'use strict';
/*
 * toprow-main.js — the pipe to Mantle for top-row hints (look-sync PROTOCOL v1).
 *
 * Mantle's top bar takes the colour of the window under it. toprow.js (the
 * chrome page) works out what this window's top pixel row looks like, in the
 * same task that changes it, and this file writes it to Mantle's pipe:
 *
 *   \\.\pipe\look-sync-toprow     one JSON object per line, UTF-8, <= 8 KB:
 *   {"v":1,"app":"quartz","hwnd":"<decimal HWND>","seq":<int, per hwnd>,
 *    "t":<Date.now() when the page made the change>,"top":TOP}
 *   TOP = {"kind":"wash","rgb":[r,g,b],"alpha":a} | {"kind":"flat","rgb":[r,g,b]}
 *       | {"kind":"cols","cols":[[r,g,b],...]}   | {"kind":"none"}
 *
 * WHERE IT RUNS. Two halves:
 *   createClient()  the pipe client. It runs in the CHROME RENDERER's preload
 *                   (preload.js; the chrome window has sandbox off, so Node's
 *                   net is there), so a hint goes from the page's task straight
 *                   into the pipe. It used to run in main: measured 2026-10-11,
 *                   main's event loop held hints back by a median 20-35 ms on a
 *                   tab switch and up to ~900 ms on a theme change (main was
 *                   busy with the webview and Look Sync), which is the delay
 *                   this whole feature exists to remove.
 *   install()       main's glue: tells the page its window's HWND, the pipe
 *                   and whether this is a test window (toprow:config), and
 *                   forwards the window events only main sees (toprow:window):
 *                   maximize / unmaximize / restore (the current hint again,
 *                   fresh seq), fullscreen on/off ("none" while fullscreen, the
 *                   chrome steps aside), and sign-in pop-ups opening and
 *                   closing ("none" for them: Windows draws their caption).
 *
 * When: every window's current hint on connect; the page's hint whenever it
 * sends one; "none" on create (nothing drawn yet) and on close (or just the
 * disconnect, when the page goes).
 *
 * Never blocks, never throws, never spams the log when Mantle isn't running:
 * one connection attempt at most every RETRY_MS, one log line per change of
 * state, writes are async (net) and a pipe that stops reading is dropped
 * once MAX_BACKLOG bytes are queued (then retried like any other drop). The
 * state and its reason, in words, go to Settings > Look via status().
 *
 * Test profiles (--test-profile) never talk to the real Mantle: they only
 * connect when TOPROW_PIPE names a pipe (a fake server), and say so.
 */
const PIPE = '\\\\.\\pipe\\look-sync-toprow';
const RETRY_MS = 2000;            // PROTOCOL: reconnect at most once per 2 s
const MAX_LINE = 8192;            // PROTOCOL: a line is at most 8 KB
const MAX_BACKLOG = 64 * 1024;    // queued and unread: Mantle has stopped reading
const NONE = Object.freeze({ kind: 'none' });
const TEST_OFF = 'off in this test window: test profiles only talk to TOPROW_PIPE, never the real Mantle';

/** The decimal HWND of a BrowserWindow (getNativeWindowHandle is the HWND's bytes). */
function hwndOf(win) {
  try {
    const b = win.getNativeWindowHandle();
    if (!b || !b.length) return null;
    return b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0));
  } catch (err) {
    return null;
  }
}

const isByte = (v) => Number.isInteger(v) && v >= 0 && v <= 255;
const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every(isByte);

/** A TOP from the page -> a clean TOP, or null when it is not one. */
function cleanTop(top) {
  if (!top || typeof top !== 'object') return null;
  switch (top.kind) {
    case 'wash': {
      const a = Number(top.alpha);
      if (!isRgb(top.rgb) || !(a >= 0 && a <= 1)) return null;
      return { kind: 'wash', rgb: top.rgb.slice(), alpha: Math.round(a * 1000) / 1000 };
    }
    case 'flat':
      return isRgb(top.rgb) ? { kind: 'flat', rgb: top.rgb.slice() } : null;
    case 'cols':
      if (!Array.isArray(top.cols) || !top.cols.length || top.cols.length > 2000 || !top.cols.every(isRgb)) return null;
      return { kind: 'cols', cols: top.cols.map((c) => c.slice()) };
    case 'none':
      return { kind: 'none' };
    default:
      return null;
  }
}

/** The line for one hint, within MAX_LINE: a cols hint too long for a line
    is halved (neighbouring columns averaged) until it fits. */
