'use strict';

// main.js — Electron entry point.
//
// Owns the single BrowserWindow, bridges the renderer to pty.js over IPC, and
// tears every PTY down on quit. It also owns everything a <webview> guest
// cannot do for itself: downloads, permission prompts, context menus, and the
// keystrokes a focused page would otherwise swallow.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  dialog,
  shell,
  clipboard,
  Menu,
  nativeTheme,
  webContents,
} = require('electron');
const { createSession, killAll } = require('./pty');
const autopauseModule = require('./autopause');
const statsModule = require('./stats');
const bgFiles = require('./bgfiles');
const appsModule = require('./apps');

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
  // --profile-name=<x> gives a test run its own storage, so several test
  // instances (one per verify agent) never share a LevelDB or a window state.
  const named = process.argv.find((a) => a.startsWith('--profile-name='));
  const suffix = named ? '-' + named.slice('--profile-name='.length).replace(/[^a-z0-9-]/gi, '') : '';
  app.setPath('userData', path.join(app.getPath('temp'), 'browser-test-profile' + suffix));
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

/**
 * Spotify auto-pause. The user's ~/spotify-autopause bridge already pauses Spotify
 * for the LessonPlayer desktop app and for Opera GX tabs; this makes THIS browser's
 * tabs do the same, and puts the whole-computer switch in the settings pane.
 * The module owns all of it -- main only feeds it guests and pushes its state.
 */
const autoPause = autopauseModule.create({
  app,
  onChange: (status) => send('autopause:changed', status),
});

/**
 * The new tab page's system stats. Ref-counted per webContents inside the
 * module: it runs nothing at all until the chrome subscribes, and kills its
 * typeperf child five seconds after the last unsubscribe. Main only wires the
 * IPC to it -- everything else, including the child's lifetime, is its own.
 */
const stats = statsModule.create({});

/** webContents ids we have already put a 'destroyed' listener on. */
const statsWatched = new Set();

/**
 * The installed-app index behind the new tab's dock and the palette's
 * "Open <app>" rows. It builds nothing until something asks, caches for a day
 * in userData, and keeps the two things a page must never do for itself --
 * starting a process and taking the foreground -- inside one module with one
 * IPC gate in front of it.
 */
const apps = appsModule.create({ app, shell });

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

/*
 * MEASURED, NOT FIXED: the pale band down the edges of the MAXIMIZED window.
 *
 * titleBarStyle:'hidden' keeps the native frame (DWM needs it to paint the
 * acrylic) and reclaims only the caption, so the resize border on the other
 * three sides stays non-client. Windows overhangs a maximized window by the
 * border thickness to push that border off screen, but the overhang is not
 * scaled the way the border is: at 1920x1080 @125% the window rect is
 * (-9,-9)-(1929,1089), the DWM frame is exactly the display, and the CONTENT
 * area covers only x 2..1917, y 0..1076 -- so 2px left, 2px right and 3px
 * bottom of bare acrylic backdrop stay visible as a pale edge. (A WinUI3
 * window maximized on the same display puts its content at 0,0 1920x1080, so
 * this is ours, not Windows being unable to do it.)
 *
 * The band is outside the renderer's document, so no stylesheet reaches it --
 * body.maximized already zeroes the margin and the radius. Growing the window
 * rect by the shortfall on 'maximize' was tried here and reverted:
 * BrowserWindow.setBounds() RESTORES a maximized window before applying the
 * rect, so the nudge silently un-maximized the window instead. The two
 * remaining options both cost more than 2px does -- frame:false (which makes
 * backgroundMaterial render solid black, per the note in createWindow) or a
 * hand-rolled maximize that gives up Windows' own snap and restore semantics.
 */

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
    // Every other switch a <webview> attribute can flip. buildWebview() sets
    // none of them, so pinning them here costs nothing and closes the whole
    // attribute channel rather than the two entries it used to cover:
    //   disablewebsecurity  -> webSecurity        (same-origin policy off)
    //   plugins             -> plugins
    //   enableblinkfeatures -> experimentalFeatures
    //   webpreferences="…"  -> any of the above, spelled as a string
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.experimentalFeatures = false;
    webPreferences.plugins = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    // A guest must not host a <webview> of its own: this hook belongs to the
    // chrome's webContents, so a NESTED attach would never reach it.
    webPreferences.webviewTag = false;
    if (params) {
      params.nodeintegration = 'false';
      // allowpopups is FORCED ON, not stripped. It is the only switch that
      // makes Chromium ask permission before opening a window instead of
      // silently dropping the request -- and "ask" means our own
      // setWindowOpenHandler below, which denies the window and opens a TAB.
      // With it off, window.open() returns null and target="_blank" does
      // nothing at all: no handler anywhere ever hears about it. (The old
      // <webview> 'new-window' DOM event that app.js used to listen for was
      // removed from Electron in v22; it never fires here.)
      params.allowpopups = true;
      delete params.disablewebsecurity;
      delete params.plugins;
      delete params.enableblinkfeatures;
      delete params.webpreferences;
    }
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

  // The WINDOW's focus, not the chrome document's. app.js pauses the new-tab
  // board while the window is behind something else, and a click into a
  // <webview> blurs the chrome document without the window losing focus at
  // all -- so that decision has to come from here.
  win.on('focus', () => send('win:focus', { focused: true }));
  win.on('blur', () => send('win:focus', { focused: false }));
  // The state the renderer missed while it was loading.
  win.webContents.on('did-finish-load', () => {
    const w = liveWin();
    if (!w) return;
    send('win:focus', { focused: w.isFocused() });
  });

  // F11 can also come from the OS or the page, so the chrome is told about the
  // resulting state rather than assuming its own toggle was the only source.
  win.on('enter-full-screen', () => send('win:fullscreen', { fullscreen: true }));
  win.on('leave-full-screen', () => send('win:fullscreen', { fullscreen: false }));

  // The chrome itself only ever needs an editing menu (address bar, find box).
  // This IS the focused window, so the built-in roles are the right wiring.
  win.webContents.on('context-menu', (_event, params) => {
    if (!params || !params.isEditable) return;
    const menu = Menu.buildFromTemplate([
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' },
    ]);
    const w = liveWin();
    menu.popup(w ? { window: w } : {});
  });

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
  // Before the handlers: a request that arrives first must already see what
  // the user decided on a previous run.
  loadPermissionDecisions();
  attachSessionHandlers();
  createWindow();
  // Deliberately not awaited: a cold start fetches filter lists over the
  // network and the window must not wait on that.
  initAdblock();

  // macOS: re-open a window when the dock icon is clicked with none open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ---------------------------------------------------------------------------
// PTY IPC
// ---------------------------------------------------------------------------

/*
 * ConPTY hands us tiny pieces, very fast.
 *
 * MEASURED (node-pty, the same spawn path, 2 MB of output): 19,748 chunks,
 * mean 104 bytes, 829 a second -- and 19,414 of the 19,747 gaps between them
 * were under 16 ms. One webContents.send per chunk is therefore ~19,700
 * structured-clone round trips and ~19,700 wake-ups of a renderer that can
 * only paint 60 of them, which is the classic flood sink.
 *
 * So: the FIRST chunk after a quiet spell goes out untouched -- keystroke echo
 * must never wait -- and that opens a 16 ms window. Anything arriving inside
 * the window is appended to one buffer and sent when it closes, in order, or
 * sooner if the buffer passes the byte cap. A window that closes empty goes
 * back to idle, so a sitting Claude tab holds no timer at all.
 */
const PTY_FLUSH_MS = 16;
const PTY_FLUSH_BYTES = 64 * 1024;

/** pty id -> { parts: string[], bytes: number, timer: Timeout|null } */
const ptyOut = new Map();

function ptySendNow(buf, id) {
  const data = buf.parts.length === 1 ? buf.parts[0] : buf.parts.join('');
  buf.parts.length = 0;
  buf.bytes = 0;
  send('pty:data', { id, data });
}

/** The coalescing window closed. Flush what is waiting, or go idle. */
function ptyWindowEnd(id) {
  const buf = ptyOut.get(id);
  if (!buf) return;
  buf.timer = null;
  if (!buf.parts.length) return; // quiet: the next chunk goes out instantly
  ptySendNow(buf, id);
  buf.timer = setTimeout(() => ptyWindowEnd(id), PTY_FLUSH_MS);
}

function ptyPush(id, data) {
  let buf = ptyOut.get(id);
  if (!buf) {
    buf = { parts: [], bytes: 0, timer: null };
    ptyOut.set(id, buf);
  }
  buf.parts.push(data);
  buf.bytes += data.length;
  if (buf.timer === null) {
    // Idle: deliver at once, then open the window.
    ptySendNow(buf, id);
  } else if (buf.bytes >= PTY_FLUSH_BYTES) {
    // The cap beats the clock: never sit on more than 64 KB.
    clearTimeout(buf.timer);
    ptySendNow(buf, id);
  } else {
    return; // already inside a window; it will carry this out
  }
  buf.timer = setTimeout(() => ptyWindowEnd(id), PTY_FLUSH_MS);
}

/** Everything still buffered goes out before the caller says the session ended. */
function ptyFlushFinal(id) {
  const buf = ptyOut.get(id);
  if (!buf) return;
  if (buf.timer !== null) clearTimeout(buf.timer);
  if (buf.parts.length) ptySendNow(buf, id);
  ptyOut.delete(id);
}

