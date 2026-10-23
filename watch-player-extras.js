/* ============================================================
   watch-player-extras.js -- one click from a tile to the video
   playing, inside the Lumen player layer (chrome side).

   watch-player.js calls in at a few points (bar, attach, reuse,
   opened, destroy, state); everything here is per slot:

   - Straight to the player, with a fallback. A Continue tile can
     open the service's player itself (Hulu /watch/<uuid>, see
     watch/playurl.js). If the player refuses it (an HTTP error, a
     failed load, Hulu sending the view somewhere other than
     /watch/), the slot loads the title page instead and says why.
   - The quality note: the playing video's own height, read from
     the page's media events (no polling), as "720p, browser
     limit" for the protected services, with a one-line reason.
   - Up next: when the video ends, main reads that service again
     (afterWatching) and answers the next episode from its own
     Continue watching; a card counts 10 s down, with Play now and
     Cancel. The service's own up-next (the page moving on, or the
     video playing again) cancels Lumen's. Space (or K, the same
     play/pause key) while the card is up never starts the next
     episode: it stops the countdown (and pauses the video if it is
     still playing), and the card says so, naming the key.
   - The menu (More): Open in Edge, each with its plain reason --
     cast, a refused licence, or a sharper picture.
   - The profile picker: a note saying Lumen reads the service
     again when the layer closes.
   ============================================================ */