function lineOf(hwnd, seq, t, top) {
  let body = { v: 1, app: 'quartz', hwnd, seq, t, top };
  let s = JSON.stringify(body);
  let cols = top.kind === 'cols' ? top.cols : null;
  while (Buffer.byteLength(s, 'utf8') + 1 > MAX_LINE && cols && cols.length > 1) {
    const half = [];
    for (let i = 0; i < cols.length; i += 2) {
      const a = cols[i], b = cols[i + 1] || cols[i];
      half.push([0, 1, 2].map((j) => Math.round((a[j] + b[j]) / 2)));
    }
    cols = half;
    body = { v: 1, app: 'quartz', hwnd, seq, t, top: { kind: 'cols', cols } };
    s = JSON.stringify(body);
  }
  if (Buffer.byteLength(s, 'utf8') + 1 > MAX_LINE) s = JSON.stringify({ v: 1, app: 'quartz', hwnd, seq, t, top: NONE });
  return s + '\n';
}

function reasonOf(err, pipe) {
  const code = err && err.code;
  if (code === 'ENOENT') return 'Mantle is not running (no pipe ' + (pipe || PIPE) + ')';
  if (code === 'EPIPE' || code === 'ECONNRESET') return 'Mantle closed the pipe';
  if (code === 'EACCES' || code === 'EPERM') return 'Windows refused the pipe (' + code + ')';
  if (code === 'EBUSY') return "Mantle's pipe is busy";
  return (err && err.message) || String(err);
}

/**
 * The pipe client (runs in the chrome renderer's preload).
 * deps: { net, pipe?, disabled?, log?, now?, onStatus? }
 *   disabled: a reason in words -> never connects, status 'off' with it
 * Returns {
 *   window(hwnd, { chrome })   a window to speak for ("none" goes out for it now)
 *   event(hwnd, name)          maximize | unmaximize | restore | enter-full-screen |
 *                              leave-full-screen | closed
 *   hint(top, t)               the chrome window's top row (before window(): kept)
 *   status(), close()
 * }
 */
