'use strict';
/*
 * watch/shape.js -- the one contract every part of Watch agrees on: the
 * services, the item shape, the sports-event shape and the read states. Pure
 * functions and tables; nothing here talks to Electron, the DOM or the network.
 *
 * Watch is Quartz's streaming hub (watch.html). It merges the user's OWN rows from
 * the services he is signed in to in Quartz (Continue watching, For You,
 * Watchlist), ESPN's public scoreboard, and per-service rows, and a click opens
 * the title on the service's own page. Read-only: no playback, no downloads,
 * no DRM work. The data never leaves the PC.
 *
 * Loads three ways, like drm-sites.js:
 *   - require('./watch/shape') in main (watch-main.js) and the tests
 *   - <script src="watch/shape.js"> in watch.html (window.WatchShape)
 *   - the adapters in watch/adapters/ require it for cleanItem()/cleanEvent()
 *
 * ITEM (what an adapter returns, what the cache keeps, what the page draws):
 *   {
 *     id:        'youtube:dQw4w9WgXcQ'    service + ':' + the service's own id (unique per service)
 *     service:   'youtube' | 'disney' | 'hulu' | 'prime' | 'espn'
 *     kind:      'resume' | 'rec' | 'watchlist' | 'live' | 'upcoming' | 'replay' | 'search'
 *     title:     plain text, <= 200 chars                       (required)
 *     subtitle:  plain text, <= 200 chars ('S2 E4', channel, network)
 *     image:     https URL of a 16:9 still/thumbnail, or ''
 *     images:    optional, only when there is more than one: art candidates sharpest first,
 *                images[0] === image (YouTube: ytThumbs()); the page steps down on a miss
 *     progress:  0..1 watched, or null (resume rows; null = unknown)
 *     url:       https URL on the service's own site            (required)
 *     startsAt:  epoch ms for live/upcoming, or null
 *     durationSec: whole seconds or null
 *     badge:     short label <= 24 chars ('Rent', 'ESPN+', 'Hulu', 'Live') or ''
 *     group:     the service's own row name ('Because you watched Bluey') or ''
 *     edge:      true when the click opens Microsoft Edge (protected video); set by cleanItem
 *     year:      the film's release year, or the show's first year, or null when the service did not say
 *     type:      'movie' | 'show' (a series, or an episode of one: the tile's title is the show) | ''
 *   }
 *   year + type + title are what tells two services' copies of one title apart (Hulu on hulu.com and
 *   the same title inside Disney+): an adapter sets them only from the service's own fields, never a guess.
 *
 * SPORTS EVENT (ESPN; the Live & Upcoming strip):
 *   {
 *     id: 'espn:401892517', league: 'nhl', leagueName: 'NHL',
 *     state: 'pre' | 'in' | 'post', startsAt: ms, detail: 'Final/OT' | '2nd 12:31' | '7:00 PM PDT',
 *     home: { name, abbr, logo, score, record }, away: { ... },  (score '' before the game)
 *     broadcasts: ['ESPN+', 'TNT'], watchUrl: 'https://www.espn.com/watch/player?id=..' | '',
 *     gamecastUrl: 'https://www.espn.com/nhl/game/_/gameId/401892517', locked: bool|null
 *   }
 *
 * PARSE RESULT (what adapter.parse(read) returns):
 *   { state: 'ok' | 'signed-out' | 'error', reason: '' | plain words, items: [ITEM], profile: '' | name,
 *     events?: [SPORTS EVENT] (espn only), counts?: {} }
 *   A reason is a sentence fragment that reads after "Couldn't read <Service>: " -- e.g.
 *   "the page loaded but no Continue Watching data matched (Disney+ changed its layout?)".
 */
