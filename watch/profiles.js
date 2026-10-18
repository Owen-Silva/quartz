/* ============================================================
   watch/profiles.js -- profiles inside Lumen (the page side).

   Disney+, Hulu and Prime stop on a "who's watching" picker, and
   every row Lumen shows belongs to one profile. So:
   - every service chip shows the active profile's avatar (the
     service's own picture when its reader saw one, else the
     initial) and, where the strip has room, its name;
   - the service's card has "Switch profile" (YouTube: "Switch
     account"), which opens the service's own picker in the player
     layer; main reads that service again when the layer closes;
   - the "who's watching" state says so, with "Pick profile"
     opening the same picker, instead of sending him to the site.
   watch.js calls in from renderStrip, fillPop and the freshness
   line; with this file missing, those stay as they were.
   ============================================================ */
(function () {
  'use strict';
  var P = window.LumenPlay;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function btn(cls, label, fn) {
    var b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(b, e); });
    return b;
  }
  function initial(name) { return P ? P.initial(name) : String(name || '').charAt(0).toUpperCase(); }

  /** The avatar: the service's picture, or the profile's initial when there is none (or it fails to load). */
  function avatar(s, cls) {
    var a = el('span', 'lp-av' + (cls ? ' ' + cls : ''));
    a.dataset.svc = s.id;
    a.setAttribute('aria-hidden', 'true');
    var letter = initial(s.profile);
    a.textContent = letter;
    if (s.avatar) {
      var img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onload = function () { a.textContent = ''; a.appendChild(img); a.classList.add('has-img'); };
      img.onerror = function () { a.title = 'Couldn’t load the profile picture; showing the initial'; };
      img.src = s.avatar;
    }
    return a;
  }

  function known(s) { return !!(s && s.state !== 'off' && (s.profile || s.avatar)); }

  /** The strip's chip: the avatar after the dot, the profile's name after the service's (wide windows). */
  function chip(main, s) {
    if (!known(s) || s.picker) return;
    var name = main.querySelector('.sp-name');
    var a = avatar(s, 'sm');
    main.insertBefore(a, name || null);
    if (s.profile) {
      var p = el('span', 'sp-prof', s.profile);
      if (name && name.nextSibling) main.insertBefore(p, name.nextSibling);
      else main.appendChild(p);
    }
    main.classList.add('has-prof');
  }

  /** The card's heading: the avatar before the service's name. */
  function popHead(h, s) {
    if (!known(s) || s.picker) return;
    h.insertBefore(avatar(s, 'md'), h.firstChild);
  }

  function pick(s, send, done) {
    send('profile', { service: s.id });
    if (typeof done === 'function') done();
  }

  /**
   * The card's actions: "Pick profile" (primary) on the who's-watching state, else "Switch profile"
   * when the service has profiles. `before`: the node they go in front of (Settings), or null.
   */
  function popActs(acts, s, send, closePop, before) {
    var pg = s.profilePage;
    if (!pg || s.state === 'off') return;
    var b;
    if (s.picker) {
      b = btn('btn sm primary lp-pick', 'Pick profile', function () { pick(s, send, function () { closePop(true); }); });
      b.title = 'Opens ' + s.name + '’s own “Who’s watching?” in Lumen; Lumen reads it again when you close it';
      acts.insertBefore(b, acts.firstChild);
      return;
    }
    if (s.state !== 'ok' && s.state !== 'never') return;
    b = btn('btn sm ghost lp-switch', pg.label || 'Switch profile', function () { pick(s, send, function () { closePop(true); }); });
    b.title = 'Opens ' + s.name + '’s own profile picker in Lumen' + (pg.where ? ' (' + pg.where + ')' : '') + '; Lumen reads it again when you close it';
    acts.insertBefore(b, before || null);
  }

  /** The card's words on the who's-watching state. */
  function popWords(p, s) {
    if (!s.picker) return false;
    p.appendChild(el('p', '', s.name + ' is asking who’s watching, so Lumen can’t read its rows until a profile is picked. Pick one here and Lumen reads ' + s.name + ' again.'));
    return true;
  }

  /** The freshness line's "Couldn't update ..." gets "Pick profile" when a service is on its picker. */
  function freshPick(f, failed, send) {
    var s = (failed || []).filter(function (x) { return x.picker && x.profilePage; })[0];
    if (!s) return;
    var b = btn('btn sm fresh-pick', 'Pick ' + s.name + ' profile', function () { pick(s, send); });
    b.setAttribute('aria-label', 'Pick a profile on ' + s.name);
    f.appendChild(b);
  }

  /** The page's "couldn't read your services" state: the same button, first. */
  function emptyPick(acts, en, send) {
    var s = (en || []).filter(function (x) { return x.picker && x.profilePage; })[0];
    if (!s) return;
    acts.insertBefore(btn('btn primary lp-pick', 'Pick a ' + s.name + ' profile', function () { pick(s, send); }), acts.firstChild);
  }

  // watch.js calls these mid-render: one that throws must never take the strip or the card down with it.
  function guard(fn, name) {
    return function () {
      try { return fn.apply(null, arguments); } catch (e) { try { console.warn('[lumen profiles] ' + name + ': ' + ((e && e.message) || e)); } catch (e2) { /* no console */ } return false; }
    };
  }
  window.LumenProfiles = { chip: guard(chip, 'chip'), popHead: guard(popHead, 'popHead'), popActs: guard(popActs, 'popActs'), popWords: guard(popWords, 'popWords'),
    freshPick: guard(freshPick, 'freshPick'), emptyPick: guard(emptyPick, 'emptyPick'), avatar: avatar };
})();