// `args` is passed straight through: pty.js owns the allowlist (only
// `--continue` survives) so there is exactly one place that decides what may
// reach claude.exe's command line.
ipcMain.handle('pty:start', (_event, { cwd, cols, rows, args } = {}) => {
  const session = createSession({
    cwd,
    cols,
    rows,
    args,
    onData: (data) => ptyPush(session.id, data),
    onExit: (exitCode) => {
      handles.delete(session.id);
      ptyFlushFinal(session.id); // the last output, then the exit
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
  ptyFlushFinal(id); // never strand a buffered tail on a closed tab's timer
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

/**
 * "Restart browser" (Settings > About, and the command palette): close and
 * reopen with the tabs restored, which is what every update to this app needs.
 *
 * app.quit() rather than app.exit(): quit is the path that runs 'before-quit'
 * (killAll() for the PTYs, and autoPause.handleQuit(), which hands our Spotify
 * hold back and may defer the quit by up to ~1.5 s to do it -- it calls
 * app.quit() again when it is done). app.exit() would skip all of that and
 * leave Spotify paused until the bridge's hold expired. The renderer has
 * already flushed its session snapshot over 'session:write' by the time this
 * arrives, and the window rect is written here the way 'close' writes it.
 *
 * app.relaunch() with no arguments reuses this process's own argv and working
 * directory, so a test instance (--test-profile, --remote-debugging-port)
 * comes back as the same test instance.
 */
ipcMain.on('app:restart', () => {
  try {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const w = liveWin();
    if (w) saveWindowState(w);
  } catch {
    // Never let a disk error strand the user in a browser that will not restart.
  }
  app.relaunch();
  app.quit();
});

ipcMain.on('win:fullscreen-toggle', () => {
  const w = liveWin();
  if (w) w.setFullScreen(!w.isFullScreen());
});

/** Paths the renderer wants to show but must not guess at. */
ipcMain.handle('app:paths', () => ({
  home: app.getPath('home'),
  downloads: app.getPath('downloads'),
}));

/**
 * Native folder picker for "which folder should this Claude session run in".
 * Returns the chosen absolute path, or null for cancel / any failure -- the
 * caller treats both the same way, so there is nothing to throw about.
 */
ipcMain.handle('app:pick-folder', async (_event, { defaultPath } = {}) => {
  const options = {
    properties: ['openDirectory'],
    defaultPath:
      typeof defaultPath === 'string' && defaultPath.trim()
        ? defaultPath.trim()
        : app.getPath('home'),
    title: 'Choose a folder for Claude',
  };
  try {
    const w = liveWin();
    // Parented when we have a window, so the sheet is modal to it.
    const result = w
      ? await dialog.showOpenDialog(w, options)
      : await dialog.showOpenDialog(options);
    if (!result || result.canceled) return null;
    const picked = Array.isArray(result.filePaths) ? result.filePaths[0] : null;
    return typeof picked === 'string' && picked ? picked : null;
  } catch {
    return null;
  }
});

/** Does this path name an existing directory? (settings validates typed paths) */
ipcMain.handle('app:dir-exists', (_event, { path: target } = {}) => {
  if (typeof target !== 'string' || !target.trim()) return false;
  try {
    return fs.statSync(path.resolve(target.trim())).isDirectory();
  } catch {
    return false;
  }
});

// ---------------------------------------------------------------------------
// The new tab's moving background
//
// Settings keeps the descriptor; the clip is copied into
// <userData>/backgrounds/ so the page keeps playing after the original moves.
// bgfiles.js holds the whole copy/validate path with no Electron in it --
// everything here is the dialog and the userData path it cannot know.
// ---------------------------------------------------------------------------

/** Where the one copied clip lives. Lazy: --test-profile rewrites userData. */
function backgroundsDir() {
  return bgFiles.backgroundsDir(app.getPath('userData'));
}

/**
 * Pick a clip and copy it in.
 * Resolves { ok: true, fileUrl, fileName, bytes } or { ok: false, reason },
 * where reason is 'cancelled', 'too-large' (past 512 MB) or a message.
 * Never rejects -- the settings panel shows the reason as a toast.
 */
ipcMain.handle('background:choose-video', async () => {
  const options = {
    properties: ['openFile'],
    title: 'Choose a moving picture for the new tab',
    filters: [{ name: 'Moving pictures', extensions: bgFiles.VIDEO_EXTS.slice() }],
  };
  let picked = null;
  try {
    const w = liveWin();
    const result = w
      ? await dialog.showOpenDialog(w, options)
      : await dialog.showOpenDialog(options);
    if (!result || result.canceled) return { ok: false, reason: 'cancelled' };
    picked = Array.isArray(result.filePaths) ? result.filePaths[0] : null;
  } catch (err) {
    return { ok: false, reason: (err && err.message) || 'The picker could not open' };
  }
  if (typeof picked !== 'string' || !picked) return { ok: false, reason: 'cancelled' };

  const out = bgFiles.installBackgroundVideo(picked, backgroundsDir());
  if (!out.ok) return { ok: false, reason: out.reason };
  return { ok: true, fileUrl: out.fileUrl, fileName: out.fileName, bytes: out.bytes };
});

/** Drop the copied clip. Always { ok: true }: gone is the state we wanted. */
ipcMain.handle('background:clear-video', () => {
  try {
    bgFiles.clearBackgroundFiles(backgroundsDir());
  } catch { /* nothing there */ }
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Session snapshot
//
// The renderer keeps its tab list in localStorage, which Chromium flushes
// lazily -- a crash or a forced kill loses the last write. This is the durable
// mirror: main writes it synchronously and atomically on every snapshot, so
// the newer of (localStorage, session.json) is always a real session.
// ---------------------------------------------------------------------------

/** Lazy, like windowStatePath(): --test-profile must not touch the real one. */
function sessionStatePath() {
  return path.join(app.getPath('userData'), 'session.json');
}

/** Snapshots are small; anything this big is a bug or a runaway, not a session. */
const SESSION_MAX_BYTES = 256 * 1024;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/*
 * The write itself is ASYNC, and only one is ever in flight.
 *
 * MEASURED: 300 snapshots pushed back to back cost 1367 ms of main-process CPU
 * when this was writeFileSync + renameSync -- 777 ms of it inside rename() --
 * and stalled the event loop for 1168 ms at the 99th percentile. Every one of
 * those milliseconds was the whole UI: main draws no frames, so a disk hiccup
 * during a burst of tab closes is felt as a freeze. Async takes the same work
 * off the loop thread; `pendingSession` collapses a burst into one write per
 * completed write, because only the NEWEST snapshot has ever been worth
 * keeping. Durability is unchanged where it matters: flushSessionSync() below
 * runs on quit and restart, when there is no loop left to protect.
 */
let pendingSession = null;   // newest snapshot json not yet on disk
let sessionWriting = false;  // a write is in flight

/** Write-then-rename: a kill mid-write can only ever destroy the .tmp, so
 *  session.json is either the previous snapshot or the new one, never half. */
function drainSession() {
  if (sessionWriting || pendingSession === null) return;
  const json = pendingSession;
  pendingSession = null;
  sessionWriting = true;
  const target = sessionStatePath();
  const tmp = `${target}.tmp`;
  fs.promises
    .writeFile(tmp, json, 'utf8')
    .then(() => fs.promises.rename(tmp, target))
    .catch(() => { /* a disk error must never take down the pump */ })
    .then(() => {
      sessionWriting = false;
      drainSession(); // whatever arrived while that one was in flight
    });
}

/** The last moment anything can be written: the process is about to go. */
function flushSessionSync() {
  if (pendingSession === null) return;
  const json = pendingSession;
  pendingSession = null;
  try {
    const target = sessionStatePath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, target);
  } catch {
    // Nothing useful to do while quitting.
  }
}

ipcMain.on('session:write', (_event, { snapshot } = {}) => {
  try {
    if (!isPlainObject(snapshot) || !Array.isArray(snapshot.tabs)) return;

    const json = JSON.stringify(snapshot);
    if (typeof json !== 'string') return;
    if (Buffer.byteLength(json, 'utf8') > SESSION_MAX_BYTES) return;

    pendingSession = json;
    drainSession();
  } catch {
    // A disk error must never take down an IPC handler.
  }
});

ipcMain.handle('session:read', () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionStatePath(), 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null; // no file yet, unreadable, or not JSON
  }
});

/**
 * The theme guest PAGES see -- what a site reads from prefers-color-scheme.
 * It is a process-wide switch, so only main can set it; the renderer owns the
 * stored preference (localStorage) and replays it here at load and on change.
 * Anything but the three known modes is ignored rather than guessed at.
 */
ipcMain.on('app:site-theme', (_event, payload) => {
  const mode = payload && payload.mode;
  if (mode !== 'system' && mode !== 'light' && mode !== 'dark') return;
  nativeTheme.themeSource = mode;
});

// ---------------------------------------------------------------------------
// Downloads
//
// Electron's default is to pop a native save dialog for every file. A real
// browser does not ask: it drops the file in the Downloads folder, never
// overwrites anything already there, and shows progress in its own UI. The
// DownloadItem objects die with their session, so everything the renderer
// needs is mirrored into a plain record the moment it changes.
// ---------------------------------------------------------------------------

/** id -> record (plus the live DownloadItem while one exists). */
const downloads = new Map();
let nextDownloadId = 1;

/**
 * "Ask where to save each file", pushed over dl:prefs. The preference itself
 * lives in the renderer's settings store, which this process cannot read, so
 * the renderer replays it at boot and on every change. Default false: a real
 * browser does not ask.
 */
let downloadAskWhere = false;

/** Progress ticks far faster than anyone can read. ~8/sec is plenty. */
const DOWNLOAD_UPDATE_MS = 125;

/** Give up de-duplicating a name long before we can hang on a full folder. */
const MAX_DUPLICATE_TRIES = 500;

/**
 * The first path in `dir` that does not exist yet: 'a.zip', then 'a (1).zip'.
 * Silently clobbering a file the user already has is the one download
 * behaviour nobody forgives.
 */
function uniqueDownloadPath(dir, rawFilename) {
  // basename() first: Chromium already strips separators out of a
  // Content-Disposition name, but joining an unflattened one onto `dir` is the
  // only place a '..\..\' could ever walk the write out of Downloads.
  const filename = path.basename(String(rawFilename || '')) || 'download';
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  for (let i = 1; i <= MAX_DUPLICATE_TRIES && fs.existsSync(candidate); i++) {
    candidate = path.join(dir, base + ' (' + i + ')' + ext);
  }
  // Five hundred duplicates is absurd but not impossible; never overwrite.
  if (fs.existsSync(candidate)) candidate = path.join(dir, base + ' (' + Date.now() + ')' + ext);
  return candidate;
}

/** The renderer-facing shape. The DownloadItem itself never crosses IPC. */
function downloadPayload(entry) {
  return {
    id: entry.id,
    filename: entry.filename,
    url: entry.url,
    savePath: entry.savePath,
    state: entry.state,
    received: entry.received,
    total: entry.total,
    paused: entry.paused,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
  };
}

/** Push an update. `force` is for the first and last one, which never drop. */
function sendDownloadUpdate(entry, force) {
  const now = Date.now();
  if (!force && now - entry.lastSent < DOWNLOAD_UPDATE_MS) return;
  entry.lastSent = now;
  send('dl:update', downloadPayload(entry));
}

/** Read the item's counters into the record, tolerating a dead item. */
function syncDownloadItem(entry) {
  const item = entry.item;
  if (!item) return;
  try {
    entry.received = item.getReceivedBytes();
    entry.total = item.getTotalBytes(); // 0 when the server sent no length
    entry.paused = item.isPaused();
    // With "ask where to save", nothing chose a path up front: the item only
    // learns one once the user answers the native dialog. Adopt it the moment
    // it exists so the row's name, its Open and its Show all point at the
    // real file.
    if (!entry.savePath) {
      const chosen = item.getSavePath();
      if (chosen) {
        entry.savePath = chosen;
        entry.filename = path.basename(chosen);
      }
    }
  } catch {
    // The item was destroyed mid-read; the record keeps its last good values.
  }
}

function handleWillDownload(_event, item) {
  const dir = app.getPath('downloads');
  let savePath = '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (downloadAskWhere) {
      // Handing Electron dialog options INSTEAD of a path is what puts the
      // native Save dialog on screen. Cancelling it cancels the item ('done'
      // fires with 'cancelled'), and the path the user picked only becomes
      // readable through item.getSavePath() afterwards -- see
      // syncDownloadItem, which adopts it.
      item.setSaveDialogOptions({
        title: 'Save as',
        defaultPath: path.join(dir, item.getFilename())
      });
    } else {
      savePath = uniqueDownloadPath(dir, item.getFilename());
      // Setting the path up front is exactly what suppresses the save dialog.
      item.setSavePath(savePath);
    }
  } catch {
    // Could not choose a path -- let Electron fall back to its own prompt
    // rather than losing the download entirely.
  }

  const entry = {
    id: nextDownloadId++,
    item,
    filename: path.basename(savePath || item.getFilename()),
    url: item.getURL(),
    savePath,
    state: 'progressing',
    received: 0,
    total: 0,
    paused: false,
    startedAt: Date.now(),
    finishedAt: null,
    lastSent: 0,
  };
  syncDownloadItem(entry);
  downloads.set(entry.id, entry);
  sendDownloadUpdate(entry, true);

  item.on('updated', (_e, state) => {
    // 'interrupted' here means stalled-but-resumable, not finished.
    entry.state = state === 'interrupted' ? 'interrupted' : 'progressing';
    syncDownloadItem(entry);
    sendDownloadUpdate(entry, false);
  });

  item.once('done', (_e, state) => {
    syncDownloadItem(entry);
    entry.state = state; // 'completed' | 'cancelled' | 'interrupted'
    entry.paused = false;
    entry.finishedAt = Date.now();
    // The DownloadItem is spent: drop it so pause/resume/cancel become no-ops
    // and nothing holds a dead native handle.
    entry.item = null;
    sendDownloadUpdate(entry, true);
  });
}

/** Run `fn` against a download that is still live; otherwise do nothing. */
function withLiveDownload(id, fn) {
  const entry = downloads.get(id);
  if (!entry || !entry.item) return;
  try {
    fn(entry.item, entry);
  } catch {
    // Racing the 'done' event is normal: the item can die between the
    // renderer's click and this call.
  }
}

ipcMain.handle('dl:list', () =>
  [...downloads.values()]
    .sort((a, b) => b.startedAt - a.startedAt || b.id - a.id)
    .map(downloadPayload)
);

ipcMain.on('dl:cancel', (_event, { id } = {}) => {
  withLiveDownload(id, (item) => item.cancel());
});

ipcMain.on('dl:pause', (_event, { id } = {}) => {
  withLiveDownload(id, (item, entry) => {
    item.pause();
    entry.paused = true;
    sendDownloadUpdate(entry, true);
  });
});

ipcMain.on('dl:resume', (_event, { id } = {}) => {
  withLiveDownload(id, (item, entry) => {
    if (!item.canResume()) return;
    item.resume();
    entry.paused = false;
    sendDownloadUpdate(entry, true);
  });
});

ipcMain.handle('dl:open', (_event, { id } = {}) => {
  const entry = downloads.get(id);
  if (!entry || entry.state !== 'completed' || !entry.savePath) {
    return 'That download is not finished.';
  }
  return shell.openPath(entry.savePath); // '' means it opened
});

ipcMain.on('dl:show', (_event, { id } = {}) => {
  const entry = downloads.get(id);
  if (entry && entry.savePath) shell.showItemInFolder(entry.savePath);
});

/**
 * The renderer's copy of "ask where to save each file". Nothing is persisted
 * here: the settings store is the source of truth and replays this at boot.
 */
ipcMain.on('dl:prefs', (_event, { askWhere } = {}) => {
  downloadAskWhere = !!askWhere;
});

/** The panel's "Open folder": the Downloads folder itself, in Explorer. */
ipcMain.on('dl:open-folder', () => {
  const dir = app.getPath('downloads');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Already there, or not ours to make -- openPath says so either way.
  }
  shell.openPath(dir);
});

ipcMain.on('dl:clear', () => {
  for (const [id, entry] of downloads) {
    if (entry.state !== 'progressing') downloads.delete(id);
  }
});

// Used by the context menu's Save link as / Save image, which have a URL but
// no DownloadItem yet. Going through the window's webContents means the
// request carries our normal session, cookies included.
// Schemes a "Save link as" can ever legitimately name. `file:` is deliberately
// absent: a page must not be able to talk the chrome into copying something off
// the local disk into Downloads, and neither javascript: nor a custom protocol
// handler has any business here.
const DOWNLOADABLE_SCHEMES = new Set(['http:', 'https:', 'blob:', 'data:']);

ipcMain.on('dl:download-url', (_event, { url } = {}) => {
  const w = liveWin();
  if (!w || typeof url !== 'string' || !url) return;
  let scheme = '';
  try {
    scheme = new URL(url).protocol;
  } catch {
    return; // not a URL at all
  }
  if (!DOWNLOADABLE_SCHEMES.has(scheme)) return;
  w.webContents.downloadURL(url);
});

// ---------------------------------------------------------------------------
// Page screenshots
//
// capturePage() lives on the GUEST's webContents, which only this process can
// reach. The PNG lands in the Downloads folder beside real downloads and
// borrows their no-overwrite naming -- but it is not a DownloadItem, so it
// never appears in the downloads panel and nothing streams over dl:update.
// ---------------------------------------------------------------------------

/** Windows rejects <>:"/\|?* and control chars in a name, plus trailing dots. */
function safeFilePart(text, fallback) {
  const cleaned = String(text || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned || fallback;
}

/** Local time as 'YYYY-MM-DD HH-mm-ss' -- a colon cannot go in a filename. */
function captureStamp(date) {
  // Duck-typed rather than `instanceof Date`, which is false for a Date made
  // in another realm (a test harness, a different context).
  const d = date && typeof date.getFullYear === 'function' ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) +
    '-' + pad(d.getMinutes()) +
    '-' + pad(d.getSeconds())
  );
}

