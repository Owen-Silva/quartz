/* ============================================================
   watch-playerbar-page.js -- the page half of Lumen's play bar.

   watch-playerbar.js (the bar, in Lumen's renderer) injects bridge()
   into the service's own player page with <webview>.executeJavaScript,
   with the service's adapter (watch/playerbar/<service>.js) as data
   plus its few page functions. The bridge:

   - finds the page's own <video> (8 s at most, then says so);
   - only then puts ONE class on <html> (lumen-pb-on) that hides the
     service's control bar: visibility only, so the service's ad UI
     (Skip, the countdown, "Why this ad"), its age, consent, "Are you
     still watching?" and error overlays inside it stay visible and
     clickable;
   - drives that <video> through the HTMLMediaElement API on command
     (play, pause, currentTime, volume, muted, playbackRate, the
     textTracks / audioTracks modes) and through the service's own
     player API where it has one (YouTube's movie_player). It only
     CONTROLS the service's player: it never reads the stream, never
     touches EME / DRM, never skips or hides an ad;
   - reports back on the console (one tagged line per change, the way
     watch-player-extras.js does): state on the video's own events,
     the time only while the bar is on screen (4 a second at most),
     the video's box, a key or a move of the mouse (5 a second at
     most). No timers at rest.

   The page's own fullscreen (its F key, a double-click, its button)
   becomes Lumen's: while the bar is on, requestFullscreen asks Lumen
   instead, so the window never goes fullscreen by surprise.

   CommonJS for the unit harness: css() and source() are pure.
   ============================================================ */
