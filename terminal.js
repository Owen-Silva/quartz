'use strict';

/*
 * ClaudeTerminal -- one xterm.js terminal + one real PTY per *tab*.
 *
 * A Claude session is a browser tab now: app.js creates a div.claude-view for
 * each one and hands it here. Several can be alive at once; only the active
 * tab's host element is visible, the rest are display:none (i.e. 0x0).
 *
 * Two things follow from that and drive this whole file:
 *   1. LAZY OPEN. Building xterm into a hidden (0x0) container gives a zero-size
 *      terminal and a permanently broken session. So create() may return before
 *      the terminal exists; we wait on a ResizeObserver (plus a rAF retry) until
 *      the host actually has width and height, and only then open + start a PTY.
 *   2. ID DISPATCH. api.pty.onData / onExit are global streams, so they are
 *      registered exactly ONCE at module level and routed to the handle whose
 *      current session id matches the payload.
 *
 * xterm is loaded as globals by index.html: Terminal, FitAddon.FitAddon.
 * contextIsolation is on -- no require(), no modules, plain browser script.
 */
(function () {
  // sessionId -> state, for routing pty:data / pty:exit to the right terminal.
  var bySession = new Map();
  // Every live handle, regardless of whether it currently owns a session.
  var all = new Set();

  var ipcWired = false;
  var seq = 0;

  // --------------------------------------------------------------- themes --
  // The background is fully transparent in BOTH palettes ON PURPOSE: the glass
  // chamber painted by chrome.css is the terminal's ground, so xterm must never
  // paint over it. Only the ink changes between themes.

  var DARK_THEME = {
    background: 'rgba(5,6,10,0)',
    foreground: '#eef1f8',
    cursor: '#ffab4c',
    cursorAccent: '#05060a',
    selectionBackground: 'rgba(125,211,255,.22)',
    black: '#1a1d27',
    red: '#ff6b7a',
    green: '#7ee8a2',
    yellow: '#ffd479',
    blue: '#8ab4ff',
    magenta: '#d7a3ff',
    cyan: '#7fe3ff',
    white: '#d5dae6',
    brightBlack: '#2a2e3d',
    brightRed: '#ff8a96',
    brightGreen: '#9df0b8',
    brightYellow: '#ffe0a0',
    brightBlue: '#a9c6ff',
    brightMagenta: '#e4bcff',
    brightCyan: '#a3ecff',
    brightWhite: '#eef1f8'
  };

  // Tuned for the pale frosted chamber (~#f2f4fa behind the text).
  var LIGHT_THEME = {
    background: 'rgba(5,6,10,0)',
    foreground: '#12162a',
    cursor: '#f08c00',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(11,127,214,.22)',
    black: '#3b4256',
    red: '#c8283f',
    green: '#137a4a',
    yellow: '#9a6a00',
    blue: '#0b5fd6',
    magenta: '#7c3aed',
    cyan: '#0a7f94',
    white: '#5c6478',
    brightBlack: '#8a92a8',
    brightRed: '#e0304a',
    brightGreen: '#178f56',
    brightYellow: '#b07a00',
    brightBlue: '#0b7fd6',
    brightMagenta: '#8b5cf6',
    brightCyan: '#0e94ab',
    brightWhite: '#12162a'
  };

  var currentTheme = 'dark';

  function paletteFor(name) {
    return name === 'light' ? LIGHT_THEME : DARK_THEME;
  }

  function applyTheme(st, palette) {
    if (!st || st.disposed || !st.term) return;
    try {
      st.term.options.theme = palette;
    } catch (err) {
      // xterm 4 (or a non-writable options bag): fall back to the old setter.
      try {
        if (typeof st.term.setOption === 'function') st.term.setOption('theme', palette);
      } catch (err2) {}
    }
  }

  function setTheme(name) {
    currentTheme = name === 'light' ? 'light' : 'dark';
    var palette = paletteFor(currentTheme);
    all.forEach(function (st) {
      applyTheme(st, palette);
    });
    return currentTheme;
  }

  function getTheme() {
    return currentTheme;
  }

  // ------------------------------------------------------------------- ipc --
  // Registered once for the lifetime of the renderer; never per handle.

  function wireIpc() {
    if (ipcWired) return;
    if (!window.api || !window.api.pty) return;
    ipcWired = true;

    window.api.pty.onData(function (payload) {
      if (!payload || !payload.id) return;
      var st = bySession.get(payload.id);
      if (!st || !st.term || st.disposed) return;
      st.term.write(payload.data);
      noteActivity(st, payload.data);
    });

    window.api.pty.onExit(function (payload) {
      if (!payload || !payload.id) return;
      var st = bySession.get(payload.id);
      if (!st) return;
      bySession.delete(payload.id);
      st.sessionId = null;
      st.live = false;
      // Whatever burst was still settling died with the session; 'live' false
      // is the signal now, and a stale 'idle' a second later would only lie.
      clearIdleTimer(st);
      st.idleBytes = 0;
      if (st.disposed) return;
      emit(st, 'live', false);
      emit(st, 'exit', { exitCode: payload.exitCode });
      if (st.term) {
        st.term.write('\r\n\x1b[2m[session ended] press Enter to start a new one\x1b[0m\r\n');
      }
    });
  }

  // ------------------------------------------------------------ attention --
  /*
   * A Claude session that wants you goes QUIET: a burst of output, then
   * nothing while it waits at a prompt. So three events ride on the data pump:
   *
   *   'activity' {bytes}  every chunk, unconditionally.
   *   'idle'     {bytes}  once per burst, IDLE_MS after the last byte, and only
   *                       when at least IDLE_MIN_BYTES have arrived since the
   *                       previous idle — a prompt after real output counts, a
   *                       lone cursor blink or a keystroke echo does not.
   *   'bell'     {bytes}  the chunk contained BEL (\x07), which Claude Code
   *                       rings on completion when its notification is on.
   *
   * Bytes under the threshold are NOT discarded: they keep accumulating, so a
   * trickle that eventually adds up still counts as a burst.
   */
  var IDLE_MS = 1200;
  var IDLE_MIN_BYTES = 200;
  var BEL = '\x07';

  function chunkLength(data) {
    if (data == null) return 0;
    if (typeof data === 'string') return data.length;
    if (typeof data.byteLength === 'number') return data.byteLength;
    if (typeof data.length === 'number') return data.length;
    return 0;
  }

  function hasBell(data) {
    if (data == null) return false;
    if (typeof data === 'string') return data.indexOf(BEL) !== -1;
    // A byte view, should a future preload hand one over instead of a string.
    if (typeof data.length === 'number' && typeof data.byteLength === 'number') {
      for (var i = 0; i < data.length; i++) if (data[i] === 7) return true;
    }
    return false;
  }

  function clearIdleTimer(st) {
    if (st.idleTimer) {
      clearTimeout(st.idleTimer);
      st.idleTimer = 0;
    }
  }

  function noteActivity(st, data) {
    if (st.disposed) return;
    var bytes = chunkLength(data);
    st.idleBytes += bytes;

    emit(st, 'activity', { bytes: bytes });
    if (hasBell(data)) emit(st, 'bell', { bytes: bytes });

    // Each chunk pushes the deadline out, so one burst produces one 'idle'.
    clearIdleTimer(st);
    st.idleTimer = setTimeout(function () {
      st.idleTimer = 0;
      if (st.disposed) return;
      if (st.idleBytes < IDLE_MIN_BYTES) return; // noise: keep waiting
      var total = st.idleBytes;
      st.idleBytes = 0;
      // The session has drawn something and stopped: its input box is up, so
      // anything waiting to be pasted can go in now (and a later paste can go
      // straight through).
      st.pasteReady = true;
      flushPaste(st);
      emit(st, 'idle', { bytes: total });
    }, IDLE_MS);
  }

  // ---------------------------------------------------------------- paste --
  //
  // "Ask Claude about this" hands a chamber a block of text. It goes into the
  // session's INPUT and nothing else: there is no Enter anywhere below, on
  // purpose -- the user reads what arrived, adds their question, and decides
  // when to send it.
  //
  // xterm has bracketed paste on, so a multi-line quote arrives as ONE block
  // rather than as N submitted lines, which is exactly what the Claude Code
  // input box wants.

  // A chamber opened for the gesture is still booting when the prompt is
  // composed, so the text waits. 'live' is the PTY, NOT the CLI: claude.exe
  // takes seconds more to draw its input box, and anything written before that
  // is read by whatever it puts up first (a trust prompt, a first-run
  // question) instead of landing in the box. So the queue waits for the first
  // quiet AFTER live -- the session has said its piece and is waiting -- with
  // a hard cap so a chatty session can never swallow the text for good.
  var PASTE_CAP_MS = 30000;

  /** Put text in now if the session is ready for it, else hold it. */
  function pasteInto(st, text) {
    var body = String(text == null ? '' : text);
    if (st.disposed || !body) return false;
    // An already-running chamber takes it straight away: the box is up and the
    // user is looking at it. Only a session that has never settled queues.
    if (st.term && st.live && st.pasteReady && !promptBlocked(st)) {
      try {
        st.term.paste(body);
        return true;
      } catch (err) { /* fall through and queue it instead */ }
    }
    st.pendingPaste.push(body);
    if (st.live) armPasteCap(st);
    return false;
  }

  /** Last resort: put the text in anyway rather than lose it. */
  function armPasteCap(st) {
    if (st.disposed || st.pasteTimer) return;
    st.pasteTimer = setTimeout(function () {
      st.pasteTimer = 0;
      st.pasteReady = true;
      flushPaste(st);
    }, PASTE_CAP_MS);
  }

  // Claude Code puts a question on screen before its input box exists (the
  // folder trust check, the first-run effort question). Text pasted then is
  // answered away with the question. Read the visible rows and hold the paste
  // while one of those is up; the next quiet after it clears lets it through.
  var BLOCKING_PROMPT = /trust this folder|Quick safety check|Enter to confirm/i;

  function promptBlocked(st) {
    try {
      var buf = st.term && st.term.buffer && st.term.buffer.active;
      if (!buf) return false;
      var start = Math.max(0, buf.length - 60);
      for (var i = start; i < buf.length; i++) {
        var line = buf.getLine(i);
        if (line && BLOCKING_PROMPT.test(line.translateToString(true))) return true;
      }
    } catch (err) { /* buffer not readable: do not block */ }
    return false;
  }

  function flushPaste(st) {
    if (st.pasteTimer) { clearTimeout(st.pasteTimer); st.pasteTimer = 0; }
    if (st.disposed || !st.term || !st.live) return;
    if (!st.pendingPaste.length) return;
    if (promptBlocked(st)) {
      // Not yet: wait for the quiet that follows the answer, capped as before.
      st.pasteReady = false;
      armPasteCap(st);
      return;
    }
    var queued = st.pendingPaste.slice();
    st.pendingPaste.length = 0;
    for (var i = 0; i < queued.length; i++) {
      try { st.term.paste(queued[i]); } catch (err) { /* terminal went away */ }
    }
  }

  // -------------------------------------------------------------- emitter --

  function emit(st, event, arg) {
    var list = st.listeners[event];
    if (!list || !list.length) return;
    // Copy: a listener may unsubscribe itself while we are iterating.
    var snapshot = list.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i](arg);
      } catch (err) {
        // One bad listener must never break the data pump.
      }
    }
  }

  function on(st, event, cb) {
    if (typeof cb !== 'function') return function () {};
    if (!st.listeners[event]) st.listeners[event] = [];
    st.listeners[event].push(cb);
    var removed = false;
    return function () {
      if (removed) return;
      removed = true;
      var list = st.listeners[event];
      if (!list) return;
      var idx = list.indexOf(cb);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  // --------------------------------------------------------------- sizing --

  function hasSize(el) {
    if (!el) return false;
    // offsetWidth/Height are 0 for display:none, which is exactly the hidden-tab
    // case we must not open or fit into.
    return el.offsetWidth > 0 && el.offsetHeight > 0 &&
      el.clientWidth > 0 && el.clientHeight > 0;
  }

  function safeFit(st) {
    if (st.disposed || !st.term || !st.fitAddon) return;
    if (!hasSize(st.host)) return;

    try {
      st.fitAddon.fit();
    } catch (err) {
      return;
    }

    var cols = st.term.cols;
    var rows = st.term.rows;
    if (!cols || !rows || cols < 1 || rows < 1) return;
    if (st.sessionId && window.api && window.api.pty) {
      try {
        window.api.pty.resize(st.sessionId, cols, rows);
      } catch (err) {
        /* main process may have torn the session down already */
      }
    }
  }

  function scheduleFit(st, key, delay) {
    if (st.disposed) return;
    if (st.timers[key]) clearTimeout(st.timers[key]);
    st.timers[key] = setTimeout(function () {
      st.timers[key] = null;
      safeFit(st);
    }, delay);
  }

  // -------------------------------------------------------------- session --

  function startPty(st) {
    if (st.disposed || st.starting || st.sessionId) return;
    if (!st.term) return;
    if (!window.api || !window.api.pty) return;

    var cols = st.term.cols;
    var rows = st.term.rows;
    if (!cols || !rows || cols < 1 || rows < 1) return;

    st.starting = true;

    // Launch flags belong to the FIRST spawn only. Consumed here, so the
    // Enter-to-restart path below always starts a plain session: a resumed
    // conversation that has already ended must not be resumed again,
    // `claude --continue` in a folder with no history just errors and exits,
    // and `--resume` would re-open its picker instead of the fresh session
    // the user asked for by pressing Enter.
    var startArgs = st.pendingArgs;
    st.pendingArgs = null;

    var startPromise;
    try {
      startPromise = window.api.pty.start({
        cwd: st.cwd,
        cols: cols,
        rows: rows,
        args: startArgs && startArgs.length ? startArgs : undefined
      });
    } catch (err) {
      st.starting = false;
      failStart(st, err);
      return;
    }

    Promise.resolve(startPromise).then(function (id) {
      st.starting = false;
      if (!id) {
        failStart(st, new Error('no session id'));
        return;
      }
      if (st.disposed) {
        // Tab closed while the main process was spawning: don't leak the PTY.
        try { window.api.pty.kill(id); } catch (err) {}
        return;
      }
      st.sessionId = id;
      bySession.set(id, st);
      st.live = true;
      emit(st, 'live', true);
      // Anything handed to this chamber while it was starting is now waiting
      // on the CLI rather than on the PTY; the cap makes sure it goes in.
      armPasteCap(st);
      // The tab may have been resized between start() and this reply.
      if (st.term && st.term.cols >= 1 && st.term.rows >= 1) {
        try {
          window.api.pty.resize(id, st.term.cols, st.term.rows);
        } catch (err) {}
      }
    }).catch(function (err) {
      st.starting = false;
      failStart(st, err);
    });
  }

  function failStart(st, err) {
    if (st.disposed) return;
    st.live = false;
    if (st.term) {
      var msg = String(err && err.message ? err.message : err);
      st.term.write('\r\n\x1b[2m[failed to start session: ' + msg + ']\x1b[0m\r\n');
    }
    emit(st, 'live', false);
  }

  // ----------------------------------------------------------------- open --

  function openTerminal(st) {
    if (st.disposed || st.term) return false;
    if (typeof window.Terminal !== 'function') return false;
    if (!hasSize(st.host)) return false;

    // The background is fully transparent ON PURPOSE: the glass chamber painted
    // by chrome.css is the terminal's ground, so xterm must not paint over it.
    st.term = new window.Terminal({
      allowTransparency: true,
      allowProposedApi: true,
      cursorBlink: true,
      scrollback: 10000,
      fontFamily: "'Cascadia Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      theme: paletteFor(currentTheme)
    });

    if (window.FitAddon && typeof window.FitAddon.FitAddon === 'function') {
      st.fitAddon = new window.FitAddon.FitAddon();
      st.term.loadAddon(st.fitAddon);
    }

    st.term.open(st.host);
    safeFit(st);

    st.term.onData(function (data) {
      if (st.disposed) return;
      if (st.sessionId && window.api && window.api.pty) {
        window.api.pty.write(st.sessionId, data);
        return;
      }
      // Dead session: Enter is the "start another one" affordance.
      if (!st.starting && typeof data === 'string' && data.indexOf('\r') !== -1) {
        restart(st);
      }
    });

    if (typeof st.term.onTitleChange === 'function') {
      st.term.onTitleChange(function (title) {
        emit(st, 'title', String(title == null ? '' : title));
      });
    }

    wireIpc();
    startPty(st);

    // One more fit once the browser has painted the tab at its final size.
    window.requestAnimationFrame(function () {
      safeFit(st);
    });

    return true;
  }

  // Poll for a measurable host. The ResizeObserver below covers the normal
  // "tab became active" path; this rAF chain covers the first frames after
  // create() when layout simply has not settled yet.
  function pumpOpen(st) {
    if (st.disposed || st.term) return;
    if (openTerminal(st)) return;
    if (st.openTries++ > 180) return; // ~3s of frames, then wait on the observer
    st.rafId = window.requestAnimationFrame(function () {
      st.rafId = 0;
      pumpOpen(st);
    });
  }

  function ensureOpen(st) {
    if (st.disposed || st.term) return;
    if (openTerminal(st)) return;
    if (!st.rafId) pumpOpen(st);
  }

  // -------------------------------------------------------------- restart --

  function restart(st) {
    if (st.disposed) return;
    if (st.sessionId || st.starting) return;
    if (!st.term) {
      ensureOpen(st);
      return;
    }
    try {
      if (typeof st.term.reset === 'function') st.term.reset();
      else st.term.clear();
    } catch (err) {}
    safeFit(st);
    st.pasteReady = false; // a restarted session has to boot all over again
    startPty(st); // same xterm, same cwd, current cols/rows
  }

  // --------------------------------------------------------------- create --

  function create(hostEl, opts) {
    var options = opts || {};
    var st = {
      id: 'claude-' + (++seq) + '-' + Math.random().toString(36).slice(2, 8),
      host: hostEl,
      cwd: options.cwd || (window.api && window.api.homeDir) || undefined,
      // Flags for the first spawn only; startPty() clears this as it uses it.
      pendingArgs: Array.isArray(options.args) ? options.args.slice() : null,
      term: null,
      fitAddon: null,
      sessionId: null,
      live: false,
      starting: false,
      disposed: false,
      openTries: 0,
      rafId: 0,
      ro: null,
      timers: { win: null, ro: null },
      // The quiet-detector above: bytes seen since the last 'idle', and the
      // pending deadline that turns silence into one.
      idleTimer: 0,
      idleBytes: 0,
      // Text handed over before the session could take it, and the timer that
      // puts it in once it can. See the paste section above.
      pendingPaste: [],
      pasteTimer: 0,
      // False until the session has drawn something and gone quiet once.
      pasteReady: false,
      listeners: Object.create(null),
      onWinResize: null
    };

    all.add(st);
    wireIpc();

    st.onWinResize = function () {
      scheduleFit(st, 'win', 100);
    };
    window.addEventListener('resize', st.onWinResize);

    if (hostEl && typeof window.ResizeObserver === 'function') {
      st.ro = new window.ResizeObserver(function () {
        if (st.disposed) return;
        if (!st.term) {
          // Still waiting for a non-zero box -- this fires when the tab is shown.
          ensureOpen(st);
          return;
        }
        scheduleFit(st, 'ro', 60);
      });
      try {
        st.ro.observe(hostEl);
      } catch (err) {
        st.ro = null;
      }
    }

    // Fast path when the tab is already visible; otherwise this is a no-op and
    // the observer/rAF pair takes over.
    ensureOpen(st);

    var handle = {
      id: st.id,
      // The folder this session runs in, for the chrome to label the tab with.
      cwd: st.cwd || '',

      focus: function () {
        if (st.disposed || !st.term) return;
        try { st.term.focus(); } catch (err) {}
      },

      fit: function () {
        // A hidden chamber normally opens from its ResizeObserver when the tab
        // is shown, but an occluded window gets no observer or rAF callbacks at
        // all, so activation calls this synchronously: open now if measurable.
        ensureOpen(st);
        safeFit(st); // no-op while hidden
      },

      // The grid the PTY is currently running at. The chamber is half of a
      // split now, so the chrome (and a test) can watch these change as the
      // divider moves; zeroes mean the terminal has not opened yet.
      size: function () {
        if (st.disposed || !st.term) return { cols: 0, rows: 0 };
        return { cols: st.term.cols || 0, rows: st.term.rows || 0 };
      },

      // Put text into the session's input box. Returns true if it went in now,
      // false if it was queued for the moment the PTY comes live. NOTHING is
      // submitted: no Enter is ever sent from here.
      paste: function (text) {
        return pasteInto(st, text);
      },

      restart: function () {
        restart(st);
      },

      isLive: function () {
        return !!st.live;
      },

      on: function (event, cb) {
        return on(st, event, cb);
      },

      dispose: function () {
        if (st.disposed) return;
        st.disposed = true;

        if (st.sessionId) {
          bySession.delete(st.sessionId);
          if (window.api && window.api.pty) {
            try { window.api.pty.kill(st.sessionId); } catch (err) {}
          }
          st.sessionId = null;
        }
        st.live = false;

        if (st.rafId) {
          window.cancelAnimationFrame(st.rafId);
          st.rafId = 0;
        }
        if (st.timers.win) { clearTimeout(st.timers.win); st.timers.win = null; }
        if (st.timers.ro) { clearTimeout(st.timers.ro); st.timers.ro = null; }
        clearIdleTimer(st);
        st.idleBytes = 0;
        if (st.pasteTimer) { clearTimeout(st.pasteTimer); st.pasteTimer = 0; }
        st.pendingPaste.length = 0;

        if (st.ro) {
          try { st.ro.disconnect(); } catch (err) {}
          st.ro = null;
        }
        if (st.onWinResize) {
          window.removeEventListener('resize', st.onWinResize);
          st.onWinResize = null;
        }

        if (st.term) {
          try { st.term.dispose(); } catch (err) {}
          st.term = null;
        }
        st.fitAddon = null;
        st.listeners = Object.create(null);
        all.delete(st);
      }
    };

    st.handle = handle;
    return handle;
  }

  window.ClaudeTerminal = { create: create, setTheme: setTheme, getTheme: getTheme };
})();