/**
 * Screenshot one guest into <Downloads>/Screenshot <host> <stamp>.png.
 *
 * `full` is RESERVED for a future full-page capture and deliberately changes
 * nothing today: stitching one would mean scrolling the guest under the user
 * and putting it back, so the visible area is what gets written either way.
 *
 * @returns {Promise<{ path: string, width: number, height: number } | { error: string }>}
 */
ipcMain.handle('capture:tab', async (_event, { wcId, full } = {}) => {
  void full; // reserved -- see above
  if (!Number.isInteger(wcId)) return { error: 'No page to capture.' };

  let contents = null;
  try {
    contents = webContents.fromId(wcId);
  } catch {
    contents = null;
  }
  // Only ever a <webview> guest: never the chrome's own renderer, and never a
  // stale id left behind by a closed tab.
  if (!contents || contents.isDestroyed() || contents.getType() !== 'webview') {
    return { error: 'That tab has no page to capture.' };
  }

  try {
    const image = await contents.capturePage();
    if (!image || image.isEmpty()) return { error: 'The page came back blank.' };

    const dir = app.getPath('downloads');
    fs.mkdirSync(dir, { recursive: true });
    const host = safeFilePart(hostOfUrl(contents.getURL()), 'page');
    const name = 'Screenshot ' + host + ' ' + captureStamp() + '.png';
    // The downloads helper, so a second capture inside the same second lands as
    // '... (1).png' instead of overwriting the first.
    const target = uniqueDownloadPath(dir, name);
    fs.writeFileSync(target, image.toPNG());

    const size = image.getSize();
    return { path: target, width: size.width, height: size.height };
  } catch (err) {
    return { error: (err && err.message) || 'The capture failed.' };
  }
});

/**
 * True only for a path that resolves INSIDE the Downloads folder. `..` and a
 * symlinked name both collapse in path.resolve() before the comparison, and
 * path.relative() on win32 compares case-insensitively, which is what NTFS
 * does.
 */
