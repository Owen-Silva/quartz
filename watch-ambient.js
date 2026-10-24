/* ============================================================
   watch-ambient.js -- Lumen's ambient field (chrome side).

   Behind Lumen's playback view and its Shorts view, the page is not
   flat black: it is the playing video's own colours, blurred into a
   soft field that fills the layer (YouTube's ambient mode, Apple TV's
   backdrop). The same idea as Quartz's chrome over its pre-blurred
   wallpaper and Lumen home's far layer (watch.js paintWash): ONE
   small picture, blurred ONCE into a 96 x 54 canvas, scaled up by the
   compositor, cross-faded by opacity. Nothing moves per frame.

     - First colours: the video's own still (YouTube: i.ytimg.com's
       mqdefault for the id in the address; other services: the
       page's og:image), decoded off the main thread, then drawn.
     - Then, while the video PLAYS, the colours follow it: every few
       seconds (EVERY) one small sample of the current frame, taken
       by the hosted page itself (createImageBitmap at 48 x 27, its own
       same-origin video; a protected or cross-origin video says so
       and the still stays), is drawn into the other canvas and the
       two cross-fade. A sample that barely changed paints nothing.
     - The refresh stops when the video is paused, the window is
       hidden or in the background, the layer is closed, in multiview
       or the corner or fullscreen, Windows asks to reduce motion, or
       battery saver is on (watch-ambient-main.js), and it slows to
       EVERY_IDLE while the field is sunk at the comments (back to EVERY
       as it rises, not after the idle wait). Reduced motion and
       battery saver keep the still field; multiview, the corner and
       fullscreen have no field at all.
     - Legibility is the CSS's (watch-ambient.css): the field is dimmed
       and washed so every word over it keeps WCAG AA on a white video.

   Hooks: watch-playview.js attach / destroy (two lines). Everything
   else is read from the layer (watch-player.js L) and the slot's own
   <webview>. Also a CommonJS module for the unit harness (the pure
   parts).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LumenAmbient = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================ pure */

  var EVERY = 4000;          // ms between frame samples while the video plays
  var EVERY_IDLE = 9000;     // ms between samples while it is paused, buffering or has no frame yet, or the field is sunk
  var FIRST = 1400;          // ms after the view opens (or the video changes) to the first sample
  var CW = 96, CH = 54;      // the field's canvas: scaled up it is a soft field and never re-blurs
  var DELTA = 9;             // mean colour change (0..255) under which a new sample paints nothing
  var FILTER = 'blur(4px) saturate(1.5)';
  var GATE_MS = 30000;       // battery saver is asked at most this often
  var STALE_MS = 700;        // a new video with no colours of its own by then: the neutral field, never the last video's
  var ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

  function parse(url) { try { return new URL(String(url || '')); } catch (e) { return null; } }

  /** The YouTube id in a watch, Shorts, embed or youtu.be address ('' when there is none). */
  function ytId(url) {
    var u = parse(url);
    if (!u) return '';
    var m;
    if (/(^|\.)youtu\.be$/i.test(u.hostname)) { m = u.pathname.split('/')[1] || ''; return ID_RE.test(m) ? m : ''; }
    var v = u.searchParams.get('v');
    if (v && ID_RE.test(v)) return v;
    m = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{6,20})/.exec(u.pathname);
    return m ? m[1] : '';
  }
  function stillUrl(id) { return ID_RE.test(String(id || '')) ? 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg' : ''; }
  /** What the field is drawn for: one key per video (a Short that moves is a new key). */
  function keyOf(service, url) { var id = ytId(url); return String(service || '') + ':' + (id || String(url || '').split('#')[0]); }

  /** A sample's signature: the mean colour of a 4 x 3 grid of cells (36 numbers). */
  function signature(px, w, h, stride) {
    var st = stride || 3, out = [];
    for (var cy = 0; cy < 3; cy++) {
      for (var cx = 0; cx < 4; cx++) {
        var x0 = Math.floor(cx * w / 4), x1 = Math.floor((cx + 1) * w / 4), y0 = Math.floor(cy * h / 3), y1 = Math.floor((cy + 1) * h / 3);
        var r = 0, g = 0, b = 0, n = 0;
        for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) { var i = (y * w + x) * st; r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
        out.push(n ? r / n : 0, n ? g / n : 0, n ? b / n : 0);
      }
    }
    return out;
  }
  /** Mean absolute difference of two signatures (0..255); Infinity when either is missing. */
  function diff(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    var t = 0;
    for (var i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]);
    return t / a.length;
  }
  /** Why the field may NOT refresh now ('' = it may). o: { reduced, saver, hidden, focused, playing }. */
  function refreshOff(o) {
    if (o.reduced) return 'Windows is set to reduce motion';
    if (o.saver === true) return 'battery saver is on';
    if (o.hidden) return 'the window is hidden';
    if (o.focused === false) return 'the window is in the background';
    return '';
  }
  /** Which slot the field dresses, from the layer's state; { s, mode } or { why }. */
  function pick(L) {
    if (!L || !L.el || !L.open || L.el.hidden) return { why: 'the player is closed' };
    var cl = L.el.classList;
    if (cl.contains('mv-mini')) return { why: 'the player is in the corner' };
    if (cl.contains('wp-fs')) return { why: 'the video is fullscreen' };
    if (!L.slots || L.slots.length !== 1) return { why: 'multiview' };
    var s = L.slots[0];
    if (!s || !s.tile || !s.view) return { why: 'no player yet' };
    var tc = s.tile.classList;
    var mode = tc.contains('sh') ? 'sh' : tc.contains('pv') ? 'pv' : '';
    if (!mode) return { why: 'the service’s full page' };
    if (s.tile.classList.contains('has-state')) return { why: 'the player shows a state' };
    return { s: s, mode: mode };
  }

  /* The hosted page's half: ONE small sample of its largest playing <video>, as RGB bytes. Runs in the
     page (executeJavaScript); never touches the stream, only the frame on screen, at 48 x 27. A
     protected (DRM) or cross-origin video can't be read: the reason comes back and the still stays.
     The frame is shrunk by createImageBitmap, off the page's main thread; the page's own thread only
     asks for it and then reads 48 x 27 pixels. "main" is that thread's time (the page's long-task
     budget), "ms" the wall time to the answer (it includes the off-thread wait). */
  function sampler() {
    var t0 = performance.now(), main = -1;
    function r1(x) { return Math.round(x * 10) / 10; }
    function still() { var m = document.querySelector('meta[property="og:image"]'); return m ? String(m.getAttribute('content') || '').slice(0, 500) : ''; }
    function done(o) { o.ms = r1(performance.now() - t0); o.main = r1(main >= 0 ? main : performance.now() - t0); return o; }
    function fail(why) { return done({ ok: false, reason: why, still: still() }); }
    try {
      if (document.hidden) return fail('hidden');
      var vs = document.querySelectorAll('video'), best = null, area = 0, W = innerWidth, H = innerHeight;
      for (var i = 0; i < vs.length; i++) {
        var v = vs[i];
        if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) continue;
        var r = v.getBoundingClientRect();
        var a = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0));
        if (a > area) { area = a; best = v; }
      }
      if (!best) return fail('no frame yet');
      var land = best.videoWidth >= best.videoHeight, w = land ? 48 : 27, h = land ? 27 : 48;
      var paused = !!(best.paused || best.ended), t = Math.round(best.currentTime * 10) / 10;
      var read = function (src) {
        var c = window.__lumenAmbC || (window.__lumenAmbC = document.createElement('canvas'));
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
        var x = c.getContext('2d', { willReadFrequently: true });
        x.clearRect(0, 0, w, h);
        x.drawImage(src, 0, 0, w, h);
        var d = x.getImageData(0, 0, w, h).data, s = '', max = 0;
        for (var k = 0; k < d.length; k += 4) {
          s += String.fromCharCode(d[k], d[k + 1], d[k + 2]);
          var m = d[k] > d[k + 1] ? d[k] : d[k + 1];
          if (d[k + 2] > m) m = d[k + 2];
          if (m > max) max = m;
        }
        return { ok: true, w: w, h: h, px: btoa(s), max: max, paused: paused, t: t };
      };
      if (typeof createImageBitmap === 'function') {
        var asked = createImageBitmap(best, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
        main = performance.now() - t0;
        return asked.then(function (bm) {
          var t1 = performance.now();
          try { var o = read(bm); main += performance.now() - t1; return done(o); }
          catch (e) { main += performance.now() - t1; return fail(String((e && e.name) || e)); }
          finally { try { bm.close(); } catch (e) { /* gone */ } }
        }, function (e) { return fail(String((e && e.name) || e)); });
      }
      return done(read(best));
    } catch (e) { return fail(String((e && e.name) || e)); }
  }
  var SAMPLE = '(' + String(sampler) + ')()';

  /* ================================================================ chrome */

  var A = {
    ctx: null, L: null, el: null, field: null, cvs: [], on: 0, src: null,
    slot: null, mode: '', key: '', from: 'none', why: '', off: '',
    timer: 0, due: 0, busy: false, sig: null, lastT: -1, playing: false, seq: 0, staleT: 0,
    paints: 0, samples: 0, skipped: 0, stills: 0, maxSampleMs: 0, maxSampleWallMs: 0, maxPaintMs: 0, lastSampleMs: 0,
    saver: null, saverAt: 0, saverAsking: false, mq: null, bound: false, obs: null,
    sinkTile: null, sinkMark: null, sinkObs: null, sunk: false
  };

  function hasDom() { return typeof document !== 'undefined' && !!document.createElement; }
  function reduced() { try { return !!(A.mq && A.mq.matches); } catch (e) { return false; } }
  function focused() { try { return document.hasFocus(); } catch (e) { return true; } }
  function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

  function build(L) {
    if (A.el || !L || !L.el || !hasDom()) return;
    var amb = A.el = document.createElement('div');
    amb.className = 'amb';
    amb.setAttribute('aria-hidden', 'true');
    var field = A.field = document.createElement('div');
    field.className = 'amb-f';
    for (var i = 0; i < 2; i++) {
      var c = document.createElement('canvas');
      c.className = 'amb-c';
      c.width = CW; c.height = CH;
      field.appendChild(c);
      A.cvs.push(c);
    }
    amb.appendChild(field);
    amb.appendChild(Object.assign(document.createElement('div'), { className: 'amb-wash' }));
    L.el.insertBefore(amb, L.el.firstChild);
    A.src = document.createElement('canvas');
  }

  function bind(L) {
    if (A.bound || !hasDom()) return;
    A.bound = true;
    try { A.mq = window.matchMedia('(prefers-reduced-motion: reduce)'); A.mq.addEventListener('change', function () { evaluate(); }); } catch (e) { A.mq = null; }
    document.addEventListener('visibilitychange', function () { evaluate(); });
    window.addEventListener('focus', function () { evaluate(); });
    window.addEventListener('blur', function () { evaluate(); });
    if (window.MutationObserver && L && L.el) {
      // The layer's own classes (pv-on, sh-on, mv-mini, wp-fs, hidden) and the grid's tile count say
      // when the field applies; the tile's classes (pv / sh / has-state) say which view it is.
      A.obs = new MutationObserver(function () { evaluate(); });
      A.obs.observe(L.el, { attributes: true, attributeFilter: ['class', 'hidden'] });
      if (L.grid) A.obs.observe(L.grid, { attributes: true, attributeFilter: ['data-n'], childList: true });
    }
  }

  function attach(ctx, s, v) {
    if (!ctx || !ctx.L || !s) return;
    A.ctx = ctx; A.L = ctx.L;
    build(ctx.L);
    bind(ctx.L);
    if (window.MutationObserver && s.tile && A.obs) A.obs.observe(s.tile, { attributes: true, attributeFilter: ['class'] });
    if (v && v.addEventListener) {
      // The page's address, from its own navigation events: <webview>.getURL() is a SYNCHRONOUS IPC to main,
      // and evaluate() runs on every class change of the layer; while main is busy opening the view each call
      // blocked the Quartz window 20-30 ms (lumen-perf trace, video view open).
      var moved = function (e) { if (e && e.url) s.ambUrl = String(e.url); if (A.slot === s) evaluate(); };
      v.addEventListener('did-navigate', moved);
      v.addEventListener('did-navigate-in-page', moved);
    }
    evaluate();
  }

  /* The playback view's sink: scrolled down to the info and the comments, the field sinks to a tint
     (watch-ambient.css .amb-sunk), so the words that rise into the light never meet it at full strength.
     ONE IntersectionObserver on a 1 px mark at the top of the scroller: no script and no paint while it
     scrolls (the scroll-driven animation it replaces repainted the whole window on every scroll step:
     watch-look-e2e, 32 window-sized paints over one wheel), one class flip where SINK_PX is crossed, and
     the compositor runs the fade. */
  var SINK_PX = 120;
  function sinkOn(tile) {
    if (A.sinkTile === tile && A.sinkMark && A.sinkMark.isConnected) return;
    sinkOff();
    if (!tile || typeof IntersectionObserver !== 'function') return;
    var mark = document.createElement('i');
    mark.className = 'amb-mark';
    mark.setAttribute('aria-hidden', 'true');
    tile.appendChild(mark);
    A.sinkTile = tile; A.sinkMark = mark;
    A.sinkObs = new IntersectionObserver(function (es) {
      if (!A.sinkMark || !A.sinkMark.isConnected || !es.length) return;
      var was = A.sunk;
      A.sunk = !es[es.length - 1].isIntersecting;
      if (A.L && A.L.el) A.L.el.classList.toggle('amb-sunk', A.sunk);
      // Back up at the top while it plays: the idle wait taken while sunk (EVERY_IDLE) is cut to the playing
      // cadence. Kept, the field at full strength stayed on a picture from the comments for up to 9 s after the
      // rise (watch-look-e2e "refreshes from the frame every few seconds": 1 sample in 9 s whenever the last
      // sample before the rise fell while sunk). Never sooner than EVERY from now: a scroll up and down can't
      // sample faster than the playing cadence.
      if (was && !A.sunk && A.playing && A.timer && !A.busy && A.due - now() > EVERY) schedule(EVERY);
    }, { root: tile, rootMargin: SINK_PX + 'px 0px 0px 0px', threshold: 0 });
    A.sinkObs.observe(mark);
  }
  function sinkOff() {
    if (A.sinkObs) { try { A.sinkObs.disconnect(); } catch (e) { /* gone */ } A.sinkObs = null; }
    if (A.sinkMark && A.sinkMark.parentNode) A.sinkMark.parentNode.removeChild(A.sinkMark);
    A.sinkMark = null; A.sinkTile = null; A.sunk = false;
    // toggle(x, false), never remove(x): remove() rewrites the class attribute even when x is absent, the
    // layer's MutationObserver calls evaluate(), evaluate() calls sinkOff() again: an endless microtask loop
    // that hung the Quartz window when the layer closed (watch-ytlib-e2e, lumen-n-perf3, 10-19).
    if (A.L && A.L.el) A.L.el.classList.toggle('amb-sunk', false);
  }

  function destroy(ctx, s) {
    A.gone = s;   // its view is going: never sampled again, even while the layer still lists it
    if (A.slot === s) { stop(); A.slot = null; }
    evaluate();
  }

  function stop() { clearTimeout(A.timer); A.timer = 0; A.seq++; A.busy = false; }

  /** Where the field stands now: on or off, which slot, which video; the refresh started or stopped. */
  function evaluate() {
    var L = A.L;
    if (!L || !L.el || !A.el) return;
    // The closed slot is let go once the layer no longer lists it: kept, it held the closed view's whole tile and
    // its detached <webview> until the next close.
    if (A.gone && (!L.slots || L.slots.indexOf(A.gone) < 0)) A.gone = null;
    var p = pick(L);
    if (p.s && p.s === A.gone) p = { why: 'the player is closing' };
    var on = !!p.s;
    L.el.classList.toggle('amb-on', on);
    L.el.classList.toggle('amb-sh', on && p.mode === 'sh');
    if (!on) {
      A.why = p.why; A.off = p.why;
      if (A.slot) { stop(); A.slot = null; }
      sinkOff();
      if (!L.open || L.el.hidden) blank();
      return;
    }
    A.why = '';
    var s = p.s, url = s.ambUrl || s.url;   // never s.view.getURL() here: see attach()
    if (p.mode === 'pv' && s.tile) sinkOn(s.tile); else sinkOff();
    var key = keyOf(s.service, url);
    if (A.slot !== s || A.mode !== p.mode || key !== A.key) {
      var fresh = key !== A.key;
      A.slot = s; A.mode = p.mode;
      if (fresh) {
        A.key = key; A.sig = null; A.lastT = -1; A.from = 'none'; A.playing = false;
        stop();
        paintStill(s.service, url, key);
        // Until this video's own still or frame paints, the field still shows the LAST video's colours: on a slow
        // network (a still that takes seconds, or never loads) that stayed behind the new video. Not painted by
        // STALE_MS: the neutral field (paint() cross-fades the real colours over it when they come).
        clearTimeout(A.staleT);
        A.staleT = setTimeout(function () { A.staleT = 0; if (A.key === key && A.from === 'none') neutral(); }, STALE_MS);
      }
    }
    schedule();
  }

  /* The player closed: the field forgets its video. Kept, the next video opened showed the last one's colours
     at full strength (the canvas stayed .on behind the closed layer) and cross-faded from them, 1.6 s, after its
     own still had loaded. The canvases are dropped while the layer is hidden, so nothing fades on screen; the
     next open starts like the first one (its still, or the neutral field after STALE_MS). Canvases only: no
     MutationObserver watches them. */
  function blank() {
    if (!A.key && A.from === 'none') return;
    clearTimeout(A.staleT); A.staleT = 0;
    A.key = ''; A.sig = null; A.lastT = -1; A.from = 'none';
    for (var i = 0; i < A.cvs.length; i++) A.cvs[i].classList.toggle('on', false);
  }

  function gateNow() {
    var t = Date.now();
    var api = window.api && window.api.lumenAmbient;
    if (api && typeof api.gate === 'function' && !A.saverAsking && t - A.saverAt > GATE_MS) {
      A.saverAsking = true;
      api.gate().then(function (r) {
        A.saverAsking = false; A.saverAt = Date.now();
        var was = A.saver;
        A.saver = r && r.ok ? r.saver : null;
        if (was !== A.saver) evaluate();
      }, function () { A.saverAsking = false; A.saverAt = Date.now(); });
    }
    return refreshOff({ reduced: reduced(), saver: A.saver, hidden: document.hidden, focused: focused() });
  }

  /** The next sample, ms from now (default: the first one or the playing cadence), if the refresh may run. */
  function schedule(ms) {
    if (!A.slot) { A.off = A.why; return; }
    A.off = gateNow();
    if (A.off) { stop(); return; }
    if (A.timer || A.busy) { if (ms === undefined) return; clearTimeout(A.timer); A.timer = 0; }
    var seq = A.seq, wait = ms === undefined ? (A.from === 'frame' ? EVERY : FIRST) : ms;
    A.due = now() + wait;
    A.timer = setTimeout(function () { A.timer = 0; if (seq === A.seq) sample(seq); }, wait);
  }

  /** The wait to the next sample: the playing cadence, and the idle one while paused or while the field is sunk to
      its tint (scrolled to the comments: a change there shows at 20% and far from the eye). Reads state only. */
  function cadence(paused) { return paused || A.sunk ? EVERY_IDLE : EVERY; }

  function sample(seq) {
    var s = A.slot;
    if (!s || !s.view || A.busy) return;
    if (gateNow()) { A.off = gateNow(); return; }
    var key = A.key, v = s.view, t0 = now();
    A.busy = true;
    var p;
    try { p = v.executeJavaScript(SAMPLE, false); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function (r) {
      A.busy = false;
      A.lastSampleMs = Math.round(now() - t0);
      if (seq !== A.seq || A.slot !== s || A.key !== key) return;
      // the page's main-thread time (its long-task budget); the wall time includes the off-thread shrink
      if (r && typeof r.main === 'number') A.maxSampleMs = Math.max(A.maxSampleMs, r.main);
      if (r && typeof r.ms === 'number') A.maxSampleWallMs = Math.max(A.maxSampleWallMs, r.ms);
      if (!r || !r.ok) {
        A.why = 'no frame sample: ' + ((r && r.reason) || 'no answer');
        A.playing = false;
        if (r && r.still && A.from === 'none') paintImageUrl(r.still, key);
        schedule(EVERY_IDLE);
        return;
      }
      A.samples++;
      A.why = '';
      A.playing = !r.paused;
      // Nothing moved since the last one (paused on the same frame): nothing to paint.
      if (r.paused && r.t === A.lastT && A.from === 'frame') { schedule(EVERY_IDLE); return; }
      A.lastT = r.t;
      // A black frame (a fade, a protected video): keep what is there.
      if (r.max < 14 && A.from !== 'none') { A.skipped++; schedule(cadence(r.paused)); return; }
      var bin = atob(r.px), px = new Uint8ClampedArray(r.w * r.h * 4);
      for (var i = 0, j = 0; i < bin.length; i += 3, j += 4) { px[j] = bin.charCodeAt(i); px[j + 1] = bin.charCodeAt(i + 1); px[j + 2] = bin.charCodeAt(i + 2); px[j + 3] = 255; }
      var sig = signature(px, r.w, r.h, 4);
      if (A.from === 'frame' && diff(sig, A.sig) < DELTA) { A.skipped++; schedule(cadence(r.paused)); return; }
      A.sig = sig;
      var sc = A.src;
      if (sc.width !== r.w) sc.width = r.w;
      if (sc.height !== r.h) sc.height = r.h;
      sc.getContext('2d').putImageData(new ImageData(px, r.w, r.h), 0, 0);
      paint(sc, r.w, r.h);
      A.from = 'frame';
      schedule(cadence(r.paused));
    }, function (e) {
      A.busy = false;
      if (seq !== A.seq) return;
      A.why = 'no frame sample: ' + ((e && e.message) || e);
      schedule(EVERY_IDLE);
    });
  }

  function paintStill(service, url, key) {
    var u = service === 'youtube' ? stillUrl(ytId(url)) : '';
    if (u) paintImageUrl(u, key);
    else if (A.from === 'none') neutral();
  }

  function paintImageUrl(u, key) {
    if (!/^https?:\/\//i.test(String(u || ''))) { if (A.from === 'none') neutral(); return; }
    var im = new Image();
    im.decoding = 'async';
    im.referrerPolicy = 'no-referrer';
    im.onload = function () {
      // Decoded off the main thread BEFORE the canvas draws it, so the draw never decodes in a frame.
      var go = function () {
        if (A.key !== key || A.from === 'frame') return;
        A.stills++;
        paint(im, im.naturalWidth, im.naturalHeight);
        A.from = 'still';
      };
      if (typeof im.decode === 'function') im.decode().then(go, go); else go();
    };
    im.onerror = function () { if (A.key === key && A.from === 'none') { A.why = 'the video’s still didn’t load'; neutral(); } };
    im.src = u;
  }

  /** No picture to draw from: a quiet neutral lift around the player, never flat black. */
  function neutral() {
    var c = A.cvs[1 - A.on];
    if (!c) return;
    var x = c.getContext('2d');
    x.save();
    x.filter = 'none';
    var g = x.createRadialGradient(CW / 2, CH * 0.42, 2, CW / 2, CH * 0.42, CW * 0.62);
    g.addColorStop(0, '#3a3c40');
    g.addColorStop(0.55, '#1c1d20');
    g.addColorStop(1, '#0b0c0d');
    x.fillStyle = g;
    x.fillRect(0, 0, CW, CH);
    x.restore();
    swap();
    A.from = 'neutral';
  }

  /** Draw a picture (cover-fit, with overscan so the blurred edge never greys) into the hidden canvas and cross-fade. */
  function paint(img, w, h) {
    var c = A.cvs[1 - A.on];
    if (!c || !w || !h) return;
    var t0 = now();
    var x = c.getContext('2d');
    var o = 6, bw = CW + 2 * o, bh = CH + 2 * o;
    var k = Math.max(bw / w, bh / h), dw = w * k, dh = h * k;
    x.save();
    x.fillStyle = '#0b0c0d';
    x.fillRect(0, 0, CW, CH);
    x.filter = FILTER;
    x.drawImage(img, (CW - dw) / 2, (CH - dh) / 2, dw, dh);
    x.restore();
    A.maxPaintMs = Math.max(A.maxPaintMs, Math.round((now() - t0) * 10) / 10);
    swap();
  }
  function swap() {
    var next = A.cvs[1 - A.on], cur = A.cvs[A.on];
    next.classList.add('on');
    cur.classList.remove('on');
    A.on = 1 - A.on;
    A.paints++;
  }

  function state() {
    return {
      on: !!(A.L && A.L.el && A.L.el.classList.contains('amb-on')), mode: A.slot ? A.mode : '', key: A.key, src: A.from,
      refreshing: !!(A.timer || A.busy), nextMs: A.timer ? Math.max(0, Math.round(A.due - now())) : null, off: A.off, why: A.why, every: EVERY,
      paints: A.paints, samples: A.samples, skipped: A.skipped, stills: A.stills,
      maxSampleMs: A.maxSampleMs, maxPaintMs: A.maxPaintMs, lastSampleMs: A.lastSampleMs, maxSampleWallMs: A.maxSampleWallMs, saver: A.saver, sunk: A.sunk,
      holdsClosed: !!A.gone, lit: A.cvs.filter(function (c) { return c.classList.contains('on'); }).length
    };
  }

  /* ------------------------------------------------- the channel's avatar */
  // YouTube's lazy images carry a 1 x 1 placeholder (a transparent GIF) until they scroll in, and the reader
  // can catch one: the view then showed an empty ring. Any avatar that loads as a placeholder (or fails) gets
  // the channel's initial on the neutral disc instead. One capture listener on 'load'; no polling.
  function placeholder(w, h) { return !(w > 2 && h > 2); }
  function initialOf(name) { var t = String(name || '').replace(/^@/, '').trim(); return t ? t.charAt(0).toUpperCase() : ''; }
  function avatarFix(img) {
    var av = img && img.parentNode;
    if (!av || !av.classList || !av.classList.contains('pv-avatar')) return;
    var chan = av.closest ? av.closest('.pv-chan') : null;
    var nm = chan ? chan.querySelector('.pv-chan-name') : null;
    img.remove();
    av.textContent = initialOf(nm && !nm.classList.contains('pv-skel') ? nm.textContent : '');
  }
  if (hasDom() && typeof document.addEventListener === 'function') {
    document.addEventListener('load', function (e) {
      var t = e.target;
      if (t && t.tagName === 'IMG' && t.parentNode && t.parentNode.classList && t.parentNode.classList.contains('pv-avatar') && placeholder(t.naturalWidth, t.naturalHeight)) avatarFix(t);
    }, true);
  }

  return {
    // watch-playview.js hooks
    attach: attach, destroy: destroy,
    // pure parts (tests/watch-ambient-test.js)
    placeholder: placeholder, initialOf: initialOf,
    ytId: ytId, stillUrl: stillUrl, keyOf: keyOf, signature: signature, diff: diff, refreshOff: refreshOff, pick: pick,
    EVERY: EVERY, EVERY_IDLE: EVERY_IDLE, DELTA: DELTA,
    _state: state
  };
});
