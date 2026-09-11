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
    });

    window.api.pty.onExit(function (payload) {
      if (!payload || !payload.id) return;
      var st = bySession.get(payload.id);
      if (!st) return;
      bySession.delete(payload.id);
      st.sessionId = null;
      st.live = false;
      if (st.disposed) return;
      emit(st, 'live', false);
      emit(st, 'exit', { exitCode: payload.exitCode });
      if (st.term) {
        st.term.write('\r\n\x1b[2m[session ended] press Enter to start a new one\x1b[0m\r\n');
      }
    });
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
    // conversation that has already ended must not be resumed again, and
    // `claude --continue` in a folder with no history just errors and exits.
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
        safeFit(st); // no-op while hidden
      },

      // The grid the PTY is currently running at. The chamber is half of a
      // split now, so the chrome (and a test) can watch these change as the
      // divider moves; zeroes mean the terminal has not opened yet.
      size: function () {
        if (st.disposed || !st.term) return { cols: 0, rows: 0 };
        return { cols: st.term.cols || 0, rows: st.term.rows || 0 };
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
