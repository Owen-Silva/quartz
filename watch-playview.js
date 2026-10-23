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
  // ms after a page loads: read until it is all there. The first read is at once (r64): the page's own data
  // (ytInitialData, an inline script) is there at dom-ready, so the title, the channel and the description need no
  // wait; it was 250 ms of nothing on every open. The later ones are the backstop under the watch below.
  var READS = [0, 900, 2000, 4000, 8000];
  // Between those reads, a WATCH in the page (r64): one read the moment the page changes what the info shows (its
  // like and Subscribe buttons drawn, the player there), coalesced to one read per WATCH_GAP_MS, answered by
  // WATCH_MS at the latest. Only while the info is incomplete, one at a time. A read that waited for the next
  // fixed time held YouTube's buttons (and the trim's cover) back up to 2 s after the page had drawn them.
  var WATCH_MS = 2500;
  var WATCH_GAP_MS = 100;
  // A page still drawn for the last video at the last timed read (readYT: stale, after an in-place move) is waited
  // for up to here, from the start of the reads: a whole load's span (READS ends at 8 s) and a second more. On real
  // YouTube the redraw came 2.8-4.8 s after the address changed (r64 probe); past this the info says why.
  var STALE_MS = 9000;
  // The page's first words, before its own app has run (r64): YouTube's watch HTML defines ytInitialPlayerResponse
  // (its videoDetails: the title, the channel's name, the description) about 180 KB BEFORE the player and app
  // scripts that must run before ytInitialData and dom-ready, and on this machine those scripts are most of the
  // open. An early read at commit answers from it (read only: no trim, no buttons, no comments), at most EARLY_MS.
  var EARLY_MS = 6000;
  var PRESS_HOLD_MAX_MS = 2000;   // a held rebuild waits for his release at most this long
  var SHOW_PAGE_ANSWER_MS = 8000; // the Lumen tab opens a show page at once; past this the press is given up, with the reason
  var PRESS_ANSWER_MS = 15000;    // a press's longest own wait is 7.5 s (Unsubscribe: menu, confirm, state); past this it is said

  // The page's own furniture, hidden outright (display:none) while the view is on. Everything
  // else outside the player is only invisible (body visibility), so the page's own buttons and
  // popups still exist for Lumen's buttons to press.
  var HIDE = {
    youtube: ['#masthead-container', 'ytd-masthead', 'tp-yt-app-drawer#guide', 'ytd-mini-guide-renderer', '#secondary', '#related',
      '#comments', 'ytd-comments', '#chat', 'ytd-live-chat-frame', '#player-ads', 'ytd-ad-slot-renderer', 'ytd-companion-slot-renderer',
      'ytd-merch-shelf-renderer', 'ytd-engagement-panel-section-list-renderer', '#panels', '#offer-module'],
    disney: [], hulu: [], prime: [], espn: []
  };
  // The members of HIDE that are display-ad slots and the merch shelf, not the page's own
  // furniture. They are hidden only while Quartz's browser-wide ad blocker is on (Settings >
  // Privacy, <userData>\adblock.json `enabled`, default on): with it switched off he has chosen to
  // see the page's ads, so the view leaves these slots to the page like any other part of it
  // (they still sit under the invisible body, so the boxed player shows the same either way).
  // Only ever a subset of HIDE: with the blocker on, the trim is HIDE exactly as it always was.
  var ADSLOTS = {
    youtube: ['#player-ads', 'ytd-ad-slot-renderer', 'ytd-companion-slot-renderer', 'ytd-merch-shelf-renderer'],
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

  /** A YouTube address's video id ('' for a channel, the home page, anything that isn't one video). */
  function ytId(url) {
    var u = parse(url);
    if (!u) return '';
    if (/(^|\.)youtu\.be$/i.test(u.hostname)) return u.pathname.slice(1).split('/')[0] || '';
    if (u.pathname === '/watch') return u.searchParams.get('v') || '';
    var m = /^\/(?:live|embed|shorts)\/([^/?#]+)/.exec(u.pathname);
    return m ? m[1] : '';
  }
  /**
   * Whether a YouTube page has moved on from the video it was opened for (autoplay, an end-screen card,
   * a link in the description: all moves in the page, no reload). Then the row's title is not this
   * video's and must not stand in for it while the page is read (r62-playview: the last video's title
   * showed under the next one, and stayed when the read failed). An item with no video id never moves.
   */
  function ytMoved(fromUrl, nowUrl) {
    var a = ytId(fromUrl);
    return !!a && ytId(nowUrl) !== a;
  }

  /* ---------------------------------------------------------------- the description's links */

  /*
   * The description used to be one text node, so its links and chapter times couldn't be clicked in
   * Lumen. Now the page's own links come over with the text (descLinks in the page: each <a>'s words and
   * its raw href; ytInitialData's commandRuns when the DOM has none) and the description is drawn as text
   * nodes and <a> elements, never markup from the page. Each link is one of:
   *   'time': this video at t seconds: the page's own player seeks and plays (no reload, r62's comments fix);
   *   'same': this video with no time: nothing to open, and the note says so;
   *   'yt':   another YouTube page (a video, Shorts, a channel or @handle, a playlist, a hashtag): opened
   *           in Lumen through window.openInLumen, the way the comments and the tiles open them;
   *   'web':  any other http(s) site: a Quartz tab (window.createTab), the way the comments open them.
   * Anything else (javascript:, data:, file:, a mailto) is no link: its words stay plain text.
   */
  var YT_BASE = 'https://www.youtube.com';
  var DESC_LINKS_MAX = 300;
  /** YouTube's t= / start= ("83", "83s", "1h2m3s") as seconds, or null. */
  function tSeconds(t) {
    if (t === null || t === undefined || t === '') return null;
    var s = String(t);
    if (/^\d+s?$/.test(s)) return parseInt(s, 10);
    var m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
    if (m && (m[1] || m[2] || m[3])) return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
    return null;
  }
  /** "1:23", "01:02:03" (a chapter time as written) as seconds, or null. */
  function clockSeconds(text) {
    var m = /^(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)$/.exec(String(text || '').trim());
    if (!m) return null;
    if (m[1] !== undefined && Number(m[2]) > 59) return null;
    return (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
  }
  function isYtHost(h) { return /^(?:(?:www|m)\.)?youtube\.com$/i.test(h) || /^(?:www\.)?youtu\.be$/i.test(h); }
  /**
   * A description link as Lumen opens it: { kind, href, t? } (kinds above), or null when it isn't an
   * http(s) link. href may be YouTube's relative form ("/watch?v=…&t=83s", "/@handle", "/hashtag/x");
   * YouTube's /redirect?q= is unwrapped to where it goes. videoId: the video that is playing.
   */
  function descLink(href, videoId, depth) {
    var s = String(href || '').trim();
    if (!s || s.length > 4000) return null;
    if (/^\/(?!\/)/.test(s)) s = YT_BASE + s;
    var u;
    try { u = new URL(s); } catch (e) { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!isYtHost(u.hostname)) return { kind: 'web', href: u.href };
    if (u.pathname === '/redirect') {
      var q = u.searchParams.get('q');
      return q && (depth || 0) < 2 ? descLink(q, videoId, (depth || 0) + 1) : null;
    }
    var v = ytId(u.href);
    var t = tSeconds(u.searchParams.get('t') || u.searchParams.get('start'));
    if (v && videoId && v === videoId && !/^\/shorts\//.test(u.pathname)) {
      return t !== null ? { kind: 'time', href: u.href, t: t } : { kind: 'same', href: u.href };
    }
    return { kind: 'yt', href: u.href };
  }
  /** Plain text's own links: http(s) addresses and chapter times ("0:00", "1:23:45"), as segments. */
  var PLAIN_RE = /(https?:\/\/[^\s<>"]+)|(^|[^\w:.])((?:\d{1,2}:)?\d{1,2}:[0-5]\d)(?![\w:])/g;
  function plainSegs(text, videoId, out) {
    var s = String(text || '');
    var at = 0, m;
    PLAIN_RE.lastIndex = 0;
    while ((m = PLAIN_RE.exec(s))) {
      var start, word, l = null;
      if (m[1]) {
        start = m.index;
        word = m[1].replace(/[)\].,;:!?'’"]+$/, '');   // "(see https://x.y/z)." ends at z
        l = descLink(word, videoId);
      } else {
        start = m.index + m[2].length;
        word = m[3];
        var sec = clockSeconds(word);
        if (videoId && sec !== null) l = { kind: 'time', href: YT_BASE + '/watch?v=' + encodeURIComponent(videoId) + '&t=' + sec + 's', t: sec };
      }
      if (!l || !word) continue;
      if (start > at) out.push({ text: s.slice(at, start) });
      out.push({ text: word, link: l });
      at = start + word.length;
      PLAIN_RE.lastIndex = at;
    }
    if (at < s.length) out.push({ text: s.slice(at) });
    return out;
  }
  /**
   * The description as segments [{ text, link? }]: the page's links (links: [{ t: their words, h: href }],
   * in page order) found in the text in order, the rest of the text scanned for plain addresses and times.
   * A page link whose words aren't in the text (YouTube rewrote them) is dropped; its words stay text.
   */
  function descSegs(text, links, videoId) {
    var s = String(text || '');
    var out = [];
    var at = 0;
    (Array.isArray(links) ? links : []).slice(0, DESC_LINKS_MAX).forEach(function (pl) {
      var words = pl && typeof pl.t === 'string' ? pl.t : '';
      if (!words) return;
      var i = s.indexOf(words, at);
      if (i < 0) return;
      var l = descLink(pl.h, videoId);
      if (!l) return;
      if (i > at) plainSegs(s.slice(at, i), videoId, out);
      out.push({ text: words, link: l });
      at = i + words.length;
    });
    if (at < s.length) plainSegs(s.slice(at), videoId, out);
    return out;
  }
  /** "1:23", "1:02:03" for t seconds (a link's title). */
  function clock(t) {
    var n = Math.max(0, Math.floor(Number(t) || 0));
    var h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), x = n % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (x < 10 ? '0' : '') + x;
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

  /**
   * The CSS that trims a page to its player; inert until the page's <html data-lumen-pv> is set.
   * adblockOn: whether Quartz's ad blocker is on. Only an explicit false drops the ADSLOTS rules;
   * anything else (true, unknown, not yet answered) is today's trim, byte for byte.
   */
  function trimCss(service, adblockOn) {
    var ads = adblockOn === false ? (ADSLOTS[service] || []) : [];
    var hide = (HIDE[service] || []).filter(function (s) { return ads.indexOf(s) < 0; })
      .map(function (s) { return 'html[data-lumen-pv] ' + s; });
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
      if (read && read.desc && (read.desc.text || read.desc.meta)) {
        // its links: words and an address, both strings, capped (the page's word, never trusted as markup)
        var dl = Array.isArray(read.desc.links) ? read.desc.links.slice(0, DESC_LINKS_MAX).filter(function (l) {
          return l && typeof l.t === 'string' && typeof l.h === 'string' && l.t && l.h && l.t.length <= 500 && l.h.length <= 4000;
        }).map(function (l) { return { t: l.t, h: l.h }; }) : [];
        out.desc = { text: String(read.desc.text || ''), meta: String(read.desc.meta || ''), links: dl };
      }
      out.signedIn = read ? (read.signedIn === true ? true : read.signedIn === false ? false : null) : null;
      ['like', 'dislike', 'sub', 'save'].forEach(function (k) {
        var b = read && read[k];
        out.buttons[k] = b && b.found ? { found: true, on: !!b.on, count: b.count || '', label: b.label || '' } : { found: false };
        if (read && !(b && b.found)) out.missing.push(k);
      });
      out.comments = read && read.comments ? read.comments : null;
      // the page was still drawn for the last video (readYT: stale): what's missing is missing for that reason
      out.stale = !!(read && read.stale);
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

  /**
   * Whether the info's lumen-pv-info says early (watch-comments.js then waits for the view's next draw instead of
   * asking for the comments itself): only while the reads that will replace the early words are still to come
   * (phase 'loading'). An early read stays the info's read until a later one lands; when every read after it
   * failed (took: the last one's catch), the reads are over, the info says 'unread' and why, and early:true there
   * left the comments "Loading…" for good with no reason. Ended reads ('unread', 'partial', 'ready', 'failed',
   * 'offline') say false: the comments start, from the page's own data or /next, or show their own reason.
   */
  function infoEarly(phase, read) {
    return !!(read && read.early) && phase === 'loading';
  }

  /** The words for a disabled button or a note under the row, or '' when it can be pressed. */
  function whyOff(m, key, phase) {
    if (phase === 'offline') return 'You’re offline';
    if (m.signedIn === false) return 'Sign in to YouTube to ' + ({ like: 'like', dislike: 'dislike', sub: 'subscribe', save: 'save' })[key];
    var b = m.buttons[key];
    if (!b || !b.found) {
      if (phase === 'loading') return 'Reading YouTube’s page…';
      if (m.stale) return 'YouTube’s page still showed the last video when Lumen last read it';
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
  function guest(GAP) {
    var V = 8;   // 5: the description's links (desc.links) and seek(); 6: watch(); 7: a stale watch page is not read (readYT); 8: playerFor
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
            out.descLinks = runLinks(s.attributedDescription);
          }
          if (sec && sec.sectionIdentifier === 'comment-item-section') {
            var ci = (sec.contents || [])[0];
            var tok = ci && ci.continuationItemRenderer && ci.continuationItemRenderer.continuationEndpoint && ci.continuationItemRenderer.continuationEndpoint.continuationCommand;
            // capped well above a real token's length (a cut one would fail): watch-comments.js asks the page itself for one this long
            if (tok && tok.token) out.comments = { token: String(tok.token).slice(0, 4000) };
          }
        });
      } catch (e) { /* a shape Lumen doesn't know: the DOM's word only */ }
      return out;
    }
    /** A command's address (urlEndpoint, watchEndpoint with its start, browseEndpoint, its metadata), or ''. */
    function cmdUrl(c) {
      var x = c && (c.innertubeCommand || c);
      if (!x || typeof x !== 'object') return '';
      if (x.urlEndpoint && x.urlEndpoint.url) return String(x.urlEndpoint.url);
      if (x.watchEndpoint && x.watchEndpoint.videoId) {
        var sts = x.watchEndpoint.startTimeSeconds;   // 0 is a real time ("0:00"): it seeks, it never reloads
        var hasT = sts !== undefined && sts !== null && sts !== '' && isFinite(Number(sts)) && Number(sts) >= 0;
        return '/watch?v=' + encodeURIComponent(x.watchEndpoint.videoId) + (hasT ? '&t=' + Math.floor(Number(sts)) + 's' : '');
      }
      if (x.browseEndpoint && x.browseEndpoint.canonicalBaseUrl) return String(x.browseEndpoint.canonicalBaseUrl);
      // the page's own address next (a hashtag is browseId "FEhashtag" + params: its address is /hashtag/<tag>,
      // never /channel/FEhashtag, which a real-YouTube probe showed); a bare browseId is a channel last
      var w = x.commandMetadata && x.commandMetadata.webCommandMetadata && x.commandMetadata.webCommandMetadata.url;
      if (w) return String(w);
      if (x.browseEndpoint && x.browseEndpoint.browseId && /^UC/.test(x.browseEndpoint.browseId)) return '/channel/' + encodeURIComponent(x.browseEndpoint.browseId);
      return '';
    }
    /** ytInitialData's description links (commandRuns over its content) as [{ t: words, h: address }]. */
    function runLinks(ad) {
      if (!ad || typeof ad.content !== 'string' || !Array.isArray(ad.commandRuns)) return [];
      return ad.commandRuns.slice().sort(function (a, b) { return (a.startIndex || 0) - (b.startIndex || 0); }).map(function (r) {
        return { t: ad.content.substr(Number(r.startIndex) || 0, Number(r.length) || 0).trim(), h: cmdUrl(r.onTap) };
      }).filter(function (l) { return l.t && l.h; }).slice(0, 300);
    }
    /**
     * The description's own links as [{ t: their words as shown, h: the raw href }], in page order. The raw
     * attribute, not a.href: YouTube writes its own pages relative ("/watch?v=…&t=83s", "/@handle"), and the
     * chrome reads them as youtube.com's whatever origin the page is served from.
     */
    function descLinks(root) {
      if (!root) return [];
      return QA('a[href]', root).slice(0, 300).map(function (a) {
        return { t: String(a.innerText || a.textContent || '').trim(), h: String(a.getAttribute('href') || '') };
      }).filter(function (l) { return l.t && l.h; });
    }
    /**
     * A time in this video (a chapter, a timestamp in the description): the page's own player seeks and plays,
     * the path the comments' timestamps take (#movie_player.seekTo, the <video> as its fallback). Never a load.
     */
    function seek(t) {
      var n = Math.max(0, Number(t) || 0);
      var mp = Q('#movie_player');
      if (mp && mp.classList && mp.classList.contains('ad-showing')) return { ok: false, reason: 'an ad is playing; the time works once it ends' };
      if (mp && typeof mp.seekTo === 'function') {
        mp.seekTo(n, true);
        try { if (typeof mp.playVideo === 'function') mp.playVideo(); } catch (e) { /* the <video> below */ }
        var pv = Q('#movie_player video');
        if (pv && pv.paused) { var pp = pv.play(); if (pp && pp.catch) pp.catch(function () { /* the player said no: it stays paused at the time */ }); }
        return { ok: true, how: 'player' };
      }
      var v = Q('#movie_player video') || Q('video');
      if (!v) return { ok: false, reason: 'there is no video on the page' };
      v.currentTime = n;
      if (v.paused) { var vp = v.play(); if (vp && vp.catch) vp.catch(function () { /* stays paused at the time */ }); }
      return { ok: true, how: 'video' };
    }
    /** The player's own title and channel for video id (getPlayerResponse's videoDetails, else getVideoData), or null. */
    function playerFor(id) {
      var mp = Q('#movie_player');
      if (!mp || !id) return null;
      try {
        var pr = typeof mp.getPlayerResponse === 'function' ? mp.getPlayerResponse() : null;
        var vd = pr && typeof pr === 'object' ? pr.videoDetails : null;
        if (vd && vd.videoId === id && vd.title) return { title: String(vd.title).slice(0, 500), author: String(vd.author || '').slice(0, 200), channelId: String(vd.channelId || '') };
        var gd = typeof mp.getVideoData === 'function' ? mp.getVideoData() : null;
        if (gd && gd.video_id === id && gd.title) return { title: String(gd.title).slice(0, 500), author: String(gd.author || '').slice(0, 200), channelId: '' };
      } catch (e) { /* the page's words only */ }
      return null;
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
      // A watch page still drawn for ANOTHER video (r64). After an in-place move (Up next's Play now, YouTube's own
      // autoplay, an end-screen card) YouTube changes the address at once but redraws its watch page only once the
      // next video's data is in: seconds later (2.8-4.8 s in a real-YouTube probe). Until then the title, the
      // channel, the description, Like and Subscribe on the page are all the LAST video's, and ytd-watch-flexy still
      // names that video in its video-id. A read in that gap took them for this video's, found them complete, and the
      // reads stopped: the next video played under the last one's info for good. So while the flexy names another
      // video, nothing the DOM says about the video is taken (document.title neither: YouTube sets it from the same
      // data): the read has only what is checked to be this id's (dataFor), complete() stays false, the watch below
      // catches the redraw, and the read says stale (the chrome says why if it never comes). A flexy with no video-id
      // (an older layout, a page still opening, the test pages) is read as before: there is nothing to compare.
      var fx = Q('ytd-watch-flexy');
      var drawnId = fx && typeof fx.getAttribute === 'function' ? String(fx.getAttribute('video-id') || '') : '';
      var stale = !!(id && drawnId && drawnId !== id);
      var m = stale ? null : md(), ow = stale ? null : owner();
      var d = dataFor(id);
      var title = stale ? '' : txt(Q('#title h1', m)) || txt(Q('h1.ytd-watch-metadata', m));
      var chA = stale ? null : Q('#channel-name #text a', ow) || Q('#channel-name a', ow) || Q('#upload-info a', ow);
      var ch = chA ? { name: txt(chA), url: chA.href || '', subs: txt(Q('#owner-sub-count', ow)), avatar: (Q('#avatar img', ow) || {}).src || '' } : null;
      if (ch && d.channel) { if (!ch.subs) ch.subs = d.channel.subs; if (!ch.avatar) ch.avatar = d.channel.avatar; }
      var descEl = stale ? null : Q('#description-inline-expander yt-attributed-string', m) || Q('#description #snippet-text', m) || Q('#description-inline-expander', m);
      var lb = stale ? null : likeBtn(), db = stale ? null : dislikeBtn(), sb = stale ? null : subBtn(), vb = stale ? null : saveBtn();
      // The player moves on before the page does (a real-YouTube probe, r64: getVideoData() named the new id 1-1.3 s
      // before the page redrew; the redraw itself came 2.8-4.8 s after the address). While the page is stale, the
      // player's own title and channel stand in, for THIS id only (playerFor checks it). No buttons, so complete()
      // stays false and the reads go on to the redraw, which brings the description and the buttons.
      var pl = stale ? playerFor(id) : null;
      if (pl) {
        title = pl.title;
        if (pl.author) ch = { name: pl.author, url: /^UC[\w-]+$/.test(pl.channelId) ? 'https://www.youtube.com/channel/' + pl.channelId : '', subs: '', avatar: '' };
      }
      return {
        ok: true, svc: 'youtube', url: location.href, videoId: id, signedIn: signed, pageTitle: stale ? '' : document.title,
        stale: stale, drawnId: drawnId,
        title: title || d.title || '', titleFrom: title ? (pl ? 'player' : 'page') : (d.title ? 'ytInitialData' : ''),
        channel: ch || d.channel || null,
        desc: (function () {
          var domText = descEl ? (descEl.innerText || txt(descEl)) : '';
          var links = domText ? descLinks(descEl) : [];
          // the DOM drew no links (an older layout, links not drawn yet): ytInitialData's runs (for this video only,
          // dataFor checks); their words are looked for in the text, so a run whose words differ is just text
          if (!links.length && d.descLinks && d.descLinks.length) links = d.descLinks;
          return { text: domText || d.desc || '', meta: (stale ? '' : txt(Q('#info-container #info', m)) || txt(Q('#info-container', m))) || d.meta || '', links: links };
        })(),
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
    // The last read handed to the chrome, as words: watch() answers only with something it hasn't seen.
    var lastSig = '';
    function tick(svc, on) { var a = apply(svc, on); var r = read(svc); lastSig = JSON.stringify(r) + '|' + a.on; r.applied = a.on; r.how = a.how || ''; return r; }
    /* A read as soon as the page draws something new (watch-playview.js WATCH_MS): its own DOM changes, coalesced
       to one read per GAP ms (YouTube's player redraws its clock every second; of the attributes only video-id is
       watched: ytd-watch-flexy's turning to this video ends a stale read (readYT) even if its text came first),
       answered with the first read that differs from the last one handed out, or the read at ms. The observer
       goes with the answer. It only READS: the trim is the chrome's to set (tick / apply), never a watch's, so a
       watch still out after the chrome gave up on the player ("the whole page shows") or after Full page was
       pressed can't trim the page behind its back. A player that turns up is said (canRoot); the chrome trims. */
    function peek(svc) {
      var r = read(svc), html = document.documentElement;
      var on = html.hasAttribute('data-lumen-pv') && !!Q('[data-lumen-pv-root]');
      r.sig = JSON.stringify(r) + '|' + on;
      r.applied = on;
      r.canRoot = !on && !!findRoot(svc);
      return r;
    }
    function watch(svc, on, ms) {
      return new Promise(function (ok) {
        var mo = null, t = 0, end = 0, over = false;
        function finish(r) { if (over) return; over = true; if (mo) mo.disconnect(); clearTimeout(t); clearTimeout(end); ok(r); }
        function look() {
          t = 0;
          var r = peek(svc), j = r.sig;
          delete r.sig;
          // new to the chrome: what the info shows changed, or a player it wants trimmed is there now
          if (j !== lastSig || (on && r.canRoot)) { lastSig = j; finish(r); }
        }
        end = setTimeout(function () { var r = peek(svc); lastSig = r.sig; delete r.sig; finish(r); }, Math.max(100, Number(ms) || 0));
        try {
          mo = new MutationObserver(function () { if (!t && !over) t = setTimeout(look, GAP); });
          mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['video-id'] });
        } catch (e) { /* the timer answers */ }
        look();
      });
    }
    /* early(ms): the info's words from ytInitialPlayerResponse.videoDetails as soon as the parser has passed it,
       for THIS address's video only (an in-page move keeps the first video's object: never shown for another id),
       or null by DOMContentLoaded / ms (the reads at dom-ready take over). Nothing on the page is touched. */
    function early(ms) {
      return new Promise(function (ok) {
        var mo = null, end = 0, over = false;
        function finish(r) {
          if (over) return; over = true;
          if (mo) mo.disconnect(); clearTimeout(end);
          try { document.removeEventListener('DOMContentLoaded', last); } catch (e) { /* gone */ }
          ok(r);
        }
        function look() {
          var u; try { u = new URL(location.href); } catch (e) { return null; }
          var id = u.searchParams.get('v') || ((/^\/live\/([^/?#]+)/.exec(u.pathname) || [])[1]) || '';
          var pr = window.ytInitialPlayerResponse, vd = pr && typeof pr === 'object' ? pr.videoDetails : null;
          if (!id || !vd || vd.videoId !== id || !vd.title) return null;
          var signed = null;
          try { if (window.ytcfg && typeof window.ytcfg.get === 'function') { var li = window.ytcfg.get('LOGGED_IN'); if (typeof li === 'boolean') signed = li; } } catch (e) { signed = null; }
          return { ok: true, early: true, svc: 'youtube', url: location.href, videoId: id, signedIn: signed, pageTitle: document.title,
            title: String(vd.title || '').slice(0, 500), titleFrom: 'player',
            channel: vd.author ? { name: String(vd.author).slice(0, 200), url: /^UC[\w-]+$/.test(String(vd.channelId || '')) ? 'https://www.youtube.com/channel/' + vd.channelId : '', subs: '', avatar: '' } : null,
            desc: { text: String(vd.shortDescription || '').slice(0, 10000), meta: '', links: [] },
            like: { found: false }, dislike: { found: false }, sub: { found: false }, save: { found: false }, comments: null, root: false, on: false, applied: false };
        }
        function try1() { var r = look(); if (r) finish(r); }
        function last() { finish(look()); }
        end = setTimeout(last, Math.max(100, Number(ms) || 0));
        try { document.addEventListener('DOMContentLoaded', last); } catch (e) { /* the timer answers */ }
        try { mo = new MutationObserver(try1); mo.observe(document.documentElement || document, { childList: true, subtree: true }); } catch (e) { /* the timer answers */ }
        try1();
      });
    }
    window.__lumenPv = { v: V, apply: apply, read: read, press: press, seek: seek, tick: tick, watch: watch, early: early };
  }
  var GUEST = '(' + String(guest) + ')(' + WATCH_GAP_MS + ');';
  function call(method, args) {
    return GUEST + 'window.__lumenPv.' + method + '(' + (args || []).map(function (a) { return JSON.stringify(a === undefined ? null : a); }).join(',') + ')';
  }

  /*
   * A slot's calls into its page, each with an end (r64). A <webview>'s executeJavaScript into a page that goes away
   * (the slot closed and its view removed, or a new document) may never answer, and every .then waiting on it kept
   * what it touched alive: the slot, its tile, the info and the comments' mount under it. lumen-perf measured +650
   * nodes and +160 listeners per video view opened and closed, once the watch's and the early read's long waits (r64:
   * WATCH_MS, EARLY_MS) left one out at nearly every close; the view before r64 stayed flat.
   * run(pr, ms) answers with the page's answer, or fails at ms ("the page didn't answer in N s", code 'late') or at
   * close() ("the view is closed", code 'closed'), whichever comes first. An answer after that is dropped, never
   * applied. Only the gate's own end waits on the page's promise (no slot, no view, no node), so a page that never
   * answers holds nothing of a closed view. ms 0: no limit, close() only.
   */
  function gate() {
    var out = [], shut = false;
    function err(code, msg) { var e = new Error(msg); e.code = code; return e; }
    function run(pr, ms) {
      if (shut) return Promise.reject(err('closed', 'the view is closed'));
      return new Promise(function (ok, no) {
        var t = 0, over = false;
        function end(fn, x) {
          if (over) return;
          over = true;
          clearTimeout(t);
          var i = out.indexOf(stop);
          if (i >= 0) out.splice(i, 1);
          fn(x);
        }
        function stop() { end(no, err('closed', 'the view is closed')); }
        out.push(stop);
        if (ms > 0) t = setTimeout(function () { end(no, err('late', 'the page didn’t answer in ' + (Math.round(ms / 100) / 10) + ' s')); }, ms);
        Promise.resolve(pr).then(function (r) { end(ok, r); }, function (e) { end(no, e); });
      });
    }
    function close() { shut = true; var l = out; out = []; l.forEach(function (f) { f(); }); }
    return { run: run, close: close, open: function () { return out.length; }, shut: function () { return shut; } };
  }

  var PURE = { NAMES: NAMES, PEEK: PEEK, READS: READS, STALE_MS: STALE_MS, HIDE: HIDE, ADSLOTS: ADSLOTS, BAR: BAR, KEEP: KEEP, pageKind: pageKind, viewable: viewable, boxedFor: boxedFor, trimCss: trimCss,
    epParts: epParts, cleanPageTitle: cleanPageTitle, model: model, complete: complete, infoEarly: infoEarly, whyOff: whyOff, guest: guest, call: call, gate: gate,
    ytId: ytId, ytMoved: ytMoved, tSeconds: tSeconds, clockSeconds: clockSeconds, descLink: descLink, descSegs: descSegs, clock: clock };
  if (typeof document === 'undefined' || typeof window === 'undefined') return PURE;

  /* ================================================================ the chrome */

  var api = window.api && window.api.lumenPlayview;
  var PREF = 'lumen';
  var CTX = null;
  var obs = null;
  var all = [];   // slots this file has seen (the e2e's _state)

  // Quartz's ad blocker, for the trim's ad-slot rules (ADSLOTS). Assumed ON until main answers,
  // so a page that loads first gets today's trim and never flashes an ad slot. Read once through
  // the existing window.api.adblock.state() and kept current by its onStateChanged push; a change
  // applies from the next page the view trims (CSS already in a page stays as it was put in).
  var adblockOn = true;
  (function () {
    var ab = window.api && window.api.adblock;
    function take(st) { if (st && typeof st.enabled === 'boolean') adblockOn = st.enabled; }
    if (!ab || typeof ab.state !== 'function') {
      console.warn('[lumen-playview] window.api.adblock is missing: the ad-slot trim stays on');
      return;
    }
    try {
      var pr = ab.state();
      if (pr && pr.then) pr.then(take, function (e) { console.warn('[lumen-playview] couldn’t read the ad blocker’s state, the ad-slot trim stays on: ' + ((e && e.message) || e)); });
    } catch (e) { console.warn('[lumen-playview] couldn’t read the ad blocker’s state, the ad-slot trim stays on: ' + ((e && e.message) || e)); }
    try { if (typeof ab.onStateChanged === 'function') ab.onStateChanged(take); } catch (e) { console.warn('[lumen-playview] couldn’t follow the ad blocker’s changes (the first read still holds): ' + ((e && e.message) || e)); }
  })();

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
  /** Every call into a page goes through its slot's gate (gate(): destroy() ends what is still out, and each has a
   *  limit): ms is the call's own wait in the page plus LATE_MS; CALL_MS for one that runs at once there (a read,
   *  the trim, a seek), which waits only for the page's busy main thread. */
  var LATE_MS = 1000;
  var CALL_MS = 8000;
  function ask(s, v, code, ms) {
    var p = pvOf(s), pr = js(v, code);
    return p && p.gate ? p.gate.run(pr, ms || CALL_MS) : pr;
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
    // Never once the player wasn't found (noRoot): the bar has said "the whole page shows", and a later
    // update() trimming the page anyway left a bare player with no info and no way back (r62-playview).
    return p.mode === 'lumen' && viewable(kindOf(s)) && !s.multi && L.slots.length === 1 && !s.blocked && !p.noRoot;
  }

  function attach(ctx, s, v) {
    CTX = ctx;
    observeLayer();
    var p = s._pv = { mode: PREF, userMode: false, phase: 'loading', read: null, applied: false, noRoot: false, why: '', busy: '', seq: 0, page: 0, navUrl: '',
      timers: [], presses: [], item: s.item || null, itemUrl: s.url, confirm: false, save: null, more: false, info: null, cover: null, lastUrl: '',
      gate: gate(), gone: false };   // gate: its calls into the page (destroy() ends them); gone: destroyed
    all.push(s);
    if (all.length > 8) all.shift();
    p.cover = el('div', 'pv-cover');
    p.cover.appendChild(el('span', 'pv-cover-bar'));
    p.cover.appendChild(el('span', 'pv-cover-txt', 'Loading the player…'));
    p.info = el('div', 'pv-info');
    // No aria-live on the panel: it is rebuilt whole on each read or press, so a screen reader read the title,
    // channel and description out again every time. The one-line notes (.pv-why, role=status) say what changed.
    p.info.setAttribute('role', 'region');
    p.info.setAttribute('aria-label', 'About this video');
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
        var pr = v.insertCSS(trimCss(s.service, adblockOn));
        if (pr && pr.catch) pr.catch(function (e) { p.why = 'Lumen couldn’t trim the page: ' + ((e && e.message) || e); render(s); });
      } catch (e) { p.why = 'Lumen couldn’t trim the page: ' + ((e && e.message) || e); }
      startReads(s, false);
    });
    v.addEventListener('did-start-navigation', function (e) {
      // A move in the same document (YouTube's own autoplay, an end-screen card, Lumen's in-place move) is NOT a new
      // document: <webview>'s event names it isInPlace (isSameDocument is the webContents' name and is never set here,
      // r63 found the same in watch-shorts.js). Read as one, every in-place move brought the cover back and restarted
      // the reads from nothing; did-navigate-in-page below handles it (another video: newPage + reads; same: re-read).
      if (s.view !== v || !e.isMainFrame || e.isInPlace || e.isSameDocument) return;
      // A new document: the last one's reads, notes, press and "Show more" are not this page's. The
      // seq bump drops a read still out on the old page (it landed after this reset and set "ready").
      newPage(s);
      p.navUrl = String(e.url || '');
      p.applied = false; p.noRoot = false;
      update(s);
    });
    // The new document is in (commit): its first words, long before dom-ready (EARLY_MS). A YouTube video page only.
    v.addEventListener('did-navigate', function (e) {
      if (s.view !== v || s.service !== 'youtube' || pageKind(String((e && e.url) || ''), s.service) !== 'watch') return;
      earlyRead(s);
    });
    v.addEventListener('did-navigate-in-page', function (e) {
      if (s.view !== v || !e.isMainFrame) return;
      var url = String(e.url || '');
      // YouTube moving to ANOTHER video in the page (autoplay, an end-screen card): everything about the
      // last video goes, the player-not-found verdict too (the new one is looked for again). The lastUrl
      // check below must not swallow it: a read can land on the new address before this event does.
      if (s.service === 'youtube' && ytId(url) && ytId(url) !== ytId(p.navUrl || p.itemUrl)) {
        p.navUrl = url;
        newPage(s);
        p.noRoot = false;
        startReads(s, true);
        return;
      }
      p.navUrl = url;
      if (url === p.lastUrl) return;
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
    // Lumen's ambient field (watch-ambient.js): the video's colours behind the view.
    if (window.LumenAmbient) { try { window.LumenAmbient.attach(ctx, s, v); } catch (e) { /* the view stays as it was */ } }
  }

  function reuse(ctx, s) {
    var p = pvOf(s);
    if (!p) return;
    p.item = s.item || null;
    p.itemUrl = s.url;
    p.navUrl = '';
    if (!p.userMode) p.mode = PREF;
    newPage(s);
    update(s);
  }

  /**
   * The slot shows another page (a new document, a reuse, YouTube's move to another video): what Lumen
   * knew about the last one goes. stopReads + the seq bump: a read or a press still out on the old page
   * (p.page) is dropped when it lands, never written over the new one (it used to set "ready" with the old info,
   * or reopen the old Save list); busy goes too, so a press the old page never answered can't leave every
   * button "Waiting for YouTube…" on the new one.
   */
  function newPage(s) {
    var p = pvOf(s);
    if (!p) return;
    stopReads(s);
    p.seq++;
    p.page = (p.page || 0) + 1;
    clearTimeout(p.pressTimer);
    p.read = null; p.phase = 'loading'; p.why = ''; p.busy = ''; p.save = null; p.confirm = false; p.more = false;
  }

  function destroy(ctx, s) {
    if (window.LumenAmbient) { try { window.LumenAmbient.destroy(ctx, s); } catch (e) { /* gone */ } }
    if (window.LumenComments && window.LumenComments.forget) { try { window.LumenComments.forget(s.id); } catch (e) { /* gone */ } }   // its comments go too
    var p = pvOf(s);
    if (!p) return;
    stopReads(s);
    // Nothing of the closed view outlives it (gate): the calls still out on its page end now (one the page answers
    // later is dropped, never applied), the seq and page bumps drop any answer already on its way, gone stops a late
    // timer's render (the show page's, a held press's release) from drawing the info, and its comments' mount, again.
    // The info is emptied too, so if anything still holds the tile it holds no title, description or comments.
    p.gone = true;
    p.seq++;
    p.page = (p.page || 0) + 1;
    if (p.gate) p.gate.close();
    clearTimeout(p.pressTimer);
    clearTimeout(p.pressT);
    p.pressing = false; p.pendingRender = false;
    if (p.info) p.info.replaceChildren();
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
    p.watch = 0; p.reading = 0;   // a watch still out on the page is dropped when it lands (took: reading)
  }

  /** Read the page at READS after it loads (or moves in place), until it is all there. */
  function startReads(s, inPage) {
    var p = pvOf(s);
    if (!p) return;
    stopReads(s);
    var seq = ++p.seq;
    if (!online()) { p.phase = 'offline'; update(s); return; }
    p.reading = seq;
    p.readT0 = Date.now();   // STALE_MS counts from here (took: a stale last read)
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
    took(s, seq, v, on, ask(s, v, call('tick', [s.service, on])), last, false);
  }
  /** A read's answer (a timed read's, or a watch's): the info from it, and the next watch while it is incomplete. */
  function took(s, seq, v, on, pr, last, watched) {
    var p = pvOf(s);
    pr.then(function (r) {
      if (s.view !== v || p.seq !== seq) return;
      if (watched && p.reading !== seq) return;   // the reads are over (complete, or the last one said): it adds nothing
      if (!r || !r.ok) throw new Error('no answer from the page');
      // A watch saw the player turn up: the trim is the chrome's to set, so a read that sets it goes now (its
      // answer carries on from there); this answer is only words.
      if (watched && on && r.canRoot && !r.applied && wantTrim(s)) { tick(s, seq, false); return; }
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
      // The last timed read found the page still the last video's (readYT: stale). After an in-place move the reads
      // run at half their times (the last at 4 s), and a real-YouTube probe measured the redraw at 2.8-4.8 s: the
      // info ended "unread" for good while YouTube drew the video a moment later. So a stale last read goes on: the
      // watch stays out (it answers at the redraw: video-id, title and channel change in the same tick) and one more
      // read comes at STALE_MS after the reads began, a whole load's span, which says why if it is still stale.
      else if (last && r.stale && p.staleSeq !== seq && Date.now() - (p.readT0 || 0) < STALE_MS) {
        p.staleSeq = seq;
        p.timers.push(setTimeout(function () { tick(s, seq, true); }, Math.max(0, STALE_MS - (Date.now() - (p.readT0 || 0)))));
        watchRead(s, seq);
      }
      else if (last) { p.phase = s.service === 'youtube' && !(r.title || (r.channel && r.channel.name)) ? 'unread' : 'partial'; p.reading = 0; }
      else watchRead(s, seq);
      update(s);
    }).catch(function (e) {
      if (s.view !== v || p.seq !== seq) return;
      if (last) { p.phase = online() ? 'unread' : 'offline'; p.why = 'Lumen couldn’t read the page: ' + ((e && e.message) || e); update(s); }
    });
  }

  /**
   * The next read as soon as the page draws something new (WATCH_MS): one watch out at a time per page read
   * (p.watch holds its seq), none once the reads stop (complete, the last timed read, a new page: stopReads
   * drops p.watch). A watch that fails or never answers costs nothing: the timed reads still come.
   */
  function watchRead(s, seq) {
    var p = pvOf(s);
    if (!p || p.watch === seq || p.seq !== seq || p.reading !== seq || !s.view || !online()) return;
    var v = s.view, on = wantTrim(s);
    p.watch = seq;
    var pr = ask(s, v, call('watch', [s.service, on, WATCH_MS]), WATCH_MS + LATE_MS);
    var free = function () { if (p.watch === seq) p.watch = 0; };
    // freed before its answer is taken, so the answer can ask for the next watch
    took(s, seq, v, on, pr.then(function (r) { free(); return r; }, function (e) { free(); throw e; }), false, true);
  }

  /**
   * The early read (EARLY_MS): drawn only while no read of the page has landed yet, and dropped once the reads at
   * dom-ready start (startReads bumps seq) or the slot moves on (newPage). Its answer is words only; the comments
   * wait for the page's own data (watch-comments.js: early), so it never costs an extra /next. They wait only while
   * the reads are still to come (infoEarly): reads that all failed end the wait, never leave it "Loading…" for good.
   */
  function earlyRead(s) {
    var p = pvOf(s);
    if (!p || p.read || !s.view || !online()) return;
    var v = s.view, seq = p.seq;
    ask(s, v, call('early', [EARLY_MS]), EARLY_MS + LATE_MS).then(function (r) {
      if (s.view !== v || p.seq !== seq || p.read || !r || !r.ok || !r.early) return;
      p.read = r;
      update(s);
    }, function () { /* the reads at dom-ready say */ });
  }

  /** Classes, the trim and the info, from the slot's state. */
  function update(s) {
    var p = pvOf(s), L = layerOf();
    if (!p || !L || p.gone) return;
    var boxed = isBoxed(s);
    s.tile.classList.toggle('pv', boxed);
    layoutBox(s);
    s.tile.classList.toggle('pv-wait', boxed && !p.applied && p.phase !== 'failed' && p.phase !== 'offline');
    if (L.el && L.slots[L.focus] === s || (L.el && L.slots.length === 1)) L.el.classList.toggle('pv-on', boxed);
    // Clear the trim where the view no longer wants it (a grid, Full page); set it where it does.
    if (s.view && p.applied !== wantTrim(s) && (p.applied || p.phase !== 'loading')) {
      var v = s.view;
      var want = wantTrim(s);
      ask(s, v, call('apply', [s.service, want])).then(function (a) { if (s.view === v) { p.applied = !!(a && a.on); render(s); } }, function () { /* the next load says */ });
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
    // The press belongs to this page (p.page, bumped by newPage): an answer that lands after the page moved on is dropped. And it
    // gets PRESS_ANSWER_MS to answer: a page that never does (its frame replaced mid-press) used to keep
    // every button "Waiting for YouTube…" for the rest of the video, with nothing saying why.
    var page = p.page;
    var settled = false;
    var mine = function () { return s.view === v && p.page === page && !settled; };
    clearTimeout(p.pressTimer);
    p.pressTimer = setTimeout(function () {
      if (!mine()) return;
      settled = true;
      p.busy = '';
      rec.ok = false;
      rec.reason = 'no answer in ' + Math.round(PRESS_ANSWER_MS / 1000) + ' s';
      p.why = 'YouTube’s page didn’t answer in ' + Math.round(PRESS_ANSWER_MS / 1000) + ' s: the state shown is what its page last said';
      render(s);
    }, PRESS_ANSWER_MS);
    render(s);
    ask(s, v, call('press', [s.service, kind, arg === undefined ? null : arg]), PRESS_ANSWER_MS + LATE_MS).then(function (r) {
      if (!mine()) return;
      settled = true;
      clearTimeout(p.pressTimer);
      p.busy = '';
      rec.ok = !!(r && r.ok);
      rec.reason = (r && r.reason) || '';
      if (!r || !r.ok) p.why = (r && r.reason) ? r.reason.charAt(0).toUpperCase() + r.reason.slice(1) : 'YouTube’s page didn’t answer';
      else if (r.changed === false && kind !== 'save-open' && kind !== 'save-close') p.why = 'YouTube didn’t confirm it yet: the state shown is what its page says';
      if (kind === 'save-open' || kind === 'save-toggle') p.save = r && r.ok ? { list: r.list || [] } : null;
      if (kind === 'save-close') p.save = null;
      if (kind === 'unsubscribe') p.confirm = false;
      return ask(s, v, call('read', [s.service])).then(function (rr) { if (s.view === v && p.page === page && rr && rr.ok) p.read = rr; render(s); });
    }).catch(function (e) {
      if (s.view !== v || p.page !== page) return;
      // Past the gate's limit (ask) with the press already settled: PRESS_ANSWER_MS's note has said why, or the press
      // answered and only the read after it never came (the state shown is the press's, as it always was).
      if (e && e.code === 'late' && settled) return;
      // The press itself, or the read after it: either way the reason is shown (as before this guard).
      settled = true;
      clearTimeout(p.pressTimer);
      p.busy = '';
      rec.ok = false;
      rec.reason = (e && e.message) || String(e);
      p.why = 'YouTube’s page didn’t answer: ' + rec.reason;
      render(s);
    });
    return true;
  }

  /**
   * Esc (watch-player.js takeShortcut, after the play bar, fullscreen and a sheet): the Unsubscribe confirm
   * closes (nothing pressed), then YouTube's Save list (its own close, like Done). true = Esc was used here.
   */
  function escape(ctx, s) {
    var p = pvOf(s);
    if (!p || !s.tile.classList.contains('pv')) return false;
    if (p.confirm) { p.confirm = false; render(s); backToPlayer(s); return true; }
    if (p.save) { if (!p.busy) press(s, 'save-close'); backToPlayer(s); return true; }
    return false;
  }

  function backToPlayer(s) { if (s && s.view && !(pvOf(s) && pvOf(s).save)) { try { s.view.focus(); } catch (e) { /* gone */ } } }

  /* ---------------------------------------------------------------- the description's links */

  /** A link in the description, on the user's click or Enter (descLink's kinds). Each way it can't open says why, in a toast. */
  var linkLog = [];   // the e2e's view: what each activation did
  function linkSay(text) {
    if (CTX && typeof CTX.toast === 'function') CTX.toast(text, true);
    else console.warn('[lumen-playview] ' + text);
  }
  function openDescLink(s, l, words) {
    var rec = { kind: l.kind, href: l.href, t: l.t === undefined ? null : l.t, ok: null, why: '', at: Date.now() };
    linkLog.push(rec);
    if (linkLog.length > 20) linkLog.shift();
    var fail = function (why) { rec.ok = false; rec.why = why; linkSay(why); return false; };
    if (l.kind === 'time') {
      // In place: the page's own player seeks and plays. Never a load of the same video ("0:00" reloaded it in
      // the comments before r62). Focus stays on the link, so the next chapter is one Tab away.
      if (!s.view) return fail('Lumen couldn’t jump to ' + clock(l.t) + ': the video’s page is closed.');
      var v = s.view;
      ask(s, v, call('seek', [l.t])).then(function (r) {
        if (r && r.ok) { rec.ok = true; rec.how = r.how; return; }
        fail('Lumen couldn’t jump to ' + clock(l.t) + ': ' + ((r && r.reason) || 'YouTube’s page said no') + '.');
      }, function (e) { fail('Lumen couldn’t jump to ' + clock(l.t) + ': YouTube’s page didn’t answer (' + String((e && e.message) || e).slice(0, 80) + ').'); });
      return true;
    }
    if (l.kind === 'same') return fail('That link is the video that’s playing' + (words ? ' (' + String(words).slice(0, 60) + ')' : '') + ', so there is nothing new to open.');
    if (l.kind === 'yt') {
      // Lumen's own way in (watch-player.js openInLumen; the comments and the tiles use it): the page opens in
      // this player, and Back comes back. openInLumen says itself when it falls back to a tab.
      if (typeof window.openInLumen !== 'function') return openTab(rec, l.href, 'Lumen’s player isn’t loaded in this window, so the YouTube link opened in a Quartz tab.');
      var ok = false;
      try { ok = window.openInLumen(l.href, { service: 'youtube' }) !== false; } catch (e) { return fail('Lumen couldn’t open the YouTube link: ' + String((e && e.message) || e).slice(0, 80) + '.'); }
      rec.ok = ok;
      if (!ok) rec.why = 'openInLumen said no (its own toast says why)';
      return ok;
    }
    return openTab(rec, l.href, '');
  }
  /** Another site: a Quartz tab, in front (app.js createTab; the comments' links take the same path). */
  function openTab(rec, href, said) {
    var fail = function (why) { rec.ok = false; rec.why = why; linkSay(why); return false; };
    if (typeof window.createTab !== 'function') return fail('Quartz can’t open a tab from here, so ' + href.slice(0, 120) + ' didn’t open.');
    var tab = null;
    try { tab = window.createTab(href, { background: false }); } catch (e) { return fail('Quartz couldn’t open a tab for ' + href.slice(0, 120) + ': ' + String((e && e.message) || e).slice(0, 80) + '.'); }
    if (!tab) return fail('Quartz didn’t open a tab for ' + href.slice(0, 120) + '.');
    rec.ok = true;
    rec.how = 'tab';
    if (said) { rec.why = said; linkSay(said); }
    return true;
  }
  /**
   * The description's text as text nodes and <a> elements: every word from the page goes in through
   * textContent / createTextNode, never as markup. An <a> with an href: Tab reaches it and Enter presses it
   * (the browser's own), and its click never navigates the chrome (preventDefault; the middle button too).
   */
  function descText(s, dt, text, links, videoId) {
    descSegs(text, links, videoId).forEach(function (sg) {
      if (!sg.link) { dt.appendChild(document.createTextNode(sg.text)); return; }
      var l = sg.link;
      var a = el('a', 'pv-link pv-link-' + l.kind, sg.text);
      a.href = l.href;
      a.rel = 'noopener noreferrer';
      a.title = l.kind === 'time' ? 'Jump to ' + clock(l.t) : l.kind === 'same' ? 'This video' : l.kind === 'yt' ? 'Open in Lumen' : 'Open ' + l.href.slice(0, 200) + ' in a Quartz tab';
      a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openDescLink(s, l, sg.text); });
      a.addEventListener('auxclick', function (e) { e.preventDefault(); e.stopPropagation(); if (e.button === 1) openDescLink(s, l, sg.text); });
      a.addEventListener('dragstart', function (e) { e.preventDefault(); });   // a drop on the chrome would navigate it
      dt.appendChild(a);
    });
  }
  /**
   * While the description is clamped to three lines, a link in the hidden lines must not take Tab: focus on it
   * scrolled the clamped box under its own "Show more" and the focus ring sat out of sight. Measured once the
   * description is in the panel (render calls this after appending it; a frame callback never ran in a hidden
   * window, and ran on a zero-size box in a hidden panel). A box with no size yet goes by the text: a link after
   * the third line break is hidden. Show more draws them all reachable again.
   */
  function clampLinks(dt) {
    var links = dt.querySelectorAll('a.pv-link');
    if (!links.length || !dt.isConnected) return;
    var box = dt.getBoundingClientRect();
    if (box.height > 0) {
      [].forEach.call(links, function (a) {
        var r = a.getBoundingClientRect();
        if (r.top >= box.bottom - 1) a.tabIndex = -1; else a.removeAttribute('tabindex');
      });
      return;
    }
    var breaks = 0;
    [].forEach.call(dt.childNodes, function (n) {
      if (n.nodeType === 3) { breaks += (n.nodeValue.match(/\n/g) || []).length; return; }
      if (n.classList && n.classList.contains('pv-link')) { if (breaks >= 3) n.tabIndex = -1; else n.removeAttribute('tabindex'); }
    });
  }

  /* ---------------------------------------------------------------- the info */

  function render(s) {
    var p = pvOf(s);
    if (!p || !p.info || p.gone) return;   // a destroyed slot's info stays empty (destroy)
    var info = p.info;
    var boxed = s.tile.classList.contains('pv');
    p.cover.hidden = !(boxed && !p.applied && p.phase === 'loading');
    p.mount.hidden = !boxed;
    if (boxed) p.mount.id = 'lumen-pv-barmount'; else p.mount.removeAttribute('id');
    if (!boxed) { info.hidden = true; return; }
    info.hidden = false;
    var phase = !online() ? 'offline' : p.phase;
    // Moved on from the opened title: YouTube by video id, from the slot's own address (known the moment the page
    // moves, before any read lands); the others by the read's address, as before.
    var moved = s.service === 'youtube' ? ytMoved(p.itemUrl, s.url) :
      !!(p.read && p.read.url && p.itemUrl && stripT(p.read.url) !== stripT(p.itemUrl));
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
        p.lastShowPage || 0, !!p.spOpening, it.id, it.title, it.subtitle, p.read]);
    } catch (e) { return ''; }
  }
  function stripT(u) { return String(u || '').replace(/[?&]t=\d+s?/, ''); }

  function titleEl(text, phase) {
    var h = el('h1', 'pv-title');
    // dir=auto: an Arabic or Hebrew title reads in its own direction. title: the clamp cuts a long one at two
    // lines, so the whole of it is on hover.
    h.dir = 'auto';
    if (text) { h.textContent = text; h.title = text; }
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
    // The reads ended on a page still drawn for the last video (readYT: stale): the channel, description and buttons
    // are missing for that reason, said before "signed out" (which would leave the missing channel unexplained).
    else if ((phase === 'unread' || phase === 'partial') && m.stale) note(info, 'YouTube’s page still showed the last video’s details when Lumen last read it, so this video’s aren’t here'
      + (m.title && m.titleFrom === 'item' ? '; the title is from Lumen’s row' : m.title && m.titleFrom === 'player' ? '; the title and channel are from YouTube’s player' : '') + '. “Full page” shows YouTube’s own.', 'warn');
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
        var dt = el('div', 'pv-desc-text');
        dt.dir = 'auto';   // a right-to-left description reads in its own direction
        // its links, chapter times and addresses work in Lumen (descText: DOM nodes only, never the page's markup)
        descText(s, dt, m.desc.text, m.desc.links, m.videoId);
        d.appendChild(dt);
        if (m.desc.text.length > 180 || /\n/.test(m.desc.text)) {
          var more = button('pv-ghost pv-more', p.more ? 'Show less' : 'Show more', function () { p.more = !p.more; render(s); });
          more.setAttribute('aria-expanded', p.more ? 'true' : 'false');
          d.appendChild(more);
        }
      }
      info.appendChild(d);
      if (dt && !p.more) clampLinks(dt);   // in the panel now: measured
    }
    // A spot for Lumen-drawn comments (a later module fills it; see LumenPlayview.commentsSpot).
    var cm = el('section', 'pv-comments');
    cm.id = 'lumen-pv-comments';
    cm.setAttribute('data-video-id', m.videoId || '');
    cm.setAttribute('data-wc-id', s.wcId === null || s.wcId === undefined ? '' : String(s.wcId));
    cm.setAttribute('aria-label', 'Comments');
    cm.hidden = true;
    info.appendChild(cm);
    // view + toggle: for watch-comments.js (its reads in the page, and "Open comments on YouTube" = Full page).
    try { document.dispatchEvent(new CustomEvent('lumen-pv-info', { detail: { slot: s.id, wcId: s.wcId, videoId: m.videoId, comments: m.comments, signedIn: m.signedIn, early: infoEarly(p.phase, p.read), container: cm,
      view: s.view, toggle: function () { return toggle(s); } } })); } catch (e) { /* no listeners */ }
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
    var sp = button('pv-showpage', p.spOpening ? 'Opening…' : 'Show page', function (b) { showPage(s, b); }, 'Open ' + (m.title || 'this title') + '’s show page in Lumen');
    row.appendChild(sp);
    info.appendChild(row);
    showPageCheck(s, sp, m);
    if (p.spOpening) disable(sp, 'Opening…');
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
    // The answer is filed under the title it was asked for: a reuse can swap p.item while the check is out.
    var askedId = p.item.id;
    ask(s, ov, showPageJs(p.item, false), SHOW_PAGE_ANSWER_MS + LATE_MS).then(function (r) {
      p.spKnown = { id: askedId, ok: !!(r && r.ok), reason: (r && r.reason) || 'Lumen has no show page for this title' };
      if (b.isConnected) disable(b, p.spKnown.ok ? '' : p.spKnown.reason);
    }, function (e) { p.spKnown = { id: askedId, ok: false, reason: 'Lumen couldn’t check: ' + ((e && e.message) || e) }; if (b.isConnected) disable(b, p.spKnown.reason); });
  }
  /** The show page in the Lumen tab; the player keeps playing in the mini-player (or closes, without it). */
  // A press never does nothing: it says "Opening…" (p.spOpening, in the render key, so a rebuild keeps it), and
  // every way it can end without the show page puts the reason under the title.
  function showPage(s, b) {
    var p = pvOf(s), ov = ownerView();
    if (!p) return;
    if (!p.item) { p.why = 'Lumen has no show page for this title'; render(s); return; }
    if (!ov) { p.why = 'The show page didn’t open: the Lumen tab isn’t there'; render(s); return; }
    if (p.spOpening) return;   // already on its way (the button says "Opening…")
    p.why = '';
    p.spOpening = true;
    var done = false, t = 0;
    var settle = function () { if (done) return false; done = true; clearTimeout(t); p.spOpening = false; return true; };
    t = setTimeout(function () {
      if (!settle()) return;
      p.why = 'The show page didn’t open: the Lumen tab didn’t answer in ' + Math.round(SHOW_PAGE_ANSWER_MS / 1000) + ' s';
      render(s);
    }, SHOW_PAGE_ANSWER_MS);
    render(s);
    ask(s, ov, showPageJs(p.item, true), SHOW_PAGE_ANSWER_MS + LATE_MS).then(function (r) {
      if (!settle()) return;
      if (!r || !r.ok) { p.why = (r && r.reason) || 'The show page didn’t open'; render(s); return; }
      p.lastShowPage = Date.now();
      render(s);
      var mini = CTX && CTX.L && CTX.L.el ? CTX.L.el.querySelector('.mv-minibtn') : null;
      if (mini && !mini.disabled && !mini.hidden) mini.click();
      else if (CTX && CTX.close) CTX.close('Show page');
    }, function (e) { if (!settle()) return; p.why = 'The show page didn’t open: ' + ((e && e.message) || e); render(s); });
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
  // A <webview> taking the focus (a player page's first dom-ready, the window's focus coming back to a page)
  // blurs this window while his button is still down here: that is not a release. Taking it for one ran the
  // held rebuild mid-press, and the release then landed on a new button: no click, nothing said ("Show page"
  // did nothing, r62-showpage). The pointerup still comes here (the press captured the mouse); a release this
  // window never hears (he switched windows) is PRESS_HOLD_MAX_MS's job.
  window.addEventListener('blur', function () {
    var a = document.activeElement;
    if (a && a.tagName === 'WEBVIEW') return;
    released();
  });

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
      phase: p.phase, applied: p.applied, noRoot: p.noRoot, why: p.why, busy: p.busy, presses: p.presses.slice(), confirm: p.confirm, save: p.save, pressing: !!p.pressing,
      view: rect(s.view), tile: rect(s.tile), info: m ? rect(m) : null, cover: p.cover && !p.cover.hidden,
      title: q('.pv-title') ? q('.pv-title').textContent : '', channel: q('.pv-chan-name') ? q('.pv-chan-name').textContent : '', subs: q('.pv-subs') ? q('.pv-subs').textContent : '',
      ep: q('.pv-ep') ? q('.pv-ep').textContent : '', svc: q('.pv-svc-name') ? q('.pv-svc-name').textContent : '',
      note: q('.pv-why') ? q('.pv-why').textContent : '', like: b('.pv-like'), dislike: b('.pv-dislike'), sub: b('.pv-sub'), savebtn: b('.pv-save'), showPage: b('.pv-showpage'),
      desc: q('.pv-desc') ? q('.pv-desc').textContent : '', comments: !!q('#lumen-pv-comments'), read: p.read,
      links: m ? [].map.call(m.querySelectorAll('.pv-desc-text a.pv-link'), function (a) { return { text: a.textContent, kind: (/pv-link-(\w+)/.exec(a.className) || [])[1] || '', href: a.getAttribute('href'), tab: a.tabIndex }; }) : [],
      descHtml: q('.pv-desc-text') ? q('.pv-desc-text').innerHTML.slice(0, 4000) : '', linkLog: linkLog.slice()
    };
  }

  return Object.assign({}, PURE, {
    // watch-player.js X() hooks
    attach: attach, reuse: reuse, destroy: destroy, sync: sync, stateActs: stateActs, escape: escape,
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