(function () {
  'use strict';
  var P = window.LumenPlay;
  var MEDIA_TAG = '__lumen:media ';
  var ARM_MS = 15000;          // how long after an open a redirect still counts as the player refusing
  var UP_NEXT_SEC = (P && P.UP_NEXT_SEC) || 10;

  var bar = null, qBtn = null, moreBtn = null, menu = null;
  var CTX = null;
  var last = { fallback: null, upnext: null, menu: null };   // the e2e's view
  var fakeNext = null;                                       // the e2e's seam: the next answer, instead of main's

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function button(cls, label, fn, aria) {
    var b = el('button', 'wp-btn ' + (cls || ''), label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(b, e); });
    return b;
  }
  function name(id) { return (P && P.NAMES[id]) || 'the service'; }
  function X(s) { if (!s._x) s._x = { armed: 0, playUrl: '', fell: '', h: 0, up: null, ended: false }; return s._x; }

  /* --------------------------------------------------------------- the bar */

  function onBar(ctx, b) {
    CTX = ctx;
    bar = b;
    qBtn = button('wpx-q', '', function () { toggleMenu(); });
    qBtn.hidden = true;
    moreBtn = button('wpx-more', '⋯', function () { toggleMenu(); }, 'More: Open in Edge and why');
    moreBtn.setAttribute('aria-haspopup', 'menu');
    moreBtn.setAttribute('aria-expanded', 'false');
    var edge = b.querySelector('.wp-edge');
    b.insertBefore(qBtn, b.querySelector('.wp-grow') ? b.querySelector('.wp-grow').nextSibling : edge);
    b.insertBefore(moreBtn, b.querySelector('.wp-close'));
    document.addEventListener('mousedown', function (e) {
      if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== moreBtn && e.target !== qBtn) closeMenu();
    }, true);
  }

  function syncQuality() {
    if (!qBtn || !CTX) return;
    var s = CTX.focused();
    var q = s && s._x && s._x.h && P ? P.qualityNote(s.service, s._x.h) : null;
    qBtn.hidden = !q;
    if (q) {
      qBtn.textContent = q.text;
      qBtn.title = q.why;
      qBtn.setAttribute('aria-label', 'Picture: ' + q.text + '. ' + q.why);
    }
  }

  /* --------------------------------------------------------------- the menu */

  function closeMenu() {
    if (!menu) return;
    menu.hidden = true;
    if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
    last.menu = null;
  }
  function toggleMenu() {
    if (menu && !menu.hidden) { closeMenu(); return; }
    openMenu();
  }
  function openMenu() {
    var s = CTX && CTX.focused();
    if (!s || !P) return;
    var layer = CTX.L.el;
    if (!menu) {
      menu = el('div', 'wpx-menu');
      menu.setAttribute('role', 'menu');
      menu.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); if (moreBtn) moreBtn.focus(); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          var items = [].slice.call(menu.querySelectorAll('[role="menuitem"]'));
          var i = items.indexOf(document.activeElement);
          var n = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
          if (n) { e.preventDefault(); n.focus(); }
        }
      });
    }
    if (menu.parentNode !== layer) layer.appendChild(menu);
    menu.replaceChildren();
    var x = X(s);
    var q = x.h ? P.qualityNote(s.service, x.h) : null;
    var info = [];
    if (q) info.push(['Picture', q.text + '. ' + q.why]);
    if (x.fell) info.push(['Opened the title page', x.fell + '.']);
    info.forEach(function (row) {
      var p = el('div', 'wpx-info');
      p.appendChild(el('b', '', row[0]));
      p.appendChild(el('span', '', row[1]));
      menu.appendChild(p);
    });
    var reasons = P.edgeReasons(s.service, { refused: s.refused || '', height: x.h });
    var labels = [];
    reasons.forEach(function (r) {
      var it = button('wpx-item', '', function (b) { closeMenu(); CTX.toEdge(s, b, r.id === 'cast' ? 'to cast' : r.id === 'licence' ? 'licence refused' : 'sharper picture'); });
      it.setAttribute('role', 'menuitem');
      it.appendChild(el('span', 'wpx-item-label', r.label));
      it.appendChild(el('span', 'wpx-item-why', r.why));
      menu.appendChild(it);
      labels.push(r.label);
    });
    menu.hidden = false;
    if (moreBtn) moreBtn.setAttribute('aria-expanded', 'true');
    // Under the More button, inside the layer.
    var lr = layer.getBoundingClientRect();
    var br = moreBtn.getBoundingClientRect();
    var w = menu.offsetWidth || 340;
    menu.style.top = Math.round(br.bottom - lr.top + 6) + 'px';
    menu.style.left = Math.round(Math.max(8, Math.min(br.right - lr.left - w, lr.width - w - 8))) + 'px';
    last.menu = { items: labels, info: info.map(function (r) { return r[0] + ': ' + r[1]; }) };
    var first = menu.querySelector('[role="menuitem"]');
    if (first) first.focus();
  }

  /* --------------------------------------------------------------- straight to the player */

  function arm(s) {
    var x = X(s);
    x.fell = '';
    x.armed = s.fallback ? Date.now() : 0;
    x.playUrl = s.fallback ? s.url : '';
    x.h = 0;
    x.ended = false;
    cancelUpNext(s, '');
  }

  function check(s, url, code, failed) {
    var x = X(s);
    if (!x.armed || !P) return;
    if (Date.now() - x.armed > ARM_MS) { x.armed = 0; return; }
    var why = P.refusal({ service: s.service, playUrl: x.playUrl, url: url, code: code, failed: failed });
    if (!why) return;
    x.armed = 0;
    x.fell = why;
    var to = s.fallback;
    s.fallback = '';
    s.url = to;
    last.fallback = { why: why, to: to, at: Date.now() };
    s.state.hidden = true;
    s.tile.classList.remove('has-state');
    try { var pr = s.view.loadURL(to); if (pr && pr.catch) pr.catch(function () { /* did-fail-load says the rest */ }); } catch (e) { s.view.setAttribute('src', to); }
    CTX.note(why + ', so Lumen opened the ' + (s.item && s.item.title ? s.item.title + ' ' : '') + 'page instead');
    try { console.warn('[lumen] ' + why + '; fell back to the title page'); } catch (e) { /* no console */ }
  }

  /* --------------------------------------------------------------- the page's media events */

  // The height it reports is the picture's SHORTER side, YouTube's own way of naming a size: a 1080x1920 Short is
  // 1080p, never "1920p" (shortsreal, 10-18).
  // Runs in the service's page: listens (capture phase, so the video's own non-bubbling events reach it)
  // and reports the biggest video's height and whether it ended. No timers, no polling.
  var MEDIA_JS = '(function () {' +
    ' if (window.__lumenMedia) return 1; window.__lumenMedia = 1;' +
    ' var log = console.log.bind(console), lastKey = "";' +
    ' function top() { var vs = document.querySelectorAll("video"), b = null; for (var i = 0; i < vs.length; i++) { if (!b || vs[i].videoWidth * vs[i].videoHeight > b.videoWidth * b.videoHeight) b = vs[i]; } return b; }' +
    ' function say(e) { var v = e && e.target; if (!v || v.tagName !== "VIDEO") return; var t = top(); if (t && t !== v && e.type !== "ended") return;' +
    '   var m = { h: (v.videoWidth && v.videoHeight ? Math.min(v.videoWidth, v.videoHeight) : v.videoHeight) || 0, w: v.videoWidth || 0, ended: e.type === "ended", playing: e.type === "playing", paused: e.type === "pause" && !v.ended };' +
    '   var k = m.h + "x" + m.ended + m.playing + m.paused; if (k === lastKey && !m.ended) return; lastKey = k;' +
    '   try { log(' + JSON.stringify(MEDIA_TAG) + ' + JSON.stringify(m)); } catch (err) {} }' +
    ' ["loadedmetadata", "resize", "playing", "pause", "ended"].forEach(function (n) { document.addEventListener(n, say, true); });' +
    ' var t = top(); if (t && t.videoHeight) say({ target: t, type: t.ended ? "ended" : "resize" });' +
    ' return 1; })()';

  function onMedia(s, m) {
    var x = X(s);
    if (m.h > 0) {
      x.h = m.h;
      if (x.armed) x.armed = 0;           // the player is playing: no longer a refusal
      if (CTX && s === CTX.focused()) syncQuality();
    }
    if (m.ended && !x.ended) { x.ended = true; ended(s); }
    else if (m.playing && x.ended) {
      // Playing again (the service's own up-next, or the user pressed play): Lumen's card steps aside.
      x.ended = false;
      cancelUpNext(s, name(s.service) + ' went on by itself');
    } else if (m.paused && x.up && (x.up.phase === 'counting' || (x.up.phase === 'asking' && !x.up.hold))) {
      // Paused while the card counts (the service's own Space or pause button, with the focus in its page):
      // a paused video never moves on by itself either.
      holdUpNext(s, 'paused');
    } else if (m.playing && x.up && x.up.phase === 'held' && x.up.how !== 'playing') {
      // Resumed after a stop (the user's second Space): the card stays, stopped, and stops saying "paused".
      x.up.how = 'playing';
      draw(s);
    }
  }

  function onAttach(ctx, s, v) {
    CTX = ctx;
    arm(s);
    v.addEventListener('dom-ready', function () {
      if (s.view !== v) return;
      try { var pr = v.executeJavaScript(MEDIA_JS, false); if (pr && pr.catch) pr.catch(function () { /* the page went */ }); } catch (e) { /* not ready */ }
    });
    v.addEventListener('console-message', function (e) {
      var msg = e && typeof e.message === 'string' ? e.message : '';
      if (s.view !== v || msg.indexOf(MEDIA_TAG) !== 0) return;
      var m = null;
      try { m = JSON.parse(msg.slice(MEDIA_TAG.length)); } catch (err) { m = null; }
      if (m && typeof m === 'object') onMedia(s, { h: Math.max(0, Math.min(8640, Math.round(Number(m.h) || 0))), ended: m.ended === true, playing: m.playing === true, paused: m.paused === true });
    });
    v.addEventListener('did-navigate', function (e) {
      if (s.view !== v) return;
      X(s).h = 0;
      if (s === CTX.focused()) syncQuality();
      check(s, e.url, e.httpResponseCode, '');
      if (X(s).up && X(s).up.phase !== 'none') cancelUpNext(s, name(s.service) + ' went on by itself');
    });
    v.addEventListener('did-navigate-in-page', function (e) {
      if (s.view !== v || !e.isMainFrame) return;
      check(s, e.url, 0, '');
      if (X(s).up && X(s).up.phase !== 'none') cancelUpNext(s, name(s.service) + ' went on by itself');
    });
    v.addEventListener('did-fail-load', function (e) {
      if (s.view !== v || !e.isMainFrame || e.errorCode === -3) return;
      check(s, e.validatedURL || s.url, 0, e.errorDescription || ('error ' + e.errorCode));
    });
  }

  function onReuse(ctx, s) { CTX = ctx; arm(s); syncQuality(); }

  function onOpened(ctx, s) {
    CTX = ctx;
    if (!s) return;
    syncQuality();
    if (s.purpose === 'profile') {
      ctx.note((s.pnote ? s.pnote + '. ' : '') + 'Pick who’s watching; Lumen reads ' + name(s.service) + ' again when you close this');
    }
  }

  function onDestroy(ctx, s) { cancelUpNext(s, ''); if (menu && ctx.L.slots.length <= 1) closeMenu(); }

  /* --------------------------------------------------------------- up next */

  function card(s) {
    var x = X(s);
    // phase: none | asking | counting | held (Space stopped the countdown) | none-found.
    // hold: Space came while still asking (the answer then lands as held, never counting). how: what the stop did
    // to the video ('' not known yet, paused, playing, ended, stopped, no video, failed), for the card's words.
    // key: the key that stopped it ('Space' or 'K'), so the card names the key that plays the video again.
    if (!x.up) x.up = { phase: 'none', el: null, timer: 0, left: 0, next: null, reason: '', hold: false, how: '', key: 'Space' };
    if (!x.up.el) {
      x.up.el = el('div', 'wpx-up');
      x.up.el.setAttribute('role', 'status');
      x.up.el.setAttribute('aria-live', 'polite');
      s.tile.appendChild(x.up.el);
    }
    return x.up;
  }

  function ended(s) {
    if (!s.item || s.purpose === 'profile' || !CTX || !CTX.api || typeof CTX.api.upNext !== 'function') return;
    var up = card(s);
    if (up.phase === 'asking' || up.phase === 'counting') return;
    up.phase = 'asking';
    up.next = null;
    up.reason = '';
    up.hold = false;
    up.how = '';
    up.key = 'Space';
    draw(s);
    var item = s.item;
    var ask = fakeNext ? Promise.resolve(fakeNext) : CTX.api.upNext(item);
    ask.then(function (r) {
      if (up.phase !== 'asking' || s.item !== item) return;
      if (r && r.next && r.next.url) {
        up.next = r.next;
        up.left = UP_NEXT_SEC;
        // Space while Lumen was still reading the service: the next episode is offered, but never counts down.
        if (up.hold) { up.phase = 'held'; up.hold = false; draw(s); return; }
        up.phase = 'counting';
        draw(s);
        up.timer = setInterval(function () {
          up.left--;
          if (up.left <= 0) { playNext(s); return; }
          var c = up.el && up.el.querySelector('.wpx-up-count');
          if (c) c.textContent = 'Plays in ' + up.left + ' s';
          record(s);
        }, 1000);
      } else {
        up.phase = 'none-found';
        up.reason = (r && r.reason) || 'No next episode came back';
        draw(s);
      }
    }, function (err) {
      if (up.phase !== 'asking') return;
      up.phase = 'none-found';
      up.reason = 'Lumen couldn’t look: ' + ((err && err.message) || err);
      draw(s);
    });
  }

  // The card's words for a stopped countdown: what Space (or K) did to the video, in plain words (never a silent
  // change). key: the key that stopped it, named back as the one that plays the video again.
  function heldText(how, key) {
    if (how === 'paused') return 'Countdown stopped and this video paused. ' + (key === 'K' ? 'K' : 'Space') + ' plays it again.';
    if (how === 'playing') return 'Countdown stopped. The next episode won’t start by itself.';
    if (how === 'ended' || how === 'stopped') return 'Countdown stopped. Staying on this video.';
    if (how === 'no video') return 'Countdown stopped. Lumen found no video on the page to pause.';
    if (how === 'failed') return 'Countdown stopped. Lumen couldn’t reach the page to pause the video.';
    return 'Countdown stopped.';
  }

  function draw(s) {
    var up = card(s);
    var c = up.el;
    // The focus was on the card (its Play now) or nowhere: it stays on the card after a redraw, so the next Space
    // lands here again (and plays or pauses this video) instead of falling to the page body.
    var ae = document.activeElement;
    var hadFocus = !!ae && (c.contains(ae) || ae === document.body);
    c.replaceChildren();
    c.hidden = up.phase === 'none';
    c.setAttribute('data-phase', up.phase);
    if (up.phase === 'none') { record(s); return; }
    var head = el('div', 'wpx-up-head', 'Up next on ' + name(s.service));
    c.appendChild(head);
    var acts = el('div', 'wpx-up-acts');
    if (up.phase === 'asking') {
      c.appendChild(el('p', 'wpx-up-sub', 'Reading ' + name(s.service) + ' for the next episode…'));
      if (up.hold) c.appendChild(el('p', 'wpx-up-count is-held', heldText(up.how, up.key)));
      acts.appendChild(button('wpx-up-cancel', 'Cancel', function () { cancelUpNext(s, 'Cancelled'); }));
    } else if (up.phase === 'held') {
      // Space stopped the countdown: the next episode stays offered (Play now still plays it), nothing counts.
      var hn = up.next;
      c.appendChild(el('p', 'wpx-up-title', hn.title || ''));
      var hep = P ? P.epText(P.epOf(hn.subtitle)) : '';
      var hrest = String(hn.subtitle || '').replace(/^\s*S\d+\s*[:.·-]?\s*E\d+\s*[·:.-]?\s*/i, '');
      c.appendChild(el('p', 'wpx-up-sub', [hep, hrest].filter(Boolean).join(' · ')));
      c.appendChild(el('p', 'wpx-up-count is-held', heldText(up.how, up.key)));
      acts.appendChild(button('wp-primary wpx-up-play', 'Play now', function () { playNext(s); }));
      acts.appendChild(button('wpx-up-cancel', 'Dismiss', function () { cancelUpNext(s, ''); }));
    } else if (up.phase === 'counting') {
      var n = up.next;
      c.appendChild(el('p', 'wpx-up-title', n.title || ''));
      var ep = P ? P.epText(P.epOf(n.subtitle)) : '';
      var rest = String(n.subtitle || '').replace(/^\s*S\d+\s*[:.·-]?\s*E\d+\s*[·:.-]?\s*/i, '');
      c.appendChild(el('p', 'wpx-up-sub', [ep, rest].filter(Boolean).join(' · ')));
      var bar2 = el('div', 'wpx-up-bar');
      var fill = el('i');
      bar2.appendChild(fill);
      c.appendChild(bar2);
      c.appendChild(el('p', 'wpx-up-count', 'Plays in ' + up.left + ' s'));
      acts.appendChild(button('wp-primary wpx-up-play', 'Play now', function () { playNext(s); }));
      acts.appendChild(button('wpx-up-cancel', 'Cancel', function () { cancelUpNext(s, 'Cancelled'); }));
      // The bar empties over the countdown: one CSS transition, no per-frame script.
      requestAnimationFrame(function () { fill.style.transitionDuration = UP_NEXT_SEC + 's'; fill.classList.add('go'); });
    } else {
      c.appendChild(el('p', 'wpx-up-sub', up.reason + '.'));
      acts.appendChild(button('wpx-up-cancel', 'Dismiss', function () { cancelUpNext(s, ''); }));
    }
    c.appendChild(acts);
    record(s);
    var f = c.querySelector('.wpx-up-play') || c.querySelector('.wpx-up-cancel');
    if (f && (up.phase === 'counting' || (up.phase === 'held' && hadFocus))) { try { f.focus({ preventScroll: true }); } catch (e) { /* not focusable */ } }
  }

  function record(s) {
    var up = s._x && s._x.up;
    if (!up) return;
    last.upnext = { phase: up.phase, left: up.left, next: up.next ? { title: up.next.title, subtitle: up.next.subtitle, url: up.next.url } : null, reason: up.reason,
      hold: !!up.hold, how: up.how, text: up.el && !up.el.hidden ? up.el.textContent : '', at: Date.now() };
  }

  /* ---- Space with the card up --------------------------------------------------------------
     The bug: the card focuses its Play now button when the countdown starts, and Lumen's key routing
     deliberately leaves Space on a focused BUTTON alone (watch-playerbar.js onChromeKey: Space presses the button),
     so Space "pressed" Play now and started the next episode. Now Space with the card up stops the countdown
     instead, pauses the video if it is still playing, and the card says so; a second Space plays or pauses this
     video as Space always does. Enter or a click on Play now, and the countdown running out, still play the next
     one. K is the same play/pause key (watch-playerbar.js KEYMAP), so it does exactly what Space does here: the
     first K stops the countdown and pauses, never plays the next episode, the card says "K plays it again", and a
     second K plays the video. */

  // Runs in the service's page (the biggest video, as the ended report reads it). 'hold': pause it if it plays,
  // and say what it was doing; 'toggle': play or pause it.
  var CARD_MEDIA_JS = '(function (cmd) {' +
    ' var vs = [].slice.call(document.querySelectorAll("video")).sort(function (a, b) { return (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight); });' +
    ' var v = vs[0]; if (!v) return "no video";' +
    ' if (cmd === "hold") { if (v.ended) return "ended"; if (v.paused) return "stopped"; v.pause(); return "paused"; }' +
    ' if (v.paused || v.ended) { var p = v.play(); if (p && p.catch) p.catch(function () {}); return "playing"; }' +
    ' v.pause(); return "paused"; })';

  function pageMedia(s, cmd) {
    try {
      var pr = s.view && s.view.executeJavaScript(CARD_MEDIA_JS + '(' + JSON.stringify(cmd) + ')', true);
      if (pr && pr.then) return pr.then(function (r) { return typeof r === 'string' ? r : 'failed'; }, function () { return 'failed'; });
    } catch (e) { /* the page went */ }
    return Promise.resolve('failed');
  }

  // Stop the countdown. via 'space' (the key, Space or K: also pause a playing video) or 'paused' (the page already
  // paused). key: 'K' when K was the key, else Space (the card's words name it).
  function holdUpNext(s, via, key) {
    var up = s && s._x && s._x.up;
    if (!up || (up.phase !== 'asking' && up.phase !== 'counting')) return false;
    stopTimer(up);
    if (up.phase === 'asking') up.hold = true; else up.phase = 'held';
    up.how = via === 'paused' ? 'paused' : '';
    up.key = key === 'K' ? 'K' : 'Space';
    draw(s);
    if (via === 'space') {
      pageMedia(s, 'hold').then(function (r) {
        if (up.phase !== 'held' && !(up.phase === 'asking' && up.hold)) return;   // played, cancelled or gone since
        if (up.how === 'playing') return;                                          // already resumed
        up.how = r;
        draw(s);
      });
    }
    return true;
  }

  // Space or K with the card counting (or still asking): stop it. true when the key was taken.
  // watch-playerbar.js key() asks this first for its play/pause key (Space or K, from the page's own key bridge or
  // Lumen's chrome); k: the key as pressed (' ', 'k' or 'K').
  function isPlayKey(k) { return k === 'k' || k === 'K'; }
  function upSpace(s, k) {
    var up = s && s._x && s._x.up;
    if (!up || up.el.hidden || (up.phase !== 'asking' && up.phase !== 'counting') || (up.phase === 'asking' && up.hold)) return false;
    return holdUpNext(s, 'space', isPlayKey(k) ? 'K' : 'Space');
  }

  // The second Space, on the card's own button: this video's play/pause, through Lumen's bar when it is on (the
  // same path as Space anywhere else), else straight on the page's video.
  function toggleVideo(s) {
    var PB = window.LumenPlayerBar;
    if (PB && typeof PB.press === 'function' && PB.press(' ', false) === true) return;
    pageMedia(s, 'toggle');
  }

  function onKey(e) {
    // Space, and K (the same play/pause key: with Lumen's bar off nothing else in the chrome would take it).
    if ((e.key !== ' ' && !isPlayKey(e.key)) || e.ctrlKey || e.altKey || e.metaKey || !CTX || !CTX.L || !CTX.L.open || !CTX.focused) return;
    var s = CTX.focused();
    var up = s && s._x && s._x.up;
    if (!up || !up.el || up.el.hidden || (up.phase !== 'asking' && up.phase !== 'counting' && up.phase !== 'held')) return;
    var t = e.target;
    if (t && (t.tagName === 'WEBVIEW' || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
    var inCard = !!t && up.el.contains(t);
    if (!inCard && !(CTX.L.el && t && CTX.L.el.contains(t)) && t !== document.body) return;
    if (e.type === 'keyup') { if (inCard) e.preventDefault(); return; }   // no button press on the key's release
    if (up.phase === 'held' && !inCard) return;   // elsewhere in the layer: the bar's own Space (play/pause)
    // Taken before Lumen's bar sees it (window capture runs first), and preventDefault keeps the focused
    // Play now from being pressed.
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (up.phase === 'held') toggleVideo(s);
    else if (up.phase === 'asking' && up.hold) toggleVideo(s);
    else holdUpNext(s, 'space', isPlayKey(e.key) ? 'K' : 'Space');
  }
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);

  function stopTimer(up) { if (up && up.timer) { clearInterval(up.timer); up.timer = 0; } }

  function cancelUpNext(s, why) {
    var up = s._x && s._x.up;
    if (!up) return;
    stopTimer(up);
    var was = up.phase;
    up.phase = 'none';
    up.hold = false;
    if (up.el) { up.el.hidden = true; up.el.replaceChildren(); }
    if (why && (was === 'asking' || was === 'counting' || was === 'held')) {
      last.upnext = { phase: 'cancelled', left: up.left, next: up.next ? { title: up.next.title, subtitle: up.next.subtitle, url: up.next.url } : null, reason: why, at: Date.now() };
      if (CTX && why === 'Cancelled') CTX.note('Up next cancelled');
    }
  }

  function playNext(s) {
    var up = s._x && s._x.up;
    if (!up || !up.next) return;
    var n = up.next;
    stopTimer(up);
    up.phase = 'none';
    up.hold = false;
    if (up.el) { up.el.hidden = true; up.el.replaceChildren(); }
    last.upnext = { phase: 'played', left: up.left, next: { title: n.title, subtitle: n.subtitle, url: n.url }, reason: '', at: Date.now() };
    CTX.open(n.url, { service: s.service, title: n.title + (n.subtitle ? ' · ' + n.subtitle : ''), fallback: n.fallback || '',
      item: { id: n.id, service: n.service || s.service, title: n.title, subtitle: n.subtitle || '' } });
  }

  /* --------------------------------------------------------------- the e2e's view */

  function state(ctx) {
    var s = ctx.focused();
    var x = s && s._x;
    return {
      quality: qBtn && !qBtn.hidden ? qBtn.textContent : '',
      qualityWhy: qBtn && !qBtn.hidden ? qBtn.title : '',
      height: x ? x.h : 0,
      armed: !!(x && x.armed),
      fell: x ? x.fell : '',
      fallback: last.fallback,
      upnext: last.upnext,
      upShown: !!(x && x.up && x.up.el && !x.up.el.hidden),
      menu: menu && !menu.hidden ? last.menu : null,
      more: !!moreBtn,
      purpose: s ? s.purpose : ''
    };
  }

  window.WatchPlayerExtras = {
    bar: onBar, attach: onAttach, reuse: onReuse, opened: onOpened, destroy: onDestroy, state: state,
    // watch-playerbar.js key(): a Space or K (its play/pause key) goes here first (true: the card took it)
    space: upSpace,
    // the e2e's seam: the same path a real 'ended' takes
    _ended: function (s) { s = s || (CTX && CTX.focused && CTX.focused()); if (s) { X(s).ended = true; ended(s); } },
    // the e2e's seam: the next answer Up next gets (instead of main re-reading the service); null: main again
    _fake: function (next) { fakeNext = next ? { ok: true, next: next } : null; return true; }
  };
})();
