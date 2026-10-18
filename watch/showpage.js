/*
 * watch/showpage.js -- Lumen's show and movie pages, drawn inside Lumen (watch.html).
 *
 * A tile of a show or film on Disney+, Hulu or Prime Video (or a YouTube video from a series
 * playlist) opens this page instead of the service's title page: the hero (art, title, year,
 * rating, synopsis, which service and profile), the big button (Resume S2 E5 / Play S1 E1 /
 * Play), season tabs with every episode (still, number, title, runtime, synopsis, a progress
 * bar and a watched check where the service said), "More like this", and the service's
 * watchlist state (read-only). Main (watch-shows-main.js) reads it; this file only draws.
 *
 * Every play is quartz-watch:open, so it plays in Lumen's player layer (openInLumen): the
 * episode's own proven address, or the title page when none is proven (watch/shows/model.js
 * playFor). Every state is drawn: loading (a skeleton, with TMDB's words as soon as they land),
 * a reader that failed (its reason, TMDB's episodes, Retry), signed out, paused, turned off, and
 * a title on none of his services (where it streams, "Watch on <service>" in the layer).
 *
 * watch.js calls in through window.LumenShows (small hooks): open(item) from a tile's click,
 * stageButton(item) for the stage, attach(bridge) at boot. createElement + textContent only.
 * Nothing runs at rest: no timers, no polling; images decode async and load lazily.
 */
