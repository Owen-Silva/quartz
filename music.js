/* ============================================================
   music.js — the idle music player, and it lives in the CHROME.

   Quiet lobby music while nothing else in the browser is making a
   sound. The player is here rather than in a guest for one reason:
   a guest dies on every navigation, and music that stops when you
   open a link is not music. The chrome outlives every tab, so the
   sound does too.

   What this file decides, and the whole of it:

     shouldPlay(c)   the one condition, pure and testable
     create(deps)    the player: the two sources, the fades, the
                     300 ms settle, and one state object to push

   What it deliberately does NOT do: read settings (app.js hands
   them in), touch a tab, know what a webview is, or write anything
   to disk. app.js owns every edge that can move the condition
   (window focus, an audible tab, the active tab, the media bridge)
   and calls setEnvironment(); this file only ever answers "so are
   we playing, then".

   The two sources, both behind the same small sink contract
   ({ resume, pause, stopNow, fadeTo, title, next, hasNext,
   playing, pending, state }):

     ambient   the generative engine in ambient.js. Its own master
               GainNode is the fader — engine.setVolume(v, seconds)
               schedules a linear ramp on it — and its stop()
               suspends the AudioContext, so a paused player costs
               exactly zero CPU.
     files     the user's own tracks through one <audio> element on
               file:// URLs. Nothing is copied and nothing is
               decoded until a track actually plays. The element's
               own .volume is the fader here, stepped every 25 ms:
               routing it through the engine's 24 kHz playback
               context would resample his music to save nothing.

   Fades are 800 ms in and 400 ms out, and every state change is
   settled for 300 ms first, so a tab switch THROUGH a web page —
   new tab, page, new tab — never blips the music.

   require()-able from node for the harness: nothing here touches
   window or document at load, and every dependency (the engine,
   the <audio> factory, the timers, the RNG) can be handed in.
   ============================================================ */

