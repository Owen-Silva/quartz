/* ============================================================
   watch-comments.js -- Lumen's own YouTube comments, under the
   video in Lumen's playback view (watch-playview.js).

   The view leaves a mount (#lumen-pv-comments) under the description
   and fires 'lumen-pv-info' each time it draws the info. This file
   fills that mount with comments drawn by Lumen: the count, Top /
   Newest, each comment (avatar, author, time, text, likes, "N
   replies" that expands), and the next page loading as he scrolls.

     - Where the data comes from: the hosted YouTube page itself. Its
       own ytInitialData has the comments section's first continuation
       token; the next pages are the page's OWN continuation requests
       (POST /youtubei/v1/next on the page's origin, with the page's
       own ytcfg context), made from inside the page, the same request
       YouTube makes when you scroll to its comments. No API key, no
       other host. The answer is parsed here (parse(): both YouTube's
       entity shape and the older commentRenderer shape).
     - Account actions (Like a comment, Reply, Comment) press YouTube's
       OWN controls in the hosted page: one press per click, only on
       his click, the state read back from the page. YouTube draws its
       own comments only when its section is in view, so on his click
       Lumen lets the page's own section lay out (invisible, behind the
       player) until YouTube has drawn it, then presses. When the page
       hasn't drawn that comment (a later page, the other sort) the
       control says so and "Open comments on YouTube" shows YouTube's
       own comments, in Lumen (the view's Full page).
     - Links in a comment are plain text and anchors (textContent only,
       http(s) only); they open in Lumen (YouTube's own links), seek
       the video (a timestamp in this video), or open in a Quartz tab.
     - Every state says why: loading, comments turned off, no comments
       here, none yet, signed out, offline, and a failed load (the
       reason and Retry).
     - Shorts: no comments panel (the Shorts view has no mount).

   Hooks: the 'lumen-pv-info' event and the mount; with this file
   missing the mount stays hidden. Also a CommonJS module for the unit
   harness (the pure parts).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LumenComments = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================ pure */

  var YT = 'https://www.youtube.com';
  var PAGE_MAX = 400;          // comments kept in the list (older ones stay, the next pages stop)
  var CLAMP = 300;             // characters before "Read more"

  function runs(x) {
    if (!x) return '';
    if (typeof x === 'string') return x;
    if (x.simpleText !== undefined) return String(x.simpleText);
    if (x.content !== undefined && typeof x.content === 'string') return x.content;
    if (Array.isArray(x.runs)) return x.runs.map(function (r) { return r && r.text ? String(r.text) : ''; }).join('');
    return '';
  }
  function dig(o, path) {
    var x = o;
    for (var i = 0; i < path.length; i++) { if (x === null || x === undefined) return undefined; x = x[path[i]]; }
    return x;
  }
  function lastThumb(list) {
    var l = Array.isArray(list) ? list : [];
    var u = l.length ? (l[l.length - 1].url || '') : '';
    return safeImg(u);
  }
  /** An image URL Lumen will load: https or data:image only (protocol-relative made https). */
  function safeImg(u) {
    var s = String(u || '').trim();
    if (/^\/\//.test(s)) s = 'https:' + s;
    if (/^https:\/\//i.test(s)) return s;
    if (/^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(s)) return s;
    return '';
  }

  /**
   * A link a comment may carry, as Lumen will open it: { href, kind } with kind 'yt' (a YouTube page:
   * opens in Lumen), 'time' (this video at t: the player seeks), 'web' (another site: a Quartz tab),
   * or null when it isn't http(s). YouTube's /redirect?q= is unwrapped to where it goes.
   */
  function linkOf(url, videoId) {
    var s = String(url || '').trim();
    if (!s) return null;
    if (/^\//.test(s) && !/^\/\//.test(s)) s = YT + s;
    var u;
    try { u = new URL(s); } catch (e) { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    var yt = /(^|\.)youtube\.com$/i.test(u.hostname) || /(^|\.)youtu\.be$/i.test(u.hostname);
    if (yt && u.pathname === '/redirect') {
      var q = u.searchParams.get('q');
      return q && q !== s ? linkOf(q, videoId) : null;
    }
    if (!yt) return { href: u.href, kind: 'web' };
    var v = u.searchParams.get('v') || (/(^|\.)youtu\.be$/i.test(u.hostname) ? u.pathname.slice(1) : '');
    var t = tSeconds(u.searchParams.get('t') || u.searchParams.get('start'));
    if (v && videoId && v === videoId && t !== null) return { href: u.href, kind: 'time', t: t };
    return { href: u.href, kind: 'yt' };
  }
  function tSeconds(t) {
    if (t === null || t === undefined || t === '') return null;
    var s = String(t);
    if (/^\d+s?$/.test(s)) return parseInt(s, 10);
    var m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
    if (m && (m[1] || m[2] || m[3])) return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
    return null;
  }
  /** The URL a YouTube command goes to (urlEndpoint, watchEndpoint, browseEndpoint, its metadata), or ''. */
  function cmdUrl(c) {
    var x = c && (c.innertubeCommand || c);
    if (!x || typeof x !== 'object') return '';
    if (x.urlEndpoint && x.urlEndpoint.url) return String(x.urlEndpoint.url);
    if (x.watchEndpoint && x.watchEndpoint.videoId) {
      // startTimeSeconds 0 is a real time ("0:00" in a chapter list): it seeks to the start, it never opens the video
      // again (a truthiness test dropped it, so "0:00" reloaded the video he was watching).
      var sts = x.watchEndpoint.startTimeSeconds;
      var hasT = sts !== undefined && sts !== null && sts !== '' && isFinite(Number(sts)) && Number(sts) >= 0;
      return YT + '/watch?v=' + encodeURIComponent(x.watchEndpoint.videoId) + (hasT ? '&t=' + Math.floor(Number(sts)) + 's' : '');
    }
    if (x.browseEndpoint) {
      if (x.browseEndpoint.canonicalBaseUrl) return YT + x.browseEndpoint.canonicalBaseUrl;
      if (x.browseEndpoint.browseId) return YT + '/channel/' + encodeURIComponent(x.browseEndpoint.browseId);
    }
    var w = dig(x, ['commandMetadata', 'webCommandMetadata', 'url']);
    return w ? String(w) : '';
  }

  /** A comment's text as segments [{ text, link? }] from the entity shape (content + commandRuns). */
  function segsFromContent(c, videoId) {
    var text = String((c && c.content) || '');
    var cr = (c && Array.isArray(c.commandRuns) ? c.commandRuns : []).slice().sort(function (a, b) { return (a.startIndex || 0) - (b.startIndex || 0); });
    var out = [], at = 0;
    cr.forEach(function (r) {
      var st = Number(r.startIndex) || 0, len = Number(r.length) || 0;
      if (st < at || len <= 0 || st + len > text.length) return;
      if (st > at) out.push({ text: text.slice(at, st) });
      var l = linkOf(cmdUrl(r.onTap), videoId);
      out.push(l ? { text: text.slice(st, st + len), link: l } : { text: text.slice(st, st + len) });
      at = st + len;
    });
    if (at < text.length) out.push({ text: text.slice(at) });
    return out;
  }
  /** The same, from the older shape (contentText.runs, each with its navigationEndpoint). */
  function segsFromRuns(rs, videoId) {
    return (Array.isArray(rs) ? rs : []).map(function (r) {
      var t = String((r && r.text) || '');
      var l = r && r.navigationEndpoint ? linkOf(cmdUrl(r.navigationEndpoint), videoId) : null;
      return l ? { text: t, link: l } : { text: t };
    }).filter(function (s) { return s.text; });
  }
  function segsText(segs) { return (segs || []).map(function (s) { return s.text; }).join(''); }

  function num(s) {
    var t = String(s === undefined || s === null ? '' : s).replace(/,/g, '').trim();
    var m = /^([\d.]+)\s*([KMB])?/i.exec(t);
    if (!m) return 0;
    var n = parseFloat(m[1]);
    var k = (m[2] || '').toUpperCase();
    return Math.round(n * (k === 'K' ? 1e3 : k === 'M' ? 1e6 : k === 'B' ? 1e9 : 1));
  }
  function repliesToken(rr) {
    // YouTube's web client now puts a thread's replies token under subThreads (contents is the older place): read
    // only from contents, every thread on real YouTube came back with no replies at all (r62, real-YouTube probe).
    var c = rr ? [].concat(Array.isArray(rr.contents) ? rr.contents : [], Array.isArray(rr.subThreads) ? rr.subThreads : []) : [];
    for (var i = 0; i < c.length; i++) { var t = contToken(c[i].continuationItemRenderer); if (t) return t; }
    return '';
  }
  function contToken(ci) {
    if (!ci) return '';
    return String(dig(ci, ['continuationEndpoint', 'continuationCommand', 'token']) || dig(ci, ['button', 'buttonRenderer', 'command', 'continuationCommand', 'token']) || '');
  }

  /** One comment from the entity shape: the view model's keys into the mutations. */
  function fromViewModel(vm, ents, videoId) {
    var e = ents[vm.commentKey] || null;
    var cep = e && e.commentEntityPayload ? e.commentEntityPayload : null;
    if (!cep) return null;
    var pr = cep.properties || {}, au = cep.author || {}, tb = cep.toolbar || {};
    var ts = ents[vm.toolbarStateKey || pr.toolbarStateKey] || null;
    var st = ts && ts.engagementToolbarStateEntityPayload ? ts.engagementToolbarStateEntityPayload : {};
    var liked = st.likeState === 'TOOLBAR_LIKE_STATE_LIKED';
    var segs = segsFromContent(pr.content, videoId);
    var authorUrl = cmdUrl(dig(au, ['channelCommand'])) || (au.channelId ? YT + '/channel/' + au.channelId : '');
    return {
      id: String(pr.commentId || vm.commentId || ''), author: String(au.displayName || ''), authorUrl: authorUrl,
      avatar: safeImg(au.avatarThumbnailUrl) || safeImg(dig(cep, ['avatar', 'image', 'sources', 0, 'url'])),
      time: String(pr.publishedTime || ''), segs: segs, text: segsText(segs),
      likes: String((liked ? tb.likeCountLiked : tb.likeCountNotliked) || '').trim(), liked: liked,
      replies: num(tb.replyCount), replyLevel: Number(pr.replyLevel) || 0,
      pinned: !!vm.pinnedText, pinnedText: String(vm.pinnedText || ''), creator: !!au.isCreator, verified: !!au.isVerified,
      hearted: st.heartState === 'TOOLBAR_HEART_STATE_HEARTED', repliesToken: ''
    };
  }
  /** One comment from the older shape. */
  function fromRenderer(r, videoId) {
    if (!r || !r.commentId) return null;
    var segs = segsFromRuns(dig(r, ['contentText', 'runs']) || (r.contentText && r.contentText.simpleText ? [{ text: r.contentText.simpleText }] : []), videoId);
    var heart = dig(r, ['actionButtons', 'commentActionButtonsRenderer', 'creatorHeart', 'creatorHeartRenderer', 'isHearted']);
    return {
      id: String(r.commentId), author: runs(r.authorText), authorUrl: cmdUrl(r.authorEndpoint),
      avatar: lastThumb(dig(r, ['authorThumbnail', 'thumbnails'])), time: runs(r.publishedTimeText),
      segs: segs, text: segsText(segs), likes: runs(r.voteCount).trim(), liked: !!r.isLiked,
      replies: Number(r.replyCount) || 0, replyLevel: 0, pinned: !!r.pinnedCommentBadge, pinnedText: r.pinnedCommentBadge ? runs(dig(r, ['pinnedCommentBadge', 'pinnedCommentBadgeRenderer', 'label'])) : '',
      creator: !!r.authorIsChannelOwner, verified: !!(r.authorCommentBadge), hearted: !!heart, repliesToken: ''
    };
  }

  /**
   * YouTube's answer to a comments continuation, as Lumen draws it:
   * { header: { count, countText, sorts: [{ label, token, selected }] } | null, items: [comment], next: token,
   *   reload: bool (a new list, e.g. a sort), known: bool (Lumen recognised the answer) }.
   */
  function parse(json, videoId) {
    var out = { header: null, items: [], next: '', reload: false, known: false };
    if (!json || typeof json !== 'object') return out;
    var ents = {};
    (dig(json, ['frameworkUpdates', 'entityBatchUpdate', 'mutations']) || []).forEach(function (m) { if (m && m.entityKey && m.payload) ents[m.entityKey] = m.payload; });
    var lists = [];
    (json.onResponseReceivedEndpoints || json.onResponseReceivedActions || []).forEach(function (ep) {
      var r = ep && ep.reloadContinuationItemsCommand, a = ep && ep.appendContinuationItemsAction;
      if (r && Array.isArray(r.continuationItems)) { lists.push(r.continuationItems); out.reload = true; out.known = true; }
      if (a && Array.isArray(a.continuationItems)) { lists.push(a.continuationItems); out.known = true; }
    });
    lists.forEach(function (items) {
      items.forEach(function (it) {
        if (!it || typeof it !== 'object') return;
        if (it.commentsHeaderRenderer) { out.header = header(it.commentsHeaderRenderer); return; }
        if (it.continuationItemRenderer) { var t = contToken(it.continuationItemRenderer); if (t) out.next = t; return; }
        var c = null;
        if (it.commentThreadRenderer) {
          var th = it.commentThreadRenderer;
          var vm = dig(th, ['commentViewModel', 'commentViewModel']);
          c = vm ? fromViewModel(vm, ents, videoId) : fromRenderer(dig(th, ['comment', 'commentRenderer']), videoId);
          if (c) {
            var rr = dig(th, ['replies', 'commentRepliesRenderer']);
            c.repliesToken = repliesToken(rr);
            if (c.repliesToken && !c.replies) c.replies = num(runs(dig(rr, ['viewReplies', 'buttonRenderer', 'text']))) || 1;
            if (!c.repliesToken) c.replies = 0;
            if (th.renderingPriority === 'RENDERING_PRIORITY_PINNED_COMMENT') c.pinned = true;
          }
        } else if (it.commentViewModel) {
          c = fromViewModel(it.commentViewModel.commentViewModel || it.commentViewModel, ents, videoId);
        } else if (it.commentRenderer) {
          c = fromRenderer(it.commentRenderer, videoId);
        }
        if (c && c.id) out.items.push(c);
      });
    });
    return out;
  }
  function header(h) {
    var count = runs(h.countText) || runs(h.commentsCount);
    var sorts = (dig(h, ['sortMenu', 'sortFilterSubMenuRenderer', 'subMenuItems']) || []).map(function (s) {
      return { label: String(s.title || runs(s.text) || ''), token: String(dig(s, ['serviceEndpoint', 'continuationCommand', 'token']) || dig(s, ['continuation', 'reloadContinuationData', 'continuation']) || ''), selected: !!s.selected };
    }).filter(function (s) { return s.label && s.token; });
    return { count: num(count), countText: countLabel(count), sorts: sorts };
  }
  /** "1,234" / "1,234 Comments" / "1 Comment" -> "1,234 Comments" (always with the word). */
  function countLabel(t) {
    var s = String(t || '').replace(/\s+/g, ' ').trim();
    if (!s) return 'Comments';
    if (/comment/i.test(s)) return s;
    return s + (num(s) === 1 ? ' Comment' : ' Comments');
  }

  /**
   * The comments section of a watch page's data (ytInitialData, or the page's own /next answer):
   * { state: 'token' | 'off' | 'none', token, message }.
   */
  function section(yd) {
    var cs = dig(yd, ['contents', 'twoColumnWatchNextResults', 'results', 'results', 'contents']);
    if (!Array.isArray(cs)) return { state: 'none', token: '', message: '' };
    for (var i = 0; i < cs.length; i++) {
      var sec = cs[i] && cs[i].itemSectionRenderer;
      if (!sec || sec.sectionIdentifier !== 'comment-item-section') continue;
      var items = Array.isArray(sec.contents) ? sec.contents : [];
      for (var j = 0; j < items.length; j++) {
        var t = contToken(items[j].continuationItemRenderer);
        if (t) return { state: 'token', token: t, message: '' };
        if (items[j].messageRenderer) return { state: 'off', token: '', message: runs(items[j].messageRenderer.text).trim() };
      }
      return { state: 'off', token: '', message: '' };
    }
    return { state: 'none', token: '', message: '' };
  }

  /** The words for a state: { title, why } (never empty: no silent states). */
  function words(state, o) {
    var x = o || {};
    switch (state) {
      case 'loading': return { title: 'Loading comments…', why: 'Reading them from YouTube’s page.' };
      case 'off': return { title: 'Comments are turned off', why: x.message ? 'YouTube’s page says: “' + x.message.replace(/\s*Learn more\s*$/i, '').trim() + '”' : 'YouTube’s page has no comments for this video.' };
      case 'none': return { title: 'No comments here', why: 'YouTube’s page doesn’t offer comments for this video (a live stream or a premiere has its chat instead).' };
      case 'empty': return { title: 'No comments yet', why: x.signedIn === false ? 'Nobody has commented on this video yet.' : 'Nobody has commented on this video yet. Be the first.' };
      case 'offline': return { title: 'You’re offline', why: 'Comments load when you’re back online.' };
      case 'failed': return { title: 'Comments didn’t load', why: 'Lumen couldn’t load comments: ' + (x.reason || 'YouTube’s page didn’t answer') + '.' };
      case 'signedout': return { title: '', why: 'You’re signed out of YouTube here: liking, replying and commenting need you signed in.' };
      default: return { title: '', why: '' };
    }
  }

  /** Whether a comment's text is long enough to clamp (Read more). */
  function long(c) { var t = String((c && c.text) || ''); return t.length > CLAMP || (t.match(/\n/g) || []).length >= 4; }

  /** Adds page items to a list, without repeating a comment (YouTube can repeat across pages). */
  function merge(list, items) {
    var seen = {};
    list.forEach(function (c) { seen[c.id] = 1; });
    var added = 0;
    (items || []).forEach(function (c) { if (!seen[c.id] && list.length < PAGE_MAX) { seen[c.id] = 1; list.push(c); added++; } });
    return added;
  }

  /* ---------------------------------------------------------------- in the page */

  /**
   * Installed in the hosted YouTube page (its own world): reads the comments section from the page's
   * own data, makes the page's own continuation requests, and presses the page's OWN comment controls.
   * Serialised with String(); it uses nothing from outside itself.
   */
  function guest() {
    var V = 1;
    if (window.__lumenCm && window.__lumenCm.v === V) return;
    function Q(sel, r) { try { return (r || document).querySelector(sel); } catch (e) { return null; } }
    function QA(sel, r) { try { return Array.prototype.slice.call((r || document).querySelectorAll(sel)); } catch (e) { return []; } }
    function txt(n) { return n ? String(n.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
    function wait(fn, ms) {
      return new Promise(function (ok) {
        var t0 = Date.now();
        (function loop() { var v = null; try { v = fn(); } catch (e) { v = null; } if (v) return ok(v); if (Date.now() - t0 > ms) return ok(null); setTimeout(loop, 100); })();
      });
    }
    function cfg(k) { try { return window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg.get(k) : undefined; } catch (e) { return undefined; } }
    function vid() {
      var u = new URL(location.href);
      return u.searchParams.get('v') || ((/^\/live\/([^/?#]+)/.exec(u.pathname) || [])[1]) || '';
    }
    function signed() { var li = cfg('LOGGED_IN'); return typeof li === 'boolean' ? li : null; }
    function cookie(name) {
      var m = new RegExp('(?:^|; )' + name.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&') + '=([^;]*)').exec(document.cookie || '');
      return m ? decodeURIComponent(m[1]) : '';
    }
    // The page's own Authorization for a signed-in request (what YouTube's own fetches send).
    function auth() {
      var sid = cookie('SAPISID') || cookie('__Secure-3PAPISID');
      if (!sid || !window.crypto || !crypto.subtle || !window.TextEncoder) return Promise.resolve('');
      var ts = Math.floor(Date.now() / 1000);
      return crypto.subtle.digest('SHA-1', new TextEncoder().encode(ts + ' ' + sid + ' ' + location.origin)).then(function (b) {
        var h = Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
        return 'SAPISIDHASH ' + ts + '_' + h;
      }, function () { return ''; });
    }
    function next(body) {
      var ctx = cfg('INNERTUBE_CONTEXT') || { client: { clientName: 'WEB', clientVersion: cfg('INNERTUBE_CLIENT_VERSION') || '2.20250101.00.00', hl: 'en' } };
      return auth().then(function (a) {
        var h = { 'Content-Type': 'application/json', 'X-Origin': location.origin };
        var cn = cfg('INNERTUBE_CONTEXT_CLIENT_NAME'), cv = cfg('INNERTUBE_CLIENT_VERSION'), si = cfg('SESSION_INDEX');
        if (cn !== undefined) h['X-Youtube-Client-Name'] = String(cn);
        if (cv !== undefined) h['X-Youtube-Client-Version'] = String(cv);
        if (si !== undefined && si !== null) h['X-Goog-AuthUser'] = String(si);
        if (a) h.Authorization = a;
        var ctl = window.AbortController ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
        return fetch('/youtubei/v1/next?prettyPrint=false', { method: 'POST', credentials: 'same-origin', headers: h,
          body: JSON.stringify(Object.assign({ context: ctx }, body)), signal: ctl ? ctl.signal : undefined })
          .then(function (res) {
            clearTimeout(timer);
            if (!res.ok) return { ok: false, status: res.status, reason: 'YouTube answered ' + res.status };
            return res.json().then(function (j) { return { ok: true, json: j }; }, function () { return { ok: false, reason: 'YouTube’s answer wasn’t readable' }; });
          }, function (e) {
            clearTimeout(timer);
            return { ok: false, reason: e && e.name === 'AbortError' ? 'YouTube didn’t answer in 15 seconds' : 'the request failed (' + ((e && e.message) || e) + ')' };
          });
      });
    }
    /** The comments section's first token: the page's own data, or (moved in place) the page's own /next. */
    function first() {
      var id = vid();
      var yd = window.ytInitialData;
      var dataId = yd && yd.currentVideoEndpoint && yd.currentVideoEndpoint.watchEndpoint && yd.currentVideoEndpoint.watchEndpoint.videoId;
      if (!id) return Promise.resolve({ ok: false, reason: 'this page isn’t a video' });
      if (yd && dataId === id) return Promise.resolve({ ok: true, from: 'ytInitialData', videoId: id, signedIn: signed(), data: pick(yd) });
      return next({ videoId: id }).then(function (r) {
        return r.ok ? { ok: true, from: 'next', videoId: id, signedIn: signed(), data: pick(r.json) } : { ok: false, videoId: id, reason: r.reason };
      });
    }
    // Only the part Lumen reads (the section list), not the whole page's data.
    function pick(yd) {
      try { return { contents: { twoColumnWatchNextResults: { results: { results: { contents: yd.contents.twoColumnWatchNextResults.results.results.contents.filter(function (c) { return c && c.itemSectionRenderer; }) } } } } }; }
      catch (e) { return null; }
    }
    function load(token) { return next({ continuation: String(token || '') }); }

    /* --- YouTube's own comment controls ---- */
    function own() { return Q('ytd-comments#comments') || Q('ytd-comments'); }
    function idOf(n) {
      var a = Q('#published-time-text a', n) || Q('a[href*="lc="]', n);
      var m = a ? /[?&]lc=([^&#]+)/.exec(a.getAttribute('href') || '') : null;
      return m ? decodeURIComponent(m[1]) : '';
    }
    function comments() { return QA('ytd-comment-view-model, ytd-comment-renderer', own() || document); }
    function findComment(id) { return comments().filter(function (n) { return idOf(n) === id; })[0] || null; }
    function likeOf(n) { return n ? (Q('#like-button button', n) || Q('button[aria-label^="Like this comment" i]', n) || Q('button[aria-label^="Like this reply" i]', n)) : null; }
    function pressed(b) { return !!b && b.getAttribute('aria-pressed') === 'true'; }
    // YouTube draws its own comments only when its section is in view: on his click, let the section lay
    // out (invisible, behind the player: the CSS keys on data-lumen-cm) and nudge its own scroll checks.
    function wake() {
      document.documentElement.setAttribute('data-lumen-cm', '');
      try { window.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize')); } catch (e) { /* none */ }
    }
    function ensure(fn, ms) {
      var v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return Promise.resolve(v);
      wake();
      return wait(fn, ms || 8000);
    }
    function fill(ed, text) {
      try { ed.focus(); } catch (e) { /* not focusable */ }
      var ok = false;
      try { document.execCommand('selectAll', false, null); ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
      if (!ok || txt(ed) !== String(text).replace(/\s+/g, ' ').trim()) {
        ed.textContent = text;
        try { ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); } catch (e) { ed.dispatchEvent(new Event('input', { bubbles: true })); }
      }
    }
    function submitOf(box) { var b = Q('#submit-button button', box) || Q('#submit-button', box); return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null; }
    function editOf(box) { return Q('#contenteditable-root', box) || Q('[contenteditable="true"]', box); }
    function sendIn(box, text, scope) {
      var ed = editOf(box);
      if (!ed) return Promise.resolve({ ok: false, reason: 'YouTube’s comment box didn’t open' });
      fill(ed, text);
      // His comment, read back: a comment with his text that didn't have it before the press (in this thread for a
      // reply). By text alone, someone else's identical comment ("First!") was taken for his; and when YouTube showed
      // his text differently, "the page's first comment" was: a reply came back as the pinned comment, by someone
      // else. No match: Lumen shows his own words and says the page didn't show them back yet (never a stranger's).
      var want = String(text).replace(/\s+/g, ' ').trim();
      var where = function () { return scope ? QA('ytd-comment-view-model, ytd-comment-renderer', scope) : comments(); };
      var his = function (n) { return txt(Q('#content-text', n)) === want; };
      var had = where().filter(his);
      return wait(function () { return submitOf(box); }, 2500).then(function (b) {
        if (!b) return { ok: false, reason: 'YouTube’s Comment button stayed off' };
        b.click();   // the one press
        return wait(function () {
          return where().filter(function (n) { return his(n) && had.indexOf(n) < 0; })[0] || null;
        }, 6000).then(function (n) {
          if (!n) return { ok: true, confirmed: false };
          return { ok: true, confirmed: true, comment: { id: idOf(n), author: txt(Q('#author-text', n)), text: txt(Q('#content-text', n)), time: txt(Q('#published-time-text', n)) } };
        });
      });
    }
    /** One press of the page's own control, on his click. Never called by itself. */
    function press(kind, arg) {
      var a = arg || {};
      if (signed() === false) return Promise.resolve({ ok: false, reason: 'you’re signed out of YouTube' });
      if (kind === 'like') {
        return ensure(function () { return findComment(String(a.id)); }, 8000).then(function (n) {
          if (!n) return { ok: false, open: true, reason: own() ? 'YouTube’s page hasn’t loaded this comment, so its Like isn’t there' : 'YouTube’s comments aren’t on its page' };
          var b = likeOf(n);
          if (!b) return { ok: false, open: true, reason: 'YouTube’s Like for this comment isn’t on its page' };
          var was = pressed(b);
          b.click();   // the one press
          return wait(function () { var x = likeOf(findComment(String(a.id))); return x && pressed(x) !== was ? x : null; }, 2500).then(function (x) {
            var nb = likeOf(findComment(String(a.id)));
            var cnt = findComment(String(a.id));
            return { ok: true, changed: !!x, on: pressed(nb), count: txt(Q('#vote-count-middle', cnt)) };
          });
        });
      }
      if (kind === 'post') {
        var boxOpen = function () { var h = Q('ytd-comments ytd-comments-header-renderer') || own(); var bx = h ? Q('ytd-commentbox', h) : null; return bx && editOf(bx) ? bx : null; };
        var placeholder = function () { return Q('ytd-comments #simple-box #placeholder-area') || Q('ytd-comments #simple-box'); };
        return ensure(function () { return boxOpen() || placeholder(); }, 8000).then(function (x) {
          if (!x) return { ok: false, open: true, reason: own() ? 'YouTube’s comment box isn’t on its page' : 'YouTube’s comments aren’t on its page' };
          if (!boxOpen()) x.click();
          return wait(boxOpen, 2500).then(function (bx) { return bx ? sendIn(bx, String(a.text || '')) : { ok: false, reason: 'YouTube’s comment box didn’t open' }; });
        });
      }
      if (kind === 'reply') {
        return ensure(function () { return findComment(String(a.id)); }, 8000).then(function (n) {
          if (!n) return { ok: false, open: true, reason: own() ? 'YouTube’s page hasn’t loaded this comment, so its Reply isn’t there' : 'YouTube’s comments aren’t on its page' };
          var scope = n.closest('ytd-comment-thread-renderer') || n.parentElement || n;
          var boxIn = function () { var bx = QA('ytd-commentbox', scope).filter(function (b) { return !!editOf(b); })[0]; return bx || null; };
          if (!boxIn()) {
            var rb = Q('#reply-button-end button', n) || QA('button', n).filter(function (b) { return /^reply$/i.test(txt(b)) || /^reply$/i.test(b.getAttribute('aria-label') || ''); })[0];
            if (!rb) return { ok: false, open: true, reason: 'YouTube’s Reply for this comment isn’t on its page' };
            rb.click();
          }
          return wait(boxIn, 2500).then(function (bx) { return bx ? sendIn(bx, String(a.text || ''), scope) : { ok: false, reason: 'YouTube’s reply box didn’t open' }; });
        });
      }
      return Promise.resolve({ ok: false, reason: 'unknown control ' + kind });
    }
    /** For "Open comments on YouTube": YouTube's own comments section, scrolled into view. */
    function showOwn() {
      document.documentElement.removeAttribute('data-lumen-cm');
      var o = own();
      if (o) { try { o.scrollIntoView({ block: 'start' }); } catch (e) { /* gone */ } }
      return { ok: !!o };
    }
    /** A timestamp in this video: YouTube's own player seeks. */
    function seek(t) {
      var mp = Q('#movie_player');
      if (mp && typeof mp.seekTo === 'function') { mp.seekTo(Number(t) || 0, true); return { ok: true, how: 'player' }; }
      var v = Q('#movie_player video') || Q('video');
      if (!v) return { ok: false, reason: 'no video on the page' };
      v.currentTime = Number(t) || 0;
      return { ok: true, how: 'video' };
    }
    function state() { return { ok: true, videoId: vid(), signedIn: signed(), own: !!own(), drawn: comments().length, woke: document.documentElement.hasAttribute('data-lumen-cm') }; }
    window.__lumenCm = { v: V, first: first, load: load, press: press, showOwn: showOwn, seek: seek, state: state };
  }
  var GUEST = '(' + String(guest) + ')();';
  function call(method, args) {
    return GUEST + 'window.__lumenCm.' + method + '(' + (args || []).map(function (a) { return JSON.stringify(a === undefined ? null : a); }).join(',') + ')';
  }

  /**
   * The page CSS (insertCSS, inert until <html data-lumen-cm>): YouTube's own comments section laid out over
   * the page's viewport, invisible and behind the player, so YouTube draws it for Lumen to press. Only
   * while the view is on (data-lumen-pv); never shown, never clickable.
   */
  var PAGE_CSS = 'html[data-lumen-pv][data-lumen-cm] ytd-comments#comments, html[data-lumen-pv][data-lumen-cm] #below ytd-comments,' +
    ' html[data-lumen-pv][data-lumen-cm] ytd-watch-flexy #comments { display: block !important; position: fixed !important; left: 0 !important; top: 0 !important;' +
    ' width: 100vw !important; height: 100vh !important; overflow: auto !important; visibility: hidden !important; pointer-events: none !important; z-index: 0 !important; }';

  var PURE = { YT: YT, PAGE_MAX: PAGE_MAX, CLAMP: CLAMP, runs: runs, safeImg: safeImg, linkOf: linkOf, tSeconds: tSeconds, cmdUrl: cmdUrl,
    segsFromContent: segsFromContent, segsFromRuns: segsFromRuns, num: num, parse: parse, section: section, countLabel: countLabel,
    words: words, long: long, merge: merge, guest: guest, call: call, PAGE_CSS: PAGE_CSS };
  if (typeof document === 'undefined' || typeof window === 'undefined') return PURE;

  /* ================================================================ the chrome */

  var STATES = [];      // one per slot (the latest few)
  var LOG = [];         // every press, for the e2e (kind, id, ok, reason)
  var SEEN = {};        // avatar URLs already decoded once

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = text; return n; }
  function btn(cls, label, fn, aria) {
    var b = el('button', 'cm-btn ' + (cls || ''));
    b.type = 'button';
    if (label) b.appendChild(el('span', 'cm-btn-txt', label));
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', function (e) { e.stopPropagation(); if (!b.disabled) fn(b, e); });
    return b;
  }
  function off(b, why) {
    b.disabled = !!why;
    if (why) { b.title = why; b.setAttribute('data-why', why); } else { b.removeAttribute('title'); b.removeAttribute('data-why'); }
  }
  var LIKE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5V20H4.2a.7.7 0 0 1-.7-.7v-8.1c0-.4.3-.7.7-.7h3.3Zm0 0 3.6-6.2c.3-.5.9-.8 1.5-.6 1 .3 1.5 1.3 1.3 2.3l-.7 3.4h5.1c1.2 0 2.1 1.1 1.8 2.3l-1.6 6.9a2.6 2.6 0 0 1-2.5 2H7.5"/></svg>';
  var CARET_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
  function js(v, code) {
    try { var p = v.executeJavaScript(code, true); return p && p.then ? p : Promise.resolve(p); } catch (e) { return Promise.reject(e); }
  }
  function online() { try { return navigator.onLine !== false; } catch (e) { return true; } }
  function cap(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function stateFor(d) {
    var key = String(d.wcId) + '|' + String(d.videoId);
    var st = STATES.filter(function (x) { return x.slot === d.slot; })[0];
    if (st && st.key === key) return st;
    if (st) { teardown(st); STATES.splice(STATES.indexOf(st), 1); }
    st = { slot: d.slot, key: key, wcId: d.wcId, videoId: d.videoId, hookToken: d.comments && d.comments.token ? String(d.comments.token) : '',
      phase: 'loading', why: '', message: '', signedIn: null, header: null, items: [], next: '', sortLabel: '', loading: false, pageWhy: '',
      replies: {}, busy: {}, notes: {}, composer: { open: false, text: '', busy: false, why: '' }, replyTo: '', replyText: '', replyBusy: false,
      expanded: {}, requests: 0, seq: 0, view: null, tile: null, toggle: null, root: el('div', 'cm-root'), io: null, focus: null };
    st.root.addEventListener('focusin', function (e) { st.focus = e.target; });
    st.root.tabIndex = -1;   // where focus waits when the control he was on is gone or busy (refocus), never a Tab stop
    if (typeof ResizeObserver === 'function') {
      var lastW = -1;
      st.ro = new ResizeObserver(function (es) { var w = es.length ? Math.round(es[es.length - 1].contentRect.width) : -1; if (w !== lastW) { lastW = w; fitSoon(st); } });
      st.ro.observe(st.root);
    }
    st.root.addEventListener('pointerdown', function (e) { if (e.button === 0) st.pressing = true; }, true);
    // Typing in a comment box is his: never the player's keys (K, J, L, F, M, Space, the arrows).
    st.root.addEventListener('keydown', function (e) {
      var t = e.target;
      if (!t || t.tagName !== 'TEXTAREA') return;
      if (e.key === 'Escape') { e.preventDefault(); t.blur(); }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
    });
    STATES.push(st);
    if (STATES.length > 4) teardown(STATES.shift());
    return st;
  }
  function teardown(st) {
    if (!st) return;
    if (st.io) { st.io.disconnect(); st.io = null; }
    if (st.ro) { st.ro.disconnect(); st.ro = null; }
    if (st.fitRaf) { cancelAnimationFrame(st.fitRaf); st.fitRaf = 0; }
  }
  /* The slot closed (watch-playview.js destroy): its section goes with it. Kept, a closed slot's state held its
     whole comments DOM, its listeners and the detached <webview> (lumen-perf: +650 nodes and +150 listeners per
     closed video view, up to four of them). */
  function forget(slot) {
    for (var i = STATES.length - 1; i >= 0; i--) {
      var st = STATES[i];
      if (st.slot !== slot) continue;
      teardown(st);
      st.view = null; st.tile = null; st.focus = null;
      STATES.splice(i, 1);
    }
  }

  /** The view drew its info: put this slot's comments in the mount (the same node, so nothing reloads). */
  function onInfo(ev) {
    var d = ev && ev.detail;
    if (!d || !d.container) return;
    var box = d.container;
    if (!d.videoId) { box.hidden = true; return; }
    var st = stateFor(d);
    var tile = box.closest ? box.closest('.wp-tile') : null;
    st.tile = tile || st.tile;
    st.view = d.view || (tile ? tile.querySelector('webview') : null) || st.view;
    st.toggle = typeof d.toggle === 'function' ? d.toggle : st.toggle;
    var hadFocus = st.focus && st.root.contains(st.focus) && (document.activeElement === document.body || !document.activeElement) ? st.focus : null;
    box.hidden = false;
    box.replaceChildren(st.root);
    if (hadFocus && hadFocus.isConnected) { try { hadFocus.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
    pageCss(st);
    if (!st.started) { st.started = true; start(st); }
    else draw(st);
    watchScroll(st);
  }
  document.addEventListener('lumen-pv-info', onInfo);

  /** The page's CSS for the invisible own section (again after each load of the page). */
  function pageCss(st) {
    var v = st.view;
    if (!v || v.__lumenCmCss) return;
    v.__lumenCmCss = true;
    var put = function () { try { var p = v.insertCSS(PAGE_CSS); if (p && p.catch) p.catch(function () { /* the press says */ }); } catch (e) { /* the press says */ } };
    put();
    v.addEventListener('dom-ready', put);
  }

  function start(st) {
    var seq = ++st.seq;
    st.items = []; st.next = ''; st.header = null; st.replies = {}; st.expanded = {}; st.why = ''; st.pageWhy = '';
    if (!online()) { st.phase = 'offline'; draw(st); return; }
    st.phase = 'loading';
    draw(st);
    if (!st.view) { fail(st, 'the video’s page isn’t there'); return; }
    js(st.view, call('first')).then(function (r) {
      if (seq !== st.seq) return;
      if (!r || !r.ok) { fail(st, (r && r.reason) || 'YouTube’s page didn’t answer'); return; }
      st.signedIn = r.signedIn;
      var sec = section(r.data);
      if (sec.state === 'off') { st.phase = 'off'; st.message = sec.message; draw(st); return; }
      if (sec.state === 'none') {
        if (st.hookToken) sec = { state: 'token', token: st.hookToken };
        else { st.phase = 'none'; draw(st); return; }
      }
      page(st, sec.token, 'first', seq);
    }).catch(function (e) { if (seq === st.seq) fail(st, 'Lumen couldn’t read the page (' + ((e && e.message) || e) + ')'); });
  }
  function fail(st, reason) { st.phase = online() ? 'failed' : 'offline'; st.why = reason; st.loading = false; draw(st); }

  /** One page of comments (the page's own continuation request). how: 'first' | 'more' | 'sort'. */
  function page(st, token, how, seq) {
    if (!token || !st.view) return;
    st.loading = true; st.pageWhy = '';
    st.requests++;
    draw(st);
    js(st.view, call('load', [token])).then(function (r) {
      if (seq !== st.seq) return;
      st.loading = false;
      if (!r || !r.ok) {
        if (how === 'more') { st.pageWhy = 'The next comments didn’t load: ' + ((r && r.reason) || 'YouTube’s page didn’t answer') + '.'; draw(st); return; }
        fail(st, (r && r.reason) || 'YouTube’s page didn’t answer');
        return;
      }
      var p = parse(r.json, st.videoId);
      if (!p.known) {
        if (how === 'more') { st.pageWhy = 'YouTube’s answer had no comments Lumen could read.'; draw(st); return; }
        fail(st, 'YouTube’s answer had no comments Lumen could read');
        return;
      }
      if (p.header) {
        st.header = p.header;
        var sel = p.header.sorts.filter(function (s) { return s.selected; })[0];
        if (sel) st.sortLabel = sel.label;
      }
      if (how !== 'more') { st.items = []; st.replies = {}; st.expanded = {}; }
      merge(st.items, p.items);
      st.next = st.items.length >= PAGE_MAX ? '' : p.next;
      st.phase = st.items.length ? 'ready' : 'empty';
      draw(st);
    }).catch(function (e) {
      if (seq !== st.seq) return;
      st.loading = false;
      if (how === 'more') { st.pageWhy = 'The next comments didn’t load: ' + ((e && e.message) || e) + '.'; draw(st); return; }
      fail(st, 'Lumen couldn’t read the page (' + ((e && e.message) || e) + ')');
    });
  }
  function more(st) { if (st.next && !st.loading && st.phase === 'ready' && online()) page(st, st.next, 'more', st.seq); }
  function sort(st, s) {
    if (!s || !s.token || st.loading || s.label === st.sortLabel) return;
    var seq = ++st.seq;
    st.sortLabel = s.label;
    st.phase = 'loading';
    page(st, s.token, 'sort', seq);
  }

  /** The next page as he scrolls: the list's end, within 600px of the tile's bottom. */
  function watchScroll(st) {
    if (!st.tile || !window.IntersectionObserver) return;
    if (st.io && st.ioRoot === st.tile) { observeEnd(st); return; }
    if (st.io) st.io.disconnect();
    st.ioRoot = st.tile;
    st.io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) more(st); }); }, { root: st.tile, rootMargin: '0px 0px 600px 0px' });
    observeEnd(st);
  }
  function observeEnd(st) {
    var end = st.root.querySelector('.cm-end');
    if (!st.io) return;
    st.io.disconnect();
    if (end) st.io.observe(end);
  }

  /* ---------------------------------------------------------------- replies */

  function toggleReplies(st, c) {
    if (st.expanded[c.id]) { st.expanded[c.id] = false; draw(st); return; }
    st.expanded[c.id] = true;
    var r = st.replies[c.id];
    if (!r) { r = st.replies[c.id] = { items: [], next: c.repliesToken, loading: false, why: '' }; loadReplies(st, c); }
    draw(st);
  }
  function loadReplies(st, c) {
    var r = st.replies[c.id];
    if (!r || r.loading || !r.next || !st.view) return;
    var seq = st.seq;
    r.loading = true; r.why = '';
    st.requests++;
    draw(st);
    // Dropped (the list was asked again: a sort, offline, Try again): the thread must not keep "Loading replies…"
    // for ever, with its own loads refused while r.loading holds. Still on screen, it says so and offers Try again.
    var dropped = function () {
      r.loading = false;
      if (st.replies[c.id] !== r) return;
      r.why = 'Replies didn’t finish loading.';
      if (st.root.isConnected) draw(st);
    };
    js(st.view, call('load', [r.next])).then(function (x) {
      if (seq !== st.seq) { dropped(); return; }
      r.loading = false;
      if (!x || !x.ok) { r.why = 'Replies didn’t load: ' + ((x && x.reason) || 'YouTube’s page didn’t answer') + '.'; draw(st); return; }
      var p = parse(x.json, st.videoId);
      if (!p.known) { r.why = 'YouTube’s answer had no replies Lumen could read.'; draw(st); return; }
      merge(r.items, p.items);
      r.next = p.next;
      draw(st);
    }).catch(function (e) { if (seq === st.seq) { r.loading = false; r.why = 'Replies didn’t load: ' + ((e && e.message) || e) + '.'; draw(st); } else dropped(); });
  }

  /* ---------------------------------------------------------------- presses */

  /** One press of YouTube's own control, on his click: never twice, never by itself. */
  function press(st, kind, c, text) {
    var id = c ? c.id : '';
    var bkey = kind + ':' + id;
    if (st.busy[bkey] || !st.view) return false;
    st.busy[bkey] = true;
    delete st.notes[id || '_post'];
    var rec = { kind: kind, id: id, at: Date.now(), ok: null, reason: '' };
    LOG.push(rec);
    if (LOG.length > 100) LOG.shift();
    if (kind === 'post') st.composer.busy = true;
    if (kind === 'reply') st.replyBusy = true;
    draw(st);
    var v = st.view;
    js(v, call('press', [kind, { id: id, text: text || '' }])).then(function (r) {
      st.busy[bkey] = false;
      rec.ok = !!(r && r.ok);
      rec.reason = (r && r.reason) || '';
      if (!r || !r.ok) {
        st.notes[id || '_post'] = { text: cap((r && r.reason) || 'YouTube’s page didn’t answer') + '.', open: !!(r && r.open) };
      } else if (kind === 'like') {
        if (r.changed === false) st.notes[id] = { text: 'YouTube didn’t confirm it yet: the state shown is what its page says.' };
        c.liked = !!r.on;
        if (r.count) c.likes = r.count;
      } else {
        var mine = { id: (r.comment && r.comment.id) || ('local-' + Date.now()), author: (r.comment && r.comment.author) || 'You', authorUrl: '', avatar: '',
          time: (r.comment && r.comment.time) || 'just now', segs: [{ text: (r.comment && r.comment.text) || text }], text: (r.comment && r.comment.text) || text,
          likes: '', liked: false, replies: 0, replyLevel: kind === 'reply' ? 1 : 0, pinned: false, creator: false, verified: false, hearted: false, repliesToken: '', mine: true };
        if (kind === 'post') { st.items.unshift(mine); st.composer = { open: false, text: '', busy: false, why: '' }; if (st.phase === 'empty') st.phase = 'ready'; }
        else {
          var rr = st.replies[id] || (st.replies[id] = { items: [], next: c.repliesToken, loading: false, why: '' });
          rr.items.unshift(mine);
          st.expanded[id] = true;
          st.replyTo = ''; st.replyText = '';
        }
        if (!r.confirmed) st.notes[mine.id] = { text: 'YouTube took it; its page didn’t show it back yet.' };
      }
      if (kind === 'post') st.composer.busy = false;
      if (kind === 'reply') st.replyBusy = false;
      draw(st);
    }).catch(function (e) {
      st.busy[bkey] = false;
      rec.ok = false;
      rec.reason = (e && e.message) || String(e);
      st.notes[id || '_post'] = { text: 'YouTube’s page didn’t answer: ' + rec.reason + '.' };
      if (kind === 'post') st.composer.busy = false;
      if (kind === 'reply') st.replyBusy = false;
      draw(st);
    });
    return true;
  }

  /** "Open comments on YouTube": the view's Full page, scrolled to YouTube's own comments. In Lumen. */
  function openOwn(st) {
    if (!st.toggle || !st.view) return false;
    var v = st.view;
    var ok = false;
    try { ok = !!st.toggle(); } catch (e) { ok = false; }
    if (!ok) return false;
    setTimeout(function () { js(v, call('showOwn')).catch(function () { /* the page shows anyway */ }); }, 350);
    return true;
  }

  function openLink(st, l) {
    if (!l) return;
    if (l.kind === 'time' && st.view) { js(st.view, call('seek', [l.t])).catch(function () { /* the player stays */ }); return; }
    if (l.kind === 'yt' && typeof window.openInLumen === 'function') { window.openInLumen(l.href, { service: 'youtube' }); return; }
    if (typeof window.createTab === 'function') { try { window.createTab(l.href, { background: false }); } catch (e) { /* nothing more */ } }
  }

  /* ---------------------------------------------------------------- drawing */

  /* A redraw rebuilds the section, so the button he pressed from the keyboard is a new node: focus fell to the
     page, his next Tab started from the top of the window and Space played or paused the video instead of
     pressing the next control. The control with focus is remembered (its comment, its kind, its place) and the
     new one takes focus, without scrolling. The comment boxes keep their own (draw: keep / keepReply). */
  var FOCUS_KINDS = ['cm-sort', 'cm-open-inline', 'cm-open', 'cm-readmore', 'cm-like', 'cm-replybtn', 'cm-replies', 'cm-morereplies',
    'cm-retry', 'cm-more', 'cm-cancel', 'cm-post', 'cm-replysend', 'cm-link'];
  function itemOf(n) { return n && n.closest ? n.closest('.cm-item') : null; }
  function focusKey(st) {
    var a = document.activeElement;
    if (!a || a === document.body || !st.root.contains(a)) return null;
    if (a === st.root) return st.refocus || null;   // a control that was off (busy) the last time: try it again
    if (a.tagName === 'TEXTAREA' || !a.classList) return null;
    var kind = FOCUS_KINDS.filter(function (k) { return a.classList.contains(k); })[0];
    if (!kind) return null;
    var item = itemOf(a);
    var same = [].filter.call((item || st.root).querySelectorAll('.' + kind), function (n) { return itemOf(n) === item; });
    return { id: item ? item.getAttribute('data-id') : null, kind: kind, i: Math.max(0, same.indexOf(a)) };
  }
  function refocus(st, k) {
    st.refocus = null;
    if (!k || !st.root.isConnected) return;
    var a = document.activeElement;
    if (a && a !== document.body && a !== st.root) return;   // focus is somewhere on purpose (a box, another control)
    var item = k.id === null ? null : [].filter.call(st.root.querySelectorAll('.cm-item'), function (n) { return n.getAttribute('data-id') === k.id; })[0] || null;
    var scope = item || (k.id === null ? st.root : null);
    var same = scope ? [].filter.call(scope.querySelectorAll('.' + k.kind), function (n) { return itemOf(n) === item; }) : [];
    var tries = [same[k.i], same[same.length - 1], item && item.querySelector('button:not(:disabled), a[href]'), st.root];
    for (var i = 0; i < tries.length; i++) {
      var t = tries[i];
      if (!t) continue;
      try { t.focus({ preventScroll: true }); } catch (e) { continue; }
      if (document.activeElement === t) { if (t === st.root) st.refocus = k; return; }
    }
  }

  /* "Read more" only where the clamp hides something: a comment over CLAMP characters can still fit in four lines
     on a wide view, and there "Read more" did nothing. Measured once per frame after a draw, and again when the
     section's width changes (a narrower window clamps more); reads first, then writes. */
  function fitSoon(st) {
    if (st.fitRaf || typeof requestAnimationFrame !== 'function') return;
    st.fitRaf = requestAnimationFrame(function () { st.fitRaf = 0; fit(st); });
  }
  function fit(st) {
    if (!st.root.isConnected) return;
    var ts = [].slice.call(st.root.querySelectorAll('.cm-text.is-clamped'));
    var over = ts.map(function (t) { return t.scrollHeight > t.clientHeight + 1; });
    ts.forEach(function (t, i) {
      var b = t.nextElementSibling;
      if (b && b.classList.contains('cm-readmore') && b.hidden !== !over[i]) b.hidden = !over[i];
    });
  }

  function draw(st) {
    if (st.pressing) { st.pendingDraw = true; return; }
    var fk = focusKey(st);
    drawNow(st);
    refocus(st, fk);
    fitSoon(st);
  }
  function drawNow(st) {
    var r = st.root;
    var keep = r.querySelector('.cm-compose textarea');
    var keepReply = r.querySelector('.cm-replybox textarea');
    var sel = keep && document.activeElement === keep ? [keep.selectionStart, keep.selectionEnd] : null;
    var selR = keepReply && document.activeElement === keepReply ? [keepReply.selectionStart, keepReply.selectionEnd] : null;
    r.replaceChildren();
    r.setAttribute('data-phase', st.phase);
    var phase = !online() && st.phase !== 'ready' ? 'offline' : st.phase;

    // The head: the count, Top / Newest, and YouTube's own comments.
    var head = el('div', 'cm-head');
    var count = st.header ? st.header.countText : 'Comments';
    head.appendChild(el('h2', 'cm-count', phase === 'ready' || phase === 'empty' ? count : 'Comments'));
    if (st.header && st.header.sorts.length > 1 && (phase === 'ready' || phase === 'empty' || (phase === 'loading' && st.sortLabel))) {
      var sorts = el('div', 'cm-sorts');
      sorts.setAttribute('role', 'radiogroup');
      sorts.setAttribute('aria-label', 'Sort comments');
      st.header.sorts.forEach(function (s) {
        var on = s.label === st.sortLabel;
        var b = btn('cm-sort' + (on ? ' is-on' : ''), s.label, function () { sort(st, s); });
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        if (st.loading && !on) off(b, 'Loading…');
        sorts.appendChild(b);
      });
      head.appendChild(sorts);
    }
    var openBtn = btn('cm-ghost cm-open', 'Open comments on YouTube', function () { if (!openOwn(st)) note(st, '_post', 'YouTube’s full page isn’t available here.'); },
      'YouTube’s own comments, in Lumen (the full page)');
    if (!st.toggle) off(openBtn, 'YouTube’s full page isn’t available here');
    head.appendChild(openBtn);
    r.appendChild(head);

    if (phase === 'loading' && !st.items.length) { r.appendChild(stateBox('loading', st)); skeleton(r); return; }
    if (phase === 'off' || phase === 'none' || phase === 'offline' || phase === 'failed') { r.appendChild(stateBox(phase, st)); return; }

    // Signed out: the list reads, the controls say why.
    if (st.signedIn === false) r.appendChild(line(words('signedout').why, 'warn'));
    else r.appendChild(composer(st, keep, sel));
    if (st.notes._post) r.appendChild(noteLine(st, st.notes._post));

    if (phase === 'empty') { r.appendChild(stateBox('empty', st)); return; }

    var list = el('div', 'cm-list');
    list.setAttribute('role', 'list');
    st.items.forEach(function (c) { list.appendChild(commentEl(st, c, false, keepReply, selR)); });
    r.appendChild(list);

    var end = el('div', 'cm-end');
    if (st.loading) { end.appendChild(el('span', 'cm-spin')); end.appendChild(el('span', 'cm-end-txt', 'Loading more comments…')); }
    else if (st.pageWhy) { end.appendChild(line(st.pageWhy, 'err', btn('cm-ghost cm-retry', 'Try again', function () { st.pageWhy = ''; more(st); }))); }
    else if (st.next) end.appendChild(btn('cm-ghost cm-more', 'Show more comments', function () { more(st); }));
    else end.appendChild(el('span', 'cm-end-txt', st.items.length >= PAGE_MAX ? 'Lumen shows the first ' + PAGE_MAX + ' comments; the rest are on YouTube’s page.' : 'That’s all the comments.'));
    r.appendChild(end);
    observeEnd(st);
  }
  function note(st, key, text) { st.notes[key] = { text: text }; draw(st); }
  function line(text, kind, act) {
    var p = el('p', 'cm-why' + (kind ? ' cm-why-' + kind : ''));
    p.setAttribute('role', 'status');
    p.appendChild(el('span', 'cm-why-txt', text));
    if (act) p.appendChild(act);
    return p;
  }
  function noteLine(st, n) {
    return line(n.text, 'warn', n.open && st.toggle ? btn('cm-ghost cm-open-inline', 'Open comments on YouTube', function () { openOwn(st); }) : null);
  }
  function stateBox(phase, st) {
    var w = words(phase, { message: st.message, reason: st.why, signedIn: st.signedIn });
    var b = el('div', 'cm-state cm-state-' + phase);
    b.setAttribute('role', 'status');
    if (phase === 'loading') b.appendChild(el('span', 'cm-spin'));
    var t = el('div', 'cm-state-txt');
    t.appendChild(el('div', 'cm-state-title', w.title));
    t.appendChild(el('div', 'cm-state-why', w.why));
    b.appendChild(t);
    if (phase === 'failed' || phase === 'offline') b.appendChild(btn('cm-ghost cm-retry', 'Try again', function () { start(st); }));
    return b;
  }
  function skeleton(r) {
    var s = el('div', 'cm-skel');
    s.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 3; i++) {
      var row = el('div', 'cm-skel-row');
      row.appendChild(el('span', 'cm-skel-av'));
      var l = el('span', 'cm-skel-lines');
      l.appendChild(el('i', 'cm-skel-l1'));
      l.appendChild(el('i', 'cm-skel-l2'));
      row.appendChild(l);
      s.appendChild(row);
    }
    r.appendChild(s);
  }

  function composer(st, keep, sel) {
    var c = st.composer;
    var f = el('div', 'cm-compose' + (c.open || c.text ? ' is-open' : ''));
    var ta = keep && keep.parentNode ? keep : el('textarea', 'cm-input');
    ta.className = 'cm-input';
    ta.rows = 1;
    ta.placeholder = 'Add a comment…';
    ta.dir = 'auto';
    ta.setAttribute('aria-label', 'Add a comment');
    ta.maxLength = 10000;
    if (ta.value !== c.text) ta.value = c.text;
    ta.disabled = !!c.busy;
    if (!ta.__cm) {
      ta.__cm = true;
      ta.addEventListener('focus', function () { st.composer.open = true; var cf = ta.closest('.cm-compose'); if (cf) cf.classList.add('is-open'); });
      ta.addEventListener('input', function () { st.composer.text = ta.value; grow(ta); var s = st.root.querySelector('.cm-post'); if (s) off(s, ta.value.trim() ? '' : 'Write a comment first'); });
    }
    f.appendChild(ta);
    var acts = el('div', 'cm-compose-acts');
    acts.appendChild(btn('cm-ghost cm-cancel', 'Cancel', function () { st.composer = { open: false, text: '', busy: false, why: '' }; draw(st); }));
    var post = btn('cm-primary cm-post', c.busy ? 'Commenting…' : 'Comment', function () {
      var t = st.composer.text.trim();
      if (t) press(st, 'post', null, t);
    });
    off(post, c.busy ? 'Waiting for YouTube…' : (c.text.trim() ? '' : 'Write a comment first'));
    acts.appendChild(post);
    f.appendChild(acts);
    if (sel) setTimeout(function () { try { ta.focus({ preventScroll: true }); ta.setSelectionRange(sel[0], sel[1]); } catch (e) { /* gone */ } }, 0);
    setTimeout(function () { grow(ta); }, 0);
    return f;
  }
  function grow(ta) { if (!ta.isConnected) return; ta.style.height = 'auto'; ta.style.height = Math.min(200, Math.max(22, ta.scrollHeight)) + 'px'; }

  function initial(name) { var t = String(name || '').replace(/^@/, '').trim(); return t ? t.charAt(0).toUpperCase() : '?'; }
  function avatarEl(c) {
    var a = el('span', 'cm-av');
    a.textContent = initial(c.author);
    if (c.avatar) {
      var img = new Image();
      img.alt = '';
      img.decoding = 'async';   // not loading=lazy: it joins the document only once loaded, and a detached lazy image never loads
      img.referrerPolicy = 'no-referrer';
      // Drawn before: straight in (the cache has it), so a redraw never flashes the initial.
      if (SEEN[c.avatar]) { a.textContent = ''; a.appendChild(img); }
      else img.onload = function () { SEEN[c.avatar] = 1; a.textContent = ''; a.appendChild(img); };
      img.onerror = function () { if (img.parentNode) img.remove(); a.textContent = initial(c.author); };
      img.src = c.avatar;
    }
    return a;
  }
  function textEl(st, c) {
    var t = el('div', 'cm-text' + (long(c) && !st.expanded['t:' + c.id] ? ' is-clamped' : ''));
    // Each comment's own direction (Arabic, Hebrew, Persian): without it an RTL comment read left to right, its
    // punctuation and any Latin words at the wrong end.
    t.dir = 'auto';
    (c.segs || []).forEach(function (s) {
      if (!s.link) { t.appendChild(document.createTextNode(s.text)); return; }
      var a = el('a', 'cm-link cm-link-' + s.link.kind, s.text);
      a.href = s.link.href;
      a.rel = 'noopener noreferrer';
      a.title = s.link.kind === 'time' ? 'Jump to ' + s.text : s.link.kind === 'yt' ? 'Open in Lumen' : 'Open ' + s.link.href + ' in a Quartz tab';
      a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openLink(st, s.link); });
      a.addEventListener('auxclick', function (e) { e.preventDefault(); });
      t.appendChild(a);
    });
    return t;
  }
  function commentEl(st, c, isReply, keepReply, selR) {
    var row = el('div', 'cm-item' + (isReply ? ' cm-reply' : '') + (c.mine ? ' is-mine' : ''));
    row.setAttribute('role', 'listitem');
    row.setAttribute('data-id', c.id);
    row.appendChild(avatarEl(c));
    var body = el('div', 'cm-body');
    if (c.pinned) body.appendChild(el('div', 'cm-pin', c.pinnedText || 'Pinned'));
    var meta = el('div', 'cm-meta');
    var au = el('span', 'cm-author' + (c.creator ? ' is-creator' : ''), c.author || 'A viewer');
    au.dir = 'auto';
    meta.appendChild(au);
    if (c.verified) { var vf = el('span', 'cm-verified', '✓'); vf.title = 'Verified'; vf.setAttribute('aria-label', 'Verified'); meta.appendChild(vf); }
    if (c.time) meta.appendChild(el('span', 'cm-time', c.time));
    body.appendChild(meta);
    body.appendChild(textEl(st, c));
    if (long(c)) body.appendChild(btn('cm-link-btn cm-readmore', st.expanded['t:' + c.id] ? 'Show less' : 'Read more', function () { st.expanded['t:' + c.id] = !st.expanded['t:' + c.id]; draw(st); }));

    var bar = el('div', 'cm-bar');
    var like = btn('cm-like' + (c.liked ? ' is-on' : ''), '', function () { press(st, 'like', c); }, (c.liked ? 'Unlike' : 'Like') + ' this comment');
    var ico = el('span', 'cm-ico');
    ico.innerHTML = LIKE_SVG;
    like.appendChild(ico);
    like.appendChild(el('span', 'cm-like-n', c.likes || ''));
    like.setAttribute('aria-pressed', c.liked ? 'true' : 'false');
    var outWhy = st.signedIn === false ? 'Sign in to YouTube to like comments' : c.mine ? 'Your own comment: like it on YouTube’s page' : st.busy['like:' + c.id] ? 'Waiting for YouTube…' : '';
    off(like, outWhy);
    bar.appendChild(like);
    if (c.hearted) { var h = el('span', 'cm-heart', '♥'); h.title = 'Hearted by the creator'; h.setAttribute('aria-label', 'Hearted by the creator'); bar.appendChild(h); }
    if (!isReply && !c.mine) {
      var rb = btn('cm-ghost-txt cm-replybtn', 'Reply', function () { st.replyTo = st.replyTo === c.id ? '' : c.id; st.replyText = ''; draw(st); setTimeout(function () { var t = st.root.querySelector('.cm-replybox textarea'); if (t) t.focus(); }, 0); });
      if (st.signedIn === false) off(rb, 'Sign in to YouTube to reply');
      bar.appendChild(rb);
    }
    body.appendChild(bar);
    if (st.notes[c.id]) body.appendChild(noteLine(st, st.notes[c.id]));

    if (!isReply && st.replyTo === c.id) body.appendChild(replyBox(st, c, keepReply, selR));

    if (!isReply && (c.replies > 0 || (st.replies[c.id] && st.replies[c.id].items.length))) {
      var open = !!st.expanded[c.id];
      var r = st.replies[c.id];
      var n = Math.max(c.replies, r ? r.items.length : 0);
      var tb = btn('cm-replies' + (open ? ' is-open' : ''), '', function () { toggleReplies(st, c); }, (open ? 'Hide ' : 'Show ') + n + (n === 1 ? ' reply' : ' replies'));
      var car = el('span', 'cm-caret');
      car.innerHTML = CARET_SVG;
      tb.appendChild(car);
      tb.appendChild(el('span', 'cm-btn-txt', (open ? 'Hide ' : '') + n + (n === 1 ? ' reply' : ' replies')));
      tb.setAttribute('aria-expanded', open ? 'true' : 'false');
      body.appendChild(tb);
      if (open && r) {
        var rl = el('div', 'cm-replylist');
        r.items.forEach(function (x) { rl.appendChild(commentEl(st, x, true)); });
        if (r.loading) { var ld = el('div', 'cm-end cm-end-sm'); ld.appendChild(el('span', 'cm-spin')); ld.appendChild(el('span', 'cm-end-txt', 'Loading replies…')); rl.appendChild(ld); }
        else if (r.why) rl.appendChild(line(r.why, 'err', btn('cm-ghost cm-retry', 'Try again', function () { r.why = ''; loadReplies(st, c); })));
        else if (r.next && r.items.length) rl.appendChild(btn('cm-ghost-txt cm-morereplies', 'Show more replies', function () { loadReplies(st, c); }));
        // "N replies" that came back empty (removed, or held for review): said, never an empty fold.
        else if (!r.items.length && !r.next) rl.appendChild(line('YouTube’s page sent no replies to show (they may have been removed or held for review).', ''));
        else if (!r.items.length) rl.appendChild(line('Replies didn’t load.', 'err', btn('cm-ghost cm-retry', 'Try again', function () { r.why = ''; loadReplies(st, c); })));
        body.appendChild(rl);
      }
    }
    row.appendChild(body);
    return row;
  }
  function replyBox(st, c, keep, sel) {
    var f = el('div', 'cm-compose cm-replybox is-open');
    var ta = keep && keep.parentNode ? keep : el('textarea', 'cm-input');
    ta.className = 'cm-input';
    ta.rows = 1;
    ta.placeholder = 'Add a reply…';
    ta.dir = 'auto';
    ta.setAttribute('aria-label', 'Reply to ' + (c.author || 'this comment'));
    if (ta.value !== st.replyText) ta.value = st.replyText;
    ta.disabled = !!st.replyBusy;
    if (!ta.__cm) {
      ta.__cm = true;
      ta.addEventListener('input', function () { st.replyText = ta.value; grow(ta); var s = st.root.querySelector('.cm-replysend'); if (s) off(s, ta.value.trim() ? '' : 'Write a reply first'); });
    }
    f.appendChild(ta);
    var acts = el('div', 'cm-compose-acts');
    acts.appendChild(btn('cm-ghost cm-cancel', 'Cancel', function () { st.replyTo = ''; st.replyText = ''; draw(st); }));
    var send = btn('cm-primary cm-replysend', st.replyBusy ? 'Replying…' : 'Reply', function () { var t = st.replyText.trim(); if (t) press(st, 'reply', c, t); });
    off(send, st.replyBusy ? 'Waiting for YouTube…' : (st.replyText.trim() ? '' : 'Write a reply first'));
    acts.appendChild(send);
    f.appendChild(acts);
    if (sel) setTimeout(function () { try { ta.focus({ preventScroll: true }); ta.setSelectionRange(sel[0], sel[1]); } catch (e) { /* gone */ } }, 0);
    setTimeout(function () { grow(ta); }, 0);
    return f;
  }

  // Offline: a load in flight is dropped (it says so); back online, it starts again by itself.
  // The release (anywhere: he may drag off): the click is dispatched first, then any held redraw runs.
  function released() {
    STATES.forEach(function (st) {
      if (!st.pressing) return;
      st.pressing = false;
      if (st.pendingDraw) { st.pendingDraw = false; setTimeout(function () { draw(st); }, 0); }
    });
  }
  window.addEventListener('pointerup', released, true);
  window.addEventListener('pointercancel', released, true);
  window.addEventListener('blur', released);

  window.addEventListener('offline', function () {
    STATES.forEach(function (st) {
      if (st.phase === 'loading' || st.loading) {
        st.seq++;
        st.loading = false;
        if (st.phase === 'loading') st.phase = 'offline';
        else { st.pageWhy = 'You’re offline: more comments load when you’re back online.'; st.resume = true; }
      }
      if (st.root.isConnected) draw(st);
    });
  });
  window.addEventListener('online', function () {
    STATES.forEach(function (st) {
      if (!st.root.isConnected) return;
      if (st.phase === 'offline' || st.phase === 'failed') start(st);
      else if (st.resume) { st.resume = false; st.pageWhy = ''; more(st); }
      else draw(st);
    });
  });

  /* ---------------------------------------------------------------- e2e seam */

  function summary(st) {
    var flat = function (c) { return { id: c.id, author: c.author, time: c.time, text: c.text, likes: c.likes, liked: c.liked, replies: c.replies, pinned: c.pinned, creator: c.creator, hearted: c.hearted, mine: !!c.mine,
      links: (c.segs || []).filter(function (s) { return s.link; }).map(function (s) { return { text: s.text, href: s.link.href, kind: s.link.kind }; }) }; };
    var rep = {};
    Object.keys(st.replies).forEach(function (k) { var r = st.replies[k]; rep[k] = { n: r.items.length, next: !!r.next, loading: r.loading, why: r.why, items: r.items.map(flat) }; });
    return { slot: st.slot, videoId: st.videoId, phase: st.phase, why: st.why, message: st.message, signedIn: st.signedIn, count: st.header ? st.header.countText : '',
      sorts: st.header ? st.header.sorts.map(function (s) { return s.label; }) : [], sort: st.sortLabel, n: st.items.length, next: !!st.next, loading: st.loading, pageWhy: st.pageWhy,
      requests: st.requests, items: st.items.map(flat), replies: rep, expanded: Object.keys(st.expanded).filter(function (k) { return st.expanded[k]; }),
      notes: JSON.parse(JSON.stringify(st.notes)), attached: st.root.isConnected,
      shown: st.root.isConnected ? (st.root.querySelector('.cm-state-title') || {}).textContent || '' : '', whyShown: st.root.isConnected ? [].map.call(st.root.querySelectorAll('.cm-state-why, .cm-why-txt'), function (n) { return n.textContent; }) : [] };
  }

  return Object.assign({}, PURE, {
    forget: forget,
    _state: function () { return { states: STATES.map(summary), presses: LOG.slice() }; },
    /** For the e2e: redraw every live section now (as a page answer would), counting the draws actually done. */
    _redraw: function () { var n = 0; STATES.forEach(function (st) { if (st.root.isConnected) { draw(st); if (!st.pendingDraw) n++; } }); return n; },
    _current: function () { var s = STATES.filter(function (x) { return x.root.isConnected; }); return s.length ? summary(s[s.length - 1]) : null; }
  });
});
