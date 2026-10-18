/* ============================================================
   watch-player-multi.js -- multiview and the mini-player, inside
   the Lumen player layer (chrome side).

   watch-player.js calls in at a few points (MV: build, bar, slot,
   view, attach, destroy, open, layout, place, shortcut, key, close,
   state); with this file missing the layer is the single player.

   Multiview: up to four tiles at once, game nights mostly.
   - Layouts: 2 side by side, 3 = one big and two small, 4 = 2x2.
     Expand (F) puts a tile in the big slot (2 and 4 get a big-slot
     layout too; F on the big tile goes back to the even grid).
     Swap trades two tiles' places; Remove (X) closes one.
   - The sound comes from ONE tile: a click into a tile, its header,
     or 1-4 moves it. M mutes them all. The tile with the sound has
     a thin outline and a speaker in its header.
   - Esc leaves multiview: the tile with the sound stays as the
     single player (Esc again closes it, as always).
   - YouTube tiles play the embed (the video only, no page around
     it); a refused embed falls back to the watch page in the tile.
     The protected services play their own player page in the tile.
   - A service that refuses another stream ("too many devices")
     says so in its own page; the tile's header repeats that exact
     sentence. Lumen never retries or works around it.
   - The RAM guard: before a tile is added, main says how much RAM
     is free; under the floor (1.5 GB) the tile is refused, in words.
   - CPU: a YouTube tile without the sound is asked for 360p (its
     player's own quality setting); the others size to the tile.

   Mini-player: the layer shrinks into a corner of the Lumen tab and
   keeps playing while he browses the rows. Drag it to any corner, a
   click restores it, X closes it. The bar's "Add to multiview" uses
   it too: the player waits in the corner until he picks a title.

   Keys reach here from the layer's own DOM and, from inside a tile,
   through main (watch-player-main.js before-input-event, grid mode).
   ============================================================ */
