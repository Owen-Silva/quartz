/*
 * watch/find.js -- Lumen's one search box, the pure half (page and main share it).
 *
 * On Enter the page asks main for every service's OWN search (Disney+, Hulu and Prime Video
 * in the hidden reader, one at a time; YouTube's public results page; TMDB's where-to-watch
 * when the user has a key). Each answer lands on its own, so the page draws the fastest at once
 * and the rest fill in. This file turns whatever has arrived into the results page:
 *
 *   merge(input) -> { best: [title], rows: [row], youtube: { state, reason, videos, channels } }
 *
 *   input = {
 *     q,                                    what he typed
 *     order:    ['disney', 'hulu', 'prime'],  the service rows, in the order they are drawn
 *     services: { disney: { state, reason, items }, ... },   state: loading | ok | empty | error |
 *                                           signed-out | off | paused | queued
 *     youtube:  { state, reason, items, channels },
 *     tmdb:     { state, reason, results },  TMDB's answer (results[].providers[])
 *     local:    [item],                     his own rows (the cache): Resume and progress come from here
 *     signedIn: { disney: true, ... }        the services he is signed into (their chip goes first)
 *   }
 *
 * A "best match" title is one tile for a title, whichever services carry it: a chip per
 * service (his signed-in ones first, then included before rent/buy), Resume and progress
 * when one of his own rows has it. Service rows keep each service's own order, verbatim.
 *
 * Offers (what a chip says): included | free | ads | rent | buy | channel | upgrade | ''.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WatchFind = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var SEARCH_SERVICES = ['disney', 'hulu', 'prime'];
  var BEST_MAX = 12;
  var ROW_MAX = 30;
  var YT_VIDEOS_MAX = 20;
  var YT_CHANNELS_MAX = 6;
  var OFFERS = ['included', 'free', 'ads', 'rent', 'buy', 'channel', 'upgrade'];
  var OFFER_RANK = { included: 0, free: 1, ads: 2, channel: 3, rent: 4, buy: 5, upgrade: 6, '': 7 };
  var OFFER_WORD = {
    included: 'Included', free: 'Free', ads: 'Free with ads', rent: 'Rent or buy', buy: 'Buy',
    channel: 'Add-on channel', upgrade: 'Not in your plan', '': ''
  };
  var TMDB_TYPE = { stream: 'included', free: 'free', ads: 'ads', rent: 'rent', buy: 'buy' };
  var STATES = ['loading', 'queued', 'ok', 'empty', 'error', 'signed-out', 'off', 'paused'];

  function fold(s) {
    var t = String(s || '').toLowerCase();
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (err) { /* old engine */ }
    return t.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  /* "The Bear" and "Bear, The" and "The Bear (2022)" are one title. */
  function titleKey(s) {
    var t = fold(String(s || '').replace(/\((19|20)\d\d\)\s*$/, ''));
    t = t.replace(/^(the|a|an) /, '');
    return t;
  }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function offerOf(v) { return OFFERS.indexOf(v) !== -1 ? v : ''; }
  function stateOf(v) { return STATES.indexOf(v) !== -1 ? v : 'error'; }

  /**
   * How well a title answers the query, 0..100. Exact beats starts-with beats every word
   * beats some words; nothing in common is 0.
   */
  function matchScore(title, q) {
    var t = titleKey(title), k = titleKey(q);
    if (!t || !k) return 0;
    if (t === k) return 100;
    if (t.indexOf(k + ' ') === 0 || t.indexOf(k + ':') === 0) return 85;
    if (t.indexOf(k) === 0) return 75;
    var words = k.split(' ').filter(Boolean);
    var tw = ' ' + t + ' ';
    var hit = 0;
    for (var i = 0; i < words.length; i++) if (tw.indexOf(' ' + words[i]) !== -1) hit++;
    if (!words.length) return 0;
    if (hit === words.length) return 60;
    return Math.round(40 * hit / words.length);
  }

  /** His own row for this title on this service (Resume / progress / on his list), or null. */
  function ownFor(local, service, key) {
    var best = null;
    for (var i = 0; i < local.length; i++) {
      var it = local[i];
      if (!it || it.service !== service || titleKey(it.title) !== key) continue;
      if (!best || (it.kind === 'resume' && best.kind !== 'resume')) best = it;
    }
    return best;
  }

  function chipRank(c, signedIn) {
    return (signedIn[c.service] ? 0 : 100) + (c.progress !== null ? 0 : 10) + OFFER_RANK[c.offer || ''];
  }

  /**
   * One results page from whatever has arrived. Pure: the same input draws the same page.
   */
  function merge(input) {
    var x = input && typeof input === 'object' ? input : {};
    var q = str(x.q);
    var order = arr(x.order).filter(function (id) { return SEARCH_SERVICES.indexOf(id) !== -1; });
    if (!order.length) order = SEARCH_SERVICES.slice();
    var services = x.services && typeof x.services === 'object' ? x.services : {};
    var local = arr(x.local).filter(function (it) { return it && typeof it === 'object'; });
    var signedIn = x.signedIn && typeof x.signedIn === 'object' ? x.signedIn : {};

    var groups = [];
    var byKey = {};
    function groupFor(title, year) {
      var key = titleKey(title);
      if (!key) return null;
      var g = byKey[key];
      // Two titles with one name and years far apart (a remake) stay two tiles.
      if (g && year && g.year && Math.abs(g.year - year) > 1) {
        var k2 = key + '|' + year;
        g = byKey[k2];
        if (!g) { g = newGroup(title, year, k2, key); }
        return g;
      }
      if (!g) g = newGroup(title, year, key, key);
      return g;
    }
    function newGroup(title, year, id, key) {
      var g = { key: id, titleKey: key, title: title, year: year || 0, type: '', image: '', images: null, subtitle: '', chips: [], best: 0, firstAt: 99, sources: 0, tmdbOnly: true };
      byKey[id] = g;
      groups.push(g);
      return g;
    }
    function addChip(g, chip) {
      for (var i = 0; i < g.chips.length; i++) {
        var c = g.chips[i];
        if (c.service !== chip.service) continue;
        // A service's own answer beats TMDB's word for it; his own row adds Resume.
        if (c.source === 'tmdb' && chip.source !== 'tmdb') g.chips[i] = Object.assign({}, chip, { progress: c.progress !== null ? c.progress : chip.progress, resume: c.resume || chip.resume });
        else if (OFFER_RANK[chip.offer || ''] < OFFER_RANK[c.offer || ''] && c.source === chip.source) g.chips[i] = chip;
        return;
      }
      g.chips.push(chip);
    }

    // 1. The services' own answers, in their own order.
    var rows = [];
    order.forEach(function (id) {
      var s = services[id] && typeof services[id] === 'object' ? services[id] : { state: 'loading' };
      var state = stateOf(s.state);
      var items = arr(s.items).filter(function (it) { return it && it.service === id && str(it.title) && str(it.url); }).slice(0, ROW_MAX);
      var tiles = items.map(function (it, i) {
        var own = ownFor(local, id, titleKey(it.title));
        var tile = {
          id: it.id, service: id, title: it.title, subtitle: str(it.subtitle), image: str(it.image), images: it.images || null,
          url: it.url, offer: offerOf(it.offer), year: it.year || 0, type: str(it.type),
          progress: own && typeof own.progress === 'number' ? own.progress : null,
          resume: !!(own && own.kind === 'resume'), resumeUrl: own && own.kind === 'resume' ? own.url : '',
          onList: !!(own && own.kind === 'watchlist')
        };
        var g = groupFor(it.title, it.year || 0);
        if (g) {
          g.tmdbOnly = false;
          g.sources++;
          if (!g.image && tile.image) { g.image = tile.image; g.images = tile.images; }
          if (!g.year && tile.year) g.year = tile.year;
          if (!g.type && tile.type) g.type = tile.type;
          if (!g.subtitle && tile.subtitle) g.subtitle = tile.subtitle;
          g.firstAt = Math.min(g.firstAt, i);
          addChip(g, { service: id, offer: tile.offer, url: tile.resume && tile.resumeUrl ? tile.resumeUrl : tile.url, progress: tile.progress, resume: tile.resume, source: 'service' });
        }
        return tile;
      });
      rows.push({ service: id, state: items.length ? 'ok' : (state === 'ok' ? 'empty' : state), reason: str(s.reason), tiles: tiles, cached: s.cached === true });
    });

    // 2. TMDB (JustWatch data): adds the services a title is on that the searches didn't say, and
    //    the titles none of his services' searches returned.
    var tm = x.tmdb && typeof x.tmdb === 'object' && x.tmdb.state === 'ok' ? arr(x.tmdb.results) : [];
    tm.forEach(function (r, i) {
      if (!r || !str(r.title)) return;
      var g = groupFor(r.title, Number(r.year) || 0);
      if (!g) return;
      if (!g.image && str(r.image)) g.image = r.image;
      if (!g.year && r.year) g.year = Number(r.year) || 0;
      if (!g.type) g.type = r.mediaType === 'movie' ? 'movie' : (r.mediaType === 'tv' ? 'show' : '');
      if (g.tmdbOnly) g.firstAt = Math.min(g.firstAt, i + 2);
      g.tmdb = true;
      g.watchLink = str(r.watchLink);
      g.elsewhere = g.elsewhere || [];
      arr(r.providers).forEach(function (p) {
        if (!p || !str(p.name)) return;
        var offer = TMDB_TYPE[p.type] || '';
        if (p.service && p.service !== 'youtube' && p.service !== 'espn') {
          var own = ownFor(local, p.service, g.titleKey);
          addChip(g, { service: p.service, offer: offer, url: own && own.kind === 'resume' ? own.url : str(p.url), progress: own && typeof own.progress === 'number' ? own.progress : null, resume: !!(own && own.kind === 'resume'), source: 'tmdb' });
        } else if (!p.service && g.elsewhere.indexOf(p.name) === -1 && g.elsewhere.length < 4) {
          g.elsewhere.push(p.name);
        }
      });
    });

    // 3. Rank: how well the title answers the query, then where it is (his services, Resume).
    groups.forEach(function (g) {
      g.chips.sort(function (a, b) { return chipRank(a, signedIn) - chipRank(b, signedIn); });
      var m = matchScore(g.title, q);
      var resume = g.chips.some(function (c) { return c.resume; });
      var mine = g.chips.some(function (c) { return signedIn[c.service] && (c.offer === 'included' || c.offer === 'free' || c.offer === 'ads' || c.offer === ''); });
      g.match = m;
      g.score = m + (resume ? 15 : 0) + (mine ? 10 : 0) + Math.min(g.chips.length, 3) * 2 + Math.max(0, 10 - g.firstAt) - (g.tmdbOnly ? 5 : 0);
      g.progress = null;
      for (var i = 0; i < g.chips.length; i++) if (g.chips[i].progress !== null) { g.progress = g.chips[i].progress; break; }
      g.resume = resume;
    });
    var ranked = groups.filter(function (g) { return g.chips.length || (g.elsewhere && g.elsewhere.length); });
    ranked.sort(function (a, b) { return b.score - a.score || a.firstAt - b.firstAt || (a.title < b.title ? -1 : 1); });
    // Best match: the titles that answer the query; when none does (a typo, a person's name),
    // the services' own top results stand in.
    var strong = ranked.filter(function (g) { return g.match >= 40; });
    var best = (strong.length ? strong : ranked.filter(function (g) { return g.firstAt < 3; })).slice(0, BEST_MAX);

    // 4. YouTube: videos and channels, as YouTube ordered them.
    var y = x.youtube && typeof x.youtube === 'object' ? x.youtube : { state: 'loading' };
    var videos = arr(y.items).filter(function (it) { return it && str(it.title) && str(it.url); }).slice(0, YT_VIDEOS_MAX);
    var channels = arr(y.channels).filter(function (c) { return c && str(c.name) && str(c.url); }).slice(0, YT_CHANNELS_MAX);
    var ytState = stateOf(y.state === 'cancelled' ? 'error' : y.state);
    if (ytState === 'ok' && !videos.length && !channels.length) ytState = 'empty';

    return {
      q: q,
      best: best,
      rows: rows,
      youtube: { state: ytState, reason: str(y.reason), videos: videos, channels: channels },
      pending: rows.filter(function (r) { return r.state === 'loading' || r.state === 'queued'; }).length + (ytState === 'loading' ? 1 : 0)
    };
  }

  /** What a chip says for an offer: "Included", "Rent or buy", ... ('' = nothing known). */
  function offerWord(offer) { return OFFER_WORD[offerOf(offer)] || ''; }

  /** The recent-searches list after `q` is searched: newest first, no repeats, `max` long. */
  function remember(list, q, max) {
    var text = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    var out = arr(list).filter(function (s) { return typeof s === 'string' && s && fold(s) !== fold(text); });
    if (text) out.unshift(text);
    return out.slice(0, max || 8);
  }

  return {
    SEARCH_SERVICES: SEARCH_SERVICES,
    OFFERS: OFFERS,
    STATES: STATES,
    fold: fold,
    titleKey: titleKey,
    matchScore: matchScore,
    merge: merge,
    offerWord: offerWord,
    remember: remember
  };
});
