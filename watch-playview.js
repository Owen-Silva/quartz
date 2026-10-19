/* ============================================================
   watch-playview.js -- Lumen's playback view (chrome side).

   A video plays in Lumen like the hover preview looks: the service's
   OWN player on top, in a 16:9 box, and Lumen's own info under it.
   The hosted page is still the service's page, in its <webview>, signed
   in as the user (Premium, quality, history and resume all hold): Lumen
   only hides everything OUTSIDE the player and lays the player over
   the page's whole viewport. The player itself (its bar, captions,
   quality, speed, keys, its ads) is never touched, and nothing is ever
   pulled out of it: no stream, no URL, no DRM.

     - How the page is trimmed: insertCSS puts rules in the page that
       apply only while <html data-lumen-pv> is set. A small script in
       the page finds the player's root (#movie_player on YouTube; the
       service's player root, or the largest <video>'s own box, on the
       others), marks it data-lumen-pv-root, and sets the flag. Then
       body is visibility:hidden, the root visible and fixed over the
       viewport, and the page's own chrome (masthead, recommendations,
       comments, sponsored cards) display:none. No root found: no flag,
       the whole page shows, and the reason is said.
     - YouTube's info (title, channel, subscribers, description) is
       read from the page's DOM, with ytInitialData as the fallback
       only when it is for the same video, and the Lumen item's own
       title as the last word. Like, Dislike, Subscribe and Save are
       YouTube's OWN buttons in the hidden page: one press per click,
       only on his click, the state read back from the page.
     - Disney+, Hulu, Prime Video and ESPN: the title, SxEy and the
       episode's name, the service, and "Show page" (Lumen's own show
       page, the player waits in the mini-player).
     - "Full page" (the bar's button, watch-player-yt.js) switches the
       slot to the service's whole page and back, without a reload.
     - Settings > Lumen, "When a video plays": Lumen view (default) or
       the service's full page (everything as before).

   Hooks: watch-player.js X() (attach, reuse, sync, destroy, stateActs);
   with this file missing, the layer is what it always was. Also a
   CommonJS module for the unit harness (the pure parts).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LumenPlayview = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================ pure */

  var NAMES = { youtube: 'YouTube', disney: 'Disney+', hulu: 'Hulu', prime: 'Prime Video', espn: 'ESPN' };
  var PEEK = 128;          // px of the info that always shows under the video (1280x800 included)
  var READS = [250, 900, 2000, 4000, 8000];   // ms after a page loads: read until it is all there
  var PRESS_HOLD_MAX_MS = 2000;   // a held rebuild waits for his release at most this long

  // The page's own furniture, hidden outright (display:none) while the view is on. Everything
  // else outside the player is only invisible (body visibility), so the page's own buttons and
  // popups still exist for Lumen's buttons to press.
  var HIDE = {
    youtube: ['#masthead-container', 'ytd-masthead', 'tp-yt-app-drawer#guide', 'ytd-mini-guide-renderer', '#secondary', '#related',
      '#comments', 'ytd-comments', '#chat', 'ytd-live-chat-frame', '#player-ads', 'ytd-ad-slot-renderer', 'ytd-companion-slot-renderer',
      'ytd-merch-shelf-renderer', 'ytd-engagement-panel-section-list-renderer', '#panels', '#offer-module'],
    disney: [], hulu: [], prime: [], espn: []
  };

  // The service's own CONTROL BAR, for a Lumen-drawn bar (the playerbar lane): hidden only while
  // <html class="lumen-pv-bar"> is set by that bridge. Never the ad UI (Skip Ad, the countdown,
  // the paid-promotion note), errors, consent or "still watching?": those stay the service's own.
  var BAR = {
    youtube: ['.ytp-chrome-bottom', '.ytp-gradient-bottom', '.ytp-chrome-top', '.ytp-gradient-top'],
    disney: [], hulu: [], prime: [], espn: []
  };
  // The page's own dialogs that must stay seen over the player (YouTube's "Video paused. Continue
  // watching?", its consent and enforcement notices): visible again, unless Lumen is mid-press of
  // its own confirm (data-lumen-pv-pressing), which it answers at once on his click.
  var KEEP = {
    youtube: ['ytd-popup-container tp-yt-paper-dialog:has(yt-confirm-dialog-renderer)', 'ytd-consent-bump-v2-lightbox',
      'ytd-popup-container tp-yt-paper-dialog:has(ytd-enforcement-message-view-model)', 'ytd-popup-container tp-yt-paper-dialog:has(ytd-mealbar-promo-renderer)'],
    disney: [], hulu: [], prime: [], espn: []
  };

  function parse(url) { try { return new URL(String(url || '')); } catch (e) { return null; } }

  /**
   * What kind of page a slot shows: 'watch' (a YouTube video), 'shorts', 'embed', 'player'
   * (a service's player page), 'other' (anything else on the service), '' (not a service page).
   */
  function pageKind(url, service) {
    var u = parse(url);
    if (!u || !/^https?:$/.test(u.protocol)) return '';
    var p = u.pathname;
    if (service === 'youtube') {
      if (/(^|\.)youtu\.be$/i.test(u.hostname)) return 'watch';
      if (p === '/watch') return u.searchParams.get('v') ? 'watch' : 'other';
      if (/^\/live\/[^/]+/.test(p)) return 'watch';
      if (/^\/shorts(\/|$)/.test(p)) return 'shorts';
      if (/^\/embed\//.test(p)) return 'embed';
      return 'other';
    }
    if (service === 'disney') return /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(play|video)\//i.test(p) ? 'player' : 'other';
    if (service === 'hulu') return /^\/watch\//i.test(p) ? 'player' : 'other';
    if (service === 'prime') return /\/(detail|watch)\//i.test(p) || /^\/gp\/video\/detail\//i.test(p) ? 'player' : 'other';
    if (service === 'espn') return /^\/(?:espnplus\/)?watch\//i.test(p) || /^\/watch\/player/i.test(p) ? 'player' : 'other';
    return '';
  }

  /** The kinds of page the view shows boxed (Shorts: the full page until the Shorts view). */
  function viewable(kind) { return kind === 'watch' || kind === 'player'; }

  /**
   * Whether a slot shows the Lumen view: the setting says so (or he toggled it), it is the one
   * player (not a multiview tile), it is a page the view knows, and its player was found.
   * o: { pref, mode, kind, multi, n, blocked, noRoot }
   */
  function boxedFor(o) {
    var x = o || {};
    return x.mode === 'lumen' && viewable(x.kind) && !x.multi && (x.n || 0) === 1 && !x.blocked && !x.noRoot;
  }

  /** The CSS that trims a page to its player; inert until the page's <html data-lumen-pv> is set. */
  function trimCss(service) {
    var hide = (HIDE[service] || []).map(function (s) { return 'html[data-lumen-pv] ' + s; });
    var bar = (BAR[service] || []).map(function (s) { return 'html[data-lumen-pv].lumen-pv-bar ' + s; });
    var keep = (KEEP[service] || []).map(function (s) { return 'html[data-lumen-pv]:not([data-lumen-pv-pressing]) ' + s; });
    return [
      keep.length ? keep.join(',\n') + ' { visibility: visible !important; z-index: 2147483647 !important; }' : '',
      bar.length ? bar.join(',\n') + ' { display: none !important; }' : '',
      'html[data-lumen-pv], html[data-lumen-pv] > body { overflow: hidden !important; background: #000 !important; }',
      'html[data-lumen-pv] > body { visibility: hidden !important; }',
      'html[data-lumen-pv] [data-lumen-pv-root] { visibility: visible !important; position: fixed !important; left: 0 !important; top: 0 !important;' +
        ' right: auto !important; bottom: auto !important; width: 100vw !important; height: 100vh !important; min-width: 0 !important; min-height: 0 !important;' +
        ' max-width: none !important; max-height: none !important; margin: 0 !important; transform: none !important; z-index: 2147483646 !important; }',
      hide.length ? hide.join(',\n') + ' { display: none !important; }' : ''
    ].filter(Boolean).join('\n');
  }

  /** "S2 E4 · Honeydew" / "S2:E4 Honeydew" / "Season 2 Episode 4" -> { ep: 'S2 E4', name: 'Honeydew' }. */
  function epParts(subtitle) {
    var t = String(subtitle || '').replace(/\s+/g, ' ').trim();
    if (!t) return { ep: '', name: '' };
    var m = /^S(\d+)\s*[:.·-]?\s*E(\d+)\b\s*[·:.\-–—]?\s*(.*)$/i.exec(t) || /^Season\s+(\d+)\D+Episode\s+(\d+)\b\s*[·:.\-–—]?\s*(.*)$/i.exec(t);
    if (m) return { ep: 'S' + Number(m[1]) + ' E' + Number(m[2]), name: m[3].trim() };
    m = /^E(\d+)\b\s*[·:.\-–—]?\s*(.*)$/i.exec(t);
    if (m) return { ep: 'E' + Number(m[1]), name: m[2].trim() };
    return { ep: '', name: t };
  }

  /** A title from a page's <title>, without the service's own suffix. */
  function cleanPageTitle(t, service) {
    var s = String(t || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/^\(\d+\)\s*/, '');
    s = s.replace(/\s*[-|–·]\s*(YouTube|Disney\+|Hulu|Prime Video|Amazon Prime Video|Watch ESPN|ESPN\+?|ESPN)\s*$/i, '');
    s = s.replace(/^Watch\s+/i, service === 'youtube' ? 'Watch ' : '');
    return s;
  }

  /**
   * What the info panel shows, from the page's read (r), the Lumen item and the slot's title.
   * Every field says where it came from; nothing is invented.
   */
  function model(service, r, item, slotTitle, opts) {
    var o = opts || {};
    var read = r && typeof r === 'object' ? r : null;
    var it = item && typeof item === 'object' ? item : null;
    var out = { service: service, name: NAMES[service] || service, title: '', titleFrom: '', ep: '', epName: '', channel: null,
      desc: null, signedIn: null, buttons: {}, missing: [], videoId: '', comments: null };
    if (service === 'youtube') {
      out.videoId = (read && read.videoId) || '';
      if (read && read.title) { out.title = read.title; out.titleFrom = read.titleFrom || 'page'; }
      else if (it && it.title && !o.moved) { out.title = it.title; out.titleFrom = 'item'; }
      else if (slotTitle && !o.moved) { out.title = slotTitle; out.titleFrom = 'item'; }
      else if (read && read.pageTitle) { out.title = cleanPageTitle(read.pageTitle, service); out.titleFrom = 'page-title'; }
      if (read && read.channel && read.channel.name) out.channel = { name: read.channel.name, subs: read.channel.subs || '', avatar: read.channel.avatar || '', url: read.channel.url || '' };
      if (read && read.desc && (read.desc.text || read.desc.meta)) out.desc = { text: read.desc.text || '', meta: read.desc.meta || '' };
      out.signedIn = read ? (read.signedIn === true ? true : read.signedIn === false ? false : null) : null;
      ['like', 'dislike', 'sub', 'save'].forEach(function (k) {
        var b = read && read[k];
        out.buttons[k] = b && b.found ? { found: true, on: !!b.on, count: b.count || '', label: b.label || '' } : { found: false };
        if (read && !(b && b.found)) out.missing.push(k);
      });
      out.comments = read && read.comments ? read.comments : null;
      return out;
    }
    // Disney+, Hulu, Prime Video, ESPN: the item is the truth while the page is still the one opened.
    var ep = epParts(it && it.subtitle);
    if (it && it.title && !o.moved) { out.title = it.title; out.titleFrom = 'item'; out.ep = ep.ep; out.epName = ep.name; }
    else if (read && read.title) { out.title = cleanPageTitle(read.title, service); out.titleFrom = 'page'; }
    else if (slotTitle) { out.title = String(slotTitle).split(' · ')[0]; out.titleFrom = 'item'; }
    return out;
  }

  /** Whether a YouTube read has everything the info shows (so the reads can stop). */
  function complete(r) {
    return !!(r && r.title && r.channel && r.channel.name && r.like && r.like.found && r.sub && r.sub.found);
  }

  /** The words for a disabled button or a note under the row, or '' when it can be pressed. */
  function whyOff(m, key, phase) {
    if (phase === 'offline') return 'You’re offline';
    if (m.signedIn === false) return 'Sign in to YouTube to ' + ({ like: 'like', dislike: 'dislike', sub: 'subscribe', save: 'save' })[key];
    var b = m.buttons[key];
    if (!b || !b.found) {
      if (phase === 'loading') return 'Reading YouTube’s page…';
      return 'YouTube’s ' + ({ like: 'Like', dislike: 'Dislike', sub: 'Subscribe', save: 'Save' })[key] + ' button isn’t on this page';
    }
    return '';
  }

  /* ---------------------------------------------------------------- in the page */

  /**
   * Installed in the hosted page (its own world, by executeJavaScript): finds the player's root,
   * sets or clears the view's flag, reads what the info shows, and presses the page's OWN buttons.
   * Serialised with String(); it uses nothing from outside itself.
   */
  function guest() {
    var V = 4;
    if (window.__lumenPv && window.__lumenPv.v === V) return;
    var ROOTS = {
      youtube: ['#movie_player'],
      disney: ['disney-web-player', '#hudson-wrapper', '.btm-media-player', '.btm-media-client'],
      hulu: ['#web-player-app', '.web-player-app', '.Player__container', '.hulu-player-app'],
      prime: ['#dv-web-player', '.webPlayerSDKContainer', '.webPlayerContainer', '.atvwebplayersdk-player-container'],
      espn: ['.btm-media-player', '#espn-player', '.media-player', '.VideoPlayer']
    };
    function Q(sel, r) { try { return (r || document).querySelector(sel); } catch (e) { return null; } }
    function QA(sel, r) { try { return Array.prototype.slice.call((r || document).querySelectorAll(sel)); } catch (e) { return []; } }
    function txt(n) { return n ? String(n.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
    function wait(fn, ms) {
      return new Promise(function (ok) {
        var t0 = Date.now();
        (function loop() { var v = null; try { v = fn(); } catch (e) { v = null; } if (v) return ok(v); if (Date.now() - t0 > ms) return ok(null); setTimeout(loop, 80); })();
      });
    }
    function bigVideo() {
      var best = null, area = 0;
      QA('video').forEach(function (v) { var b = v.getBoundingClientRect(); var a = b.width * b.height; if (a > area) { area = a; best = v; } });
      return area > 1600 ? best : null;
    }
    function findRoot(svc) {
      var list = ROOTS[svc] || [];
      for (var i = 0; i < list.length; i++) {
        var el = Q(list[i]);
        if (el && (el.tagName === 'VIDEO' || Q('video', el))) return { el: el, how: list[i] };
      }
      if (svc === 'youtube') return null;   // YouTube's player is #movie_player or nothing
      var v = bigVideo();
      if (!v) return null;
      var r = v.getBoundingClientRect();
      var best = v, n = v.parentElement;
      while (n && n !== document.body && n !== document.documentElement) {
        var b = n.getBoundingClientRect();
        if (Math.abs(b.width - r.width) > 4 || Math.abs(b.height - r.height) > 4) break;
        best = n; n = n.parentElement;
      }
      return { el: best, how: 'the largest video' };
    }
    function nudge() { setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (e) { /* gone */ } }, 0); }
    function apply(svc, on) {
      var html = document.documentElement;
      var was = html.hasAttribute('data-lumen-pv');
      if (!on) {
        html.removeAttribute('data-lumen-pv');
        QA('[data-lumen-pv-root]').forEach(function (n) { n.removeAttribute('data-lumen-pv-root'); });
        if (was) nudge();
        return { on: false, root: false };
      }
      var f = findRoot(svc);
      if (!f) { if (was) { html.removeAttribute('data-lumen-pv'); nudge(); } return { on: false, root: false }; }
      QA('[data-lumen-pv-root]').forEach(function (n) { if (n !== f.el) n.removeAttribute('data-lumen-pv-root'); });
      var fresh = !f.el.hasAttribute('data-lumen-pv-root');
      f.el.setAttribute('data-lumen-pv-root', '');
      html.setAttribute('data-lumen-pv', svc);
      if (fresh || !was) nudge();
      return { on: true, root: true, how: f.how };
    }

    /* --- YouTube's own buttons ---- */
    function md() { return Q('ytd-watch-metadata') || Q('#below') || document; }
    function owner() { return Q('ytd-video-owner-renderer', md()) || Q('#owner', md()) || md(); }
    function likeBtn() { return Q('like-button-view-model button', md()) || Q('#segmented-like-button button', md()) || Q('button[aria-label^="like this video" i]', md()); }
    function dislikeBtn() { return Q('dislike-button-view-model button', md()) || Q('#segmented-dislike-button button', md()) || Q('button[aria-label^="dislike this video" i]', md()); }
    function subBtn() { return Q('#subscribe-button button', owner()) || Q('#subscribe-button button', md()) || Q('ytd-subscribe-button-renderer button', md()); }
    function saveBtn() { return Q('button[aria-label="Save to playlist"]', md()) || Q('button[aria-label^="Save" i]', md()); }
    function pressed(b) { return !!b && b.getAttribute('aria-pressed') === 'true'; }
    function subscribed(b) {
      if (!b) return false;
      var host = b.closest('ytd-subscribe-button-renderer');
      if (host && host.hasAttribute('subscribed')) return true;
      var label = String(b.getAttribute('aria-label') || '');
      if (/^unsubscribe/i.test(label)) return true;
      return /^subscribed$/i.test(txt(b));
    }
    function saveOpts() {
      return QA('ytd-add-to-playlist-renderer ytd-playlist-add-to-option-renderer').map(function (n) {
        var cb = Q('#checkbox', n) || Q('[role="checkbox"]', n) || n;
        return { el: cb, name: txt(Q('#label', n)) || String(cb.getAttribute('aria-label') || '').trim() || txt(n),
          on: cb.hasAttribute('checked') || cb.getAttribute('aria-checked') === 'true' };
      }).filter(function (o) { return o.name; });
    }
    function dataFor(id) {
      var yd = window.ytInitialData;
      var out = {};
      try {
        var dataId = yd && yd.currentVideoEndpoint && yd.currentVideoEndpoint.watchEndpoint && yd.currentVideoEndpoint.watchEndpoint.videoId;
        if (!yd || !id || dataId !== id) return out;
        var cs = yd.contents.twoColumnWatchNextResults.results.results.contents || [];
        cs.forEach(function (c) {
          var p = c.videoPrimaryInfoRenderer, s = c.videoSecondaryInfoRenderer, sec = c.itemSectionRenderer;
          var runs = function (x) { return x ? (x.simpleText || (x.runs || []).map(function (r) { return r.text; }).join('')) : ''; };
          if (p) { out.title = runs(p.title); out.meta = [runs(p.viewCount && p.viewCount.videoViewCountRenderer && p.viewCount.videoViewCountRenderer.viewCount), runs(p.dateText)].filter(Boolean).join(' · '); }
          if (s && s.owner && s.owner.videoOwnerRenderer) {
            var o = s.owner.videoOwnerRenderer;
            out.channel = { name: runs(o.title), subs: runs(o.subscriberCountText), avatar: o.thumbnail && o.thumbnail.thumbnails && o.thumbnail.thumbnails.length ? o.thumbnail.thumbnails[o.thumbnail.thumbnails.length - 1].url : '' };
            out.desc = s.attributedDescription ? s.attributedDescription.content : runs(s.description);
          }
          if (sec && sec.sectionIdentifier === 'comment-item-section') {
            var ci = (sec.contents || [])[0];
            var tok = ci && ci.continuationItemRenderer && ci.continuationItemRenderer.continuationEndpoint && ci.continuationItemRenderer.continuationEndpoint.continuationCommand;
            if (tok && tok.token) out.comments = { token: String(tok.token).slice(0, 400) };
          }
        });
      } catch (e) { /* a shape Lumen doesn't know: the DOM's word only */ }
      return out;
    }
    function readYT() {
      var u = new URL(location.href);
      var id = u.searchParams.get('v') || ((/^\/live\/([^/?#]+)/.exec(u.pathname) || [])[1]) || '';
      var signed = null;
      try { if (window.ytcfg && typeof window.ytcfg.get === 'function') { var li = window.ytcfg.get('LOGGED_IN'); if (typeof li === 'boolean') signed = li; } } catch (e) { signed = null; }
      if (signed === null) {
        if (Q('#masthead #avatar-btn, ytd-masthead #avatar-btn')) signed = true;
        else if (Q('#masthead a[href*="ServiceLogin"], ytd-masthead a[href*="ServiceLogin"], #masthead a[href*="accounts.google.com"]')) signed = false;
      }
      var m = md(), ow = owner();
      var d = dataFor(id);
      var title = txt(Q('#title h1', m)) || txt(Q('h1.ytd-watch-metadata', m));
      var chA = Q('#channel-name #text a', ow) || Q('#channel-name a', ow) || Q('#upload-info a', ow);
      var ch = chA ? { name: txt(chA), url: chA.href || '', subs: txt(Q('#owner-sub-count', ow)), avatar: (Q('#avatar img', ow) || {}).src || '' } : null;
      if (ch && d.channel) { if (!ch.subs) ch.subs = d.channel.subs; if (!ch.avatar) ch.avatar = d.channel.avatar; }
      var descEl = Q('#description-inline-expander yt-attributed-string', m) || Q('#description #snippet-text', m) || Q('#description-inline-expander', m);
      var lb = likeBtn(), db = dislikeBtn(), sb = subBtn(), vb = saveBtn();
      return {
        ok: true, svc: 'youtube', url: location.href, videoId: id, signedIn: signed, pageTitle: document.title,
        title: title || d.title || '', titleFrom: title ? 'page' : (d.title ? 'ytInitialData' : ''),
        channel: ch || d.channel || null,
        desc: { text: (descEl ? (descEl.innerText || txt(descEl)) : '') || d.desc || '', meta: txt(Q('#info-container #info', m)) || txt(Q('#info-container', m)) || d.meta || '' },
        like: lb ? { found: true, on: pressed(lb), count: txt(lb), label: lb.getAttribute('aria-label') || '' } : { found: false },
        dislike: db ? { found: true, on: pressed(db), label: db.getAttribute('aria-label') || '' } : { found: false },
        sub: sb ? { found: true, on: subscribed(sb), label: sb.getAttribute('aria-label') || txt(sb) } : { found: false },
        save: vb ? { found: true, on: false, label: vb.getAttribute('aria-label') || '' } : { found: false },
        comments: d.comments || null,
        root: !!Q('[data-lumen-pv-root]'), on: document.documentElement.hasAttribute('data-lumen-pv')
      };
    }
    function readOther(svc) {
      var og = Q('meta[property="og:title"]');
      return { ok: true, svc: svc, url: location.href, title: (og && og.getAttribute('content')) || document.title || '', pageTitle: document.title,
        root: !!Q('[data-lumen-pv-root]'), on: document.documentElement.hasAttribute('data-lumen-pv') };
    }
    function read(svc) { return svc === 'youtube' ? readYT() : readOther(svc); }

    /** One press of the page's own button (kind), on his click. Never called by itself. */
    function press(svc, kind, arg) {
      if (svc !== 'youtube') return Promise.resolve({ ok: false, reason: 'nothing to press on this service' });
      var b;
      if (kind === 'like' || kind === 'dislike') {
        b = kind === 'like' ? likeBtn() : dislikeBtn();
        if (!b) return Promise.resolve({ ok: false, reason: 'YouTube’s ' + (kind === 'like' ? 'Like' : 'Dislike') + ' button isn’t on this page' });
        var was = pressed(b);
        b.click();
        return wait(function () { var n = kind === 'like' ? likeBtn() : dislikeBtn(); return n && pressed(n) !== was ? 1 : 0; }, 2500)
          .then(function (ch) { return { ok: true, changed: !!ch }; });
      }
      if (kind === 'subscribe') {
        b = subBtn();
        if (!b) return Promise.resolve({ ok: false, reason: 'YouTube’s Subscribe button isn’t on this page' });
        if (subscribed(b)) return Promise.resolve({ ok: false, reason: 'already subscribed' });
        b.click();
        return wait(function () { return subscribed(subBtn()) ? 1 : 0; }, 2500).then(function (ch) { return { ok: true, changed: !!ch }; });
      }
      if (kind === 'unsubscribe') {
        b = subBtn();
        if (!b) return Promise.resolve({ ok: false, reason: 'YouTube’s Subscribe button isn’t on this page' });
        if (!subscribed(b)) return Promise.resolve({ ok: false, reason: 'not subscribed' });
        var html = document.documentElement;
        html.setAttribute('data-lumen-pv-pressing', '');
        var done = function (r) { html.removeAttribute('data-lumen-pv-pressing'); return r; };
        b.click();
        // YouTube asks to confirm (its own dialog, or its menu's "Unsubscribe" and then the dialog).
        var confirmBtn = function () { return Q('yt-confirm-dialog-renderer #confirm-button button') || Q('yt-confirm-dialog-renderer #confirm-button') || Q('#confirm-button button'); };
        var menuItem = function () { return QA('ytd-menu-service-item-renderer, tp-yt-paper-item, yt-list-item-view-model').filter(function (n) { return /^unsubscribe$/i.test(txt(n)); })[0] || null; };
        return wait(function () { return confirmBtn() || menuItem(); }, 2500).then(function (c) {
          if (!c) return { ok: false, reason: 'YouTube didn’t ask to confirm the unsubscribe' };
          if (c !== confirmBtn()) { c.click(); return wait(confirmBtn, 2500).then(function (c2) { if (!c2) return { ok: false, reason: 'YouTube’s confirm didn’t appear' }; c2.click(); return { ok: true, confirmed: true }; }); }
          c.click();
          return { ok: true, confirmed: true };
        }).then(function (r) { return r.ok ? wait(function () { return subscribed(subBtn()) ? 0 : 1; }, 2500).then(function (ch) { r.changed = !!ch; return r; }) : r; })
          .then(done, function (e) { done(null); return { ok: false, reason: String((e && e.message) || e) }; });
      }
      if (kind === 'save-open') {
        b = saveBtn();
        if (!b) return Promise.resolve({ ok: false, reason: 'YouTube’s Save button isn’t on this page' });
        b.click();
        return wait(function () { var l = saveOpts(); return l.length ? l : null; }, 3000).then(function (l) {
          return l ? { ok: true, list: l.map(function (o) { return { name: o.name, on: o.on }; }) } : { ok: false, reason: 'YouTube’s Save list didn’t open' };
        });
      }
      if (kind === 'save-toggle') {
        var opts = saveOpts();
        var o = opts[Number(arg)];
        if (!o) return Promise.resolve({ ok: false, reason: 'that playlist isn’t in YouTube’s list any more' });
        var before = o.on;
        o.el.click();
        return wait(function () { var n = saveOpts()[Number(arg)]; return n && n.on !== before ? 1 : 0; }, 2000).then(function (ch) {
          return { ok: true, changed: !!ch, list: saveOpts().map(function (x) { return { name: x.name, on: x.on }; }) };
        });
      }
      if (kind === 'save-close') {
        var x = Q('ytd-add-to-playlist-renderer #close-button button') || Q('ytd-add-to-playlist-renderer #close-button');
        if (x) x.click();
        else if (saveOpts().length) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: false, reason: 'unknown button ' + kind });
    }
    window.__lumenPv = { v: V, apply: apply, read: read, press: press,
      tick: function (svc, on) { var a = apply(svc, on); var r = read(svc); r.applied = a.on; r.how = a.how || ''; return r; } };
  }
  var GUEST = '(' + String(guest) + ')();';
  function call(method, args) {
    return GUEST + 'window.__lumenPv.' + method + '(' + (args || []).map(function (a) { return JSON.stringify(a === undefined ? null : a); }).join(',') + ')';
  }

  var PURE = { NAMES: NAMES, PEEK: PEEK, READS: READS, HIDE: HIDE, BAR: BAR, KEEP: KEEP, pageKind: pageKind, viewable: viewable, boxedFor: boxedFor, trimCss: trimCss,
    epParts: epParts, cleanPageTitle: cleanPageTitle, model: model, complete: complete, whyOff: whyOff, guest: guest, call: call };
  if (typeof document === 'undefined' || typeof window === 'undefined') return PURE;

  /* ================================================================ the chrome */

  var api = window.api && window.api.lumenPlayview;
  var PREF = 'lumen';
  var CTX = null;
  var obs = null;
  var all = [];   // slots this file has seen (the e2e's _state)

  if (api && typeof api.get === 'function') {
    api.get().then(function (r) { if (r && (r.view === 'lumen' || r.view === 'page')) { PREF = r.view; refreshAll(); } }, function () { /* the default */ });
  }

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = text; return n; }
  function button(cls, label, fn, aria) {
    var b = el('button', 'pv-btn ' + cls);
    b.type = 'button';
    if (label) b.appendChild(el('span', 'pv-btn-txt', label));
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', function (e) { e.stopPropagation(); if (!b.disabled) fn(b, e); });
    return b;
  }
  var ICON = {
    like: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5V20H4.2a.7.7 0 0 1-.7-.7v-8.1c0-.4.3-.7.7-.7h3.3Zm0 0 3.6-6.2c.3-.5.9-.8 1.5-.6 1 .3 1.5 1.3 1.3 2.3l-.7 3.4h5.1c1.2 0 2.1 1.1 1.8 2.3l-1.6 6.9a2.6 2.6 0 0 1-2.5 2H7.5"/></svg>',
    save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.8h11c.4 0 .7.3.7.7v15.6l-6.2-4-6.2 4V4.5c0-.4.3-.7.7-.7Z"/></svg>'
  };
  function iconBtn(cls, icon, label, fn, aria) {
    var b = button(cls, '', fn, aria);
    var i = el('span', 'pv-ico');
    i.innerHTML = ICON[icon];
    b.appendChild(i);
    if (label !== null) b.appendChild(el('span', 'pv-btn-txt', label));
    return b;
  }
  function js(v, code) {
    try { var p = v.executeJavaScript(code, true); return p && p.then ? p : Promise.resolve(p); } catch (e) { return Promise.reject(e); }
  }
  function online() { try { return navigator.onLine !== false; } catch (e) { return true; } }
  function layerOf() { return CTX && CTX.L ? CTX.L : null; }

  /* ---------------------------------------------------------------- slot state */

  function pvOf(s) { return s && s._pv ? s._pv : null; }

  function kindOf(s) { return pageKind(s.url, s.service); }

  function isBoxed(s) {
    var p = pvOf(s), L = layerOf();
    if (!p || !s.view || !L) return false;
    return boxedFor({ mode: p.mode, kind: kindOf(s), multi: !!s.multi, n: L.slots.length, blocked: s.blocked, noRoot: p.noRoot });
  }
  /** The page keeps its trim in the mini-player too (just the player in the corner); never in a grid. */
  function wantTrim(s) {
    var p = pvOf(s), L = layerOf();
    if (!p || !L) return false;
    return p.mode === 'lumen' && viewable(kindOf(s)) && !s.multi && L.slots.length === 1 && !s.blocked;
  }

  function attach(ctx, s, v) {
    CTX = ctx;
    observeLayer();
    var p = s._pv = { mode: PREF, userMode: false, phase: 'loading', read: null, applied: false, noRoot: false, why: '', busy: '', seq: 0,
      timers: [], presses: [], item: s.item || null, itemUrl: s.url, confirm: false, save: null, more: false, info: null, cover: null, lastUrl: '' };
    all.push(s);
    if (all.length > 8) all.shift();
    p.cover = el('div', 'pv-cover');
    p.cover.appendChild(el('span', 'pv-cover-bar'));
    p.cover.appendChild(el('span', 'pv-cover-txt', 'Loading the player…'));
    p.info = el('div', 'pv-info');
    p.info.setAttribute('aria-live', 'polite');
    p.info.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      p.pressing = true;
      clearTimeout(p.pressT);
      p.pressT = setTimeout(function () { releasedOne(s); }, PRESS_HOLD_MAX_MS);   // a release Lumen never heard
    }, true);
    // The mount for an overlay play bar (the playerbar lane): the video box's bottom edge, over the
    // webview, empty and click-through until something is put in it. Its id is set only while boxed.
    p.mount = el('div', 'pv-barmount');
    s.tile.appendChild(p.cover);
    s.tile.appendChild(p.mount);
    s.tile.appendChild(p.info);
    v.addEventListener('dom-ready', function () {
      if (s.view !== v) return;
      try {
        var pr = v.insertCSS(trimCss(s.service));
        if (pr && pr.catch) pr.catch(function (e) { p.why = 'Lumen couldn’t trim the page: ' + ((e && e.message) || e); render(s); });
      } catch (e) { p.why = 'Lumen couldn’t trim the page: ' + ((e && e.message) || e); }
      startReads(s, false);
    });
    v.addEventListener('did-start-navigation', function (e) {
      if (s.view !== v || !e.isMainFrame || e.isSameDocument) return;
      p.applied = false; p.noRoot = false; p.read = null; p.phase = 'loading'; p.save = null; p.confirm = false;
      update(s);
    });
    v.addEventListener('did-navigate-in-page', function (e) {
      if (s.view !== v || !e.isMainFrame) return;
      if (String(e.url || '') === p.lastUrl) return;
      p.read = null; p.phase = 'loading'; p.save = null; p.confirm = false;
      startReads(s, true);
    });
    v.addEventListener('did-fail-load', function (e) {
      if (s.view !== v || !e.isMainFrame || e.errorCode === -3) return;
      p.phase = online() ? 'failed' : 'offline';
      p.why = (NAMES[s.service] || 'The service') + '’s page didn’t load: ' + (e.errorDescription || ('error ' + e.errorCode));
      stopReads(s);
      update(s);
    });
    update(s);
  }

  function reuse(ctx, s) {
    var p = pvOf(s);
    if (!p) return;
    p.item = s.item || null;
    p.itemUrl = s.url;
    if (!p.userMode) p.mode = PREF;
    p.read = null; p.phase = 'loading'; p.why = ''; p.save = null; p.confirm = false; p.more = false;
    update(s);
  }

  function destroy(ctx, s) {
    var p = pvOf(s);
    if (!p) return;
    stopReads(s);
    var i = all.indexOf(s);
    if (i >= 0) all.splice(i, 1);
  }

  function sync(ctx, s) { CTX = ctx; if (s) update(s); }

  /** A failed state in the Lumen view: the info says it too (the state's own box has the reason). */
  function stateActs(ctx, s, kind) {
    var p = pvOf(s);
    if (!p) return;
    if (kind === 'failed') { p.phase = online() ? 'failed' : 'offline'; stopReads(s); render(s); }
  }

  function stopReads(s) {
    var p = pvOf(s);
    if (!p) return;
    p.timers.forEach(function (t) { clearTimeout(t); });
    p.timers = [];
  }

  /** Read the page at READS after it loads (or moves in place), until it is all there. */
  function startReads(s, inPage) {
    var p = pvOf(s);
    if (!p) return;
    stopReads(s);
    var seq = ++p.seq;
    if (!online()) { p.phase = 'offline'; update(s); return; }
    READS.forEach(function (ms, i) {
      p.timers.push(setTimeout(function () { tick(s, seq, i === READS.length - 1); }, inPage ? Math.max(120, ms / 2) : ms));
    });
    update(s);
  }

  function tick(s, seq, last) {
    var p = pvOf(s);
    if (!p || p.seq !== seq || !s.view) return;
    var v = s.view;
    var on = wantTrim(s);
    js(v, call('tick', [s.service, on])).then(function (r) {
      if (s.view !== v || p.seq !== seq) return;
      if (!r || !r.ok) throw new Error('no answer from the page');
      p.lastUrl = r.url || p.lastUrl;
      p.read = r;
      p.applied = !!r.applied;
      if (on && !r.applied && last) {
        p.noRoot = true;
        p.why = 'Lumen couldn’t find ' + (NAMES[s.service] || 'the service') + '’s player on this page, so the whole page shows.';
        if (CTX && CTX.note) CTX.note(p.why);
      }
      var done = s.service === 'youtube' ? complete(r) && (!on || r.applied) : (!on || r.applied);
      if (done) { p.phase = 'ready'; stopReads(s); }
      else if (last) p.phase = s.service === 'youtube' && !(r.title || (r.channel && r.channel.name)) ? 'unread' : 'partial';
      update(s);
    }).catch(function (e) {
      if (s.view !== v || p.seq !== seq) return;
      if (last) { p.phase = online() ? 'unread' : 'offline'; p.why = 'Lumen couldn’t read the page: ' + ((e && e.message) || e); update(s); }
    });
  }

  /** Classes, the trim and the info, from the slot's state. */
  function update(s) {
    var p = pvOf(s), L = layerOf();
    if (!p || !L) return;
    var boxed = isBoxed(s);
    s.tile.classList.toggle('pv', boxed);
    layoutBox(s);
    s.tile.classList.toggle('pv-wait', boxed && !p.applied && p.phase !== 'failed' && p.phase !== 'offline');
    if (L.el && L.slots[L.focus] === s || (L.el && L.slots.length === 1)) L.el.classList.toggle('pv-on', boxed);
    // Clear the trim where the view no longer wants it (a grid, Full page); set it where it does.
    if (s.view && p.applied !== wantTrim(s) && (p.applied || p.phase !== 'loading')) {
      var v = s.view;
      var want = wantTrim(s);
      js(v, call('apply', [s.service, want])).then(function (a) { if (s.view === v) { p.applied = !!(a && a.on); render(s); } }, function () { /* the next load says */ });
    }
    render(s);
    syncBar(s);
  }

  function syncBar(s) {
    var YT = window.WatchPlayerYT;
    if (CTX && YT && typeof YT.sync === 'function' && CTX.focused && CTX.focused() === s) { try { YT.sync(CTX, s); } catch (e) { /* the bar stays */ } }
  }

  function refreshAll() {
    all.forEach(function (s) { var p = pvOf(s); if (p && !p.userMode) p.mode = PREF; if (p) update(s); });
  }

  function observeLayer() {
    var L = layerOf();
    if (obs || !L || !L.el || !window.MutationObserver) return;
    obs = new MutationObserver(function () { all.forEach(function (s) { if (s.view) update(s); }); });
    obs.observe(L.el, { attributes: true, attributeFilter: ['class'] });
    if (L.grid) obs.observe(L.grid, { attributes: true, attributeFilter: ['data-n'] });
    // The box follows the layer's size (a window resize, the split view): only when it changes.
    if (L.grid && window.ResizeObserver) new ResizeObserver(function () { all.forEach(layoutBox); }).observe(L.grid);
  }

  /**
   * The video box, in pixels on the <webview> itself (a <webview> ignores container-relative sizes):
   * 16:9, as wide as the layer allows, capped so PEEK px of the info always shows under it. Cleared
   * outside the view (a grid, the corner, the video's fullscreen, Full page): the page fills the tile.
   */
  function layoutBox(s) {
    var L = layerOf();
    if (!L || !s || !s.view || !s.tile) return;
    var on = s.tile.classList.contains('pv') && L.el && !L.el.classList.contains('mv-mini') && !L.el.classList.contains('wp-fs') && L.grid;
    if (!on) {
      if (s.view.style.width || s.view.style.height) { s.view.style.width = ''; s.view.style.height = ''; }
      s.tile.style.removeProperty('--pv-w');
      return;
    }
    var g = L.grid.getBoundingClientRect();
    if (g.width < 50 || g.height < 50) return;
    var w = Math.floor(Math.max(160, Math.min(g.width - 48, (g.height - 14 - PEEK) * 16 / 9)));
    var h = Math.round(w * 9 / 16);
    if (s.view.style.width !== w + 'px') s.view.style.width = w + 'px';
    if (s.view.style.height !== h + 'px') s.view.style.height = h + 'px';
    s.tile.style.setProperty('--pv-w', w + 'px');
  }

  /* ---------------------------------------------------------------- the bar's toggle */

  /** For watch-player-yt.js's "Full page" button: { label, title } when this slot has the toggle, else null. */
  function toggleFor(s) {
    var p = pvOf(s), L = layerOf();
    if (!p || !s.view || !L || L.slots.length !== 1 || s.multi || s.blocked || p.noRoot) return null;
    if (PREF === 'page' && !p.userMode) return null;   // the setting says "the service's full page": as before
    if (!viewable(kindOf(s))) return null;
    var svc = NAMES[s.service] || 'the service';
    return p.mode === 'lumen'
      ? { label: 'Full page', title: svc + '’s full page' + (s.service === 'youtube' ? ': comments, recommendations and the rest' : '') }
      : { label: 'Lumen view', title: 'Back to Lumen’s view: just the player, with Lumen’s info under it' };
  }
  function toggle(s) {
    var p = pvOf(s);
    if (!toggleFor(s)) return false;
    p.mode = p.mode === 'lumen' ? 'page' : 'lumen';
    p.userMode = true;
    p.save = null; p.confirm = false;
    update(s);
    if (p.mode === 'lumen' && !p.applied) startReads(s, true);
    try { s.view.focus(); } catch (e) { /* not focusable */ }
    return true;
  }

  /* ---------------------------------------------------------------- presses */

  /** One press of the page's own button, on his click: never twice, never by itself. */
  function press(s, kind, arg) {
    var p = pvOf(s);
    if (!p || !s.view || p.busy) return false;
    var v = s.view;
    p.busy = kind;
    p.why = '';
    var rec = { kind: kind, arg: arg === undefined ? null : arg, at: Date.now(), ok: null, reason: '' };
    p.presses.push(rec);
    render(s);
    js(v, call('press', [s.service, kind, arg === undefined ? null : arg])).then(function (r) {
      if (s.view !== v) return;
      p.busy = '';
      rec.ok = !!(r && r.ok);
      rec.reason = (r && r.reason) || '';
      if (!r || !r.ok) p.why = (r && r.reason) ? r.reason.charAt(0).toUpperCase() + r.reason.slice(1) : 'YouTube’s page didn’t answer';
      else if (r.changed === false && kind !== 'save-open' && kind !== 'save-close') p.why = 'YouTube didn’t confirm it yet: the state shown is what its page says';
      if (kind === 'save-open' || kind === 'save-toggle') p.save = r && r.ok ? { list: r.list || [] } : null;
      if (kind === 'save-close') p.save = null;
      if (kind === 'unsubscribe') p.confirm = false;
      return js(v, call('read', [s.service])).then(function (rr) { if (s.view === v && rr && rr.ok) p.read = rr; render(s); });
    }).catch(function (e) {
      if (s.view !== v) return;
      p.busy = '';
      rec.ok = false;
      rec.reason = (e && e.message) || String(e);
      p.why = 'YouTube’s page didn’t answer: ' + rec.reason;
      render(s);
    });
    return true;
  }

  function backToPlayer(s) { if (s && s.view && !(pvOf(s) && pvOf(s).save)) { try { s.view.focus(); } catch (e) { /* gone */ } } }

  /* ---------------------------------------------------------------- the info */

  function render(s) {
    var p = pvOf(s);
    if (!p || !p.info) return;
    var info = p.info;
    var boxed = s.tile.classList.contains('pv');
    p.cover.hidden = !(boxed && !p.applied && p.phase === 'loading');
    p.mount.hidden = !boxed;
    if (boxed) p.mount.id = 'lumen-pv-barmount'; else p.mount.removeAttribute('id');
    if (!boxed) { info.hidden = true; return; }
    info.hidden = false;
    var phase = !online() ? 'offline' : p.phase;
    var moved = !!(p.read && p.read.url && p.itemUrl && stripT(p.read.url) !== stripT(p.itemUrl) && s.service !== 'youtube');
    // Rebuild only when what it shows changed: the layer's own class changes and the page reads call
    // update() often, and a rebuild between his mouse press and release would swallow that click.
    var key = renderKey(s, p, phase, moved);
    if (key && key === p.rkey && info.firstChild) return;
    // His button is down on the info (a page read or the play bar's sync landed mid-click): hold the
    // rebuild until the release, so the click lands on the button he pressed; released() runs it.
    if (p.pressing && info.firstChild) { p.pendingRender = true; return; }
    p.rkey = key;
    var m = model(s.service, p.read, p.item, s.title, { moved: moved });
    info.setAttribute('data-svc', s.service);
    info.setAttribute('data-phase', phase);
    info.replaceChildren();
    if (s.service === 'youtube') renderYT(s, p, m, phase, info);
    else renderOther(s, p, m, phase, info);
  }
  /** Everything the info is drawn from; '' (always redraw) if it can't be written down. */
  function renderKey(s, p, phase, moved) {
    var it = p.item || {};
    try {
      return JSON.stringify([s.service, s.id, s.wcId, s.title, phase, moved, p.why, p.busy, p.confirm, p.more, p.save, p.spKnown,
        p.lastShowPage || 0, it.id, it.title, it.subtitle, p.read]);
    } catch (e) { return ''; }
  }
  function stripT(u) { return String(u || '').replace(/[?&]t=\d+s?/, ''); }

  function titleEl(text, phase) {
    var h = el('h1', 'pv-title');
    if (text) h.textContent = text;
    else { h.classList.add('pv-skel'); h.textContent = phase === 'loading' ? 'Loading the title…' : 'Untitled'; }
    return h;
  }

  function note(info, text, kind, act) {
    if (!text) return;
    var p = el('p', 'pv-why' + (kind ? ' pv-why-' + kind : ''));
    p.setAttribute('role', 'status');
    p.appendChild(el('span', 'pv-why-txt', text));
    if (act) p.appendChild(act);
    info.appendChild(p);
  }

  function renderYT(s, p, m, phase, info) {
    info.appendChild(titleEl(m.title, phase));
    var row = el('div', 'pv-row');
    // The channel: avatar, name, subscribers, Subscribe.
    var chan = el('div', 'pv-chan');
    var av = el('span', 'pv-avatar');
    if (m.channel && m.channel.avatar && /^https?:|^data:/.test(m.channel.avatar)) {
      var img = el('img');
      img.alt = '';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.src = m.channel.avatar;
      img.addEventListener('error', function () { img.remove(); av.textContent = initial(m.channel.name); });
      av.appendChild(img);
    } else av.textContent = m.channel ? initial(m.channel.name) : '';
    if (!m.channel) av.classList.add('pv-skel');
    chan.appendChild(av);
    var ct = el('div', 'pv-chan-txt');
    ct.appendChild(el('span', 'pv-chan-name' + (m.channel ? '' : ' pv-skel'), m.channel ? m.channel.name : (phase === 'loading' ? 'Reading the channel…' : 'Channel unknown')));
    ct.appendChild(el('span', 'pv-subs', m.channel ? (m.channel.subs || '') : ''));
    chan.appendChild(ct);
    var sb = m.buttons.sub;
    var subOn = !!(sb && sb.found && sb.on);
    var sub = button('pv-sub' + (subOn ? ' is-on' : ''), p.busy === 'subscribe' || p.busy === 'unsubscribe' ? (subOn ? 'Unsubscribing…' : 'Subscribing…') : (subOn ? 'Subscribed' : 'Subscribe'), function () {
      if (subOn) { p.confirm = true; render(s); var c = info.querySelector('.pv-confirm .pv-danger'); if (c) c.focus(); return; }
      press(s, 'subscribe');
      backToPlayer(s);
    }, subOn ? 'Subscribed to ' + ((m.channel && m.channel.name) || 'this channel') + ': unsubscribe' : 'Subscribe to ' + ((m.channel && m.channel.name) || 'this channel'));
    sub.setAttribute('aria-pressed', subOn ? 'true' : 'false');
    disable(sub, whyOff(m, 'sub', phase) || (p.busy ? 'Waiting for YouTube…' : ''));
    chan.appendChild(sub);
    row.appendChild(chan);
    // Like / Dislike / Save.
    var acts = el('div', 'pv-acts');
    var pair = el('div', 'pv-pair');
    var lk = m.buttons.like, dk = m.buttons.dislike;
    var like = iconBtn('pv-like' + (lk.on ? ' is-on' : ''), 'like', lk.found ? (lk.count && !/^like$/i.test(lk.count) ? lk.count : 'Like') : 'Like',
      function () { press(s, 'like'); backToPlayer(s); }, lk.on ? 'You like this: remove the like' : 'Like this video');
    like.setAttribute('aria-pressed', lk.on ? 'true' : 'false');
    disable(like, whyOff(m, 'like', phase) || (p.busy ? 'Waiting for YouTube…' : ''));
    var dis = iconBtn('pv-dislike' + (dk.on ? ' is-on' : ''), 'like', null, function () { press(s, 'dislike'); backToPlayer(s); }, dk.on ? 'You dislike this: remove the dislike' : 'Dislike this video');
    dis.setAttribute('aria-pressed', dk.on ? 'true' : 'false');
    disable(dis, whyOff(m, 'dislike', phase) || (p.busy ? 'Waiting for YouTube…' : ''));
    pair.appendChild(like);
    pair.appendChild(el('span', 'pv-pair-sep'));
    pair.appendChild(dis);
    acts.appendChild(pair);
    var save = iconBtn('pv-save' + (p.save ? ' is-open' : ''), 'save', p.busy === 'save-open' ? 'Opening…' : 'Save', function () {
      if (p.save) { press(s, 'save-close'); return; }
      press(s, 'save-open');
    }, 'Save to a playlist');
    save.setAttribute('aria-expanded', p.save ? 'true' : 'false');
    disable(save, whyOff(m, 'save', phase) || (p.busy && p.busy.indexOf('save') !== 0 ? 'Waiting for YouTube…' : ''));
    acts.appendChild(save);
    row.appendChild(acts);
    info.appendChild(row);

    // Lumen's own confirm for Unsubscribe (YouTube's is in its hidden page; Lumen presses it on his yes).
    if (p.confirm && subOn) {
      var cf = el('div', 'pv-confirm');
      cf.setAttribute('role', 'alertdialog');
      cf.appendChild(el('span', 'pv-confirm-txt', 'Unsubscribe from ' + ((m.channel && m.channel.name) || 'this channel') + '?'));
      cf.appendChild(button('pv-danger', 'Unsubscribe', function () { press(s, 'unsubscribe'); backToPlayer(s); }));
      cf.appendChild(button('pv-ghost', 'Cancel', function () { p.confirm = false; render(s); backToPlayer(s); }));
      info.appendChild(cf);
    }
    // YouTube's own Save list, drawn by Lumen: each row presses that playlist's own checkbox.
    if (p.save) {
      var sl = el('div', 'pv-savelist');
      sl.setAttribute('role', 'group');
      sl.setAttribute('aria-label', 'Save to a playlist');
      var head = el('div', 'pv-savelist-head');
      head.appendChild(el('span', 'pv-savelist-title', 'Save to…'));
      head.appendChild(button('pv-ghost pv-savelist-done', 'Done', function () { press(s, 'save-close'); backToPlayer(s); }));
      sl.appendChild(head);
      if (!p.save.list.length) sl.appendChild(el('p', 'pv-why', 'YouTube’s list is empty'));
      p.save.list.forEach(function (o, i) {
        var r = button('pv-saveopt' + (o.on ? ' is-on' : ''), o.name, function () { press(s, 'save-toggle', i); }, (o.on ? 'Remove from ' : 'Save to ') + o.name);
        r.setAttribute('role', 'checkbox');
        r.setAttribute('aria-checked', o.on ? 'true' : 'false');
        r.insertBefore(el('span', 'pv-check'), r.firstChild);
        if (p.busy) disable(r, 'Waiting for YouTube…');
        sl.appendChild(r);
      });
      info.appendChild(sl);
    }

    // Why anything is off: one line, the reason in words.
    if (phase === 'offline') note(info, 'You’re offline. The video’s details load when you’re back online.', 'warn');
    else if (phase === 'failed') note(info, p.why || 'YouTube’s page didn’t load.', 'err');
    else if (m.signedIn === false) note(info, 'You’re signed out of YouTube here: Like, Dislike, Subscribe and Save need you signed in.', 'warn',
      button('pv-ghost pv-signin', 'Sign in on YouTube’s page', function () { if (!toggle(s) && CTX) CTX.note('YouTube’s Sign in is at the top right of its page'); }));
    else if (p.why) note(info, p.why, /couldn’t|didn’t|isn’t|not /i.test(p.why) ? 'warn' : '');
    else if (phase === 'unread') note(info, 'Lumen couldn’t read this video’s details from YouTube’s page' + (m.title ? '; the title is from Lumen’s row' : '') + '.', 'warn');
    else if (phase !== 'loading' && m.missing.length) {
      var words = { like: 'Like', dislike: 'Dislike', sub: 'Subscribe', save: 'Save' };
      note(info, 'YouTube’s ' + m.missing.map(function (k) { return words[k]; }).join(', ') + (m.missing.length > 1 ? ' buttons aren’t' : ' button isn’t') + ' on this page, so ' + (m.missing.length > 1 ? 'they’re' : 'it’s') + ' off here.', 'warn');
    }

    // The description: YouTube's views and date line, then the text (three lines, "Show more").
    if (m.desc && (m.desc.text || m.desc.meta)) {
      var d = el('div', 'pv-desc' + (p.more ? ' is-more' : ''));
      if (m.desc.meta) d.appendChild(el('div', 'pv-desc-meta', m.desc.meta));
      if (m.desc.text) {
        d.appendChild(el('div', 'pv-desc-text', m.desc.text));
        if (m.desc.text.length > 180 || /\n/.test(m.desc.text)) d.appendChild(button('pv-ghost pv-more', p.more ? 'Show less' : 'Show more', function () { p.more = !p.more; render(s); }));
      }
      info.appendChild(d);
    }
    // A spot for Lumen-drawn comments (a later module fills it; see LumenPlayview.commentsSpot).
    var cm = el('section', 'pv-comments');
    cm.id = 'lumen-pv-comments';
    cm.setAttribute('data-video-id', m.videoId || '');
    cm.setAttribute('data-wc-id', s.wcId === null || s.wcId === undefined ? '' : String(s.wcId));
    cm.setAttribute('aria-label', 'Comments');
    cm.hidden = true;
    info.appendChild(cm);
    try { document.dispatchEvent(new CustomEvent('lumen-pv-info', { detail: { slot: s.id, wcId: s.wcId, videoId: m.videoId, comments: m.comments, container: cm } })); } catch (e) { /* no listeners */ }
  }

  function renderOther(s, p, m, phase, info) {
    var svc = el('div', 'pv-svc');
    var mark = el('span', 'wp-mark pv-mark', (window.WatchPlayerHosts && WatchPlayerHosts.SERVICES[s.service] && WatchPlayerHosts.SERVICES[s.service].mark) || '');
    mark.setAttribute('data-svc', s.service);
    svc.appendChild(mark);
    svc.appendChild(el('span', 'pv-svc-name', m.name));
    info.appendChild(svc);
    info.appendChild(titleEl(m.title, phase));
    if (m.ep || m.epName) {
      var ep = el('div', 'pv-ep');
      if (m.ep) ep.appendChild(el('span', 'pv-ep-num', m.ep));
      if (m.ep && m.epName) ep.appendChild(el('i', 'pv-dot'));
      if (m.epName) ep.appendChild(el('span', 'pv-ep-name', m.epName));
      info.appendChild(ep);
    }
    var row = el('div', 'pv-row pv-row-other');
    var sp = button('pv-showpage', 'Show page', function (b) { showPage(s, b); }, 'Open ' + (m.title || 'this title') + '’s show page in Lumen');
    row.appendChild(sp);
    info.appendChild(row);
    showPageCheck(s, sp, m);
    if (phase === 'offline') note(info, 'You’re offline. ' + m.name + '’s player needs the connection back.', 'warn');
    else if (phase === 'failed') note(info, p.why || m.name + '’s page didn’t load.', 'err');
    else if (p.why) note(info, p.why, 'warn');
    else if (!m.title && phase !== 'loading') note(info, 'Lumen couldn’t read this title from ' + m.name + '’s page.', 'warn');
  }

  function initial(name) { var t = String(name || '').trim(); return t ? t.charAt(0).toUpperCase() : ''; }
  function disable(b, why) {
    b.disabled = !!why;
    if (why) { b.title = why; b.setAttribute('aria-disabled', 'true'); b.setAttribute('data-why', why); }
    else { b.removeAttribute('title'); b.removeAttribute('aria-disabled'); b.removeAttribute('data-why'); }
  }

  /* ---------------------------------------------------------------- Show page */

  // In the Lumen tab: the tile he played (by its id), and whether Lumen has a show page for it.
  function showPageJs(item, open) {
    return '(() => { const id = ' + JSON.stringify(String(item && item.id || '')) + ';' +
      ' const S = window.LumenShows; if (!S) return { ok: false, reason: "Lumen’s show pages aren’t loaded" };' +
      ' const node = id ? [...document.querySelectorAll("*")].find((n) => n._item && n._item.id === id && n._item.kind !== "resume") || [...document.querySelectorAll("*")].find((n) => n._item && n._item.id === id) : null;' +
      ' const it = node ? node._item : ' + JSON.stringify(item || null) + ';' +
      ' if (!it || !S.stageButton(it)) return { ok: false, reason: "Lumen has no show page for this title" };' +
      (open ? ' return { ok: !!S.open(it), reason: "" };' : ' return { ok: true };') + ' })()';
  }
  function ownerView() { var L = layerOf(); return L && L.owner && L.owner.viewEl ? L.owner.viewEl : null; }
  function showPageCheck(s, b, m) {
    var p = pvOf(s), ov = ownerView();
    if (!p.item) { disable(b, 'Lumen has no show page for this title'); return; }
    if (p.spKnown && p.spKnown.id === p.item.id) { disable(b, p.spKnown.ok ? '' : p.spKnown.reason); return; }
    disable(b, 'Checking for a show page…');
    if (!ov) { disable(b, 'The Lumen tab isn’t there'); return; }
    js(ov, showPageJs(p.item, false)).then(function (r) {
      p.spKnown = { id: p.item && p.item.id, ok: !!(r && r.ok), reason: (r && r.reason) || 'Lumen has no show page for this title' };
      if (b.isConnected) disable(b, p.spKnown.ok ? '' : p.spKnown.reason);
    }, function (e) { p.spKnown = { id: p.item && p.item.id, ok: false, reason: 'Lumen couldn’t check: ' + ((e && e.message) || e) }; if (b.isConnected) disable(b, p.spKnown.reason); });
  }
  /** The show page in the Lumen tab; the player keeps playing in the mini-player (or closes, without it). */
  function showPage(s, b) {
    var p = pvOf(s), ov = ownerView();
    if (!ov || !p.item) return;
    disable(b, 'Opening…');
    js(ov, showPageJs(p.item, true)).then(function (r) {
      if (!r || !r.ok) { p.why = (r && r.reason) || 'The show page didn’t open'; render(s); return; }
      p.lastShowPage = Date.now();
      var mini = CTX && CTX.L && CTX.L.el ? CTX.L.el.querySelector('.mv-minibtn') : null;
      if (mini && !mini.disabled && !mini.hidden) mini.click();
      else if (CTX && CTX.close) CTX.close('Show page');
    }, function (e) { p.why = 'The show page didn’t open: ' + ((e && e.message) || e); render(s); });
  }

  /* ---------------------------------------------------------------- settings, offline */

  function setView(v) {
    var next = v === 'page' ? 'page' : 'lumen';
    PREF = next;
    all.forEach(function (s) { var p = pvOf(s); if (p) { p.userMode = false; p.mode = next; } });
    refreshAll();
    if (!api || typeof api.setView !== 'function') return Promise.resolve({ view: next, saved: false });
    return api.setView(next).then(function (r) { PREF = (r && r.view) || next; return { view: PREF, saved: true }; });
  }

  // The release (anywhere: he may drag off): the click is dispatched first, then any held rebuild runs.
  function releasedOne(s) {
    var p = pvOf(s);
    if (!p || !p.pressing) return;
    p.pressing = false;
    clearTimeout(p.pressT);
    if (p.pendingRender) { p.pendingRender = false; setTimeout(function () { render(s); }, 0); }
  }
  function released() { all.forEach(releasedOne); }
  window.addEventListener('pointerup', released, true);
  window.addEventListener('pointercancel', released, true);
  window.addEventListener('blur', released);

  window.addEventListener('offline', function () { all.forEach(function (s) { render(s); }); });
  window.addEventListener('online', function () { all.forEach(function (s) { var p = pvOf(s); if (p && p.phase !== 'ready') startReads(s, true); else render(s); }); });

  /* ---------------------------------------------------------------- e2e seam */

  function rect(n) { if (!n || !n.getBoundingClientRect) return null; var r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
  function stateOf(s) {
    var p = pvOf(s);
    if (!p) return null;
    var m = p.info && !p.info.hidden ? p.info : null;
    var q = function (sel) { return m ? m.querySelector(sel) : null; };
    var b = function (sel) { var n = q(sel); return n ? { text: n.textContent.trim(), disabled: n.disabled, pressed: n.getAttribute('aria-pressed'), why: n.getAttribute('data-why') || '' } : null; };
    return {
      id: s.id, wcId: s.wcId, service: s.service, url: s.url, kind: kindOf(s), mode: p.mode, userMode: p.userMode, boxed: s.tile.classList.contains('pv'),
      phase: p.phase, applied: p.applied, noRoot: p.noRoot, why: p.why, busy: p.busy, presses: p.presses.slice(), confirm: p.confirm, save: p.save,
      view: rect(s.view), tile: rect(s.tile), info: m ? rect(m) : null, cover: p.cover && !p.cover.hidden,
      title: q('.pv-title') ? q('.pv-title').textContent : '', channel: q('.pv-chan-name') ? q('.pv-chan-name').textContent : '', subs: q('.pv-subs') ? q('.pv-subs').textContent : '',
      ep: q('.pv-ep') ? q('.pv-ep').textContent : '', svc: q('.pv-svc-name') ? q('.pv-svc-name').textContent : '',
      note: q('.pv-why') ? q('.pv-why').textContent : '', like: b('.pv-like'), dislike: b('.pv-dislike'), sub: b('.pv-sub'), savebtn: b('.pv-save'), showPage: b('.pv-showpage'),
      desc: q('.pv-desc') ? q('.pv-desc').textContent : '', comments: !!q('#lumen-pv-comments'), read: p.read
    };
  }

  return Object.assign({}, PURE, {
    // watch-player.js X() hooks
    attach: attach, reuse: reuse, destroy: destroy, sync: sync, stateActs: stateActs,
    // watch-player-yt.js's "Full page" button
    toggleFor: toggleFor, toggle: toggle,
    // Settings > Lumen
    view: function () { return PREF; }, setView: setView,
    // a later comments module: the container under the description, and the event it fires
    commentsSpot: function () { return document.getElementById('lumen-pv-comments'); },
    _press: function (kind, arg) { var L = layerOf(); var s = L && L.slots[L.focus]; return s ? press(s, kind, arg) : false; },
    _state: function () { var L = layerOf(); return { pref: PREF, slots: all.filter(function (s) { return !!s.view; }).map(stateOf), layerOn: !!(L && L.el && L.el.classList.contains('pv-on')) }; }
  });
});
