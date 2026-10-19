/* ============================================================
   watch-shorts.js -- Lumen's Shorts view (chrome side).

   A YouTube Short plays in Lumen the way it does on YouTube: one
   vertical player, centred, YouTube's own player and controls, and
   the wheel, a trackpad swipe, a touch swipe or Up/Down moving one
   Short at a time. The hosted page is still YouTube's own Shorts page
   in the layer's <webview> (signed in as the user; history, likes and the
   sequence are YouTube's own). Lumen only trims it and draws the rest:

     - The trim (watch-playview.js's way): insertCSS rules that apply
       only while the page's <html data-lumen-sh> is set. A script in
       the page finds the Shorts app (ytd-shorts with a <video>), marks
       it data-lumen-sh-root and lays it over the page's viewport (the
       9:16 webview); YouTube's masthead, guide, its action bar (Like,
       Dislike, Comments, Share), the title and channel overlay and its
       up/down buttons are hidden, since Lumen draws its own. The
       player, its controls, the ad UI, consent and error notices are
       never hidden. No root found: no flag, the whole page shows, and
       the reason is said.
     - Lumen's info sits BESIDE the player on a wide layer and BELOW it
       on a narrow one: the title, the channel, Subscribe, Like,
       Dislike and Save. Each is YouTube's OWN button in the page,
       pressed once per click, only on his click, the state read back.
       The model and the reasons are watch-playview.js's (model,
       whyOff), so the two views say the same things.
     - Next and Previous press YouTube's OWN Shorts navigation (its
       down/up buttons; else its snap container is scrolled one Short;
       else its own Arrow key). The info follows whichever Short is
       current: it shows a read only when the read is for the Short
       the page's address says (follow()).
     - The wheel anywhere in the Shorts view outside the page (the
       margins, Lumen's info and buttons: forwarded, never swallowed)
       moves one Short per gesture: a trackpad's burst of small deltas
       and its inertia are ONE gesture (gesture()). Over the player
       itself, YouTube's own handler and snap do it. Up/Down in the
       chrome do the same; in the page they are YouTube's own keys.
     - A channel's Shorts tab and Subscriptions' Shorts open their
       first Short in YouTube's own player (its own sequence follows).

   Hooks: watch-player.js X() (attach, reuse, sync, destroy,
   stateActs); with this file missing, a Short is the page it always
   was. Lumen's play bar (watch-playerbar.js) fits itself to the
   vertical player and leaves Up/Down, the wheel and swipes to this
   view (move() takes an Up/Down the bar's page bridge saw). watch-shorts-main.js logs the view's lines to quartz.log. Also
   a CommonJS module for the unit harness (the pure parts).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./watch-playview'));
  else root.LumenShorts = factory(root.LumenPlayview);
})(typeof self !== 'undefined' ? self : this, function (PV) {
  'use strict';

  /* ================================================================ pure */

  var ORIGIN = 'https://www.youtube.com';
  var ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
  var YT_HOST = /^(www\.|m\.)?youtube\.com$/i;
  var READS = [250, 900, 2000, 4000, 8000];   // ms after a page loads
  var MOVES = [150, 500, 1100, 2500];          // ms after it moves to another Short in place

  // The wheel, as one gesture per Short (gesture()).
  var WHEEL = {
    GAP: 220,       // ms of quiet that ends a gesture (a trackpad's inertia keeps it going)
    MIN: 24,        // px a gesture must travel before it moves a Short (a twitch is no move)
    LOCK: 380,      // ms after a move in which nothing moves again (YouTube's snap is still running)
    RISE: 2.5,      // a new swipe inside the inertia: a delta this many times the last one
    RISE_MIN: 40,   // ...and at least this big
    LINE: 16, PAGE: 800
  };

  // The layout (box()).
  var LAY = { PAD: 16, GAP: 16, NAV: 44, INFO_W: 340, INFO_MAX: 420, INFO_H: 172, BELOW_MAX: 560 };

  function parse(url) { try { return new URL(String(url || '')); } catch (e) { return null; } }

  /**
   * Which Shorts page a URL is, or null: { kind: 'short', id } (one Short), { kind: 'feed' }
   * (youtube.com/shorts, YouTube picks the first), { kind: 'channel', path } (a channel's Shorts
   * tab), { kind: 'subs' } (Subscriptions' Shorts). service: the slot's service, so a test origin
   * (rebased to 127.0.0.1) counts when the slot says 'youtube'.
   */
  function route(url, service) {
    var u = parse(url);
    if (!u || !/^https?:$/.test(u.protocol)) return null;
    if (!YT_HOST.test(u.hostname) && service !== 'youtube') return null;
    var p = u.pathname.replace(/\/+$/, '') || '/';
    var m = /^\/shorts\/([^/]+)$/.exec(p);
    if (m) return ID_RE.test(m[1]) ? { kind: 'short', id: m[1] } : null;
    if (p === '/shorts') return { kind: 'feed' };
    if (p === '/feed/subscriptions/shorts') return { kind: 'subs' };
    m = /^(\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+))\/shorts$/.exec(p);
    if (m) return { kind: 'channel', path: m[1] };
    return null;
  }
  function isShorts(url, service) { return !!route(url, service); }
  /** The Short a URL is ('' when it is a feed, a grid, or no Short). */
  function idOf(url, service) { var r = route(url, service); return r && r.kind === 'short' ? r.id : ''; }

  /** The URL each of Lumen's ways in opens. */
  function entryUrl(kind, arg) {
    if (kind === 'short') return ID_RE.test(String(arg || '')) ? ORIGIN + '/shorts/' + arg : '';
    if (kind === 'feed') return ORIGIN + '/shorts';
    if (kind === 'subs') return ORIGIN + '/feed/subscriptions/shorts';
    if (kind === 'channel') return /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)$/.test(String(arg || '')) ? ORIGIN + arg + '/shorts' : '';
    return '';
  }

  /**
   * The wheel: one Short per gesture. st: the state from the last call (or null); ev: { dy, dx,
   * mode (deltaMode), t (ms) }. Returns { st, step: -1 | 0 | 1 }. A gesture is a run of events
   * with less than GAP ms between them (a trackpad's burst and its inertia); it moves once, when
   * it has travelled MIN px, and never within LOCK ms of the last move. A new swipe inside a
   * decaying burst (a delta RISE times the last, or the other way) starts a new gesture.
   */
  function gesture(st, ev) {
    var s = st ? Object.assign({}, st) : { lastT: -1e9, lastAbs: 0, acc: 0, fired: false, stepT: -1e9, dir: 0 };
    var e = ev || {};
    var k = e.mode === 1 ? WHEEL.LINE : e.mode === 2 ? WHEEL.PAGE : 1;
    var dy = Number(e.dy) * k || 0, dx = Number(e.dx) * k || 0;
    var t = Number(e.t) || 0;
    if (Math.abs(dx) > Math.abs(dy)) { s.lastT = t; return { st: s, step: 0 }; }   // sideways: not a Short move
    var a = Math.abs(dy);
    var dir = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    var fresh = t - s.lastT >= WHEEL.GAP ||
      (s.fired && dir && s.dir && dir !== s.dir && a >= WHEEL.RISE_MIN) ||
      (s.fired && a >= WHEEL.RISE_MIN && a > s.lastAbs * WHEEL.RISE);
    if (fresh) { s.acc = 0; s.fired = false; }
    s.acc += dy;
    s.lastT = t;
    s.lastAbs = a;
    if (dir) s.dir = dir;
    var step = 0;
    if (!s.fired && Math.abs(s.acc) >= WHEEL.MIN && t - s.stepT >= WHEEL.LOCK) {
      step = s.acc > 0 ? 1 : -1;
      s.fired = true;
      s.stepT = t;
    }
    return { st: s, step: step };
  }

  /** A key in the chrome: 1 (ArrowDown), -1 (ArrowUp), 0 (anything else, or with a modifier). */
  function keyStep(e) {
    var x = e || {};
    if (x.altKey || x.ctrlKey || x.metaKey || x.shiftKey) return 0;
    return x.key === 'ArrowDown' ? 1 : x.key === 'ArrowUp' ? -1 : 0;
  }

  /**
   * The info follows the current Short: the page's address says which Short it is (curId); a read
   * is shown only when it is for that Short. Returns { id, fresh, moved }: fresh = the read is the
   * current Short's; moved = the current Short is not the one shown last (shownId).
   */
  function follow(curId, read, shownId) {
    var id = String(curId || '');
    var rid = read && read.videoId ? String(read.videoId) : '';
    return { id: id, fresh: !!id && rid === id, moved: !!id && id !== String(shownId || '') };
  }

  /** Whether a read has everything the info shows (the reads can stop). */
  function complete(r) {
    return !!(r && r.videoId && r.title && r.channel && r.channel.name && r.like && r.like.found && r.sub && r.sub.found);
  }

  /**
   * Where everything goes in the tile (gw x gh, the layer's grid): the player 9:16 as tall as the
   * tile allows, centred; Lumen's Next/Previous beside it; the info BESIDE when there is room for
   * it on both sides (so the player stays centred), else BELOW (the player shorter, so it fits).
   */
  function box(gw, gh) {
    var W = Math.max(0, Math.floor(gw)), Hh = Math.max(0, Math.floor(gh));
    var vh = Math.max(160, Hh - 2 * LAY.PAD);
    var vw = Math.round(vh * 9 / 16);
    var side = LAY.GAP + LAY.NAV + LAY.GAP + LAY.INFO_W;
    if (W >= vw + 2 * side) {
      var x = Math.round((W - vw) / 2);
      var infoX = x + vw + LAY.GAP + LAY.NAV + LAY.GAP;
      return { mode: 'beside', vw: vw, vh: vh, x: x, y: LAY.PAD, navX: x + vw + LAY.GAP, navY: LAY.PAD,
        infoX: infoX, infoY: LAY.PAD, infoW: Math.max(LAY.INFO_W, Math.min(LAY.INFO_MAX, W - infoX - 24)), infoH: vh };
    }
    vh = Math.max(160, Hh - 2 * LAY.PAD - LAY.GAP - LAY.INFO_H);
    vw = Math.round(vh * 9 / 16);
    var maxW = W - 2 * (LAY.GAP + LAY.NAV + LAY.GAP);
    if (vw > maxW && maxW > 90) { vw = maxW; vh = Math.round(vw * 16 / 9); }
    var bx = Math.round((W - vw) / 2);
    var iw = Math.min(LAY.BELOW_MAX, Math.max(200, W - 48));
    return { mode: 'below', vw: vw, vh: vh, x: bx, y: LAY.PAD, navX: bx + vw + LAY.GAP, navY: LAY.PAD,
      infoX: Math.round((W - iw) / 2), infoY: LAY.PAD + vh + LAY.GAP, infoW: iw, infoH: Math.max(0, Hh - (LAY.PAD + vh + LAY.GAP) - 8) };
  }

  // YouTube's own furniture on the Shorts page, hidden while the view is on. Never the player, its
  // controls, the ad UI (an ad's own panel is kept by :has()), consent, errors or dialogs.
  var AD = 'ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-reel-ad-metadata-renderer, [class*="ad-badge"], [class*="AdBadge"], [id^="ad-"]';
  var HIDE = ['#masthead-container', 'ytd-masthead', 'tp-yt-app-drawer#guide', 'ytd-mini-guide-renderer', '#guide',
    '#navigation-container', '#navigation-button-up', '#navigation-button-down',
    'ytd-reel-video-renderer #actions', 'reel-action-bar-view-model', 'ytd-reel-player-overlay-renderer #actions',
    'ytd-reel-video-renderer #metapanel', 'yt-reel-metapanel-view-model', 'ytd-reel-player-header-renderer', 'ytd-reel-video-renderer .metadata-container',
    'ytd-shorts #shorts-panel-container', 'ytd-shorts ytd-engagement-panel-section-list-renderer'];
  // ...of which the Short's own overlay pieces (its title and channel, its action bar) are only VEILED (invisible,
  // never hit, still laid out): YouTube loads their images, the channel's avatar among them, only once laid out
  // (a display:none avatar never got its picture, and Lumen showed an initial). Read 10-18 from the real page.
  var VEIL = ['ytd-reel-video-renderer #actions', 'reel-action-bar-view-model', 'ytd-reel-player-overlay-renderer #actions',
    'ytd-reel-video-renderer #metapanel', 'yt-reel-metapanel-view-model', 'ytd-reel-player-header-renderer', 'ytd-reel-video-renderer .metadata-container'];
  var GONE = HIDE.filter(function (s) { return VEIL.indexOf(s) < 0; });
  // Today's Shorts page (read 10-18 from the real page): ONE ytd-reel-video-renderer, in #reel-overlay-container,
  // which YouTube moves into the current sequence slot (div.reel-video-in-sequence-new: YouTube's own 9:16 size,
  // a gap between slots, the neighbours' thumbnails above and below). Lumen pins that overlay over the whole page
  // (the 9:16 webview) and sizes every box down to the player to it, so the Short shows edge to edge, centred, with
  // no black strip and nothing cut off, and no neighbour peeks in. Older pages (a renderer per slot) keep the
  // per-renderer rules below.
  var FILL = ['#reel-overlay-container > ytd-reel-video-renderer', 'ytd-reel-video-renderer #short-video-container', 'ytd-reel-video-renderer .player-wrapper',
    'ytd-reel-video-renderer #player-container', 'ytd-reel-video-renderer .player-container', 'ytd-reel-video-renderer ytd-player', 'ytd-reel-video-renderer ytd-player > #container',
    'ytd-reel-video-renderer #shorts-player', '#reel-overlay-container #shorts-player'];
  var KEEP = ['ytd-popup-container tp-yt-paper-dialog:has(yt-confirm-dialog-renderer)', 'ytd-consent-bump-v2-lightbox',
    'ytd-popup-container tp-yt-paper-dialog:has(ytd-enforcement-message-view-model)', 'yt-playability-error-supported-renderers',
    'ytd-reel-video-renderer ytd-ad-slot-renderer', 'ytd-reel-video-renderer ytd-reel-ad-metadata-renderer'];

  /** The CSS that trims YouTube's Shorts page to its player; inert until <html data-lumen-sh> is set. */
  function trimCss() {
    var R = 'html[data-lumen-sh] [data-lumen-sh-root]';
    return [
      KEEP.map(function (s) { return 'html[data-lumen-sh]:not([data-lumen-sh-pressing]) ' + s; }).join(',\n') + ' { visibility: visible !important; z-index: 2147483647 !important; }',
      'html[data-lumen-sh], html[data-lumen-sh] > body { overflow: hidden !important; background: #000 !important; }',
      'html[data-lumen-sh] > body { visibility: hidden !important; }',
      R + ' { visibility: visible !important; position: fixed !important; left: 0 !important; top: 0 !important; right: auto !important; bottom: auto !important;' +
        ' width: 100vw !important; height: 100vh !important; margin: 0 !important; padding: 0 !important; min-width: 0 !important; min-height: 0 !important;' +
        ' max-width: none !important; max-height: none !important; transform: none !important; z-index: 2147483646 !important; background: #000 !important;' +
        ' --ytd-masthead-height: 0px; --ytd-toolbar-height: 0px; }',
      R + ' #shorts-container, ' + R + ' #shorts-inner-container { width: 100vw !important; height: 100vh !important; margin: 0 !important; padding: 0 !important; top: 0 !important; transform: none !important; contain: none !important; filter: none !important; will-change: auto !important; }',
      R + ' .reel-video-in-sequence-new { transform: none !important; contain: none !important; filter: none !important; will-change: auto !important; }',
      R + ' #reel-overlay-container { position: fixed !important; left: 0 !important; top: 0 !important; right: auto !important; bottom: auto !important; width: 100vw !important; height: 100vh !important;' +
        ' margin: 0 !important; padding: 0 !important; min-width: 0 !important; max-width: none !important; max-height: none !important; transform: none !important; border-radius: 0 !important; z-index: 2 !important; background: #000 !important; }',
      R + ' ytd-reel-video-renderer { width: 100vw !important; height: 100vh !important; margin: 0 !important; padding: 0 !important; flex: none !important; min-width: 0 !important; max-width: none !important; }',
      R + ' ytd-reel-video-renderer #player-container, ' + R + ' ytd-reel-video-renderer .player-container, ' + R + ' ytd-reel-video-renderer #shorts-player' +
        ' { width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important; margin: 0 !important; border-radius: 0 !important; }',
      FILL.map(function (s) { return R + ' ' + s; }).join(', ') + ' { position: relative !important; left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important; margin: 0 !important; padding: 0 !important;' +
        ' min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important; flex: none !important; border-radius: 0 !important; transform: none !important; }',
      // The picture itself: the whole frame, never YouTube's pillarbox offset from a size it computed before the trim.
      R + ' #shorts-player video.html5-main-video, ' + R + ' ytd-reel-video-renderer video.html5-main-video { left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important; object-fit: contain !important; }',
      VEIL.map(function (s) { return 'html[data-lumen-sh] ' + s + ':not(:has(' + AD + '))'; }).join(',\n') + ' { visibility: hidden !important; pointer-events: none !important; }',
      GONE.map(function (s) { return 'html[data-lumen-sh] ' + s + ':not(:has(' + AD + '))'; }).join(',\n') + ' { display: none !important; }'
    ].join('\n');
  }

  /* ---------------------------------------------------------------- in the page */

  /**
   * Installed in YouTube's Shorts page (its own world, by executeJavaScript): finds the Shorts app,
   * sets or clears the view's flag, reads the CURRENT Short, moves with YouTube's own navigation,
   * opens a grid's first Short, and presses YouTube's own buttons. Serialised with String().
   */
  function guest() {
    var V = 2;
    if (window.__lumenSh && window.__lumenSh.v === V) return;
    function Q(sel, r) { try { return (r || document).querySelector(sel); } catch (e) { return null; } }
    function QA(sel, r) { try { return Array.prototype.slice.call((r || document).querySelectorAll(sel)); } catch (e) { return []; } }
    function txt(n) { return n ? String(n.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
    function wait(fn, ms) {
      return new Promise(function (ok) {
        var t0 = Date.now();
        (function loop() { var v = null; try { v = fn(); } catch (e) { v = null; } if (v) return ok(v); if (Date.now() - t0 > ms) return ok(null); setTimeout(loop, 80); })();
      });
    }
    function idOf(href) { var m = /\/shorts\/([A-Za-z0-9_-]{6,20})/.exec(String(href || '')); return m ? m[1] : ''; }
    function kind() {
      var p = location.pathname.replace(/\/+$/, '');
      if (/^\/shorts\/[^/]+$/.test(p)) return 'short';
      if (p === '/shorts') return 'feed';
      if (/\/shorts$/.test(p)) return 'grid';
      return 'other';
    }
    function reels() { return QA('ytd-reel-video-renderer'); }
    /** The Short on screen: YouTube's is-active, else the reel nearest the middle. */
    function active() {
      var a = Q('ytd-reel-video-renderer[is-active]');
      if (a) return a;
      var best = null, dist = 1e9, cy = innerHeight / 2;
      reels().forEach(function (r) { var b = r.getBoundingClientRect(); if (b.height < 10) return; var d = Math.abs((b.top + b.bottom) / 2 - cy); if (d < dist) { dist = d; best = r; } });
      return best;
    }
    function findRoot() {
      var app = Q('ytd-shorts');
      if (app && Q('video', app)) return { el: app, how: 'ytd-shorts' };
      return null;
    }
    var mo = null;
    function nudge() { setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (e) { /* gone */ } }, 0); }
    function apply(on) {
      var html = document.documentElement;
      var was = html.hasAttribute('data-lumen-sh');
      if (!on) {
        html.removeAttribute('data-lumen-sh');
        QA('[data-lumen-sh-root]').forEach(function (n) { n.removeAttribute('data-lumen-sh-root'); });
        if (was) nudge();
        return { on: false, root: false };
      }
      var f = findRoot();
      if (!f) { if (was) { html.removeAttribute('data-lumen-sh'); nudge(); } return { on: false, root: false }; }
      QA('[data-lumen-sh-root]').forEach(function (n) { if (n !== f.el) n.removeAttribute('data-lumen-sh-root'); });
      var fresh = !f.el.hasAttribute('data-lumen-sh-root');
      f.el.setAttribute('data-lumen-sh-root', '');
      html.setAttribute('data-lumen-sh', '');
      if (fresh || !was) nudge();
      // The current Short is snapped to the top after any resize (YouTube's own scroll position).
      if (fresh || !was) { var a = active(); if (a && a.scrollIntoView) setTimeout(function () { try { a.scrollIntoView({ block: 'start' }); } catch (e) { /* gone */ } }, 30); }
      return { on: true, root: true, how: f.how };
    }

    /* --- YouTube's own buttons, in the current Short ---- */
    function likeBtn(r) { return Q('like-button-view-model button', r) || Q('#like-button button', r) || Q('button[aria-label^="like this" i]', r); }
    // Today's page (read 10-18): the action bar is reel-action-bar-view-model (like-button-view-model, comments,
    // share, remix, the sound); signed out it has NO Dislike, signed in YouTube adds its own beside Like. Subscribe
    // sits in the channel bar (yt-reel-channel-bar-view-model .ytReelChannelBarViewModelReelSubscribeButton
    // button-view-model button), no subscribe-* element any more. Tag, class and label are all tried.
    function dislikeBtn(r) { return Q('dislike-button-view-model button', r) || Q('#dislike-button button', r) || Q('[class*="DislikeButton"] button', r) || Q('button[aria-label^="dislike" i]', r) || Q('reel-action-bar-view-model button[aria-label*="dislike" i]', r); }
    function subBtn(r) {
      return Q('subscribe-button-view-model button', r) || Q('yt-subscribe-button-view-model button', r) || Q('#subscribe-button button', r) || Q('ytd-subscribe-button-renderer button', r) ||
        Q('[class*="ReelSubscribeButton"] button', r) || Q('yt-reel-channel-bar-view-model button[aria-label^="subscribe" i]', r) || Q('yt-reel-channel-bar-view-model button[aria-label^="unsubscribe" i]', r) || Q('[class*="SubscribeButton"] button', r);
    }
    function saveBtn(r) { return Q('button[aria-label="Save to playlist" i]', r) || Q('button[aria-label^="Save" i]', r); }
    function menuBtn(r) { return Q('#menu-button button', r) || Q('button[aria-label="More actions" i]', r); }
    function pressed(b) { return !!b && b.getAttribute('aria-pressed') === 'true'; }
    function subscribed(b) {
      if (!b) return false;
      var host = b.closest('ytd-subscribe-button-renderer, subscribe-button-view-model, yt-subscribe-button-view-model, [class*="SubscribeButton"]');
      if (host && host.hasAttribute('subscribed')) return true;
      if (/^unsubscribe/i.test(String(b.getAttribute('aria-label') || ''))) return true;
      return /^subscribed$/i.test(txt(b));
    }
    function saveOpts() {
      return QA('ytd-add-to-playlist-renderer ytd-playlist-add-to-option-renderer, yt-list-item-view-model[role="listitem"]:has([role="checkbox"])').map(function (n) {
        var cb = Q('#checkbox', n) || Q('[role="checkbox"]', n) || n;
        return { el: cb, name: txt(Q('#label', n)) || String(cb.getAttribute('aria-label') || '').trim() || txt(n),
          on: cb.hasAttribute('checked') || cb.getAttribute('aria-checked') === 'true' };
      }).filter(function (o) { return o.name; });
    }
    function labelOf(b) {
      var host = b.closest('like-button-view-model, #like-button, ytd-toggle-button-renderer') || b;
      return txt(Q('.yt-spec-button-shape-with-label__label', host)) || txt(host);
    }
    function signedIn() {
      var signed = null;
      try { if (window.ytcfg && typeof window.ytcfg.get === 'function') { var li = window.ytcfg.get('LOGGED_IN'); if (typeof li === 'boolean') signed = li; } } catch (e) { signed = null; }
      if (signed === null) {
        if (Q('#masthead #avatar-btn, ytd-masthead #avatar-btn')) signed = true;
        else if (Q('a[href*="ServiceLogin"], a[href*="accounts.google.com"]')) signed = false;
      }
      return signed;
    }
    function read() {
      var k = kind();
      var r = active();
      var out = { ok: true, kind: k, url: location.href, videoId: k === 'short' ? idOf(location.pathname) : '', signedIn: signedIn(), pageTitle: document.title,
        title: '', channel: null, like: { found: false }, dislike: { found: false }, sub: { found: false }, save: { found: false },
        canPrev: null, canNext: null, root: !!Q('[data-lumen-sh-root]'), on: document.documentElement.hasAttribute('data-lumen-sh'),
        reels: reels().length, links: k === 'grid' || k === 'feed' ? QA('a[href*="/shorts/"]').length : 0, ad: false };
      if (!r) return out;
      out.ad = !!Q(AD_SEL, r);
      var t = Q('yt-shorts-video-title-view-model h2', r) || Q('.ytShortsVideoTitleViewModelShortsVideoTitle', r) || Q('h2.title', r) || Q('#overlay .title', r);
      out.title = txt(t);
      var ca = Q('yt-reel-channel-bar-view-model a[href*="/@"]', r) || Q('.ytReelChannelBarViewModelChannelName a', r) || Q('ytd-channel-name a', r) || Q('#channel-name a', r) || Q('a[href^="/@"]', r);
      if (ca && txt(ca)) {
        // The channel bar's own avatar (yt-decorated-avatar-view-model's img). An <img> YouTube hasn't loaded yet has
        // no src: the next read gets it (the bar is veiled, never display:none, so YouTube does load it).
        var img = Q('yt-reel-channel-bar-view-model img[src]', r) || Q('#avatar img[src]', r) || Q('img.yt-core-image[src]', r);
        var av = img ? String(img.src || '') : '';
        out.channel = { name: txt(ca).replace(/^@/, '@'), url: ca.href || '', avatar: /^(https?:\/\/|data:image\/)/.test(av) ? av : '', subs: '' };
      }
      var lb = likeBtn(r), db = dislikeBtn(r), sb = subBtn(r), vb = saveBtn(r) || menuBtn(r);
      if (lb) out.like = { found: true, on: pressed(lb), count: labelOf(lb), label: lb.getAttribute('aria-label') || '' };
      if (db) out.dislike = { found: true, on: pressed(db), label: db.getAttribute('aria-label') || '' };
      if (sb) out.sub = { found: true, on: subscribed(sb), label: sb.getAttribute('aria-label') || txt(sb) };
      if (vb) out.save = { found: true, on: false, label: vb.getAttribute('aria-label') || '' };
      var up = Q('#navigation-button-up button'), dn = Q('#navigation-button-down button');
      var list = reels(), i = list.indexOf(r);
      out.canPrev = up ? !up.disabled && up.getAttribute('aria-disabled') !== 'true' : i > 0;
      out.canNext = dn ? !dn.disabled && dn.getAttribute('aria-disabled') !== 'true' : (i >= 0 && i < list.length - 1) || null;
      return out;
    }
    var AD_SEL = 'ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-reel-ad-metadata-renderer';

    /** One move with YouTube's OWN navigation: its button, else its snap container, else its key. */
    function step(dir) {
      var from = idOf(location.pathname);
      var b = dir > 0 ? Q('#navigation-button-down button') : Q('#navigation-button-up button');
      if (b && (b.disabled || b.getAttribute('aria-disabled') === 'true')) return { ok: false, how: 'button', from: from, reason: dir > 0 ? 'This is the last Short YouTube has here' : 'This is the first Short' };
      if (b) { b.click(); return { ok: true, how: 'button', from: from }; }
      var box = Q('#shorts-inner-container') || Q('ytd-shorts #shorts-container');
      if (box && box.scrollHeight > box.clientHeight + 4) {
        var before = box.scrollTop;
        if (dir < 0 && before <= 2) return { ok: false, how: 'scroll', from: from, reason: 'This is the first Short' };
        box.scrollBy({ top: dir * box.clientHeight, behavior: 'smooth' });
        return { ok: true, how: 'scroll', from: from };
      }
      var key = dir > 0 ? 'ArrowDown' : 'ArrowUp';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: key, code: key, keyCode: dir > 0 ? 40 : 38, bubbles: true }));
      return { ok: true, how: 'key', from: from };
    }

    /** A grid (a channel's Shorts tab, Subscriptions' Shorts): YouTube's own first Short link. */
    function openFirst() {
      var a = QA('a[href*="/shorts/"]').filter(function (n) { return idOf(n.getAttribute('href')); })[0];
      if (!a) return { ok: false, reason: 'no Shorts on this page' };
      a.click();
      return { ok: true, id: idOf(a.getAttribute('href')) };
    }

    /** One press of YouTube's own button (kind) in the current Short, on his click. */
    function press(kind, arg) {
      var r = active();
      if (!r) return Promise.resolve({ ok: false, reason: 'no Short is on YouTube’s page' });
      var b;
      if (kind === 'like' || kind === 'dislike') {
        b = kind === 'like' ? likeBtn(r) : dislikeBtn(r);
        if (!b) return Promise.resolve({ ok: false, reason: 'YouTube’s ' + (kind === 'like' ? 'Like' : 'Dislike') + ' button isn’t on this Short' });
        var was = pressed(b);
        b.click();
        return wait(function () { var n = kind === 'like' ? likeBtn(r) : dislikeBtn(r); return n && pressed(n) !== was ? 1 : 0; }, 2500).then(function (ch) { return { ok: true, changed: !!ch }; });
      }
      if (kind === 'subscribe') {
        b = subBtn(r);
        if (!b) return Promise.resolve({ ok: false, reason: 'YouTube’s Subscribe button isn’t on this Short' });
        if (subscribed(b)) return Promise.resolve({ ok: false, reason: 'already subscribed' });
        b.click();
        return wait(function () { return subscribed(subBtn(r)) ? 1 : 0; }, 2500).then(function (ch) { return { ok: true, changed: !!ch }; });
      }
      if (kind === 'unsubscribe') {
        b = subBtn(r);
        if (!b) return Promise.resolve({ ok: false, reason: 'YouTube’s Subscribe button isn’t on this Short' });
        if (!subscribed(b)) return Promise.resolve({ ok: false, reason: 'not subscribed' });
        var html = document.documentElement;
        html.setAttribute('data-lumen-sh-pressing', '');
        var done = function (x) { html.removeAttribute('data-lumen-sh-pressing'); return x; };
        b.click();
        var confirmBtn = function () { return Q('yt-confirm-dialog-renderer #confirm-button button') || Q('yt-confirm-dialog-renderer #confirm-button') || Q('#confirm-button button'); };
        var menuItem = function () { return QA('ytd-menu-service-item-renderer, tp-yt-paper-item, yt-list-item-view-model').filter(function (n) { return /^unsubscribe$/i.test(txt(n)); })[0] || null; };
        return wait(function () { return confirmBtn() || menuItem(); }, 2500).then(function (c) {
          if (!c) return { ok: false, reason: 'YouTube didn’t ask to confirm the unsubscribe' };
          if (c !== confirmBtn()) { c.click(); return wait(confirmBtn, 2500).then(function (c2) { if (!c2) return { ok: false, reason: 'YouTube’s confirm didn’t appear' }; c2.click(); return { ok: true }; }); }
          c.click();
          return { ok: true };
        }).then(function (x) { return x.ok ? wait(function () { return subscribed(subBtn(r)) ? 0 : 1; }, 2500).then(function (ch) { x.changed = !!ch; return x; }) : x; })
          .then(done, function (e) { done(null); return { ok: false, reason: String((e && e.message) || e) }; });
      }
      if (kind === 'save-open') {
        var list = function () { var l = saveOpts(); return l.length ? l : null; };
        var shown = function (l) { return l ? { ok: true, list: l.map(function (o) { return { name: o.name, on: o.on }; }) } : { ok: false, reason: 'YouTube’s Save list didn’t open' }; };
        b = saveBtn(r);
        if (b) { b.click(); return wait(list, 3000).then(shown); }
        var mb = menuBtn(r);
        if (!mb) return Promise.resolve({ ok: false, reason: 'YouTube’s Save button isn’t on this Short' });
        mb.click();
        return wait(function () { return QA('ytd-menu-service-item-renderer, tp-yt-paper-item, yt-list-item-view-model').filter(function (n) { return /^save/i.test(txt(n)); })[0] || null; }, 2500).then(function (item) {
          if (!item) return { ok: false, reason: 'YouTube’s menu has no Save for this Short' };
          item.click();
          return wait(list, 3000).then(shown);
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
    /** The current Short changes (is-active moves): the chrome is told by the address; this keeps the root marked. */
    function watchActive() {
      if (mo || !window.MutationObserver) return;
      var app = Q('ytd-shorts');
      if (!app) return;
      mo = new MutationObserver(function () { if (document.documentElement.hasAttribute('data-lumen-sh') && !Q('[data-lumen-sh-root]')) apply(true); });
      mo.observe(app, { subtree: true, attributes: true, attributeFilter: ['is-active'] });
    }
    // The wheel over today's pinned Short (#reel-overlay-container, fixed over the page): a fixed box's wheel never
    // reaches YouTube's snap container, so the page moves ONE Short per gesture itself, with YouTube's own
    // Next/Previous (step()). A trackpad's burst and its inertia are one gesture (the chrome's gesture() rule: 220 ms
    // of quiet ends it, 24 px moves, then 380 ms of lock). Older pages (no pinned overlay) keep YouTube's own wheel.
    var wg = { last: 0, acc: 0, moved: false, lock: 0 };
    function onWheel(e) {
      if (!document.documentElement.hasAttribute('data-lumen-sh') || e.ctrlKey) return;
      var t = e.target;
      if (!t || !t.closest || !t.closest('[data-lumen-sh-root] #reel-overlay-container')) return;
      e.preventDefault();
      e.stopPropagation();
      var now = Date.now();
      var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
      if (now - wg.last > 220) { wg.acc = 0; wg.moved = false; }
      wg.last = now;
      if (wg.moved || now < wg.lock) return;
      wg.acc += dy;
      if (Math.abs(wg.acc) >= 24) { wg.moved = true; wg.lock = now + 380; step(wg.acc > 0 ? 1 : -1); }
    }
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    window.__lumenSh = { v: V, apply: apply, read: read, step: step, openFirst: openFirst, press: press,
      tick: function (on) { var a = apply(on); if (a.on) watchActive(); var x = read(); x.applied = a.on; x.how = a.how || ''; return x; } };
  }
  var GUEST = '(' + String(guest) + ')();';
  function call(method, args) {
    return GUEST + 'window.__lumenSh.' + method + '(' + (args || []).map(function (a) { return JSON.stringify(a === undefined ? null : a); }).join(',') + ')';
  }

  var PURE = { ORIGIN: ORIGIN, READS: READS, MOVES: MOVES, WHEEL: WHEEL, LAY: LAY, HIDE: HIDE, KEEP: KEEP, route: route, isShorts: isShorts, idOf: idOf,
    entryUrl: entryUrl, gesture: gesture, keyStep: keyStep, follow: follow, complete: complete, box: box, trimCss: trimCss, guest: guest, call: call };
  if (typeof document === 'undefined' || typeof window === 'undefined') return PURE;

  /* ================================================================ the chrome */

  var api = window.api && window.api.lumenShorts;
  var CTX = null;
  var all = [];
  var keysOn = false;

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
    save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.8h11c.4 0 .7.3.7.7v15.6l-6.2-4-6.2 4V4.5c0-.4.3-.7.7-.7Z"/></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 14.5 12 8.5l6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg>'
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
  function shOf(s) { return s && s._sh ? s._sh : null; }
  function logLine(line) { try { if (api && typeof api.log === 'function') api.log(line); } catch (e) { /* no channel: nothing to log to */ } }
  function disable(b, why) {
    b.disabled = !!why;
    if (why) { b.title = why; b.setAttribute('aria-disabled', 'true'); b.setAttribute('data-why', why); }
    else { b.removeAttribute('title'); b.removeAttribute('aria-disabled'); b.removeAttribute('data-why'); }
  }
  function initial(name) { var t = String(name || '').replace(/^@/, '').trim(); return t ? t.charAt(0).toUpperCase() : ''; }

  /* ---------------------------------------------------------------- slot state */

  /** The view is on for a slot: the one player (not a tile, not the corner, not fullscreen), on a Shorts page. */
  function onFor(s) {
    var L = layerOf();
    return !!(s && s.view && L && L.slots.length === 1 && !s.multi && !s.blocked && isShorts(s.url, s.service) &&
      !(L.el && (L.el.classList.contains('mv-mini') || L.el.classList.contains('wp-fs'))));
  }

  function attach(ctx, s, v) {
    CTX = ctx;
    keys();
    var p = s._sh = { phase: 'loading', read: null, shown: null, shownId: '', applied: false, noRoot: false, why: '', busy: '', seq: 0, timers: [],
      presses: [], steps: [], wheel: null, wheels: 0, confirm: false, save: null, opened: '', logged: '', lastUrl: '', layout: null };
    all.push(s);
    if (all.length > 8) all.shift();
    p.cover = el('div', 'sh-cover');
    p.cover.appendChild(el('span', 'pv-cover-bar'));
    p.coverTxt = el('span', 'sh-cover-txt', 'Loading Shorts…');
    p.cover.appendChild(p.coverTxt);
    p.nav = el('div', 'sh-nav');
    p.prev = iconBtn('sh-navbtn sh-prev', 'up', null, function () { step(s, -1, 'button'); backToPlayer(s); }, 'Previous Short (Up arrow)');
    p.next = iconBtn('sh-navbtn sh-next', 'down', null, function () { step(s, 1, 'button'); backToPlayer(s); }, 'Next Short (Down arrow)');
    p.nav.appendChild(p.prev);
    p.nav.appendChild(p.next);
    p.info = el('div', 'sh-info');
    p.info.setAttribute('aria-live', 'polite');
    s.tile.appendChild(p.cover);
    s.tile.appendChild(p.nav);
    s.tile.appendChild(p.info);
    // The wheel anywhere in the tile outside the page (the margins, the info, the buttons) moves one
    // Short per gesture; the save list scrolls itself when it can.
    s.tile.addEventListener('wheel', function (e) { onWheel(s, e); }, { passive: false });
    // A touch swipe on Lumen's parts: one Short per swipe (on the player, YouTube's own).
    var touch = null;
    s.tile.addEventListener('touchstart', function (e) { if (shOn(s) && e.touches.length === 1) touch = { y: e.touches[0].clientY, t: Date.now() }; }, { passive: true });
    s.tile.addEventListener('touchend', function (e) {
      if (!touch || !shOn(s)) { touch = null; return; }
      var t = e.changedTouches && e.changedTouches[0];
      var dy = t ? touch.y - t.clientY : 0;
      touch = null;
      if (Math.abs(dy) >= 48) step(s, dy > 0 ? 1 : -1, 'touch');
    }, { passive: true });
    v.addEventListener('dom-ready', function () {
      if (s.view !== v) return;
      try {
        var pr = v.insertCSS(trimCss());
        if (pr && pr.catch) pr.catch(function (e) { p.why = 'Lumen couldn’t trim YouTube’s page: ' + ((e && e.message) || e); render(s); });
      } catch (e) { p.why = 'Lumen couldn’t trim YouTube’s page: ' + ((e && e.message) || e); }
      if (isShorts(s.url, s.service)) startReads(s, false);
    });
    v.addEventListener('did-start-navigation', function (e) {
      if (s.view !== v || !e.isMainFrame || e.isSameDocument) return;
      p.applied = false; p.noRoot = false; p.read = null; p.phase = 'loading'; p.save = null; p.confirm = false;
      update(s);
    });
    v.addEventListener('did-navigate-in-page', function (e) {
      if (s.view !== v || !e.isMainFrame) return;
      var u = String(e.url || '');
      if (u === p.lastUrl) return;
      p.lastUrl = u;
      p.save = null; p.confirm = false;
      if (isShorts(u, s.service)) startReads(s, true);
      else update(s);
    });
    v.addEventListener('did-fail-load', function (e) {
      if (s.view !== v || !e.isMainFrame || e.errorCode === -3) return;
      p.phase = online() ? 'failed' : 'offline';
      p.why = 'YouTube’s Shorts page didn’t load: ' + (e.errorDescription || ('error ' + e.errorCode));
      stopReads(s);
      if (isShorts(s.url, s.service)) logLine('the Shorts page failed: ' + (e.errorDescription || ('error ' + e.errorCode)));
      update(s);
    });
    update(s);
  }

  function reuse(ctx, s) {
    var p = shOf(s);
    if (!p) return;
    CTX = ctx;
    p.read = null; p.shown = null; p.shownId = ''; p.phase = 'loading'; p.why = ''; p.save = null; p.confirm = false; p.noRoot = false; p.opened = '';
    update(s);
  }
  function destroy(ctx, s) {
    var p = shOf(s);
    if (!p) return;
    stopReads(s);
    var i = all.indexOf(s);
    if (i >= 0) all.splice(i, 1);
  }
  function sync(ctx, s) {
    CTX = ctx;
    if (!s) return;
    update(s);
    // The bar names the view, not the first Short (the info names the current one).
    var L = layerOf();
    if (shOn(s) && L && L.titleEl && CTX.focused && CTX.focused() === s) L.titleEl.textContent = 'YouTube Shorts';
  }
  function stateActs(ctx, s, kind) {
    var p = shOf(s);
    if (!p || !isShorts(s.url, s.service)) return;
    if (kind === 'failed') { p.phase = online() ? 'failed' : 'offline'; stopReads(s); render(s); }
  }

  function shOn(s) { return !!(s && s.tile && s.tile.classList.contains('sh')); }

  function stopReads(s) {
    var p = shOf(s);
    if (!p) return;
    p.timers.forEach(function (t) { clearTimeout(t); });
    p.timers = [];
  }
  function startReads(s, moved) {
    var p = shOf(s);
    if (!p) return;
    stopReads(s);
    var seq = ++p.seq;
    if (!online()) { p.phase = 'offline'; update(s); return; }
    if (p.phase !== 'failed') p.phase = moved && p.applied ? 'moving' : 'loading';
    var list = moved ? MOVES : READS;
    list.forEach(function (ms, i) { p.timers.push(setTimeout(function () { tick(s, seq, i === list.length - 1); }, ms)); });
    update(s);
  }

  function tick(s, seq, last) {
    var p = shOf(s);
    if (!p || p.seq !== seq || !s.view) return;
    var v = s.view;
    var on = onFor(s);
    js(v, call('tick', [on])).then(function (r) {
      if (s.view !== v || p.seq !== seq) return;
      if (!r || !r.ok) throw new Error('no answer from the page');
      p.read = r;
      p.applied = !!r.applied;
      var cur = idOf(s.url, s.service);
      // A grid (a channel's Shorts, Subscriptions' Shorts, the feed before YouTube picks): its first Short.
      if ((r.kind === 'grid' || (r.kind === 'feed' && !r.reels)) && on) {
        if (r.links && p.opened !== r.url) {
          p.opened = r.url;
          js(v, call('openFirst', [])).then(function (o) { if (o && !o.ok && s.view === v) { p.why = 'YouTube’s page has ' + o.reason; render(s); } }, function () { /* the next tick says */ });
        } else if (last && !r.links) {
          p.phase = 'empty';
          p.why = r.kind === 'grid' ? 'YouTube’s page has no Shorts here.' : 'YouTube didn’t pick a Short to start with.';
          logLine('no Shorts to open: ' + r.kind);
        }
        update(s);
        return;
      }
      if (on && !r.applied && last && r.kind === 'short') {
        p.noRoot = true;
        p.why = 'Lumen couldn’t find YouTube’s Shorts player on this page, so the whole page shows.';
        if (CTX && CTX.note) CTX.note(p.why);
        logLine('no Shorts player found on the page');
      }
      var f = follow(cur, r, p.shownId);
      if (f.fresh) { p.shown = r; p.shownId = f.id; }
      var done = f.fresh && complete(r) && (!on || r.applied);
      if (done) { p.phase = 'ready'; stopReads(s); }
      else if (last) p.phase = !f.fresh ? 'unread' : (r.title || (r.channel && r.channel.name)) ? 'partial' : 'unread';
      if (on && p.logged !== s.id + ':' + (p.applied ? 'on' : 'off') && p.applied) { p.logged = s.id + ':on'; logLine('opened: ' + ((route(s.url, s.service) || {}).kind || 'short')); }
      update(s);
    }).catch(function (e) {
      if (s.view !== v || p.seq !== seq) return;
      if (last) { p.phase = online() ? 'unread' : 'offline'; p.why = 'Lumen couldn’t read YouTube’s page: ' + ((e && e.message) || e); update(s); }
    });
  }

  /** Classes, the trim, the layout and the info, from the slot's state. */
  function update(s) {
    var p = shOf(s), L = layerOf();
    if (!p || !L) return;
    var on = onFor(s);
    var boxed = on && !p.noRoot;
    s.tile.classList.toggle('sh', boxed);
    s.tile.classList.toggle('sh-wait', boxed && !p.applied && p.phase !== 'failed' && p.phase !== 'offline');
    if (L.el && (L.slots[L.focus] === s || L.slots.length === 1)) L.el.classList.toggle('sh-on', boxed);
    layoutBox(s);
    if (s.view && p.applied && !on) {
      var v = s.view;
      js(v, call('apply', [false])).then(function () { if (s.view === v) { p.applied = false; render(s); } }, function () { /* the next load says */ });
    }
    render(s);
  }

  var ro = null;
  function layoutBox(s) {
    var L = layerOf();
    if (!L || !s || !s.view) return;
    var p = shOf(s);
    if (!shOn(s) || !L.grid) {
      if (p && p.layout) {
        ['--sh-x', '--sh-y', '--sh-w', '--sh-h'].forEach(function (k) { s.tile.style.removeProperty(k); });
        s.tile.removeAttribute('data-sh');
        p.layout = null;
      }
      return;
    }
    if (!ro && window.ResizeObserver) { ro = new ResizeObserver(function () { all.forEach(function (x) { if (shOn(x)) layoutBox(x); }); }); ro.observe(L.grid); }
    var r = s.tile.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) return;
    var b = box(r.width, r.height);
    p.layout = b;
    // The webview's box as px variables on the tile (watch-shorts.css places it with them): the playback
    // view clears the webview's own inline size on any tile that is not its own, so Lumen never sets it.
    var ts = s.tile.style;
    ts.setProperty('--sh-x', b.x + 'px'); ts.setProperty('--sh-y', b.y + 'px'); ts.setProperty('--sh-w', b.vw + 'px'); ts.setProperty('--sh-h', b.vh + 'px');
    s.tile.setAttribute('data-sh', b.mode);
    var cs = p.cover.style; cs.left = b.x + 'px'; cs.top = b.y + 'px'; cs.width = b.vw + 'px'; cs.height = b.vh + 'px';
    var ns = p.nav.style; ns.left = b.navX + 'px'; ns.top = b.navY + 'px'; ns.height = b.vh + 'px';
    var is = p.info.style; is.left = b.infoX + 'px'; is.top = b.infoY + 'px'; is.width = b.infoW + 'px'; is.maxHeight = b.infoH + 'px';
  }

  /* ---------------------------------------------------------------- moving */

  function onWheel(s, e) {
    if (!shOn(s)) return;
    var p = shOf(s);
    // The save list scrolls itself while it can; everything else is a Short move.
    var list = e.target && e.target.closest ? e.target.closest('.pv-savelist') : null;
    if (list && list.scrollHeight > list.clientHeight + 2) {
      var atTop = list.scrollTop <= 0, atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
      if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atEnd)) return;
    }
    e.preventDefault();
    p.wheels++;
    var g = gesture(p.wheel, { dy: e.deltaY, dx: e.deltaX, mode: e.deltaMode, t: e.timeStamp || Date.now() });
    p.wheel = g.st;
    if (g.step) step(s, g.step, 'wheel');
  }

  /** One move with YouTube's own navigation in the page. */
  function step(s, dir, how) {
    var p = shOf(s);
    if (!p || !s.view || !shOn(s)) return false;
    var v = s.view;
    var rec = { dir: dir, how: how, at: Date.now(), ok: null, via: '', reason: '' };
    p.steps.push(rec);
    if (p.steps.length > 50) p.steps.shift();
    js(v, call('step', [dir])).then(function (r) {
      if (s.view !== v) return;
      rec.ok = !!(r && r.ok); rec.via = (r && r.how) || ''; rec.reason = (r && r.reason) || '';
      if (!rec.ok) { p.why = rec.reason || 'YouTube’s page didn’t move'; render(s); return; }
      if (p.why && /first Short|last Short|didn’t move/.test(p.why)) p.why = '';
      // The address changes with YouTube's own move (did-navigate-in-page reads the new Short); read anyway.
      startReads(s, true);
    }, function (e) { if (s.view === v) { rec.ok = false; rec.reason = (e && e.message) || String(e); p.why = 'YouTube’s page didn’t answer: ' + rec.reason; render(s); } });
    return true;
  }

  /** Up/Down in the chrome (focus on Lumen's own parts): one Short. In the page they are YouTube's keys. */
  function keys() {
    if (keysOn) return;
    keysOn = true;
    document.addEventListener('keydown', function (e) {
      var L = layerOf();
      if (!L || !L.open || e.defaultPrevented) return;
      var s = CTX && CTX.focused ? CTX.focused() : null;
      if (!shOn(s)) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'WEBVIEW' || t.isContentEditable)) return;
      if (t && t.closest && t.closest('.pv-savelist') && t.closest('.pv-savelist').contains(t)) return;
      if (t && t !== document.body && L.el && !L.el.contains(t)) return;
      var d = keyStep(e);
      if (!d) return;
      e.preventDefault();
      step(s, d, 'key');
    });
  }

  function backToPlayer(s) { var p = shOf(s); if (s && s.view && !(p && p.save)) { try { s.view.focus(); } catch (e) { /* gone */ } } }

  /* ---------------------------------------------------------------- presses */

  /** One press of YouTube's own button, on his click: never twice, never by itself. */
  function press(s, kind, arg) {
    var p = shOf(s);
    if (!p || !s.view || p.busy) return false;
    var v = s.view;
    var forId = p.shownId;
    p.busy = kind;
    p.why = '';
    var rec = { kind: kind, arg: arg === undefined ? null : arg, at: Date.now(), ok: null, reason: '', id: forId };
    p.presses.push(rec);
    render(s);
    js(v, call('press', [kind, arg === undefined ? null : arg])).then(function (r) {
      if (s.view !== v) return;
      p.busy = '';
      rec.ok = !!(r && r.ok);
      rec.reason = (r && r.reason) || '';
      if (!r || !r.ok) p.why = (r && r.reason) ? r.reason.charAt(0).toUpperCase() + r.reason.slice(1) : 'YouTube’s page didn’t answer';
      else if (r.changed === false && kind !== 'save-open' && kind !== 'save-close') p.why = 'YouTube didn’t confirm it yet: the state shown is what its page says';
      if (kind === 'save-open' || kind === 'save-toggle') p.save = r && r.ok ? { list: r.list || [] } : null;
      if (kind === 'save-close') p.save = null;
      if (kind === 'unsubscribe') p.confirm = false;
      return js(v, call('read', [])).then(function (rr) {
        if (s.view !== v || !rr || !rr.ok) { render(s); return; }
        p.read = rr;
        var f = follow(idOf(s.url, s.service), rr, p.shownId);
        if (f.fresh) { p.shown = rr; p.shownId = f.id; }
        render(s);
      });
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

  /* ---------------------------------------------------------------- the info */

  function render(s) {
    var p = shOf(s);
    if (!p || !p.info) return;
    var on = shOn(s);
    var phase = !online() ? 'offline' : p.phase;
    p.cover.hidden = !(on && !p.applied && (phase === 'loading' || phase === 'moving' || phase === 'empty'));
    p.coverTxt.textContent = phase === 'empty' ? (p.why || 'No Shorts here') : (route(s.url, s.service) || {}).kind === 'channel' ? 'Opening the channel’s Shorts…' : 'Loading Shorts…';
    p.cover.classList.toggle('is-empty', phase === 'empty');
    p.nav.hidden = !on;
    p.info.hidden = !on;
    if (!on) return;
    var cur = idOf(s.url, s.service);
    var f = follow(cur, p.shown, p.shownId);
    // Only the current Short's read is ever shown; while the next one is read, its own skeleton.
    var r = f.fresh ? p.shown : null;
    var m = PV && typeof PV.model === 'function' ? PV.model('youtube', r, null, '', { moved: true }) : fallbackModel(r);
    if (!m.title && r && r.pageTitle && PV && PV.cleanPageTitle) m.title = PV.cleanPageTitle(String(r.pageTitle).replace(/\s*#shorts\b/i, ''), 'youtube');
    var showPhase = phase === 'ready' ? 'ready' : (!r && phase !== 'failed' && phase !== 'offline' && phase !== 'unread') ? 'loading' : phase;
    var info = p.info;
    info.setAttribute('data-phase', showPhase);
    info.setAttribute('data-short', f.fresh ? f.id : '');
    info.replaceChildren();
    var head = el('div', 'sh-head');
    head.appendChild(el('span', 'sh-kicker', 'Shorts'));
    info.appendChild(head);
    var h = el('h1', 'pv-title sh-title');
    if (m.title) h.textContent = m.title;
    else { h.classList.add('pv-skel'); h.textContent = showPhase === 'loading' || showPhase === 'moving' ?'Loading the Short…' : 'Untitled Short'; }
    info.appendChild(h);
    renderChannel(s, p, m, showPhase, info);
    renderActs(s, p, m, showPhase, info);
    renderLists(s, p, m, info);
    renderNote(s, p, m, showPhase, info, r);
    info.appendChild(el('p', 'sh-hint', 'Scroll, swipe or press ↑ ↓ for the next Short'));
    // Lumen's Previous / Next: off only where YouTube says there is nowhere to go.
    var rd = p.read && follow(cur, p.read, '').fresh ? p.read : r;
    var dead = phase === 'failed' || phase === 'offline';
    disable(p.prev, dead ? 'YouTube’s page isn’t there' : rd && rd.canPrev === false ? 'This is the first Short' : '');
    disable(p.next, dead ? 'YouTube’s page isn’t there' : rd && rd.canNext === false ? 'This is the last Short YouTube has here' : '');
  }
  function fallbackModel(r) {
    var out = { title: (r && r.title) || '', channel: r && r.channel || null, signedIn: r ? r.signedIn : null, buttons: {}, missing: [] };
    ['like', 'dislike', 'sub', 'save'].forEach(function (k) { var b = r && r[k]; out.buttons[k] = b && b.found ? b : { found: false }; if (r && !(b && b.found)) out.missing.push(k); });
    return out;
  }
  function whyOff(m, key, phase) {
    if (phase === 'moving') phase = 'loading';
    if (PV && typeof PV.whyOff === 'function') return PV.whyOff(m, key, phase).replace('on this page', 'on this Short');
    return m.buttons[key] && m.buttons[key].found ? '' : 'Not on this Short';
  }

  function renderChannel(s, p, m, phase, info) {
    var chan = el('div', 'pv-chan sh-chan');
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
    chan.appendChild(ct);
    var sb = m.buttons.sub;
    var subOn = !!(sb && sb.found && sb.on);
    var name = (m.channel && m.channel.name) || 'this channel';
    var sub = button('pv-sub sh-sub' + (subOn ? ' is-on' : ''), p.busy === 'subscribe' || p.busy === 'unsubscribe' ? (subOn ? 'Unsubscribing…' : 'Subscribing…') : (subOn ? 'Subscribed' : 'Subscribe'), function () {
      if (subOn) { p.confirm = true; render(s); var c = info.querySelector('.pv-confirm .pv-danger'); if (c) c.focus(); return; }
      press(s, 'subscribe');
      backToPlayer(s);
    }, subOn ? 'Subscribed to ' + name + ': unsubscribe' : 'Subscribe to ' + name);
    sub.setAttribute('aria-pressed', subOn ? 'true' : 'false');
    disable(sub, whyOff(m, 'sub', phase) || (p.busy ? 'Waiting for YouTube…' : ''));
    chan.appendChild(sub);
    info.appendChild(chan);
  }

  function renderActs(s, p, m, phase, info) {
    var acts = el('div', 'pv-acts sh-acts');
    var pair = el('div', 'pv-pair');
    var lk = m.buttons.like, dk = m.buttons.dislike;
    var like = iconBtn('pv-like' + (lk.on ? ' is-on' : ''), 'like', lk.found ? (lk.count && !/^like$/i.test(lk.count) ? lk.count : 'Like') : 'Like',
      function () { press(s, 'like'); backToPlayer(s); }, lk.on ? 'You like this Short: remove the like' : 'Like this Short');
    like.setAttribute('aria-pressed', lk.on ? 'true' : 'false');
    disable(like, whyOff(m, 'like', phase) || (p.busy ? 'Waiting for YouTube…' : ''));
    var dis = iconBtn('pv-dislike' + (dk.on ? ' is-on' : ''), 'like', null, function () { press(s, 'dislike'); backToPlayer(s); }, dk.on ? 'You dislike this Short: remove the dislike' : 'Dislike this Short');
    dis.setAttribute('aria-pressed', dk.on ? 'true' : 'false');
    disable(dis, whyOff(m, 'dislike', phase) || (p.busy ? 'Waiting for YouTube…' : ''));
    pair.appendChild(like);
    pair.appendChild(el('span', 'pv-pair-sep'));
    pair.appendChild(dis);
    acts.appendChild(pair);
    var save = iconBtn('pv-save' + (p.save ? ' is-open' : ''), 'save', p.busy === 'save-open' ? 'Opening…' : 'Save', function () {
      if (p.save) { press(s, 'save-close'); return; }
      press(s, 'save-open');
    }, 'Save this Short to a playlist');
    save.setAttribute('aria-expanded', p.save ? 'true' : 'false');
    disable(save, whyOff(m, 'save', phase) || (p.busy && p.busy.indexOf('save') !== 0 ? 'Waiting for YouTube…' : ''));
    acts.appendChild(save);
    info.appendChild(acts);
  }

  function renderLists(s, p, m, info) {
    var subOn = !!(m.buttons.sub && m.buttons.sub.found && m.buttons.sub.on);
    if (p.confirm && subOn) {
      var cf = el('div', 'pv-confirm');
      cf.setAttribute('role', 'alertdialog');
      cf.appendChild(el('span', 'pv-confirm-txt', 'Unsubscribe from ' + ((m.channel && m.channel.name) || 'this channel') + '?'));
      cf.appendChild(button('pv-danger', 'Unsubscribe', function () { press(s, 'unsubscribe'); backToPlayer(s); }));
      cf.appendChild(button('pv-ghost', 'Cancel', function () { p.confirm = false; render(s); backToPlayer(s); }));
      info.appendChild(cf);
    }
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
  }

  function note(info, text, kind) {
    if (!text) return;
    var n = el('p', 'pv-why' + (kind ? ' pv-why-' + kind : ''));
    n.setAttribute('role', 'status');
    n.appendChild(el('span', 'pv-why-txt', text));
    info.appendChild(n);
  }
  function renderNote(s, p, m, phase, info, r) {
    if (phase === 'offline') note(info, 'You’re offline. Shorts load again when you’re back online.', 'warn');
    else if (phase === 'failed') note(info, p.why || 'YouTube’s Shorts page didn’t load.', 'err');
    else if (phase === 'empty') note(info, p.why || 'No Shorts here.', 'warn');
    else if (m.signedIn === false) note(info, 'You’re signed out of YouTube here: Like, Dislike, Subscribe and Save need you signed in (Lumen’s YouTube row has Sign in).', 'warn');
    else if (p.why) note(info, p.why, /couldn’t|didn’t|isn’t|not |first Short|last Short/i.test(p.why) ? 'warn' : '');
    else if (phase === 'unread') note(info, 'Lumen couldn’t read this Short’s details from YouTube’s page.', 'warn');
    else if (phase !== 'loading' && phase !== 'moving' && r && m.missing && m.missing.length) {
      var words = { like: 'Like', dislike: 'Dislike', sub: 'Subscribe', save: 'Save' };
      note(info, 'YouTube’s ' + m.missing.map(function (k) { return words[k]; }).join(', ') + (m.missing.length > 1 ? ' buttons aren’t' : ' button isn’t') + ' on this Short, so ' + (m.missing.length > 1 ? 'they’re' : 'it’s') + ' off here.', 'warn');
    }
    if (r && r.ad) note(info, 'This is an ad on YouTube: its own Sponsored panel stays on the player.', '');
  }

  window.addEventListener('offline', function () { all.forEach(function (s) { render(s); }); });
  window.addEventListener('online', function () { all.forEach(function (s) { var p = shOf(s); if (p && p.phase !== 'ready' && isShorts(s.url, s.service)) startReads(s, false); else render(s); }); });

  /* ---------------------------------------------------------------- e2e seam */

  function rect(n) { if (!n || !n.getBoundingClientRect) return null; var r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
  function stateOf(s) {
    var p = shOf(s);
    if (!p) return null;
    var m = p.info && !p.info.hidden ? p.info : null;
    var q = function (sel) { return m ? m.querySelector(sel) : null; };
    var b = function (n) { return n ? { text: n.textContent.trim(), disabled: n.disabled, pressed: n.getAttribute('aria-pressed'), why: n.getAttribute('data-why') || '' } : null; };
    return {
      id: s.id, url: s.url, route: route(s.url, s.service), cur: idOf(s.url, s.service), on: shOn(s), mode: s.tile.getAttribute('data-sh') || '', phase: p.phase,
      applied: p.applied, noRoot: p.noRoot, why: p.why, busy: p.busy, presses: p.presses.slice(), steps: p.steps.slice(), wheels: p.wheels, confirm: p.confirm, save: p.save,
      shownId: p.shownId, infoShort: m ? m.getAttribute('data-short') : '', view: rect(s.view), tile: rect(s.tile), info: m ? rect(m) : null, nav: p.nav.hidden ? null : rect(p.nav),
      cover: !p.cover.hidden, title: q('.pv-title') ? q('.pv-title').textContent : '', channel: q('.pv-chan-name') ? q('.pv-chan-name').textContent : '',
      note: q('.pv-why') ? q('.pv-why').textContent : '', like: b(q('.pv-like')), dislike: b(q('.pv-dislike')), sub: b(q('.pv-sub')), savebtn: b(q('.pv-save')),
      prev: b(p.prev), next: b(p.next), read: p.read
    };
  }

  return Object.assign({}, PURE, {
    // watch-player.js X() hooks
    attach: attach, reuse: reuse, destroy: destroy, sync: sync, stateActs: stateActs,
    // Lumen's play bar (watch-playerbar.js) hands Up/Down it got on a Short here: one Short, the same move.
    move: function (s, dir, how) { return shOn(s) ? step(s, dir > 0 ? 1 : -1, how || 'key') : false; },
    _step: function (dir) { var L = layerOf(); var s = L && L.slots[L.focus]; return s ? step(s, dir, 'test') : false; },
    _state: function () { var L = layerOf(); return { slots: all.filter(function (s) { return !!s.view; }).map(stateOf), layerOn: !!(L && L.el && L.el.classList.contains('sh-on')) }; }
  });
});