function isInsideDownloads(target) {
  try {
    const dir = path.resolve(app.getPath('downloads'));
    const rel = path.relative(dir, path.resolve(String(target)));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Reveal a finished screenshot in Explorer. The path comes from the renderer,
 * so it is confined to the folder capture:tab writes into -- there is no other
 * place a screenshot can be, and an arbitrary path would otherwise let a
 * compromised chrome point Explorer at anything on the disk.
 */
ipcMain.on('capture:show', (_event, { path: target } = {}) => {
  if (typeof target !== 'string' || !target) return;
  if (!isInsideDownloads(target)) return;
  shell.showItemInFolder(target);
});

// ---------------------------------------------------------------------------
// Permissions
//
// Electron grants every permission request by default, which would make this
// the most generous browser on the machine. Harmless, user-initiated things
// are allowed silently; the ones that reach hardware, location or the
// clipboard are asked about once per origin; everything else is denied.
// ---------------------------------------------------------------------------

/** Allowed with no prompt: all of these need a user gesture anyway. */
const PERMISSIONS_ALWAYS_ALLOW = new Set([
  'fullscreen',
  'pointerLock',
  'clipboard-sanitized-write',
  'window-placement',
  'window-management',
  'keyboardLock',
]);

/** Worth interrupting for. Anything not here and not above is denied. */
const PERMISSION_PHRASES = {
  geolocation: 'know your location',
  notifications: 'send you notifications',
  midi: 'use your MIDI devices',
  midiSysex: 'use your MIDI devices, including system messages',
  'display-capture': 'share your screen',
  'idle-detection': 'know when you are inactive',
  'clipboard-read': 'read your clipboard',
  openExternal: 'open another app',
};

/** 'origin|permission' -> boolean, remembered for the rest of the run. */
const permissionDecisions = new Map();

/** 'origin|permission' -> in-flight promise, so one dialog serves every ask. */
const permissionPending = new Map();

function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return '';
  }
}

/**
 * Decisions outlive the run: <userData>/permissions.json holds
 * { origin: { permission: 'allow' | 'block' } }. Same best-effort, lazily
 * resolved path as window-state.json -- a missing or corrupt file just means
 * nothing has been decided yet, and a failed write never escapes a handler.
 */
function permissionsPath() {
  return path.join(app.getPath('userData'), 'permissions.json');
}

/** Everything that can actually raise a dialog, in the order they are listed. */
const PERMISSION_PROMPT_LIST = ['media', ...Object.keys(PERMISSION_PHRASES)];

/** Prompting + silently-allowed names: the only keys the store will accept. */
const KNOWN_PERMISSIONS = new Set([...PERMISSION_PROMPT_LIST, ...PERMISSIONS_ALWAYS_ALLOW]);

/** An origin we are willing to key a decision on: parses, and is http(s). */
function validOrigin(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  return url.origin;
}

/** Fold the file back into the Map, dropping anything no longer meaningful. */
function loadPermissionDecisions() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(permissionsPath(), 'utf8'));
  } catch {
    return; // no file yet, unreadable, or not JSON -- nothing is remembered
  }
  if (!parsed || typeof parsed !== 'object') return;
  for (const [rawOrigin, perms] of Object.entries(parsed)) {
    const origin = validOrigin(rawOrigin);
    if (!origin || !perms || typeof perms !== 'object') continue;
    for (const [permission, decision] of Object.entries(perms)) {
      if (!KNOWN_PERMISSIONS.has(permission)) continue;
      if (decision !== 'allow' && decision !== 'block') continue;
      permissionDecisions.set(origin + '|' + permission, decision === 'allow');
    }
  }
}

/** The Map, written back out as { origin: { permission: decision } }. */
function savePermissionDecisions() {
  try {
    const out = {};
    for (const [key, allowed] of permissionDecisions) {
      const cut = key.lastIndexOf('|');
      if (cut <= 0) continue;
      const origin = key.slice(0, cut);
      // A guest on an opaque origin ('' or 'null') can still be asked about,
      // but there is nothing stable to remember it under.
      if (!validOrigin(origin)) continue;
      (out[origin] = out[origin] || {})[key.slice(cut + 1)] = allowed ? 'allow' : 'block';
    }
    fs.writeFileSync(permissionsPath(), JSON.stringify(out, null, 2));
  } catch {
    // A disk error must never take down a dialog callback or an IPC handler.
  }
}

/** Every explicit decision for one origin: { permission: 'allow'|'block' }. */
function permissionsForOrigin(origin) {
  const out = {};
  const prefix = origin + '|';
  for (const [key, allowed] of permissionDecisions) {
    if (!key.startsWith(prefix)) continue;
    out[key.slice(prefix.length)] = allowed ? 'allow' : 'block';
  }
  return out;
}

/** The one place a decision is written, so file and Map cannot drift apart. */
function rememberPermission(origin, permission, allowed) {
  permissionDecisions.set(origin + '|' + permission, allowed);
  savePermissionDecisions();
}

/** What the user recognises: the host, not the whole origin. */
function originLabel(origin) {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin || 'This page';
  }
}

/** The '<host> wants to …' clause for one request. */
function permissionPhrase(permission, details) {
  if (permission === 'media') {
    const types = (details && details.mediaTypes) || [];
    const wants = [];
    if (types.includes('video')) wants.push('camera');
    if (types.includes('audio')) wants.push('microphone');
    // Chrome asks for both when the page did not say which.
    if (!wants.length) wants.push('camera', 'microphone');
    return 'use your ' + wants.join(' and ');
  }
  if (permission === 'openExternal') {
    const external = details && details.externalURL;
    const scheme = external ? String(external).split(':')[0] : '';
    return scheme ? 'open a ' + scheme + ': link in another app' : 'open another app';
  }
  return PERMISSION_PHRASES[permission] || 'use ' + permission;
}

/** The small print under the question: the exact target, where we have one. */
function permissionDetail(permission, origin, details) {
  if (permission === 'openExternal' && details && details.externalURL) {
    return String(details.externalURL).slice(0, 200);
  }
  return (origin || 'This page') + ' — blocked unless you allow it.';
}

/**
 * Resolve to the user's answer, asking at most once per origin+permission and
 * coalescing simultaneous asks (a page calling getUserMedia twice must not
 * stack two dialogs).
 */
function askPermission(origin, permission, details) {
  const key = origin + '|' + permission;
  // "Open other apps" is asked every time: one remembered Allow would turn a
  // site into a permanent launcher for any protocol handler on the machine.
  if (permission !== 'openExternal' && permissionDecisions.has(key)) {
    return Promise.resolve(permissionDecisions.get(key));
  }
  const pending = permissionPending.get(key);
  if (pending) return pending;

  const w = liveWin();
  if (!w) return Promise.resolve(false); // nothing to parent a dialog to

  const promise = dialog
    .showMessageBox(w, {
      type: 'question',
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Permission request',
      message: originLabel(origin) + ' wants to ' + permissionPhrase(permission, details),
      detail: permissionDetail(permission, origin, details),
    })
    .then((result) => {
      const allowed = result.response === 0;
      if (permission !== 'openExternal') rememberPermission(origin, permission, allowed);
      return allowed;
    })
    .catch(() => false) // a dialog that failed to show is not consent
    .finally(() => permissionPending.delete(key));

  permissionPending.set(key, promise);
  return promise;
}

/** getURL() throws on a destroyed webContents; never let that reach Electron. */
function safeUrl(contents) {
  try {
    return contents && !contents.isDestroyed() ? contents.getURL() : '';
  } catch {
    return '';
  }
}

/**
 * Webviews carry no `partition` attribute, so every guest page shares
 * session.defaultSession -- the same session downloads and permissions hang
 * off here.
 */
function attachSessionHandlers() {
  const sess = session.defaultSession;
  if (!sess) return;

  sess.on('will-download', handleWillDownload);

  sess.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (PERMISSIONS_ALWAYS_ALLOW.has(permission)) return callback(true);
    const prompts = permission === 'media' || permission in PERMISSION_PHRASES;
    if (!prompts) return callback(false);

    const origin = originOf(safeUrl(contents) || (details && details.requestingUrl));
    askPermission(origin, permission, details).then(
      (allowed) => callback(allowed),
      () => callback(false)
    );
  });

  // A check must give the same answer a request would, or a site sees itself
  // as granted and then silently fails.
  sess.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (PERMISSIONS_ALWAYS_ALLOW.has(permission)) return true;
    const origin = originOf(
      requestingOrigin || (details && details.requestingUrl) || safeUrl(contents)
    );
    const decision = permissionDecisions.get(origin + '|' + permission);
    return decision === true;
  });
}

// ---------------------------------------------------------------------------
// Certificate errors
//
// The default answer stays "reject": nothing here grants an exception, and
// there is no UI to click through one. All we do is REMEMBER which origins
// failed, so site info can say why the padlock is off instead of reporting a
// plain https URL as fine.
// ---------------------------------------------------------------------------

/** Origins whose certificate Chromium refused at least once this run. */
const certErrors = new Set();

app.on('certificate-error', (_event, _contents, url, _error, _certificate, callback) => {
  const origin = originOf(url);
  if (origin) certErrors.add(origin);
  // No preventDefault(), so Electron applies its own verdict (reject) and
  // ignores this callback -- answering false keeps that explicit either way.
  callback(false);
});

// ---------------------------------------------------------------------------
// Ad blocking
//
// Ghostery's engine owns session.defaultSession's webRequest hooks, so every
// <webview> guest is filtered by the one engine -- there is nothing per-tab to
// wire up. Two things are ours: the persisted preferences (on/off + a per-site
// allowlist) and the per-tab "blocked" counters the chrome shows.
//
// Cosmetic filtering (hiding the container an ad would have filled) needs a
// preload inside every guest frame. We do NOT reach for will-attach-webview for
// that -- that hook deliberately strips any preload a PAGE asks for, and must
// keep doing so. enableBlockingInSession() registers the library's own preload
// at the SESSION level instead, which is a separate mechanism and reaches every
// frame including guests.
// ---------------------------------------------------------------------------

const { ElectronBlocker, NetworkFilter } = require('@ghostery/adblocker-electron');

/** Serialized engine. First run fetches the lists; later runs load this. */
function adblockCachePath() {
  return path.join(app.getPath('userData'), 'adblock-engine.bin');
}

/** { enabled, allow } -- same lazy-path, best-effort style as window-state. */
function adblockPrefsPath() {
  return path.join(app.getPath('userData'), 'adblock.json');
}

/** @type {import('@ghostery/adblocker-electron').ElectronBlocker | null} */
let blocker = null;

/** True only while the engine is actually hooked into the session. */
let blockingOn = false;

let adblockPrefs = { enabled: true, allow: [] };

/** host -> the ids of the exception filters we pushed into the engine for it. */
const allowFilterIds = new Map();

/** webContents id -> { blocked, host } for the page currently loaded there. */
const adblockCounts = new Map();

