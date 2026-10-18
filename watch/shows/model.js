'use strict';
/*
 * watch/shows/model.js -- the one contract Lumen's show pages agree on: which tile opens a show
 * page, the SHOW shape (cleaned), the big button (Resume S2 E5 / Play S1 E1 / Play) and what each
 * episode plays. Pure functions over plain objects; no DOM, no Electron, no network.
 *
 * Loads two ways, like watch/playurl.js:
 *   - require('./watch/shows/model') in main (watch-shows-main.js), the readers and the tests
 *   - <script src="watch/shows/model.js"> in watch.html (window.LumenShowModel), after playurl.js
 *
 * SHOW (what a reader returns once cleaned, what the page draws):
 *   { service: 'hulu'|'disney'|'prime'|'youtube'|'' ('' = from TMDB only, not on his services),
 *     type: 'show'|'movie', id, url (the service's title page, or ''), title, year|null, rating,
 *     synopsis, genres[], image (16:9 https), runtimeSec|null (movie),
 *     seasons: [{ n, label, url, loaded, episodes: [EP] }]   (none for a movie)
 *     resume: { s, e }|null   the service's own "you are here" (Keep Watching / Continue)
 *     progress: 0..1|null, watched: bool|null, playUrl  (a movie's own)
 *     more: [{ title, image, url, service, year, type }], watchlist: true|false|null,
 *     progressKnown: bool (the service said per-episode progress), source: 'service'|'tmdb'|'mixed',
 *     notes: [plain words] }
 *   EP: { id, s, e, title, synopsis, runtimeSec|null, image, progress: 0..1|null, watched: bool|null, url }
 *     url is a PROVEN play address the service's own data gave (Hulu /watch/<uuid>, a YouTube
 *     watch?v=&list=, Prime's own autoplay link) or ''. '' plays the title page (playFor()).
 */
