/* ============================================================
   watch-playerbar.js -- Lumen's own play bar (chrome side).

   The service's player page plays in the layer's <webview>; this
   draws ONE play bar, the same on every service, over the bottom of
   the video's box: play/pause, a seek bar (buffered + elapsed), the
   time, -10 s / +10 s, volume and mute, speed, captions, audio
   language, quality, Next episode where the service has one, and
   Lumen's fullscreen (the Lumen window, never the screen; "Whole
   screen" is a second, separate action).

   The page half (watch-playerbar-page.js) is injected into the
   service's page and drives its own <video> (and YouTube's own
   movie_player API); the per-service parts are data in
   watch/playerbar/<service>.js.

   It hides the service's own bar only while Lumen's is on: one class
   on the page's <html>. It falls back to the service's own bar, with
   a one-line reason, when the video can't be found in 8 s or a
   command fails twice in a row. Settings > Lumen > Play bar picks
   "The service's own" for good.

   Multiview tiles have no Lumen bar (see tileRule below).

   Hooks: watch-player.js's X() list (attach / destroy / sync) and
   takeShortcut (Esc closes a menu, then Lumen's fullscreen, first).

   CommonJS for the unit harness: everything above "DOM" is pure.
   ============================================================ */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LumenPlayerBar = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var HIDE_MS = 2500;      // still this long (and playing): the bar goes
  var FIND_MS = 8000;      // the bridge looks for the page's <video> this long
  var CMD_MS = 2500;       // a command with no answer this long has failed
  var FAILS = 2;           // this many failed commands in a row: the service's own bar comes back
  var SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  var STORE = 'lumen.playbar';

  /* =============================================================== pure */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  /** 0:05, 12:34, 1:02:03. ref (the duration) keeps the hours column once the video is an hour long. */
  function fmtTime(sec, ref) {
    var s = Number(sec);
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    if (h > 0 || Number(ref) >= 3600) return h + ':' + pad(m) + ':' + pad(x);
    return m + ':' + pad(x);
  }
  /** The range a seek may land in: [0, duration - 0.1], or a live stream's seekable window. */
  function seekRange(dur, sk) {
    if (dur > 0) return [0, Math.max(0, dur - 0.1)];
    if (sk && sk.length === 2 && isFinite(sk[0]) && isFinite(sk[1])) return [sk[0], sk[1]];
    return [0, 0];
  }
  function clampSeek(to, dur, sk) { var r = seekRange(dur, sk); return Math.max(r[0], Math.min(r[1], Number(to) || 0)); }
  function skipTarget(cur, by, dur, sk) { return clampSeek((Number(cur) || 0) + (Number(by) || 0), dur, sk); }
  /** Where along the seek bar a pointer is, 0..1. */
  function fracAt(x, left, width) { if (!(width > 0)) return 0; return Math.max(0, Math.min(1, (x - left) / width)); }
  function timeAt(frac, dur, sk) {
    if (dur > 0) return Math.max(0, Math.min(1, frac)) * dur;
    var r = seekRange(dur, sk);
    return r[0] + Math.max(0, Math.min(1, frac)) * (r[1] - r[0]);
  }
  function fracOf(t, dur, sk) {
    if (dur > 0) return Math.max(0, Math.min(1, t / dur));
    var r = seekRange(dur, sk);
    return r[1] > r[0] ? Math.max(0, Math.min(1, (t - r[0]) / (r[1] - r[0]))) : 1;
  }
  function stepSpeed(r, dir) {
    var i = 0, best = Infinity;
    for (var k = 0; k < SPEEDS.length; k++) { var d = Math.abs(SPEEDS[k] - r); if (d < best) { best = d; i = k; } }
    return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + (dir > 0 ? 1 : -1)))];
  }
  function stepVol(v, by) { return Math.round(Math.max(0, Math.min(1, (Number(v) || 0) + by)) * 100) / 100; }
  function speedLabel(r) { return r === 1 ? 'Normal' : String(r).replace(/^0\./, '0.') + '×'; }

  /**
   * The keys, the same on every service (The user's list): Space/K play-pause, J/L 10 s, the arrows
   * 5 s and the volume, M mute, F Lumen's fullscreen (Shift+F the whole screen), C captions,
   * Shift+< and Shift+> the speed. Ctrl/Alt/Meta combinations are never the bar's.
   */
  var KEYMAP = {
    ' ': { c: 'toggle' }, k: { c: 'toggle' },
    j: { c: 'skip', by: -10 }, l: { c: 'skip', by: 10 },
    ArrowLeft: { c: 'skip', by: -5 }, ArrowRight: { c: 'skip', by: 5 },
    ArrowUp: { c: 'vol', by: 0.05 }, ArrowDown: { c: 'vol', by: -0.05 },
    m: { c: 'mute' }, f: { c: 'fs' }, c: { c: 'cc' },
    '<': { c: 'speed', dir: -1 }, '>': { c: 'speed', dir: 1 }
  };
  var PAGE_KEYS = [' ', 'k', 'K', 'j', 'J', 'l', 'L', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'm', 'M', 'f', 'F', 'c', 'C', '<', '>'];
  function keyAction(key, shift, mods) {
    if (mods) return null;
    var k = String(key || '');
    if (k.length === 1 && k !== ' ') k = k.toLowerCase();
    if ((k === '<' || k === '>') && !shift) return null;
    if (k === 'f' && shift) return { c: 'whole' };
    var a = KEYMAP[k];
    return a ? Object.assign({}, a) : null;
  }

  var KIND = { captions: 'Captions', audio: 'Audio language', quality: 'Quality', speed: 'Speed' };
  /**
   * One menu's model from what the page reported. via: api (the service's player API), tracks (the
   * video's textTracks / audioTracks), button (YouTube's own CC button, pressed for him), own (the
   * service shares no list: the item opens ITS menu and says so), none (the service has no such menu).
   */
  function buildMenu(kind, m, svc, opt) {
    var o = opt || {};
    var title = KIND[kind] || kind;
    var low = title.toLowerCase();
    var out = { kind: kind, title: title, items: [], note: '', via: m ? m.via : 'none' };
    if (kind === 'speed') {
      var r = Number(o.rate) || 1;
      out.via = 'video';
      out.items = SPEEDS.map(function (s) { return { id: String(s), label: speedLabel(s), on: Math.abs(s - r) < 0.01 }; });
    } else if (!m || m.via === 'none') {
      out.note = (m && m.why) || (svc + ' has no ' + low + ' choice on its page.');
    } else if (m.via === 'own') {
      out.items = [{ id: '__own', label: 'Open ' + svc + '’s ' + low + ' menu', own: true }];
      out.note = svc + ' doesn’t share its ' + low + ' list with Lumen, so this opens ' + svc + '’s own menu.';
    } else {
      if (m.off) out.items.push({ id: 'off', label: 'Off', on: m.cur === 'off' || !m.cur });
      (m.items || []).forEach(function (it) { out.items.push({ id: String(it.id), label: String(it.label || it.id), on: String(it.id) === String(m.cur) }); });
      if (m.via === 'button') out.note = svc + ' hasn’t listed its tracks yet: this turns its captions on or off.';
      if (kind === 'quality' && m.now) out.note = 'Playing at ' + m.now + '.';
    }
    // The gear menu always ends with a way into the service's own controls: nothing its bar can do is lost.
    if (kind === 'quality' && o.ownMore) out.items.push({ id: '__more', label: svc + '’s own controls…', own: true, sep: true });
    return out;
  }
  /** C: captions off <-> on (the last track he had, else the first); with no list, the captions menu opens. */
  function captionsToggle(m, last) {
    if (!m || m.via === 'own' || m.via === 'none' || !(m.items && m.items.length)) return { open: true };
    if (m.cur && m.cur !== 'off') return { id: 'off' };
    var ids = m.items.map(function (i) { return String(i.id); });
    return { id: last && ids.indexOf(last) >= 0 ? last : ids[0] };
  }

  /** ms until the bar hides, or -1 while it must stay (paused, a menu open, the pointer on it, a drag). */
  function hideDelay(o) {
    if (o.paused || o.menu || o.hover || o.drag || o.own || o.ended) return -1;
    return Math.max(0, HIDE_MS - ((Number(o.now) || 0) - (Number(o.lastAct) || 0)));
  }

  var VERB = {
    toggle: 'play or pause', play: 'play', pause: 'pause', seek: 'seek', skip: 'skip', vol: 'change the volume', mute: 'mute',
    rate: 'change the speed', pick: 'change the track', own: 'open the service’s menu', next: 'go to the next episode', menus: 'read the menus'
  };
  /**
   * The fallback rules. novideo: the bridge found no <video> in FIND_MS. fail(): a user command that
   * failed (no answer in CMD_MS, or the page said no); FAILS in a row and the service's own bar is
   * back. A blocked seek (an ad) is not a failure. Every rule returns the one-line reason, or ''.
   */
  function Health(svc) {
    var fails = 0;
    var name = svc || 'The service';
    return {
      count: function () { return fails; },
      ok: function () { fails = 0; return ''; },
      fail: function (c, why) {
        fails++;
        if (fails < FAILS) return '';
        return 'Lumen’s play bar couldn’t ' + (VERB[c] || c) + ' twice in a row' + (why ? ' (' + String(why).slice(0, 80) + ')' : '') +
          ', so ' + name + '’s own bar is back.';
      },
      novideo: function (ms) {
        return 'Lumen’s play bar found no video on ' + name + '’s page in ' + Math.round((Number(ms) || FIND_MS) / 1000) + ' s, so ' + name + '’s own bar is back.';
      },
      broken: function (why) { return 'Lumen’s play bar couldn’t start on ' + name + '’s page (' + String(why || 'no answer').slice(0, 80) + '), so ' + name + '’s own bar stays.'; }
    };
  }

  function modeFrom(raw) { return raw === 'service' ? 'service' : 'lumen'; }
  /**
   * Multiview tiles get NO Lumen bar: a tile is a glance at one of up to four videos, multiview owns
   * the sound (one tile has it; M mutes all) and the keys (1-4, F, X, M), and four bars would fight
   * it and cover a quarter-size picture. The tile keeps its service's own compact bar; expand a tile
   * or go back to one video and Lumen's bar returns.
   */
  function tileRule(nSlots) { return nSlots > 1 ? 'none' : 'full'; }

  var PURE = {
    HIDE_MS: HIDE_MS, FIND_MS: FIND_MS, CMD_MS: CMD_MS, FAILS: FAILS, SPEEDS: SPEEDS, STORE: STORE, PAGE_KEYS: PAGE_KEYS,
    fmtTime: fmtTime, seekRange: seekRange, clampSeek: clampSeek, skipTarget: skipTarget, fracAt: fracAt, timeAt: timeAt, fracOf: fracOf,
    stepSpeed: stepSpeed, stepVol: stepVol, speedLabel: speedLabel, keyAction: keyAction, buildMenu: buildMenu, captionsToggle: captionsToggle,
    hideDelay: hideDelay, Health: Health, modeFrom: modeFrom, tileRule: tileRule
  };
  if (typeof document === 'undefined') return PURE;

  /* =============================================================== DOM */

  var Page = root.LumenPlayerBarPage;
  var CTX = null;
  var lastNote = '';
  var LOG = [];   // the last fallbacks and failures, for the e2e and for him in Settings

  function adapters() { return root.LumenPlayerBarAdapters || {}; }
  function adapterFor(svc) { return adapters()[svc] || null; }
  function getMode() { try { return modeFrom(root.localStorage.getItem(STORE)); } catch (e) { return 'lumen'; } }
  function slots() { return (CTX && CTX.L && CTX.L.slots) || []; }
  function isMulti() { return tileRule(slots().length) === 'none'; }
  function svcName(s) { var a = adapterFor(s.service); return (a && a.name) || 'The service'; }
  function say(text) { lastNote = text; if (CTX && CTX.note) CTX.note(text); }
  function remember(kind, text) { LOG.push({ at: Date.now(), kind: kind, text: text }); if (LOG.length > 20) LOG.shift(); }

  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var NS = 'http://www.w3.org/2000/svg';
  // Stroke icons on a 24 grid, the way Quartz draws its own.
  var ICONS = {
    play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M8 5.5v13M16 5.5v13" stroke-width="3"/>',
    back: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v3h3"/><text x="12" y="15.2" text-anchor="middle" font-size="7.4" font-weight="700" fill="currentColor" stroke="none">10</text>',
    fwd: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v3h-3"/><text x="12" y="15.2" text-anchor="middle" font-size="7.4" font-weight="700" fill="currentColor" stroke="none">10</text>',
    vol: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    mute: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    cc: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M16.5 10.2a2.2 2.2 0 1 0 0 3.6"/>',
    audio: '<path d="M5 6.5h9.5a2 2 0 0 1 2 2V14a2 2 0 0 1-2 2H10l-3.5 3v-3H5a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2z"/><path d="M19.5 9.5v6.5M17 11v3.5M7 11.2h5M7 13.4h3.5"/>',
    gear: '<path d="M5 7h9M18 7h1M5 12h3M12 12h7M5 17h7M16 17h3"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="14" cy="17" r="2"/>',
    fs: '<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/>',
    unfs: '<path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5"/>',
    whole: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5"/><path d="M9 19.5h6M12 16v3.5"/>',
    next: '<path d="M6.5 6v12l9-6z" fill="currentColor" stroke="none"/><path d="M18 6v12" stroke-width="2.4"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'
  };
  function icon(name) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'pb-ic');
    s.innerHTML = ICONS[name] || '';
    return s;
  }
  function setIcon(b, name) { var old = b.querySelector('svg'); var n = icon(name); if (old) b.replaceChild(n, old); else b.insertBefore(n, b.firstChild); }
  function button(cls, ic, label, fn) {
    var b = h('button', 'pb-btn ' + cls);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    if (ic) b.appendChild(icon(ic));
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(b, e); });
    return b;
  }

  /* ---------------------------------------------------------- the slot's bar */

  function make(s, a) {
    var P = {
      svc: a, name: a.name, view: null, on: false, ready: false, fell: '', st: null, menus: null, health: Health(a.name),
      lastAct: 0, hideT: 0, findT: 0, reasonT: 0, hover: false, drag: false, menu: null, fs: false, whole: false, own: '',
      idle: false, live: false, lastCap: '', cmds: 0, fails: 0, blocked: 0, injected: 0, multiOff: false
    };
    var bar = h('div', 'pb is-off');
    bar.setAttribute('data-svc', s.service);
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', a.name + ' controls, in Lumen');
    var panel = h('div', 'pb-panel');
    // seek
    var seek = h('div', 'pb-seek');
    seek.setAttribute('role', 'slider');
    seek.setAttribute('tabindex', '0');
    seek.setAttribute('aria-label', 'Seek');
    var track = h('div', 'pb-track');
    var buf = h('div', 'pb-buf'), done = h('div', 'pb-done'), hov = h('div', 'pb-hov');
    track.appendChild(buf); track.appendChild(hov); track.appendChild(done);
    var knob = h('div', 'pb-knob');
    var tip = h('div', 'pb-tip');
    seek.appendChild(track); seek.appendChild(knob); seek.appendChild(tip);
    // row
    var row = h('div', 'pb-row');
    var left = h('div', 'pb-left'), right = h('div', 'pb-right');
    var play = button('pb-play', 'play', 'Play (Space)', function () { user(s, { c: 'toggle' }); });
    var back = button('pb-back', 'back', 'Back 10 seconds (J)', function () { skip(s, -10); });
    var fwd = button('pb-fwd', 'fwd', 'Forward 10 seconds (L)', function () { skip(s, 10); });
    var mute = button('pb-mute', 'vol', 'Mute (M)', function () { toggleMute(s); });
    var vol = h('input', 'pb-vol');
    vol.type = 'range'; vol.min = '0'; vol.max = '100'; vol.step = '1'; vol.value = '100';
    vol.setAttribute('aria-label', 'Volume');
    vol.addEventListener('input', function () { user(s, { c: 'vol', v: Number(vol.value) / 100 }); paintVol(s, Number(vol.value) / 100, false); });
    var volWrap = h('div', 'pb-volwrap');
    volWrap.appendChild(mute); volWrap.appendChild(vol);
    var time = h('div', 'pb-time');
    var ad = h('div', 'pb-ad');
    ad.hidden = true;
    left.appendChild(play); left.appendChild(back); left.appendChild(fwd); left.appendChild(volWrap); left.appendChild(time); left.appendChild(ad);
    var next = button('pb-next', 'next', 'Next episode', function () { user(s, { c: 'next' }); });
    next.appendChild(h('span', 'pb-btn-text', 'Next episode'));
    next.hidden = true;
    var cc = button('pb-cc', 'cc', 'Captions (C)', function (b) { openMenu(s, 'captions', b); });
    var audio = button('pb-audio', 'audio', 'Audio language', function (b) { openMenu(s, 'audio', b); });
    var speed = button('pb-speed', '', 'Speed (Shift+< and Shift+>)', function (b) { openMenu(s, 'speed', b); });
    var speedTx = h('span', 'pb-btn-text pb-speed-text', '1×');
    speed.appendChild(speedTx);
    var quality = button('pb-quality', 'gear', 'Quality and more', function (b) { openMenu(s, 'quality', b); });
    var whole = button('pb-whole', 'whole', 'Whole screen (Shift+F)', function () { setWhole(s, !P.whole); });
    whole.hidden = true;
    var fs = button('pb-fs', 'fs', 'Fill the Lumen window (F)', function () { setFs(s, !P.fs); });
    [next, cc, audio, speed, quality, whole, fs].forEach(function (b) { right.appendChild(b); });
    row.appendChild(left); row.appendChild(right);
    panel.appendChild(seek); panel.appendChild(row);
    bar.appendChild(panel);
    // the menu, the own-menu pill, the fallback reason
    var menu = h('div', 'pb-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    var ownPill = h('div', 'pb-pill pb-ownpill');
    ownPill.hidden = true;
    var ownTx = h('span', 'pb-pill-text');
    var ownBack = h('button', 'pb-pill-btn', 'Back to Lumen’s bar');
    ownBack.type = 'button';
    ownBack.addEventListener('click', function (e) { e.stopPropagation(); ownOff(s); });
    ownPill.appendChild(ownTx); ownPill.appendChild(ownBack);
    var reason = h('div', 'pb-pill pb-reason');
    reason.hidden = true;
    reason.setAttribute('role', 'status');
    var reasonTx = h('span', 'pb-pill-text');
    var reasonX = button('pb-reason-x', 'close', 'Dismiss', function () { reason.hidden = true; });
    reason.appendChild(reasonTx); reason.appendChild(reasonX);

    P.el = { bar: bar, panel: panel, seek: seek, buf: buf, done: done, hov: hov, knob: knob, tip: tip, play: play, back: back, fwd: fwd, mute: mute, vol: vol,
      time: time, ad: ad, next: next, cc: cc, audio: audio, speed: speed, speedTx: speedTx, quality: quality, whole: whole, fs: fs, menu: menu,
      ownPill: ownPill, ownTx: ownTx, reason: reason, reasonTx: reasonTx };
    s._pb = P;
    s.tile.appendChild(bar);
    s.tile.appendChild(menu);
    s.tile.appendChild(ownPill);
    s.tile.appendChild(reason);

    bar.addEventListener('pointerenter', function () { P.hover = true; activity(s); });
    bar.addEventListener('pointerleave', function () { P.hover = false; activity(s); });
    bar.addEventListener('pointermove', function () { if (Date.now() - P.lastAct > 200) activity(s); });
    menu.addEventListener('pointerenter', function () { P.hover = true; });
    menu.addEventListener('pointerleave', function () { P.hover = false; activity(s); });
    wireSeek(s);
    return P;
  }

  function wireSeek(s) {
    var P = s._pb, E = P.el;
    function at(e) { var r = E.seek.getBoundingClientRect(); return fracAt(e.clientX, r.left, r.width); }
    function dur() { return P.st ? P.st.d : 0; }
    function sk() { return P.st ? P.st.sk : null; }
    function locked() { return !!(P.st && P.st.ad && P.st.ad.on); }
    E.seek.addEventListener('pointermove', function (e) {
      var f = at(e);
      E.hov.style.width = (f * 100) + '%';
      E.tip.textContent = locked() ? 'Seeking is off during the ad' : fmtTime(timeAt(f, dur(), sk()), dur());
      var w = E.seek.clientWidth, tw = E.tip.offsetWidth || 40;
      E.tip.style.left = Math.max(0, Math.min(w - tw, f * w - tw / 2)) + 'px';
      if (P.drag) paintSeek(s, f);
    });
    E.seek.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      if (locked()) { blockedSeek(s); return; }
      P.drag = true;
      try { E.seek.setPointerCapture(e.pointerId); } catch (err) { /* old pointer */ }
      E.seek.classList.add('is-drag');
      paintSeek(s, at(e));
    });
    function end(e) {
      if (!P.drag) return;
      P.drag = false;
      E.seek.classList.remove('is-drag');
      var to = clampSeek(timeAt(at(e), dur(), sk()), dur(), sk());
      user(s, { c: 'seek', to: to });
      activity(s);
    }
    E.seek.addEventListener('pointerup', end);
    E.seek.addEventListener('pointercancel', function () { P.drag = false; E.seek.classList.remove('is-drag'); });
    E.seek.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Home') user(s, { c: 'seek', to: seekRange(dur(), sk())[0] });
      else if (e.key === 'End') user(s, { c: 'seek', to: seekRange(dur(), sk())[1] });
      else skip(s, e.key === 'ArrowLeft' ? -5 : 5);
    });
  }

  /* ---------------------------------------------------------- talking to the page */

  function js(s, code) {
    var v = s.view;
    if (!v) return Promise.reject(new Error('the player is gone'));
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('no answer in ' + (CMD_MS / 1000) + ' s')); }, CMD_MS);
      try {
        v.executeJavaScript(code, false).then(function (r) { clearTimeout(t); resolve(r); }, function (e) { clearTimeout(t); reject(e); });
      } catch (e) { clearTimeout(t); reject(e); }
    });
  }
  /** A command he gave: counted for the fallback rule. */
  function user(s, c) {
    var P = s._pb;
    if (!P || !P.on) return Promise.resolve(null);
    if (P.own && c.c !== 'own') ownOff(s);
    P.cmds++;
    activity(s);
    return js(s, Page.command(c)).then(function (r) {
      if (r && r.ok) { P.health.ok(); if (r.st) take(s, r.st); return r; }
      if (r && r.blocked === 'ad') { blockedSeek(s); return r; }
      return failed(s, c.c, (r && r.why) || 'the page said no');
    }, function (e) { return failed(s, c.c, (e && e.message) || String(e)); });
  }
  function failed(s, c, why) {
    var P = s._pb;
    P.fails++;
    var r = P.health.fail(c, why);
    remember('fail', (VERB[c] || c) + ': ' + why);
    if (r) fallback(s, r);
    else say('Lumen’s play bar couldn’t ' + (VERB[c] || c) + ' (' + String(why).slice(0, 80) + ').');
    return null;
  }
  /** Background talk (live on/off, the cursor): never counted, never shown. */
  function quiet(s, c) { if (s._pb && s._pb.on) js(s, Page.command(c)).catch(function () { /* the next push says */ }); }

  function inject(s) {
    var P = s._pb;
    if (!P || P.fell || getMode() === 'service' || isMulti() || !Page) return;
    clearTimeout(P.findT);
    P.ready = false;
    P.injected++;
    // The bridge says "no video" itself at FIND_MS; this catches a page that never answers at all.
    P.findT = setTimeout(function () { if (!P.ready && !P.fell) fallback(s, P.health.novideo(FIND_MS)); }, FIND_MS + 1500);
    var code = Page.source({ find: FIND_MS, keys: PAGE_KEYS }, P.svc);
    js(s, code).then(function (r) {
      if (r && r.found && !P.ready) quiet(s, { c: 'rescan' });
    }, function (e) { if (!P.fell) fallback(s, P.health.broken((e && e.message) || e)); });
  }

  function onMsg(s, m) {
    var P = s._pb;
    if (!P || !m) return;
    switch (m.t) {
      case 'ready': case 'swap':
        clearTimeout(P.findT);
        if (P.fell || getMode() === 'service' || isMulti()) { quiet2(s, { c: 'off' }); return; }
        P.ready = true;
        if (m.st && m.st.menus) P.menus = m.st.menus;
        setOn(s, true);
        take(s, m.st);
        activity(s);
        break;
      case 'state': take(s, m.st); break;
      case 'rect': if (P.st) { P.st.rect = m.rect; place(s); } break;
      case 'act': activity(s); break;
      case 'key': key(s, m.k, m.s); break;
      case 'dbl': case 'fs': setFs(s, !P.fs); break;
      case 'novideo': clearTimeout(P.findT); if (!P.fell && getMode() !== 'service' && !isMulti()) fallback(s, P.health.novideo(m.ms)); break;
      case 'err': failed(s, m.c || 'play', m.why); break;
      default: break;
    }
  }
  function quiet2(s, c) { js(s, Page.command(c)).catch(function () { /* gone */ }); }

  function setOn(s, on) {
    var P = s._pb;
    P.on = !!on;
    P.el.bar.classList.toggle('is-off', !P.on);
    if (!P.on) { closeMenu(s); P.el.ownPill.hidden = true; if (P.fs) setFs(s, false); }
  }

  function fallback(s, reason) {
    var P = s._pb;
    if (!P) return;
    clearTimeout(P.findT);
    P.fell = reason;
    setOn(s, false);
    quiet2(s, { c: 'off' });
    remember('fallback', reason);
    say(reason);
    P.el.reasonTx.textContent = reason;
    P.el.reason.hidden = false;
    clearTimeout(P.reasonT);
    P.reasonT = setTimeout(function () { P.el.reason.hidden = true; }, 12000);
  }

  /* ---------------------------------------------------------- painting */

  function take(s, st) {
    var P = s._pb;
    if (!st) return;
    var was = P.st;
    P.st = st;
    if (st.menus) P.menus = st.menus;
    paint(s);
    if (!was || !was.rect || !st.rect || was.rect.x !== st.rect.x || was.rect.y !== st.rect.y || was.rect.w !== st.rect.w || was.rect.h !== st.rect.h) place(s);
    if (was && !!was.p !== !!st.p) activity(s);
    if (was && !!(was.ad && was.ad.on) !== !!(st.ad && st.ad.on)) { closeMenu(s); activity(s); }
    if (P.menu && P.menu.kind === 'speed') renderMenu(s);
  }
  function paintSeek(s, f) { var E = s._pb.el; E.done.style.width = (f * 100) + '%'; E.knob.style.left = (f * 100) + '%'; }
  function paintVol(s, v, m) {
    var E = s._pb.el;
    var shown = m ? 0 : v;
    E.vol.value = String(Math.round(shown * 100));
    E.vol.style.setProperty('--pb-v', (shown * 100) + '%');
    setIcon(E.mute, m || v === 0 ? 'mute' : 'vol');
    E.mute.setAttribute('aria-label', m ? 'Unmute (M)' : 'Mute (M)');
    E.mute.title = E.mute.getAttribute('aria-label');
  }
  function paint(s) {
    var P = s._pb, E = P.el, st = P.st;
    if (!st) return;
    var ad = st.ad && st.ad.on ? st.ad : null;
    E.bar.classList.toggle('is-ad', !!ad);
    E.bar.classList.toggle('is-paused', !!st.p);
    E.bar.classList.toggle('is-live', st.d === -1);
    setIcon(E.play, st.p ? 'play' : 'pause');
    E.play.setAttribute('aria-label', st.p ? 'Play (Space)' : 'Pause (Space)');
    E.play.title = E.play.getAttribute('aria-label');
    var f = fracOf(st.c, st.d, st.sk);
    if (!P.drag) paintSeek(s, f);
    E.buf.style.width = (st.d > 0 ? Math.min(1, st.b / st.d) * 100 : 0) + '%';
    E.seek.setAttribute('aria-valuemin', '0');
    E.seek.setAttribute('aria-valuemax', String(Math.round(st.d > 0 ? st.d : 0)));
    E.seek.setAttribute('aria-valuenow', String(Math.round(st.c)));
    E.seek.setAttribute('aria-valuetext', fmtTime(st.c, st.d) + ' of ' + (st.d > 0 ? fmtTime(st.d) : 'live'));
    E.seek.setAttribute('aria-disabled', ad ? 'true' : 'false');
    E.time.textContent = st.d === -1 ? (st.sk && st.sk[1] - st.c > 15 ? 'Live −' + fmtTime(st.sk[1] - st.c) : 'Live')
      : fmtTime(st.c, st.d) + ' / ' + fmtTime(st.d > 0 ? st.d : 0, st.d);
    E.ad.hidden = !ad;
    if (ad) E.ad.textContent = 'Ad' + (ad.left != null ? ' · ' + fmtTime(ad.left) : '') + (ad.text && /\d of \d/.test(ad.text) ? ' · ' + ad.text.match(/\d+ of \d+/)[0] : '');
    paintVol(s, st.vol, st.m);
    E.speedTx.textContent = String(st.r).replace(/^0\./, '.') + '×';
    E.next.hidden = !st.next || !!ad;
    E.whole.hidden = !P.fs;
    setIcon(E.fs, P.fs ? 'unfs' : 'fs');
    E.fs.setAttribute('aria-label', P.fs ? 'Leave Lumen’s full window (F)' : 'Fill the Lumen window (F)');
    E.fs.title = E.fs.getAttribute('aria-label');
    var m = P.menus || {};
    E.cc.classList.toggle('is-on', !!(m.captions && m.captions.cur && m.captions.cur !== 'off' && m.captions.via !== 'own'));
    E.audio.hidden = !m.audio || (m.audio.via === 'none');
  }

  /** The bar over the bottom of the video's own box (the page reports it), in the tile's pixels. */
  function place(s) {
    var P = s._pb, st = P.st;
    if (!st || !st.rect || !s.view) return;
    var r = st.rect, vw = s.view.clientWidth || 0, vh = s.view.clientHeight || 0;
    var k = r.vw > 0 && vw > 0 ? vw / r.vw : 1;
    var x = Math.max(0, r.x * k), w = Math.min(vw - x, (r.x + r.w) * k - x);
    var bottom = Math.min(vh, (r.y + r.h) * k);
    var top = Math.max(0, r.y * k);
    var bar = P.el.bar;
    var gone = w < 160 || bottom - top < 90;
    bar.classList.toggle('is-gone', gone);
    if (gone) return;
    bar.style.left = Math.round(x) + 'px';
    bar.style.width = Math.round(w) + 'px';
    bar.style.bottom = Math.round(vh - bottom) + 'px';
    bar.classList.toggle('is-compact', w < 620);
    bar.classList.toggle('is-tiny', w < 400);
    if (P.menu) placeMenu(s);
  }

  /* ---------------------------------------------------------- showing and hiding */

  function activity(s) {
    var P = s._pb;
    if (!P || !P.on) return;
    P.lastAct = Date.now();
    show(s, true);
    schedule(s);
  }
  function schedule(s) {
    var P = s._pb;
    clearTimeout(P.hideT);
    var d = hideDelay({ now: Date.now(), lastAct: P.lastAct, paused: P.st && P.st.p, ended: P.st && P.st.e, menu: !!P.menu, hover: P.hover, drag: P.drag, own: !!P.own });
    if (d < 0) return;
    P.hideT = setTimeout(function () {
      var again = hideDelay({ now: Date.now(), lastAct: P.lastAct, paused: P.st && P.st.p, ended: P.st && P.st.e, menu: !!P.menu, hover: P.hover, drag: P.drag, own: !!P.own });
      if (again === 0) show(s, false); else if (again > 0) schedule(s);
    }, d + 20);
  }
  function show(s, on) {
    var P = s._pb;
    if (P.idle === !on) return;
    P.idle = !on;
    P.el.bar.classList.toggle('is-idle', !on);
    // The time ticks only while it is on screen; the cursor hides with the bar (playing only).
    quiet(s, { c: 'live', on: !!on });
    quiet(s, { c: 'idle', on: !on });
  }

  /* ---------------------------------------------------------- actions */

  function skip(s, by) {
    var P = s._pb;
    if (P.st && P.st.ad && P.st.ad.on) { blockedSeek(s); return; }
    if (P.st) { var to = skipTarget(P.st.c, by, P.st.d, P.st.sk); paintSeek(s, fracOf(to, P.st.d, P.st.sk)); }
    user(s, { c: 'skip', by: by });
  }
  function blockedSeek(s) { s._pb.blocked++; say('Seeking is off while the ad plays: ' + svcName(s) + '’s Skip button works when it shows.'); }
  function toggleMute(s) { var st = s._pb.st; user(s, { c: 'mute', on: !(st && st.m) }); }
  function key(s, k, shift) {
    var P = s._pb;
    if (!P || !P.on) return false;
    var a = keyAction(k, shift, false);
    if (!a) return false;
    activity(s);
    var st = P.st || {};
    switch (a.c) {
      case 'toggle': user(s, { c: 'toggle' }); break;
      case 'skip': skip(s, a.by); break;
      case 'vol': user(s, { c: 'vol', v: stepVol(st.m ? 0 : st.vol, a.by) }); break;
      case 'mute': toggleMute(s); break;
      case 'fs': setFs(s, !P.fs); break;
      case 'whole': setWhole(s, !P.whole); break;
      case 'speed': user(s, { c: 'rate', r: stepSpeed(st.r || 1, a.dir) }).then(function () { say('Speed ' + speedLabel(P.st ? P.st.r : 1)); }); break;
      case 'cc': {
        var m = P.menus && P.menus.captions;
        var t = captionsToggle(m, P.lastCap);
        if (t.open) openMenu(s, 'captions', P.el.cc);
        else pickItem(s, 'captions', t.id);
        break;
      }
      default: return false;
    }
    return true;
  }

  function setFs(s, on) {
    var P = s._pb;
    if (!P || !CTX) return;
    if (!on && P.whole) setWhole(s, false);
    P.fs = !!on && P.on;
    var L = CTX.L;
    if (L && L.el) {
      L.el.classList.toggle('wp-fs', P.fs || !!L.fsSlot);
      L.el.classList.toggle('pb-lumenfs', P.fs);
    }
    s.tile.classList.toggle('is-fs', P.fs || s.fs);
    paint(s);
    activity(s);
  }
  /** The second action: the whole screen. Only ever on his ask (Shift+F, or the button in Lumen's full window). */
  function setWhole(s, on) {
    var P = s._pb;
    if (on && !P.fs) setFs(s, true);
    P.whole = !!on;
    try { if (typeof root.setPageFullscreen === 'function') root.setPageFullscreen(P.whole); } catch (e) { /* app.js gone */ }
    paint(s);
  }

  /* ---------------------------------------------------------- menus */

  function openMenu(s, kind, anchor) {
    var P = s._pb;
    if (P.menu && P.menu.kind === kind) { closeMenu(s); return; }
    P.menu = { kind: kind, anchor: anchor };
    renderMenu(s);
    P.el.menu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    placeMenu(s);
    activity(s);
    // Fresh lists each time (YouTube lists its captions once the module has loaded).
    if (kind !== 'speed') {
      js(s, Page.command({ c: 'menus' })).then(function (r) {
        if (r && r.ok && r.menus) { P.menus = r.menus; if (P.menu && P.menu.kind === kind) { renderMenu(s); placeMenu(s); } paint(s); }
      }, function () { /* the menu shows what it had */ });
    }
  }
  function closeMenu(s) {
    var P = s._pb;
    if (!P || !P.menu) return false;
    if (P.menu.anchor) P.menu.anchor.setAttribute('aria-expanded', 'false');
    P.menu = null;
    P.el.menu.hidden = true;
    schedule(s);
    return true;
  }
  function menuModel(s, kind) {
    var P = s._pb;
    var m = P.menus || {};
    var hasMore = !!(P.svc.own && P.svc.own.more);
    return buildMenu(kind, kind === 'speed' ? null : m[kind], P.name, { rate: P.st ? P.st.r : 1, ownMore: hasMore || true });
  }
  function renderMenu(s) {
    var P = s._pb, box = P.el.menu;
    if (!P.menu) return;
    var model = menuModel(s, P.menu.kind);
    P.menu.model = model;
    box.replaceChildren();
    box.setAttribute('data-kind', model.kind);
    box.setAttribute('aria-label', model.title);
    box.appendChild(h('div', 'pb-menu-title', model.title));
    var list = h('div', 'pb-menu-list');
    model.items.forEach(function (it) {
      var b = h('button', 'pb-item' + (it.on ? ' is-on' : '') + (it.own ? ' is-own' : '') + (it.sep ? ' has-sep' : ''));
      b.type = 'button';
      b.setAttribute('role', it.own ? 'menuitem' : 'menuitemradio');
      if (!it.own) b.setAttribute('aria-checked', it.on ? 'true' : 'false');
      b.setAttribute('data-id', it.id);
      var c = h('span', 'pb-item-check');
      if (it.on) c.appendChild(icon('check'));
      b.appendChild(c);
      b.appendChild(h('span', 'pb-item-label', it.label));
      b.addEventListener('click', function (e) { e.stopPropagation(); pickItem(s, model.kind, it.id); });
      list.appendChild(b);
    });
    box.appendChild(list);
    if (model.note) box.appendChild(h('p', 'pb-menu-note', model.note));
  }
  function placeMenu(s) {
    var P = s._pb, E = P.el;
    if (!P.menu) return;
    var tile = s.tile, tw = tile.clientWidth, th = tile.clientHeight;
    var bl = E.bar.offsetLeft, bw = E.bar.offsetWidth, bt = E.bar.offsetTop;
    var a = P.menu.anchor, ar = a.getBoundingClientRect(), tr = tile.getBoundingClientRect();
    var mw = Math.min(300, Math.max(220, bw - 24));
    var right = Math.max(8, Math.min(tw - mw - 8, tw - (ar.right - tr.left) - 4));
    E.menu.style.width = mw + 'px';
    E.menu.style.right = Math.round(Math.max(8, Math.min(right, tw - (bl + bw) + 8 + (bw - mw - 16)))) + 'px';
    E.menu.style.bottom = Math.round(th - bt + 6) + 'px';
    E.menu.style.maxHeight = Math.max(120, bt - 14) + 'px';
  }
  function pickItem(s, kind, id) {
    var P = s._pb;
    if (id === '__own' || id === '__more') { openOwn(s, id === '__more' ? 'more' : kind); return; }
    if (kind === 'speed') { user(s, { c: 'rate', r: Number(id) }).then(function () { if (P.menu) renderMenu(s); }); closeMenu(s); return; }
    if (kind === 'captions' && id !== 'off') P.lastCap = id;
    user(s, { c: 'pick', kind: kind, id: id }).then(function (r) {
      if (r && r.menus) P.menus = r.menus;
      paint(s);
      var it = (menuModel(s, kind).items || []).filter(function (x) { return x.id === id; })[0];
      if (r) say(KIND[kind] + ': ' + (it ? it.label : id));
    });
    closeMenu(s);
  }
  /** The service's own menu, for this moment: its bar is unhidden, its button pressed, and the bar says so. */
  function openOwn(s, kind) {
    var P = s._pb;
    closeMenu(s);
    user(s, { c: 'own', kind: kind }).then(function (r) {
      if (!r || !r.ok) return;
      var what = kind === 'more' ? 'controls' : (KIND[kind] || kind).toLowerCase() + ' menu';
      P.own = kind;
      P.el.ownTx.textContent = r.opened ? P.name + '’s own ' + what + ' is open.' : P.name + '’s own bar is showing; its ' + what + ' is there.';
      P.el.ownPill.hidden = false;
      P.el.bar.classList.add('is-own');
      say(P.el.ownTx.textContent);
      schedule(s);
    });
  }
  function ownOff(s) {
    var P = s._pb;
    if (!P.own) return;
    P.own = '';
    P.el.ownPill.hidden = true;
    P.el.bar.classList.remove('is-own');
    quiet(s, { c: 'ownoff' });
    activity(s);
  }

  /* ---------------------------------------------------------- the layer's hooks (watch-player.js X()) */

  function attach(ctx, s, v) {
    CTX = ctx;
    var a = adapterFor(s.service);
    if (!a || !Page) return;
    var P = s._pb || make(s, a);
    P.view = v;
    P.fell = '';
    v.addEventListener('dom-ready', function () {
      if (s.view !== v) return;
      P.st = null; P.ready = false; P.own = '';
      setOn(s, false);
      inject(s);
    });
    v.addEventListener('did-navigate', function () {
      if (s.view !== v) return;
      // A new page: a fallback was about the old one.
      P.fell = ''; P.health.ok(); P.el.reason.hidden = true;
    });
    v.addEventListener('did-navigate-in-page', function (e) {
      if (s.view !== v || !e.isMainFrame || !P.ready) return;
      setTimeout(function () { quiet(s, { c: 'rescan' }); }, 300);
    });
    v.addEventListener('console-message', function (e) {
      var msg = e && typeof e.message === 'string' ? e.message : '';
      if (s.view !== v || msg.indexOf(Page.TAG) !== 0) return;
      var m = null;
      try { m = JSON.parse(msg.slice(Page.TAG.length)); } catch (err) { m = null; }
      if (m && typeof m === 'object') onMsg(s, m);
    });
    v.addEventListener('focus', function () { if (s.view === v) activity(s); });
    sync(ctx);
  }
  function destroy(ctx, s) {
    var P = s._pb;
    if (!P) return;
    if (P.fs) setFs(s, false);
    clearTimeout(P.hideT); clearTimeout(P.findT); clearTimeout(P.reasonT);
    ['bar', 'menu', 'ownPill', 'reason'].forEach(function (k) { var e = P.el[k]; if (e && e.parentNode) e.parentNode.removeChild(e); });
    s._pb = null;
  }
  /** Called on every bar sync (focus moves, tiles come and go): one video = Lumen's bar; tiles = none. */
  function sync(ctx) {
    if (ctx) CTX = ctx;
    var multi = isMulti(), mode = getMode();
    slots().forEach(function (s) {
      var P = s._pb;
      if (!P) return;
      var want = !multi && mode === 'lumen' && !P.fell;
      if (want && !P.on && P.multiOff) { P.multiOff = false; if (P.ready) { quiet2(s, { c: 'on' }); setOn(s, true); activity(s); } else inject(s); }
      else if (want && !P.on && !P.ready && P.injected === 0 && s.view) inject(s);
      else if (!want && P.on) { P.multiOff = multi; setOn(s, false); quiet2(s, { c: 'off' }); }
    });
  }
  /** watch-player.js takeShortcut: Esc closes a menu, then the service's own menu, then Lumen's full window. */
  function shortcut(id) {
    var s = CTX && CTX.focused && CTX.focused();
    var P = s && s._pb;
    if (!P || !P.on) return false;
    if (id === 'escape') {
      if (closeMenu(s)) return true;
      if (P.own) { ownOff(s); return true; }
      if (P.fs) { setFs(s, false); return true; }
    }
    return false;
  }
  /** Keys pressed with the focus in Lumen's own chrome (a bar button, the layer): the same map. */
  function onChromeKey(e) {
    if (!CTX || !CTX.L || !CTX.L.open || e.ctrlKey || e.altKey || e.metaKey) return;
    var s = CTX.focused && CTX.focused();
    var P = s && s._pb;
    if (!P || !P.on) return;
    var t = e.target;
    var inLayer = CTX.L.el && t && CTX.L.el.contains(t);
    if (!inLayer && t !== document.body) return;
    if (t && t.tagName === 'WEBVIEW') return;      // the page's own bridge has it
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !(t.classList && t.classList.contains('pb-vol'))) return;
    if (t && t.classList && t.classList.contains('pb-vol') && /^Arrow/.test(e.key)) return;
    if ((e.key === ' ' || e.key === 'Enter') && t && t.tagName === 'BUTTON') return;
    if (!keyAction(e.key, e.shiftKey, false)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && !/^Arrow/.test(e.key)) return;
    key(s, e.key, e.shiftKey);
  }
  document.addEventListener('keydown', onChromeKey, true);

  /** Settings > Lumen: "Play bar: Lumen (default) / The service's own". */
  function renderSetting(field, u) {
    var mode = getMode();
    field.replaceChildren();
    var row = u.el('div', 'set-row set-row-static pb-set-row');
    row.appendChild(u.el('span', 'set-row-label', 'Play bar'));
    row.appendChild(u.segmented([{ id: 'lumen', name: 'Lumen' }, { id: 'service', name: 'The service’s own' }], mode, function (id) {
      try { root.localStorage.setItem(STORE, id); } catch (e) { /* storage blocked: holds for this run */ }
      applyMode();
      renderSetting(field, u);
    }));
    field.appendChild(row);
    field.appendChild(u.el('p', 'set-hint', mode === 'lumen'
      ? 'One play bar on every service: play, seek, ±10 s, volume, speed, captions, audio, quality and Lumen’s full window. If it can’t find the video or a control fails twice, the service’s own bar comes back and says why.'
      : 'Each service shows its own play bar, as on its site.'));
    var last = LOG.filter(function (x) { return x.kind === 'fallback'; }).slice(-1)[0];
    if (last) field.appendChild(u.el('p', 'set-hint', 'Last fallback: ' + last.text));
  }
  function applyMode() {
    var mode = getMode();
    slots().forEach(function (s) {
      var P = s._pb;
      if (!P) return;
      if (mode === 'service' && P.on) { setOn(s, false); quiet2(s, { c: 'off' }); }
    });
    if (mode === 'lumen') slots().forEach(function (s) { var P = s._pb; if (P && !P.on && !P.fell && s.view) { if (P.ready) { quiet2(s, { c: 'on' }); setOn(s, true); activity(s); } else inject(s); } });
  }

  /** The e2e's view. */
  function _state() {
    return {
      mode: getMode(), note: lastNote, log: LOG.slice(-5),
      slots: slots().map(function (s) {
        var P = s._pb;
        if (!P) return { svc: s.service, none: true };
        var b = P.el.bar.getBoundingClientRect();
        return {
          svc: s.service, on: P.on, ready: P.ready, fell: P.fell, idle: P.idle, fs: P.fs, whole: P.whole, own: P.own, menu: P.menu ? { kind: P.menu.kind, model: P.menu.model } : null,
          st: P.st ? { p: P.st.p, c: P.st.c, d: P.st.d, vol: P.st.vol, m: P.st.m, r: P.st.r, ad: P.st.ad, next: P.st.next } : null,
          menus: P.menus, cmds: P.cmds, fails: P.fails, blocked: P.blocked, injected: P.injected, multiOff: P.multiOff,
          bar: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) },
          reason: P.el.reason.hidden ? '' : P.el.reasonTx.textContent
        };
      })
    };
  }

  return Object.assign({}, PURE, {
    attach: attach, destroy: destroy, sync: sync, shortcut: shortcut, renderSetting: renderSetting, applyMode: applyMode,
    _state: _state, _key: function (k, shift) { var s = CTX && CTX.focused(); return s ? key(s, k, shift) : false; }
  });
});