/**
 * A hostname the allowlist can be keyed on: lowercase, no scheme, no port or
 * path, and no leading `www.` so example.com and www.example.com are one site.
 */
function normaliseHost(value) {
  if (typeof value !== 'string') return '';
  let host = value.trim().toLowerCase();
  if (!host) return '';
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return '';
    }
  }
  host = host.split('/')[0].split('@').pop().split(':')[0];
  return host.replace(/^www\./, '');
}

function isAllowedHost(host) {
  return !!host && adblockPrefs.allow.includes(host);
}

function readAdblockPrefs() {
  const fallback = { enabled: true, allow: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(adblockPrefsPath(), 'utf8'));
  } catch {
    return fallback; // no file yet, unreadable, or not JSON -- blocking is on
  }
  if (!parsed || typeof parsed !== 'object') return fallback;
  const allow = Array.isArray(parsed.allow)
    ? [...new Set(parsed.allow.map(normaliseHost).filter(Boolean))]
    : [];
  return { enabled: parsed.enabled !== false, allow };
}

function saveAdblockPrefs() {
  try {
    fs.writeFileSync(adblockPrefsPath(), JSON.stringify(adblockPrefs, null, 2));
  } catch {
    // A disk error must never take down an IPC handler.
  }
}

/**
 * Two exception rules per allowlisted host, because one does not cover both
 * halves of the blocker:
 *   @@*$domain=host   -- lets every SUBRESOURCE the page requests through.
 *                        (@@||host^$document does NOT: this engine matches one
 *                        request at a time and keeps no page state, so a
 *                        $document exception only ever matches the main
 *                        document, which is never blocked in the first place.)
 *   @@||host^$elemhide -- stops the cosmetic rules from hiding anything.
 */
function allowRulesFor(host) {
  return [`@@*$domain=${host}`, `@@||${host}^$elemhide`];
}

function applyAllowRule(host) {
  if (!blocker || allowFilterIds.has(host)) return;
  const filters = allowRulesFor(host)
    .map((raw) => NetworkFilter.parse(raw))
    .filter(Boolean);
  if (!filters.length) return;
  blocker.update({ newNetworkFilters: filters });
  allowFilterIds.set(host, filters.map((filter) => filter.getId()));
}

function removeAllowRule(host) {
  const ids = allowFilterIds.get(host);
  if (!blocker || !ids) return;
  allowFilterIds.delete(host);
  blocker.update({ removedNetworkFilters: ids });
}

/**
 * Exceptions that are on whatever the user's allowlist says, because blocking
 * these does not remove an ad -- it stalls the page that asked for them.
 *
 * YouTube's SPA waits on its own first-party calls before a click turns into a
 * playing video: /youtubei/v1/* is the player API (log_event included) and
 * /api/stats/* is the playback telemetry the ad check rides on. The prebuilt
 * ads+tracking lists cancel two of them outright
 * (||youtube.com^/youtubei/v1/log_event and ||youtube.com^/api/stats/ads?), and
 * a cancelled fetch there is what leaves the player spinning until the document
 * is reloaded. Ad DELIVERY is untouched: youtube.com/pagead/, doubleclick.net
 * and the rest still block exactly as before.
 */
const UNBREAK_FILTERS = ['@@||youtube.com/youtubei/', '@@||youtube.com/api/stats/'];

/** Applied once when the engine is built; nothing in the UI turns these off. */
function applyUnbreakRules() {
  if (!blocker) return;
  const filters = UNBREAK_FILTERS.map((raw) => NetworkFilter.parse(raw)).filter(Boolean);
  if (filters.length) blocker.update({ newNetworkFilters: filters });
}

function adblockState() {
  return {
    enabled: adblockPrefs.enabled,
    ready: !!blocker && blockingOn,
    allow: [...adblockPrefs.allow],
  };
}

/**
 * The library's cosmetic-filter IPC handler answers any frame in the session --
 * including our own chrome, which is a file:// page and would get the generic
 * "hide anything that looks like an ad" stylesheet injected into the UI. Wrap
 * it so only real web pages are served. disable() removes the channel again.
 */
function guardCosmeticInjection() {
  ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters');
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url, msg) => {
    let scheme = '';
    try {
      scheme = new URL(url).protocol;
    } catch {
      return undefined;
    }
    if (scheme !== 'http:' && scheme !== 'https:') return undefined;
    if (!blocker) return undefined;
    return blocker.onInjectCosmeticFilters(event, url, msg);
  });
}

function setBlockingEnabled(on) {
  const sess = session.defaultSession;
  if (!blocker || !sess) {
    blockingOn = false;
    return;
  }
  if (on && !blockingOn) {
    blocker.enableBlockingInSession(sess);
    guardCosmeticInjection();
    blockingOn = true;
  } else if (!on && blockingOn) {
    try {
      blocker.disableBlockingInSession(sess);
    } catch {
      // Already gone; the flag below is what the rest of the app reads.
    }
    blockingOn = false;
  }
}

/**
 * Built once at startup and never awaited by window creation: a first run has
 * to fetch ~3 MB of filter lists, and the browser must be usable meanwhile.
 * Offline with no cache simply leaves the engine null -- everything else here
 * degrades to "blocking unavailable" rather than failing.
 */
async function initAdblock() {
  adblockPrefs = readAdblockPrefs();
  try {
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: adblockCachePath(),
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
  } catch (err) {
    console.error('[adblock] engine unavailable:', (err && err.message) || err);
    blocker = null;
    send('adblock:state-changed', adblockState());
    return;
  }

  blocker.on('request-blocked', (request) => {
    // request.tabId is the webContents id of the frame that made the request.
    countBlocked(request && request.tabId);
  });

  applyUnbreakRules();
  for (const host of adblockPrefs.allow) applyAllowRule(host);
  setBlockingEnabled(adblockPrefs.enabled);
  send('adblock:state-changed', adblockState());
}

function hostOfUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function countBlocked(wcId) {
  if (!Number.isInteger(wcId)) return;
  const entry = adblockCounts.get(wcId) || { blocked: 0, host: '' };
  entry.blocked += 1;
  adblockCounts.set(wcId, entry);
  queueAdblockUpdate(wcId);
}

/** A page load blocks in bursts; the chrome only needs a few repaints a second. */
const ADBLOCK_MIN_INTERVAL = 250;

/** webContents id -> { last, timer } */
const adblockSendState = new Map();

function sendAdblockUpdate(wcId) {
  const entry = adblockCounts.get(wcId);
  if (!entry) return;
  send('adblock:update', {
    wcId,
    blocked: entry.blocked,
    host: entry.host,
    allowed: isAllowedHost(entry.host),
  });
}

/**
 * At most one immediate send plus one trailing send per 250 ms window, so <= 4
 * messages/sec per tab. The trailing send reads the counter at fire time, so
 * the last value always arrives even though the ones in between are dropped.
 */
function queueAdblockUpdate(wcId) {
  let st = adblockSendState.get(wcId);
  if (!st) {
    st = { last: 0, timer: null };
    adblockSendState.set(wcId, st);
  }
  if (st.timer) return;
  const wait = ADBLOCK_MIN_INTERVAL - (Date.now() - st.last);
  if (wait <= 0) {
    st.last = Date.now();
    sendAdblockUpdate(wcId);
    return;
  }
  st.timer = setTimeout(() => {
    st.timer = null;
    st.last = Date.now();
    sendAdblockUpdate(wcId);
  }, wait);
}

function forgetAdblockTab(wcId) {
  adblockCounts.delete(wcId);
  const st = adblockSendState.get(wcId);
  if (st && st.timer) clearTimeout(st.timer);
  adblockSendState.delete(wcId);
}

ipcMain.handle('adblock:state', () => adblockState());

ipcMain.handle('adblock:count', (_event, payload) => {
  const wcId = payload && payload.wcId;
  const entry = adblockCounts.get(wcId) || { blocked: 0, host: '' };
  return { blocked: entry.blocked, host: entry.host, allowed: isAllowedHost(entry.host) };
});

ipcMain.on('adblock:set-enabled', (_event, payload) => {
  const on = !!(payload && payload.on);
  adblockPrefs.enabled = on;
  saveAdblockPrefs();
  setBlockingEnabled(on);
  send('adblock:state-changed', adblockState());
});

ipcMain.on('adblock:allow-host', (_event, payload) => {
  const host = normaliseHost(payload && payload.host);
  if (!host) return;
  const on = !!(payload && payload.on);
  const index = adblockPrefs.allow.indexOf(host);
  if (on && index === -1) {
    adblockPrefs.allow.push(host);
    applyAllowRule(host);
  } else if (!on && index !== -1) {
    adblockPrefs.allow.splice(index, 1);
    removeAllowRule(host);
  }
  saveAdblockPrefs();
  send('adblock:state-changed', adblockState());
});

// ---------------------------------------------------------------------------
// Site info
//
// What sits behind the padlock for the page in the active tab: how the
// connection is secured, which permissions this origin has been explicitly
// granted or denied, and the two destructive actions (forget the permissions,
// clear the site's data). A guest page can inspect none of this itself.
//
// Every handler answers with { error: string } instead of throwing: a popover
// in the chrome must never be able to reject into the renderer.
// ---------------------------------------------------------------------------

/** Everything clearStorageData() can drop for one origin. */
const CLEARABLE_STORAGES = [
  'cookies',
  'localstorage',
  'indexdb',
  'serviceworkers',
  'cachestorage',
  'websql',
];