(function () {
  /*
   * The services Watch knows. `order` is the accounts strip and the per-service
   * rows. `everyMin` is the polite floor between two reads while Watch is open
   * (every service 15 min since 10-17, measured in watch-auto; ESPN 2 while a game
   * it shows is live). `edge` = its player needs Widevine, so a click opens
   * Microsoft Edge (Quartz's existing "Open in Edge" path, drm-main.js).
   */
  var SERVICES = [
    {
      id: 'youtube', name: 'YouTube', short: 'YouTube', edge: false, everyMin: 15, needsSignIn: true,
      home: 'https://www.youtube.com/',
      signIn: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F',
      searchUrl: 'https://www.youtube.com/results?search_query=',
      covers: ''
    },
    {
      id: 'disney', name: 'Disney+', short: 'Disney+', edge: true, everyMin: 15, needsSignIn: true,
      home: 'https://www.disneyplus.com/home',
      signIn: 'https://www.disneyplus.com/login',
      searchUrl: 'https://www.disneyplus.com/search?q=',
      covers: 'Includes Hulu (once your Hulu profile is linked) and the ESPN hub'
    },
    {
      id: 'prime', name: 'Prime Video', short: 'Prime', edge: true, everyMin: 15, needsSignIn: true,
      home: 'https://www.primevideo.com/',
      signIn: 'https://www.primevideo.com/',
      searchUrl: 'https://www.primevideo.com/search/ref=atv_nb_sr?phrase=',
      covers: ''
    },
    {
      id: 'espn', name: 'ESPN', short: 'ESPN', edge: true, everyMin: 15, liveEveryMin: 2, needsSignIn: false,
      home: 'https://www.espn.com/watch/',
      signIn: 'https://www.espn.com/watch/',
      searchUrl: 'https://www.espn.com/search/_/q/',
      covers: 'Scores and schedules are public: no sign-in needed'
    }
  ];

  /*
   * Hulu: hulu.com's own web app (still separate in Oct 2026; FEASIBILITY.md "Hulu (10-17)"),
   * right after Disney+ in the strip. It reads on Disney+'s floor, whatever that floor is (one
   * Disney account, one politeness budget). Added here, not in the table, so it never sits on a
   * line another lane edits.
   */
  SERVICES.splice(SERVICES.indexOf(serviceById('disney')) + 1, 0, {
    id: 'hulu', name: 'Hulu', short: 'Hulu', edge: true, everyMin: serviceById('disney').everyMin, needsSignIn: true,
    home: 'https://www.hulu.com/hub/home',
    signIn: 'https://www.hulu.com/login',
    searchUrl: 'https://www.hulu.com/search?q=',
    covers: 'hulu.com’s own Keep Watching, My Stuff and picks. Hulu titles inside Disney+ show under Disney+'
  });

  var SERVICE_IDS = SERVICES.map(function (s) { return s.id; });
  var KINDS = ['resume', 'rec', 'watchlist', 'live', 'upcoming', 'replay', 'search'];
  var STATES = ['ok', 'signed-out', 'error', 'off', 'never'];
  var EVENT_STATES = ['pre', 'in', 'post'];

  /* The leagues the sports strip can show, NHL first (The user plays). `path` is ESPN's own. */
  var LEAGUES = [
    { id: 'nhl', name: 'NHL', path: 'hockey/nhl' },
    { id: 'nfl', name: 'NFL', path: 'football/nfl' },
    { id: 'nba', name: 'NBA', path: 'basketball/nba' },
    { id: 'mlb', name: 'MLB', path: 'baseball/mlb' },
    { id: 'cfb', name: 'College football', path: 'football/college-football' },
    { id: 'mls', name: 'MLS', path: 'soccer/usa.1' },
    { id: 'wnba', name: 'WNBA', path: 'basketball/wnba' },
    { id: 'chky', name: 'College hockey', path: 'hockey/mens-college-hockey' }
  ];
  var DEFAULT_LEAGUES = ['nhl', 'nfl', 'nba', 'mlb'];

  var TITLE_MAX = 200;
  /* Control characters, zero-width marks and the two Unicode line separators: built from
     escapes in a string so no raw separator ever sits inside a regex literal. */
  var CONTROL_CHARS = new RegExp('[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]', 'g');
  var BADGE_MAX = 24;
  var URL_MAX = 2048;

  function serviceById(id) {
    for (var i = 0; i < SERVICES.length; i++) if (SERVICES[i].id === id) return SERVICES[i];
    return null;
  }

  function leagueById(id) {
    for (var i = 0; i < LEAGUES.length; i++) if (LEAGUES[i].id === id) return LEAGUES[i];
    return null;
  }

  /** Plain one-line text: no control characters, whitespace collapsed, capped. '' for non-text. */
  function cleanText(value, max) {
    if (typeof value === 'number' && isFinite(value)) value = String(value);
    if (typeof value !== 'string') return '';
    var s = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
    var cap = max || TITLE_MAX;
    if (s.length > cap) s = s.slice(0, cap - 1).replace(/\s+\S*$/, '') + '…';
    return s;
  }

  /** An https URL, normalised, or ''. http is refused: every service and CDN here is https. */
  function cleanHttps(value) {
    if (typeof value !== 'string' || !value || value.length > URL_MAX) return '';
    var v = value.trim();
    if (v.indexOf('//') === 0) v = 'https:' + v;
    var u;
    try { u = new URL(v); } catch (err) { return ''; }
    if (u.protocol !== 'https:' || !u.hostname) return '';
    if (u.username || u.password) return '';
    return u.href;
  }

  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (err) { return ''; }
  }

  function hostIs(host, suffix) {
    return host === suffix || (host.length > suffix.length && host.slice(-(suffix.length + 1)) === '.' + suffix);
  }

  /*
   * Does a click on this URL go to Microsoft Edge? The streaming services whose
   * players need Widevine (drm-sites.js's list, kept in step by the harness),
   * plus ESPN's own player (ESPN+ is protected). An ESPN gamecast or any
   * YouTube page plays here, in Quartz.
   */
  var EDGE_HOSTS = ['primevideo.com', 'disneyplus.com', 'hulu.com', 'netflix.com', 'max.com', 'hbomax.com',
    'peacocktv.com', 'paramountplus.com'];
  function opensInEdge(url) {
    var host = hostOf(url);
    if (!host) return false;
    for (var i = 0; i < EDGE_HOSTS.length; i++) if (hostIs(host, EDGE_HOSTS[i])) return true;
    if (hostIs(host, 'tv.apple.com') || host === 'tv.youtube.com') return true;
    if (hostIs(host, 'espn.com')) {
      var p = '';
      try { p = new URL(url).pathname.toLowerCase(); } catch (err) { p = ''; }
      return p.indexOf('/watch/player') === 0;
    }
    return false;
  }

  /** The service a URL belongs to, by host: 'youtube' | 'disney' | 'hulu' | 'prime' | 'espn' | ''. */
  function serviceForUrl(url) {
    var host = hostOf(url);
    if (!host) return '';
    if (hostIs(host, 'youtube.com') || host === 'youtu.be') return host === 'tv.youtube.com' ? '' : 'youtube';
    if (hostIs(host, 'disneyplus.com')) return 'disney';
    if (hostIs(host, 'hulu.com')) return 'hulu';
    if (hostIs(host, 'primevideo.com')) return 'prime';
    if (hostIs(host, 'espn.com')) return 'espn';
    return '';
  }

  function finiteOrNull(n) {
    return (typeof n === 'number' && isFinite(n)) ? n : null;
  }

  /**
   * One adapter item, checked and capped, or null when it cannot be shown
   * (no title, no https link, an unknown service or kind). Everything an
   * adapter hands over goes through here before it reaches the cache or a page.
   */
  function cleanItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var service = SERVICE_IDS.indexOf(raw.service) !== -1 ? raw.service : '';
    var kind = KINDS.indexOf(raw.kind) !== -1 ? raw.kind : '';
    var title = cleanText(raw.title, TITLE_MAX);
    var url = cleanHttps(raw.url);
    if (!service || !kind || !title || !url) return null;
    var rawId = cleanText(raw.id, 300);
    if (!rawId) rawId = service + ':' + url;
    var id = rawId.indexOf(service + ':') === 0 ? rawId : service + ':' + rawId;
    var progress = finiteOrNull(raw.progress);
    if (progress !== null) {
      if (progress > 1 && progress <= 100) progress = progress / 100;   // a percent slipped through
      progress = Math.max(0, Math.min(1, progress));
    }
    var startsAt = finiteOrNull(raw.startsAt);
    var duration = finiteOrNull(raw.durationSec);
    var year = finiteOrNull(raw.year);
    if (year !== null && (year !== Math.round(year) || year < 1880 || year > 2100)) year = null;
    var type = raw.type === 'movie' || raw.type === 'show' ? raw.type : '';
    var image = cleanHttps(raw.image);
    var images = [];
    if (image && Array.isArray(raw.images)) {
      for (var i = 0; i < raw.images.length && images.length < 6; i++) {
        var im = cleanHttps(raw.images[i]);
        if (im && images.indexOf(im) === -1) images.push(im);
      }
      if (images[0] !== image) images = [];
    }
    var out = {
      id: id,
      service: service,
      kind: kind,
      title: title,
      subtitle: cleanText(raw.subtitle, TITLE_MAX),
      image: image,
      progress: progress,
      url: url,
      startsAt: startsAt !== null && startsAt > 0 ? Math.round(startsAt) : null,
      durationSec: duration !== null && duration > 0 ? Math.round(duration) : null,
      badge: cleanText(raw.badge, BADGE_MAX),
      group: cleanText(raw.group, 120),
      edge: opensInEdge(url),
      year: year,
      type: type
    };
    if (images.length > 1) out.images = images;
    // playUrl (watch/playurl.js): straight to the service's player, on the same service; url stays the fallback.
    var play = cleanHttps(raw.playUrl);
    if (play && play !== url && serviceForUrl(play) === service) out.playUrl = play;
    return out;
  }

  /** A list of items, cleaned, de-duplicated by id (first wins), capped. */
  function cleanItems(list, cap) {
    var out = [];
    var seen = {};
    if (!Array.isArray(list)) return out;
    var max = cap || 400;
    for (var i = 0; i < list.length && out.length < max; i++) {
      var it = cleanItem(list[i]);
      if (!it) continue;
      var key = it.kind + '|' + it.id;
      if (seen[key]) continue;
      seen[key] = true;
      out.push(it);
    }
    return out;
  }

  function cleanTeam(raw) {
    var t = raw && typeof raw === 'object' ? raw : {};
    var score = (typeof t.score === 'number' && isFinite(t.score)) ? String(t.score) : cleanText(t.score, 8);
    return {
      name: cleanText(t.name, 60),
      abbr: cleanText(t.abbr, 8),
      logo: cleanHttps(t.logo),
      score: score,
      record: cleanText(t.record, 16)
    };
  }

  /** One sports event, checked, or null (no teams, no start time, unknown state). */
  function cleanEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var league = leagueById(raw.league);
    var state = EVENT_STATES.indexOf(raw.state) !== -1 ? raw.state : '';
    var startsAt = finiteOrNull(raw.startsAt);
    var home = cleanTeam(raw.home);
    var away = cleanTeam(raw.away);
    if (!league || !state || startsAt === null || (!home.name && !home.abbr) || (!away.name && !away.abbr)) return null;
    var id = cleanText(raw.id, 80);
    if (!id) return null;
    if (id.indexOf('espn:') !== 0) id = 'espn:' + id;
    var broadcasts = [];
    if (Array.isArray(raw.broadcasts)) {
      for (var i = 0; i < raw.broadcasts.length && broadcasts.length < 6; i++) {
        var b = cleanText(raw.broadcasts[i], 24);
        if (b && broadcasts.indexOf(b) === -1) broadcasts.push(b);
      }
    }
    var watchUrl = cleanHttps(raw.watchUrl);
    var gamecastUrl = cleanHttps(raw.gamecastUrl);
    return {
      id: id,
      league: league.id,
      leagueName: cleanText(raw.leagueName, 40) || league.name,
      state: state,
      startsAt: Math.round(startsAt),
      detail: cleanText(raw.detail, 40),
      home: home,
      away: away,
      broadcasts: broadcasts,
      watchUrl: watchUrl,
      gamecastUrl: gamecastUrl,
      locked: raw.locked === true ? true : (raw.locked === false ? false : null),
      edge: watchUrl ? opensInEdge(watchUrl) : false
    };
  }

  function cleanEvents(list, cap) {
    var out = [];
    var seen = {};
    if (!Array.isArray(list)) return out;
    var max = cap || 120;
    for (var i = 0; i < list.length && out.length < max; i++) {
      var ev = cleanEvent(list[i]);
      if (!ev || seen[ev.id]) continue;
      seen[ev.id] = true;
      out.push(ev);
    }
    return out;
  }

  /** A parse result, checked: an unknown state is an error with the reason kept. */
  function cleanResult(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var state = (r.state === 'ok' || r.state === 'signed-out' || r.state === 'error') ? r.state : 'error';
    var reason = cleanText(r.reason, 240);
    if (state === 'error' && !reason) reason = 'the reader returned nothing it could use';
    var out = {
      state: state,
      reason: state === 'ok' ? '' : reason,
      items: cleanItems(r.items),
      profile: cleanText(r.profile, 60)
    };
    // The profile's picture (https only), and "the service stopped on its who's-watching picker".
    var avatar = cleanHttps(r.avatar);
    if (avatar && state === 'ok') out.avatar = avatar;
    if (r.picker === true && state === 'error') out.picker = true;
    if (Array.isArray(r.events)) out.events = cleanEvents(r.events);
    // A part that failed while the rest read (history timed out, home worked) is a WARNING:
    // kept and shown, never dropped (no silent failures).
    out.warnings = [];
    if (Array.isArray(r.warnings)) {
      for (var w = 0; w < r.warnings.length && out.warnings.length < 5; w++) {
        var t = cleanText(r.warnings[w], 160);
        if (t && out.warnings.indexOf(t) === -1) out.warnings.push(t);
      }
    }
    return out;
  }

  /*
   * Tree walking for the tolerant parsers. Every service here ships a big JSON
   * tree whose layer of renderers churns (YouTube moved videoRenderer ->
   * richItemRenderer -> lockupViewModel in two years), so the adapters walk the
   * tree looking for the fields they need instead of hard-coding paths.
   * walk(node, visit): depth-first, visit(value, key, parent, depth) returning
   * false skips that subtree. Bounded: depth 60, 200k nodes.
   */
  function walk(root, visit) {
    var stack = [[root, '', null, 0]];
    var seen = 0;
    while (stack.length) {
      var top = stack.pop();
      var node = top[0];
      if (++seen > 200000) return;
      if (top[3] > 60) continue;
      if (visit(node, top[1], top[2], top[3]) === false) continue;
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (var i = node.length - 1; i >= 0; i--) stack.push([node[i], i, node, top[3] + 1]);
      } else {
        var keys = Object.keys(node);
        for (var k = keys.length - 1; k >= 0; k--) stack.push([node[keys[k]], keys[k], node, top[3] + 1]);
      }
    }
  }

  /** Text out of the shapes services use: 'x', {simpleText}, {runs:[{text}]}, {content}, {text}. */
  function textOf(v) {
    if (typeof v === 'string') return v;
    if (!v || typeof v !== 'object') return '';
    if (typeof v.simpleText === 'string') return v.simpleText;
    if (Array.isArray(v.runs)) return v.runs.map(function (r) { return (r && typeof r.text === 'string') ? r.text : ''; }).join('');
    if (typeof v.content === 'string') return v.content;
    if (typeof v.string === 'string') return v.string;          // Prime: { attrs, string }
    if (typeof v.message === 'string') return v.message;
    if (typeof v.text === 'string') return v.text;
    if (v.text && typeof v.text === 'object') return textOf(v.text);
    if (typeof v.default === 'object' && v.default) return textOf(v.default);
    return '';
  }

  /** "1:02:03" / "12:31" -> seconds, or null. */
  function clockToSec(s) {
    if (typeof s !== 'string') return null;
    var m = s.trim().match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (!m) return null;
    return m[3] !== undefined ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
  }

  /* Freshness: how long ago, in the words the tiles use. */
  function agoText(ms, now) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return 'never';
    var d = Math.max(0, (now || Date.now()) - ms);
    var min = Math.round(d / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    var h = Math.round(min / 60);
    if (h < 24) return h + ' h ago';
    var days = Math.round(h / 24);
    return days === 1 ? 'yesterday' : days + ' days ago';
  }

  /*
   * YouTube thumbnail candidates, sharpest first. YouTube's pages hand out ~320-480 px stills
   * (hqdefault/mqdefault, often with ?sqp=&rs= sizing), which look blocky as full-bleed art. For a
   * video id the CDN also serves maxresdefault (1280x720; webp and jpg) and sddefault (640x480), but
   * maxres is missing for some videos (404 with a 120x90 grey body), so the page steps down the list.
   * Live streams use the *_live names (the plain ones are a stale pre-stream still). The original URL
   * is always last. A non-ytimg URL, or one without a video id, comes back alone. Never more than 6.
   * Shorts (short === true) keep the original FIRST: it is YouTube's vertical still, which a 16:9 tile
   * crops cleanly, where the 16:9 / 4:3 stills of a vertical video carry black side bars.
   */
  var YT_ID = /^[A-Za-z0-9_-]{11}$/;
  function ytThumbs(url, id, short) {
    var orig = cleanHttps(url);
    var host = '';
    var path = '';
    try { var u = new URL(orig); host = u.hostname; path = u.pathname; } catch (err) { host = ''; }
    var isYt = /^i\d?\.ytimg\.com$/.test(host);
    var m = isYt ? /^\/(?:vi|vi_webp)\/([A-Za-z0-9_-]{11})\/([A-Za-z0-9_]+)\.(?:jpg|webp)$/.exec(path) : null;
    var vid = m ? m[1] : (isYt || !orig) && typeof id === 'string' && YT_ID.test(id) ? id : '';
    if (!vid) return orig ? [orig] : [];
    var live = m ? /_live$/.test(m[2]) : false;
    var sfx = live ? '_live' : '';
    var base = 'https://i.ytimg.com/vi/' + vid + '/';
    var out = [
      'https://i.ytimg.com/vi_webp/' + vid + '/maxresdefault' + sfx + '.webp',
      base + 'maxresdefault' + sfx + '.jpg',
      base + 'sddefault' + sfx + '.jpg',
      base + 'hqdefault' + sfx + '.jpg'
    ];
    if (orig && out.indexOf(orig) === -1) {
      if (short === true) out.unshift(orig); else out.push(orig);
    }
    return out.slice(0, 6);
  }

  var API = {
    SERVICES: SERVICES,
    SERVICE_IDS: SERVICE_IDS,
    KINDS: KINDS,
    STATES: STATES,
    LEAGUES: LEAGUES,
    DEFAULT_LEAGUES: DEFAULT_LEAGUES,
    EDGE_HOSTS: EDGE_HOSTS,
    serviceById: serviceById,
    leagueById: leagueById,
    serviceForUrl: serviceForUrl,
    opensInEdge: opensInEdge,
    cleanText: cleanText,
    cleanHttps: cleanHttps,
    cleanItem: cleanItem,
    cleanItems: cleanItems,
    cleanEvent: cleanEvent,
    cleanEvents: cleanEvents,
    cleanResult: cleanResult,
    walk: walk,
    textOf: textOf,
    clockToSec: clockToSec,
    agoText: agoText,
    ytThumbs: ytThumbs
  };

  if (typeof module === 'object' && module && module.exports) module.exports = API;
  if (typeof window !== 'undefined' && window) window.WatchShape = API;
})();
