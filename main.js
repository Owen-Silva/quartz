'use strict';

// main.js — Electron entry point.
//
// Owns the single BrowserWindow, bridges the renderer to pty.js over IPC, and
// tears every PTY down on quit.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createSession, killAll } = require('./pty');

/** @type {BrowserWindow | null} */
let win = null;

/**
 * Windows 11 22H2 (build 22621) is the first release where DWM exposes the
 * acrylic system backdrop to apps. os.release() looks like '10.0.26200'.
 */
function isWin11_22H2OrLater() {
  if (process.platform !== 'win32') return false;
  const build = Number(String(os.release()).split('.')[2]);
  return Number.isFinite(build) && build >= 22621;
}

/** Reflects the backdrop that actually got applied to the live window. */
let acrylicActive = false;

// Test runs (smoketest.js, verify scripts) pass --test-profile so their cookies,
// storage and theme choice never land in the real profile.
if (process.argv.includes('--test-profile')) {
  app.setPath('userData', path.join(app.getPath('temp'), 'browser-test-profile'));
}

/** id -> session handle returned by pty.createSession */
const handles = new Map();

/** True only when it is actually safe to push an IPC message at the renderer. */
function canSend() {
  return !!win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed();
}

function send(channel, payload) {
  if (!canSend()) return;
  win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// Window state
//
// Remember where the window was between launches -- position, size, and whether
// it was maximized. Everything here is best-effort: a missing, corrupt or
// off-screen state file just means the window opens at the defaults, and a
// failed write is never allowed to escape an event handler.
// ---------------------------------------------------------------------------

/**
 * Resolved lazily, not once at module load: --test-profile rewrites userData,
 * so a test run keeps its remembered geometry out of the real profile.
 */
function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/** Must match baseOptions.minWidth / minHeight in createWindow(). */
const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;

/** How much of the saved rect has to land on a display for it to be usable. */
const MIN_VISIBLE = 100;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * True when the saved rectangle still overlaps some connected display's work
 * area by at least MIN_VISIBLE px on each axis. Monitors get unplugged and
 * layouts get rearranged; a window remembered at x:3000 must not reopen
 * somewhere the user cannot reach it.
 */
function intersectsAnyDisplay(rect) {
  let displays;
  try {
    // Required here rather than at the top: the screen module is only usable
    // once the app is ready.
    displays = require('electron').screen.getAllDisplays();
  } catch {
    return false;
  }
  if (!Array.isArray(displays)) return false;

  return displays.some((display) => {
    const area = display && display.workArea;
    if (!area) return false;
    const overlapX =
      Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
    const overlapY =
      Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
  });
}

/**
 * Read window-state.json, keeping only the parts that are still trustworthy.
 * Returns null when there is nothing usable at all; otherwise an object that
 * always carries `maximized` and carries x/y/width/height only when they pass.
 */
function readWindowState() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
  } catch {
    return null; // no file yet, unreadable, or not JSON -- defaults are fine
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const maximized = parsed.maximized === true;
  const { x, y, width, height } = parsed;

  // A size that is not two finite numbers, or that is below the window's own
  // minimums, is discarded outright -- and with it the position it went with.
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return { maximized };
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return { maximized };

  // Size is good but the position isn't: let Electron centre the window.
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return { width, height, maximized };

  const rect = { x, y, width, height };
  if (!intersectsAnyDisplay(rect)) return { maximized };

  return { ...rect, maximized };
}

/** Single shared debounce timer for the 'resize' / 'move' storms. */
let saveTimer = null;

/**
 * Write the current geometry out. While maximized we record maximized:true but
 * store getNormalBounds(), so un-maximizing after the next launch restores the
 * size the window actually had before it was maximized.
 */
function saveWindowState(w) {
  try {
    if (!w || w.isDestroyed()) return;
    // Minimized bounds describe the taskbar, not the window -- skip them.
    if (w.isMinimized()) return;

    const maximized = w.isMaximized();
    const bounds = maximized ? w.getNormalBounds() : w.getBounds();
    if (!bounds) return;

    const state = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized,
    };
    fs.writeFileSync(windowStatePath(), JSON.stringify(state, null, 2));
  } catch {
    // A disk error must never take down a window event handler.
  }
}

/** Coalesce the burst of events a drag or resize produces into one write. */
function queueWindowStateSave(w) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveWindowState(w);
  }, 300);
}