/** Loopback http IS a secure context in Chromium; do not call it 'http'. */
function isLoopbackHost(host) {
  const h = String(host || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

/** { secure, reason } for one already-parsed URL. */
function securityOf(url) {
  const scheme = url.protocol.replace(':', '');
  if (scheme === 'https') {
    return certErrors.has(url.origin)
      ? { secure: false, reason: 'certificate' }
      : { secure: true, reason: 'https' };
  }
  if (scheme === 'http') {
    return isLoopbackHost(url.hostname)
      ? { secure: true, reason: 'local' }
      : { secure: false, reason: 'http' };
  }
  // Pages that never crossed a network: our own chrome, a local file, a blob.
  if (['file', 'about', 'data', 'blob', 'chrome'].includes(scheme)) {
    return { secure: true, reason: 'local' };
  }
  return { secure: false, reason: 'other' };
}

/** The message for an { error } reply, without leaking a stack at the UI. */
function errorText(err) {
  return String((err && err.message) || err || 'failed');
}

ipcMain.handle('site:info', (_event, payload) => {
  try {
    let url;
    try {
      url = new URL(String((payload && payload.url) || ''));
    } catch {
      return { error: 'invalid url' };
    }
    const origin = validOrigin(url.href);
    const { secure, reason } = securityOf(url);
    return {
      origin: origin || url.origin,
      host: url.hostname,
      scheme: url.protocol.replace(':', ''),
      secure,
      reason,
      // Only what was actually decided -- an absent name means "still asks".
      permissions: origin ? permissionsForOrigin(origin) : {},
      promptable: [...PERMISSION_PROMPT_LIST],
    };
  } catch (err) {
    return { error: errorText(err) };
  }
});

ipcMain.handle('site:set-permission', (_event, payload) => {
  try {
    const origin = validOrigin(payload && payload.origin);
    if (!origin) return { error: 'invalid origin' };
    const permission = String((payload && payload.permission) || '');
    if (!KNOWN_PERMISSIONS.has(permission)) return { error: 'unknown permission' };
    const decision = String((payload && payload.decision) || '');
    if (decision !== 'allow' && decision !== 'block' && decision !== 'ask') {
      return { error: 'invalid decision' };
    }

    if (decision === 'ask') {
      // Forgetting is not the same as blocking: the next request prompts again.
      permissionDecisions.delete(origin + '|' + permission);
      savePermissionDecisions();
    } else {
      rememberPermission(origin, permission, decision === 'allow');
    }
    send('site:permissions-changed', { origin });
    return permissionsForOrigin(origin);
  } catch (err) {
    return { error: errorText(err) };
  }
});

ipcMain.handle('site:reset-permissions', (_event, payload) => {
  try {
    const origin = validOrigin(payload && payload.origin);
    if (!origin) return { error: 'invalid origin' };
    const prefix = origin + '|';
    for (const key of [...permissionDecisions.keys()]) {
      if (key.startsWith(prefix)) permissionDecisions.delete(key);
    }
    savePermissionDecisions();
    send('site:permissions-changed', { origin });
    return permissionsForOrigin(origin); // {}
  } catch (err) {
    return { error: errorText(err) };
  }
});

/**
 * The domains a cookie for this host could have been stored under: the host
 * itself, and its parent domain when there is one (a cookie set for
 * `.example.com` by www.example.com belongs to no single origin).
 */
function cookieDomainsFor(host) {
  const labels = String(host || '')
    .split('.')
    .filter(Boolean);
  if (!labels.length) return [];
  const domains = [labels.join('.')];
  if (labels.length > 2) domains.push(labels.slice(1).join('.'));
  return domains;
}

ipcMain.handle('site:clear-data', async (_event, payload) => {
  try {
    const origin = validOrigin(payload && payload.origin);
    if (!origin) return { error: 'invalid origin' };
    const sess = session.defaultSession;
    if (!sess) return { error: 'no session' };

    // The cookie jar is walked FIRST, and by hand: clearStorageData({ origin })
    // matches scheme+host+port exactly, so a domain cookie set for
    // `.example.com` would survive it -- and anything it did drop could no
    // longer be counted. Host and parent domain both.
    const host = new URL(origin).hostname;
    const seen = new Set();
    let cookiesRemoved = 0;
    for (const domain of cookieDomainsFor(host)) {
      let cookies = [];
      try {
        cookies = await sess.cookies.get({ domain });
      } catch {
        cookies = []; // a jar we cannot read is not a reason to fail the clear
      }
      for (const cookie of cookies) {
        const bare = String(cookie.domain || host).replace(/^\./, '');
        const cookiePath = cookie.path || '/';
        const key = bare + cookiePath + '|' + cookie.name;
        if (seen.has(key)) continue; // the parent query re-lists the host's own
        seen.add(key);
        const url = (cookie.secure ? 'https://' : 'http://') + bare + cookiePath;
        try {
          await sess.cookies.remove(url, cookie.name);
          cookiesRemoved += 1;
        } catch {
          // Already gone, or not ours to remove -- do not count it.
        }
      }
    }

    // Then everything else the origin owns -- plus any cookie the walk above
    // could not name.
    await sess.clearStorageData({ origin, storages: CLEARABLE_STORAGES });
    return { cookiesRemoved };
  } catch (err) {
    return { error: errorText(err) };
  }
});

// ---------------------------------------------------------------------------
// Shortcuts that must survive page focus
//
// A key pressed while focus sits inside a <webview> never reaches our renderer:
// the guest page consumes it first. So intercept in the main process and
// forward the intent to the chrome renderer. Without this, Ctrl+` fails exactly
// when you'd want it -- while you are actually reading a page.
// ---------------------------------------------------------------------------

/**
 * What each key means, keyed by combo. This is only the built-in default: the
 * renderer owns the real map (shortcuts.js) and mirrors it over 'shortcuts:set'
 * at boot and after every change, so these entries are what a renderer that
 * never sends would get.
 *
 * A combo reads Ctrl, Alt, then Shift, letters uppercase, and the UNSHIFTED
 * character of a punctuation key -- see comboFromInput() below.
 */
const DEFAULT_BINDINGS = {
  'Ctrl+`': 'toggle-terminal',
  'Ctrl+T': 'new-tab',
  'Ctrl+Shift+T': 'reopen-tab',
  'Ctrl+W': 'close-tab',
  'Ctrl+L': 'focus-omnibox',
  'Ctrl+=': 'zoom-in',
  'Ctrl+Shift+=': 'zoom-in', // the '+' key, which needs Shift on a US layout
  'Ctrl+-': 'zoom-out',
  'Ctrl+0': 'zoom-reset',
  'Ctrl+F': 'find',
  'Ctrl+J': 'downloads',
  'Ctrl+K': 'command-palette',
  'Ctrl+Shift+K': 'ask-claude',
  'Ctrl+H': 'history',
  'Ctrl+D': 'bookmark',
  'Ctrl+,': 'settings',
  'Ctrl+R': 'reload',
  'Ctrl+Shift+R': 'reader',
  'Ctrl+Shift+A': 'tabsearch',
  'Ctrl+Shift+S': 'capture',
  'Ctrl+Shift+B': 'bookmarks-bar',
  'Ctrl+\\': 'split',
  'Ctrl+Shift+\\': 'claude-split',
  // Alt+Arrow is history navigation in every browser, and the page eats it.
  'Alt+Left': 'back',
  'Alt+Right': 'forward',
};

let keyBindings = DEFAULT_BINDINGS;

/**
 * The renderer's map, whenever it changes. Anything that is not a plain object
 * of string -> string is ignored, and so is one that leaves nothing usable:
 * main keeps what it already had rather than losing every page-focus shortcut
 * to a single bad payload.
 */
ipcMain.on('shortcuts:set', (_event, payload) => {
  const next = payload && payload.bindings;
  if (!next || typeof next !== 'object' || Array.isArray(next)) return;
  const clean = Object.create(null);
  let count = 0;
  for (const combo of Object.keys(next)) {
    const action = next[combo];
    if (typeof combo !== 'string' || typeof action !== 'string') continue;
    if (!combo || !action) continue;
    clean[combo] = action;
    count += 1;
  }
  if (!count || count > 200) return; // a real map has a few dozen entries
  keyBindings = clean;
});

/** A modifier pressed on its own is never a combo. */
const MODIFIER_KEYS = {
  Control: 1, Ctrl: 1, Alt: 1, AltGraph: 1, Shift: 1, Meta: 1,
  OS: 1, CapsLock: 1, NumLock: 1, ScrollLock: 1, Dead: 1, Unidentified: 1,
};

/** input.key spellings -> the canonical name a combo is written with. */
const NAMED_KEYS = {
  ArrowLeft: 'Left', Left: 'Left',
  ArrowRight: 'Right', Right: 'Right',
  ArrowUp: 'Up', Up: 'Up',
  ArrowDown: 'Down', Down: 'Down',
  PageUp: 'PageUp', PageDown: 'PageDown',
  Home: 'Home', End: 'End',
  Tab: 'Tab', Enter: 'Enter', Return: 'Enter',
  ' ': 'Space', Space: 'Space', Spacebar: 'Space',
  Backspace: 'Backspace',
  Delete: 'Delete', Del: 'Delete',
  Insert: 'Insert',
  Escape: 'Escape', Esc: 'Escape',
};

/**
 * Shifted characters, back to the key actually pressed. Bindings are written in
 * unshifted terms ('Ctrl+Shift+\', never 'Ctrl+|'), so the Shift has to come
 * out of the character and go into the modifier list.
 */
const UNSHIFTED_CHARS = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6',
  '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[',
  '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
};

/**
 * An Electron `before-input-event` input object -> the combo string the binding
 * map is keyed by. Must agree with shortcuts.js's own fromMainInput(): the two
 * sides meet only through these strings, so the tables above are a copy of the
 * ones in shortcuts.js and have to move together.
 */
function comboFromInput(input) {
  const key = String((input && input.key) || '');
  if (!key) return '';
  if (Object.prototype.hasOwnProperty.call(MODIFIER_KEYS, key)) return '';
  let name = key;
  let shift = !!input.shift;

  if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, key)) {
    name = NAMED_KEYS[key]; // ArrowLeft -> Left, ' ' -> Space
  } else if (Object.prototype.hasOwnProperty.call(UNSHIFTED_CHARS, key)) {
    name = UNSHIFTED_CHARS[key]; // the character itself is proof Shift was down
    shift = true;
  } else if (key.length === 1) {
    name = key.toUpperCase();
  }

  const parts = [];
  if (input.control) parts.push('Ctrl');
  if (input.alt) parts.push('Alt');
  if (shift) parts.push('Shift');
  parts.push(name);
  return parts.join('+');
}