(function (root, factory) {
  var api;
  if (typeof module === 'object' && module.exports) {
    api = factory(require('../playurl'), require('../shape'));
    module.exports = api;
  } else {
    root.LumenShowModel = factory(root.LumenPlay, root.WatchShape);
  }
})(typeof self !== 'undefined' ? self : this, function (Play, Shape) {
  var SERVICES = ['disney', 'hulu', 'prime', 'youtube'];
  var NAMES = { youtube: 'YouTube', disney: 'Disney+', hulu: 'Hulu', prime: 'Prime Video', espn: 'ESPN', '': 'TMDB' };
  var CAP = { seasons: 40, episodes: 200, more: 20, genres: 4, notes: 6, synopsis: 600, epSynopsis: 400 };
  var DONE_AT = 0.95;     // past this an episode counts as watched (the credits)
  var STARTED_AT = 0.02;  // under this it was barely opened
  var UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  var NOT_SHOWS = /^(WL|LL|LM|RD|UL|FL|OLAK5uy_|RDMM|RDCLAK)/;   // Watch Later, Liked, mixes, uploads: not series

  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function num(v) { var n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && isFinite(n) ? n : null; }
  function text(v, max) {
    var s = Shape && Shape.cleanText ? Shape.cleanText(typeof v === 'string' ? v : '', max) : str(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
    return s;
  }
  function https(v) {
    if (Shape && Shape.cleanHttps) return Shape.cleanHttps(v);
    var s = str(v);
    return /^https:\/\/[^\s]+$/i.test(s) ? s : '';
  }
  function parse(url) { try { return new URL(String(url || '')); } catch (e) { return null; } }
  function hostIs(host, domain) { return host === domain || host.slice(-(domain.length + 1)) === '.' + domain; }
  function svcOfUrl(url) {
    var u = parse(url);
    if (!u) return '';
    var h = u.hostname.toLowerCase();
    if (hostIs(h, 'hulu.com')) return 'hulu';
    if (hostIs(h, 'disneyplus.com')) return 'disney';
    if (hostIs(h, 'primevideo.com') || (hostIs(h, 'amazon.com') && /\/(gp\/video|video)\b/.test(u.pathname))) return 'prime';
    if (hostIs(h, 'youtube.com')) return 'youtube';
    return '';
  }
  function frac(v) { var n = num(v); return n === null ? null : (n < 0 ? 0 : n > 1 ? 1 : n); }
  function int(v, lo, hi) { var n = num(v); return n !== null && Math.floor(n) === n && n >= lo && n <= hi ? n : null; }
  function yearOf(v) { var n = int(v, 1880, 2100); if (n !== null) return n; var m = /^\s*(\d{4})/.exec(str(v)); return m ? int(+m[1], 1880, 2100) : null; }

  /* ------------------------------------------------------------ which tile opens a show page */

  function playlistIdOf(url) {
    var u = parse(url);
    if (!u || svcOfUrl(url) !== 'youtube') return '';
    var id = u.searchParams.get('list') || '';
    return /^[A-Za-z0-9_-]{10,64}$/.test(id) && !NOT_SHOWS.test(id) ? id : '';
  }

  /**
   * The show page a tile means, or null when it plays straight away (a YouTube video with no
   * series playlist, a live game, an ESPN airing). { service, type, id, url, title, year, key }.
   */
  function requestFor(it) {
    var i = obj(it);
    if (!i) return null;
    if (/^(live|upcoming|replay)$/.test(str(i.kind))) return null;
    var url = https(i.url);
    var svc = svcOfUrl(url);
    if (!svc || (i.service && i.service !== svc)) return null;
    var u = parse(url);
    var path = u ? u.pathname : '';
    var m, id = '', type = '';
    if (svc === 'hulu') {
      m = /^\/(series|movie)\/([^\/?#]+)/i.exec(path);
      if (m && UUID_RE.test(m[2])) { id = UUID_RE.exec(m[2])[1].toLowerCase(); type = m[1].toLowerCase() === 'movie' ? 'movie' : 'show'; }
    } else if (svc === 'disney') {
      m = /\/browse\/entity-([A-Za-z0-9_-]{6,80})/i.exec(path) || /\/(?:series|movies)\/[^\/]+\/([A-Za-z0-9_-]{6,80})/i.exec(path);
      if (m) { id = m[1]; type = i.type === 'movie' ? 'movie' : i.type === 'show' ? 'show' : ''; }
    } else if (svc === 'prime') {
      m = /\/detail\/(?:[^\/]+\/)?([A-Za-z0-9]{8,40})\/?$/i.exec(path) || /\/detail\/([A-Za-z0-9]{8,40})/i.exec(path);
      if (m) { id = m[1]; type = i.type === 'movie' ? 'movie' : i.type === 'show' ? 'show' : ''; }
    } else if (svc === 'youtube') {
      id = playlistIdOf(url);
      type = 'show';
      if (id) url = 'https://www.youtube.com/playlist?list=' + id;
    }
    if (!id) return null;
    return { service: svc, type: type, id: id, url: url, title: text(i.title, 200), year: yearOf(i.year), key: svc + ':' + id };
  }

  /* ------------------------------------------------------------ cleaning */

  function cleanEp(raw, sDefault) {
    var r = obj(raw);
    if (!r) return null;
    var s = int(r.s, 0, 200);
    if (s === null) s = sDefault;
    var e = int(r.e, 0, 5000);
    var title = text(r.title, 200);
    if (e === null && !title) return null;
    var p = frac(r.progress);
    var w = r.watched === true ? true : r.watched === false ? false : null;
    if (w === null && p !== null && p >= DONE_AT) w = true;
    var rt = num(r.runtimeSec);
    return {
      id: text(String(r.id === undefined || r.id === null ? '' : r.id), 120), s: s, e: e, title: title,
      synopsis: text(r.synopsis, CAP.epSynopsis), runtimeSec: rt !== null && rt > 0 && rt < 86400 ? Math.round(rt) : null,
      image: https(r.image), progress: p, watched: w, url: https(r.url)
    };
  }

  function cleanMore(raw) {
    var r = obj(raw);
    if (!r) return null;
    var title = text(r.title, 200);
    if (!title) return null;
    var svc = SERVICES.indexOf(r.service) !== -1 ? r.service : '';
    var tid = int(r.tmdbId, 1, 1e9);
    return { title: title, image: https(r.image), url: https(r.url), service: svc, year: yearOf(r.year), type: r.type === 'movie' ? 'movie' : r.type === 'show' ? 'show' : '',
      tmdbId: tid, tmdbType: tid && (r.tmdbType === 'tv' || r.tmdbType === 'movie') ? r.tmdbType : '' };
  }

  function cleanShow(raw) {
    var r = obj(raw);
    if (!r) return null;
    var title = text(r.title, 200);
    if (!title) return null;
    var type = r.type === 'movie' ? 'movie' : 'show';
    var seasons = [];
    var seen = {};
    (Array.isArray(r.seasons) ? r.seasons : []).forEach(function (sRaw) {
      var so = obj(sRaw);
      if (!so || seasons.length >= CAP.seasons) return;
      var n = int(so.n, 0, 200);
      if (n === null || seen[n]) return;
      seen[n] = true;
      var eps = [];
      var epSeen = {};
      (Array.isArray(so.episodes) ? so.episodes : []).forEach(function (eRaw) {
        if (eps.length >= CAP.episodes) return;
        var ep = cleanEp(eRaw, n);
        if (!ep) return;
        var k = ep.id || ('e' + ep.e + ':' + ep.title);
        if (epSeen[k]) return;
        epSeen[k] = true;
        eps.push(ep);
      });
      eps.sort(function (a, b) { return (a.e === null ? 1e6 : a.e) - (b.e === null ? 1e6 : b.e); });
      seasons.push({ n: n, label: text(so.label, 60) || (n === 0 ? 'Specials' : 'Season ' + n), url: https(so.url), loaded: so.loaded === false ? false : eps.length > 0, fromTmdb: so.fromTmdb === true, episodes: eps });
    });
    seasons.sort(function (a, b) { return (a.n === 0 ? 1e6 : a.n) - (b.n === 0 ? 1e6 : b.n); });
    var res = obj(r.resume);
    var resume = res && int(res.e, 0, 5000) !== null ? { s: int(res.s, 0, 200), e: int(res.e, 0, 5000) } : null;
    if (type === 'movie') resume = res ? { s: null, e: null } : null;   // a film: the service said "Continue"
    var more = [];
    (Array.isArray(r.more) ? r.more : []).forEach(function (m) { if (more.length < CAP.more) { var c = cleanMore(m); if (c) more.push(c); } });
    var rt = num(r.runtimeSec);
    var p = frac(r.progress);
    return {
      service: SERVICES.indexOf(r.service) !== -1 ? r.service : '',
      type: type, id: text(String(r.id === undefined || r.id === null ? '' : r.id), 120), url: https(r.url), title: title,
      year: yearOf(r.year), rating: text(r.rating, 16), synopsis: text(r.synopsis, CAP.synopsis),
      genres: (Array.isArray(r.genres) ? r.genres : []).map(function (g) { return text(g, 40); }).filter(Boolean).slice(0, CAP.genres),
      image: https(r.image), runtimeSec: rt !== null && rt > 0 && rt < 86400 ? Math.round(rt) : null,
      seasons: type === 'movie' ? [] : seasons, resume: resume,
      progress: p, watched: r.watched === true ? true : r.watched === false ? false : (p !== null && p >= DONE_AT ? true : null),
      playUrl: https(r.playUrl), more: more,
      watchlist: r.watchlist === true ? true : r.watchlist === false ? false : null,
      progressKnown: r.progressKnown === true, source: r.source === 'tmdb' || r.source === 'mixed' ? r.source : 'service',
      notes: (Array.isArray(r.notes) ? r.notes : []).map(function (n) { return text(n, 240); }).filter(Boolean).slice(0, CAP.notes)
    };
  }

  /* ------------------------------------------------------------ TMDB fills the gaps */

  /**
   * The service's show with TMDB's words where the service said nothing: synopsis, year, rating,
   * genres, art, "More like this", and whole seasons the service did not send (marked: no progress).
   */
  function mergeTmdb(show, tm) {
    var s = cleanShow(show);
    var t = cleanShow(tm);
    if (!s) return t;
    if (!t) return s;
    var used = false;
    ['synopsis', 'rating', 'image'].forEach(function (k) { if (!s[k] && t[k]) { s[k] = t[k]; used = true; } });
    if (s.year === null && t.year !== null) { s.year = t.year; used = true; }
    if (!s.genres.length && t.genres.length) { s.genres = t.genres; used = true; }
    if (s.runtimeSec === null && t.runtimeSec !== null) s.runtimeSec = t.runtimeSec;
    if (!s.more.length && t.more.length) { s.more = t.more; used = true; }
    if (s.type === 'show') {
      var have = {};
      s.seasons.forEach(function (x) { have[x.n] = x; });
      t.seasons.forEach(function (ts) {
        var mine = have[ts.n];
        if (!mine) { s.seasons.push(Object.assign({}, ts, { fromTmdb: true })); used = true; return; }
        if (!mine.episodes.length && ts.episodes.length) { mine.episodes = ts.episodes; mine.loaded = true; mine.fromTmdb = true; used = true; }
        else if (mine.episodes.length && ts.episodes.length) {
          // the service's episodes keep their progress; TMDB fills a missing synopsis, still or runtime
          var byE = {};
          ts.episodes.forEach(function (e) { if (e.e !== null) byE[e.e] = e; });
          mine.episodes.forEach(function (e) {
            var te = e.e !== null ? byE[e.e] : null;
            if (!te) return;
            if (!e.synopsis && te.synopsis) e.synopsis = te.synopsis;
            if (!e.image && te.image) e.image = te.image;
            if (e.runtimeSec === null && te.runtimeSec !== null) e.runtimeSec = te.runtimeSec;
            if (!e.title && te.title) e.title = te.title;
          });
        }
      });
      s.seasons.sort(function (a, b) { return (a.n === 0 ? 1e6 : a.n) - (b.n === 0 ? 1e6 : b.n); });
    }
    if (used && s.source === 'service') s.source = 'mixed';
    return s;
  }

  /* ------------------------------------------------------------ the big button */

  function epLabel(ep) { return ep ? (ep.s !== null && ep.s !== undefined ? 'S' + ep.s + ' E' + ep.e : 'E' + ep.e) : ''; }
  function allEps(show) {
    var out = [];
    (show.seasons || []).filter(function (x) { return x.n > 0; }).concat((show.seasons || []).filter(function (x) { return x.n === 0; }))
      .forEach(function (x) { x.episodes.forEach(function (e) { out.push(e); }); });
    return out;
  }
  function started(e) { return e.progress !== null && e.progress >= STARTED_AT && e.progress < DONE_AT && e.watched !== true; }
  function done(e) { return e.watched === true || (e.progress !== null && e.progress >= DONE_AT); }

  /** What one episode (or the movie, ep null) plays: { url, fallback, proven, why }. */
  function playFor(show, ep) {
    var s = show || {};
    var page = https(s.url);
    var season = ep && (s.seasons || []).filter(function (x) { return x.n === ep.s; })[0];
    var seasonPage = (season && https(season.url)) || page;
    if (!ep) {
      if (s.playUrl) return { url: s.playUrl, fallback: page, proven: true, why: '' };
      if (s.service === 'hulu' && s.type === 'movie' && Play && Play.huluWatchUrl(s.id)) return { url: Play.huluWatchUrl(s.id), fallback: page, proven: true, why: '' };
      return { url: page, fallback: '', proven: false, why: page ? '' : 'no page to open' };
    }
    if (s.service === 'youtube') return ep.url ? { url: ep.url, fallback: page, proven: true, why: '' } : { url: page, fallback: '', proven: false, why: '' };
    if (s.service === 'hulu') {
      var w = ep.url || (Play && Play.huluWatchUrl(ep.id)) || '';
      if (w) return { url: w, fallback: page, proven: true, why: '' };
      return { url: page, fallback: '', proven: false, why: 'Hulu gave no player address for this episode, so it opens the show’s page' };
    }
    if (s.service === 'prime') {
      if (ep.url) return { url: ep.url, fallback: seasonPage, proven: true, why: '' };
      return { url: seasonPage, fallback: '', proven: false, why: 'Prime Video plays episodes from the season’s page' };
    }
    if (s.service === 'disney') return { url: page, fallback: '', proven: false, why: 'Disney+ opens on the show’s page (its episode player address isn’t proven)' };
    return { url: page, fallback: '', proven: false, why: '' };
  }

  /** The big button: { label, ep, url, fallback, proven, why }. */
  function resumePlan(show) {
    var s = show || {};
    if (s.type === 'movie') {
      var f = playFor(s, null);
      var label = (s.progress !== null && s.progress >= STARTED_AT && s.progress < DONE_AT && s.watched !== true) || (s.resume && s.progress === null) ? 'Resume' : 'Play';
      return Object.assign({ label: label, ep: null }, f);
    }
    var eps = allEps(s);
    var pick = null, verb = 'Play';
    if (s.resume && s.resume.e !== null) {
      pick = eps.filter(function (e) { return e.e === s.resume.e && (s.resume.s === null || e.s === s.resume.s); })[0] || null;
      if (pick) verb = 'Resume';
    }
    if (!pick) {
      var part = eps.filter(started);
      if (part.length) { pick = part[part.length - 1]; verb = 'Resume'; }
    }
    if (!pick) {
      var lastDone = -1;
      eps.forEach(function (e, i) { if (done(e)) lastDone = i; });
      if (lastDone !== -1 && lastDone + 1 < eps.length) pick = eps[lastDone + 1];
    }
    if (!pick && eps.length) pick = eps.filter(function (e) { return e.s >= 1; })[0] || eps[0];
    if (!pick) return Object.assign({ label: 'Play', ep: null }, playFor(s, null));
    return Object.assign({ label: verb + ' ' + epLabel(pick), ep: pick }, playFor(s, pick));
  }

  /** The season tab to open first: the big button's season, else the first real season. */
  function startSeason(show) {
    var s = show || {};
    var plan = resumePlan(s);
    if (plan.ep && plan.ep.s !== null) return plan.ep.s;
    var first = (s.seasons || []).filter(function (x) { return x.n > 0; })[0] || (s.seasons || [])[0];
    return first ? first.n : null;
  }

  function serviceName(id) { return NAMES[id] || NAMES['']; }

  return {
    SERVICES: SERVICES, CAP: CAP, DONE_AT: DONE_AT, STARTED_AT: STARTED_AT,
    requestFor: requestFor, playlistIdOf: playlistIdOf, svcOfUrl: svcOfUrl,
    cleanShow: cleanShow, cleanEp: cleanEp, mergeTmdb: mergeTmdb,
    playFor: playFor, resumePlan: resumePlan, startSeason: startSeason, epLabel: epLabel, serviceName: serviceName,
    started: started, done: done
  };
});
