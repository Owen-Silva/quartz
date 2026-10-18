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
     video playing again) cancels Lumen's.
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

  // Runs in the service's page: listens (capture phase, so the video's own non-bubbling events reach it)
  // and reports the biggest video's height and whether it ended. No timers, no polling.
  var MEDIA_JS = '(function () {' +
    ' if (window.__lumenMedia) return 1; window.__lumenMedia = 1;' +
    ' var log = console.log.bind(console), lastKey = "";' +
    ' function top() { var vs = document.querySelectorAll("video"), b = null; for (var i = 0; i < vs.length; i++) { if (!b || vs[i].videoWidth * vs[i].videoHeight > b.videoWidth * b.videoHeight) b = vs[i]; } return b; }' +
    ' function say(e) { var v = e && e.target; if (!v || v.tagName !== "VIDEO") return; var t = top(); if (t && t !== v && e.type !== "ended") return;' +
    '   var m = { h: v.videoHeight || 0, w: v.videoWidth || 0, ended: e.type === "ended", playing: e.type === "playing" };' +
    '   var k = m.h + "x" + m.ended + m.playing; if (k === lastKey && !m.ended) return; lastKey = k;' +
    '   try { log(' + JSON.stringify(MEDIA_TAG) + ' + JSON.stringify(m)); } catch (err) {} }' +
    ' ["loadedmetadata", "resize", "playing", "ended"].forEach(function (n) { document.addEventListener(n, say, true); });' +
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
      // Playing again (the service's own up-next, or he pressed play): Lumen's card steps aside.
      x.ended = false;
      cancelUpNext(s, name(s.service) + ' went on by itself');
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
      if (m && typeof m === 'object') onMedia(s, { h: Math.max(0, Math.min(8640, Math.round(Number(m.h) || 0))), ended: m.ended === true, playing: m.playing === true });
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
    if (!x.up) x.up = { phase: 'none', el: null, timer: 0, left: 0, next: null, reason: '' };
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
    draw(s);
    var item = s.item;
    CTX.api.upNext(item).then(function (r) {
      if (up.phase !== 'asking' || s.item !== item) return;
      if (r && r.next && r.next.url) {
        up.next = r.next;
        up.phase = 'counting';
        up.left = UP_NEXT_SEC;
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

  function draw(s) {
    var up = card(s);
    var c = up.el;
    c.replaceChildren();
    c.hidden = up.phase === 'none';
    c.setAttribute('data-phase', up.phase);
    if (up.phase === 'none') { record(s); return; }
    var head = el('div', 'wpx-up-head', 'Up next on ' + name(s.service));
    c.appendChild(head);
    var acts = el('div', 'wpx-up-acts');
    if (up.phase === 'asking') {
      c.appendChild(el('p', 'wpx-up-sub', 'Reading ' + name(s.service) + ' for the next episode…'));
      acts.appendChild(button('wpx-up-cancel', 'Cancel', function () { cancelUpNext(s, 'Cancelled'); }));
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
    if (f && up.phase === 'counting') { try { f.focus({ preventScroll: true }); } catch (e) { /* not focusable */ } }
  }

  function record(s) {
    var up = s._x && s._x.up;
    if (!up) return;
    last.upnext = { phase: up.phase, left: up.left, next: up.next ? { title: up.next.title, subtitle: up.next.subtitle, url: up.next.url } : null, reason: up.reason, at: Date.now() };
  }

  function stopTimer(up) { if (up && up.timer) { clearInterval(up.timer); up.timer = 0; } }

  function cancelUpNext(s, why) {
    var up = s._x && s._x.up;
    if (!up) return;
    stopTimer(up);
    var was = up.phase;
    up.phase = 'none';
    if (up.el) { up.el.hidden = true; up.el.replaceChildren(); }
    if (why && (was === 'asking' || was === 'counting')) {
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
    // the e2e's seam: the same path a real 'ended' takes
    _ended: function (s) { if (s) { X(s).ended = true; ended(s); } }
  };
})();
