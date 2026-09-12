'use strict';

/**
 * embed.js — native app tabs.
 *
 * The user: "for apps is there a way where I can start the apps in a tab but it's
 * running the app so that literally everything is just in a tab?"
 *
 * This is the engine for that. A real program's real top-level window is
 * re-parented INTO the browser window (SetParent) and moved to sit exactly over
 * a tab's content area, so Notepad, Explorer, a game launcher — anything with a
 * plain Win32 window — runs as ITSELF inside a tab. Nothing is screen-scraped
 * or remoted: it is the app's own HWND, drawing its own pixels, one child
 * window deep inside ours.
 *
 * WHY WIN32 AND NOT ELECTRON: there is no Electron API for hosting a foreign
 * HWND. The four calls that make this work (SetParent, GetWindowLongPtr,
 * SetWindowLongPtr, SetWindowPos) are user32, so the module talks to user32
 * directly through koffi — an N-API FFI that needs no native rebuild against
 * Electron's headers. When koffi cannot load, every entry point answers
 * { ok: false, reason: 'unavailable' } and the browser is exactly what it was.
 *
 * THE ONE RULE THAT MATTERS: a child HWND dies with its parent. If the browser
 * window is destroyed while an app is still parented into it, Windows destroys
 * the app's window too — which for most programs means the program exits. So
 * detachAll() runs on 'before-quit', on the main window's 'close', and once
 * more from process.on('exit') as a last resort. That path must never be
 * skipped: skipping it turns a browser quit into "the user's app just vanished".
 *
 * WHAT THIS MODULE DOES NOT DO: it knows nothing about tabs, layout or the
 * chrome. It takes a tabId as an opaque key and a rectangle in the chrome
 * page's CSS pixels, and it answers values — never throws at a caller.
 *
 * HWNDs travel as DECIMAL STRINGS ('4523874'). koffi hands out pointers as
 * BigInt, and a BigInt is a poor thing to push through IPC and JSON, so every
 * hwnd leaving this module is a string and every hwnd arriving is accepted as
 * a string, a number or a BigInt.
 */

const { app, screen, BrowserWindow } = require('electron');
const EventEmitter = require('events');
const { execFile, execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Win32, through koffi
// ---------------------------------------------------------------------------

/** Window styles (winuser.h). Kept as BigInt: WS_POPUP is 0x80000000, which is
 *  past the int32 range JS bitwise operators work in. */
const WS_CHILD = 0x40000000n;
const WS_POPUP = 0x80000000n;
const WS_CAPTION = 0x00c00000n;
const WS_THICKFRAME = 0x00040000n;
const WS_MINIMIZEBOX = 0x00020000n;
const WS_MAXIMIZEBOX = 0x00010000n;
const WS_SYSMENU = 0x00080000n;
const WS_DLGFRAME = 0x00400000n;
const WS_BORDER = 0x00800000n;

/** Everything a top-level window wears that a child window must not. */
const DECORATION = WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX
  | WS_MAXIMIZEBOX | WS_SYSMENU | WS_DLGFRAME | WS_BORDER;

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;

/** A tool window is a palette/tooltip/tray helper, never a document window. */
const WS_EX_TOOLWINDOW = 0x00000080n;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;
const SWP_HIDEWINDOW = 0x0080;

/** SetWindowPos's hWndInsertAfter. 0 is HWND_TOP. */
const HWND_TOP = 0n;

const SW_HIDE = 0;
/** Restore/show WITHOUT activating. SW_RESTORE DOES activate a window, and the user
 *  is at the machine: hosting a minimised app must never take his keyboard. */
const SW_SHOWNOACTIVATE = 4;

const WM_CLOSE = 0x0010;

const GA_PARENT = 1;
const GA_ROOT = 2;

/** GetWindow(GW_OWNER): a window's OWNER, which is not its parent. An owned
 *  window is a dialog, splash or palette belonging to another window; hosting
 *  one leaves its owner behind on the desktop still driving it, so they are
 *  refused. (An owned window's GA_ROOT is itself, so the top-level test below
 *  does NOT catch them -- measured: a credential dialog owned by this very
 *  browser window enumerated as "hostable".) */
const GW_OWNER = 4;

/** OpenProcess access that a non-elevated process is allowed to ask for. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** A window of one of these classes is a Store/UWP app: see attach(). */
const STORE_CLASSES = new Set(['applicationframewindow', 'windows.ui.core.corewindow']);

/**
 * Everything user32/kernel32 gives us, or null when koffi would not load.
 *
 * Bound LAZILY, on the first call that needs it, and never at require() time:
 * The user restarts the browser from this folder while it is being worked on, and a
 * native module that is missing, half-installed or built for another ABI must
 * cost him a dead `api.embed`, not a browser that will not start.
 */
let w32 = null;
let w32Tried = false;

function win32() {
  if (!w32Tried) {
    w32Tried = true;
    try { w32 = loadWin32(); } catch { w32 = null; }
  }
  return w32;
}

/**
 * Bind the Win32 surface once. Returns null (never throws) when koffi is
 * missing or refuses to load, which is the whole of this module's fallback
 * story: no FFI, no native tabs, browser unchanged.
 */
function loadWin32() {
  if (process.platform !== 'win32') return null;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    // Prefixed names: koffi's type registry is per-process, and a second
    // module binding its own RECT must not collide with ours.
    const RECT = koffi.struct('EmbedRect', {
      left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t',
    });
    koffi.proto('bool __stdcall EmbedEnumProc(void *hwnd, intptr_t lparam)');

    // GUITHREADINFO, for "which window actually has the keyboard". cbSize has
    // to be filled in by the caller, so the size is bound alongside the call.
    koffi.struct('EmbedGuiThreadInfo', {
      cbSize: 'uint32_t',
      flags: 'uint32_t',
      hwndActive: 'void *',
      hwndFocus: 'void *',
      hwndCapture: 'void *',
      hwndMenuOwner: 'void *',
      hwndMoveSize: 'void *',
      hwndCaret: 'void *',
      rcCaret: 'EmbedRect',
    });

    return {
      koffi,
      RECT,
      EnumWindows: user32.func('bool __stdcall EnumWindows(EmbedEnumProc *cb, intptr_t lparam)'),
      IsWindow: user32.func('bool __stdcall IsWindow(void *h)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *h)'),
      /* THE WATCHDOG'S ONE QUESTION. SetParent joined the app's input queue to
       * ours, so an app that stops pumping messages freezes the BROWSER's input
       * too -- this is how the poll notices in time to let go. Like IsWindow it
       * reads state the window manager already keeps (the last time that thread
       * pumped), so it cannot itself block on the wedged app. */
      IsHungAppWindow: user32.func('bool __stdcall IsHungAppWindow(void *h)'),
      IsIconic: user32.func('bool __stdcall IsIconic(void *h)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *h, _Out_ uint8_t *buf, int max)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(void *h, _Out_ uint8_t *buf, int max)'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *h, _Out_ uint32_t *pid)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(void *h, _Out_ EmbedRect *r)'),
      GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(void *h, int idx)'),
      SetWindowLongPtrW: user32.func('intptr_t __stdcall SetWindowLongPtrW(void *h, int idx, intptr_t v)'),
      SetParent: user32.func('void * __stdcall SetParent(void *child, void *parent)'),
      GetParent: user32.func('void * __stdcall GetParent(void *h)'),
      GetWindow: user32.func('void * __stdcall GetWindow(void *h, uint32_t cmd)'),
      GetAncestor: user32.func('void * __stdcall GetAncestor(void *h, uint32_t flags)'),
      SetWindowPos: user32.func('bool __stdcall SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, uint32_t flags)'),
      ShowWindow: user32.func('bool __stdcall ShowWindow(void *h, int cmd)'),
      PostMessageW: user32.func('bool __stdcall PostMessageW(void *h, uint32_t msg, uintptr_t wp, intptr_t lp)'),
      GetDpiForWindow: user32.func('uint32_t __stdcall GetDpiForWindow(void *h)'),
      // Focus truth (focusInfo below). GetFocus() is deliberately NOT here: it
      // answers for the CALLING thread's input queue, which is never the one
      // the hosted app's window belongs to.
      GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
      GetGUIThreadInfo: user32.func('bool __stdcall GetGUIThreadInfo(uint32_t tid, _Inout_ EmbedGuiThreadInfo *gui)'),
      SetFocus: user32.func('void * __stdcall SetFocus(void *h)'),
      GUI_SIZE: koffi.sizeof('EmbedGuiThreadInfo'),
      OpenProcess: kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(void *h)'),
      QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32_t flags, _Out_ uint8_t *buf, _Inout_ uint32_t *size)'),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Whatever a caller gave us for an hwnd -> BigInt, or 0n when it is junk. */
function toHandle(value) {
  try {
    if (typeof value === 'bigint') return value >= 0n ? value : 0n;
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? BigInt(Math.trunc(value)) : 0n;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!/^\d+$/.test(text)) return 0n;
      return BigInt(text);
    }
  } catch { /* fall through */ }
  return 0n;
}

