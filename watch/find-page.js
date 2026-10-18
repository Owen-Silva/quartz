/* ============================================================
   watch/find-page.js -- Lumen's one search box, the page half.

   Typing still shows the quick "where to watch" grid (watch.js:
   his own rows, YouTube, TMDB). ENTER asks every service's OWN
   search (quartz-watch:find; watch-find-main.js reads Disney+,
   Hulu and Prime Video one at a time in the hidden reader, plus
   YouTube and TMDB) and draws this results page, filling it in
   as each service answers (window.__applyWatchFind):

     Best match   one tile per title; a chip per service that has
                  it (his signed-in ones first), Included / Rent
                  or buy, Resume and progress from his own rows
     Disney+ / Hulu / Prime Video   each service's own results, in
                  its order, each row in its own state (searching,
                  failed with why + Retry, "Sign in to search X")
     YouTube      channels, then videos

   Every click plays or opens in the Lumen layer (quartz-watch:open;
   main decides layer / Edge). Keys: / focuses the box (watch.js),
   Enter searches, Esc clears, the arrows move between tiles.
   Recent searches stay in this page's localStorage, with Clear.
   Everything is drawn with createElement + textContent.
   ============================================================ */
(function () {
  'use strict';
  var Find = window.WatchFind;
  var Shape = window.WatchShape;
  var RECENT_KEY = 'lumen.recentSearches';
  var RECENT_MAX = 8;
  var SVC_ORDER = ['disney', 'hulu', 'prime'];

  var B = null;   // the bridge watch.js hands over: send, openUrl, signin, snap, services, results, input, clear, artImage, settings
  var F = { open: false, q: '', seq: 0, order: SVC_ORDER.slice(), services: {}, youtube: null, tmdb: null, done: false, fatal: '', queued: false, startedAt: 0 };
  var R = { el: null, items: [], idx: -1 };   // the recent-searches panel

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null && text !== '') e.textContent = String(text);
    return e;
  }
  function btn(cls, text, onClick, aria) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    if (aria) b.setAttribute('aria-label', aria);
    return b;
  }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function txt(v, max) { return Shape ? Shape.cleanText(v, max || 300) : str(v).slice(0, max || 300); }
  function svcInfo(id) { return (Shape && Shape.serviceById(id)) || { id: id, name: id, short: id }; }
  function svcName(id) { return svcInfo(id).name; }
  function svcShort(id) { return svcInfo(id).short || svcName(id); }
  function cap(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function lenText(sec) {
    if (!sec) return '';
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function isTmdb(u) { try { var h = new URL(u).hostname; return /(^|\.)themoviedb\.org$/.test(h); } catch (e) { return false; } }
  function isYouTube(u) { return !!(Shape && Shape.serviceForUrl(u) === 'youtube'); }

  /* ---------------------------------------------------------- what main sends */

  function cleanItem(raw, service) {
    var c = Shape ? Shape.cleanItem(raw) : null;
    if (!c || (service && c.service !== service)) return null;
    c.offer = Find && Find.OFFERS.indexOf(raw.offer) !== -1 ? raw.offer : '';
    return c;
  }
  function cleanSvcAnswer(id, a) {
    var x = a && typeof a === 'object' ? a : {};
    return {
      state: Find.STATES.indexOf(x.state) !== -1 ? x.state : 'error',
      reason: txt(x.reason, 300),
      items: arr(x.items).map(function (it) { return cleanItem(it, id); }).filter(Boolean).slice(0, 40),
      cached: x.cached === true,
      age: typeof x.age === 'number' && isFinite(x.age) ? x.age : 0
    };
  }
  function cleanYouTube(a) {
    var x = a && typeof a === 'object' ? a : {};
    var state = x.ok === true || x.state === 'ok' ? 'ok' : (x.state === 'off' ? 'off' : 'error');
    return {
      state: state,
      reason: txt(x.reason, 300),
      items: arr(x.items).map(function (it) { return cleanItem(it, 'youtube'); }).filter(Boolean).slice(0, 20),
      channels: arr(x.channels).map(function (c) {
        if (!c || typeof c !== 'object') return null;
        var url = Shape ? Shape.cleanHttps(c.url) : '';
        if (!url || !isYouTube(url)) return null;
        return { name: txt(c.name, 100), url: url, image: Shape.cleanHttps(c.image), subs: txt(c.subs, 60), handle: txt(c.handle, 100) };
      }).filter(function (c) { return c && c.name; }).slice(0, 6)
    };
  }
  function cleanTmdb(a) {
    var x = a && typeof a === 'object' ? a : {};
    return {
      state: txt(x.state, 20) || 'error',
      reason: txt(x.reason, 300),
      attribution: txt(x.attribution, 120),
      results: arr(x.results).map(function (r) {
        if (!r || typeof r !== 'object' || !txt(r.title, 200)) return null;
        var wl = Shape.cleanHttps(r.watchLink);
        return {
          title: txt(r.title, 200), year: Number(r.year) || 0, mediaType: r.mediaType === 'movie' || r.mediaType === 'tv' ? r.mediaType : '',
          image: Shape.cleanHttps(r.image), watchLink: wl && isTmdb(wl) ? wl : '',
          providers: arr(r.providers).map(function (p) {
            if (!p || typeof p !== 'object' || !txt(p.name, 60)) return null;
            var svc = Shape.serviceById(p.service) ? p.service : '';
            var url = Shape.cleanHttps(p.url);
            return { name: txt(p.name, 60), type: txt(p.type, 10), service: svc, url: url && (Shape.serviceForUrl(url) || isTmdb(url)) ? url : '' };
          }).filter(Boolean).slice(0, 20)
        };
      }).filter(Boolean).slice(0, 20)
    };
  }

  window.__applyWatchFind = function (part) {
    try {
      if (!part || typeof part !== 'object' || !F.open || part.seq !== F.seq) return;   // a stale answer: ignored
      switch (part.kind) {
        case 'start':
          if (!part.only && Array.isArray(part.order)) F.order = part.order.filter(function (id) { return SVC_ORDER.indexOf(id) !== -1; });
          Object.keys(part.services || {}).forEach(function (id) {
            if (SVC_ORDER.indexOf(id) !== -1) F.services[id] = cleanSvcAnswer(id, part.services[id]);
          });
          break;
        case 'service':
          if (SVC_ORDER.indexOf(part.service) !== -1) F.services[part.service] = cleanSvcAnswer(part.service, part.answer);
          break;
        case 'youtube': F.youtube = cleanYouTube(part.answer); break;
        case 'tmdb': F.tmdb = cleanTmdb(part.answer); break;
        case 'done': if (!part.only) F.done = true; break;
        case 'fatal': F.fatal = txt(part.reason, 200) || 'search failed'; break;
        default: return;
      }
      soon();
    } catch (err) {
      if (B && B.toast) B.toast('Couldn’t show these search results: ' + txt((err && err.message) || String(err), 160), { err: true });
    }
  };

  /* ---------------------------------------------------------- searching */

  function submit(q, force) {
    var text = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text || !B) return false;
    F.seq += 1;
    F.open = true;
    F.q = text;
    F.order = SVC_ORDER.slice();
    F.services = {};
    F.youtube = null;
    F.tmdb = null;
    F.done = false;
    F.fatal = '';
    F.startedAt = Date.now();
    remember(text);
    hideRecents();
    B.send('find', force ? { q: text, seq: F.seq, force: true } : { q: text, seq: F.seq });
    render();
    return true;
  }
  function retry(id) {
    if (!F.open || !B) return;
    F.services[id] = { state: 'loading', reason: '', items: [] };
    B.send('find', { q: F.q, seq: F.seq, only: id, force: true });
    render();
  }
  function owns(q) { return F.open && q === F.q; }
  function close() { if (F.open) { F.open = false; F.seq += 1; } }

  var queued = false;
  function soon() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; if (F.open && B && B.isCurrent(F.q)) render(); });
  }

  /* ---------------------------------------------------------- the page */

  function localItems() {
    var snap = B.snap();
    return snap && Array.isArray(snap.items) ? snap.items : [];
  }
  function signedIn() {
    var out = {};
    arr(B.services()).forEach(function (s) { if (s && s.enabled && (s.state === 'ok' || (s.state === 'error' && s.lastOkAt))) out[s.id] = true; });
    return out;
  }

  function render() {
    if (!B || !F.open) return;
    var keep = focusKey();
    var m = Find.merge({ q: F.q, order: F.order, services: F.services, youtube: F.youtube || { state: 'loading' }, tmdb: F.tmdb, local: localItems(), signedIn: signedIn() });
    var frag = document.createDocumentFragment();
    var page = el('div', 'fd');
    page.setAttribute('data-q', F.q);

    var head = el('div', 'res-h fd-h');
    head.appendChild(el('h2', '', 'Results for “' + F.q + '”'));
    head.appendChild(statusLine(m));
    head.appendChild(btn('btn sm', 'Clear search', function () { B.clear(); }));
    page.appendChild(head);
    if (F.fatal) page.appendChild(note('err', 'Search didn’t work.', cap(F.fatal) + '.'));

    page.appendChild(bestSection(m));
    m.rows.forEach(function (row) { page.appendChild(serviceSection(row)); });
    page.appendChild(youtubeSection(m.youtube));
    page.appendChild(tmdbFoot());
    frag.appendChild(page);
    B.results.replaceChildren(frag);
    restoreFocus(keep);
  }

  function statusLine(m) {
    var s = el('span', 'sub fd-status');
    s.setAttribute('role', 'status');
    var waiting = m.rows.filter(function (r) { return r.state === 'loading' || r.state === 'queued'; }).map(function (r) { return svcName(r.service); });
    if (!F.youtube) waiting.push('YouTube');
    if (waiting.length) {
      s.appendChild(spinner());
      s.appendChild(document.createTextNode('Searching ' + listText(waiting) + '…'));
    } else {
      var n = m.best.length;
      s.textContent = (n ? n + (n === 1 ? ' title' : ' titles') + ' · ' : '') + 'searched Disney+, Hulu, Prime Video and YouTube';
    }
    return s;
  }
  function listText(a) { return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  function spinner() { var sp = el('span', 'fd-spin'); sp.setAttribute('aria-hidden', 'true'); return sp; }

  function section(key, title, aside) {
    var sec = el('section', 'fd-sec');
    sec.dataset.sec = key;
    var h = el('div', 'fd-sh');
    if (key !== 'best') { var mk = el('span', 'chip mk fd-mk', svcShort(key)); mk.dataset.svc = key; h.appendChild(mk); }
    h.appendChild(el('h3', '', title));
    if (aside) h.appendChild(aside);
    sec.appendChild(h);
    return sec;
  }

  function bestSection(m) {
    var sec = section('best', 'Best match');
    if (!m.best.length) {
      if (m.pending || !F.youtube) {
        sec.appendChild(skeleton('fd-grid', 4));
      } else {
        var any = m.rows.some(function (r) { return r.tiles.length; });
        sec.appendChild(note('calm', any ? 'No title matches “' + F.q + '” exactly.' : 'None of your services has “' + F.q + '”.',
          any ? 'Each service’s own results are below.' : 'Check the spelling, or try fewer words.'));
      }
      return sec;
    }
    var grid = el('div', 'fd-grid');
    m.best.forEach(function (g) { grid.appendChild(titleTile(g)); });
    sec.appendChild(grid);
    return sec;
  }

  /* One title, whichever services have it. */
  function titleTile(g) {
    var t = el('div', 'fd-tile fd-title');
    var first = g.chips[0];
    var hit = btn('fd-hit', '', function () { openChip(g, first); });
    hit.dataset.nav = 'b:' + g.key;
    hit.setAttribute('aria-label', (g.resume ? 'Resume ' : 'Play ') + g.title + (first ? ' on ' + svcName(first.service) : ''));
    var art = artBox({ title: g.title, image: g.image, images: g.images, service: first ? first.service : '' });
    if (g.progress !== null) art.appendChild(progressBar(g.progress));
    if (g.resume) art.appendChild(el('span', 'fd-resume', 'Resume'));
    hit.appendChild(art);
    var words = el('span', 'fd-t');
    words.appendChild(el('b', '', g.title));
    var meta = [g.year ? String(g.year) : '', g.type === 'movie' ? 'Movie' : (g.type === 'show' ? 'Series' : '')].filter(Boolean).join(' · ');
    if (meta) words.appendChild(el('span', '', meta));
    hit.appendChild(words);
    t.appendChild(hit);
    var chips = el('div', 'fd-chips');
    g.chips.forEach(function (c) {
      var word = Find.offerWord(c.offer);
      var b = btn('fd-chip' + (c.offer === 'rent' || c.offer === 'buy' || c.offer === 'upgrade' || c.offer === 'channel' ? ' pay' : ' inc'), '', function () { openChip(g, c); },
        (c.resume ? 'Resume ' : 'Open ') + g.title + ' on ' + svcName(c.service) + (word ? ', ' + word : ''));
      b.dataset.svc = c.service;
      b.appendChild(el('b', '', svcShort(c.service)));
      if (word) b.appendChild(el('span', '', word));
      if (c.source === 'tmdb') b.title = 'Where-to-watch data from JustWatch, via TMDB';
      chips.appendChild(b);
    });
    if (g.elsewhere && g.elsewhere.length) {
      var also = el('span', 'fd-else', 'Also on ' + g.elsewhere.slice(0, 3).join(', '));
      chips.appendChild(also);
    }
    if (g.watchLink) {
      var w = btn('fd-chip look', 'Where to watch', function () { B.send('open', { url: g.watchLink, title: 'Where to watch ' + g.title }); },
        'Where to watch ' + g.title + ' (TMDB)');
      chips.appendChild(w);
    }
    t.appendChild(chips);
    return t;
  }
  function openChip(g, c) {
    if (!c) { if (g.watchLink) B.send('open', { url: g.watchLink, title: 'Where to watch ' + g.title }); return; }
    if (c.url && isTmdb(c.url)) { B.send('open', { url: c.url, title: g.title }); return; }
    B.openUrl(c.url, g.title);
  }

  function serviceSection(row) {
    var id = row.service;
    var name = svcName(id);
    var aside = null;
    if (row.state === 'loading' || row.state === 'queued') {
      aside = el('small', 'fd-state');
      aside.appendChild(spinner());
      aside.appendChild(document.createTextNode(row.state === 'queued' ? 'Waiting its turn' : 'Searching ' + name + '…'));
    } else if (row.state === 'ok') {
      aside = el('small', 'fd-state', row.tiles.length + (row.tiles.length === 1 ? ' result' : ' results') + (row.cached ? ' · from your search a moment ago' : ''));
    }
    var sec = section(id, name, aside);
    sec.dataset.state = row.state;
    if (row.state === 'ok') {
      var r = el('div', 'fd-row');
      row.tiles.forEach(function (tile) { r.appendChild(serviceTile(tile)); });
      sec.appendChild(r);
    } else if (row.state === 'loading' || row.state === 'queued') {
      sec.appendChild(skeleton('fd-row', 5));
    } else if (row.state === 'signed-out') {
      var n = note('calm', 'You’re signed out of ' + name + '.', 'Lumen searches ' + name + ' once you sign in.');
      n.appendChild(btn('btn sm fd-sign', 'Sign in to search ' + name, function () { B.signin(id); }));
      sec.appendChild(n);
    } else if (row.state === 'off') {
      var o = note('calm', name + ' is off.', 'Turn it on in Settings > Lumen to search it here.');
      o.appendChild(btn('btn sm', 'Open Settings', function () { B.settings(); }));
      sec.appendChild(o);
    } else if (row.state === 'empty') {
      sec.appendChild(note('calm', name + ' found nothing for “' + F.q + '”.', ''));
    } else {
      var e = note(row.state === 'paused' ? 'warn' : 'err', row.state === 'paused' ? name + ' search is paused.' : name + ' search didn’t work.', row.reason ? cap(row.reason) + '.' : '');
      e.appendChild(btn('btn sm', 'Retry', function () { retry(id); }, 'Search ' + name + ' again'));
      sec.appendChild(e);
    }
    return sec;
  }

  function serviceTile(tile) {
    var t = el('div', 'fd-tile');
    var url = tile.resume && tile.resumeUrl ? tile.resumeUrl : tile.url;
    var hit = btn('fd-hit', '', function () { B.openUrl(url, tile.title); });
    hit.dataset.nav = 's:' + tile.id;
    var word = Find.offerWord(tile.offer);
    hit.setAttribute('aria-label', (tile.resume ? 'Resume ' : 'Play ') + tile.title + ' on ' + svcName(tile.service) + (word ? ', ' + word : ''));
    var art = artBox(tile);
    if (tile.progress !== null) art.appendChild(progressBar(tile.progress));
    if (tile.resume) art.appendChild(el('span', 'fd-resume', 'Resume'));
    else if (tile.onList) art.appendChild(el('span', 'fd-resume list', 'On your list'));
    hit.appendChild(art);
    var words = el('span', 'fd-t');
    words.appendChild(el('b', '', tile.title));
    var sub = [word, tile.subtitle].filter(Boolean).join(' · ');
    if (sub) {
      var s = el('span', tile.offer === 'rent' || tile.offer === 'buy' || tile.offer === 'upgrade' || tile.offer === 'channel' ? 'pay' : '', sub);
      words.appendChild(s);
    }
    hit.appendChild(words);
    t.appendChild(hit);
    return t;
  }

  function youtubeSection(y) {
    var aside = null;
    if (y.state === 'loading') { aside = el('small', 'fd-state'); aside.appendChild(spinner()); aside.appendChild(document.createTextNode('Searching YouTube…')); }
    else if (y.state === 'ok') aside = el('small', 'fd-state', [y.channels.length ? y.channels.length + (y.channels.length === 1 ? ' channel' : ' channels') : '', y.videos.length + (y.videos.length === 1 ? ' video' : ' videos')].filter(Boolean).join(' · '));
    var sec = section('youtube', 'YouTube', aside);
    sec.dataset.state = y.state;
    if (y.state === 'loading') { sec.appendChild(skeleton('fd-row', 5)); return sec; }
    if (y.state === 'off') { sec.appendChild(note('calm', 'YouTube is off.', 'Turn it on in Settings > Lumen to search it here.')); return sec; }
    if (y.state === 'empty') { sec.appendChild(note('calm', 'YouTube found nothing for “' + F.q + '”.', '')); return sec; }
    if (y.state !== 'ok') {
      var n = note('err', 'YouTube search didn’t work.', y.reason ? cap(y.reason) + '.' : '');
      n.appendChild(btn('btn sm', 'Search on YouTube', function () { B.openUrl('https://www.youtube.com/results?search_query=' + encodeURIComponent(F.q), 'YouTube: ' + F.q); }));
      sec.appendChild(n);
      return sec;
    }
    var r = el('div', 'fd-row');
    y.channels.forEach(function (c) {
      var t = el('div', 'fd-tile fd-chan');
      var hit = btn('fd-hit', '', function () { B.openUrl(c.url, c.name); }, 'Channel: ' + c.name + (c.subs ? ', ' + c.subs : ''));
      hit.dataset.nav = 'c:' + c.url;
      var av = el('span', 'fd-av');
      if (c.image) { var img = el('img'); img.alt = ''; img.decoding = 'async'; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.src = c.image; img.onerror = function () { img.remove(); }; av.appendChild(img); }
      av.appendChild(el('span', 'fd-av-l', c.name.charAt(0).toUpperCase()));
      hit.appendChild(av);
      var w = el('span', 'fd-t');
      w.appendChild(el('b', '', c.name));
      w.appendChild(el('span', '', ['Channel', c.subs || c.handle].filter(Boolean).join(' · ')));
      hit.appendChild(w);
      t.appendChild(hit);
      r.appendChild(t);
    });
    y.videos.forEach(function (it) {
      var t = el('div', 'fd-tile');
      var hit = btn('fd-hit', '', function () { B.openUrl(it.url, it.title); }, 'Play ' + it.title + ' on YouTube');
      hit.dataset.nav = 'y:' + it.id;
      var art = artBox(it);
      if (it.durationSec) art.appendChild(el('span', 'fd-len', lenText(it.durationSec)));
      hit.appendChild(art);
      var w = el('span', 'fd-t');
      w.appendChild(el('b', '', it.title));
      if (it.subtitle) w.appendChild(el('span', '', it.subtitle));
      hit.appendChild(w);
      t.appendChild(hit);
      r.appendChild(t);
    });
    sec.appendChild(r);
    return sec;
  }

  function tmdbFoot() {
    var f = el('div', 'fd-foot');
    var tm = F.tmdb;
    if (tm && tm.state === 'ok' && tm.results.length) f.appendChild(el('p', 'attrib', tm.attribution || 'Where-to-watch data from JustWatch, via TMDB'));
    else if (tm && tm.state === 'no-key') {
      var slot = el('div', 'tmdb-slot');
      slot.appendChild(el('span', 'tag', 'Not set up'));
      slot.appendChild(el('span', 'tmdb-txt', 'Add a free TMDB key in Settings to also see where titles are streaming that your services don’t return'));
      slot.appendChild(btn('btn sm', 'Open Settings', function () { B.settings(); }));
      f.appendChild(slot);
    } else if (tm && tm.state !== 'ok' && tm.state !== 'empty') {
      f.appendChild(note('warn', 'Where-to-watch (TMDB) didn’t answer.', tm.reason ? cap(tm.reason) + '.' : ''));
    }
    return f;
  }

  function artBox(it) {
    var art = el('span', 'fd-art');
    if (B.artImage) B.artImage(art, { title: it.title, image: it.image, images: it.images || null, service: it.service || '' }, true);
    return art;
  }
  function progressBar(p) {
    var prog = el('span', 'fd-prog');
    var bar = el('i');
    bar.style.setProperty('--p', String(Math.max(0, Math.min(1, p))));
    prog.appendChild(bar);
    return prog;
  }
  function skeleton(cls, n) {
    var r = el('div', cls + ' fd-sk');
    r.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < n; i++) { var t = el('div', 'fd-tile'); t.appendChild(el('span', 'fd-art')); var w = el('span', 'fd-t'); w.appendChild(el('i')); w.appendChild(el('i')); t.appendChild(w); r.appendChild(t); }
    return r;
  }
  function note(kind, title, why) {
    var n = el('div', 'res-note fd-note' + (kind ? ' ' + kind : ''));
    n.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    var g = el('span', 'grow');
    g.appendChild(el('b', '', title));
    if (why) { g.appendChild(document.createTextNode(' ')); g.appendChild(el('span', 'why', why)); }
    n.appendChild(g);
    return n;
  }

  /* ---------------------------------------------------------- keys */

  function tiles() { return Array.prototype.slice.call(B.results.querySelectorAll('.fd-hit[data-nav]')); }
  function focusKey() { var a = document.activeElement; return a && B.results.contains(a) && a.dataset && a.dataset.nav ? a.dataset.nav : ''; }
  function restoreFocus(key) {
    if (!key) return;
    var list = tiles();
    for (var i = 0; i < list.length; i++) if (list[i].dataset.nav === key) { list[i].focus({ preventScroll: true }); return; }
  }
  /* The tile the arrow points at: the nearest one that way, by where they sit on screen. */
  function neighbour(from, key) {
    var a = from.getBoundingClientRect();
    var ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    var best = null, bestD = Infinity;
    tiles().forEach(function (t) {
      if (t === from) return;
      var b = t.getBoundingClientRect();
      var bx = b.left + b.width / 2, by = b.top + b.height / 2;
      var dx = bx - ax, dy = by - ay;
      var sameLine = Math.abs(dy) < a.height / 2;
      var d;
      if (key === 'ArrowRight') { if (!sameLine || dx <= 1) return; d = dx; }
      else if (key === 'ArrowLeft') { if (!sameLine || dx >= -1) return; d = -dx; }
      else if (key === 'ArrowDown') { if (dy <= a.height / 2) return; d = dy * 4 + Math.abs(dx); }
      else { if (dy >= -a.height / 2) return; d = -dy * 4 + Math.abs(dx); }
      if (d < bestD) { bestD = d; best = t; }
    });
    return best;
  }
  function onResultsKey(e) {
    if (!F.open || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { e.preventDefault(); B.clear(); return; }
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('fd-hit')) {
      if (/^Arrow/.test(e.key) && t && t.closest && t.closest('.fd-chips')) {
        var tile = t.closest('.fd-tile').querySelector('.fd-hit');
        if (tile && (e.key === 'ArrowUp')) { e.preventDefault(); tile.focus(); }
      }
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      var n = neighbour(t, e.key);
      e.preventDefault();
      if (n) { n.focus(); n.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
      else if (e.key === 'ArrowUp') B.input.focus();
    }
  }

  /** watch.js hands the search field's keys over first. -> true when it was ours. */
  function key(e, q) {
    if (R.el && !R.el.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveRecent(e.key === 'ArrowDown' ? 1 : -1); return true; }
      if (e.key === 'Enter' && R.idx >= 0 && R.items[R.idx]) { e.preventDefault(); pickRecent(R.items[R.idx]); return true; }
      if (e.key === 'Escape') { e.preventDefault(); hideRecents(); return true; }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (q) submit(q);
      return true;
    }
    if (e.key === 'ArrowDown' && owns(q)) {
      var first = tiles()[0];
      if (first) { e.preventDefault(); first.focus(); return true; }
    }
    return false;
  }

  /* ---------------------------------------------------------- recent searches */

  function loadRecent() {
    try { var v = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter(function (s) { return typeof s === 'string' && s; }).slice(0, RECENT_MAX) : []; } catch (e) { return []; }
  }
  function saveRecent(list) { try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) { /* storage off: nothing kept */ } }
  function remember(q) { saveRecent(Find.remember(loadRecent(), q, RECENT_MAX)); }
  function clearRecent() { try { window.localStorage.removeItem(RECENT_KEY); } catch (e) { /* none */ } }

  function showRecents() {
    if (!B || B.input.value) { hideRecents(); return; }
    var list = loadRecent();
    if (!list.length) { hideRecents(); return; }
    if (!R.el) {
      R.el = el('div', 'fd-recent');
      R.el.id = 'fd-recent';
      R.el.setAttribute('role', 'listbox');
      R.el.setAttribute('aria-label', 'Recent searches');
      R.el.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep the field focused
      B.input.parentNode.appendChild(R.el);
      B.input.setAttribute('aria-controls', 'fd-recent');
    }
    R.items = list;
    R.idx = -1;
    var head = el('div', 'fd-rh');
    head.appendChild(el('span', '', 'Recent searches'));
    head.appendChild(btn('fd-rclear', 'Clear', function () { clearRecent(); hideRecents(); B.input.focus(); }, 'Clear recent searches'));
    var frag = document.createDocumentFragment();
    frag.appendChild(head);
    list.forEach(function (q, i) {
      var b = btn('fd-ri', q, function () { pickRecent(q); });
      b.setAttribute('role', 'option');
      b.id = 'fd-ri-' + i;
      b.tabIndex = -1;
      frag.appendChild(b);
    });
    R.el.replaceChildren(frag);
    R.el.hidden = false;
    B.input.setAttribute('aria-expanded', 'true');
  }
  function hideRecents() {
    if (!R.el) return;
    R.el.hidden = true;
    R.idx = -1;
    if (B) { B.input.setAttribute('aria-expanded', 'false'); B.input.removeAttribute('aria-activedescendant'); }
  }
  function moveRecent(d) {
    var opts = R.el.querySelectorAll('.fd-ri');
    if (!opts.length) return;
    R.idx = Math.max(-1, Math.min(opts.length - 1, R.idx + d));
    for (var i = 0; i < opts.length; i++) opts[i].classList.toggle('on', i === R.idx);
    if (R.idx >= 0) B.input.setAttribute('aria-activedescendant', opts[R.idx].id); else B.input.removeAttribute('aria-activedescendant');
  }
  function pickRecent(q) {
    hideRecents();
    B.input.value = q;
    B.input.dispatchEvent(new Event('input', { bubbles: true }));
    submit(q);
  }

  /* ---------------------------------------------------------- wiring */

  function attach(bridge) {
    B = bridge;
    B.results.addEventListener('keydown', onResultsKey);
    B.input.addEventListener('focus', showRecents);
    B.input.addEventListener('input', function () { if (B.input.value) hideRecents(); else showRecents(); });
    B.input.addEventListener('blur', hideRecents);
    // Forget (Settings > Lumen) takes the recent searches too.
    var prev = window.__applyWatchResult;
    window.__applyWatchResult = function (r) {
      if (r && r.action === 'forget' && r.ok) { clearRecent(); hideRecents(); }
      return typeof prev === 'function' ? prev.apply(this, arguments) : undefined;
    };
  }

  window.WatchFindPage = {
    attach: attach, submit: submit, owns: owns, close: close, render: render, key: key,
    _state: function () { return { open: F.open, q: F.q, seq: F.seq, done: F.done, services: Object.keys(F.services).map(function (k) { return k + ':' + F.services[k].state; }), youtube: F.youtube ? F.youtube.state : 'loading', tmdb: F.tmdb ? F.tmdb.state : '', recent: loadRecent() }; }
  };
})();