/**
 * Keys that mean something with no modifier at all. Escape is the odd one out:
 * it is mirrored to the chrome (to close the find bar) but never swallowed,
 * because the page still needs it.
 */
const BARE_KEYS = {
  F5: 'reload',
  F11: 'fullscreen',
  Escape: 'escape',
};

/**
 * Punctuation keys where Shift only changes the character printed. Bindings are
 * written unshifted ('Ctrl+='), so a shifted press of the same physical key --
 * which arrives as '+' and canonicalises to 'Ctrl+Shift+=' -- falls back to the
 * unshifted binding. shortcuts.js's actionFor() does exactly this for the
 * chrome; without the same tolerance here the '+' key would zoom only while the
 * chrome had focus and do nothing inside a page.
 */
const PUNCTUATION_KEYS = {
  ',': 1, '.': 1, '/': 1, '\\': 1, '=': 1, '-': 1, '`': 1, '[': 1, ']': 1, ';': 1, "'": 1,
};

/** A combo -> the bound action id, or null. Exact match first. */
function bindingFor(combo) {
  if (!combo) return null;
  if (Object.prototype.hasOwnProperty.call(keyBindings, combo)) return keyBindings[combo];
  // An exact match always wins above, which is what keeps Ctrl+Shift+\ apart
  // from Ctrl+\; only an unclaimed shifted punctuation combo falls back.
  if (combo.indexOf('Shift+') < 0) return null;
  const key = combo.slice(combo.lastIndexOf('+') + 1);
  if (!Object.prototype.hasOwnProperty.call(PUNCTUATION_KEYS, key)) return null;
  const bare = combo.replace('Shift+', '');
  return Object.prototype.hasOwnProperty.call(keyBindings, bare) ? keyBindings[bare] : null;
}

/** A key pressed inside a page -> the chrome action it means, or null. */
function shortcutFor(input) {
  const key = String(input.key);
  // Fixed cases, in front of the binding map because they are not rebindable.
  if (input.control && !input.alt) {
    if (key === 'Tab') return { action: input.shift ? 'prev-tab' : 'next-tab' };
    if (/^[1-9]$/.test(key)) return { action: 'select-tab', index: Number(key) };
  }
  // Everything else is whatever the renderer has bound the combo to.
  const action = bindingFor(comboFromInput(input));
  return typeof action === 'string' && action ? { action } : null;
}

// ---------------------------------------------------------------------------
// Guest context menu
//
// A <webview> has no menu of its own, and the built-in `role:` entries act on
// the focused *window*, not the guest -- so every item here calls the guest's
// own webContents method explicitly.
// ---------------------------------------------------------------------------

/** navigationHistory is the current API; the old methods are the fallback. */
function navHistory(contents) {
  return contents.navigationHistory || null;
}

function guestCanGoBack(contents) {
  const nav = navHistory(contents);
  if (nav && typeof nav.canGoBack === 'function') return nav.canGoBack();
  return typeof contents.canGoBack === 'function' ? contents.canGoBack() : false;
}

function guestCanGoForward(contents) {
  const nav = navHistory(contents);
  if (nav && typeof nav.canGoForward === 'function') return nav.canGoForward();
  return typeof contents.canGoForward === 'function' ? contents.canGoForward() : false;
}

function guestGoBack(contents) {
  const nav = navHistory(contents);
  if (nav && typeof nav.goBack === 'function') nav.goBack();
  else if (typeof contents.goBack === 'function') contents.goBack();
}

function guestGoForward(contents) {
  const nav = navHistory(contents);
  if (nav && typeof nav.goForward === 'function') nav.goForward();
  else if (typeof contents.goForward === 'function') contents.goForward();
}

/** Flatten non-empty groups into one template, separated. */
function joinMenuGroups(groups) {
  const template = [];
  for (const group of groups) {
    if (!group || !group.length) continue;
    if (template.length) template.push({ type: 'separator' });
    template.push(...group);
  }
  return template;
}

/** A destroyed guest throws on every getter; a menu must never take it down. */
function safeUrlOf(contents) {
  try { return contents.getURL() || ''; } catch (err) { return ''; }
}

function safeTitleOf(contents) {
  try { return contents.getTitle() || ''; } catch (err) { return ''; }
}

/** Menu labels are one line: collapse the selection and cap it at 30 chars. */
function selectionLabel(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 30 ? flat.slice(0, 30) + '…' : flat;
}

function guestMenuTemplate(contents, params) {
  const navigation = [
    { label: 'Back', enabled: guestCanGoBack(contents), click: () => guestGoBack(contents) },
    {
      label: 'Forward',
      enabled: guestCanGoForward(contents),
      click: () => guestGoForward(contents),
    },
    { label: 'Reload', click: () => contents.reload() },
  ];

  const link = [];
  if (params.linkURL) {
    link.push(
      {
        label: 'Open link in new tab',
        click: () => send('open-url', { url: params.linkURL, background: true }),
      },
      { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
      { label: 'Save link as', click: () => contents.downloadURL(params.linkURL) }
    );
  }

  const image = [];
  if (params.mediaType === 'image' && params.srcURL) {
    image.push(
      {
        label: 'Open image in new tab',
        click: () => send('open-url', { url: params.srcURL, background: true }),
      },
      { label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y) },
      { label: 'Save image', click: () => contents.downloadURL(params.srcURL) }
    );
  }

  const selection = [];
  const selected = String(params.selectionText || '').trim();
  if (selected) {
    selection.push(
      { label: 'Copy', click: () => contents.copy() },
      {
        label: 'Search Google for "' + selectionLabel(selected) + '"',
        click: () =>
          send('open-url', {
            url: 'https://www.google.com/search?q=' + encodeURIComponent(selected),
            background: false,
          }),
      }
    );
  }

  // The gesture this browser exists for: hand what you are looking at to a
  // Claude Code session standing next to it. Main only carries the facts --
  // app.js composes the prompt and pastes it into the chamber's INPUT, where
  // it waits for the user's own question. Nothing is ever executed from here.
  const askUrl = params.pageURL || safeUrlOf(contents);
  const askTitle = safeTitleOf(contents);
  const ask = [];
  if (selected) {
    ask.push({
      label: 'Ask Claude about "' + selectionLabel(selected) + '"',
      click: () => send('ask-claude', { url: askUrl, title: askTitle, selection: selected }),
    });
  }
  ask.push({
    label: 'Ask Claude about this page',
    click: () => send('ask-claude', { url: askUrl, title: askTitle, selection: '' }),
  });
  // The same hand-off with the page's picture attached: the renderer takes the
  // screenshot (capturePage belongs to the guest, and capture:tab already does
  // it) and pastes the file's path, which Claude Code can open.
  ask.push({
    label: 'Show Claude this page',
    click: () =>
      send('ask-claude', { url: askUrl, title: askTitle, selection: '', mode: 'screenshot' }),
  });
  // ...and with the article's TEXT attached: the renderer reads the page back
  // through reader.js and quotes it, so a session that cannot browse can still
  // answer from it. Main carries no page content either way.
  ask.push({
    label: 'Ask Claude about this article',
    click: () =>
      send('ask-claude', { url: askUrl, title: askTitle, selection: '', mode: 'article' }),
  });

  const editing = [];
  if (params.isEditable) {
    const flags = params.editFlags || {};
    editing.push(
      { label: 'Undo', enabled: flags.canUndo !== false, click: () => contents.undo() },
      { label: 'Redo', enabled: flags.canRedo !== false, click: () => contents.redo() },
      { label: 'Cut', enabled: flags.canCut !== false, click: () => contents.cut() },
      { label: 'Copy', enabled: flags.canCopy !== false, click: () => contents.copy() },
      { label: 'Paste', enabled: flags.canPaste !== false, click: () => contents.paste() },
      { label: 'Select all', click: () => contents.selectAll() }
    );
  }

  const inspect = [
    {
      label: 'Inspect',
      click: () => {
        contents.inspectElement(params.x, params.y);
        // inspectElement does not raise devtools that are already open.
        if (contents.isDevToolsOpened() && contents.devToolsWebContents) {
          contents.devToolsWebContents.focus();
        }
      },
    },
  ];

  // Selection items sit above editing ones so Copy-the-selection is not buried
  // under the edit block in a textarea.
  return joinMenuGroups([navigation, link, image, selection, ask, editing, inspect]);
}

// ---------------------------------------------------------------------------
// Spotify auto-pause IPC
//
// Every call resolves. A bridge that is not running, a scheduled task that is
// missing, a schtasks call that fails -- all of it comes back as plain English
// in `status.error` rather than as a rejected invoke, because the settings pane
// polls these and a throw there would surface as a dead section.
// ---------------------------------------------------------------------------

ipcMain.handle('autopause:status', () => autoPause.status());

ipcMain.handle('autopause:set-enabled', (_event, { on } = {}) => autoPause.setEnabled(!!on));

// The patch is re-validated inside the module (hosts are normalised, junk and
// duplicates dropped, the list capped) -- preload's clamp is the first pass,
// not the only one.
ipcMain.handle('autopause:set-config', (_event, patch = {}) => autoPause.setConfig(patch));

ipcMain.handle('autopause:doctor', () => autoPause.doctor());

// ---------------------------------------------------------------------------
// New tab system stats
//
// Ref-counted, so a renderer that subscribes twice has to unsubscribe twice.
// A renderer that goes away without balancing its subscribes (a reload, a
// crash, the window closing) would otherwise pin the sampler on forever, so
// its whole count is dropped the moment its webContents is destroyed.
// ---------------------------------------------------------------------------

ipcMain.on('stats:subscribe', (event) => {
  const contents = event.sender;
  if (!contents || contents.isDestroyed()) return;
  if (!statsWatched.has(contents.id)) {
    statsWatched.add(contents.id);
    const id = contents.id;
    contents.once('destroyed', () => {
      statsWatched.delete(id);
      stats.drop(id);
    });
  }
  stats.subscribe(contents);
});

ipcMain.on('stats:unsubscribe', (event) => {
  const contents = event.sender;
  if (!contents) return;
  stats.unsubscribe(contents);
});

/** How many pids one end-task call may carry. A list, never a sweep. */
const END_TASK_MAX_PIDS = 64;