function createClient(deps) {
  const netImpl = deps.net;
  const pipe = deps.pipe || PIPE;
  const disabled = deps.disabled || null;
  const log = deps.log || ((...a) => console.log('[toprow]', ...a));
  const now = deps.now || Date.now;
  const onStatus = deps.onStatus || (() => {});

  const windows = new Map();      // hwnd -> { hwnd, seq, pageTop, fullscreen, chrome }
  let pendingTop = null;          // a hint from before the chrome window was named
  let pendingT = null;
  let sock = null;
  let connected = false;
  let retryTimer = null;
  let lastTry = 0;
  let closed = false;
  let sentTotal = 0;
  let tries = 0;
  let status = disabled
    ? { state: 'off', reason: disabled, pipe, since: now() }
    : { state: 'connecting', reason: null, pipe, since: now() };
  let lastLogged = null;

  function snapshot() {
    return Object.assign({}, status, { sent: sentTotal, tries, windows: windows.size, retryMs: RETRY_MS });
  }

  function setStatus(state, reason) {
    if (status.state === state && status.reason === (reason || null)) return;
    status = { state, reason: reason || null, pipe, since: now() };
    const line = state + (reason ? ': ' + reason : '');
    if (line !== lastLogged) { lastLogged = line; try { log(line); } catch (err) { /* logging only */ } }
    try { onStatus(snapshot()); } catch (err) { /* a listener's problem */ }
  }

  /* ---- the connection ------------------------------------------------ */

  function scheduleRetry() {
    if (closed || disabled || retryTimer || sock) return;
    const wait = Math.max(0, lastTry + RETRY_MS - now());
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, wait);
  }

  function connect() {
    if (closed || disabled || sock) return;
    lastTry = now();
    tries += 1;
    let s;
    try {
      s = netImpl.connect(pipe);
    } catch (err) {
      setStatus('waiting', reasonOf(err, pipe));
      scheduleRetry();
      return;
    }
    sock = s;
    s.on('connect', () => {
      if (sock !== s) return;
      connected = true;
      setStatus('connected', null);
      for (const w of windows.values()) emit(w);        // every window's current hint
    });
    s.on('data', () => { /* PROTOCOL v1: nothing comes back; read it so the pipe never fills */ });
    s.on('error', (err) => {
      if (sock !== s) return;
      setStatus('waiting', reasonOf(err, pipe));
    });
    s.on('close', () => {
      if (sock !== s) return;
      sock = null;
      const was = connected;
      connected = false;
      if (was && status.state === 'connected') setStatus('waiting', 'Mantle closed the pipe');
      scheduleRetry();
    });
  }

  function write(line) {
    if (!connected || !sock) return false;
    if (sock.writableLength > MAX_BACKLOG) {
      setStatus('waiting', 'Mantle stopped reading its pipe (' + sock.writableLength + ' bytes waiting)');
      try { sock.destroy(); } catch (err) { /* closing anyway */ }
      return false;
    }
    try { sock.write(line); return true; } catch (err) { setStatus('waiting', reasonOf(err, pipe)); return false; }
  }

  /* ---- the windows ---------------------------------------------------- */

  function emit(w, top, t) {
    w.seq += 1;
    const say = top || (w.fullscreen ? NONE : (w.pageTop || NONE));
    if (write(lineOf(w.hwnd, w.seq, Number.isFinite(t) ? t : now(), say))) sentTotal += 1;
  }

  function chromeWin() {
    for (const w of windows.values()) if (w.chrome) return w;
    return null;
  }

  function addWindow(hwnd, opts) {
    hwnd = String(hwnd || '');
    if (!/^\d+$/.test(hwnd) || windows.has(hwnd)) return;
    const w = { hwnd, seq: 0, pageTop: null, fullscreen: !!(opts && opts.fullscreen), chrome: !!(opts && opts.chrome) };
    windows.set(hwnd, w);
    emit(w, NONE);                                         // on create: nothing drawn yet
    if (w.chrome && pendingTop) {                          // the page spoke before it knew its HWND
      w.pageTop = pendingTop;
      pendingTop = null;
      emit(w, null, pendingT);
    }
  }

  function event(hwnd, name) {
    const w = windows.get(String(hwnd));
    if (!w) return;
    if (name === 'enter-full-screen') { w.fullscreen = true; emit(w, NONE); }
    else if (name === 'leave-full-screen') { w.fullscreen = false; emit(w); }
    else if (name === 'maximize' || name === 'unmaximize' || name === 'restore') emit(w);
    else if (name === 'closed') { emit(w, NONE); windows.delete(w.hwnd); }
  }

  function hint(top, t) {
    const clean = cleanTop(top) || NONE;
    const w = chromeWin();
    if (!w) { pendingTop = clean; pendingT = t; return; }
    w.pageTop = clean;
    emit(w, null, t);
  }

  function close() {
    closed = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (sock) {
      for (const w of windows.values()) emit(w, NONE);     // on quit: nothing to say any more
      try { sock.end(); } catch (err) { /* gone */ }
    }
  }

  if (!disabled) connect();
  return { window: addWindow, event, hint, status: snapshot, close, _windows: windows };
}

/**
 * Main's glue. deps: { ipcMain, BrowserWindow, test }
 * Returns { attachWindow(win, { chrome }) }.
 */
function install(deps) {
  const { ipcMain, BrowserWindow } = deps;
  const envPipe = process.env.TOPROW_PIPE || null;
  const pipe = envPipe || PIPE;
  const disabled = deps.test && !envPipe ? TEST_OFF : null;
  let chrome = null;              // the chrome window (pop-up events go to its page)

  ipcMain.handle('toprow:config', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== chrome) return null;
    let fullscreen = false;
    try { fullscreen = win.isFullScreen(); } catch (err) { /* not yet */ }
    return { hwnd: hwndOf(win), pipe, disabled, fullscreen };
  });

  function tell(msg) {
    try {
      if (chrome && !chrome.isDestroyed() && !chrome.webContents.isDestroyed()) chrome.webContents.send('toprow:window', msg);
    } catch (err) { /* the page is gone: its pipe went with it */ }
  }

  function attachWindow(win, opts) {
    const hwnd = hwndOf(win);
    if (!hwnd) return null;
    if (opts && opts.chrome) {
      chrome = win;
      for (const ev of ['maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
        win.on(ev, () => tell({ hwnd, event: ev }));
      }
    } else {
      tell({ hwnd, event: 'create', chrome: false });
      win.on('closed', () => tell({ hwnd, event: 'closed' }));
    }
    return hwnd;
  }

  return { attachWindow };
}

module.exports = { install, createClient, cleanTop, lineOf, hwndOf, PIPE, RETRY_MS, MAX_LINE, TEST_OFF };
