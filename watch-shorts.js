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
       Dislike, Save, Comments and Share. Subscribe, Like, Dislike and
       Save are YouTube's OWN buttons in the page, pressed once per
       click, only on his click, the state read back. The model and the
       reasons are watch-playview.js's (model, whyOff), so the two
       views say the same things.
     - Comments opens Lumen's own comments (watch-comments.js, the
       renderer under a normal video) in the info, for the Short the
       page's address says: a move in the feed brings the next Short's,
       never the last one's. Share copies the Short's link
       (youtube.com/shorts/<id>) for the Short the info names, and says
       so, or says why it couldn't.
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
  // The Short's own shape (box(), shape()): clamped to 9:16 ... 1:1. Read from the page until it is the current
  // Short's (every EVERY ms, for POLL ms at most); a new shape eases the box over EASE ms (watch-shorts.css .sh-ease).
  var ASP = { TALL: 9 / 16, WIDE: 1, EVERY: 120, POLL: 4000, EASE: 120 };

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
  /** The link Share copies: YouTube's own address for the Short (never the page's own host, which a test may rebase); '' for no id. */
  function shortUrl(id) { return ID_RE.test(String(id || '')) ? ORIGIN + '/shorts/' + id : ''; }

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
   * A channel's initial, for its avatar while it has no picture: its first character as he sees it (a whole emoji,
   * flag or accented letter, never half of a surrogate pair, which drew as a broken glyph), upper-cased.
   */
  function initial(name) {
    var t = String(name || '').replace(/^@/, '').trim();
    if (!t) return '';
    var first = '';
    try {
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        var it = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t)[Symbol.iterator]().next();
        first = it.value ? it.value.segment : '';
      }
    } catch (e) { first = ''; }
    if (!first) first = Array.from(t)[0] || '';
    return first.toUpperCase();
  }

  /** A Short's shape (width / height) as the box uses it: its own, clamped to 9:16 ... 1:1; 9:16 while unknown. */
  function shape(aspect) {
    var a = Number(aspect);
    if (!(a > 0) || !isFinite(a)) return ASP.TALL;
    return Math.min(ASP.WIDE, Math.max(ASP.TALL, a));
  }

  /**
   * Where everything goes in the tile (gw x gh, the layer's grid): the player as tall as the tile
   * allows, centred, as wide as the Short's own shape (aspect: width / height, clamped to 9:16 ...
   * 1:1; 9:16 while unknown); Lumen's Next/Previous beside it; the info BESIDE when a 9:16 player
   * leaves room for it on both sides (so the player stays centred), else BELOW (the player shorter,
   * so it fits). The mode never depends on the shape (a Short's shape arriving never moves the info
   * from beside to below): a wider Short that doesn't fit beside at full height gets shorter instead.
   */
  function box(gw, gh, aspect) {
    var W = Math.max(0, Math.floor(gw)), Hh = Math.max(0, Math.floor(gh));
    var a = shape(aspect);
    var vh = Math.max(160, Hh - 2 * LAY.PAD);
    var vw = Math.round(vh * ASP.TALL);
    var side = LAY.GAP + LAY.NAV + LAY.GAP + LAY.INFO_W;
    if (W >= vw + 2 * side) {
      vw = Math.round(vh * a);
      var room = W - 2 * side;
      if (vw > room) { vw = room; vh = Math.round(vw / a); }
      var x = Math.round((W - vw) / 2);
      var infoX = x + vw + LAY.GAP + LAY.NAV + LAY.GAP;
      return { mode: 'beside', vw: vw, vh: vh, x: x, y: LAY.PAD, navX: x + vw + LAY.GAP, navY: LAY.PAD,
        infoX: infoX, infoY: LAY.PAD, infoW: Math.max(LAY.INFO_W, Math.min(LAY.INFO_MAX, W - infoX - 24)), infoH: vh };
    }
    vh = Math.max(160, Hh - 2 * LAY.PAD - LAY.GAP - LAY.INFO_H);
    vw = Math.round(vh * a);
    var maxW = W - 2 * (LAY.GAP + LAY.NAV + LAY.GAP);
    if (vw > maxW && maxW > 90) { vw = maxW; vh = Math.round(vw / a); }
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
      VEIL.map(function (s) { return 'html[data-lumen-sh] ' + s + ':not(:has(' + AD + '))'; }).join(',\n') + ' { visibility: hidden !important; pointer-events: none !important; position: absolute !important; }',
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
    var V = 3;
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
      // Written only when they change: the same value written again is still a mutation, and the read's own
      // observer (until()) took each one for YouTube's app changing, so a wait checked itself every 30 ms.
      if (fresh) f.el.setAttribute('data-lumen-sh-root', '');
      if (!was) html.setAttribute('data-lumen-sh', '');
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
        reels: reels().length, links: k === 'grid' || k === 'feed' ? QA('a[href*="/shorts/"]').length : 0, ad: false, ready: document.readyState };
      out.asp = aspect();
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
    // The current Short's own shape. Its <video>'s once its metadata is in (the picture itself); before that,
    // YouTube's player data for THIS Short (#shorts-player's own getVideoData()/getPlayerResponse()), when the page
    // has it. fresh: it is this Short's, not the one before (YouTube's one player still holds the last Short's
    // video for a moment after a move); the chrome keeps asking until it is.
    var asp = { url: '', id: '' };
    function videoOf(r) { return Q('#shorts-player video', r) || Q('video.html5-main-video', r) || Q('video', r); }
    function marked() { asp.url = String(this.currentSrc || ''); asp.id = idOf(location.pathname); }
    function playerId(r) {
      try {
        var pl = Q('#shorts-player', r) || Q('.html5-video-player', r);
        var vd = pl && typeof pl.getVideoData === 'function' ? pl.getVideoData() : null;
        return vd && vd.video_id ? String(vd.video_id) : '';
      } catch (e) { return ''; }
    }
    function playerShape(r, id) {
      try {
        var pl = Q('#shorts-player', r) || Q('.html5-video-player', r);
        if (!id || !pl || typeof pl.getVideoData !== 'function' || typeof pl.getPlayerResponse !== 'function') return null;
        var vd = pl.getVideoData();
        if (!vd || vd.video_id !== id) return null;
        var sd = (pl.getPlayerResponse() || {}).streamingData || {};
        var f = (sd.adaptiveFormats || []).concat(sd.formats || []).filter(function (x) { return x && x.width > 0 && x.height > 0; })[0];
        return f ? { w: f.width, h: f.height } : null;
      } catch (e) { return null; }
    }
    function aspect() {
      var id = kind() === 'short' ? idOf(location.pathname) : '';
      var r = active();
      var v = r ? videoOf(r) : null;
      if (v && !v.__lumenAsp) { v.__lumenAsp = 1; v.addEventListener('loadedmetadata', marked); v.addEventListener('resize', marked); }
      var has = !!(v && v.readyState >= 1 && v.videoWidth > 0 && v.videoHeight > 0);
      if (has && String(v.currentSrc || '') !== asp.url) { asp.url = String(v.currentSrc || ''); asp.id = id; }
      if (has && asp.id === id) return { w: v.videoWidth, h: v.videoHeight, from: 'video', fresh: true };
      var pd = playerShape(r, id);
      if (pd) return { w: pd.w, h: pd.h, from: 'player', fresh: true };
      if (has) return { w: v.videoWidth, h: v.videoHeight, from: 'video', fresh: false };
      return { w: 0, h: 0, from: '', fresh: false };
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

    /** YouTube's own Save list for the current Short: its Save button, else its menu's Save. */
    function openSave() {
      var r = active();
      if (!r) return Promise.resolve({ ok: false, reason: 'no Short is on YouTube’s page' });
      var list = function () { var l = saveOpts(); return l.length ? l : null; };
      var shown = function (l) { return l ? { ok: true, list: l.map(function (o) { return { name: o.name, on: o.on }; }) } : { ok: false, reason: 'YouTube’s Save list didn’t open' }; };
      var b = saveBtn(r);
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
    /** One press of YouTube's own button (kind) in the current Short, on his click. */
    function press(kind, arg, forId) {
      var r = active();
      if (!r) return Promise.resolve({ ok: false, reason: 'no Short is on YouTube’s page' });
      // The Short Lumen's info names (forId) must still be the page's own: its address and, when YouTube's player
      // says, the video in its one player (today's page reuses one renderer for every Short).
      if (forId) {
        var at = idOf(location.pathname), pid = playerId(r);
        if ((at && at !== forId) || (pid && pid !== forId)) return Promise.resolve({ ok: false, reason: 'the Short changed as you clicked, so nothing was pressed: press again' });
      }
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
        // A list still open from before (another Short's, left open by a move) is closed first, so the list read
        // back is the one YouTube opens for THIS Short, never the last one's ticks.
        var stale = Q('ytd-add-to-playlist-renderer #close-button button') || Q('ytd-add-to-playlist-renderer #close-button');
        if (saveOpts().length) {
          if (stale) stale.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
        }
        return wait(function () { return saveOpts().length ? 0 : 1; }, 1500).then(function (closed) {
          if (!closed) return { ok: false, reason: 'YouTube’s Save list from before didn’t close' };
          return openSave();
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
      // The event's own time (when the device sent it), so a page busy with the move never splits one gesture in two.
      var now = e.timeStamp > 0 ? performance.timeOrigin + e.timeStamp : Date.now();
      var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
      if (now - wg.last > 220) { wg.acc = 0; wg.moved = false; }
      wg.last = now;
      if (wg.moved || now < wg.lock) return;
      wg.acc += dy;
      if (Math.abs(wg.acc) >= 24) {
        wg.moved = true; wg.lock = now + 380;
        step(wg.acc > 0 ? 1 : -1);   // the one move (Lumen's chrome leaves a wheel over the page to the page: onWheel)
      }
    }
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });

    /* --- the read, the moment the page has it (until()) ---- */
    // The chrome used to ask at fixed times (250, 900, 2000 ms after a load; 150, 500, 1100 ms after a move): the
    // cover stayed over a page that was ready to trim until the next ask, and a moved Short's info waited at least
    // 150 ms for its first. Now it asks ONCE and the page answers as soon as its read says something the chrome
    // hasn't seen (sig): YouTube's app changing under it wakes the check (a MutationObserver, its checks 30 ms apart
    // at most), and the ask's own time limit answers anyway (final). One wait at a time: a newer ask answers the
    // older one at once (the chrome drops that by its seq), and stop() ends it, so no observer outlives its read.
    function now(on) { var a = on === null ? { on: document.documentElement.hasAttribute('data-lumen-sh') } : apply(on); if (a.on) watchActive(); var x = read(); x.applied = a.on; x.how = a.how || ''; return x; }
    function sigOf(x) {
      var b = function (k) { var o = x[k] || {}; return o.found ? (o.on ? 2 : 1) + ':' + (o.count || '') : 0; };
      return [x.kind, x.videoId, x.applied ? 1 : 0, x.root ? 1 : 0, x.reels > 0 ? 1 : 0, x.links > 0 ? 1 : 0, x.title, x.channel ? x.channel.name + '|' + (x.channel.avatar ? 1 : 0) : '',
        b('like'), b('dislike'), b('sub'), b('save'), x.canPrev, x.canNext, x.ad ? 1 : 0, x.signedIn, x.ready === 'loading' ? 0 : 1].join('\u0001');
    }
    // A move in place: YouTube's address names the next Short a moment before its one renderer and its one player
    // have the Short's own title, channel and buttons. Read in that moment, the info named the new Short with the
    // last one's title. So for LAG ms after the address first names a Short, a read whose player still holds
    // another video, or whose title and channel are still those last answered for another Short, is not this
    // Short's yet (videoId ''): the chrome keeps its skeleton. After LAG it is taken as it is (an ad's own player,
    // two Shorts of one series), so a page that never changes them still shows what it has.
    //
    // The player's own word ends the wait early (r64, measured on real YouTube): the page's #shorts-player had the
    // new Short (getVideoData() on its id) at a median 263 ms after a move, the active renderer's title at 264 ms,
    // but the info drew the right title at a median 738 ms: the renderer's OWN player lookup (playerId(r)) stayed on
    // the last Short about 470 ms longer, and held the read back the whole time. So a read is released as soon as
    // one of the page's players (playerData()) is on the address's Short with a title of its own that is not the
    // last Short's, AND the renderer has a title that is not the last Short's ('player-data'): the player vouches
    // for the address, the renderer's text is the one shown. The player's title itself is never shown: a first
    // build that showed it while the renderer still had the last Short's text drew an ad's internal asset name
    // ("V3 10s 9x16 ...") for 1.5 s on real YouTube, where the renderer then had no title at all. A renderer still
    // on the last Short's title, or with none, waits under the old rule (LAG, then 'cap'), so the last Short's
    // title is never shown, and a player whose title is the last one's releases nothing (two Shorts of one series
    // wait out LAG as before).
    // Where the wait went is in every read (x.gate) and the chrome's _state(): why it was released ('player-data',
    // 'renderer': the page's own read was this Short's, 'cap': LAG ran out with the page still looking like the
    // last Short) or 'held', and lag: the ms from the read first seeing the address on this Short to the release
    // (or until now, while held).
    var LAG = 1500;
    var seen = { id: '', at: 0, last: null, why: '', lag: 0 }, told = { id: '', title: '', chan: '' };
    function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
    /**
     * The address's Short as one of the page's players has it: { title } from the first player whose getVideoData()
     * is on id (today's pinned #reel-overlay-container player, the active renderer's own, the page's first
     * #shorts-player), from its player response's videoDetails when getVideoData() has no title.
     * null: no player is on id yet (or the page has none Lumen can ask).
     */
    function playerData(r, id) {
      if (!id) return null;
      var cands = [Q('#reel-overlay-container #shorts-player'), r ? Q('#shorts-player', r) : null, Q('#shorts-player'), r ? Q('.html5-video-player', r) : null];
      var asked = [];
      for (var i = 0; i < cands.length; i++) {
        var pl = cands[i];
        if (!pl || asked.indexOf(pl) >= 0) continue;
        asked.push(pl);
        try {
          if (typeof pl.getVideoData !== 'function') continue;
          var vd = pl.getVideoData() || {};
          if (String(vd.video_id || '') !== id) continue;
          var title = clean(vd.title);
          if (!title && typeof pl.getPlayerResponse === 'function') {
            var d = (pl.getPlayerResponse() || {}).videoDetails || {};
            if (d.videoId === id) title = clean(d.title);
          }
          return { title: title };
        } catch (e) { /* a player mid-swap threw: the next one is asked, and the old rule still stands */ }
      }
      return null;
    }
    function current(x) {
      var at = x.videoId;
      if (!at) return x;
      var t = Date.now();
      // last: the Short answered before this one (never this one itself: A, B, back to A compares nothing).
      if (seen.id !== at) seen = { id: at, at: t, last: told.id && told.id !== at ? { title: told.title, chan: told.chan } : null, why: '', lag: 0 };
      var L = seen.last;
      var r = active(), pid = r ? playerId(r) : '';
      var chan = x.channel ? x.channel.name : '';
      var dom = x.title;
      var pd = playerData(r, at);
      var pdNew = !!(pd && pd.title && !(L && pd.title === L.title));
      // The player vouches for the address and the renderer has moved on from the last Short: released.
      var vouched = pdNew && !!dom && !(L && dom === L.title);
      var held = !!((pid && pid !== at) || (L && !!dom && dom === L.title && chan === L.chan));
      if (!vouched && held && t - seen.at < LAG) {
        x.lag = pid && pid !== at ? 'player' : 'title';
        x.gate = { why: 'held', lag: t - seen.at, player: pd ? (pd.title ? (pdNew ? 'new-title' : 'last-title') : 'no-title') : 'none' };
        x.videoId = '';
        return x;
      }
      if (!seen.why) { seen.why = vouched ? 'player-data' : held ? 'cap' : 'renderer'; seen.lag = t - seen.at; }
      x.gate = { why: seen.why, lag: seen.lag };
      if (x.title) { told.id = at; told.title = x.title; told.chan = chan; }
      return x;
    }
    var wt = null;
    function stop() { if (wt) wt.end(null); return { ok: true }; }
    function until(on, sig, ms) {
      if (wt) wt.end(null);
      return new Promise(function (ok) {
        var t0 = Date.now(), me = {}, timer = 0, chk = 0, lagT = 0, obs = null;
        var answer = function (x, final) { x.sig = sigOf(x); x.final = !!final; x.waited = Date.now() - t0; return x; };
        var x0 = answer(current(now(on)), !(ms > 0));
        if (x0.sig !== sig || x0.final || !window.MutationObserver) { ok(x0); return; }
        var onRs = function () { if (!chk) chk = setTimeout(check, 0); };   // the HTML parsed: no mutation need say so
        var close = function () { if (wt === me) wt = null; clearTimeout(timer); clearTimeout(chk); clearTimeout(lagT); timer = chk = lagT = 0; if (obs) obs.disconnect(); obs = null; try { document.removeEventListener('readystatechange', onRs); } catch (e) { /* no document events */ } };
        // stopped (stop(), a newer ask): answered without touching the trim; the time limit: read once more.
        me.end = function (final) { if (wt !== me) return; close(); ok(answer(current(now(final ? on : null)), !!final)); };
        var check = function () {
          chk = 0;
          if (wt !== me) return;
          var x = current(now(on));
          var s1 = sigOf(x);
          if (s1 !== sig) { close(); ok(answer(x, false)); return; }
          if (x.lag) lagged(x);
        };
        // Still lagging behind the address: looked at again apart from YouTube's mutations (its one player
        // changes video without one), every 100 ms and once more as the lag runs out.
        var lagged = function (x) { clearTimeout(lagT); lagT = setTimeout(function () { lagT = 0; check(); }, Math.max(30, Math.min(100, LAG - (Date.now() - seen.at) + 5))); };
        wt = me;
        timer = setTimeout(function () { me.end(true); }, ms);
        // The attributes read() looks at (not the player's own style churn); Lumen's own data-lumen-sh* writes never count.
        obs = new MutationObserver(function (recs) {
          if (chk) return;
          for (var i = 0; i < recs.length; i++) { if (!(recs[i].type === 'attributes' && /^data-lumen-sh/.test(recs[i].attributeName || ''))) { chk = setTimeout(check, 30); return; } }
        });
        obs.observe(Q('ytd-shorts') || document.body || document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
          attributeFilter: ['is-active', 'aria-pressed', 'aria-label', 'aria-disabled', 'disabled', 'href', 'src', 'hidden'] });
        try { document.addEventListener('readystatechange', onRs); } catch (e) { /* no document events: the observer and the time limit still answer */ }
        if (x0.lag) lagged(x0);
      });
    }
    window.__lumenSh = { v: V, apply: function (on) { var a = apply(on); if (!on) stop(); return a; }, read: read, aspect: aspect, step: step, openFirst: openFirst, press: press,
      tick: function (on) { return current(now(on)); }, until: until, stop: stop };
  }
  var GUEST = '(' + String(guest) + ')();';
  function call(method, args) {
    return GUEST + 'window.__lumenSh.' + method + '(' + (args || []).map(function (a) { return JSON.stringify(a === undefined ? null : a); }).join(',') + ')';
  }

  var PURE = { ORIGIN: ORIGIN, READS: READS, MOVES: MOVES, WHEEL: WHEEL, LAY: LAY, ASP: ASP, shape: shape, initial: initial, HIDE: HIDE, KEEP: KEEP, route: route, isShorts: isShorts, idOf: idOf,
    entryUrl: entryUrl, shortUrl: shortUrl, gesture: gesture, keyStep: keyStep, follow: follow, complete: complete, box: box, trimCss: trimCss, guest: guest, call: call };
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
    comments: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.2 4.5h13.6c.8 0 1.4.6 1.4 1.4v9.4c0 .8-.6 1.4-1.4 1.4H10l-4.6 3.6v-3.6h-.2c-.8 0-1.4-.6-1.4-1.4V5.9c0-.8.6-1.4 1.4-1.4Z"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 5.2 20 11.5l-6.5 6.3v-3.6c-4.6 0-7.6 1.3-9.6 4.6.6-4.9 3.3-9 9.6-9.7V5.2Z"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5.5 12.5 4.2 4.2 8.8-9.4"/></svg>',
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
      presses: [], steps: [], wheel: null, wheels: 0, confirm: false, save: null, opened: '', logged: '', lastUrl: '', layout: null,
      aspect: 0, aspT: 0, aspSeq: 0, easeT: 0, navs: 0, whyShort: false, failedLoad: false, sig: '', refocus: '', trimmed: false,
      cm: false, share: null, shareT: 0, reading: 0, asking: false, askOn: false, ask: 0, readEnd: 0, readSig: '', readDoc: -1 };
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
    // The comments' mount (Comments open): ONE node for the slot's life, so a rebuild of the info moves it rather
    // than reloading it (watch-comments.js keeps its section in it). Its own changes are never read out as the info's
    // (a page of comments arriving is not an announcement); the renderer's own notes are status lines of their own.
    p.cmBox = el('div', 'sh-comments');
    p.cmBox.setAttribute('role', 'region');
    p.cmBox.setAttribute('aria-label', 'Comments on this Short');
    p.cmBox.setAttribute('aria-live', 'off');
    s.tile.appendChild(p.cover);
    s.tile.appendChild(p.nav);
    s.tile.appendChild(p.info);
    // The wheel anywhere in the tile outside the page (the margins, the info, the buttons) moves one
    // Short per gesture; the save list scrolls itself when it can.
    s.tile.addEventListener('wheel', function (e) { onWheel(s, e); }, { passive: false });
    // A touch swipe on Lumen's parts: one Short per swipe (on the player, YouTube's own).
    var touch = null;
    s.tile.addEventListener('touchstart', function (e) {
      // A swipe that scrolls the Save list is the list's, never a Short move (the wheel's rule, onWheel()).
      var inList = e.target && e.target.closest && (e.target.closest('.pv-savelist') || overflows(e.target.closest('.sh-comments')) ||
        (s.tile.getAttribute('data-sh') === 'below' && p.info.scrollHeight > p.info.clientHeight + 2 && p.info.contains(e.target)));
      touch = shOn(s) && e.touches.length === 1 && !inList ? { y: e.touches[0].clientY, t: Date.now() } : null;
    }, { passive: true });
    s.tile.addEventListener('touchend', function (e) {
      if (!touch || !shOn(s)) { touch = null; return; }
      var t = e.changedTouches && e.changedTouches[0];
      var dy = t ? touch.y - t.clientY : 0;
      touch = null;
      if (Math.abs(dy) >= 48) step(s, dy > 0 ? 1 : -1, 'touch');
    }, { passive: true });
    var trim = function () {
      try {
        var pr = v.insertCSS(trimCss());
        if (pr && pr.catch) pr.catch(function (e) { p.why = 'Lumen couldn’t trim YouTube’s page: ' + ((e && e.message) || e); render(s); });
      } catch (e) { p.why = 'Lumen couldn’t trim YouTube’s page: ' + ((e && e.message) || e); }
    };
    // The trim and the reads start when the new document COMMITS (did-navigate), not at dom-ready: YouTube's Shorts
    // page starts its player while its HTML is still streaming in (real YouTube, warm: the first frame ~650 ms after
    // the click, dom-ready 1.5-2 s), and a page that busy answered the first ask late, so the cover hid a Short that
    // was already playing for 1-2 s. dom-ready inserts the trim again (in case the commit's went to a document
    // that didn't last; a second copy of the same rules changes nothing) and starts the reads only if the commit
    // didn't (readDoc: this document's reads are running).
    v.addEventListener('dom-ready', function () {
      if (s.view !== v) return;
      trim();
      if (isShorts(s.url, s.service) && !(p.reading && p.readDoc === p.navs)) { startReads(s, false); p.readDoc = p.navs; }
    });
    v.addEventListener('did-start-navigation', function (e) {
      // A move in place (YouTube's pushState from Short to Short) is not a new document. The <webview> event names
      // it isInPlace (isSameDocument is the webContents' name, never set here): read as a new document, every move
      // dropped the trim flag, the read and the open Save list before did-navigate-in-page could close YouTube's
      // own (r62's unproven 11e), and closed open comments.
      if (s.view !== v || !e.isMainFrame || e.isInPlace || e.isSameDocument) return;
      p.applied = false; p.noRoot = false; p.read = null; p.phase = 'loading'; p.save = null; p.confirm = false; p.cm = false;
      newDocument(s);
      update(s);
    });
    v.addEventListener('did-navigate-in-page', function (e) {
      if (s.view !== v || !e.isMainFrame) return;
      var u = String(e.url || '');
      if (u === p.lastUrl) return;
      p.lastUrl = u;
      // A reason about the Short just left (a press YouTube didn't confirm, "the first Short", a page that
      // didn't answer a move) is that Short's, never the next one's.
      if (p.whyShort) { p.why = ''; p.whyShort = false; }
      // YouTube's Save list was for the Short just left: it is closed in the page too (left open, invisible
      // under the trim, the next Save read its ticks for the new Short).
      if (p.save) js(v, call('press', ['save-close', null])).catch(function () { /* the page went: nothing open */ });
      p.save = null; p.confirm = false;
      // A refused copy already said under the Short just left is that Short's reason (r62: a reason never outlives
      // its Short). A copy still in flight, or "Link copied: <its link>", stays: each note names its own link, so a
      // click just before the move still says what it copied (or why it couldn't).
      // Open comments stay open: render() mounts the new Short's.
      if (p.share && p.share.ok === false) clearShare(p);
      if (isShorts(u, s.service)) startReads(s, true);
      else update(s);
    });
    // A new document committed: whatever the old one wore is gone with it.
    v.addEventListener('did-navigate', function (e) {
      if (s.view !== v) return;
      p.trimmed = false;
      if (p.failedLoad || !isShorts((e && e.url) || s.url, s.service)) return;
      trim();
      startReads(s, false);
      p.readDoc = p.navs;
    });
    v.addEventListener('did-fail-load', function (e) {
      if (s.view !== v || !e.isMainFrame || e.errorCode === -3) return;
      p.phase = online() ? 'failed' : 'offline';
      p.failedLoad = true;   // the page itself is Chromium's error page: back online, it is loaded again (the 'online' handler)
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
    p.read = null; p.shown = null; p.shownId = ''; p.phase = 'loading'; p.why = ''; p.save = null; p.confirm = false; p.noRoot = false; p.opened = ''; p.cm = false;
    p.aspect = 0;
    newDocument(s);
    update(s);
  }
  /**
   * The page is about to be a new document (a full load: reuse()'s loadURL, a reload, a link out of YouTube's
   * app): nothing the old one started may land on the new one.
   *   - The reads and the shape poll stop, and seq moves on, so an answer from the old page (its
   *     executeJavaScript still in flight) is dropped instead of marking the new page trimmed (p.applied) and
   *     hiding the cover while YouTube's untrimmed page loads.
   *   - A press in flight is let go (navs moves on; press() drops its answer): Electron never settles an
   *     executeJavaScript whose page went away, and its p.busy left every button "Waiting for YouTube…" for good.
   *   - The last in-page address is forgotten: did-navigate-in-page skips a repeat of it, and on the new document
   *     the first in-page move can be to that same Short (A, B; reopened at A; the wheel to B), which then never
   *     got read and the info stayed "Loading the Short…".
   */
  function newDocument(s) {
    var p = shOf(s);
    if (!p) return;
    stopReads(s);
    p.seq++;
    clearTimeout(p.aspT); p.aspT = 0;
    p.navs++;
    p.busy = '';
    p.lastUrl = '';
    // ...and the old document's reasons go with it ("didn't load" stayed under the Short Try again brought back).
    p.why = ''; p.whyShort = false;
    p.failedLoad = false;
    clearShare(p);
    // The comments read from the old document: a request still in flight there never settles (Electron's
    // executeJavaScript across a new document), and it left "Loading comments…" for good. A new document is a
    // new section, read from the new page.
    forgetComments(s, 'short');
  }
  // which 'short': only the Shorts view's section (a normal video's, under the playback view, is never touched here).
  function forgetComments(s, which) {
    try { if (window.LumenComments && typeof window.LumenComments.forget === 'function') window.LumenComments.forget(s.id, which); } catch (e) { /* nothing kept */ }
  }
  function destroy(ctx, s) {
    var p = shOf(s);
    if (!p) return;
    stopReads(s);
    clearTimeout(p.aspT); clearTimeout(p.easeT); p.aspT = p.easeT = 0;
    clearShare(p);
    forgetComments(s);   // the closed slot's comments (their DOM, listeners and webview) go with it
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

  /**
   * The reads of one load or one move (seq): ONE ask at a time that the page answers when its read changes (guest
   * until()), each answer shown at once, the next ask carrying what this one said (sig), until the read is complete
   * or the time is up (READ_MS after a load, MOVE_MS after a move: the last entries of READS and MOVES, the times
   * the old fixed asks ended at). The answer at the time limit is the last one (final): its reasons are said.
   */
  var READ_MS = READS[READS.length - 1], MOVE_MS = MOVES[MOVES.length - 1];
  function stopReads(s) {
    var p = shOf(s);
    if (!p) return;
    p.timers.forEach(function (t) { clearTimeout(t); });
    p.timers = [];
    // A wait still open in the page ends (its observer with it); its answer is dropped (p.reading).
    if (p.reading && p.asking && s.view) js(s.view, call('stop', [])).catch(function () { /* the page went: nothing waits there */ });
    p.reading = 0; p.asking = false;
  }
  function startReads(s, moved) {
    var p = shOf(s);
    if (!p) return;
    stopReads(s);
    var seq = ++p.seq;
    if (!online()) { p.phase = 'offline'; update(s); return; }
    if (p.phase !== 'failed') p.phase = moved && p.applied ? 'moving' : 'loading';
    p.reading = seq;
    p.readEnd = Date.now() + (moved ? MOVE_MS : READ_MS);
    p.readSig = '';
    // A page that never answers (hung, its script gone) still gets its reason: past the time limit with an ask
    // still open, the reads end as an unanswered last read would.
    p.timers.push(setTimeout(function () {
      if (p.seq !== seq || p.reading !== seq) return;
      if (p.phase === 'ready') { stopReads(s); return; }   // shown complete already: nothing to say
      var f = follow(idOf(s.url, s.service), p.shown, '');
      p.phase = !online() ? 'offline' : f.fresh && p.shown && (p.shown.title || (p.shown.channel && p.shown.channel.name)) ? 'partial' : 'unread';
      p.why = 'YouTube’s page didn’t answer Lumen’s read';
      stopReads(s);
      update(s);
    }, p.readEnd - Date.now() + 3000));
    tick(s, seq);
    update(s);
  }

  function tick(s, seq) {
    var p = shOf(s);
    if (!p || p.seq !== seq || p.reading !== seq || !s.view) return;
    var v = s.view;
    var on = onFor(s);
    // ask: this ask's own number. A newer ask (the view turned on or off while one was open: update()) answers the
    // older one in the page; that answer is dropped here, so one load never runs two loops of asks.
    var ask = p.ask = (p.ask || 0) + 1;
    p.asking = true; p.askOn = on;
    js(v, call('until', [on, p.readSig, Math.max(0, p.readEnd - Date.now())])).then(function (r) {
      if (s.view !== v || p.seq !== seq || p.reading !== seq || p.ask !== ask) return;
      p.asking = false;
      if (!r || !r.ok) throw new Error('no answer from the page');
      var last = !!r.final || Date.now() >= p.readEnd - 20;
      p.readSig = String(r.sig || '');
      p.read = r;
      p.applied = !!r.applied;
      if (r.on || r.applied) p.trimmed = true;
      if (r.asp) setAspect(s, r.asp);
      if (r.kind === 'short' && !(r.asp && r.asp.fresh)) pollAspect(s, seq);
      var cur = idOf(s.url, s.service);
      // A grid (a channel's Shorts, Subscriptions' Shorts, the feed before YouTube picks): its first Short.
      if ((r.kind === 'grid' || (r.kind === 'feed' && !r.reels)) && on) {
        // Not while its HTML is still streaming in (the reads start at the commit now): a link half built then
        // isn't the grid's first Short, and the feed picks its own once its app is up.
        if (r.links && p.opened !== r.url && r.ready !== 'loading') {
          p.opened = r.url;
          js(v, call('openFirst', [])).then(function (o) { if (o && !o.ok && s.view === v) { p.why = 'YouTube’s page has ' + o.reason; render(s); } }, function () { /* the next tick says */ });
        } else if (last) {
          // No Shorts on the grid, or its first Short was clicked and YouTube never opened it: either way the
          // cover says why instead of "Opening the channel's Shorts…" for good.
          p.phase = 'empty';
          p.why = r.links ? 'YouTube didn’t open the first Short here.' : r.kind === 'grid' ? 'YouTube’s page has no Shorts here.' : 'YouTube didn’t pick a Short to start with.';
          logLine((r.links ? 'the first Short never opened: ' : 'no Shorts to open: ') + r.kind);
        }
        update(s);
        if (!last) tick(s, seq);   // the next ask: YouTube opening the Short (or the grid filling) answers it
        else stopReads(s);
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
      // Complete is shown as ready at once, but the page is still asked until the time is up: the asks cost nothing
      // while nothing changes (the page answers only a change), and what YouTube fills in after it is complete still
      // shows: the channel's picture its <img> hadn't loaded yet (the old fixed asks stopped at the first complete
      // read, ~150 ms in, when it usually had), and its one renderer's own late correction of a title or channel.
      if (done) p.phase = 'ready';
      else if (last && p.phase !== 'ready') p.phase = !f.fresh ? 'unread' : (r.title || (r.channel && r.channel.name)) ? 'partial' : 'unread';
      if (last) stopReads(s);
      if (on && p.logged !== s.id + ':' + (p.applied ? 'on' : 'off') && p.applied) { p.logged = s.id + ':on'; logLine('opened: ' + ((route(s.url, s.service) || {}).kind || 'short')); }
      update(s);
      if (!last) tick(s, seq);   // the next ask, carrying this answer's sig: the page answers when it changes
    }).catch(function (e) {
      if (s.view !== v || p.seq !== seq || p.reading !== seq || p.ask !== ask) return;
      p.asking = false;
      // A page that didn't answer (still loading its own script, busy): asked again shortly while there is time,
      // never in a tight loop; at the time limit the reason is said.
      if (Date.now() < p.readEnd - 20) { p.timers.push(setTimeout(function () { tick(s, seq); }, 150)); return; }
      p.phase = online() ? 'unread' : 'offline'; p.why = 'Lumen couldn’t read YouTube’s page: ' + ((e && e.message) || e);
      stopReads(s);
      update(s);
    });
  }

  /** Classes, the trim, the layout and the info, from the slot's state. */
  function update(s) {
    var p = shOf(s), L = layerOf();
    if (!p || !L) return;
    var on = onFor(s);
    // An ask open in the page was made for the other state (the layer went to the corner, or came back): asked
    // again, so the page's checks never put the trim back on a page that isn't the Shorts view (or leave it off).
    if (p.reading && p.asking && p.askOn !== on && s.view) tick(s, p.reading);
    var boxed = on && !p.noRoot;
    s.tile.classList.toggle('sh', boxed);
    s.tile.classList.toggle('sh-wait', boxed && !p.applied && p.phase !== 'failed' && p.phase !== 'offline');
    if (L.el && (L.slots[L.focus] === s || L.slots.length === 1)) L.el.classList.toggle('sh-on', boxed);
    layoutBox(s);
    // The view is off (a normal video, a tile, the corner) while the page may still wear the trim: it comes off.
    // p.trimmed, not p.applied: a navigation that STARTED (did-start-navigation clears p.applied) can still be
    // aborted or end in-page (real YouTube, Short -> video), and the old document then kept its flag: the video
    // page under it stayed hidden (body visibility: hidden).
    if (s.view && (p.applied || p.trimmed) && !on) {
      var v = s.view;
      js(v, call('apply', [false])).then(function () { if (s.view === v) { p.applied = false; p.trimmed = false; render(s); } }, function () { /* the next load says */ });
    }
    render(s);
  }

  /** The current Short's shape from the page (a guest aspect() answer): a new one re-boxes, easing. */
  function setAspect(s, a) {
    var p = shOf(s);
    if (!p || !a || !(a.w > 0) || !(a.h > 0)) return;
    var r = a.w / a.h;
    if (Math.abs(shape(r) - shape(p.aspect)) < 0.004) { p.aspect = r; return; }
    p.aspect = r;
    layoutBox(s, true);
  }
  /** Asks the page for the Short's shape every ASP.EVERY ms until it is this Short's (fresh), ASP.POLL ms at most. */
  function pollAspect(s, seq) {
    var p = shOf(s);
    if (!p || p.aspSeq === seq || !s.view) return;
    p.aspSeq = seq;
    var v = s.view, t0 = Date.now();
    (function next() {
      clearTimeout(p.aspT);
      p.aspT = setTimeout(function () {
        p.aspT = 0;
        if (p.seq !== seq || s.view !== v || Date.now() - t0 > ASP.POLL) return;
        js(v, call('aspect', [])).then(function (a) {
          if (p.seq !== seq || s.view !== v) return;
          setAspect(s, a);
          if (!(a && a.fresh)) next();
        }, function () { /* the page went away: its next load reads again */ });
      }, ASP.EVERY);
    })();
  }

  var ro = null;
  /** The box from the tile's size and the Short's shape. ease: a new shape, eased (never a resize or the first box). */
  function layoutBox(s, ease) {
    var L = layerOf();
    if (!L || !s || !s.view) return;
    var p = shOf(s);
    if (!shOn(s) || !L.grid) {
      if (p && p.layout) {
        ['--sh-x', '--sh-y', '--sh-w', '--sh-h'].forEach(function (k) { s.tile.style.removeProperty(k); });
        clearTimeout(p.easeT); p.easeT = 0; s.tile.removeAttribute('data-sh-ease');
        s.tile.removeAttribute('data-sh');
        p.layout = null;
      }
      return;
    }
    if (!ro && window.ResizeObserver) { ro = new ResizeObserver(function () { all.forEach(function (x) { if (shOn(x)) layoutBox(x); }); }); ro.observe(L.grid); }
    var r = s.tile.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) return;
    var b = box(r.width, r.height, p.aspect);
    var was = p.layout;
    if (ease && was && b.mode === was.mode && (b.vw !== was.vw || b.vh !== was.vh)) {
      s.tile.setAttribute('data-sh-ease', '');
      clearTimeout(p.easeT);
      p.easeT = setTimeout(function () { p.easeT = 0; s.tile.removeAttribute('data-sh-ease'); }, ASP.EASE + 60);
    } else if (!ease && p.easeT && was && (b.vw !== was.vw || b.vh !== was.vh || b.x !== was.x || b.mode !== was.mode)) { clearTimeout(p.easeT); p.easeT = 0; s.tile.removeAttribute('data-sh-ease'); }
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
    // A wheel over the page itself is the page's: YouTube's own wheel, or (today's pinned Short) the page script's
    // one-Short-per-gesture (guest() onWheel). Stepping here too moved two Shorts for one gesture.
    // So is one over Lumen's cover on the player while a move loads: the rest of that same gesture (a trackpad's
    // inertia) landed there and moved a second Short.
    var p = shOf(s);
    if (e.target === s.view || (p && p.cover && e.target && p.cover.contains(e.target))) { e.preventDefault(); return; }
    // The save list scrolls itself while it can, and so does the info below the player (a narrow layer: its fixed
    // band can be shorter than a note or the Save list, watch-shorts.css); everything else is a Short move.
    if (scrolls(e.target && e.target.closest ? e.target.closest('.pv-savelist') : null, e.deltaY)) return;
    // Open comments that overflow are read with the wheel: ALWAYS theirs, even at either end (a flick that ran
    // past the last comment skipped to the next Short while he was reading). Comments that fit move a Short.
    if (overflows(e.target && e.target.closest ? e.target.closest('.sh-comments') : null)) return;
    if (s.tile.getAttribute('data-sh') === 'below' && scrolls(p.info.contains(e.target) ? p.info : null, e.deltaY)) return;
    e.preventDefault();
    p.wheels++;
    var g = gesture(p.wheel, { dy: e.deltaY, dx: e.deltaX, mode: e.deltaMode, t: e.timeStamp || Date.now() });
    p.wheel = g.st;
    if (g.step) step(s, g.step, 'wheel');
  }

  /** Whether a scroll box (or null) has more than it shows. */
  function overflows(box) { return !!box && box.scrollHeight > box.clientHeight + 2; }
  /** Whether a scroll box (or null) overflows and can still go the wheel's way (dy). */
  function scrolls(box, dy) {
    if (!box || box.scrollHeight <= box.clientHeight + 2) return false;
    var atTop = box.scrollTop <= 0, atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 1;
    return (dy < 0 && !atTop) || (dy > 0 && !atEnd);
  }

  /** One move with YouTube's own navigation in the page. */
  function step(s, dir, how) {
    var p = shOf(s);
    if (!p || !s.view || !shOn(s)) return false;
    var v = s.view;
    var rec = { dir: dir, how: how, at: Date.now(), ok: null, via: '', reason: '' };
    var u0 = p.lastUrl;
    p.steps.push(rec);
    if (p.steps.length > 50) p.steps.shift();
    js(v, call('step', [dir])).then(function (r) {
      if (s.view !== v) return;
      rec.ok = !!(r && r.ok); rec.via = (r && r.how) || ''; rec.reason = (r && r.reason) || '';
      if (!rec.ok) { p.why = rec.reason || 'YouTube’s page didn’t move'; p.whyShort = true; render(s); return; }
      if (p.why && /first Short|last Short|didn’t move/.test(p.why)) p.why = '';
      // The address changes with YouTube's own move (did-navigate-in-page reads the new Short); read anyway, unless
      // that already happened (its reads, started for the new address, are the move's: restarting them dropped an
      // ask the page was about to answer). Asked before the address moves, the page answers with the Short still
      // on it; did-navigate-in-page then reads the new one.
      if (p.lastUrl === u0) startReads(s, true);
    }, function (e) { if (s.view === v) { rec.ok = false; rec.reason = (e && e.message) || String(e); p.why = 'YouTube’s page didn’t answer: ' + rec.reason; p.whyShort = true; render(s); } });
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
      // In the comments, the arrows are the comments' (they scroll the list he is reading), never a Short move.
      if (t && t.closest && t.closest('.sh-comments')) return;
      if (t && t !== document.body && L.el && !L.el.contains(t)) return;
      var d = keyStep(e);
      if (!d) return;
      e.preventDefault();
      // A held arrow is one Short, not one per auto-repeat (about 30 a second ran through the feed).
      if (e.repeat) return;
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
    var nav = p.navs;
    p.busy = kind;
    p.why = ''; p.whyShort = false;
    var rec = { kind: kind, arg: arg === undefined ? null : arg, at: Date.now(), ok: null, reason: '', id: forId };
    p.presses.push(rec);
    render(s);
    // forId: the Short Lumen's info names. The page refuses a press when its own Short is another one (the address
    // or YouTube's one player already moved on), so a click never likes or subscribes the Short that came next.
    var target = kind === 'save-toggle' || kind === 'save-close' ? '' : forId;
    js(v, call('press', [kind, arg === undefined ? null : arg, target])).then(function (r) {
      if (s.view !== v || p.navs !== nav) return;   // a new document since (newDocument()): not this press's page
      p.busy = '';
      rec.ok = !!(r && r.ok);
      rec.reason = (r && r.reason) || '';
      if (!r || !r.ok) p.why = (r && r.reason) ? r.reason.charAt(0).toUpperCase() + r.reason.slice(1) : 'YouTube’s page didn’t answer';
      else if (r.changed === false && kind !== 'save-open' && kind !== 'save-close') p.why = 'YouTube didn’t confirm it yet: the state shown is what its page says';
      p.whyShort = !!p.why;
      // YouTube's Save list opened for a Short he has since moved on from: closed in the page, never shown as this one's.
      var gone = !!forId && idOf(s.url, s.service) !== forId;
      if ((kind === 'save-open' || kind === 'save-toggle') && gone && r && r.ok) { js(v, call('press', ['save-close', null])).catch(function () { /* the page went */ }); p.save = null; }
      else if (kind === 'save-open' || kind === 'save-toggle') p.save = r && r.ok ? { list: r.list || [] } : null;
      if (kind === 'save-close') p.save = null;
      if (kind === 'unsubscribe') p.confirm = false;
      return js(v, call('read', [])).then(function (rr) {
        if (s.view !== v || p.navs !== nav) return;
        if (!rr || !rr.ok) { render(s); return; }
        p.read = rr;
        var f = follow(idOf(s.url, s.service), rr, p.shownId);
        if (f.fresh) { p.shown = rr; p.shownId = f.id; }
        render(s);
      });
    }).catch(function (e) {
      if (s.view !== v || p.navs !== nav) return;
      p.busy = '';
      rec.ok = false;
      rec.reason = (e && e.message) || String(e);
      p.why = 'YouTube’s page didn’t answer: ' + rec.reason;
      p.whyShort = true;
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
    // Rebuilt only when what it shows changed (a tick, a sync or a resize that changes nothing leaves it alone):
    // a rebuild on every update dropped the keyboard focus from the button he was on, re-announced the whole
    // info to a screen reader, scrolled the Save list back to the top and could eat a click between its press
    // and release. When it does change, the focus goes back to the same control and the list keeps its scroll.
    var sig = '';
    // Open comments are the address's Short's (cur), which moves on before its read comes in: in the signature, so
    // a quick run of moves (no read in between) still mounts each new Short's comments, never the last one's.
    try { sig = JSON.stringify([showPhase, f.fresh ? f.id : '', m, p.busy, p.confirm, p.save, p.why, !!(r && r.ad), !!r, p.cm ? cur : '', p.share]); } catch (e) { sig = ''; }
    if (!sig || sig !== p.sig || !info.firstChild) {
      p.sig = sig;
      var fk = focusKey(info) || p.refocus;
      var sl0 = info.querySelector('.pv-savelist');
      var top = sl0 ? sl0.scrollTop : 0;
      build(s, p, m, showPhase, info, r);
      var sl1 = info.querySelector('.pv-savelist');
      if (sl1 && top) sl1.scrollTop = top;
      p.refocus = refocus(info, fk) ? '' : fk;
    }
    // Lumen's Previous / Next: off only where YouTube says there is nowhere to go.
    var rd = p.read && follow(cur, p.read, '').fresh ? p.read : r;
    var dead = phase === 'failed' || phase === 'offline';
    disable(p.prev, dead ? 'YouTube’s page isn’t there' : rd && rd.canPrev === false ? 'This is the first Short' : '');
    disable(p.next, dead ? 'YouTube’s page isn’t there' : rd && rd.canNext === false ? 'This is the last Short YouTube has here' : '');
  }
  /** The info's contents, from the model (render() decides when). */
  function build(s, p, m, showPhase, info, r) {
    info.replaceChildren();
    var head = el('div', 'sh-head');
    head.appendChild(el('span', 'sh-kicker', 'Shorts'));
    info.appendChild(head);
    var h = el('h1', 'pv-title sh-title');
    h.dir = 'auto';   // a right-to-left title reads right to left (its own first strong character decides)
    if (m.title) h.textContent = m.title;
    else { h.classList.add('pv-skel'); h.textContent = showPhase === 'loading' || showPhase === 'moving' ?'Loading the Short…' : 'Untitled Short'; }
    info.appendChild(h);
    renderChannel(s, p, m, showPhase, info);
    renderActs(s, p, m, showPhase, info, r);
    renderLists(s, p, m, info);
    renderNote(s, p, m, showPhase, info, r);
    renderComments(s, p, info, r);
    info.appendChild(el('p', 'sh-hint', 'Scroll, swipe or press ↑ ↓ for the next Short'));
  }
  // The info's own controls, as keys that find their twins after a rebuild (render()). Done before Cancel: both are pv-ghost.
  var FOCUS_KEYS = ['pv-like', 'pv-dislike', 'pv-save', 'sh-comments-btn', 'sh-share', 'pv-sub', 'pv-danger', 'pv-savelist-done', 'pv-ghost', 'pv-saveopt'];
  function focusKey(info) {
    var a = document.activeElement;
    if (!a || !info.contains(a) || !a.classList) return '';
    for (var i = 0; i < FOCUS_KEYS.length; i++) {
      if (!a.classList.contains(FOCUS_KEYS[i])) continue;
      if (FOCUS_KEYS[i] === 'pv-saveopt') return 'pv-saveopt:' + Array.prototype.indexOf.call(info.querySelectorAll('.pv-saveopt'), a);
      return FOCUS_KEYS[i];
    }
    return '';
  }
  /** The focus back on the control (key) it was on; false while that control is off (busy): the next rebuild tries again. */
  function refocus(info, key) {
    if (!key) return true;
    var a = document.activeElement;
    if (a && a !== document.body && !info.contains(a)) return true;   // he has moved on: the focus is never pulled back
    var k = key.split(':');
    var n = k.length > 1 ? info.querySelectorAll('.' + k[0])[Number(k[1])] : info.querySelector('.' + k[0]);
    if (!n) return true;
    if (n.disabled) return false;
    try { n.focus({ preventScroll: true }); } catch (e) { /* not focusable: nothing to keep */ }
    return true;
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
    var cn = el('span', 'pv-chan-name' + (m.channel ? '' : ' pv-skel'), m.channel ? m.channel.name : (phase === 'loading' ? 'Reading the channel…' : 'Channel unknown'));
    cn.dir = 'auto';
    ct.appendChild(cn);
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

  function renderActs(s, p, m, phase, info, r) {
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
    // Comments: Lumen's own (watch-comments.js) in the info, for the Short the address says. Nothing is pressed in
    // YouTube's page, so it never waits on a press. A mouse click hands the keys back to the player (Space, the
    // arrows); from the keyboard the focus stays, so Tab goes on into the comments.
    var cur = idOf(s.url, s.service);
    var cmb = iconBtn('sh-comments-btn' + (p.cm ? ' is-open' : ''), 'comments', 'Comments', function (b, e) {
      p.cm = !p.cm;
      render(s);
      if (e && e.detail > 0) backToPlayer(s);
    }, p.cm ? 'Hide the comments' : 'Show this Short’s comments');
    cmb.setAttribute('aria-expanded', p.cm ? 'true' : 'false');
    disable(cmb, cmOff(s, p, phase, cur, r));
    acts.appendChild(cmb);
    // Share: the link to the Short the info names (r's own id, never the address's: a click as the feed moves
    // copies the Short he saw, never the one that came next), onto the clipboard, said on the button and in a note.
    var forId = r && r.videoId ? String(r.videoId) : '';
    var done = p.share && p.share.ok && p.share.id === forId;
    var sha = iconBtn('sh-share' + (done ? ' is-done' : ''), done ? 'check' : 'share', done ? 'Link copied' : 'Share', function (b, e) {
      share(s, forId, e && e.detail > 0);
    }, done ? 'Link copied: ' + shortUrl(forId) : 'Share: copy this Short’s link');
    disable(sha, !forId ? (phase === 'failed' || phase === 'offline' ? 'YouTube’s page isn’t there' : 'Loading the Short…') : r.ad ? 'This is an ad on YouTube, not a Short to share' : '');
    acts.appendChild(sha);
    info.appendChild(acts);
  }

  /** Why Comments is off (''= on): no renderer, no Short yet, the page gone, an ad. */
  function cmOff(s, p, phase, cur, r) {
    if (!window.LumenComments) return 'Lumen’s comments aren’t loaded in this window';
    if (phase === 'failed') return 'YouTube’s page isn’t there';
    if (!cur) return 'Loading the Short…';
    if (r && r.ad) return 'This is an ad on YouTube: it has no comments here';
    return '';
  }

  /** The comments' mount, after the info's other parts (a reason for the buttons stays in sight above it). */
  function renderComments(s, p, info, r) {
    var cur = idOf(s.url, s.service);
    var on = p.cm && !cmOff(s, p, p.phase, cur, r);
    info.classList.toggle('has-cm', on);
    if (!on) return;
    info.appendChild(p.cmBox);
    p.cmBox.setAttribute('data-short', cur);
    // watch-comments.js fills it: the same event the playback view fires, as a Short's (short: its id goes to the
    // page's own /next; the mount is what scrolls). A new id is a new section, so the last Short's never shows.
    try {
      document.dispatchEvent(new CustomEvent('lumen-pv-info', { detail: { slot: s.id, wcId: s.wcId, videoId: cur, comments: null, container: p.cmBox,
        view: s.view, short: true, scroller: p.cmBox } }));
    } catch (e) {
      p.cmBox.replaceChildren(el('p', 'pv-why pv-why-err', 'Lumen couldn’t show the comments: ' + ((e && e.message) || e)));
    }
    // The renderer answers in the same turn; a box it left empty would be a silent nothing.
    if (!p.cmBox.firstChild) p.cmBox.replaceChildren(el('p', 'pv-why pv-why-warn', 'Lumen’s comments didn’t draw here.'));
  }

  /* ---------------------------------------------------------------- share */

  function clearShare(p) { if (!p) return; clearTimeout(p.shareT); p.shareT = 0; p.share = null; }
  /**
   * The Short's link onto the clipboard (the chrome's own: navigator.clipboard on his click, else the copy command),
   * then "Link copied" on the button and in a note for SHARE_MS. A refusal says why and shows the link to copy by hand.
   */
  var SHARE_MS = 3000;
  function share(s, id, byMouse) {
    var p = shOf(s);
    if (!p || !id) return false;
    var v = s.view;
    var url = shortUrl(id);
    clearShare(p);
    var rec = { id: id, url: url, ok: null, why: '', at: Date.now() };
    p.share = rec;
    copyText(url).then(function (how) {
      if (p.share !== rec || s.view !== v) return;   // another copy, a move or a new page since: that one's answer stands
      rec.ok = true; rec.how = how;
      logLine('share: copied the link to a Short (' + how + ')');
      p.shareT = setTimeout(function () { if (p.share === rec) { p.share = null; p.shareT = 0; render(s); } }, SHARE_MS);
      render(s);
      if (byMouse) backToPlayer(s);   // after the copy: the clipboard needs this window's focus while it writes
    }, function (e) {
      if (p.share !== rec || s.view !== v) return;
      rec.ok = false; rec.why = (e && e.message) || String(e);
      logLine('share: the copy failed: ' + rec.why);
      render(s);
    });
    render(s);
    return true;
  }
  function copyText(text) {
    return new Promise(function (ok, no) {
      var byCommand = function (why) {
        var ta = document.createElement('textarea');
        var back = document.activeElement;
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position: fixed; left: -9999px; top: 0; opacity: 0;';
        document.body.appendChild(ta);
        ta.select();
        var done = false;
        try { done = document.execCommand('copy'); } catch (e) { done = false; }
        ta.remove();
        try { if (back && back.focus) back.focus({ preventScroll: true }); } catch (e) { /* gone */ }
        if (done) ok('copy command'); else no(new Error(why || 'the clipboard refused it'));
      };
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(function () { ok('clipboard'); }, function (e) {
            byCommand('the clipboard refused it (' + ((e && e.message) || e) + ')');
          });
          return;
        }
      } catch (e) { byCommand('the clipboard refused it (' + ((e && e.message) || e) + ')'); return; }
      byCommand('this window has no clipboard');
    });
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
    // Share's answer, naming the link it was for (a click just before a move still says what it did there).
    var sh = p.share;
    if (sh && sh.ok === true) note(info, 'Link copied: ' + sh.url, 'ok');
    else if (sh && sh.ok === false) note(info, 'Lumen couldn’t copy the link: ' + sh.why + '. The link is ' + sh.url, 'warn');
  }

  window.addEventListener('offline', function () { all.forEach(function (s) { render(s); }); });
  // Back online. A Shorts page that failed to load is only Chromium's error page, so reading it again said "Lumen
  // couldn't read this Short" over it for good: it is loaded again, as the offline note promises ("Shorts load again
  // when you're back online"), and the player's own failed card goes the way its Try again takes it.
  window.addEventListener('online', function () {
    all.forEach(function (s) {
      var p = shOf(s);
      if (p && p.failedLoad && s.view && isShorts(s.url, s.service)) {
        logLine('back online: the Shorts page loads again');
        if (s.state) s.state.hidden = true;
        try { s.view.reload(); } catch (e) { p.why = 'Lumen couldn’t load YouTube’s Shorts page again: ' + ((e && e.message) || e); render(s); }
        return;
      }
      if (p && p.phase !== 'ready' && isShorts(s.url, s.service)) startReads(s, false); else render(s);
    });
  });

  /* ---------------------------------------------------------------- e2e seam */

  function rect(n) { if (!n || !n.getBoundingClientRect) return null; var r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
  function stateOf(s) {
    var p = shOf(s);
    if (!p) return null;
    var m = p.info && !p.info.hidden ? p.info : null;
    var q = function (sel) { return m ? m.querySelector(sel) : null; };
    var b = function (n) { return n ? { text: n.textContent.trim(), disabled: n.disabled, pressed: n.getAttribute('aria-pressed'), why: n.getAttribute('data-why') || '' } : null; };
    // gate: where the last read's wait after a move went (the page's current(): why it was released, its lag in ms).
    return {
      id: s.id, url: s.url, route: route(s.url, s.service), cur: idOf(s.url, s.service), on: shOn(s), mode: s.tile.getAttribute('data-sh') || '', phase: p.phase,
      applied: p.applied, noRoot: p.noRoot, why: p.why, busy: p.busy, presses: p.presses.slice(), steps: p.steps.slice(), wheels: p.wheels, confirm: p.confirm, save: p.save,
      shownId: p.shownId, infoShort: m ? m.getAttribute('data-short') : '', view: rect(s.view), tile: rect(s.tile), info: m ? rect(m) : null, nav: p.nav.hidden ? null : rect(p.nav),
      cover: !p.cover.hidden, title: q('.pv-title') ? q('.pv-title').textContent : '', channel: q('.pv-chan-name') ? q('.pv-chan-name').textContent : '',
      note: q('.pv-why') ? q('.pv-why').textContent : '', like: b(q('.pv-like')), dislike: b(q('.pv-dislike')), sub: b(q('.pv-sub')), savebtn: b(q('.pv-save')),
      cmbtn: b(q('.sh-comments-btn')), sharebtn: b(q('.sh-share')), cm: p.cm, cmShort: m && m.contains(p.cmBox) ? p.cmBox.getAttribute('data-short') : '', cmBox: m && m.contains(p.cmBox) ? rect(p.cmBox) : null,
      share: p.share ? { id: p.share.id, url: p.share.url, ok: p.share.ok, why: p.share.why } : null, notes: m ? [].map.call(m.querySelectorAll('.pv-why'), function (n) { return n.textContent; }) : [],
      prev: b(p.prev), next: b(p.next), read: p.read, gate: p.read && p.read.gate ? p.read.gate : null, aspect: p.aspect, ease: s.tile.hasAttribute('data-sh-ease')
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
