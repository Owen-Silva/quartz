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

    return {
      koffi,
      RECT,
      EnumWindows: user32.func('bool __stdcall EnumWindows(EmbedEnumProc *cb, intptr_t lparam)'),
      IsWindow: user32.func('bool __stdcall IsWindow(void *h)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *h)'),
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

  const counters = { attaches: 0, detaches: 0, layouts: 0, layoutSkips: 0, polls: 0, gone: 0, finds: 0 };

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
   * Our own windows are NEVER returned. Re-parenting the browser into itself
   * is not a thing anyone wants to discover by accident.
   */
  function findWindows(filter) {
    if (!win32()) return [];
    const spec = filter || {};
    const wantPid = isFiniteInt(Number(spec.pid)) && Number(spec.pid) > 0 ? Math.trunc(Number(spec.pid)) : 0;
    const wantExe = normalizeExe(spec.exe);
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
          if (wantExe && normalizeExe(exe) !== wantExe) return true;
          out.push({
            hwnd: handleText(handle),
            pid,
            title,
            className: windowClass(handle),
            exe,
          });
        } catch { /* one bad window must not end the sweep */ }
        return true;
      }, 0);
    } catch (err) {
      log('embed: EnumWindows failed', err && err.message);
    }
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
    };

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

    clearCloseTimer(key);
    attached.delete(key);
    byHandle.delete(record.key);
    counters.detaches += 1;
    if (!attached.size) stopPoll();

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
    if (!attached.size) stopPoll();
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
    return { ok: true, detached: ids.length };
  }

  // -- liveness poll --------------------------------------------------------

  /**
   * Apps close themselves, crash, or (rarely) re-parent their own window out
   * from under us. One IsWindow call per attached tab per second is enough to
   * notice, and costs nothing measurable with a handful of tabs.
   *
   * IsWindow and GetParent ONLY. Our input queue is attached to the app's (see
   * attach()), so a poll tick that used SendMessage -- or anything else that
   * waits on the app's message loop -- would freeze the browser's own input
   * every second a hosted app was wedged.
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
        try {
          if (parent && w32.GetParent(record.handle) !== parent) forget(record, 'was re-parented away');
        } catch { /* leave it attached; the next tick tries again */ }
      }
    }, 1000);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function stopPoll() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
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
      polling: !!pollTimer,
      scale: win32() ? scaleFactor() : 1,
      counters: Object.assign({}, counters),
    };
  }

  return {
    // A getter: the binding is not attempted until something actually asks.
    get available() { return !!win32(); },
    findWindows,
    attach,
    layout,
    detach,
    close,
    detachAll,
    handleWindowClose,
    alive,
    list,
    stats,
    on: emitter.on.bind(emitter),
    off: emitter.off ? emitter.off.bind(emitter) : emitter.removeListener.bind(emitter),
    once: emitter.once.bind(emitter),
  };
}

module.exports = { create };