function createWindow() {
  const baseOptions = {
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    // Same icon the Start Menu / taskbar shortcut uses, so the running window
    // and the pinned entry read as one app.
    icon: path.join(__dirname, 'assets', 'browser.ico'),
    // Nothing is painted until 'ready-to-show': no white flash, and the
    // backdrop material is attached before the first frame.
    show: false,
    // 'hidden' hides the caption but KEEPS the native non-client frame, which
    // DWM needs to draw a system backdrop. frame:false would make
    // backgroundMaterial render solid black. The renderer draws its own
    // window controls, so no titleBarOverlay either.
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // <webview> is how we host the browsing pane
      sandbox: false,
    },
  };

  // Window state: overlay whatever the last session left behind. Anything that
  // did not survive validation simply stays at the defaults above.
  const savedState = readWindowState();
  if (savedState) {
    if (isFiniteNumber(savedState.width) && isFiniteNumber(savedState.height)) {
      baseOptions.width = savedState.width;
      baseOptions.height = savedState.height;
    }
    if (isFiniteNumber(savedState.x) && isFiniteNumber(savedState.y)) {
      baseOptions.x = savedState.x;
      baseOptions.y = savedState.y;
    }
  }

  // --no-acrylic gives a flat window; used to measure what the material costs.
  let acrylic = isWin11_22H2OrLater() && !process.argv.includes('--no-acrylic');

  // A transparent backgroundColor is what lets the acrylic show through; the
  // opaque fallback is for everything older than Win11 22H2.
  const build = () =>
    new BrowserWindow(
      acrylic
        ? { ...baseOptions, backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }
        : { ...baseOptions, backgroundColor: '#05060a' }
    );

  try {
    win = build();
  } catch (err) {
    if (!acrylic) throw err;
    // The material was refused for some reason -- fall back to the flat window
    // rather than failing to open one at all.
    acrylic = false;
    win = build();
  }

  acrylicActive = acrylic;

  // Electron 44 still lets a guest <webview> request its own preload / node
  // integration. Strip both so a page we navigate to can never elevate itself.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL; // legacy key, still honoured by some builds
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    if (params) params.nodeintegration = 'false';
  });

  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return;
    // Maximize BEFORE showing, or the window flashes at the restored size for
    // a frame and then snaps out to full screen.
    if (savedState && savedState.maximized) win.maximize();
    win.show();
  });

  // The renderer owns the maximize/restore glyph, so it has to hear about
  // state changes it did not initiate (double-click, Win+Up, snap).
  win.on('maximize', () => send('win:maximized', { maximized: true }));
  win.on('unmaximize', () => send('win:maximized', { maximized: false }));

  // Window state: drags and resizes fire continuously, so those are debounced;
  // maximize / unmaximize / close are one-shot and written straight away --
  // 'close' being the last moment anything can be written at all.
  win.on('resize', () => queueWindowStateSave(win));
  win.on('move', () => queueWindowStateSave(win));
  win.on('maximize', () => saveWindowState(win));
  win.on('unmaximize', () => saveWindowState(win));
  win.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveWindowState(win);
  });

  win.loadFile('index.html');

  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  // macOS: re-open a window when the dock icon is clicked with none open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ---------------------------------------------------------------------------
// PTY IPC
// ---------------------------------------------------------------------------

ipcMain.handle('pty:start', (_event, { cwd, cols, rows } = {}) => {
  const session = createSession({
    cwd,
    cols,
    rows,
    onData: (data) => send('pty:data', { id: session.id, data }),
    onExit: (exitCode) => {
      handles.delete(session.id);
      send('pty:exit', { id: session.id, exitCode });
    },
  });

  handles.set(session.id, session);
  return session.id;
});

ipcMain.on('pty:write', (_event, { id, data } = {}) => {
  const session = handles.get(id);
  if (session) session.write(data);
});

ipcMain.on('pty:resize', (_event, { id, cols, rows } = {}) => {
  const session = handles.get(id);
  if (session) session.resize(cols, rows);
});

ipcMain.on('pty:kill', (_event, { id } = {}) => {
  const session = handles.get(id);
  if (!session) return;
  handles.delete(id);
  session.kill();
});

// ---------------------------------------------------------------------------
// Window controls
//
// The window is frameless, so the renderer draws its own minimize / maximize /
// close buttons and asks us to act on them.
// ---------------------------------------------------------------------------

/** The window, but only while it is still usable. */
function liveWin() {
  return win && !win.isDestroyed() ? win : null;
}

ipcMain.handle('win:info', () => {
  const w = liveWin();
  return { acrylic: acrylicActive, maximized: !!w && w.isMaximized() };
});

ipcMain.on('win:minimize', () => {
  const w = liveWin();
  if (w) w.minimize();
});

ipcMain.on('win:maximize', () => {
  const w = liveWin();
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});

ipcMain.on('win:close', () => {
  const w = liveWin();
  if (w) w.close();
});

// ---------------------------------------------------------------------------
// Shortcuts that must survive page focus
//
// A key pressed while focus sits inside a <webview> never reaches our renderer:
// the guest page consumes it first. So intercept in the main process and
// forward the intent to the chrome renderer. Without this, Ctrl+` fails exactly
// when you'd want it -- while you are actually reading a page.
// ---------------------------------------------------------------------------

const SHORTCUTS = {
  '`': 'toggle-terminal',
  t: 'new-tab',
  w: 'close-tab',
  l: 'focus-omnibox',
  '=': 'zoom-in',
  '+': 'zoom-in',
  '-': 'zoom-out',
  '0': 'zoom-reset',
};

/** Map a Ctrl+key press inside a page to the chrome action it means, or null. */
function shortcutFor(input) {
  const key = String(input.key);
  if (key === 'Tab') return { action: input.shift ? 'prev-tab' : 'next-tab' };
  if (/^[1-9]$/.test(key)) return { action: 'select-tab', index: Number(key) };
  // Ctrl+Shift+T reopens the last closed tab. It has to be caught before the
  // lowercasing lookup below, which would otherwise read it as Ctrl+T.
  if (input.shift && (key === 't' || key === 'T')) return { action: 'reopen-tab' };
  const action = SHORTCUTS[key.toLowerCase()];
  return action ? { action } : null;
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;
    const payload = shortcutFor(input);
    if (!payload) return;
    event.preventDefault();
    send('shortcut', payload);
  });
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

app.on('window-all-closed', () => {
  killAll();
  handles.clear();
  app.quit();
});

app.on('before-quit', () => {
  killAll();
  handles.clear();
});