(function () {
  'use strict';

  /* --- the numbers the brief fixes ----------------------------- */

  var FADE_IN_MS = 800;     // coming up: slow enough not to announce itself
  var FADE_OUT_MS = 400;    // going down: fast enough to get out of the way
  var SETTLE_MS = 300;      // a burst of edges is one decision
  var VOLUME_MS = 200;      // the slider itself, which is not a start or a stop
  var STEP_MS = 25;         // one <audio>.volume step (40 a second)

  /* The console channels the new tab page asks over. It has no preload,
     so a printed line is the whole of its reach into the chrome. */
  var MUSIC_PREFIX = 'newtab:music ';
  var MEDIA_PREFIX = 'newtab:media ';
  var MUSIC_ACTIONS = ['enable', 'toggle', 'next'];
  var MEDIA_CMDS = ['play', 'pause', 'toggle', 'next', 'prev'];

  var WHERES = ['newtab', 'anywhere'];
  var SOURCES = ['ambient', 'files'];

  /* --- small pure helpers -------------------------------------- */

  function noop() {}

  function clamp01(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return n < 0 ? 0 : (n > 1 ? 1 : n);
  }

  function str(v) { return typeof v === 'string' ? v : ''; }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function pick(list, value, fallback) {
    return list.indexOf(value) >= 0 ? value : fallback;
  }

  function defaultTimers() {
    return {
      setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
      clearTimeout: function (id) { return clearTimeout(id); }
    };
  }

  /**
   * The settings group as this file insists on reading it. settings.js
   * normalises it already; this is the belt to that braces, and it is what
   * lets a harness hand in half a group.
   */
  function normalizeMusic(value) {
    var v = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    var files = [];
    if (Array.isArray(v.files)) {
      for (var i = 0; i < v.files.length; i += 1) {
        var raw = v.files[i];
        var path = '';
        var name = '';
        if (typeof raw === 'string') path = raw;
        else if (raw && typeof raw === 'object') {
          path = str(raw.path);
          name = str(raw.name);
        }
        path = path.trim();
        if (!path) continue;
        files.push({ path: path, name: name.trim() || baseName(path) });
      }
    }
    return {
      enabled: v.enabled === true,
      source: pick(SOURCES, v.source, 'ambient'),
      where: pick(WHERES, v.where, 'newtab'),
      volume: v.volume === undefined ? 0.35 : clamp01(v.volume),
      files: files,
      shuffle: v.shuffle !== false
    };
  }

  /** The last segment of a path, either slash. */
  function baseName(path) {
    var parts = String(path).split(/[\\/]+/);
    return parts[parts.length - 1] || String(path);
  }

  /**
   * A Windows path as a URL an <audio> element will actually fetch. The
   * chrome is itself a file:// document, so file:// media is same-scheme and
   * needs no protocol handler: only the encoding has to be right.
   *
   *   C:\Music\a b#1.mp3   ->  file:///C:/Music/a%20b%231.mp3
   *   \\nas\share\x.flac   ->  file://nas/share/x.flac
   */
  function fileUrl(path) {
    var raw = String(path == null ? '' : path).replace(/\\/g, '/');
    if (!raw) return '';
    var out;
    if (raw.indexOf('//') === 0) out = 'file://' + raw.slice(2);   // UNC share
    else if (/^[A-Za-z]:/.test(raw)) out = 'file:///' + raw;       // drive letter
    else out = 'file://' + (raw.charAt(0) === '/' ? raw : '/' + raw);
    /* encodeURI leaves : / and % alone, which is what a path needs; # and ?
       would otherwise cut the URL short, so they go by hand. */
    return encodeURI(out).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }

  /** 0..n-1. */
  function sequence(n) {
    var out = [];
    for (var i = 0; i < n; i += 1) out.push(i);
    return out;
  }

  /** Fisher-Yates over 0..n-1 with an injectable RNG, so a test can fix it. */
  function shuffleOrder(n, random) {
    var rnd = typeof random === 'function' ? random : Math.random;
    var out = sequence(n);
    for (var i = out.length - 1; i > 0; i -= 1) {
      var j = Math.floor(rnd() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  /* --- the one condition --------------------------------------- */

  /**
   * The whole rule, as a pure function of facts app.js gathers:
   *
   *   enabled       the setting
   *   manualPaused  he pressed Pause on the new tab page
   *   focused       the window has focus (app.js: windowBlurred === false)
   *   audibleTab    some tab is making a sound and is not muted
   *   mediaPlaying  the machine is playing something (Spotify et al, via the
   *                 SMTC bridge's /now — status 'playing')
   *   newTabActive  the tab in front is a new-tab page
   *   where         'newtab' (only in front of a new tab) or 'anywhere'
   *   ready         the chosen source has something to play
   *
   * A pane, a dialog or the settings panel is NOT in this list on purpose:
   * opening the settings to turn the music up must not pause the music.
   */
  function shouldPlay(c) {
    var s = c || {};
    if (s.enabled !== true) return false;
    if (s.manualPaused === true) return false;
    if (s.focused !== true) return false;
    if (s.audibleTab === true) return false;
    if (s.mediaPlaying === true) return false;
    if (s.ready === false) return false;
    if (s.where === 'anywhere') return true;
    return s.newTabActive === true;
  }

  /* --- the console channels ------------------------------------ */

  /**
   * One console line -> { <field>: <one of allowed> }, or null. A console line
   * is not a trusted channel: a wrong prefix, broken JSON, an array, a
   * non-string field and an unknown verb all come back null rather than
   * partly honoured, exactly like parseEndTaskLine in app.js.
   */
  function parseLine(prefix, text, field, allowed) {
    if (typeof text !== 'string') return null;
    var line = text.trim();
    if (line.indexOf(prefix) !== 0) return null;
    var msg = null;
    try { msg = JSON.parse(line.slice(prefix.length)); } catch (err) { return null; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
    var value = msg[field];
    if (typeof value !== 'string') return null;
    value = value.toLowerCase();
    if (allowed.indexOf(value) < 0) return null;
    var out = {};
    out[field] = value;
    return out;
  }

  /** `newtab:music {"action":"toggle"}` -> { action: 'toggle' }. */
  function parseMusicLine(text) {
    return parseLine(MUSIC_PREFIX, text, 'action', MUSIC_ACTIONS);
  }

  /** `newtab:media {"cmd":"next"}` -> { cmd: 'next' }. */
  function parseMediaLine(text) {
    return parseLine(MEDIA_PREFIX, text, 'cmd', MEDIA_CMDS);
  }

  /* --- now playing: what counts as a change -------------------- */

  /**
   * The fields of a /now answer that are worth an executeJavaScript into the
   * guest. positionMs is deliberately NOT among them: it moves every single
   * poll and the page interpolates it locally, so including it would turn a
   * change-only push into one push every two seconds for ever. Art travels as
   * its hash: the bytes themselves are pushed only when that hash moves.
   */
  function mediaFacts(answer) {
    var a = (answer && typeof answer === 'object') ? answer : {};
    return {
      ok: a.ok === true,
      source: str(a.source),
      title: str(a.title),
      artist: str(a.artist),
      album: str(a.album),
      status: str(a.status) || 'none',
      durationMs: num(a.durationMs),
      canNext: a.canNext === true,
      canPrev: a.canPrev === true,
      artHash: str(a.artHash)
    };
  }

  function mediaHash(answer) {
    return JSON.stringify(mediaFacts(answer));
  }

  /** True when the machine is playing something. The idle music's veto. */
  function mediaPlaying(answer) {
    return mediaFacts(answer).status === 'playing';
  }

  /**
   * One /now answer -> what to do with it.
   *
   *   prev   { hash, artHash, art } as it was after the last push
   *   fresh  a guest that has just loaded and knows nothing: push even
   *          though nothing changed, and include the art we are holding
   *
   * Returns { changed, hash, artHash, art, payload }: `art` is what the
   * chrome should now remember, `payload.art` is what goes over the wire
   * (null when the guest already has that image).
   */
  function mediaPush(answer, prev, fresh) {
    var facts = mediaFacts(answer);
    var hash = JSON.stringify(facts);
    var p = prev || {};
    var a = (answer && typeof answer === 'object') ? answer : {};
    var incoming = typeof a.art === 'string' && a.art ? a.art : '';
    var newArt = incoming && facts.artHash !== str(p.artHash);
    var keptArt = newArt ? incoming : str(p.art);
    return {
      changed: hash !== str(p.hash),
      hash: hash,
      artHash: facts.artHash || (newArt ? '' : str(p.artHash)),
      art: keptArt,
      payload: {
        ok: facts.ok,
        source: facts.source,
        title: facts.title,
        artist: facts.artist,
        album: facts.album,
        status: facts.status,
        positionMs: num(a.positionMs),
        durationMs: facts.durationMs,
        canNext: facts.canNext,
        canPrev: facts.canPrev,
        art: newArt ? incoming : (fresh ? keptArt : null)
      }
    };
  }

  /* --- sink 1: the built-in engine ----------------------------- */

  /**
   * ambient.js behind the sink contract. The AudioContext is created on the
   * first resume() and never closed: stop() suspends it, which renders
   * nothing at all, and the next resume() is a resume of the same graph.
   */
  function createAmbientSink(options) {
    var o = options || {};
    var Ambient = o.ambient;
    var timers = o.timers || defaultTimers();
    var onChange = typeof o.onChange === 'function' ? o.onChange : noop;
    var ctx = null;
    var engine = null;
    var playing = false;
    var stopTimer = null;

    function build() {
      if (engine) return engine;
      if (!Ambient || typeof Ambient.create !== 'function') return null;
      try {
        ctx = typeof Ambient.createContext === 'function' ? Ambient.createContext() : null;
        if (!ctx) return null;
        /* Volume 0: the fade-in is the only thing that ever raises it, so the
           first note is never at full level. */
        engine = Ambient.create({ ctx: ctx, volume: 0 });
      } catch (err) { engine = null; }
      return engine;
    }

    function cancelStop() {
      if (stopTimer != null) { timers.clearTimeout(stopTimer); stopTimer = null; }
    }

    function fadeTo(v, ms) {
      if (!engine) return;
      try { engine.setVolume(clamp01(v), Math.max(0, ms || 0) / 1000); } catch (err) { /* fake ctx */ }
    }

    return {
      kind: 'ambient',
      /** Play, or come back up from a fade that had not finished. */
      resume: function (volume, ms) {
        cancelStop();
        if (!build()) return false;
        if (!playing) {
          try { engine.setVolume(0, 0); } catch (err) { /* fine */ }
          try { engine.start(); } catch (err) { return false; }
          playing = true;
          onChange();
        }
        fadeTo(volume, ms);
        return true;
      },
      /** Down over `ms`, then silent AND suspended. */
      pause: function (ms) {
        if (!playing) return false;
        var wait = Math.max(0, ms || 0);
        fadeTo(0, wait);
        cancelStop();
        stopTimer = timers.setTimeout(function () {
          stopTimer = null;
          if (!playing) return;
          playing = false;
          try { engine.stop(); } catch (err) { /* fine */ }
        }, wait);
        return true;
      },
      stopNow: function () {
        cancelStop();
        if (!engine) return;
        playing = false;
        try { engine.stop(); } catch (err) { /* fine */ }
      },
      fadeTo: fadeTo,
      title: function () {
        if (!engine || typeof engine.title !== 'function') return '';
        try { return engine.title(); } catch (err) { return ''; }
      },
      hasNext: function () { return false; },
      next: function () { return false; },
      playing: function () { return playing; },
      pending: function () { return stopTimer != null; },
      state: function () {
        var inner = null;
        if (engine && typeof engine.state === 'function') {
          try { inner = engine.state(); } catch (err) { inner = null; }
        }
        return {
          kind: 'ambient',
          playing: playing,
          ctxState: ctx ? ctx.state : null,
          engine: inner
        };
      }
    };
  }

  /* --- sink 2: his own tracks ---------------------------------- */

  /**
   * One <audio> element walking a (shuffled) playlist of file:// URLs.
   * Nothing is copied, nothing is decoded before it plays, and a file that
   * has moved is skipped rather than mourned. When EVERY track in the list
   * fails, onExhausted() fires and the player falls back to the engine.
   */
  function createFilesSink(options) {
    var o = options || {};
    var files = Array.isArray(o.files) ? o.files.slice() : [];
    var timers = o.timers || defaultTimers();
    var onChange = typeof o.onChange === 'function' ? o.onChange : noop;
    var onExhausted = typeof o.onExhausted === 'function' ? o.onExhausted : noop;
    var order = o.shuffle === false ? sequence(files.length) : shuffleOrder(files.length, o.random);
    var at = 0;                 // index INTO order, remembered across pauses
    var el = null;
    var playing = false;
    var loaded = -1;            // the order index the element currently holds
    var failures = 0;           // consecutive, so one bad file is not the end
    var blocked = '';           // a rejected play(), e.g. autoplay policy
    var stopTimer = null;
    var fadeTimer = null;
    var fadeTarget = 0;

    function element() {
      if (el) return el;
      if (typeof o.createAudio !== 'function') return null;
      try { el = o.createAudio(); } catch (err) { el = null; }
      if (!el) return null;
      try {
        el.preload = 'none';
        el.loop = false;
        el.volume = 0;
      } catch (err) { /* a fake element may have none of these */ }
      listen('ended', function () { step(1, playing); });
      listen('error', function () { failed(); });
      return el;
    }

    function listen(name, fn) {
      if (!el || typeof el.addEventListener !== 'function') return;
      try { el.addEventListener(name, fn); } catch (err) { /* fine */ }
    }

    function current() {
      if (!files.length) return null;
      return files[order[at % order.length]] || null;
    }

    function load() {
      var track = current();
      if (!el || !track) return;
      loaded = at;
      try { el.src = fileUrl(track.path); } catch (err) { /* fine */ }
      if (typeof el.load === 'function') { try { el.load(); } catch (err) { /* fine */ } }
    }

    function play() {
      if (!el) return;
      var pending = null;
      try { pending = el.play(); } catch (err) { blocked = String(err && err.message || err); return; }
      if (pending && typeof pending.then === 'function') {
        pending.then(function () { blocked = ''; }, function (err) {
          blocked = String((err && err.message) || err || 'blocked');
        });
      }
    }

    /** Advance `n` tracks; play the new one only when we are meant to sound. */
    function step(n, autoplay) {
      if (!files.length) return;
      at = (at + n + order.length) % order.length;
      if (!element()) return;
      load();
      if (autoplay) play();
      onChange();
    }

    function failed() {
      failures += 1;
      if (failures >= files.length) { onExhausted(); return; }
      step(1, playing);
    }

    function clearFade() {
      if (fadeTimer != null) { timers.clearTimeout(fadeTimer); fadeTimer = null; }
    }

    function cancelStop() {
      if (stopTimer != null) { timers.clearTimeout(stopTimer); stopTimer = null; }
    }

    function setVolume(v) {
      if (!el) return;
      try { el.volume = clamp01(v); } catch (err) { /* fine */ }
    }

    /**
     * The element's own volume IS the master gain here, and it takes no ramps,
     * so the ramp is drawn by hand: one 25 ms step at a time, linear.
     */
    function fadeTo(v, ms) {
      if (!el) return;
      var to = clamp01(v);
      fadeTarget = to;
      clearFade();
      var wait = Math.max(0, ms || 0);
      var from = clamp01(el.volume);
      var steps = Math.max(1, Math.round(wait / STEP_MS));
      if (wait <= 0 || steps <= 1) { setVolume(to); return; }
      var done = 0;
      var tick = function () {
        fadeTimer = null;
        done += 1;
        setVolume(from + (to - from) * (done / steps));
        if (done < steps) fadeTimer = timers.setTimeout(tick, STEP_MS);
      };
      fadeTimer = timers.setTimeout(tick, STEP_MS);
    }

    return {
      kind: 'files',
      resume: function (volume, ms) {
        cancelStop();
        if (!files.length) return false;
        if (!element()) return false;
        if (loaded !== at || !el.src) load();
        if (!playing) {
          setVolume(0);
          playing = true;
          onChange();
        }
        play();
        fadeTo(volume, ms);
        return true;
      },
      pause: function (ms) {
        if (!playing) return false;
        var wait = Math.max(0, ms || 0);
        fadeTo(0, wait);
        cancelStop();
        stopTimer = timers.setTimeout(function () {
          stopTimer = null;
          if (!playing) return;
          playing = false;
          clearFade();
          if (el && typeof el.pause === 'function') {
            try { el.pause(); } catch (err) { /* fine */ }
          }
          /* The last step of the ramp and this deadline land on the same
             millisecond, so whichever wins, the element ends up silent. */
          setVolume(0);
        }, wait);
        return true;
      },
      stopNow: function () {
        cancelStop();
        clearFade();
        playing = false;
        if (el && typeof el.pause === 'function') {
          try { el.pause(); } catch (err) { /* fine */ }
        }
        setVolume(0);
      },
      fadeTo: fadeTo,
      title: function () {
        var track = current();
        return track ? track.name : '';
      },
      hasNext: function () { return files.length > 1; },
      next: function () {
        if (files.length < 2) return false;
        failures = 0;          // a press is a fresh run at the list
        step(1, playing);
        return true;
      },
      playing: function () { return playing; },
      pending: function () { return stopTimer != null || fadeTimer != null; },
      state: function () {
        var track = current();
        return {
          kind: 'files',
          playing: playing,
          index: at,
          order: order.slice(),
          track: track ? track.name : '',
          src: el && el.src ? el.src : '',
          volume: el ? clamp01(el.volume) : 0,
          target: fadeTarget,
          failures: failures,
          blocked: blocked
        };
      }
    };
  }

  /* --- the player ---------------------------------------------- */

  /**
   * create(deps) -> the player app.js drives.
   *
   *   music        () => Settings.music(), re-read on refresh()
   *   settings     a group handed straight in (tests; instead of `music`)
   *   ambient      window.Ambient
   *   createAudio  () => document.createElement('audio')
   *   onState      called with { enabled, playing, source, title, where }
   *                whenever that object actually changes — this is exactly
   *                what app.js pushes to the new tab page
   *   timers       { setTimeout, clearTimeout } for tests
   *   random       for the shuffle
   */
  function create(options) {
    var o = options || {};
    var timers = o.timers || defaultTimers();
    var readSettings = typeof o.music === 'function' ? o.music : null;
    var ambient = o.ambient || (typeof window !== 'undefined' ? window.Ambient : null);
    var createAudio = typeof o.createAudio === 'function' ? o.createAudio : function () {
      if (typeof document === 'undefined') return null;
      return document.createElement('audio');
    };
    var random = typeof o.random === 'function' ? o.random : Math.random;
    var onState = typeof o.onState === 'function' ? o.onState : noop;

    var music = normalizeMusic(readSettings ? read() : o.settings);
    var env = { focused: false, audibleTab: false, mediaPlaying: false, newTabActive: false };
    var manualPaused = false;
    var fellBack = false;        // every track failed: the engine took over
    var sink = null;
    var sinkKey = '';
    var retiring = [];           // sinks fading out after a source change
    var wanted = false;          // the decision currently applied
    var settle = null;
    var lastPushed = '';
    /* A sink reports a start or a track change through onChange, and during
       apply() that would push a half-made state (playing, but not decided
       yet). Depth, not a boolean: falling back to the engine applies again
       from inside an apply. */
    var applying = 0;

    function read() {
      try { return readSettings(); } catch (err) { return null; }
    }

    /* --- what we would be playing, and whether we can ---------- */

    function sourceKind() {
      if (music.source === 'files' && !fellBack && music.files.length) return 'files';
      return 'ambient';
    }

    /** The sink identity: a different one means the old sink has to go. */
    function keyFor(kind) {
      if (kind !== 'files') return 'ambient';
      return 'files|' + (music.shuffle ? 's' : 'o') + '|' + music.files.map(function (f) {
        return f.path;
      }).join('\u0000');
    }

    function ready() {
      if (music.source === 'files' && !fellBack) return music.files.length > 0;
      return !!(ambient && typeof ambient.create === 'function');
    }

    function conditions() {
      return {
        enabled: music.enabled,
        manualPaused: manualPaused,
        focused: env.focused,
        audibleTab: env.audibleTab,
        mediaPlaying: env.mediaPlaying,
        newTabActive: env.newTabActive,
        where: music.where,
        ready: ready()
      };
    }

    /* --- the sinks --------------------------------------------- */

    function make(kind) {
      if (kind === 'files') {
        return createFilesSink({
          files: music.files,
          shuffle: music.shuffle,
          timers: timers,
          random: random,
          createAudio: createAudio,
          onChange: emit,
          onExhausted: function () {
            /* Every track failed. Say so once, hand the room to the engine,
               and leave the setting alone: his list is still his list. */
            fellBack = true;
            retire();
            apply();
          }
        });
      }
      return createAmbientSink({ ambient: ambient, timers: timers, onChange: emit });
    }

    /** Fade the current sink out and forget it; it stops itself. */
    function retire() {
      if (!sink) return;
      var old = sink;
      sink = null;
      sinkKey = '';
      old.pause(FADE_OUT_MS);
      retiring.push(old);
    }

    function sweep() {
      for (var i = retiring.length - 1; i >= 0; i -= 1) {
        if (!retiring[i].playing() && !retiring[i].pending()) retiring.splice(i, 1);
      }
    }

    /* --- the decision ------------------------------------------ */

    function apply() {
      if (settle != null) { timers.clearTimeout(settle); settle = null; }
      sweep();
      var want = shouldPlay(conditions());
      applying += 1;
      try {
        if (want) {
          var kind = sourceKind();
          var key = keyFor(kind);
          if (sink && key !== sinkKey) retire();
          if (!sink) { sink = make(kind); sinkKey = key; }
          if (sink && !sink.resume(music.volume, FADE_IN_MS)) {
            /* The engine refused (no AudioContext) or the list is empty: the
               state says "not playing" rather than lying about it. */
            want = false;
          }
        } else if (sink) {
          sink.pause(FADE_OUT_MS);
        }
      } finally { applying -= 1; }
      wanted = want;
      emit();
      return want;
    }

    /** A burst of edges is one decision, 300 ms after the last of them. */
    function schedule() {
      if (settle != null) timers.clearTimeout(settle);
      settle = timers.setTimeout(function () {
        settle = null;
        apply();
      }, SETTLE_MS);
    }

    /* --- the state app.js pushes ------------------------------- */

    function state() {
      var sounding = wanted && !!sink;
      return {
        enabled: music.enabled,
        playing: sounding,
        source: sourceKind(),
        title: sounding && sink ? sink.title() : '',
        where: music.where
      };
    }

    function emit() {
      if (applying > 0) return state();   // apply() pushes once, at the end
      var next = state();
      var key = '';
      try { key = JSON.stringify(next); } catch (err) { key = String(Math.random()); }
      if (key === lastPushed) return next;
      lastPushed = key;
      try { onState(next); } catch (err) { /* one bad listener */ }
      return next;
    }

    /* --- what app.js calls ------------------------------------- */

    return {
      /** The four facts from the chrome. Any real move settles a decision. */
      setEnvironment: function (patch) {
        var p = patch || {};
        var moved = false;
        var keys = ['focused', 'audibleTab', 'mediaPlaying', 'newTabActive'];
        for (var i = 0; i < keys.length; i += 1) {
          var k = keys[i];
          if (p[k] === undefined) continue;
          var v = p[k] === true;
          if (env[k] === v) continue;
          env[k] = v;
          moved = true;
        }
        /* With the switch off there is no decision to settle, so an edge costs
           not even a timer: enabling is a settings write, and that applies at
           once rather than through the settle. */
        if (moved && music.enabled) schedule();
        return moved;
      },

      /**
       * A settings write. The volume is not a start or a stop, so it applies
       * at once (200 ms) rather than waiting out the settle; everything else
       * goes through the same decision as any other edge.
       */
      setSettings: function (next) {
        var before = music;
        music = normalizeMusic(next);
        var wasKey = JSON.stringify({ s: before.source, f: before.files, h: before.shuffle });
        var isKey = JSON.stringify({ s: music.source, f: music.files, h: music.shuffle });
        if (wasKey !== isKey) fellBack = false;   // a new list deserves a new try
        if (!before.enabled && music.enabled) manualPaused = false;
        if (!music.enabled) manualPaused = false;
        var structural = wasKey !== isKey
          || before.enabled !== music.enabled
          || before.where !== music.where;
        if (structural) { apply(); return state(); }
        if (before.volume !== music.volume && wanted && sink) sink.fadeTo(music.volume, VOLUME_MS);
        return emit();
      },

      /** Re-read the store (app.js hands the group in; this is the shortcut). */
      refresh: function () {
        if (!readSettings) return state();
        return this.setSettings(read());
      },

      /** The page's Play/Pause. Immediate: a press is not a state drift. */
      toggle: function () {
        if (!music.enabled) return state();
        manualPaused = !manualPaused;
        apply();
        return state();
      },

      /** The page's Play when the music is off: only meaningful for callers
       *  that also wrote `enabled` to the store; here it just clears a pause. */
      play: function () {
        manualPaused = false;
        apply();
        return state();
      },

      /** Next track. Files only; the engine has no tracks to skip. */
      next: function () {
        if (!sink || sink.kind !== 'files') return false;
        var moved = sink.next();
        emit();
        return moved;
      },

      /** Apply any pending decision now (user actions, tests, the live check). */
      flush: function () { return apply(); },

      state: state,

      /** Everything, for the harness and for the live verification. */
      debug: function () {
        return {
          conditions: conditions(),
          wanted: wanted,
          manualPaused: manualPaused,
          fellBack: fellBack,
          sinkKey: sinkKey,
          settlePending: settle != null,
          retiring: retiring.length,
          music: music,
          sink: sink ? sink.state() : null
        };
      },

      /** Window teardown: no timer, no context, no element left running. */
      destroy: function () {
        if (settle != null) { timers.clearTimeout(settle); settle = null; }
        if (sink) { sink.stopNow(); sink = null; sinkKey = ''; }
        for (var i = 0; i < retiring.length; i += 1) retiring[i].stopNow();
        retiring = [];
        wanted = false;
      }
    };
  }

  var MusicPlayer = {
    FADE_IN_MS: FADE_IN_MS,
    FADE_OUT_MS: FADE_OUT_MS,
    SETTLE_MS: SETTLE_MS,
    VOLUME_MS: VOLUME_MS,
    STEP_MS: STEP_MS,
    MUSIC_PREFIX: MUSIC_PREFIX,
    MEDIA_PREFIX: MEDIA_PREFIX,
    MUSIC_ACTIONS: MUSIC_ACTIONS.slice(),
    MEDIA_CMDS: MEDIA_CMDS.slice(),
    normalizeMusic: normalizeMusic,
    shouldPlay: shouldPlay,
    fileUrl: fileUrl,
    shuffleOrder: shuffleOrder,
    parseMusicLine: parseMusicLine,
    parseMediaLine: parseMediaLine,
    mediaFacts: mediaFacts,
    mediaHash: mediaHash,
    mediaPlaying: mediaPlaying,
    mediaPush: mediaPush,
    createAmbientSink: createAmbientSink,
    createFilesSink: createFilesSink,
    create: create
  };

  if (typeof window !== 'undefined') window.MusicPlayer = MusicPlayer;
  // node require()s this same file for the harness.
  if (typeof module !== 'undefined' && module.exports) module.exports = MusicPlayer;
})();
