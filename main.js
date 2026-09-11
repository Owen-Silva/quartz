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
} = require('electron');
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
  attachSessionHandlers();
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

/** Progress ticks far faster than anyone can read. ~8/sec is plenty. */
const DOWNLOAD_UPDATE_MS = 125;

/** Give up de-duplicating a name long before we can hang on a full folder. */
const MAX_DUPLICATE_TRIES = 500;

/**
 * The first path in `dir` that does not exist yet: 'a.zip', then 'a (1).zip'.
 * Silently clobbering a file the user already has is the one download
 * behaviour nobody forgives.
 */
function uniqueDownloadPath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  for (let i = 1; i <= MAX_DUPLICATE_TRIES && fs.existsSync(candidate); i++) {
    candidate = path.join(dir, base + ' (' + i + ')' + ext);
  }
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
  } catch {
    // The item was destroyed mid-read; the record keeps its last good values.
  }
}

function handleWillDownload(_event, item) {
  const dir = app.getPath('downloads');
  let savePath = '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    savePath = uniqueDownloadPath(dir, item.getFilename());
    // Setting the path up front is exactly what suppresses the save dialog.
    item.setSavePath(savePath);
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

ipcMain.on('dl:clear', () => {
  for (const [id, entry] of downloads) {
    if (entry.state !== 'progressing') downloads.delete(id);
  }
});

// Used by the context menu's Save link as / Save image, which have a URL but
// no DownloadItem yet. Going through the window's webContents means the
// request carries our normal session, cookies included.
ipcMain.on('dl:download-url', (_event, { url } = {}) => {
  const w = liveWin();
  if (w && typeof url === 'string' && url) w.webContents.downloadURL(url);
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
  if (permissionDecisions.has(key)) return Promise.resolve(permissionDecisions.get(key));
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
      permissionDecisions.set(key, allowed);
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
  f: 'find',
  j: 'downloads',
  h: 'history',
  d: 'bookmark',
  ',': 'settings',
};

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
  return joinMenuGroups([navigation, link, image, selection, editing, inspect]);
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

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

    // Alt+Arrow is history navigation in every browser, and the page eats it.
    if (input.alt && !input.control && !input.meta) {
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        event.preventDefault();
        send('shortcut', { action: key === 'ArrowLeft' ? 'back' : 'forward' });
      }
      return;
    }

    const bare = BARE_KEYS[key];
    if (bare) {
      // Escape is forwarded but not swallowed: the page still wants it.
      if (bare !== 'escape') event.preventDefault();
      send('shortcut', { action: bare });
      return;
    }

    if (!input.control || input.alt || input.meta) return;
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