(function (root, factory) {
  var P = factory();
  if (typeof module === 'object' && module.exports) module.exports = P;
  else root.LumenPlayerBarPage = P;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var TAG = 'lumenpb:';
  var VERSION = 3;

  /** The style the bridge puts in the page: hide H while on; K inside H stays visible and clickable. */
  function css(hide, keep) {
    hide = (hide || []).filter(Boolean);
    keep = (keep || []).filter(Boolean);
    if (!hide.length) return '';
    var on = function (x) { return 'html.lumen-pb-on ' + x; };
    var out = [];
    out.push(hide.map(on).join(',\n') + ' { visibility: hidden !important; pointer-events: none !important; }');
    out.push(hide.map(function (h) { return 'html.lumen-pb-on.lumen-pb-own ' + h; }).join(',\n') + ' { visibility: visible !important; pointer-events: auto !important; }');
    if (keep.length) {
      var ks = [];
      hide.forEach(function (h) { keep.forEach(function (k) { ks.push(on(h + ' ' + k)); }); });
      out.push(ks.join(',\n') + ' { visibility: visible !important; pointer-events: auto !important; }');
    }
    out.push('html.lumen-pb-on.lumen-pb-idle, html.lumen-pb-on.lumen-pb-idle * { cursor: none !important; }');
    return out.join('\n');
  }

  /* ---- runs INSIDE the service's page: no closures over this file, ES5 only ---- */
  function bridge(cfg, A) {
    var W = window, D = document, R = D.documentElement;
    if (W.__lumenPB && W.__lumenPB.v === cfg.v) return W.__lumenPB.status();
    if (W.__lumenPB && typeof W.__lumenPB.teardown === 'function') { try { W.__lumenPB.teardown(); } catch (e) { /* an older bridge */ } }
    var log = console.log.bind(console);
    var B = { v: cfg.v, video: null, on: false, want: true, live: false, findT: 0, findUntil: 0, pushT: 0, lastPush: 0, lastAct: 0, rectT: 0, ro: null, mo: null, offs: [] };
    var RF = Element.prototype.requestFullscreen, RFW = Element.prototype.webkitRequestFullscreen;
    function post(m) { try { log(cfg.tag + JSON.stringify(m)); } catch (e) { /* no console */ } }
    function listen(t, n, f, o) { t.addEventListener(n, f, o); B.offs.push(function () { t.removeEventListener(n, f, o); }); }
    function safe(f) { try { return f(); } catch (e) { return null; } }
    function num(x, d) { x = Number(x); return isFinite(x) ? x : d; }

    var st = D.createElement('style');
    st.id = 'lumen-pb-style';
    st.textContent = cfg.css || '';
    (D.head || R).appendChild(st);

    function area(v) { var r = v.getBoundingClientRect(); return r.width * r.height; }
    function pick() {
      var seen = [], best = null;
      var sels = cfg.video && cfg.video.length ? cfg.video : ['video'];
      for (var i = 0; i < sels.length; i++) {
        var l = safe(function () { return D.querySelectorAll(sels[i]); }) || [];
        for (var j = 0; j < l.length; j++) {
          var v = l[j];
          if (v.tagName !== 'VIDEO' || seen.indexOf(v) >= 0) continue;
          seen.push(v);
          if (area(v) > 0) return v;
          if (!best) best = v;
        }
      }
      return best;
    }
    function find(fresh) {
      clearTimeout(B.findT);
      if (fresh) B.findUntil = Date.now() + num(cfg.find, 8000);
      var v = pick();
      if (v) { attach(v); return; }
      if (Date.now() >= B.findUntil) { post({ t: 'novideo', ms: num(cfg.find, 8000), url: String(location.href).slice(0, 200) }); return; }
      B.findT = setTimeout(function () { find(false); }, 400);
    }

    var EV = ['play', 'pause', 'playing', 'waiting', 'ended', 'durationchange', 'loadedmetadata', 'volumechange', 'ratechange', 'progress', 'seeked', 'emptied'];
    function onEv(e) { if (e.target === B.video) soon(); }
    function onTime(e) {
      if (e.target !== B.video) return;
      if (!B.live) return;
      if (Date.now() - B.lastPush >= 250) push();
    }
    function attach(v) {
      if (B.video === v) return;
      var first = !B.video;
      if (B.video && B.ro) { try { B.ro.unobserve(B.video); } catch (e) { /* gone */ } }
      B.video = v;
      if (B.ro) B.ro.observe(v);
      setOn(B.want);
      post({ t: first ? 'ready' : 'swap', st: state(true) });
    }
    function setOn(on) {
      B.on = !!on && !!B.video;
      R.classList.toggle('lumen-pb-on', B.on);
      if (!B.on) { R.classList.remove('lumen-pb-own'); R.classList.remove('lumen-pb-idle'); }
      var fake = function () { post({ t: 'fs' }); return Promise.resolve(); };
      Element.prototype.requestFullscreen = B.on ? fake : RF;
      if (RFW) Element.prototype.webkitRequestFullscreen = B.on ? fake : RFW;
    }
    function soon() { if (!B.pushT) B.pushT = setTimeout(push, 40); }
    function push() { clearTimeout(B.pushT); B.pushT = 0; if (B.video) post({ t: 'state', st: state(false) }); }

    function rect() {
      var v = B.video;
      if (!v) return null;
      var r = v.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), vw: W.innerWidth, vh: W.innerHeight };
    }
    function buffered(v, c) {
      var b = v.buffered, end = 0;
      for (var i = 0; b && i < b.length; i++) { if (b.start(i) <= c + 0.5 && b.end(i) >= c) end = Math.max(end, b.end(i)); }
      return end;
    }
    function state(withMenus) {
      var v = B.video;
      if (!v) return null;
      if (!v.isConnected) { B.video = null; find(true); return null; }
      var c = num(v.currentTime, 0), d = v.duration;
      var sk = null;
      if (!isFinite(d) && v.seekable && v.seekable.length) sk = [v.seekable.start(0), v.seekable.end(v.seekable.length - 1)];
      var s = {
        p: !!v.paused, e: !!v.ended, c: c, d: isFinite(d) ? d : (d === Infinity ? -1 : 0), b: buffered(v, c), sk: sk,
        vol: num(v.volume, 1), m: !!v.muted, r: num(v.playbackRate, 1), rs: v.readyState,
        ad: A.ad ? safe(function () { return A.ad(D, v); }) : null,
        next: hasNext(), rect: rect(), on: B.on, own: R.classList.contains('lumen-pb-own')
      };
      if (withMenus) s.menus = menus();
      B.lastPush = Date.now();
      return s;
    }
    function hasNext() {
      if (A.hasNext) return !!safe(function () { return A.hasNext(D); });
      return !!(cfg.next && safe(function () { return D.querySelector(cfg.next); }));
    }

    /* ---- menus: the adapter's API first, then the video's own tracks, then the service's own menu ---- */
    function tracks(v) {
      var tt = v.textTracks, out = [], cur = 'off';
      for (var i = 0; tt && i < tt.length; i++) {
        var t = tt[i];
        if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
        out.push({ id: String(i), label: String(t.label || t.language || ('Track ' + (out.length + 1))) });
        if (t.mode === 'showing') cur = String(i);
      }
      return out.length ? { via: 'tracks', off: true, items: out, cur: cur } : null;
    }
    function audios(v) {
      var at = v.audioTracks;
      if (!at || at.length < 2) return null;
      var out = [], cur = '';
      for (var i = 0; i < at.length; i++) {
        out.push({ id: String(i), label: String(at[i].label || at[i].language || ('Track ' + (i + 1))) });
        if (at[i].enabled) cur = String(i);
      }
      return { via: 'tracks', items: out, cur: cur };
    }
    function ownOf(kind) {
      var sel = cfg.own && cfg.own[kind];
      return sel && safe(function () { return D.querySelector(sel); }) ? { via: 'own', items: [] } : null;
    }
    function none(kind) { return { via: 'none', items: [], why: (cfg.none && cfg.none[kind]) || '' }; }
    function menus() {
      var v = B.video;
      var m = (A.menus && v ? safe(function () { return A.menus(D, v); }) : null) || {};
      if (!m.captions) m.captions = (v && tracks(v)) || ownOf('captions') || none('captions');
      if (!m.audio) m.audio = (v && audios(v)) || ownOf('audio') || none('audio');
      if (!m.quality) m.quality = ownOf('quality') || none('quality');
      return m;
    }
    function choose(kind, id) {
      var v = B.video, m = menus()[kind];
      if (!m) return { ok: false, why: 'no ' + kind + ' menu' };
      if (m.via === 'api' || m.via === 'button') return A.pick && A.pick(kind, id, D, v) ? { ok: true } : { ok: false, why: 'the player did not take it' };
      if (m.via === 'tracks' && kind === 'captions') {
        for (var i = 0; i < v.textTracks.length; i++) {
          var t = v.textTracks[i];
          if (t.kind === 'subtitles' || t.kind === 'captions') t.mode = String(i) === id ? 'showing' : 'disabled';
        }
        return { ok: true };
      }
      if (m.via === 'tracks' && kind === 'audio') {
        for (var k = 0; k < v.audioTracks.length; k++) v.audioTracks[k].enabled = String(k) === id;
        return { ok: true };
      }
      return { ok: false, why: kind + ' has no list here' };
    }
    function own(kind) {
      var sel = (cfg.own && (cfg.own[kind] || cfg.own.more)) || '';
      var b = sel ? safe(function () { return D.querySelector(sel); }) : null;
      R.classList.add('lumen-pb-own');
      if (!b) return { ok: true, opened: false };
      b.click();
      return { ok: true, opened: true };
    }

    /* ---- input: the bar's keys, the mouse moving, a double-click ---- */
    function typing(t) { return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')); }
    function isKey(e) { return cfg.keys.indexOf(e.key) >= 0; }
    function onKey(e) {
      if (!B.on || e.ctrlKey || e.altKey || e.metaKey || typing(e.target) || !isKey(e)) return;
      // Space or Enter on one of the page's own buttons (its Skip button, a dialog) presses that button.
      if ((e.key === ' ' || e.key === 'Enter') && e.target && e.target !== D.body && /^(BUTTON|A)$/.test(e.target.tagName || '')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== 'keydown') return;
      if (e.repeat && !/^Arrow/.test(e.key)) return;
      post({ t: 'key', k: e.key, s: !!e.shiftKey });
    }
    function onMove() {
      if (!B.on) return;
      var n = Date.now();
      if (n - B.lastAct < 200) return;
      B.lastAct = n;
      post({ t: 'act' });
    }
    function onDbl(e) {
      if (!B.on || !B.video) return;
      var r = B.video.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      post({ t: 'dbl' });
    }
    function onRect() { if (!B.rectT) B.rectT = setTimeout(function () { B.rectT = 0; if (B.video) post({ t: 'rect', rect: rect() }); }, 80); }

    listen(W, 'keydown', onKey, true);
    listen(W, 'keyup', onKey, true);
    listen(W, 'keypress', onKey, true);
    listen(W, 'pointermove', onMove, { capture: true, passive: true });
    listen(W, 'pointerdown', function () { B.lastAct = 0; onMove(); }, { capture: true, passive: true });
    listen(W, 'dblclick', onDbl, true);
    listen(W, 'resize', onRect, { passive: true });
    listen(W, 'scroll', onRect, { capture: true, passive: true });
    for (var i = 0; i < EV.length; i++) listen(D, EV[i], onEv, true);
    listen(D, 'timeupdate', onTime, true);
    if (typeof ResizeObserver === 'function') B.ro = new ResizeObserver(onRect);
    if (cfg.adRoot && typeof MutationObserver === 'function') {
      var ar = D.querySelector(cfg.adRoot);
      if (ar) { B.mo = new MutationObserver(soon); B.mo.observe(ar, { attributes: true, attributeFilter: ['class'] }); }
    }

    function cmd(c) {
      c = c || {};
      var v = B.video && B.video.isConnected ? B.video : null;
      if (c.c === 'status') return status();
      if (c.c === 'rescan') { if (!v) { B.video = null; find(true); } else post({ t: 'ready', st: state(true) }); return status(); }
      if (c.c === 'off') { B.want = false; setOn(false); return { ok: true }; }
      if (!v) return { ok: false, why: 'the video is not on the page' };
      var ad = A.ad ? safe(function () { return A.ad(D, v); }) : null;
      switch (c.c) {
        case 'on': B.want = true; setOn(true); break;
        case 'live': B.live = !!c.on; if (B.live) push(); break;
        case 'idle': R.classList.toggle('lumen-pb-idle', !!c.on && B.on); break;
        case 'play': case 'pause': case 'toggle': {
          var go = c.c === 'play' || (c.c === 'toggle' && v.paused);
          if (go) { var pr = v.play(); if (pr && pr.catch) pr.catch(function (err) { post({ t: 'err', c: 'play', why: String((err && err.name) || err).slice(0, 80) }); }); }
          else v.pause();
          break;
        }
        case 'seek': case 'skip': {
          if (ad && ad.on) return { ok: false, blocked: 'ad' };
          var d = v.duration, lo = 0, hi = isFinite(d) ? Math.max(0, d - 0.1) : Infinity;
          if (!isFinite(d) && v.seekable && v.seekable.length) { lo = v.seekable.start(0); hi = v.seekable.end(v.seekable.length - 1); }
          var to = c.c === 'seek' ? num(c.to, v.currentTime) : v.currentTime + num(c.by, 0);
          v.currentTime = Math.max(lo, Math.min(hi, to));
          break;
        }
        case 'vol': v.volume = Math.max(0, Math.min(1, num(c.v, v.volume))); if (v.volume > 0 && v.muted && c.unmute !== false) v.muted = false; break;
        case 'mute': v.muted = !!c.on; break;
        case 'rate': v.playbackRate = Math.max(0.0625, Math.min(16, num(c.r, 1))); break;
        case 'menus': return { ok: true, menus: menus() };
        case 'pick': { var r1 = choose(String(c.kind), String(c.id)); if (!r1.ok) return r1; return { ok: true, menus: menus(), st: state(false) }; }
        case 'own': return own(String(c.kind || 'more'));
        case 'ownoff': R.classList.remove('lumen-pb-own'); break;
        case 'next': { var nb = cfg.next ? D.querySelector(cfg.next) : null; if (!nb) return { ok: false, why: 'no next-episode button' }; nb.click(); break; }
        default: return { ok: false, why: 'unknown command ' + String(c.c).slice(0, 20) };
      }
      return { ok: true, st: state(false) };
    }
    function status() { return { ok: true, v: B.v, found: !!B.video, on: B.on }; }
    function teardown() {
      setOn(false);
      clearTimeout(B.findT); clearTimeout(B.pushT); clearTimeout(B.rectT);
      for (var i = 0; i < B.offs.length; i++) B.offs[i]();
      if (B.ro) B.ro.disconnect();
      if (B.mo) B.mo.disconnect();
      if (st.parentNode) st.parentNode.removeChild(st);
      W.__lumenPB = null;
    }
    W.__lumenPB = { v: B.v, cmd: function (c) { try { return cmd(c); } catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 120) }; } }, status: status, teardown: teardown };
    find(true);
    return status();
  }

  /** The code the bar injects: the bridge, its config and the adapter's page functions. */
  function source(cfg, adapter) {
    var a = adapter || {};
    var fns = a.page || {};
    var parts = Object.keys(fns).filter(function (k) { return typeof fns[k] === 'function'; })
      .map(function (k) { return JSON.stringify(k) + ': ' + fns[k].toString(); });
    var c = {
      v: VERSION, tag: TAG, find: cfg && cfg.find || 8000, keys: (cfg && cfg.keys) || [],
      video: a.video || ['video'], adRoot: a.adRoot || '', own: a.own || {}, next: a.next || '', none: a.none || {},
      css: css(a.hide, a.keep)
    };
    return '(' + bridge.toString() + ')(' + JSON.stringify(c) + ', {' + parts.join(',\n') + '})';
  }

  /** The call that runs one command in the page; a page without the bridge answers why. */
  function command(c) {
    return '(function (c) { var b = window.__lumenPB; return b ? b.cmd(c) : { ok: false, why: "the bridge is not on the page", gone: true }; })(' + JSON.stringify(c || {}) + ')';
  }

  return { TAG: TAG, VERSION: VERSION, css: css, bridge: bridge, source: source, command: command };
});