(function () {
  'use strict';
  var H = window.WatchPlayerHosts;
  var MAX = 4;
  var HEAD_H = 30;                 // a tile's header (multiview) and the mini-player's
  var MINI_W = 400, MINI_W_GRID = 500, MINI_GAP = 16;
  var EMBED_REFERER = 'https://github.com/Owen-Silva/quartz';   // the identity watch/preview.js sends with YouTube's embed
  var LIMIT_TAG = '__lumen:limit ';
  var LIMIT_WATCH_MS = 120000;     // how long after a page loads its text is watched for a stream-limit message
  var EMBED_CHECKS = [2500, 7000];
  var QUALITY_TRIES = [1500, 4000, 9000];
  var LOW_Q = 'medium';            // 360p: a YouTube tile without the sound

  var M = {
    spot: false,          // 2 or 4 tiles: one in the big slot
    muteAll: false,
    mini: false, pick: false, corner: 'br', drag: null,
    swapFrom: null,
    refusal: null,        // the last tile that was not added: { text, at }
    lastAdd: null,
    els: null
  };
  var CTX = null;

  /* --------------------------------------------------------------- helpers */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function iconBtn(cls, glyph, label, fn) {
    var b = el('button', 'mv-ib ' + cls);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.appendChild(el('span', 'mv-glyph', glyph));
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(b, e); });
    return b;
  }
  function L() { return CTX && CTX.L; }
  function slots() { var l = L(); return l ? l.slots : []; }
  function isMulti() { return slots().length > 1; }
  function svcName(id) { return (CTX && CTX.svcName(id)) || 'The service'; }
  function svcMark(id) { var s = H && H.SERVICES[id]; return s ? s.mark : ''; }
  function nameOf(s) { return s.title || (s._mv && s._mv.pageTitle) || svcName(s.service); }
  function say(text, err) {
    if (!CTX) return;
    CTX.note(text);
    if (err) CTX.toast(text, true);
  }
  function js(v, code) {
    try { var p = v.executeJavaScript(code, false); if (p && p.then) return p.then(null, function () { return null; }); } catch (e) { /* not attached yet */ }
    return Promise.resolve(null);
  }
  function timer(s, fn, ms) {
    var t = setTimeout(function () { var i = s._mv.timers.indexOf(t); if (i >= 0) s._mv.timers.splice(i, 1); fn(); }, ms);
    s._mv.timers.push(t);
  }
  function clearTimers(s) { for (var i = 0; i < s._mv.timers.length; i++) clearTimeout(s._mv.timers[i]); s._mv.timers = []; }

  /** A YouTube video address -> its embed (same origin, so a test's local front serves it too), or ''. */
  function embedFor(url) {
    var x;
    try { x = new URL(url); } catch (e) { return ''; }
    var id = '';
    var short = /(^|\.)youtu\.be$/i.test(x.hostname);
    if (short) id = x.pathname.slice(1).split('/')[0];
    else if (x.pathname === '/watch') id = x.searchParams.get('v') || '';
    else { var m = /^\/(?:live|embed)\/([^/?#]+)/.exec(x.pathname); if (m) id = m[1]; }
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return '';
    var start = H && H.seconds ? H.seconds(x.searchParams.get('t') || x.searchParams.get('start') || '') : 0;
    var origin = short || /^(m|music)\.youtube\.com$/i.test(x.hostname) ? 'https://www.youtube.com' : x.origin;
    return origin + '/embed/' + id + '?autoplay=1&playsinline=1&rel=0' + (start > 0 ? '&start=' + start : '');
  }
  function withStart(embed, sec) {
    var u = embed.replace(/&start=\d+/, '');
    return sec > 0 ? u + '&start=' + Math.floor(sec) : u;
  }

  /* --------------------------------------------------------------- page scripts */

  // Runs in a tile's page: watches its own rendered text (for two minutes after a load, and again
  // after a video error) for a stream-limit message, and reports that sentence once. Read-only.
  var LIMIT_JS = '(function () {' +
    ' if (window.__lumenLimit) return 1; window.__lumenLimit = 1;' +
    ' var RE = /(too many (people|devices|screens|streams|users)|stream(ing)? limit|maximum number of (devices|screens|streams)|(devices|screens|streams) at (the same|one) time|concurrent stream)/i;' +
    ' var log = console.log.bind(console), done = false, t = 0, until = Date.now() + ' + LIMIT_WATCH_MS + ';' +
    ' function find() { t = 0; if (done || !document.body) return; var txt = document.body.innerText || ""; var m = RE.exec(txt); if (!m) return;' +
    '   var a = txt.lastIndexOf("\\n", m.index) + 1, b = txt.indexOf("\\n", m.index); if (b < 0) b = txt.length;' +
    '   done = true; try { obs.disconnect(); } catch (e) {}' +
    '   try { log(' + JSON.stringify(LIMIT_TAG) + ' + JSON.stringify({ text: txt.slice(a, b).replace(/\\s+/g, " ").trim().slice(0, 220) })); } catch (e) {} }' +
    ' var obs = new MutationObserver(function () { if (done) return; if (Date.now() > until) { obs.disconnect(); return; } if (!t) t = setTimeout(find, 1200); });' +
    ' obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });' +
    ' document.addEventListener("error", function (e) { if (done || !e.target || e.target.tagName !== "VIDEO") return; until = Date.now() + 30000; try { obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (err) {} if (!t) t = setTimeout(find, 800); }, true);' +
    ' find(); return 1; })()';

  // YouTube's embed: "error:<its words>" when it shows its own error panel, else playing/paused/none.
  var EMBED_CHECK_JS = '(function () { var e = document.querySelector(".ytp-error"); if (e && e.offsetParent !== null) return "error:" + (e.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 160);' +
    ' var v = document.querySelector("video"); return v ? (v.paused ? "paused" : "playing") : "none"; })()';

  function qualityJs(q) {
    return '(function (q) { var p = document.getElementById("movie_player"); if (!p || typeof p.setPlaybackQualityRange !== "function") return "none";' +
      ' try { p.setPlaybackQualityRange(q, q); return "set:" + q; } catch (e) { return "error"; } })(' + JSON.stringify(q) + ')';
  }

  var TIME_JS = '(function () { var v = document.querySelector("video"); return v && isFinite(v.currentTime) ? Math.floor(v.currentTime) : 0; })()';

  /* --------------------------------------------------------------- the layer's pieces */

  function onBuild(ctx, layer) {
    CTX = ctx;
    var head = el('div', 'mv-mini-head');
    var mark = el('span', 'wp-mark mv-mini-mark');
    var title = el('span', 'mv-mini-title');
    var grow = el('span', 'wp-grow');
    var cancel = el('button', 'wp-btn mv-mini-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', function (e) { e.stopPropagation(); cancelPick(); });
    var restore = iconBtn('mv-mini-restore', '', 'Restore the player', function () { exitMini(); });
    var x = iconBtn('mv-mini-close', '', 'Close the player', function () { CTX.close('Close'); });
    head.appendChild(mark); head.appendChild(title); head.appendChild(grow); head.appendChild(cancel); head.appendChild(restore); head.appendChild(x);
    var hit = el('div', 'mv-mini-hit');
    hit.setAttribute('role', 'button');
    hit.setAttribute('aria-label', 'Restore the player (drag to move it)');
    hit.appendChild(el('span', 'mv-glyph mv-mini-hint', ''));
    layer.appendChild(head);
    layer.appendChild(hit);
    M.els = { head: head, mark: mark, title: title, cancel: cancel, hit: hit, add: M.els && M.els.add, minib: M.els && M.els.minib };
    wireDrag(head);
    wireDrag(hit);
    layer.addEventListener('keydown', function (e) {
      if (!isMulti() || M.mini || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      var k = String(e.key || '').toLowerCase();
      if (/^[1-4]$/.test(k) || k === 'f' || k === 'x' || k === 'm') { e.preventDefault(); doKey(k, null); }
    });
  }

  function onBar(ctx, bar) {
    CTX = ctx;
    var add = el('button', 'wp-btn mv-add');
    add.type = 'button';
    add.appendChild(el('span', 'mv-glyph', ''));
    add.appendChild(document.createTextNode('Add to multiview'));
    add.title = 'Watch another title alongside this one (up to four)';
    add.addEventListener('click', function (e) { e.stopPropagation(); startPick(); });
    var minib = iconBtn('mv-minibtn', '', 'Mini player: keep it playing in a corner while you browse', function () { enterMini(false); });
    bar.appendChild(add);
    bar.appendChild(minib);
    M.els = Object.assign(M.els || {}, { add: add, minib: minib });
  }

  /* --------------------------------------------------------------- tiles */

  function onSlot(ctx, s, o) {
    CTX = ctx;
    var x = o || {};
    s._mv = { embed: x.embed || '', watchUrl: x.watchUrl || '', limit: '', muted: false, q: '', pageTitle: '', timers: [], limitIn: false, converted: !!x.embed, check: '' };
    var head = el('div', 'mv-head');
    var num = el('span', 'mv-num', '');
    var mark = el('span', 'wp-mark mv-mark');
    var name = el('span', 'mv-name');
    var limit = el('span', 'mv-limit');
    limit.setAttribute('role', 'status');
    var sound = el('button', 'mv-sound');
    sound.type = 'button';
    sound.appendChild(el('span', 'mv-glyph', ''));
    sound.appendChild(el('span', 'mv-sound-txt', 'Sound'));
    sound.addEventListener('click', function (e) { e.stopPropagation(); select(s, true); });
    var expand = iconBtn('mv-expand', '', 'Expand to the big tile (F)', function () { expandSlot(s); });
    var swap = iconBtn('mv-swap', '', 'Swap places with another tile', function () { startSwap(s); });
    var remove = iconBtn('mv-remove', '', 'Remove this tile (X)', function () { removeSlot(s, 'Remove'); });
    head.appendChild(num); head.appendChild(mark); head.appendChild(name); head.appendChild(limit);
    head.appendChild(el('span', 'wp-grow'));
    head.appendChild(sound); head.appendChild(expand); head.appendChild(swap); head.appendChild(remove);
    head.addEventListener('click', function () { if (isMulti()) select(s, true); });
    var target = el('div', 'mv-swap-target');
    target.hidden = true;
    var tb = el('button', 'wp-btn wp-primary mv-swap-here', 'Swap here');
    tb.type = 'button';
    tb.addEventListener('click', function (e) { e.stopPropagation(); finishSwap(s); });
    target.appendChild(tb);
    s.tile.insertBefore(head, s.tile.firstChild);
    s.tile.appendChild(target);
    s._mv.els = { head: head, num: num, mark: mark, name: name, limit: limit, sound: sound, target: target };
    paintHead(s);
  }

  function onView(ctx, s, v) {
    if (s._mv && s._mv.embed) v.setAttribute('httpreferrer', EMBED_REFERER);
  }

  function onAttach(ctx, s, v) {
    CTX = ctx;
    v.addEventListener('dom-ready', function () {
      if (s.view !== v) return;
      applyAudio();
      if (isMulti()) { armPage(s); if (!s._mv.converted) toEmbed(s); }
    });
    v.addEventListener('did-start-loading', function () { if (s.view === v) s._mv.limitIn = false; });
    v.addEventListener('did-finish-load', function () {
      if (s.view !== v || !isMulti()) return;
      if (s._mv.embed) for (var i = 0; i < EMBED_CHECKS.length; i++) timer(s, function () { checkEmbed(s); }, EMBED_CHECKS[i]);
      armQuality(s);
    });
    v.addEventListener('page-title-updated', function (e) { if (s.view === v) { s._mv.pageTitle = String(e.title || '').slice(0, 160); paintHead(s); } });
    v.addEventListener('console-message', function (e) {
      var msg = e && typeof e.message === 'string' ? e.message : '';
      if (s.view !== v || msg.indexOf(LIMIT_TAG) !== 0) return;
      var m = null;
      try { m = JSON.parse(msg.slice(LIMIT_TAG.length)); } catch (err) { m = null; }
      if (m && typeof m.text === 'string' && m.text) onLimit(s, m.text.slice(0, 220));
    });
    // A click into the tile's page focuses its <webview>: the sound follows (main says so too).
    v.addEventListener('focus', function () { if (s.view === v && isMulti() && !M.mini) select(s, false); });
  }

  function onDestroy(ctx, s) {
    if (!s._mv) return;
    clearTimers(s);
    if (M.swapFrom === s) endSwap();
  }

  /** The page's own script: the stream-limit watch (multiview only). */
  function armPage(s) {
    if (!s.view || s._mv.limitIn || s.wcId === null) return;   // before dom-ready: the dom-ready handler arms it
    s._mv.limitIn = true;
    js(s.view, LIMIT_JS);
  }

  function onLimit(s, text) {
    if (s._mv.limit === text) return;
    s._mv.limit = text;
    paintHead(s);
    // His account's own limit: said, never worked around (no retry, no reload).
    say(svcName(s.service) + ' refused another stream: ' + text);
  }

  function checkEmbed(s) {
    if (!s.view || !s._mv.embed) return;
    js(s.view, EMBED_CHECK_JS).then(function (r) {
      s._mv.check = typeof r === 'string' ? r : '';
      if (typeof r !== 'string' || r.indexOf('error:') !== 0 || !s._mv.embed || !s.view) return;
      var why = r.slice(6) || 'its player showed an error';
      var to = s._mv.watchUrl;
      s._mv.embed = '';
      clearTimers(s);
      say('YouTube’s embedded player didn’t play “' + nameOf(s) + '” (' + why + '): the tile plays its watch page instead');
      if (!to) return;
      s.url = to;
      try { var p = s.view.loadURL(to); if (p && p.catch) p.catch(function () { /* a redirect or a stop */ }); } catch (e) { /* gone */ }
    });
  }

  /** A YouTube tile without the sound asks its player for 360p; with the sound, its own choice. */
  function armQuality(s) {
    if (s.service !== 'youtube' || !s.view) return;
    for (var i = 0; i < QUALITY_TRIES.length; i++) timer(s, function () { applyQuality(s); }, QUALITY_TRIES[i]);
  }
  function applyQuality(s) {
    if (s.service !== 'youtube' || !s.view) return;
    var want = isMulti() && s !== CTX.focused() ? LOW_Q : 'auto';
    if (want === 'auto' && !s._mv.q) return;   // never asked for less: nothing to give back
    js(s.view, qualityJs(want)).then(function (r) { if (typeof r === 'string' && r.indexOf('set:') === 0) s._mv.q = want === 'auto' ? '' : want; s._mv.qAnswer = r || ''; });
  }

  /* --------------------------------------------------------------- layout and sound */

  function onLayout(ctx) {
    CTX = ctx;
    var l = ctx.L;
    var n = l.slots.length;
    var multi = n > 1;
    if (!multi) { M.spot = false; M.muteAll = false; endSwap(); }
    if (l.focus >= n) l.focus = Math.max(0, n - 1);
    l.el.classList.toggle('mv-multi', multi);
    l.grid.classList.toggle('mv-spot', multi && (n === 3 || M.spot));
    for (var i = 0; i < n; i++) {
      var s = l.slots[i];
      s.tile.setAttribute('data-pos', String(i));
      if (!s._mv) continue;
      paintHead(s);
      if (multi) {
        armPage(s);
        if (!s._mv.converted && s.wcId !== null) toEmbed(s);
      }
      applyQuality(s);
    }
    applyAudio();
    paintBar();
    if (M.mini) ctx.place();
  }

  /** The single player's YouTube watch page, once it is a tile, becomes the embed where it was. */
  function toEmbed(s) {
    s._mv.converted = true;
    if (s.service !== 'youtube' || !s.view || s.blocked) return;
    var e = embedFor(s.url);
    if (!e) return;
    var v = s.view;
    js(v, TIME_JS).then(function (sec) {
      if (s.view !== v || !isMulti()) return;
      var to = withStart(e, Number(sec) || 0);
      s._mv.watchUrl = s.url;
      s._mv.embed = to;
      s.url = to;
      try { var p = v.loadURL(to, { httpReferrer: EMBED_REFERER }); if (p && p.catch) p.catch(function () { /* a redirect or a stop */ }); } catch (err) { /* gone */ }
    });
  }

  function applyAudio() {
    var l = L();
    if (!l) return;
    var multi = l.slots.length > 1;
    for (var i = 0; i < l.slots.length; i++) {
      var s = l.slots[i];
      if (!s._mv) continue;
      var muted = multi && (M.muteAll || i !== l.focus);
      s._mv.muted = muted;
      s.tile.classList.toggle('mv-audio', multi && i === l.focus && !M.muteAll);
      s.tile.classList.toggle('mv-selected', multi && i === l.focus);
      if (s.view) { try { s.view.setAudioMuted(muted); } catch (e) { /* before dom-ready: re-applied there */ } }
      paintHead(s);
    }
  }

  function paintHead(s) {
    var e = s._mv && s._mv.els;
    if (!e) return;
    var l = L();
    var i = l ? l.slots.indexOf(s) : -1;
    e.num.textContent = i >= 0 ? String(i + 1) : '';
    e.mark.textContent = svcMark(s.service);
    e.mark.setAttribute('data-svc', s.service || '');
    e.name.textContent = nameOf(s);
    e.name.title = nameOf(s);
    e.limit.textContent = s._mv.limit ? svcName(s.service) + ': “' + s._mv.limit + '”' : '';
    e.limit.title = e.limit.textContent;
    s.tile.classList.toggle('mv-limited', !!s._mv.limit);
    var audio = l && i === l.focus && !M.muteAll;
    e.sound.classList.toggle('on', !!audio);
    e.sound.querySelector('.mv-glyph').textContent = audio ? '' : '';
    e.sound.querySelector('.mv-sound-txt').textContent = audio ? 'Sound' : (M.muteAll ? 'Muted' : 'Listen');
    e.sound.setAttribute('aria-label', audio ? 'This tile has the sound' : 'Move the sound to this tile (' + (i + 1) + ')');
    e.sound.setAttribute('aria-pressed', audio ? 'true' : 'false');
  }

  function paintBar() {
    var l = L();
    if (!M.els || !l) return;
    var n = l.slots.length;
    if (M.els.add) {
      M.els.add.disabled = n >= MAX;
      M.els.add.title = n >= MAX ? 'Multiview holds four streams: remove one (X) to add another' : 'Watch another title alongside this one (up to four)';
    }
    if (M.els.title) {
      var f = CTX.focused();
      M.els.title.textContent = M.pick ? 'Pick a title in ' + CTX.NAME + ' to add' : (f ? nameOf(f) + (n > 1 ? ' · ' + n + ' streams' : '') : '');
      M.els.mark.textContent = f && !M.pick ? svcMark(f.service) : '';
      M.els.mark.setAttribute('data-svc', f ? f.service : '');
      M.els.cancel.hidden = !M.pick;
      M.els.head.classList.toggle('picking', M.pick);
    }
  }

  function select(s, focusIt) {
    var l = L();
    var i = l ? l.slots.indexOf(s) : -1;
    if (i < 0 || !isMulti()) return;
    var moved = l.focus !== i || M.muteAll;
    l.focus = i;
    M.muteAll = false;
    applyAudio();
    for (var j = 0; j < l.slots.length; j++) applyQuality(l.slots[j]);
    CTX.syncBar();
    paintBar();
    if (focusIt && s.view) { try { s.view.focus(); } catch (e) { /* not focusable */ } }
    if (moved) CTX.note('Sound: tile ' + (i + 1) + ', ' + nameOf(s));
  }

  function toggleMuteAll() {
    if (!isMulti()) return;
    M.muteAll = !M.muteAll;
    applyAudio();
    CTX.note(M.muteAll ? 'All tiles muted (M brings the sound back)' : 'Sound: tile ' + (L().focus + 1));
  }

  function swapIdx(a, b) {
    var l = L();
    if (a === b || a < 0 || b < 0) return;
    var keep = l.slots[l.focus];
    var t = l.slots[a]; l.slots[a] = l.slots[b]; l.slots[b] = t;
    l.focus = Math.max(0, l.slots.indexOf(keep));
    CTX.layout();
    CTX.syncBar();
  }

  function expandSlot(s) {
    var l = L();
    var i = l.slots.indexOf(s);
    var n = l.slots.length;
    if (i < 0 || n < 2) return;
    if (n === 3) {
      if (i === 0) { CTX.note('Tile 1 is the big tile'); return; }
      swapIdx(i, 0);
      CTX.note('Expanded: ' + nameOf(s));
      return;
    }
    if (M.spot && i === 0) { M.spot = false; CTX.layout(); CTX.note('Back to the even grid'); return; }
    M.spot = true;
    if (i !== 0) swapIdx(i, 0); else CTX.layout();
    CTX.note('Expanded: ' + nameOf(s) + ' (F again for the even grid)');
  }

  function startSwap(s) {
    var l = L();
    var n = l.slots.length;
    if (n < 2) return;
    if (n === 2) { swapIdx(0, 1); CTX.note('Swapped'); return; }
    if (M.swapFrom === s) { endSwap(); return; }
    M.swapFrom = s;
    l.el.classList.add('mv-swapping');
    for (var i = 0; i < n; i++) { var t = l.slots[i]; if (t._mv) t._mv.els.target.hidden = t === s; }
    s.tile.classList.add('mv-swap-from');
    CTX.note('Swap: pick the tile to trade places with (Esc cancels)');
  }
  function finishSwap(t) {
    var from = M.swapFrom;
    endSwap();
    if (!from || from === t) return;
    var l = L();
    swapIdx(l.slots.indexOf(from), l.slots.indexOf(t));
    CTX.note('Swapped');
  }
  function endSwap() {
    var l = L();
    M.swapFrom = null;
    if (!l || !l.el) return;
    l.el.classList.remove('mv-swapping');
    for (var i = 0; i < l.slots.length; i++) {
      var t = l.slots[i];
      if (t._mv) t._mv.els.target.hidden = true;
      t.tile.classList.remove('mv-swap-from');
    }
  }

  function removeSlot(s, why) {
    var l = L();
    var i = l.slots.indexOf(s);
    if (i < 0) return;
    if (l.slots.length === 1) { CTX.close(why || 'Remove'); return; }
    var hadSound = i === l.focus;
    var keep = l.slots[l.focus];
    l.slots.splice(i, 1);
    CTX.destroySlot(s);
    l.focus = hadSound ? 0 : Math.max(0, l.slots.indexOf(keep));
    // Fresh after watching, for the tile that went (watch-main re-reads that service).
    if (CTX.api && s.service && !s.blocked) { try { CTX.api.closed([s.service]); } catch (e) { /* no channel */ } }
    CTX.layout();
    CTX.syncBar();
    CTX.note('Removed ' + nameOf(s) + (hadSound && l.slots.length ? '. Sound: tile 1' : ''));
  }

  /** Esc: the tile with the sound stays, as the single player. */
  function leaveMulti() {
    var l = L();
    var keep = l.slots[l.focus] || l.slots[0];
    var gone = l.slots.filter(function (t) { return t !== keep; });
    l.slots = [keep];
    l.focus = 0;
    for (var i = 0; i < gone.length; i++) CTX.destroySlot(gone[i]);
    var svcs = [];
    for (var j = 0; j < gone.length; j++) if (gone[j].service && !gone[j].blocked && svcs.indexOf(gone[j].service) === -1) svcs.push(gone[j].service);
    if (CTX.api && svcs.length) { try { CTX.api.closed(svcs); } catch (e) { /* no channel */ } }
    CTX.layout();
    CTX.syncBar();
    CTX.note('Left multiview: ' + nameOf(keep) + ' plays on');
  }

  /* --------------------------------------------------------------- adding a tile */

  function refuse(text) {
    M.refusal = { text: text, at: Date.now() };
    say(text, true);
    if (M.mini) { M.pick = false; paintBar(); }
  }

  function onOpen(ctx, url, service, o) {
    CTX = ctx;
    var l = ctx.L;
    // In the corner with several tiles, a title he picks joins them (it never replaces the games).
    var want = o.multi === true || M.pick || (M.mini && l.open && l.slots.length > 1);
    if (!want) {
      if (M.mini) exitMini(true);   // a title picked while the player sits in a corner: it plays here, full size
      return undefined;
    }
    var open = l.open && l.slots.length > 0;
    if (!open) {
      // Nothing playing: this one plays, and waits in the corner for the next pick.
      M.mini = true;
      M.pick = true;
      if (l.el) l.el.classList.add('mv-mini');
      setTimeout(function () { paintBar(); focusRows(); }, 0);
      return undefined;
    }
    M.pick = false;
    if (l.slots.length >= MAX) { refuse('Multiview holds four streams: remove one (X) to add another'); return true; }
    var title = o.title || '';
    var api = ctx.api;
    var check = api && typeof api.free === 'function' ? api.free() : Promise.resolve(null);
    M.lastAdd = { url: url, at: Date.now(), state: 'checking' };
    Promise.resolve(check).then(function (r) {
      var free = r && Number.isFinite(r.freeGb) ? r.freeGb : null;
      var floor = r && Number.isFinite(r.floorGb) ? r.floorGb : 1.5;
      M.lastAdd.freeGb = free;
      if (free === null) { M.lastAdd.state = 'refused'; refuse('No stream was added: Lumen couldn’t read how much memory is free'); return; }
      if (free < floor) {
        M.lastAdd.state = 'refused';
        refuse('Not enough memory for another stream: ' + (Math.floor(free * 10) / 10).toFixed(1) + ' GB free');
        return;
      }
      if (!l.open || l.slots.length >= MAX) { M.lastAdd.state = 'refused'; if (l.open) refuse('Multiview holds four streams: remove one (X) to add another'); return; }
      addTile(url, service, title, o);
      M.lastAdd.state = 'added';
    }, function (err) {
      M.lastAdd.state = 'refused';
      refuse('No stream was added: Lumen couldn’t read how much memory is free (' + String((err && err.message) || err).slice(0, 80) + ')');
    });
    return true;
  }

  function addTile(url, service, title, o) {
    var l = L();
    var to = url, embed = '', watchUrl = '';
    if (service === 'youtube' && !o.blocked) { embed = embedFor(url); if (embed) { watchUrl = url; to = embed; } }
    var s = CTX.makeSlot(to, { service: service, title: title, blocked: o.blocked || '', multi: true, embed: embed, watchUrl: watchUrl });
    l.slots.push(s);
    l.grid.appendChild(s.tile);
    if (M.mini) exitMini(true);
    CTX.layout();
    CTX.syncBar();
    CTX.show();
    var n = l.slots.length;
    CTX.note('Added ' + (title || svcName(service)) + ' as tile ' + n + '. Sound stays on tile ' + (l.focus + 1) + ': press ' + n + ' or click it to listen');
  }

  /* --------------------------------------------------------------- the mini-player */

  function startPick() {
    var l = L();
    if (!l || !l.open) return;
    if (l.slots.length >= MAX) { refuse('Multiview holds four streams: remove one (X) to add another'); return; }
    enterMini(true);
  }
  function cancelPick() { M.pick = false; paintBar(); }

  function enterMini(pick) {
    var l = L();
    if (!l || !l.open) return;
    if (l.fsSlot) return;
    endSwap();
    if (l.sheet) { CTX.note('Finish signing in first'); return; }
    M.mini = true;
    M.pick = !!pick;
    l.el.classList.add('mv-mini');
    paintBar();
    CTX.place();
    focusRows();
  }
  function exitMini(quiet) {
    var l = L();
    M.mini = false;
    M.pick = false;
    M.drag = null;
    if (!l || !l.el) return;
    l.el.classList.remove('mv-mini', 'mv-dragging', 'mv-snap');
    paintBar();
    CTX.place();
    var f = CTX.focused();
    if (!quiet && f && f.view) { try { f.view.focus(); } catch (e) { /* not focusable */ } }
  }
  function focusRows() {
    var l = L();
    var v = l && l.owner && l.owner.viewEl;
    if (v) { try { v.focus(); } catch (e) { /* not focusable */ } }
  }

  /** The mini box in the owner tab: its corner, or where a drag holds it. */
  function onPlace(ctx, r, hr) {
    if (!M.mini) return undefined;
    var l = ctx.L;
    var n = l.slots.length;
    var w = Math.round(Math.min(n > 1 ? MINI_W_GRID : MINI_W, Math.max(240, r.width * 0.42)));
    var h = Math.round(w * 9 / 16) + HEAD_H;
    var minL = r.left - hr.left + MINI_GAP, maxL = r.left - hr.left + r.width - w - MINI_GAP;
    var minT = r.top - hr.top + MINI_GAP, maxT = r.top - hr.top + r.height - h - MINI_GAP;
    var x, y;
    if (M.drag && M.drag.moved) {
      x = Math.max(minL, Math.min(maxL, M.drag.x));
      y = Math.max(minT, Math.min(maxT, M.drag.y));
    } else {
      x = M.corner.charAt(1) === 'l' ? minL : maxL;
      y = M.corner.charAt(0) === 't' ? minT : maxT;
    }
    l.el.style.left = Math.round(x) + 'px';
    l.el.style.top = Math.round(y) + 'px';
    l.el.style.width = w + 'px';
    l.el.style.height = h + 'px';
    M.box = { left: Math.round(x), top: Math.round(y), width: w, height: h, area: { minL: minL, maxL: maxL, minT: minT, maxT: maxT } };
    return true;
  }

  function wireDrag(node) {
    node.addEventListener('pointerdown', function (e) {
      if (!M.mini || e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('button')) return;
      var l = L();
      var b = l.el.getBoundingClientRect();
      var views = document.getElementById('views');
      var hr = views ? views.getBoundingClientRect() : { left: 0, top: 0 };
      M.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: b.left - hr.left, oy: b.top - hr.top, x: b.left - hr.left, y: b.top - hr.top, moved: false, node: node };
      try { node.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
      e.preventDefault();
    });
    node.addEventListener('pointermove', function (e) {
      var d = M.drag;
      if (!d || d.id !== e.pointerId) return;
      var dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      if (!d.moved) { d.moved = true; L().el.classList.add('mv-dragging'); }
      d.x = d.ox + dx;
      d.y = d.oy + dy;
      CTX.place();
    });
    var end = function (e) {
      var d = M.drag;
      if (!d || d.id !== e.pointerId) return;
      try { node.releasePointerCapture(e.pointerId); } catch (err) { /* released */ }
      M.drag = null;
      var l = L();
      l.el.classList.remove('mv-dragging');
      if (e.type === 'pointercancel') { CTX.place(); return; }
      if (!d.moved) { if (node === M.els.hit) exitMini(); return; }
      // The nearest corner, by where the box's middle was let go.
      var a = M.box && M.box.area;
      var cx = d.x + (M.box ? M.box.width : 0) / 2, cy = d.y + (M.box ? M.box.height : 0) / 2;
      var midX = a ? (a.minL + a.maxL + M.box.width) / 2 : 0, midY = a ? (a.minT + a.maxT + M.box.height) / 2 : 0;
      M.corner = (cy < midY ? 't' : 'b') + (cx < midX ? 'l' : 'r');
      l.el.classList.add('mv-snap');
      CTX.place();
      setTimeout(function () { if (L() && L().el) L().el.classList.remove('mv-snap'); }, 260);
    };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
  }

  /* --------------------------------------------------------------- keys */

  function doKey(k, wcId) {
    var l = L();
    if (!l || !l.open || !isMulti() || M.mini) return;
    if (/^[1-4]$/.test(k)) {
      var s = l.slots[Number(k) - 1];
      if (s) select(s, true); else CTX.note('There is no tile ' + k);
      return;
    }
    var f = CTX.focused();
    if (!f) return;
    if (k === 'f') expandSlot(f);
    else if (k === 'x') removeSlot(f, 'X');
    else if (k === 'm') toggleMuteAll();
  }

  function onKey(ctx, m) {
    CTX = ctx;
    var k = String(m.key || '');
    if (k === 'focus') {
      if (!isMulti() || M.mini) return;
      for (var i = 0; i < ctx.L.slots.length; i++) if (ctx.L.slots[i].wcId === m.wcId && i !== ctx.L.focus) select(ctx.L.slots[i], false);
      return;
    }
    doKey(k.toLowerCase(), m.wcId);
  }

  function onShortcut(ctx, id) {
    CTX = ctx;
    var l = ctx.L;
    // In the corner the player is beside the rows: Esc and Back are theirs.
    if (M.mini) return false;
    if (id !== 'escape') return undefined;
    if (l.fsSlot || l.sheet || Date.now() - l.fsLeftAt < 500) return undefined;
    if (M.swapFrom) { endSwap(); ctx.note('Swap cancelled'); return true; }
    if (l.slots.length > 1) { leaveMulti(); return true; }
    return undefined;
  }

  /** Back in multiview: the selected tile's own history; with nothing earlier, a word about Esc. */
  function onBack(ctx) {
    CTX = ctx;
    if (!isMulti() || M.mini) return undefined;
    var s = ctx.focused();
    var v = s && s.view;
    var can = false;
    try { can = !!(v && v.canGoBack()); } catch (e) { can = false; }
    if (can) { try { var p = v.goBack(); if (p && p.catch) p.catch(function () { /* the page went */ }); } catch (e) { /* gone */ } }
    else ctx.note('Nothing earlier in tile ' + (ctx.L.focus + 1) + ': Esc leaves multiview');
    return true;
  }

  function onClose(ctx) {
    M.mini = false; M.pick = false; M.drag = null; M.spot = false; M.muteAll = false;
    endSwap();
    var l = ctx.L;
    if (l.el) { l.el.classList.remove('mv-mini', 'mv-multi', 'mv-dragging', 'mv-snap'); }
    if (l.grid) l.grid.classList.remove('mv-spot');
  }

  /* --------------------------------------------------------------- the e2e's view */

  function state(ctx) {
    var l = ctx.L;
    var r = function (n) { if (!n) return null; var b = n.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
    return {
      n: l.slots.length,
      layout: l.grid ? (l.grid.getAttribute('data-n') || '') + (l.grid.classList.contains('mv-spot') ? '-spot' : '') : '',
      spot: M.spot, muteAll: M.muteAll, mini: M.mini, pick: M.pick, corner: M.corner,
      swapping: !!M.swapFrom,
      refusal: M.refusal, lastAdd: M.lastAdd,
      box: l.el ? r(l.el) : null,
      tiles: l.slots.map(function (s, i) {
        var x = s._mv || {};
        return { pos: i, wcId: s.wcId, service: s.service, url: s.url, embed: !!x.embed, muted: !!x.muted, audio: s.tile.classList.contains('mv-audio'),
          limit: x.limit || '', q: x.q || '', qAnswer: x.qAnswer || '', check: x.check || '', rect: r(s.tile),
          head: x.els ? x.els.head.textContent : '', headShown: x.els ? x.els.head.offsetParent !== null : false };
      })
    };
  }

  window.WatchPlayerMulti = {
    build: onBuild, bar: onBar, slot: onSlot, view: onView, attach: onAttach, destroy: onDestroy,
    open: onOpen, layout: onLayout, place: onPlace, shortcut: onShortcut, key: onKey, back: onBack, close: onClose, state: state,
    // for watch-player-multi-unit.js
    _embedFor: embedFor, _withStart: withStart
  };
})();