/** The only shape an hwnd leaves this module in. */
function handleText(handle) {
  return String(handle === null || handle === undefined ? 0n : handle);
}

/** A UTF-16 out-buffer read back as a JS string. */
function readWide(buf, chars) {
  if (!(chars > 0)) return '';
  return buf.toString('ucs2', 0, Math.min(chars * 2, buf.length));
}

function normalizeExe(name) {
  const text = String(name || '').trim().toLowerCase();
  if (!text) return '';
  const base = text.split(/[\\/]/).pop() || '';
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

function isFiniteInt(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/* The focus HWND used to be classified by CLASS NAME (`chrome_…` -> "that is
   our own chrome"). That is wrong for the apps this browser is built to host:
   Discord, VS Code, Cursor and the Spotify desktop app are Electron/CEF, so
   their windows are Chrome_WidgetWin_1 with a Chrome_RenderWidgetHostHWND
   inside them too. focusInfo() asks WHICH PROCESS owns the focus window
   instead -- see `ownProcess` there. */

/** A pid list from anything a caller might pass: a number, an array, junk. */
function pidList(value) {
  const raw = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  const out = [];
  for (const item of raw) {
    const n = Number(item);
    if (Number.isInteger(n) && n > 0 && out.indexOf(n) === -1) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The process tree
//
// "Host the window the launch produced" needs more than an exe name. Two copies
// of Paint are both mspaint.exe; a launcher (Discord's Update.exe, a game's
// bootstrapper, an App Execution Alias) draws its window from a DIFFERENT
// process than the one we started. So embed:open hands findWindows the pid it
// launched, and a window belonging to that pid OR ANY OF ITS DESCENDANTS is the
// one we want.
//
// Windows will not tell us a window's creation time, but it will tell us a
// PROCESS's, and that is the useful half: a window whose process started after
// the launch is new, whatever its pid.
//
// One PowerShell answers both questions for every process at once (~0.4 s), and
// the answer is cached for 2 s -- the poll loop looks four times a second, and
// pids do not move that fast. main.js warms it ASYNCHRONOUSLY between polls, so
// the synchronous read below is the fallback, not the normal path.
// ---------------------------------------------------------------------------

/** How long a snapshot is trusted. */
const PROC_TREE_TTL_MS = 2000;

/** The snapshot read gets this long before it is abandoned. */
const PROC_TREE_TIMEOUT_MS = 6000;

/** One line per process: '<pid> <parent pid> <start ms since epoch>'. */
const PROC_TREE_SCRIPT = [
  '$ErrorActionPreference = \'SilentlyContinue\'',
  'foreach ($p in Get-CimInstance Win32_Process) {',
  '  $c = 0',
  '  if ($p.CreationDate) { $c = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }',
  '  "$($p.ProcessId) $($p.ParentProcessId) $c"',
  '}'
].join('\n');

const PROC_TREE_ARGS = [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', Buffer.from(PROC_TREE_SCRIPT, 'utf16le').toString('base64')
];

/**
 * Parse the snapshot. A line that is not three numbers is skipped rather than
 * trusted; a truncated run still yields the processes that did print.
 *
 * @returns {{parents:Map<number,number>, starts:Map<number,number>}}
 */
function parseProcTree(text) {
  const parents = new Map();
  const starts = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!pid) continue;                                    // pid 0 is not a process
    parents.set(pid, Number(m[2]));
    starts.set(pid, Number(m[3]));
  }
  return { parents: parents, starts: starts };
}

/**
 * A pid set grown to include every descendant, breadth-first. The seeds are in
 * the set whether or not the tree knows them, so a snapshot that failed still
 * prefers the pid we launched.
 *
 * @param {number[]} seeds
 * @param {Map<number,number>|null} parents  pid -> parent pid
 * @returns {Set<number>}
 */
function descendantsOf(seeds, parents) {
  const set = new Set(pidList(seeds));
  if (!set.size || !parents || typeof parents.forEach !== 'function') return set;
  const kids = new Map();
  parents.forEach((ppid, pid) => {
    if (!ppid || ppid === pid) return;                     // no self-parenting cycles
    const list = kids.get(ppid);
    if (list) list.push(pid);
    else kids.set(ppid, [pid]);
  });
  const queue = Array.from(set);
  let guard = 0;
  while (queue.length && guard < 4096) {
    guard += 1;
    const pid = queue.shift();
    const list = kids.get(pid);
    if (!list) continue;
    for (const kid of list) {
      if (set.has(kid)) continue;                          // already counted: no loops
      set.add(kid);
      queue.push(kid);
    }
  }
  return set;
}

/**
 * Where a window sits in "which of these is the one I just asked for":
 *   0  it belongs to the launched process or one of its descendants
 *   1  its process started after the launch, so the window is new
 *   2  it was already there
 *
 * @param {{pid:number, startedAt?:number}} win
 * @param {Set<number>|null} prefer
 * @param {number} since  epoch ms of the launch, 0 to skip the rule
 */
function rankWindow(win, prefer, since) {
  const pid = win && Number(win.pid) ? Number(win.pid) : 0;
  if (prefer && pid && prefer.has(pid)) return 0;
  const started = win && Number(win.startedAt) ? Number(win.startedAt) : 0;
  if (since > 0 && started > 0 && started >= since) return 1;
  return 2;
}

/**
 * Order a sweep: preferred first, then freshly started, then the rest. Sorting
 * is STABLE, so within a rank the EnumWindows z-order (front to back) survives.
 *
 * @returns {object[]} a new array
 */
function orderWindows(list, prefer, since) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const at = Number(since) > 0 ? Math.trunc(Number(since)) : 0;
  return arr.sort((a, b) => rankWindow(a, prefer, at) - rankWindow(b, prefer, at));
}

// ---------------------------------------------------------------------------
// The hung-app watchdog's decision
// ---------------------------------------------------------------------------

/**
 * How many CONSECUTIVE samples decide. One is not enough in either direction:
 * an app is briefly "hung" every time it opens a modal, loads a huge file or
 * gets swapped in, and evicting a tab for that would be worse than the freeze.
 * Two ticks of the 1 s poll is 1-2 s of a genuinely wedged input queue.
 */
const HUNG_SAMPLES = 2;

/**
 * The whole watchdog, as a pure step so the debounce is testable without Win32.
 *
 *   state   { watching, hungStreak, okStreak } -- carry it between ticks.
 *           `watching` false is "hosted in a tab"; true is "already detached
 *           and being watched for a recovery".
 *   sample  { hung } -- one IsHungAppWindow read.
 *   ->      { state, action } where action is:
 *             'detach'     it has been hung HUNG_SAMPLES ticks running: get the
 *                          window out of our window (and off our input queue).
 *             'recovered'  it has answered HUNG_SAMPLES ticks running since:
 *                          the chrome may offer to host it again.
 *             ''           nothing to do this tick.
 *
 * A streak only counts while it is unbroken: one answering tick zeroes the hung
 * count, one hung tick zeroes the recovery count.
 */
function hungStep(state, sample) {
  const s = state && typeof state === 'object' ? state : {};
  const hung = !!(sample && sample.hung);
  const watching = !!s.watching;
  const hungStreak = watching ? 0 : (hung ? (Number(s.hungStreak) || 0) + 1 : 0);
  const okStreak = watching ? (hung ? 0 : (Number(s.okStreak) || 0) + 1) : 0;

  if (!watching && hungStreak >= HUNG_SAMPLES) {
    return { state: { watching: true, hungStreak: 0, okStreak: 0 }, action: 'detach' };
  }
  if (watching && okStreak >= HUNG_SAMPLES) {
    return { state: { watching: false, hungStreak: 0, okStreak: 0 }, action: 'recovered' };
  }
  return { state: { watching, hungStreak, okStreak }, action: '' };
}

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {BrowserWindow|function():BrowserWindow} opts.win the browser window,
 *   or a getter for it (main.js creates the window after this module is made).
 * @param {function(string, ...any)} [opts.log] optional trace sink.
 * @param {function(string)} [opts.onGone] convenience alias for on('gone').
 */
function create(opts) {
  const options = opts || {};
  const emitter = new EventEmitter();
  // Nothing here is fatal enough to deserve an unhandled 'error'.
  emitter.setMaxListeners(0);
  if (typeof options.onGone === 'function') emitter.on('gone', options.onGone);

  const log = typeof options.log === 'function' ? options.log : () => {};

  /** tabId -> attachment record. */
  const attached = new Map();

  /** pid -> 'notepad.exe', so a findWindows sweep is not 200 OpenProcess calls. */
  const exeByPid = new Map();

  /** hwnd (string) -> tabId, so a second attach of the same window is refused. */
  const byHandle = new Map();

  /** @type {NodeJS.Timeout|null} the 1 s liveness poll; runs only when busy. */
  let pollTimer = null;

  /** tabId -> timer, for close()'s "it ignored WM_CLOSE" fallback. */
  const closeTimers = new Map();

  /**
   * tabId -> { tabId, key, pid, exe } for a tab whose app has gone quiet. The
   * window is STILL HOSTED (see reportHung): this is the note that says a hang
   * has already been reported, so it is reported once and the recovery that
   * follows it is reported once too.
   */
  const hungWatch = new Map();

  const counters = {
    attaches: 0, detaches: 0, layouts: 0, layoutSkips: 0, polls: 0, gone: 0,
    finds: 0, trees: 0, hung: 0, recovered: 0, titles: 0
  };

  let shutdownHooked = false;

  // -- the browser window ---------------------------------------------------

  function liveWin() {
    const w = typeof options.win === 'function' ? options.win() : options.win;
    return w && typeof w.isDestroyed === 'function' && !w.isDestroyed() ? w : null;
  }

  /** Our own top-level HWND as a BigInt, or 0n when there is no window. */
  function browserHandle() {
    const w = liveWin();
    if (!w) return 0n;
    try {
      const buf = w.getNativeWindowHandle();
      if (!buf || buf.length < 8) return 0n;
      return buf.readBigUInt64LE(0);
    } catch {
      return 0n;
    }
  }

  /**
   * CSS pixels (what the chrome page measures in) -> physical pixels (what
   * SetWindowPos wants). Electron's own display scale first, because that is
   * the number Chromium laid the page out with; GetDpiForWindow is the fallback
   * for the moment before a display is matchable.
   */
  function scaleFactor() {
    const w = liveWin();
    if (w && screen && typeof screen.getDisplayMatching === 'function') {
      try {
        const display = screen.getDisplayMatching(w.getBounds());
        const sf = display && Number(display.scaleFactor);
        if (Number.isFinite(sf) && sf > 0) return sf;
      } catch { /* fall through to DPI */ }
    }
    if (w32) {
      try {
        const dpi = Number(w32.GetDpiForWindow(browserHandle()));
        if (Number.isFinite(dpi) && dpi > 0) return dpi / 96;
      } catch { /* fall through */ }
    }
    return 1;
  }

  // -- window facts ---------------------------------------------------------

  function windowTitle(handle) {
    try {
      const buf = Buffer.allocUnsafe(1024);
      return readWide(buf, w32.GetWindowTextW(handle, buf, 511));
    } catch {
      return '';
    }
  }

  function windowClass(handle) {
    try {
      const buf = Buffer.allocUnsafe(512);
      return readWide(buf, w32.GetClassNameW(handle, buf, 255));
    } catch {
      return '';
    }
  }

  /** Our own top-level HWNDs (every BrowserWindow, not just the chrome). */
  function ourHandles() {
    const out = new Set();
    try {
      for (const w of BrowserWindow.getAllWindows()) {
        try {
          if (w.isDestroyed()) continue;
          const buf = w.getNativeWindowHandle();
          if (buf && buf.length >= 8) out.add(buf.readBigUInt64LE(0));
        } catch { /* skip that window */ }
      }
    } catch { /* no BrowserWindow in a unit test */ }
    return out;
  }

  function windowExStyle(handle) {
    try { return BigInt(w32.GetWindowLongPtrW(handle, GWL_EXSTYLE)) & 0xffffffffn; }
    catch { return 0n; }
  }

  /**
   * The single gate for "may this window be hosted in a tab", used by BOTH the
   * sweep and attach(): a caller can hand attach() any HWND at all, so the
   * checks cannot live only in findWindows().
   *
   * Returns null when the window is hostable, or the refusal reason:
   *   'gone'           IsWindow says no
   *   'not-top-level'  it is already somebody's child (including OUR OWN
   *                    Chromium render-widget HWNDs, whose root is our window --
   *                    re-parenting one of those breaks the browser itself)
   *   'own-window'     it is one of ours, or lives in this process
   *   'owned-window'   it has an owner: a dialog/splash/palette, not an app
   *   'tool-window'    WS_EX_TOOLWINDOW: a palette or tray helper
   *   'store-app'      a UWP frame or CoreWindow (see attach()'s notes)
   */
  function hostable(handle, ours) {
    try { if (!w32.IsWindow(handle)) return 'gone'; } catch { return 'gone'; }
    const mine = ours || ourHandles();
    if (mine.has(handle)) return 'own-window';
    let root;
    try { root = w32.GetAncestor(handle, GA_ROOT); } catch { return 'gone'; }
    if (root !== handle) return 'not-top-level';
    let parentOf = null;
    try { parentOf = w32.GetParent(handle); } catch { parentOf = null; }
    if (parentOf) return 'not-top-level';
    let owner = null;
    try { owner = w32.GetWindow(handle, GW_OWNER); } catch { owner = null; }
    if (owner) return 'owned-window';
    if (windowExStyle(handle) & WS_EX_TOOLWINDOW) return 'tool-window';
    const pid = windowPid(handle);
    if (!pid || pid === process.pid) return 'own-window';
    if (STORE_CLASSES.has(windowClass(handle).toLowerCase())) return 'store-app';
    return null;
  }

  function windowPid(handle) {
    try {
      const out = [0];
      w32.GetWindowThreadProcessId(handle, out);
      const pid = Number(out[0]);
      return Number.isInteger(pid) && pid > 0 ? pid : 0;
    } catch {
      return 0;
    }
  }

  function windowRect(handle) {
    try {
      const r = {};
      if (!w32.GetWindowRect(handle, r)) return null;
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    } catch {
      return null;
    }
  }

  /**
   * 'notepad.exe' for a pid, '' when the process is gone or shy. Cached: a
   * findWindows sweep asks about the same handful of pids repeatedly, and the
   * cache is dropped wholesale rather than aged (pids are reused, and a stale
   * name only ever costs a missed match on the next sweep).
   */
  function exeForPid(pid) {
    if (!pid) return '';
    const hit = exeByPid.get(pid);
    if (hit !== undefined) return hit;
    let name = '';
    try {
      const h = w32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (h) {
        try {
          const buf = Buffer.allocUnsafe(2048);
          const size = [1024];
          if (w32.QueryFullProcessImageNameW(h, 0, buf, size)) {
            const full = readWide(buf, Number(size[0]));
            name = (full.split(/[\\/]/).pop() || '').toLowerCase();
          }
        } finally {
          w32.CloseHandle(h);
        }
      }
    } catch { /* '' is a fine answer */ }
    if (exeByPid.size > 512) exeByPid.clear();
    exeByPid.set(pid, name);
    return name;
  }

  // -- the process tree, cached ---------------------------------------------

  /** { at, parents, starts } or null before the first read. */
  let tree = null;

  /** The in-flight async read, so four polls a second cost one PowerShell. */
  let treeReading = null;

  function treeFresh() {
    return tree && Date.now() - tree.at <= PROC_TREE_TTL_MS ? tree : null;
  }

  function keepTree(text) {
    const parsed = parseProcTree(text);
    // An empty parse is a failed run, not "no processes": keep the old snapshot
    // rather than replacing it with nothing.
    if (!parsed.parents.size) return treeFresh() || tree;
    counters.trees += 1;
    tree = { at: Date.now(), parents: parsed.parents, starts: parsed.starts };
    return tree;
  }

  /**
   * The snapshot, refreshed SYNCHRONOUSLY if it is stale. Only the preferPids /
   * since paths reach this, and main.js warms the cache first, so in practice
   * this is the fallback for the very first sweep.
   */
  function processTree() {
    const fresh = treeFresh();
    if (fresh) return fresh;
    let out = '';
    try {
      out = execFileSync('powershell.exe', PROC_TREE_ARGS, {
        encoding: 'utf8',
        timeout: PROC_TREE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (err) {
      log('embed: process tree read failed', err && err.message);
      return tree;                                         // a stale tree beats none
    }
    return keepTree(out);
  }

  /**
   * The same read, off the main thread. main.js awaits this between polls so the
   * 20 s wait never blocks the UI on PowerShell. Never rejects.
   */
  function warmProcessTree() {
    const fresh = treeFresh();
    if (fresh) return Promise.resolve(fresh);
    if (treeReading) return treeReading;
    treeReading = new Promise((resolve) => {
      let child = null;
      try {
        child = execFile('powershell.exe', PROC_TREE_ARGS, {
          encoding: 'utf8',
          timeout: PROC_TREE_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024
        }, (err, stdout) => {
          if (err && !stdout) {
            log('embed: process tree warm failed', err && err.message);
            resolve(tree);
            return;
          }
          resolve(keepTree(stdout));
        });
      } catch (err) {
        log('embed: process tree warm refused', err && err.message);
        resolve(tree);
        return;
      }
      if (child && typeof child.unref === 'function') { /* keep it: the callback needs it */ }
    }).then((value) => { treeReading = null; return value; },
      () => { treeReading = null; return tree; });
    return treeReading;
  }

  /**
   * Did a process of this exe START since `since`, whether or not it has drawn
   * a window yet?
   *
   * This is what tells "the app is single-instance, the launch just raised the
   * window it already had" apart from "the copy I launched is still starting".
   * A packaged activation through explorer takes seconds to draw, and adopting
   * the OLD window while the new one is still coming is exactly the bug this
   * lane is about.
   *
   * Only pids in the current snapshot count, so a launcher stub that already
   * exited stops holding the wait open.
   *
   * @param {{exe?:string, since?:number}} spec
   */
  function hasNewProcess(spec) {
    const req = spec || {};
    const want = normalizeExe(req.exe);
    const since = Number(req.since) > 0 ? Math.trunc(Number(req.since)) : 0;
    if (!want || !since || !win32()) return false;
    const snap = processTree();
    if (!snap || !snap.starts) return false;
    let found = false;
    snap.starts.forEach((at, pid) => {
      if (found || !(Number(at) >= since)) return;
      if (normalizeExe(exeForPid(pid)) === want) found = true;
    });
    return found;
  }

  // -- findWindows ----------------------------------------------------------

  /**
   * Visible, titled, top-level windows — for one pid, or for every process
   * whose exe basename matches (case-insensitive, '.exe' optional), or all of
   * them when neither filter is given.
   *
   * Order is EnumWindows order, which is front-to-back z-order. That is the
   * practical stand-in for "newest first": a window that just opened took the
   * foreground, so it is at the front. (Windows does not record window
   * creation time anywhere a caller can read it.)
   *
   * TWO EXTRA FILTERS, for "the app I just launched":
   *   preferPids  the pid embed:open started. A window belonging to it or to
   *               ANY OF ITS DESCENDANTS is marked `preferred` and sorted to
   *               the front, and it is kept even when the exe filter would
   *               have dropped it — a launcher's real window is a different
   *               exe, and that window is still the answer.
   *   since       epoch ms of the launch. A window whose PROCESS started after
   *               it sorts ahead of the ones that were already there.
   * Either one costs a process-tree snapshot (cached 2 s, warmed
   * asynchronously by the caller); neither is read on a plain sweep, so the
   * poll loop and embed:find are exactly as cheap as before.
   *
   * Our own windows are NEVER returned. Re-parenting the browser into itself
   * is not a thing anyone wants to discover by accident.
   */
  function findWindows(filter) {
    if (!win32()) return [];
    const spec = filter || {};
    const wantPid = isFiniteInt(Number(spec.pid)) && Number(spec.pid) > 0 ? Math.trunc(Number(spec.pid)) : 0;
    const wantExe = normalizeExe(spec.exe);
    const seeds = pidList(spec.preferPids);
    const since = Number(spec.since) > 0 ? Math.trunc(Number(spec.since)) : 0;
    // One snapshot per sweep, and only when something actually asks for it.
    const snap = (seeds.length || since) ? processTree() : null;
    const prefer = seeds.length ? descendantsOf(seeds, snap && snap.parents) : null;
    const out = [];
    counters.finds += 1;
    const ours = ourHandles();

    try {
      w32.EnumWindows((handle) => {
        try {
          if (!w32.IsWindowVisible(handle)) return true;
          const pid = windowPid(handle);
          if (wantPid && pid !== wantPid) return true;
          // One gate for the sweep and for attach(): top-level, unowned, not a
          // tool window, not a Store frame, and never one of ours.
          if (hostable(handle, ours)) return true;
          const title = windowTitle(handle);
          if (!title) return true;                                // untitled = plumbing
          const exe = exeForPid(pid);
          const preferred = !!(prefer && pid && prefer.has(pid));
          if (wantExe && !preferred && normalizeExe(exe) !== wantExe) return true;
          out.push({
            hwnd: handleText(handle),
            pid,
            title,
            className: windowClass(handle),
            exe,
            preferred,
            startedAt: snap && snap.starts ? (snap.starts.get(pid) || 0) : 0,
          });
        } catch { /* one bad window must not end the sweep */ }
        return true;
      }, 0);
    } catch (err) {
      log('embed: EnumWindows failed', err && err.message);
    }
    if (prefer || since) return orderWindows(out, prefer, since);
    return out;
  }

  // -- attach ---------------------------------------------------------------

  /**
   * Re-parent a top-level window into the browser window and leave it HIDDEN
   * until the chrome sends the first layout(). Everything needed to put the
   * window back exactly as it was is saved first.
   *
   * Refusals (all as values, never throws):
   *   'unavailable'       koffi did not load
   *   'no-window'         no browser window to parent into
   *   'bad-hwnd' / 'gone' the handle is junk or already dead
   *   'own-window'        it is one of ours
   *   'store-app'         a UWP/Store window (see below)
   *   'already-attached'  that exact window is already in a tab
   *   'not-top-level' / 'owned-window' / 'tool-window'  see hostable()
   *
   * THE COST NOBODY SEES: SetParent across processes ATTACHES THE TWO INPUT
   * QUEUES (the child's thread and the parent's thread share one), which is how
   * a hung app becomes a hung browser -- Windows serialises input for both
   * threads. There is no way around it while hosting a foreign HWND, so the
   * rule for everything in this module is: NEVER make a call that waits on the
   * app's message loop. IsWindow / GetParent / GetWindowLongPtr read kernel
   * state and cannot block; GetWindowText on another process’s window returns
   * the cached caption (it does not send WM_GETTEXT, by design); closing uses
   * PostMessage, never SendMessage. Keep it that way.
   *
   * WHY STORE APPS ARE REFUSED: a packaged app's visible window is an
   * ApplicationFrameWindow owned by ApplicationFrameHost.exe, hosting the app's
   * real CoreWindow from a different process. Re-parenting the frame moves a
   * shell-owned window that the shell keeps re-positioning, and re-parenting
   * the CoreWindow is refused outright by the system. Both end in a black or
   * frozen rectangle, so the honest answer is "not this one".
   */
  function attach(spec) {
    if (!win32()) return { ok: false, reason: 'unavailable' };
    const req = spec || {};
    const tabId = String(req.tabId == null ? '' : req.tabId);
    if (!tabId) return { ok: false, reason: 'bad-tab' };

    const handle = toHandle(req.hwnd);
    if (!handle) return { ok: false, reason: 'bad-hwnd' };

    const parent = browserHandle();
    if (!parent) return { ok: false, reason: 'no-window' };

    if (handle === parent) return { ok: false, reason: 'own-window' };

    // FIRST, before any window test: a window WE are already hosting is a child
    // of ours by now, so every check below would call it 'not-top-level' and the
    // caller would never learn the real answer.
    const key = handleText(handle);
    const holder = byHandle.get(key);
    if (holder && holder !== tabId && attached.has(holder)) return { ok: false, reason: 'already-attached' };
    if (holder === tabId) return { ok: false, reason: 'already-attached' };

    // A caller may hand us ANY handle, so the whole gate runs here too: a
    // Chromium render-widget HWND (a child of our own window), an owned dialog,
    // a tool window and an already-parented child are all refused. Attaching
    // any of them is not a cosmetic mistake -- re-parenting a window that is
    // already someone's child, or restoring a top-level style onto it later,
    // leaves a window its owner can no longer drive.
    const refusal = hostable(handle, ourHandles());
    if (refusal) return { ok: false, reason: refusal };

    const pid = windowPid(handle);
    const className = windowClass(handle);

    // One tab hosts one window: a second attach on the same tab puts the
    // previous app back where it came from rather than orphaning it.
    if (attached.has(tabId)) detach(tabId, { restore: true });

    const rect = windowRect(handle) || { left: 0, top: 0, right: 0, bottom: 0 };
    let style;
    let exstyle;
    try {
      style = BigInt(w32.GetWindowLongPtrW(handle, GWL_STYLE)) & 0xffffffffn;
      exstyle = BigInt(w32.GetWindowLongPtrW(handle, GWL_EXSTYLE)) & 0xffffffffn;
    } catch {
      return { ok: false, reason: 'no-style' };
    }

    const record = {
      tabId,
      handle,
      key,
      pid,
      title: windowTitle(handle),
      className,
      exe: exeForPid(pid),
      parentHwnd: parent,
      saved: { style, exstyle, rect, parent: w32.GetParent(handle) },
      last: null,          // last physical rect + visibility we applied
      visible: false,
      // The watchdog's carried state (see hungStep). A window being hosted is
      // by definition not one we are watching from the outside.
      hung: { watching: false, hungStreak: 0, okStreak: 0 },
    };

    /* Hosting it again ends any watch on it: by hwnd as well as by tab, so a
       recovered window adopted into a DIFFERENT tab is not watched twice. */
    dropWatch(tabId);
    for (const entry of Array.from(hungWatch.values())) {
      if (entry.key === key) dropWatch(entry.tabId);
    }

    try {
      // A minimised window has nothing to show and cannot be sized: restore it
      // first. SW_SHOWNOACTIVATE, not SW_RESTORE: SW_RESTORE ACTIVATES the
      // window, which would take the user's keyboard the moment a tab opens.
      if (w32.IsIconic(handle)) w32.ShowWindow(handle, SW_SHOWNOACTIVATE);

      const childStyle = (style & ~DECORATION) | WS_CHILD;

      /*
       * THE ORDER HERE WAS MEASURED, NOT GUESSED (2026-09-11).
       *
       * 1. Hide FIRST. Re-parenting a visible window makes it jump to the
       *    parent's client origin at its old size for a frame or two -- a
       *    1152x592 Notepad flashing across the chrome before the first layout.
       * 2. SetParent, THEN the style. Doing the style first leaves a WS_CHILD
       *    window whose parent is still the desktop, which is a state Windows
       *    has no real answer for.
       * 3. NEVER size it to 0x0. The first version of this ended with
       *    SetWindowPos(0,0,0,0 | HIDEWINDOW), and that call DESTROYED the
       *    window of every app it was tried on -- Notepad's window went away
       *    and the process exited a moment later, every time. A zero-area
       *    client rect is not something a real app is built to survive. So the
       *    window keeps its own size until the chrome's first layout() and this
       *    last call only applies the frame change and hides it again
       *    (SWP_NOMOVE | SWP_NOSIZE).
       *
       * SWP_NOACTIVATE throughout: the user is at the machine, and a tab opening
       * must never take his keyboard.
       */
      w32.ShowWindow(handle, SW_HIDE);
      w32.SetParent(handle, parent);
      w32.SetWindowLongPtrW(handle, GWL_STYLE, childStyle);
      w32.SetWindowPos(handle, HWND_TOP, 0, 0, 0, 0,
        SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_HIDEWINDOW | SWP_NOMOVE | SWP_NOSIZE);
    } catch (err) {
      // Half-done is the worst outcome, and the worst half-done state of all is
      // WS_CHILD with no parent -- an invisible window nothing can reach again.
      // So every undo step gets its OWN try: a throw in one must not skip the
      // style restore that follows it.
      try { w32.SetParent(handle, record.saved.parent || 0n); } catch { /* next */ }
      try { w32.SetWindowLongPtrW(handle, GWL_STYLE, style); } catch { /* next */ }
      try { w32.SetWindowLongPtrW(handle, GWL_EXSTYLE, exstyle); } catch { /* next */ }
      try {
        w32.SetWindowPos(handle, HWND_TOP, rect.left, rect.top,
          Math.max(0, rect.right - rect.left), Math.max(0, rect.bottom - rect.top),
          SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE);
      } catch { /* nothing further to try */ }
      log('embed: attach failed', err && err.message);
      return { ok: false, reason: 'attach-failed' };
    }

    attached.set(tabId, record);
    byHandle.set(key, tabId);
    counters.attaches += 1;
    startPoll();
    ensureShutdownHooks();
    log('embed: attached', tabId, key, record.exe, record.title);

    return {
      ok: true,
      hwnd: key,
      title: record.title,
      className: record.className,
      pid: record.pid,
      exe: record.exe,
    };
  }

  // -- layout ---------------------------------------------------------------

  /**
   * Put the attached window over the tab's content area. `rect` is in the
   * chrome page's CSS pixels, relative to the browser window's client area —
   * which is the same origin a child HWND's coordinates use, so the conversion
   * is nothing but the display scale factor.
   *
   * Idempotent and cheap: the last applied physical rect is remembered and an
   * identical call does no Win32 work at all. The chrome will call this on
   * every resize frame, so that matters.
   */
  function layout(tabId, rect, visible) {
    if (!win32()) return { ok: false, reason: 'unavailable' };
    const record = attached.get(String(tabId == null ? '' : tabId));
    if (!record) return { ok: false, reason: 'not-attached' };

    const box = rect || {};
    const sf = scaleFactor();
    const x = Math.round((Number(box.x) || 0) * sf);
    const y = Math.round((Number(box.y) || 0) * sf);
    const w = Math.max(0, Math.round((Number(box.w) || 0) * sf));
    const h = Math.max(0, Math.round((Number(box.h) || 0) * sf));
    // A zero-area tab is a hidden tab whatever the caller asked for.
    const show = !!visible && w > 0 && h > 0;

    const last = record.last;
    if (last && last.x === x && last.y === y && last.w === w && last.h === h && last.show === show) {
      counters.layoutSkips += 1;
      return { ok: true, changed: false, rect: { x, y, w, h }, visible: show, scale: sf };
    }

    try {
      if (!w32.IsWindow(record.handle)) {
        forget(record, 'gone');
        return { ok: false, reason: 'gone' };
      }
      // Sizing a hidden window is pointless work AND some apps redraw on it;
      // when it is going away, move nothing and just hide.
      const flags = SWP_NOACTIVATE | (show ? SWP_SHOWWINDOW : SWP_HIDEWINDOW)
        | (show ? 0 : SWP_NOMOVE | SWP_NOSIZE);
      w32.SetWindowPos(record.handle, HWND_TOP, x, y, w, h, flags);
    } catch (err) {
      log('embed: layout failed', tabId, err && err.message);
      return { ok: false, reason: 'layout-failed' };
    }

    record.last = { x, y, w, h, show };
    record.visible = show;
    counters.layouts += 1;
    return { ok: true, changed: true, rect: { x, y, w, h }, visible: show, scale: sf };
  }

  // -- detach / close -------------------------------------------------------

  /**
   * Put the window back: top-level again, its own styles, its own old rect.
   * NEVER activated — the user is at the machine, and a tab closing must not throw
   * a window in his face.
   *
   * `restore: false` still un-parents and still restores the styles (a WS_CHILD
   * window with no parent is an invisible zombie), it only skips showing the
   * window and putting it back at its old rect.
   */
  function detach(tabId, opts2) {
    const key = String(tabId == null ? '' : tabId);
    const record = attached.get(key);
    if (!record) return { ok: false, reason: 'not-attached' };
    const restore = !(opts2 && opts2.restore === false);
    // A tab that was reported hung is still a hosted tab: its hang note goes
    // when the window does, and no recovery is reported for a tab that is gone.
    dropWatch(key);

    clearCloseTimer(key);
    attached.delete(key);
    byHandle.delete(record.key);
    counters.detaches += 1;
    maybeStopPoll();

    if (!win32()) return { ok: true, hwnd: record.key, restored: false };

    let alive2 = false;
    try { alive2 = !!w32.IsWindow(record.handle); } catch { alive2 = false; }
    if (!alive2) return { ok: true, hwnd: record.key, restored: false, reason: 'gone' };

    // STEP AT A TIME. The two states worth avoiding are "WS_CHILD with no
    // parent" (an unreachable zombie) and "still our child when we are about to
    // be destroyed" (the app dies with the browser), so the un-parent decides
    // what follows: if it did not take, the record goes BACK into the map so the
    // poll, the next detach and the shutdown path all try again, and the styles
    // are left alone -- a working child window beats a broken top-level one.
    let unparented = false;
    try {
      w32.SetParent(record.handle, 0n);                         // back to the desktop
      unparented = true;
    } catch (err) {
      log('embed: SetParent(desktop) threw', key, err && err.message);
    }
    try {
      // MEASURED, and it cost a broken Paint window to learn: a window that is
      // still WS_CHILD after SetParent(null) is a child OF THE DESKTOP, and
      // GetParent then returns the desktop HWND -- not null. Testing GetParent
      // for truthiness therefore reads every successful un-parent as a failure,
      // skips the style restore, and leaves exactly the WS_CHILD-with-no-real-
      // parent zombie this code exists to prevent. The only question that has a
      // stable answer is "is it still OUR child".
      if (unparented && record.parentHwnd
        && w32.GetParent(record.handle) === record.parentHwnd) unparented = false;
    } catch { /* trust the call above */ }

    if (!unparented) {
      attached.set(key, record);
      byHandle.set(record.key, key);
      startPoll();
      log('embed: detach failed, window kept as a child for a retry', key);
      return { ok: false, reason: 'detach-failed', hwnd: record.key };
    }

    try { w32.SetWindowLongPtrW(record.handle, GWL_STYLE, record.saved.style); } catch { /* next */ }
    try { w32.SetWindowLongPtrW(record.handle, GWL_EXSTYLE, record.saved.exstyle); } catch { /* next */ }
    try {
      const r = record.saved.rect;
      if (restore) {
        w32.SetWindowPos(record.handle, HWND_TOP, r.left, r.top,
          Math.max(0, r.right - r.left), Math.max(0, r.bottom - r.top),
          SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE);
      } else {
        w32.ShowWindow(record.handle, SW_HIDE);
        w32.SetWindowPos(record.handle, HWND_TOP, r.left, r.top,
          Math.max(0, r.right - r.left), Math.max(0, r.bottom - r.top),
          SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_HIDEWINDOW);
      }
    } catch (err) {
      log('embed: detach reposition failed', key, err && err.message);
    }

    log('embed: detached', key, record.key, restore ? 'restored' : 'hidden');
    return { ok: true, hwnd: record.key, restored: restore };
  }

  /**
   * Ask the app to close itself (WM_CLOSE — the same thing its X button sends,
   * so unsaved work still prompts). If the window is still there 3 s later the
   * app is showing a dialog we cannot see inside the tab, so the window goes
   * back to being a normal top-level window where the user can answer it.
   */
  function close(tabId) {
    const key = String(tabId == null ? '' : tabId);
    const record = attached.get(key);
    if (!record) return { ok: false, reason: 'not-attached' };
    if (!win32()) return { ok: false, reason: 'unavailable' };

    try {
      w32.PostMessageW(record.handle, WM_CLOSE, 0, 0);
    } catch (err) {
      log('embed: WM_CLOSE failed', key, err && err.message);
      return { ok: false, reason: 'close-failed' };
    }

    clearCloseTimer(key);
    const timer = setTimeout(() => {
      closeTimers.delete(key);
      const still = attached.get(key);
      if (!still) return;
      let live = false;
      try { live = !!w32.IsWindow(still.handle); } catch { live = false; }
      if (!live) { forget(still, 'gone'); return; }
      log('embed: WM_CLOSE ignored, handing the window back', key);
      detach(key, { restore: true });
      emitter.emit('gone', key);
      counters.gone += 1;
    }, 3000);
    if (typeof timer.unref === 'function') timer.unref();
    closeTimers.set(key, timer);

    return { ok: true, hwnd: record.key };
  }

  function clearCloseTimer(key) {
    const timer = closeTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      closeTimers.delete(key);
    }
  }

  /** Drop a record whose window is dead (nothing to restore) and say so. */
  function forget(record, reason) {
    if (!record || !attached.has(record.tabId)) return;
    attached.delete(record.tabId);
    byHandle.delete(record.key);
    clearCloseTimer(record.tabId);
    dropWatch(record.tabId);      // a dead window has no hang to report on
    maybeStopPoll();
    counters.gone += 1;
    log('embed: window ' + reason, record.tabId, record.key);
    emitter.emit('gone', record.tabId);
  }

  /** Everything home. Safe to call repeatedly, and from a shutdown path. */
  function detachAll(opts2) {
    const ids = Array.from(attached.keys());
    for (const id of ids) {
      try { detach(id, opts2 || { restore: true }); } catch { /* keep going */ }
    }
    // Every hang note goes with the windows it was about.
    hungWatch.clear();
    maybeStopPoll();
    return { ok: true, detached: ids.length };
  }

  // -- the hung-app watchdog ------------------------------------------------

  /**
   * A hosted app has stopped answering. That matters more here than anywhere
   * else, because SetParent joined its input queue to OURS: while it is a child
   * of this window, its wedged message loop is also the browser's frozen
   * keyboard and mouse.
   *
   * AND YET NOTHING IS DETACHED HERE. MEASURED, 2026-09-12: the automatic
   * detach cannot land while the app is actually wedged. SetParent has to be
   * served by the app's own thread, and that same joined queue starves THIS
   * process's message loop -- one IPC round trip took 9.7 s, the 1 s poll ran 7
   * times in 30 s, and the eviction completed 50 ms after the app started
   * pumping again. So an automatic detach does not free anything during the
   * freeze; it only pops a HEALTHY app out of its tab a moment after it
   * recovers, which is the one outcome nobody asked for.
   *
   * So the watchdog reports, and the user decides: 'hung' says the app went
   * quiet (the chrome suffixes the tab title and offers the existing manual Pop
   * out), 'recovered' says it is answering again, and the window stays hosted
   * throughout. Freeing the input queue mid-freeze needs a detach from off the
   * main thread, which is not something this module can do.
   */
  function reportHung(record) {
    hungWatch.set(record.tabId, {
      tabId: record.tabId,
      key: record.key,
      pid: record.pid,
      exe: record.exe,
    });
    counters.hung += 1;
    log('embed: hung, still hosted', record.tabId, record.key, record.exe);
    emitter.emit('hung', { tabId: record.tabId, hwnd: record.key, pid: record.pid });
  }

  /** It answers again. Bookkeeping only: the window never moved. */
  function reportRecovered(record) {
    if (!hungWatch.delete(record.tabId)) return;
    counters.recovered += 1;
    log('embed: answers again', record.tabId, record.key);
    emitter.emit('recovered', { tabId: record.tabId, hwnd: record.key });
  }

  /** Forget one tab's hang, without reporting a recovery it never had. */
  function dropWatch(tabId) {
    const key = String(tabId == null ? '' : tabId);
    if (!hungWatch.has(key)) return false;
    hungWatch.delete(key);
    maybeStopPoll();
    return true;
  }

  /**
   * The app's own window caption, pushed whenever it changes — "(3) Discord",
   * the file a window is editing, a page title. record.title is the cache, so a
   * title that has not moved costs one GetWindowText and no IPC.
   */
  function pushTitle(record) {
    let text = '';
    try { text = windowTitle(record.handle); } catch { return; }
    if (text === record.title) return;
    record.title = text;
    counters.titles += 1;
    emitter.emit('title', { tabId: record.tabId, title: text });
  }

  // -- liveness poll --------------------------------------------------------

  /**
   * Apps close themselves, crash, or (rarely) re-parent their own window out
   * from under us. One IsWindow call per attached tab per second is enough to
   * notice, and costs nothing measurable with a handful of tabs.
   *
   * IsWindow, GetParent, IsHungAppWindow and GetWindowText ONLY. Our input queue
   * is attached to the app's (see attach()), so a poll tick that used
   * SendMessage -- or anything else that waits on the app's message loop --
   * would freeze the browser's own input every second a hosted app was wedged.
   * All four read state the window manager already holds: GetWindowText is the
   * subtle one, and it is safe BY DESIGN -- for a window in another process it
   * returns the caption Windows cached rather than sending WM_GETTEXT, which is
   * documented precisely so that a caller cannot be hung by the window it asks
   * about.
   *
   * The same tick does three jobs, in this order: liveness, the hung-app
   * watchdog (see reportHung -- it REPORTS, it never moves the window), and the
   * live title.
   */
  function startPoll() {
    if (pollTimer || !win32()) return;
    pollTimer = setInterval(() => {
      counters.polls += 1;
      const parent = browserHandle();
      for (const record of Array.from(attached.values())) {
        let live = false;
        try { live = !!w32.IsWindow(record.handle); } catch { live = false; }
        if (!live) { forget(record, 'died'); continue; }
        // Something took it back: let go rather than fighting over it.
        let ours = true;
        try {
          if (parent && w32.GetParent(record.handle) !== parent) {
            forget(record, 'was re-parented away');
            ours = false;
          }
        } catch { /* leave it attached; the next tick tries again */ }
        if (!ours) continue;

        // The watchdog. Nothing is moved: 'detach' here is the decision's name
        // for "it has gone quiet", and reportHung only tells the chrome. See
        // reportHung for why an automatic detach was measured and dropped.
        let hung = false;
        try { hung = !!w32.IsHungAppWindow(record.handle); } catch { hung = false; }
        const step = hungStep(record.hung, { hung });
        record.hung = step.state;
        if (step.action === 'detach') reportHung(record);
        else if (step.action === 'recovered') reportRecovered(record);

        pushTitle(record);
      }
    }, 1000);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function stopPoll() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  /**
   * The poll exists for the attached windows: a hang is bookkeeping ON one of
   * them (the window never leaves its tab), so hungWatch can never be the reason
   * the poll keeps running.
   */
  function maybeStopPoll() {
    if (attached.size) return;
    stopPoll();
  }

  // -- shutdown -------------------------------------------------------------

  /**
   * The rule from the file header, wired: a child HWND is destroyed with its
   * parent, so every path out of this process has to un-parent first.
   * Registered on the first attach so a browser that never hosts an app adds
   * no listeners at all. main.js hooks the same points; both are idempotent.
   */
  function ensureShutdownHooks() {
    if (shutdownHooked) return;
    shutdownHooked = true;
    try {
      app.on('before-quit', () => { detachAll(); });
    } catch { /* no app object in a unit test */ }
    // Last resort. Synchronous by definition here, which koffi calls are.
    process.on('exit', () => { try { detachAll(); } catch { /* nothing left */ } });
  }

  /** Called by main.js from the main window's 'close', before it is destroyed. */
  function handleWindowClose() {
    return detachAll();
  }

  // -- focus ----------------------------------------------------------------

  /**
   * WHO HAS THE KEYBOARD -- the one question Electron cannot answer once an
   * app window is hosted in a tab.
   *
   * Electron calls the BrowserWindow blurred the moment focus moves into the
   * child, because Chromium's own HWND lost it; from Windows' point of view the
   * foreground window never changed. So everything the chrome hangs off window
   * focus (the idle music, the presence gate) has to ask here instead.
   *
   *   foregroundRoot  GetForegroundWindow -> GA_ROOT, as a decimal string.
   *   ours            that root is one of OUR top-level windows: the user is
   *                   working inside this browser, whatever Electron thinks.
   *   focusHwnd/Class the window that actually holds focus, and its class
   *                   (the class is for LOGGING only -- see ownProcess).
   *   ownProcess      the focus window belongs to THIS process: the chrome, a
   *                   guest page, devtools -- so shortcuts already work. Asked
   *                   by pid, never by class name: every app worth hosting in a
   *                   tab (Discord, VS Code, Cursor, Spotify) is Electron/CEF
   *                   and has Chrome_WidgetWin_1 / Chrome_RenderWidgetHostHWND
   *                   windows of its own, which a class test cannot tell from
   *                   ours. Chromium creates every HWND in the browser process,
   *                   so "our pid" is exactly "our chrome".
   *   hostedTabId     the native tab whose app window (or a control inside it)
   *                   holds focus, or null. Non-null is the exact state the
   *                   browser's own shortcuts are dead in.
   *   hostedVisible   that tab's window is the one on screen (layout's
   *                   `visible`), i.e. it is the active tab.
   *
   * Every call is a kernel-state read: GetForegroundWindow, GetGUIThreadInfo,
   * GetClassName and GetParent cannot block on the app's message loop, which is
   * the rule for everything in this module (see attach()).
   */
  function focusInfo() {
    const info = {
      available: false,
      foregroundRoot: '0',
      ours: false,
      focusHwnd: '0',
      focusClass: '',
      ownProcess: false,
      hostedTabId: null,
      hostedVisible: false,
    };
    if (!win32()) return info;
    info.available = true;

    let fg = 0n;
    try { fg = w32.GetForegroundWindow() || 0n; } catch { return info; }
    if (!fg) return info;                       // a locked session has none
    let root = fg;
    try { root = w32.GetAncestor(fg, GA_ROOT) || fg; } catch { root = fg; }
    info.foregroundRoot = handleText(root);
    info.ours = ourHandles().has(root);
    if (!info.ours) return info;                // another app: nothing to say

    /* SetParent attached the app thread's input queue to ours (see attach()),
       so the FOREGROUND queue's focus window is the true answer for both. Thread
       id 0 asks about exactly that queue, which is why GetFocus() -- thread
       local, and always our own -- would lie here. */
    let focus = 0n;
    try {
      const gui = { cbSize: w32.GUI_SIZE };
      if (w32.GetGUIThreadInfo(0, gui)) focus = gui.hwndFocus || 0n;
    } catch { focus = 0n; }
    if (!focus) return info;
    info.focusHwnd = handleText(focus);
    info.focusClass = windowClass(focus);
    /* WHOSE window is it -- the only question the class name cannot answer. A
       pid we cannot read (0) is not an assertion that it is ours, and it never
       stands alone: hostedTabId below is what actually gates the shortcuts. */
    const focusOwner = windowPid(focus);
    info.ownProcess = focusOwner > 0 && focusOwner === process.pid;

    /* The focused HWND is usually a control INSIDE the app's window -- an edit
       box, a canvas, or for an Electron guest a Chrome_RenderWidgetHostHWND
       inside its Chrome_WidgetWin_1 -- so walk up to the window we actually
       host. The depth cap is a loop guard, not a real limit: even that nested
       case is two parents below ours. */
    let node = focus;
    for (let depth = 0; node && depth < 16; depth += 1) {
      const tabId = byHandle.get(handleText(node));
      const record = tabId ? attached.get(tabId) : null;
      if (record) {
        info.hostedTabId = String(tabId);
        info.hostedVisible = !!record.visible;
        break;
      }
      let parent = 0n;
      try { parent = w32.GetParent(node) || 0n; } catch { parent = 0n; }
      if (!parent || parent === node) break;
      node = parent;
    }
    return info;
  }

  /**
   * Give the keyboard back to the chrome WITHOUT raising or activating
   * anything: SetFocus moves focus inside the window that is already in the
   * foreground, so a window behind the user's stays behind it.
   *
   * This is the one call in the module that crosses into the app's thread (the
   * currently focused window gets WM_KILLFOCUS), and it is exactly what a mouse
   * click on the tab strip already does. It runs only in answer to a keystroke
   * the user meant for the browser, never on a timer.
   */
  function focusChrome() {
    if (!win32()) return false;
    const parent = browserHandle();
    if (!parent) return false;
    try { w32.SetFocus(parent); } catch { return false; }
    return true;
  }

  // -- inspection -----------------------------------------------------------

  function alive(tabId) {
    const record = attached.get(String(tabId == null ? '' : tabId));
    if (!record || !win32()) return false;
    try { return !!w32.IsWindow(record.handle); } catch { return false; }
  }

  function list() {
    const out = [];
    for (const record of attached.values()) {
      out.push({
        tabId: record.tabId,
        hwnd: record.key,
        pid: record.pid,
        title: w32 && alive(record.tabId) ? (windowTitle(record.handle) || record.title) : record.title,
        className: record.className,
        exe: record.exe,
        visible: record.visible,
        rect: record.last ? { x: record.last.x, y: record.last.y, w: record.last.w, h: record.last.h } : null,
      });
    }
    return out;
  }

  function stats() {
    return {
      ffi: win32() ? 'koffi' : null,
      available: !!win32(),
      attached: attached.size,
      // Hosted windows whose app has gone quiet and not yet answered.
      hungReported: hungWatch.size,
      polling: !!pollTimer,
      scale: win32() ? scaleFactor() : 1,
      counters: Object.assign({}, counters),
    };
  }

  return {
    // A getter: the binding is not attempted until something actually asks.
    get available() { return !!win32(); },
    findWindows,
    warmProcessTree,
    hasNewProcess,
    attach,
    layout,
    detach,
    close,
    /** Tabs reported hung and still hosted, as { tabId, hwnd } — read-only, for
     *  the live verification. */
    hungTabs: () => Array.from(hungWatch.values()).map((e) => ({ tabId: e.tabId, hwnd: e.key })),
    detachAll,
    handleWindowClose,
    alive,
    focusInfo,
    focusChrome,
    list,
    stats,
    on: emitter.on.bind(emitter),
    off: emitter.off ? emitter.off.bind(emitter) : emitter.removeListener.bind(emitter),
    once: emitter.once.bind(emitter),
  };
}

module.exports = {
  create,
  // pure parts, for the harness
  pidList,
  parseProcTree,
  descendantsOf,
  rankWindow,
  orderWindows,
  hungStep,
  HUNG_SAMPLES,
  PROC_TREE_TTL_MS,
  PROC_TREE_SCRIPT,
  PROC_TREE_ARGS
};