/**
 * End the processes behind one row of the new tab page's process table.
 *
 * Killing a process is the one thing in this file a page must never be able to
 * ask for on its own, so the gate is deliberately narrow:
 *   - only the chrome's own webContents may call it (a <webview> guest, a
 *     devtools page or anything else is answered with an empty array),
 *   - at most END_TASK_MAX_PIDS integers, junk entries dropped,
 *   - the refusals themselves (self, protected, pid 0/4) live in stats.js.
 * A build whose stats.js predates endTask() answers 'unavailable' rather than
 * throwing, so the page can show a reason instead of a dead button.
 */
ipcMain.handle('stats:end-task', (event, pids) => {
  const contents = event.sender;
  if (!contents || !canSend() || contents !== win.webContents) return [];

  const list = [];
  if (Array.isArray(pids)) {
    for (const raw of pids) {
      const pid = Number(raw);
      if (!Number.isInteger(pid) || pid < 0) continue;
      if (list.indexOf(pid) === -1) list.push(pid);
      if (list.length >= END_TASK_MAX_PIDS) break;
    }
  }
  if (!list.length) return [];

  const end = typeof stats.endTask === 'function'
    ? stats.endTask.bind(stats)
    : (typeof statsModule.endTask === 'function' ? statsModule.endTask : null);
  if (!end) return list.map((pid) => ({ pid, ok: false, reason: 'unavailable' }));

  try {
    return Promise.resolve(end(list)).then(
      (results) => (Array.isArray(results) ? results : []),
      () => list.map((pid) => ({ pid, ok: false, reason: 'failed' }))
    );
  } catch (err) {
    return list.map((pid) => ({ pid, ok: false, reason: 'failed' }));
  }
});

// ---------------------------------------------------------------------------
// Installed apps (the new tab's dock, the palette's "Open <app>" rows)
//
// Same gate as stats:end-task, and for the same reason: starting a process and
// taking the foreground are the two things a PAGE must never be able to ask
// for. Only the chrome's own webContents is answered -- the new tab page is a
// <webview> guest with no preload, so it reaches these through app.js, which
// has already decided the click was real.
//
// Nothing here can throw at the renderer: every answer is a value, and a
// failure is a { ok: false, reason } the page can show.
// ---------------------------------------------------------------------------

/** True when this IPC call came from the chrome document itself. */
function isChromeSender(event) {
  const contents = event && event.sender;
  return !!contents && canSend() && contents === win.webContents;
}

/** An empty index, for a refused or failed call. */
function emptyAppList() {
  return { builtAt: 0, buildMs: 0, fromCache: false, iconsOmitted: false, counts: { total: 0 }, apps: [] };
}

ipcMain.handle('apps:list', (event) => {
  if (!isChromeSender(event)) return emptyAppList();
  try {
    return apps.list().catch(() => emptyAppList());
  } catch {
    return emptyAppList();
  }
});

ipcMain.handle('apps:refresh', (event) => {
  if (!isChromeSender(event)) return emptyAppList();
  try {
    return apps.refresh().catch(() => emptyAppList());
  } catch {
    return emptyAppList();
  }
});

// Icons travel with apps:list unless the whole set is over the budget; this is
// the per-entry fallback for that case (and for an icon that arrived late).
ipcMain.handle('apps:icon', (event, id) => {
  if (!isChromeSender(event)) return null;
  try {
    return apps.icon(typeof id === 'string' ? id : '').catch(() => null);
  } catch {
    return null;
  }
});

ipcMain.handle('apps:launch', (event, id) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  try {
    return apps.launch(typeof id === 'string' ? id : '').catch(() => ({ ok: false, reason: 'failed' }));
  } catch {
    return { ok: false, reason: 'failed' };
  }
});

// The one place in this file that is ALLOWED to steal focus: the user clicked
// a dock tile whose running dot was lit, and "switch to it" is the whole point.
ipcMain.handle('apps:focus', (event, pid) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  try {
    return apps.focus(pid).catch(() => ({ ok: false, reason: 'failed' }));
  } catch {
    return { ok: false, reason: 'failed' };
  }
});

/** file:// prefix of the app's own folder: newtab.html, reader.html, history. */
const BUNDLED_PAGE_PREFIX = pathToFileURL(path.join(__dirname, path.sep)).href;

/** True for one of OUR file:// pages (the new tab page, reader, history). */
function isBundledPageUrl(url) {
  return typeof url === 'string' && url.toLowerCase().startsWith(BUNDLED_PAGE_PREFIX.toLowerCase());
}

/**
 * The scheme gate for anything a PAGE asks us to open in a new window. Only
 * http(s) survives: `javascript:` would run in the new document, `data:` and
 * `blob:` are the classic phishing shells, and `file:` is the one the
 * will-navigate lock below exists to stop. Returns the normalised href, or
 * null to deny.
 */
function webUrlOrNull(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  /*
   * window.open(), target="_blank", and anything else that wants a second
   * window -- including a link inside a cross-origin iframe, which is how
   * Google's account popover spells "Add another account".
   *
   * This browser has no second window: the chrome owns the tab strip, so the
   * answer is always 'deny' plus an 'open-url' to the renderer, which turns it
   * into a tab (the same channel a page's "open link in new tab" menu item
   * uses). Denying here is what keeps a page from ever getting a bare
   * BrowserWindow with none of our chrome on it.
   *
   * This replaces the <webview> 'new-window' DOM event app.js used to listen
   * for: that event was removed from Electron in v22 and never fires on 44, so
   * every popup in the app was silently dying. setWindowOpenHandler is the
   * modern path -- and it only runs at all because will-attach-webview turns
   * `allowpopups` on.
   *
   * Known trade-off: a page that opens a popup and then talks to it through
   * `window.opener` (the OAuth "sign in with Google" flow is the one that
   * matters) gets a tab with no opener, so the postMessage back to the first
   * page never arrives. Fixing that means letting a real child window through
   * with { action: 'allow' }, which is a bigger change than this one.
   */
  contents.setWindowOpenHandler((details) => {
    const url = webUrlOrNull(details && details.url);
    if (url) {
      send('open-url', { url, background: details.disposition === 'background-tab' });
    }
    return { action: 'deny' };
  });

  /*
   * Page-INITIATED navigation to file://. Chromium already refuses this for a
   * web page, so this is the second lock rather than the first -- but the cost
   * is one string test and the thing it stops (a page walking the guest onto
   * file:///C:/Users/... and reading it same-origin) is the worst outcome in
   * the app.
   *
   * will-navigate fires only for navigation the PAGE started: loadURL() and
   * setAttribute('src', …) -- which is every navigation the chrome itself
   * drives, omnibox included -- do not emit it. So typing a file:// path stays
   * exactly as it was.
   *
   * The one page-initiated file:// navigation we do want is our own: the new
   * tab page calls location.assign() for whatever was typed into its field,
   * and reader.html links back with location.href. Both are bundled pages.
   */
  contents.on('will-navigate', (event, url) => {
    if (typeof url !== 'string' || !/^file:/i.test(url)) return;
    if (isBundledPageUrl(safeUrl(contents))) return;
    event.preventDefault();
  });

  // A click inside a guest never reaches the chrome renderer; split view needs
  // to know which pane took focus so the omnibox and chips can follow it.
  contents.on('focus', () => send('guest-focus', { wcId: contents.id }));

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key);

    // Devtools belong to the GUEST, and only main has a handle on it -- so this
    // one is done here instead of round-tripping through the renderer.
    if (key === 'F12' || (input.control && input.shift && key.toLowerCase() === 'i')) {
      event.preventDefault();
      contents.toggleDevTools();
      return;
    }

    const bare = BARE_KEYS[key];
    if (bare) {
      // Escape is forwarded but not swallowed: the page still wants it.
      if (bare !== 'escape') event.preventDefault();
      send('shortcut', { action: bare });
      return;
    }

    // Ctrl and Alt combos are the rebindable ones; anything else is the
    // page's own business.
    if (input.meta || (!input.control && !input.alt)) return;
    const payload = shortcutFor(input);
    if (!payload) return;
    event.preventDefault();
    send('shortcut', payload);
  });

  contents.on('context-menu', (_e, params) => {
    const menu = Menu.buildFromTemplate(guestMenuTemplate(contents, params));
    const w = liveWin();
    menu.popup(w ? { window: w } : {});
  });

  // The blocked counter belongs to the PAGE, not the tab: a new main-frame
  // document starts from zero, and carries the host the chrome shows next to
  // it. 'did-navigate' is main-frame only, so an iframe cannot reset anything.
  contents.on('did-navigate', (_e, url) => {
    adblockCounts.set(contents.id, { blocked: 0, host: hostOfUrl(url) });
    queueAdblockUpdate(contents.id);
  });

  contents.on('destroyed', () => forgetAdblockTab(contents.id));

  // Spotify auto-pause watches this guest from here on: audible + a watched
  // host is what counts as "a video is playing". It attaches its own listeners
  // and drops the tab when it is destroyed.
  autoPause.watchGuest(contents);
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

app.on('window-all-closed', () => {
  killAll();
  handles.clear();
  for (const id of Array.from(ptyOut.keys())) ptyFlushFinal(id);
  app.quit();
});

app.on('before-quit', (event) => {
  // The one place a synchronous write is still right: there is no event loop
  // left to protect, and a snapshot that never reached disk is a lost session.
  // (app:restart goes through app.quit(), so a restart lands here too.)
  flushSessionSync();
  killAll();
  handles.clear();
  for (const id of Array.from(ptyOut.keys())) ptyFlushFinal(id);
  // The stats sampler's typeperf child is not ours to leave behind: it is a
  // separate process that would outlive the quit.
  stats.stop();
  // Same idea for the app index: a Get-StartApps or a focus PowerShell caught
  // mid-flight is a child of ours, and it is not going to be missed.
  apps.stop();
  // Hands our Spotify hold back. That is an HTTP round trip, so it may defer
  // the quit by up to ~1.5 s -- once, and only when a hold is actually out.
  // Skipping it would leave Spotify paused until the bridge's 180 s hold TTL
  // expired it.
  autoPause.handleQuit(event);
});