(function () {
  'use strict';
  var M = window.LumenShowModel;
  var Shape = window.WatchShape;
  var B = { snap: function () { return null; }, signin: function () {}, settings: function () {} };
  var S = { root: null, body: null, crumb: null, cur: null, seq: 0, returnFocus: null, stack: [] };

  try {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'watch-shows.css';
    document.head.appendChild(link);
  } catch (e) { /* unstyled is still usable */ }

  /* ------------------------------------------------------------------ helpers */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null && text !== '') n.textContent = text;
    return n;
  }
  function btn(cls, text, fn, aria) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(b, e); });
    return b;
  }
  function say(line, msg) { try { console.log('quartz-watch:' + line + ' ' + JSON.stringify(msg || {})); } catch (e) { /* nothing to tell */ } }
  function svcName(id) { return M ? M.serviceName(id) : id; }
  function svcState(id) {
    var sn = B.snap();
    var list = sn && Array.isArray(sn.services) ? sn.services : [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function mins(sec) {
    if (!sec) return '';
    var m = Math.round(sec / 60);
    return m >= 60 ? Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '') : m + ' min';
  }
  function dot(parts) { return parts.filter(Boolean).join(' · '); }
  function img(box, url, alt) {
    if (!url) { box.classList.add('noart'); return; }
    var i = new Image();
    i.alt = alt || '';
    i.decoding = 'async';
    i.loading = 'lazy';
    i.referrerPolicy = 'no-referrer';
    i.onerror = function () { if (i.parentNode) i.parentNode.removeChild(i); box.classList.add('noart'); };
    i.src = url;
    box.appendChild(i);
  }
  function svcChip(id) {
    var c = el('span', 'shw-svc');
    c.dataset.svc = id || 'tmdb';
    c.appendChild(el('span', 'shw-svc-n', id ? 'On ' + svcName(id) : 'Not on your services'));
    var st = id ? svcState(id) : null;
    if (st && (st.profile || st.avatar) && !st.picker) {
      var av = el('span', 'lp-av sm');
      av.dataset.svc = id;
      av.setAttribute('aria-hidden', 'true');
      av.textContent = String(st.profile || '?').charAt(0).toUpperCase();
      if (st.avatar) {
        var a = new Image();
        a.alt = ''; a.decoding = 'async'; a.referrerPolicy = 'no-referrer';
        a.onload = function () { av.textContent = ''; av.appendChild(a); av.classList.add('has-img'); };
        a.src = st.avatar;
      }
      c.appendChild(av);
      if (st.profile) c.appendChild(el('span', 'shw-prof', st.profile));
    }
    return c;
  }

  /* ------------------------------------------------------------------ the overlay */

  function ensureRoot() {
    if (S.root) return;
    var r = el('div', 'shw');
    r.setAttribute('role', 'dialog');
    r.setAttribute('aria-modal', 'true');
    r.hidden = true;
    r.tabIndex = -1;
    var bar = el('div', 'shw-bar');
    var back = btn('icon-btn shw-back', '', function () { goBack(); }, 'Back');
    back.title = 'Back (Esc)';
    back.appendChild(el('span', 'shw-arrow', '←'));
    bar.appendChild(back);
    S.crumb = el('div', 'shw-crumb');
    bar.appendChild(S.crumb);
    bar.appendChild(btn('btn sm ghost', 'Close', function () { closeAll(); }, 'Close and go back to Lumen'));
    r.appendChild(bar);
    S.body = el('div', 'shw-body');
    r.appendChild(S.body);
    r.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); goBack(); }
      else if (e.key === 'Tab') trap(e);
    });
    r.addEventListener('wheel', function (e) { e.stopPropagation(); }, { passive: true });
    document.body.appendChild(r);
    S.root = r;
  }
  function trap(e) {
    var f = [].slice.call(S.root.querySelectorAll('button:not([disabled])')).filter(function (n) { return n.offsetParent !== null; });
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
  function goBack() {
    if (S.stack.length) { var prev = S.stack.pop(); show(prev, true); return; }
    closeAll();
  }
  function closeAll() {
    S.stack = [];
    S.cur = null;
    S.seq += 1;
    if (!S.root) return;
    S.root.hidden = true;
    S.body.replaceChildren();
    document.body.classList.remove('shw-open');
    var f = S.returnFocus;
    S.returnFocus = null;
    if (f && f.isConnected && typeof f.focus === 'function') { try { f.focus({ preventScroll: true }); } catch (e) { /* fine */ } }
  }

  /* A view: { req, answer, season, tile } -- req is what main is asked; tile is what the tile already knew. */
  function show(view, fromBack) {
    ensureRoot();
    if (!S.cur && !fromBack) S.returnFocus = document.activeElement;
    S.cur = view;
    S.root.hidden = false;
    document.body.classList.add('shw-open');
    S.root.setAttribute('aria-label', (view.tile.title || 'Title') + ' in Lumen');
    if (!view.answer) ask(view, false);
    render();
    S.body.scrollTop = 0;
    try { S.root.querySelector('.shw-back').focus({ preventScroll: true }); } catch (e) { /* fine */ }
  }
  function ask(view, force) {
    S.seq += 1;
    view.seq = S.seq;
    view.answer = null;
    view.loading = true;
    var q = view.req;
    say('show', { what: 'show', seq: view.seq, service: q.service || '', type: q.type || '', id: q.id || '', url: q.url || '', title: q.title || '', year: q.year || null, tmdbId: q.tmdbId || 0, tmdbType: q.tmdbType || '', force: !!force });
  }
  function push(view) { if (S.cur) S.stack.push(S.cur); show(view); }

  window.__applyWatchShow = function (a) {
    var v = S.cur;
    if (!a || !v || a.seq !== v.seq) return;
    if (a.what === 'season') { applySeason(v, a); return; }
    if (a.partial) { v.partial = a; render(); return; }
    v.answer = a;
    v.loading = false;
    v.partial = null;
    var sh = a.show;
    if (sh && sh.type === 'show' && (v.season === undefined || v.season === null)) v.season = M.startSeason(sh);
    render();
  };

  function applySeason(v, a) {
    var sh = v.answer && v.answer.show;
    if (!sh) return;
    var s = sh.seasons.filter(function (x) { return x.n === a.n; })[0];
    if (!s) return;
    s.asking = false;
    if (a.state === 'ok' && a.season) { s.episodes = a.season.episodes; s.loaded = true; s.fromTmdb = a.source === 'tmdb'; s.error = ''; }
    else s.error = a.reason || 'that season did not load';
    if (v.season === a.n) render();
  }

  /* ------------------------------------------------------------------ drawing */

  function render() {
    var v = S.cur;
    if (!v) return;
    var a = v.answer;
    var p = v.partial;
    var sh = (a && a.show) || (p && p.show) || null;
    S.crumb.replaceChildren(el('span', 'shw-crumb-s', v.req.service ? svcName(v.req.service) : 'Lumen'), el('span', 'shw-crumb-t', (sh && sh.title) || v.tile.title || ''));
    var nodes = [];
    nodes.push(hero(v, sh));
    if (a && a.state === 'elsewhere') nodes.push(elsewhere(a));
    if (sh && sh.type === 'show' && sh.seasons.length) nodes.push(seasons(v, sh));
    else if (!sh && v.loading) nodes.push(skeletonEpisodes());
    if (sh && sh.more.length) nodes.push(moreLike(sh));
    if (a && a.attribution && (a.state !== 'ok' || a.providers.length)) nodes.push(el('p', 'shw-attr', a.state === 'elsewhere' ? a.attribution : 'Where-to-watch and TMDB data: ' + a.attribution.replace(/^Where-to-watch data from /, '')));
    S.body.replaceChildren.apply(S.body, nodes);
  }

  function banner(kind, words, acts) {
    var b = el('div', 'shw-note ' + kind);
    b.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    b.appendChild(el('span', 'shw-dot'));
    b.appendChild(el('span', 'shw-note-t', words));
    (acts || []).forEach(function (x) { b.appendChild(x); });
    return b;
  }

  function stateNote(v) {
    var a = v.answer;
    var svc = v.req.service;
    var name = svcName(svc);
    var retry = function () { return btn('btn sm', 'Retry', function () { ask(v, true); render(); }); };
    var openSvc = function () { return v.req.url ? btn('btn sm ghost', 'Open on ' + name, function () { play(v.req.url, v.tile.title, ''); }) : null; };
    if (!a) {
      if (v.partial) return banner('busy', 'Reading ' + name + ' for your progress… episodes below are from TMDB until it answers.');
      return banner('busy', svc ? 'Reading ' + name + '…' : 'Looking this up on TMDB…');
    }
    if (a.state === 'ok' || a.state === 'elsewhere') return null;
    var tm = a.show ? (a.show.type === 'movie' ? ' The details are from TMDB; your progress isn’t shown.' : ' Episodes are from TMDB; your progress isn’t shown.') : (a.tmdbReason ? ' TMDB: ' + a.tmdbReason + '.' : '');
    if (a.state === 'signed-out') return banner('warn', 'You’re signed out of ' + name + ' in Quartz.' + tm, [btn('btn sm', 'Sign in', function () { B.signin(svc); })]);
    if (a.state === 'off') return banner('warn', name + ' is off in Settings > Lumen.' + tm, [btn('btn sm', 'Settings', function () { B.settings(); })]);
    if (a.state === 'paused') return banner('warn', 'Lumen’s reader is paused: ' + String(a.reason || '').replace(/^Lumen’s reader is /, '') + '.' + tm, [retry()]);
    if (a.picker) return banner('warn', name + ' is asking who’s watching.' + tm, [btn('btn sm', 'Pick profile', function () { say('profile', { service: svc }); })]);
    var why = 'Couldn’t read ' + (svc ? name : 'this title') + ': ' + (a.reason || 'no reason given') + '.' + tm;
    return banner(a.show ? 'warn' : 'err', why, [retry(), openSvc()].filter(Boolean));
  }

  function hero(v, sh) {
    var h = el('section', 'shw-hero');
    var txt = el('div', 'shw-txt');
    var eb = el('div', 'shw-eyebrow');
    eb.appendChild(svcChip(v.req.service));
    var a = v.answer;
    if (sh && sh.watchlist !== null && v.req.service) {
      var wl = el('span', 'shw-wl' + (sh.watchlist ? ' on' : ''), sh.watchlist ? (v.req.service === 'hulu' ? 'In My Stuff' : 'On your Watchlist') : (v.req.service === 'hulu' ? 'Not in My Stuff' : 'Not on your Watchlist'));
      wl.title = 'From ' + svcName(v.req.service) + ' (read-only here)';
      eb.appendChild(wl);
    }
    txt.appendChild(eb);
    var title = (sh && sh.title) || v.tile.title || '';
    var h1 = el('h1', 'shw-h1' + (title.length > 40 ? ' long' : title.length > 22 ? ' mid' : ''), title);
    txt.appendChild(h1);
    if (sh) {
      var nS = sh.seasons.filter(function (x) { return x.n > 0; }).length;
      txt.appendChild(el('div', 'shw-meta', dot([sh.year ? String(sh.year) : '', sh.rating, sh.genres.slice(0, 3).join(', '),
        sh.type === 'movie' ? mins(sh.runtimeSec) : nS ? nS + (nS === 1 ? ' season' : ' seasons') : ''])));
      if (sh.synopsis) txt.appendChild(el('p', 'shw-syn', sh.synopsis));
    } else {
      var sk = el('div', 'shw-sk-lines');
      sk.appendChild(el('i')); sk.appendChild(el('i')); sk.appendChild(el('i'));
      txt.appendChild(sk);
    }
    var note = stateNote(v);
    var acts = el('div', 'shw-acts');
    if (sh && (!a || a.state !== 'elsewhere')) {
      var plan = M.resumePlan(sh);
      var where = plan.url || v.req.url;
      if (where) {
        var big = btn('btn primary shw-play', '', function () { play(where, title + (plan.ep ? ' · ' + M.epLabel(plan.ep) : ''), plan.fallback); },
          plan.label + ' ' + title + ' on ' + svcName(sh.service || v.req.service));
        big.appendChild(el('span', 'shw-play-i'));
        big.appendChild(document.createTextNode(plan.label));
        acts.appendChild(big);
        if (plan.ep && plan.ep.progress !== null && plan.ep.progress > 0 && !M.done(plan.ep)) {
          var left = plan.ep.runtimeSec ? Math.max(1, Math.round(plan.ep.runtimeSec * (1 - plan.ep.progress) / 60)) + ' min left' : '';
          acts.appendChild(el('span', 'shw-left', dot([plan.ep.title, left])));
        } else if (plan.ep && plan.ep.title) acts.appendChild(el('span', 'shw-left', plan.ep.title));
        if (!plan.proven && plan.why) acts.appendChild(el('span', 'shw-why', plan.why));
      }
      if (v.req.url && where !== v.req.url) acts.appendChild(btn('btn ghost sm', 'Title page', function () { play(v.req.url, title, ''); }, 'Open the ' + svcName(v.req.service) + ' title page in Lumen'));
    } else if (!sh) {
      var skb = el('span', 'shw-sk-btn');
      skb.setAttribute('aria-hidden', 'true');
      acts.appendChild(skb);
    }
    if (acts.childNodes.length) txt.appendChild(acts);
    if (note) txt.appendChild(note);
    if (sh && sh.notes.length && a && a.state === 'ok') sh.notes.forEach(function (n) { txt.appendChild(el('p', 'shw-fine', n)); });
    h.appendChild(txt);
    var pic = el('div', 'shw-pic');
    var frame = el('div', 'shw-art');
    frame.setAttribute('aria-hidden', 'true');
    var art = (sh && sh.image) || v.tile.image || '';
    if (art) img(frame, art, ''); else if (sh || !v.loading) frame.classList.add('noart'); else frame.classList.add('sk');
    pic.appendChild(frame);
    h.appendChild(pic);
    return h;
  }

  function skeletonEpisodes() {
    var w = el('section', 'shw-eps-wrap');
    var list = el('div', 'shw-eps');
    for (var i = 0; i < 4; i++) {
      var r = el('div', 'shw-ep sk');
      r.appendChild(el('span', 'shw-thumb'));
      var t = el('span', 'shw-ep-t');
      t.appendChild(el('i')); t.appendChild(el('i'));
      r.appendChild(t);
      list.appendChild(r);
    }
    w.appendChild(list);
    return w;
  }

  function seasons(v, sh) {
    var w = el('section', 'shw-eps-wrap');
    var head = el('div', 'shw-sec-h');
    head.appendChild(el('h2', '', sh.service === 'youtube' ? 'Videos' : 'Episodes'));
    var tabs = el('div', 'shw-tabs');
    tabs.setAttribute('role', 'tablist');
    var cur = sh.seasons.filter(function (x) { return x.n === v.season; })[0] || sh.seasons[0];
    v.season = cur.n;
    if (sh.seasons.length > 1) {
      sh.seasons.forEach(function (s) {
        var t = btn('shw-tab' + (s.n === cur.n ? ' on' : ''), s.label, function () { pickSeason(v, s.n); });
        t.setAttribute('role', 'tab');
        t.setAttribute('aria-selected', s.n === cur.n ? 'true' : 'false');
        t.dataset.n = String(s.n);
        tabs.appendChild(t);
      });
      head.appendChild(tabs);
    }
    w.appendChild(head);
    if (cur.fromTmdb && cur.episodes.length) w.appendChild(el('p', 'shw-fine', 'This season’s episodes are from TMDB: ' + svcName(sh.service || v.req.service) + ' didn’t send them, so there’s no progress here.'));
    var list = el('div', 'shw-eps');
    list.setAttribute('role', 'tabpanel');
    if (!cur.episodes.length) {
      if (cur.asking) { w.appendChild(skeletonEpisodes()); return w; }
      var nm = svcName(sh.service || v.req.service);
      var acts = [];
      if (cur.url || v.req.url) acts.push(btn('btn sm', 'Open ' + cur.label + ' on ' + nm, function () { play(cur.url || v.req.url, sh.title + ' · ' + cur.label, ''); }));
      w.appendChild(banner(cur.error ? 'warn' : 'idle', cur.error ? cur.label + ' didn’t load: ' + cur.error + '.' : nm + ' hasn’t sent ' + cur.label + ' yet.', acts));
      return w;
    }
    var plan = M.resumePlan(sh);
    cur.episodes.forEach(function (ep) { list.appendChild(episodeRow(v, sh, ep, plan.ep && plan.ep.id === ep.id && plan.ep.e === ep.e && plan.ep.s === ep.s)); });
    w.appendChild(list);
    return w;
  }

  function pickSeason(v, n) {
    v.season = n;
    var sh = v.answer && v.answer.show;
    var s = sh && sh.seasons.filter(function (x) { return x.n === n; })[0];
    if (s && !s.episodes.length && !s.asking && !s.error) {
      s.asking = true;
      var a = v.answer;
      say('show', { what: 'season', seq: v.seq, key: a.key || '', service: v.req.service || '', id: v.req.id || '', n: n, tmdbId: a.tmdbType === 'tv' ? a.tmdbId : 0, url: s.url || '' });
    }
    render();
    var t = S.body.querySelector('.shw-tab[data-n="' + n + '"]');
    if (t) try { t.focus({ preventScroll: true }); } catch (e) { /* fine */ }
  }

  function episodeRow(v, sh, ep, isNext) {
    var r = btn('shw-ep' + (isNext ? ' next' : '') + (M.done(ep) ? ' done' : ''), '', function () {
      var p = M.playFor(sh, ep);
      if (p.url) play(p.url, sh.title + ' · ' + M.epLabel(ep) + (ep.title ? ' · ' + ep.title : ''), p.fallback);
    });
    var th = el('span', 'shw-thumb');
    img(th, ep.image, '');
    if (ep.progress !== null && ep.progress > 0 && !M.done(ep)) {
      var bar = el('span', 'shw-prog');
      var i = el('i');
      i.style.setProperty('--p', String(ep.progress));
      bar.appendChild(i);
      th.appendChild(bar);
    }
    if (M.done(ep)) { var ck = el('span', 'shw-check'); ck.setAttribute('aria-hidden', 'true'); th.appendChild(ck); }
    r.appendChild(th);
    var t = el('span', 'shw-ep-t');
    var l1 = el('span', 'shw-ep-h');
    l1.appendChild(el('b', '', (ep.e !== null ? ep.e + '. ' : '') + (ep.title || 'Episode ' + ep.e)));
    l1.appendChild(el('span', 'shw-ep-m', dot([mins(ep.runtimeSec), M.done(ep) ? 'Watched' : ep.progress !== null && ep.progress > 0 ? Math.round(ep.progress * 100) + '% watched' : isNext ? 'Up next' : ''])));
    t.appendChild(l1);
    if (ep.synopsis) t.appendChild(el('span', 'shw-ep-s', ep.synopsis));
    r.appendChild(t);
    var p = M.playFor(sh, ep);
    r.setAttribute('aria-label', dot([M.epLabel(ep), ep.title, mins(ep.runtimeSec), M.done(ep) ? 'watched' : ep.progress ? Math.round(ep.progress * 100) + ' percent watched' : '']) + '. ' + (p.proven ? 'Plays in Lumen.' : 'Opens the title page in Lumen.'));
    return r;
  }

  function moreLike(sh) {
    var w = el('section', 'shw-more');
    w.appendChild(el('h2', '', 'More like this'));
    var grid = el('div', 'shw-grid');
    sh.more.forEach(function (m) {
      var req = m.url ? M.requestFor({ url: m.url, title: m.title, year: m.year, type: m.type, service: m.service, kind: 'rec' }) : null;
      var can = !!req || !!m.tmdbId;
      var c = btn('shw-card' + (can ? '' : ' off'), '', function () {
        if (req) push(viewFor(req, { title: m.title, image: m.image }));
        else if (m.tmdbId) push(viewFor({ service: '', type: m.type, id: '', url: '', title: m.title, year: m.year, tmdbId: m.tmdbId, tmdbType: m.tmdbType }, { title: m.title, image: m.image }));
      });
      if (!can) c.disabled = true;
      var art = el('span', 'shw-card-a');
      img(art, m.image, '');
      if (m.service) { var mk = el('span', 'chip oa mk', Shape && Shape.serviceById(m.service) ? Shape.serviceById(m.service).short : svcName(m.service)); mk.dataset.svc = m.service; art.appendChild(mk); }
      c.appendChild(art);
      var meta = el('span', 'shw-card-m');
      meta.appendChild(el('b', '', m.title));
      meta.appendChild(el('span', '', dot([m.year ? String(m.year) : '', m.type === 'movie' ? 'Film' : m.type === 'show' ? 'Series' : ''])));
      c.appendChild(meta);
      grid.appendChild(c);
    });
    w.appendChild(grid);
    return w;
  }

  function elsewhere(a) {
    var w = el('section', 'shw-else');
    w.appendChild(el('h2', '', 'Where it streams'));
    var list = el('div', 'shw-prov');
    var words = { stream: 'Stream', free: 'Free', ads: 'With ads', rent: 'Rent', buy: 'Buy' };
    if (!a.providers.length) list.appendChild(el('p', 'shw-fine', 'TMDB lists nowhere to stream this in the US right now.'));
    a.providers.forEach(function (p) {
      var row = el('div', 'shw-prov-r');
      var logo = el('span', 'shw-prov-l');
      img(logo, p.logo, '');
      row.appendChild(logo);
      row.appendChild(el('span', 'shw-prov-n', p.name));
      row.appendChild(el('span', 'shw-prov-t', words[p.type] || p.type));
      if (p.url) {
        var label = p.service ? 'Watch on ' + svcName(p.service) : 'See where to watch';
        row.appendChild(btn('btn sm' + (p.service ? '' : ' ghost'), label, function () { play(p.url, (a.show && a.show.title ? a.show.title + ' · ' : '') + p.name, ''); }, label + ': ' + p.name));
      }
      list.appendChild(row);
    });
    w.appendChild(list);
    if (a.watchLink) w.appendChild(btn('btn ghost sm', 'All options on TMDB', function () { play(a.watchLink, 'Where to watch', ''); }));
    return w;
  }

  function play(url, title, fallback) {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return;
    var m = { url: url, title: String(title || '').slice(0, 200) };
    if (fallback) m.fallback = fallback;
    say('open', m);
  }

  /* ------------------------------------------------------------------ the way in */

  function viewFor(req, tile) { return { req: req, tile: tile || {}, answer: null, partial: null, season: null, seq: 0, loading: true }; }

  /** A tile's click: true when it opened a show page (the caller does nothing more). */
  function open(item) {
    if (!M) return false;
    var req = M.requestFor(item);
    if (!req) return false;
    if (S.cur) closeAll();
    show(viewFor(req, { title: item.title, image: item.image }));
    return true;
  }

  /** A title on none of his services (a TMDB hit): its page with where it streams. */
  function openTmdb(hit) {
    if (!hit || !hit.title) return false;
    if (S.cur) closeAll();
    show(viewFor({ service: '', type: hit.mediaType === 'movie' ? 'movie' : 'show', id: '', url: '', title: hit.title, year: hit.year || null, tmdbId: hit.tmdbId || 0, tmdbType: hit.mediaType || '' }, { title: hit.title, image: hit.image }));
    return true;
  }

  /** The stage's secondary button for a title with a show page, or null. */
  function stageButton(item) {
    if (!M || !M.requestFor(item)) return null;
    var label = item && item.type === 'movie' ? 'Details' : 'Episodes';
    return btn('btn ghost', label, function () { open(item); }, label + ' for ' + (item.title || 'this title') + ' in Lumen');
  }

  window.LumenShows = {
    attach: function (b) { if (b && typeof b === 'object') { if (typeof b.snap === 'function') B.snap = b.snap; if (typeof b.signin === 'function') B.signin = b.signin; if (typeof b.settings === 'function') B.settings = b.settings; } },
    open: open, openTmdb: openTmdb, stageButton: stageButton, close: closeAll,
    isOpen: function () { return !!S.cur; },
    _state: function () { var v = S.cur; return v ? { req: v.req, state: v.answer ? v.answer.state : 'loading', season: v.season, seq: v.seq, partial: !!v.partial, depth: S.stack.length } : null; }
  };
})();
