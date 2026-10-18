/* ============================================================
   watch/ytlib-page.js -- YouTube past the home row, drawn natively in Lumen
   (window.WatchYt): the Subscriptions row on the lens, and its pages --
   Subscriptions, a channel's Videos, the Library (Watch later, Liked
   videos, playlists) and one playlist -- in a layer over the rows, the way
   search results are. Every tile plays through Lumen's player layer
   (watch.js openUrl -> quartz-watch:open), at &t= when YouTube said how far
   he got. Read only; main reads (watch/ytlib-main.js).

     out  quartz-watch:yt {"op":"subs"|"library"|"channel"|"playlist"|"played", url?, id?, seq?, force?}
     in   window.__applyWatchYt(answer)

   watch.js calls in through small hooks: attach(helpers), row(snap) for the
   lens model, head() for the row's header, card() per tile, stage hooks,
   onKey(). Everything is createElement + textContent.
   ============================================================ */
(function () {
  'use strict';
  var ORIGIN = 'https://www.youtube.com';
  var ROW_MAX = 24;
  var H = null;                      // watch.js helpers (attach)
  var Y = { subs: null, library: null, pages: {}, views: [], seq: 0, el: null, body: null, head: null, note: null, lastFocus: null };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null && text !== '') e.textContent = String(text);
    return e;
  }
  function btn(cls, text, onClick, aria) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', function (e) { e.stopPropagation(); onClick(e); });
    return b;
  }
  function https(v) {
    if (typeof v !== 'string' || !v) return '';
    try { var u = new URL(v.indexOf('//') === 0 ? 'https:' + v : v); return u.protocol === 'https:' ? u.href : ''; } catch (e) { return ''; }
  }
  function txt(v, max) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200) : ''; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function send(op, msg) { if (H) H.send('yt', Object.assign({ op: op }, msg || {})); }
  function ytOn(snap) {
    var s = snap && arr(snap.services).filter(function (x) { return x.id === 'youtube'; })[0];
    return !!(s && s.enabled);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function initial(name) { var m = /[A-Za-z0-9]/.exec(name || ''); return m ? m[0].toUpperCase() : '?'; }

  /* ------------------------------------------------------------ answers */

  function cleanTile(it) {
    if (!it || typeof it !== 'object') return null;
    var url = https(it.url);
    var title = txt(it.title, 200);
    if (!url || !title || !/^https:\/\/www\.youtube\.com\//.test(url)) return null;
    var ch = it.channel && typeof it.channel === 'object' ? it.channel : {};
    return {
      id: txt(it.id, 80) || 'youtube:' + it.vid, vid: txt(it.vid, 11), service: 'youtube', kind: 'rec', also: [],
      title: title, subtitle: txt(it.subtitle, 200), image: https(it.image), images: arr(it.images).map(https).filter(Boolean),
      progress: typeof it.progress === 'number' && isFinite(it.progress) ? Math.max(0, Math.min(1, it.progress)) : null,
      url: url, startsAt: null, durationSec: typeof it.durationSec === 'number' && it.durationSec > 0 ? it.durationSec : null,
      badge: txt(it.badge, 24), group: '', edge: false, yt: true, isNew: it.isNew === true, live: it.live === true, upcoming: it.upcoming === true,
      age: txt(it.age, 60), channel: { name: txt(ch.name, 120), path: typeof ch.path === 'string' && /^\/(@|channel\/|c\/|user\/)/.test(ch.path) ? ch.path : '', avatar: https(ch.avatar) }
    };
  }
  function cleanAnswer(a) {
    if (!a || typeof a !== 'object') return null;
    var o = {
      what: a.what, key: txt(a.key, 300), seq: a.seq | 0, state: ['ok', 'signed-out', 'error', 'never'].indexOf(a.state) !== -1 ? a.state : 'error',
      reason: txt(a.reason, 300), readAt: +a.readAt || 0, lastOkAt: +a.lastOkAt || 0, refreshing: a.refreshing === true, paused: txt(a.paused, 200),
      items: arr(a.items).map(cleanTile).filter(Boolean), newCount: a.newCount | 0, shortsHidden: a.shortsHidden | 0, empty: a.empty === true
    };
    if (a.what === 'channel') o.channel = a.channel && typeof a.channel === 'object' ? a.channel : null;
    if (a.what === 'playlist') o.playlist = a.playlist && typeof a.playlist === 'object' ? a.playlist : null;
    if (a.what === 'library') {
      ['wl', 'll'].forEach(function (k) { var p = a[k]; o[k] = p && typeof p === 'object' ? { state: p.state, reason: txt(p.reason, 300), items: arr(p.items).map(cleanTile).filter(Boolean), playlist: p.playlist || null } : null; });
      var pl = a.playlists;
      o.playlists = pl && typeof pl === 'object' ? { state: pl.state, reason: txt(pl.reason, 300), empty: pl.empty === true,
        items: arr(pl.items).filter(function (p) { return p && /^[A-Za-z0-9_-]{2,64}$/.test(p.id) && txt(p.title); }).map(function (p) {
          return { id: p.id, title: txt(p.title, 200), count: txt(p.count, 40), image: https(p.image), owner: txt(p.owner, 120) };
        }) } : null;
    }
    return o;
  }

  window.__applyWatchYt = function (raw) {
    var a = cleanAnswer(raw);
    if (!a) return;
    if (a.what === 'subs') {
      var before = Y.subs ? rowSigOf(Y.subs) : '';
      Y.subs = a;
      if (H && rowSigOf(a) !== before) H.renderLens();
    } else if (a.what === 'library') Y.library = a;
    else if (a.what === 'channel' || a.what === 'playlist') {
      var cur = Y.pages[a.key];
      if (cur && cur.seq > a.seq && a.seq) return;   // an older ask's answer
      Y.pages[a.key] = a;
    } else return;
    var v = top();
    if (v && viewKey(v) === a.key) renderView(false);
  };

  /* ------------------------------------------------------------ the row */

  function rowSigOf(a) {
    if (!a) return '';
    return [a.state, a.reason, a.refreshing, a.paused, a.newCount, a.readAt].concat(a.items.slice(0, ROW_MAX).map(function (it) { return it.vid + (it.isNew ? '*' : '') + it.url; })).join('\u0001');
  }

  /** The Subscriptions row for watch.js's lens model, or null (YouTube off, nothing asked yet). */
  function row(snap) {
    if (!H || !ytOn(snap)) return null;
    var a = Y.subs;
    if (!a) return null;
    var items = a.items.slice(0, ROW_MAX);
    var state = '';
    if (a.state === 'signed-out') state = 'signed-out';
    else if (!items.length) {
      if (a.refreshing && a.state === 'never') state = 'loading';
      else if (a.paused && a.state === 'never') state = 'paused';
      else if (a.state === 'error') state = 'error';
      else if (a.state === 'ok') state = 'empty';
      else state = 'loading';
    }
    var m = { key: 'r:yt-subs', kind: 'items', id: 'yt-subs', title: 'Subscriptions', service: '', yt: true, top: !state, items: [] };
    if (state) m.items = [stateItem(state, a)];
    else m.items = items;
    m.ytSig = '\u0002' + rowSigOf(a);
    return m;
  }

  var STATE_TEXT = {
    'signed-out': ['Sign in to YouTube', 'Your subscriptions show here once you’re signed in. Sign-in opens inside Lumen.', 'Sign in to YouTube'],
    loading: ['Reading your subscriptions…', 'The newest videos from the channels you follow, read from YouTube.', ''],
    paused: ['Subscriptions are waiting', '', 'Retry'],
    error: ['Couldn’t read your subscriptions', '', 'Retry'],
    empty: ['No videos from your subscriptions', 'Subscribe to channels on YouTube and their newest videos show here.', 'Find channels']
  };
  function stateItem(state, a) {
    var t = STATE_TEXT[state];
    var body = t[1];
    if (state === 'error') body = 'YouTube: ' + (a.reason || 'the read failed') + '.';
    if (state === 'paused') body = capFirst(a.paused) + '.';
    return { id: 'yt-state:' + state, service: '', kind: 'rec', also: [], title: t[0], subtitle: body, image: '', images: [], progress: null, url: ORIGIN + '/feed/subscriptions',
      durationSec: null, badge: '', group: '', edge: false, ytState: state, ytAction: t[2] };
  }
  function capFirst(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function stateAction(state) {
    if (state === 'signed-out') return function () { H.send('signin', { service: 'youtube' }); };
    if (state === 'empty') return function () { H.openUrl(ORIGIN + '/feed/channels', 'YouTube channels'); };
    if (state === 'error' || state === 'paused') return function () { send('subs', { force: true }); };
    return null;
  }

  /** The row's header (watch.js rowSub): the new badge, how fresh, See all and Library. */
  function head(m, headEl) {
    var a = Y.subs;
    if (!a) return;
    if (a.newCount > 0) {
      var bd = el('span', 'yt-badge', a.newCount + ' new');
      bd.title = plural(a.newCount, 'video') + ' since you last opened Lumen';
      headEl.appendChild(bd);
    }
    var sub = el('span', 'sub');
    if (a.state === 'error' && a.items.length) {
      sub.className = 'sub err';
      sub.appendChild(el('span', 'dot err'));
      sub.appendChild(document.createTextNode('Couldn’t refresh \u00b7 showing '));
      sub.appendChild(H.agoSpan('', a.lastOkAt || a.readAt));
      sub.title = a.reason;
      var retry = btn('btn sm ghost', 'Retry', function () { send('subs', { force: true }); }, 'Retry reading your subscriptions');
      headEl.appendChild(sub);
      headEl.appendChild(retry);
    } else if (a.items.length) {
      sub.textContent = a.refreshing ? 'Newest first \u00b7 refreshing\u2026' : a.paused ? 'Newest first \u00b7 ' + a.paused : 'Newest first \u00b7 YouTube';
      headEl.appendChild(sub);
    } else if (a.state !== 'signed-out') {
      sub.textContent = 'YouTube';
      headEl.appendChild(sub);
    }
    if (a.state === 'signed-out') return;
    var acts = el('span', 'yt-hacts');
    acts.appendChild(btn('btn sm ghost', 'See all', function () { open({ kind: 'subs' }); }, 'See all subscriptions'));
    acts.appendChild(btn('btn sm ghost', 'Library', function () { open({ kind: 'library' }); }, 'Your YouTube library: Watch later, Liked videos, playlists'));
    headEl.appendChild(acts);
  }

  /** One tile on the lens (watch.js cardEl made it): the avatar, the New mark, the state card. */
  function card(c, it) {
    if (it.ytState) {
      c.classList.add('yt-state', 'st-' + it.ytState);
      c.replaceChildren();
      var box = el('span', 'yt-sbox');
      box.appendChild(el('b', '', it.title));
      if (it.subtitle) box.appendChild(el('span', '', it.subtitle));
      if (it.ytAction) {
        var go = el('span', 'btn sm' + (it.ytState === 'signed-out' ? ' primary' : ''), it.ytAction);
        box.appendChild(go);
      }
      c.appendChild(box);
      c.setAttribute('aria-label', it.title + '. ' + (it.subtitle || ''));
      c._ytAction = stateAction(it.ytState);
      if (!c._ytAction) c.classList.add('sk-card');
      return;
    }
    c.classList.add('yt-sub');
    if (it.isNew) {
      c.classList.add('is-new');
      var art = c.querySelector('.art');
      if (art) art.appendChild(el('span', 'yt-new', 'New'));
      c.setAttribute('aria-label', 'New. ' + (c.getAttribute('aria-label') || ''));
    }
    var meta = c.querySelector('.m');
    if (meta) meta.insertBefore(avatarEl(it.channel, 'yt-av'), meta.firstChild);
    c._ytPlay = true;
  }

  function avatarEl(ch, cls) {
    var a = el('span', cls);
    a.setAttribute('aria-hidden', 'true');
    a.appendChild(el('i', '', initial(ch && ch.name)));
    if (ch && ch.avatar) {
      var img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () { if (img.parentNode) img.parentNode.removeChild(img); });
      img.src = ch.avatar;
      a.appendChild(img);
    }
    return a;
  }

  /** watch.js openCard: a state card runs its action; a tile plays (and stops being new). */
  function openCard(card) {
    if (card._ytAction) { card._ytAction(); return true; }
    if (card._ytPlay && card._item) { play(card._item); return true; }
    return false;
  }

  /* The URL that plays: Continue watching's own (with &t=) when the same video is there. */
  function playUrl(it) {
    var snap = H && H.snap();
    if (snap && snap.items) {
      for (var i = 0; i < snap.items.length; i++) {
        var x = snap.items[i];
        if (x && x.service === 'youtube' && x.kind === 'resume' && x.id === it.id && /[?&]t=\d+/.test(x.url)) return x.url;
      }
    }
    return it.url;
  }
  function play(it) {
    H.openUrl(playUrl(it), it.title);
    if (it.vid && it.isNew) send('played', { id: it.vid });
  }

  /** The stage (hero) for a state card. */
  function stageState(it) {
    var t = el('div', 'txt');
    var eb = el('div', 'eyebrow');
    eb.appendChild(el('span', 'rn', 'Subscriptions'));
    var mk = el('span', 'chip mk', 'YT');
    mk.dataset.svc = 'youtube';
    eb.appendChild(mk);
    t.appendChild(eb);
    t.appendChild(el('h1', '', it.title));
    if (it.subtitle) t.appendChild(el('div', 'meta yt-why', it.subtitle));
    var act = stateAction(it.ytState);
    if (act && it.ytAction) {
      var acts = el('div', 'acts');
      acts.appendChild(btn('btn primary', it.ytAction, act));
      t.appendChild(acts);
    }
    var pic = el('div', 'pic');
    return [t, pic];
  }

  /** The stage's buttons for a tile: its channel, and the whole feed. */
  function stageActs(acts, it) {
    if (!it || !it.yt || !it.channel || !it.channel.path) return;
    var ch = btn('btn ghost yt-chbtn', '', function () { open({ kind: 'channel', path: it.channel.path, name: it.channel.name, avatar: it.channel.avatar }); }, 'Open ' + (it.channel.name || 'the channel') + ' in Lumen');
    ch.appendChild(avatarEl(it.channel, 'yt-av sm'));
    ch.appendChild(el('span', '', it.channel.name || 'Channel'));
    acts.appendChild(ch);
  }

  /* ------------------------------------------------------------ the pages */

  function top() { return Y.views.length ? Y.views[Y.views.length - 1] : null; }
  function viewKey(v) {
    if (!v) return '';
    if (v.kind === 'subs') return 'subs';
    if (v.kind === 'library') return 'library';
    if (v.kind === 'channel') return 'channel:' + v.path;
    return 'playlist:' + v.id;
  }
  function answerFor(v) {
    var k = viewKey(v);
    if (k === 'subs') return Y.subs;
    if (k === 'library') return Y.library;
    return Y.pages[k] || null;
  }
  function ask(v, force) {
    Y.seq++;
    if (v.kind === 'subs') send('subs', { force: !!force });
    else if (v.kind === 'library') send('library', { force: !!force, seq: Y.seq });
    else if (v.kind === 'channel') send('channel', { url: ORIGIN + v.path, force: !!force, seq: Y.seq });
    else send('playlist', { id: v.id, force: !!force, seq: Y.seq });
  }

  function build() {
    if (Y.el) return;
    Y.el = el('section', 'ytp');
    Y.el.id = 'ytp';
    Y.el.hidden = true;
    Y.el.setAttribute('aria-label', 'YouTube in Lumen');
    Y.head = el('div', 'ytp-h');
    Y.note = el('div', 'ytp-note-slot');
    Y.body = el('div', 'ytp-b');
    Y.el.appendChild(Y.head);
    Y.el.appendChild(Y.note);
    Y.el.appendChild(Y.body);
    Y.el.addEventListener('keydown', gridKey);
    document.body.appendChild(Y.el);
  }

  function open(v) {
    build();
    if (!Y.views.length) Y.lastFocus = document.activeElement;
    var t = top();
    if (t && viewKey(t) === viewKey(v)) return;
    Y.views.push(v);
    document.body.classList.add('yt-open');
    Y.el.hidden = false;
    if (H && H.previewStop) H.previewStop();
    ask(v, false);
    renderView(true);
  }
  function back() {
    Y.views.pop();
    if (!Y.views.length) { close(); return; }
    renderView(true);
  }
  function close() {
    Y.views.length = 0;
    if (!Y.el) return;
    Y.el.hidden = true;
    Y.body.replaceChildren();
    Y.head.replaceChildren();
    Y.note.replaceChildren();
    document.body.classList.remove('yt-open');
    var f = Y.lastFocus;
    Y.lastFocus = null;
    if (f && document.contains(f) && typeof f.focus === 'function') f.focus({ preventScroll: true });
    else if (H && H.focusLens) H.focusLens();
  }
  function isOpen() { return !!Y.views.length; }

  function renderView(fresh) {
    var v = top();
    if (!v || !Y.el) return;
    var a = answerFor(v);
    var keepScroll = fresh ? 0 : Y.el.scrollTop;
    var focusKey = !fresh && document.activeElement && Y.el.contains(document.activeElement) ? (document.activeElement.dataset.fk || '') : '';
    Y.head.replaceChildren();
    Y.note.replaceChildren();
    Y.body.replaceChildren();
    var backB = btn('icon-btn ytp-back', '', back, Y.views.length > 1 ? 'Back' : 'Back to Lumen');
    backB.title = Y.views.length > 1 ? 'Back (Esc)' : 'Back to Lumen (Esc)';
    if (H && H.icon) backB.appendChild(H.icon('left'));
    backB.dataset.fk = 'back';
    Y.head.appendChild(backB);
    if (v.kind === 'subs') viewSubs(a);
    else if (v.kind === 'channel') viewChannel(v, a);
    else if (v.kind === 'library') viewLibrary(a);
    else viewPlaylist(v, a);
    if (fresh) {
      Y.el.scrollTop = 0;
      backB.focus({ preventScroll: true });
    } else {
      Y.el.scrollTop = keepScroll;
      if (focusKey) { var f = Y.el.querySelector('[data-fk="' + focusKey.replace(/["\\]/g, '') + '"]'); if (f) f.focus({ preventScroll: true }); }
    }
  }

  function title(h2, sub, extra) {
    var t = el('div', 'ytp-ttl');
    var row1 = el('div', 'ytp-t1');
    row1.appendChild(el('h2', '', h2));
    if (extra) row1.appendChild(extra);
    t.appendChild(row1);
    if (sub) t.appendChild(el('span', 'sub', sub));
    Y.head.appendChild(t);
    var acts = el('div', 'ytp-acts');
    Y.head.appendChild(acts);
    return acts;
  }
  function hostedBtn(label, url, ttl) {
    var b = btn('btn sm ghost', label, function () { H.openUrl(url, ttl); });
    if (H && H.icon) b.appendChild(H.icon('out', 's'));
    return b;
  }
  function refreshBtn(v, a) {
    var b = btn('btn sm ghost', a && a.refreshing ? 'Refreshing\u2026' : 'Refresh', function () { ask(v, true); renderView(false); });
    if (a && a.refreshing) b.disabled = true;
    b.dataset.fk = 'refresh';
    return b;
  }

  /* The bar under the title: refreshing, stale, paused. */
  function noteFor(v, a, what) {
    if (!a) return;
    var n = null;
    if (a.state === 'error' && a.items.length) {
      n = el('div', 'res-note err');
      var w = el('span', 'grow');
      w.appendChild(el('b', '', 'Couldn’t refresh ' + what + '. '));
      w.appendChild(el('span', 'why', 'YouTube: ' + (a.reason || 'the read failed') + '. '));
      w.appendChild(document.createTextNode('Showing what Lumen read '));
      w.appendChild(H.agoSpan('', a.lastOkAt || a.readAt, '', '.'));
      n.appendChild(w);
      n.appendChild(btn('btn sm', 'Retry', function () { ask(v, true); renderView(false); }));
    } else if (a.paused && !a.refreshing && a.items.length) {
      n = el('div', 'res-note calm');
      n.appendChild(el('span', 'grow', capFirst(a.paused) + '. Showing what Lumen read earlier.'));
      n.appendChild(btn('btn sm', 'Retry', function () { ask(v, true); renderView(false); }));
    } else if (a.refreshing && a.items.length) {
      n = el('div', 'res-note calm yt-refreshing');
      var g = el('span', 'grow');
      g.appendChild(document.createTextNode('Refreshing\u2026 showing what Lumen read '));
      g.appendChild(H.agoSpan('', a.lastOkAt || a.readAt, '', '.'));
      n.appendChild(g);
    }
    if (n) Y.note.appendChild(n);
  }

  /* A designed empty / signed-out / failed / loading body. Returns true when it drew one. */
  function stateBody(v, a, words) {
    var st = !a ? 'loading' : a.state === 'signed-out' ? 'signed-out' : a.items.length ? '' :
      (a.state === 'never' || a.refreshing) && !a.paused ? 'loading' : a.paused && a.state === 'never' ? 'paused' : a.state === 'error' ? 'error' : a.state === 'ok' ? 'empty' : 'loading';
    if (!st) return false;
    if (st === 'loading') {
      var sk = el('div', 'yt-grid yt-sk');
      sk.setAttribute('aria-hidden', 'true');
      for (var i = 0; i < 8; i++) { var c = el('div', 'yt-cell'); c.appendChild(el('span', 'yt-art')); c.appendChild(el('span', 'yt-skl')); c.appendChild(el('span', 'yt-skl s')); sk.appendChild(c); }
      var lab = el('p', 'yt-loading', words.loading);
      lab.setAttribute('role', 'status');
      Y.body.appendChild(lab);
      Y.body.appendChild(sk);
      return true;
    }
    var p = el('div', 'yt-panel st-' + st);
    var acts = el('div', 'acts');
    if (st === 'signed-out') {
      p.appendChild(el('h3', '', 'Sign in to YouTube'));
      p.appendChild(el('p', '', words.signedOut + ' Sign-in opens inside Lumen.'));
      acts.appendChild(btn('btn primary', 'Sign in to YouTube', function () { H.send('signin', { service: 'youtube' }); }));
    } else if (st === 'error') {
      p.appendChild(el('h3', '', 'Couldn’t read ' + words.what));
      p.appendChild(el('p', 'why', 'YouTube: ' + (a.reason || 'the read failed') + '.'));
      acts.appendChild(btn('btn primary', 'Retry', function () { ask(v, true); renderView(false); }));
      if (words.hosted) acts.appendChild(hostedBtn('Open on YouTube', words.hosted, words.what));
    } else if (st === 'paused') {
      p.appendChild(el('h3', '', capFirst(words.what) + ' are waiting'));
      p.appendChild(el('p', 'why', capFirst(a.paused) + '.'));
      acts.appendChild(btn('btn primary', 'Retry', function () { ask(v, true); renderView(false); }));
    } else {
      p.appendChild(el('h3', '', words.emptyTitle));
      p.appendChild(el('p', '', words.empty));
      if (words.emptyAct) acts.appendChild(hostedBtn(words.emptyAct[0], words.emptyAct[1], words.emptyAct[0]));
    }
    p.appendChild(acts);
    Y.body.appendChild(p);
    return true;
  }

  function cell(it, opts) {
    var o = opts || {};
    var c = el('div', 'yt-cell' + (it.isNew ? ' is-new' : ''));
    var pb = btn('yt-play', '', function () { play(it); });
    pb.dataset.fk = 'v:' + it.vid;
    pb._item = it;
    var art = el('span', 'yt-art');
    if (H && H.artImage) H.artImage(art, it, true); else if (it.image) { var im = el('img'); im.src = it.image; im.alt = ''; art.appendChild(im); }
    if (it.live) art.appendChild(el('span', 'live', 'Live'));
    else if (it.upcoming) art.appendChild(el('span', 'len', 'Upcoming'));
    else if (it.durationSec && H && H.lenText) art.appendChild(el('span', 'len', H.lenText(it.durationSec)));
    if (it.isNew) art.appendChild(el('span', 'yt-new', 'New'));
    if (typeof it.progress === 'number' && it.progress > 0) {
      var prog = el('span', 'prog');
      var bar = el('i');
      bar.style.setProperty('--p', String(it.progress));
      prog.appendChild(bar);
      art.appendChild(prog);
    }
    pb.appendChild(art);
    pb.appendChild(el('span', 'yt-t', it.title));
    var resumes = /[?&]t=\d+/.test(playUrl(it));
    pb.setAttribute('aria-label', (it.isNew ? 'New. ' : '') + it.title + (it.channel.name && !o.noChannel ? ', ' + it.channel.name : '') + (it.age ? ', ' + it.age : '') + '. ' + (resumes ? 'Resumes' : 'Plays') + ' in Lumen.');
    c.appendChild(pb);
    var by = el('div', 'yt-by');
    if (!o.noChannel && it.channel.path) {
      var chb = btn('yt-ch', '', function () { open({ kind: 'channel', path: it.channel.path, name: it.channel.name, avatar: it.channel.avatar }); }, 'Open ' + (it.channel.name || 'the channel'));
      chb.dataset.fk = 'c:' + it.vid;
      chb.appendChild(avatarEl(it.channel, 'yt-av'));
      chb.appendChild(el('span', 'yt-chn', it.channel.name || 'Channel'));
      by.appendChild(chb);
    } else if (!o.noChannel && it.channel.name) {
      by.appendChild(el('span', 'yt-chn', it.channel.name));
    }
    var meta = o.noChannel ? it.subtitle : it.age;
    if (meta) by.appendChild(el('span', 'yt-age', meta));
    c.appendChild(by);
    return c;
  }
  function grid(items, opts) {
    var g = el('div', 'yt-grid');
    items.forEach(function (it) { g.appendChild(cell(it, opts)); });
    return g;
  }
  function section(h, sub, body, more) {
    var s = el('section', 'yt-sec');
    var hd = el('div', 'yt-sec-h');
    hd.appendChild(el('h3', '', h));
    if (sub) hd.appendChild(el('span', 'sub', sub));
    if (more) hd.appendChild(more);
    s.appendChild(hd);
    s.appendChild(body);
    return s;
  }

  function viewSubs(a) {
    var v = top();
    var bd = null;
    if (a && a.newCount) { bd = el('span', 'yt-badge', a.newCount + ' new'); bd.title = plural(a.newCount, 'video') + ' since you last opened Lumen'; }
    var acts = title('Subscriptions', a && a.items.length ? 'Newest first \u00b7 ' + plural(a.items.length, 'video') + ' from the channels you follow' : 'The channels you follow, on YouTube', bd);
    if (a && a.state !== 'signed-out') {
      acts.appendChild(btn('btn sm ghost', 'Library', function () { open({ kind: 'library' }); }));
      acts.appendChild(refreshBtn(v, a));
    }
    acts.appendChild(hostedBtn('Open on YouTube', ORIGIN + '/feed/subscriptions', 'Subscriptions'));
    noteFor(v, a, 'your subscriptions');
    if (stateBody(v, a, { what: 'your subscriptions', loading: 'Reading your subscriptions\u2026', signedOut: 'Your subscriptions, channels and library show here once you’re signed in.',
      emptyTitle: 'No videos from your subscriptions', empty: 'Subscribe to channels on YouTube and their newest videos show here.', emptyAct: ['Find channels', ORIGIN + '/feed/channels'], hosted: ORIGIN + '/feed/subscriptions' })) return;
    var fresh = a.items.filter(function (it) { return it.isNew; });
    var rest = a.items.filter(function (it) { return !it.isNew; });
    if (fresh.length) Y.body.appendChild(section('New since you last opened Lumen', plural(fresh.length, 'video'), grid(fresh)));
    if (rest.length) Y.body.appendChild(section(fresh.length ? 'Earlier' : 'Latest', '', grid(rest)));
    if (a.shortsHidden) {
      var sn = el('div', 'res-note calm yt-shorts');
      sn.appendChild(el('span', 'grow', plural(a.shortsHidden, 'Short') + ' from your subscriptions aren’t in this list (they’re vertical; they play best on YouTube’s Shorts page).'));
      sn.appendChild(hostedBtn('Open Shorts', ORIGIN + '/feed/subscriptions/shorts', 'Subscriptions: Shorts'));
      Y.body.appendChild(sn);
    }
  }

  function viewChannel(v, a) {
    var ch = (a && a.channel) || {};
    var name = txt(ch.name) || v.name || 'Channel';
    var bits = [txt(ch.handle), txt(ch.subscribers), txt(ch.videos)].filter(Boolean);
    var t = el('div', 'ytp-ch');
    t.appendChild(avatarEl({ name: name, avatar: https(ch.avatar) || v.avatar }, 'yt-av lg'));
    Y.head.appendChild(t);
    var acts = title(name, bits.join(' \u00b7 ') || 'YouTube channel');
    acts.appendChild(refreshBtn(v, a));
    acts.appendChild(hostedBtn('Shorts', ORIGIN + v.path + '/shorts', name + ': Shorts'));
    acts.appendChild(hostedBtn('Open on YouTube', ORIGIN + v.path, name));
    noteFor(v, a, 'this channel');
    if (stateBody(v, a, { what: 'this channel', loading: 'Reading ' + name + '\u2026', signedOut: 'YouTube asked the reader to sign in.',
      emptyTitle: 'No videos yet', empty: name + ' hasn’t posted any videos (Shorts and live streams are on YouTube’s own tabs).', emptyAct: ['Open on YouTube', ORIGIN + v.path], hosted: ORIGIN + v.path })) return;
    var sub = 'Newest first';
    if (a.shortsHidden) sub += ' \u00b7 ' + plural(a.shortsHidden, 'Short') + ' left out';
    Y.body.appendChild(section('Videos', sub, grid(a.items, { noChannel: true })));
  }

  function viewLibrary(a) {
    var v = top();
    var acts = title('Library', 'Watch later, Liked videos and your playlists, from YouTube');
    if (a && a.state !== 'signed-out') acts.appendChild(refreshBtn(v, a));
    acts.appendChild(hostedBtn('Open on YouTube', ORIGIN + '/feed/you', 'Library'));
    var any = a && (a.wl || a.ll || a.playlists);
    if (a && a.state === 'ok' && !any) a = Object.assign({}, a, { state: 'never' });
    if (!any && stateBody(v, a && Object.assign({}, a, { items: [] }), { what: 'your library', loading: 'Reading your library\u2026', signedOut: 'Watch later, Liked videos and your playlists show here once you’re signed in.',
      emptyTitle: 'Nothing saved yet', empty: '', hosted: ORIGIN + '/feed/you' })) return;
    if (a.state === 'error' && any) noteFor(v, Object.assign({}, a, { items: [1] }), 'your library');
    else if (a.refreshing) noteFor(v, Object.assign({}, a, { items: [1] }), 'your library');
    [['wl', 'Watch later', 'WL', 'Nothing in Watch later. Save a video on YouTube and it shows here.'],
      ['ll', 'Liked videos', 'LL', 'No liked videos yet.']].forEach(function (s) {
      var part = a[s[0]];
      if (!part) return;
      var more = null;
      var count = part.playlist && txt(part.playlist.count);
      if (part.items.length) more = btn('btn sm ghost', 'See all' + (count ? ' (' + count + ')' : ''), function () { open({ kind: 'playlist', id: s[2], title: s[1] }); });
      var body;
      if (part.state === 'error' && !part.items.length) body = sectionErr(part.reason, ORIGIN + '/playlist?list=' + s[2], s[1]);
      else if (!part.items.length) body = el('p', 'yt-empty', s[3]);
      else body = grid(part.items.slice(0, 12));
      Y.body.appendChild(section(s[1], part.state === 'error' && part.items.length ? 'couldn’t refresh: ' + part.reason : '', body, more));
    });
    var pl = a.playlists;
    if (pl) {
      var pbody;
      if (pl.state === 'error') pbody = sectionErr(pl.reason, ORIGIN + '/feed/playlists', 'Playlists');
      else if (!pl.items.length) pbody = el('p', 'yt-empty', 'No playlists yet.');
      else {
        pbody = el('div', 'yt-grid');
        pl.items.forEach(function (p) { pbody.appendChild(plTile(p)); });
      }
      Y.body.appendChild(section('Playlists', pl.items.length ? plural(pl.items.length, 'playlist') : '', pbody));
    }
  }
  function sectionErr(reason, url, what) {
    var n = el('div', 'res-note err');
    n.appendChild(el('span', 'grow why', 'Couldn’t read it. YouTube: ' + (reason || 'the read failed') + '.'));
    n.appendChild(hostedBtn('Open on YouTube', url, what));
    return n;
  }
  function plTile(p) {
    var c = el('div', 'yt-cell');
    var b = btn('yt-play yt-pl', '', function () { open({ kind: 'playlist', id: p.id, title: p.title }); });
    b.dataset.fk = 'p:' + p.id;
    var art = el('span', 'yt-art');
    if (p.image) { var im = el('img'); im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; im.referrerPolicy = 'no-referrer'; im.src = p.image; art.appendChild(im); }
    if (p.count) art.appendChild(el('span', 'len', p.count));
    b.appendChild(art);
    b.appendChild(el('span', 'yt-t', p.title));
    b.setAttribute('aria-label', 'Playlist ' + p.title + (p.count ? ', ' + p.count : '') + '. Opens in Lumen.');
    c.appendChild(b);
    var by = el('div', 'yt-by');
    by.appendChild(el('span', 'yt-age', p.owner ? 'Playlist \u00b7 ' + p.owner : 'Playlist'));
    c.appendChild(by);
    return c;
  }

  function viewPlaylist(v, a) {
    var h = (a && a.playlist) || {};
    var name = txt(h.title) || v.title || 'Playlist';
    var acts = title(name, [txt(h.owner) && 'by ' + txt(h.owner), txt(h.count)].filter(Boolean).join(' \u00b7 ') || 'Playlist');
    acts.appendChild(refreshBtn(v, a));
    acts.appendChild(hostedBtn('Open on YouTube', ORIGIN + '/playlist?list=' + v.id, name));
    noteFor(v, a, 'this playlist');
    if (stateBody(v, a, { what: 'this playlist', loading: 'Reading ' + name + '\u2026', signedOut: 'This playlist shows here once you’re signed in.',
      emptyTitle: 'This playlist is empty', empty: '', hosted: ORIGIN + '/playlist?list=' + v.id })) return;
    Y.body.appendChild(section('Videos', 'In playlist order', grid(a.items)));
  }

  /* ------------------------------------------------------------ keys */

  /* Arrows move between tiles by where they sit (a grid of any width). */
  function gridKey(e) {
    var k = e.key;
    if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'ArrowUp' && k !== 'ArrowDown') return;
    var cur = e.target && e.target.closest ? e.target.closest('.yt-play') : null;
    if (!cur || e.altKey || e.ctrlKey || e.metaKey) return;
    var all = Array.prototype.slice.call(Y.el.querySelectorAll('.yt-play'));
    var a = cur.getBoundingClientRect();
    var best = null, bestD = Infinity;
    all.forEach(function (b) {
      if (b === cur) return;
      var r = b.getBoundingClientRect();
      var dx = (r.left + r.width / 2) - (a.left + a.width / 2), dy = (r.top + r.height / 2) - (a.top + a.height / 2);
      var ok = k === 'ArrowLeft' ? dx < -4 && Math.abs(dy) < a.height / 2 : k === 'ArrowRight' ? dx > 4 && Math.abs(dy) < a.height / 2 : k === 'ArrowUp' ? dy < -4 : dy > 4;
      if (!ok) return;
      var d = k === 'ArrowLeft' || k === 'ArrowRight' ? Math.abs(dx) : Math.abs(dy) * 4 + Math.abs(dx);
      if (d < bestD) { bestD = d; best = b; }
    });
    if (best) { e.preventDefault(); best.focus(); best.scrollIntoView({ block: 'nearest' }); }
  }

  /** watch.js onKey, first: Esc / Alt+Left walk back out of the pages. */
  function onKey(e) {
    if (!isOpen()) return false;
    if (e.key === 'Escape' || (e.key === 'ArrowLeft' && e.altKey) || e.key === 'BrowserBack') {
      e.preventDefault();
      back();
      return true;
    }
    // The page's own keys (search's '/', the lens arrows) wait while a page is open.
    if (e.key === '/' || ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !(e.target && e.target.closest && e.target.closest('.ytp')))) { return e.key !== '/'; }
    return !!(e.target && e.target.closest && e.target.closest('.ytp'));
  }

  function attach(helpers) {
    H = helpers;
    build();
    // The mouse's back button walks back out of the pages too.
    window.addEventListener('mouseup', function (e) { if (e.button === 3 && isOpen()) { e.preventDefault(); back(); } });
    send('subs', {});
  }

  window.WatchYt = {
    attach: attach, row: row, head: head, card: card, openCard: openCard, stageState: stageState, stageActs: stageActs, onKey: onKey,
    open: open, back: back, close: close, isOpen: isOpen,
    _state: function () { return { subs: Y.subs && { state: Y.subs.state, n: Y.subs.items.length, newCount: Y.subs.newCount, refreshing: Y.subs.refreshing }, views: Y.views.map(viewKey), pages: Object.keys(Y.pages) }; }
  };
})();
