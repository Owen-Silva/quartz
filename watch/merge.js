'use strict';
/*
 * watch/merge.js -- turns what each service's reader last returned into the
 * rows the Watch page draws. Pure: no Electron, no DOM, no clock of its own
 * (the caller passes `now`). Loads like shape.js: require() in main and the
 * tests, <script src="watch/merge.js"> in watch.html (window.WatchMerge).
 *
 * The rows, top to bottom (FEASIBILITY.md "Merge"):
 *   continue   Continue watching: every service's resume rows, round-robin so
 *              one service never buries the rest, each in its own order
 *              (which is the service's own recency).
 *   foryou     For you: recommendations round-robin across services, so the
 *              YouTube home feed does not drown Disney+ and Prime. Titles that
 *              two services both recommend appear once.
 *   watchlist  Watchlist: the same, for saved titles.
 *   per service, the service's OWN named rows ("Because you watched Bluey"),
 *              at most GROUPS_PER_SERVICE of them.
 * The sports strip is not a row of items: it is buildSports(events, now).
 */
(function () {
  var Shape = (typeof module === 'object' && module && module.exports)
    ? require('./shape')
    : (typeof window !== 'undefined' ? window.WatchShape : null);

  var ROW_CAP = 40;
  var GROUPS_PER_SERVICE = 4;
  var GROUP_MIN = 3;          // a named row with fewer items than this folds into the service's "More" row
  var ROUND_ROBIN = ['youtube', 'disney', 'prime', 'espn'];

  /** Lower-case, accents folded, punctuation gone: for de-duplicating titles and for search. */
  function fold(s) {
    var t = String(s || '').toLowerCase();
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (err) { /* old engine */ }
    return t.replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /** Take from each list in turn: a1 b1 c1 a2 b2 c2 ... until `cap`. */
  function roundRobin(lists, cap) {
    var out = [];
    var idx = lists.map(function () { return 0; });
    var more = true;
    while (more && out.length < cap) {
      more = false;
      for (var i = 0; i < lists.length && out.length < cap; i++) {
        if (idx[i] < lists[i].length) { out.push(lists[i][idx[i]++]); more = true; }
      }
    }
    return out;
  }

  function byService(items, kind) {
    var lists = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || it.kind !== kind) continue;
      (lists[it.service] = lists[it.service] || []).push(it);
    }
    return ROUND_ROBIN.map(function (id) { return lists[id] || []; });
  }

  function dedupe(list, byTitle) {
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var key = byTitle ? 't:' + fold(it.title) : 'i:' + it.id;
      if (!key || seen[key]) continue;
      seen[key] = true;
      out.push(it);
    }
    return out;
  }

  /**
   * The rows. `services` is { id: { state, items, enabled } } (the cache);
   * a disabled service contributes nothing. Each row: { id, title, items, service? }.
   * Empty rows are left out; the page draws its own empty state.
   */
  function buildRows(services) {
    var all = [];
    var src = services && typeof services === 'object' ? services : {};
    var ids = Shape ? Shape.SERVICE_IDS : ROUND_ROBIN;
    for (var s = 0; s < ids.length; s++) {
      var entry = src[ids[s]];
      if (!entry || entry.enabled === false || !Array.isArray(entry.items)) continue;
      for (var k = 0; k < entry.items.length; k++) all.push(entry.items[k]);
    }

    var rows = [];
    var cont = dedupe(roundRobin(byService(all, 'resume'), ROW_CAP), false);
    if (cont.length) rows.push({ id: 'continue', title: 'Continue watching', items: cont });

    // Something already in Continue watching is not "for you" a second time.
    var inCont = {};
    cont.forEach(function (it) { inCont[fold(it.title)] = true; });
    var recs = roundRobin(byService(all, 'rec'), ROW_CAP * 2).filter(function (it) { return !inCont[fold(it.title)]; });
    recs = dedupe(recs, true).slice(0, ROW_CAP);
    if (recs.length) rows.push({ id: 'foryou', title: 'For you', items: recs });

    var wl = dedupe(roundRobin(byService(all, 'watchlist'), ROW_CAP), true);
    if (wl.length) rows.push({ id: 'watchlist', title: 'Watchlist', items: wl });

    // The services' own rows, in the services' order. YouTube's home feed has
    // no named shelves worth a row each, so it gets one "From YouTube" row.
    for (var j = 0; j < ids.length; j++) {
      var id = ids[j];
      if (id === 'espn') continue;
      var mine = all.filter(function (it) { return it.service === id && it.kind === 'rec'; });
      if (!mine.length) continue;
      var svc = Shape ? Shape.serviceById(id) : { name: id };
      var groups = [];
      var byGroup = {};
      var loose = [];
      mine.forEach(function (it) {
        if (!it.group) { loose.push(it); return; }
        if (!byGroup[it.group]) { byGroup[it.group] = []; groups.push(it.group); }
        byGroup[it.group].push(it);
      });
      var shown = 0;
      for (var g = 0; g < groups.length && shown < GROUPS_PER_SERVICE; g++) {
        var list = byGroup[groups[g]];
        if (list.length < GROUP_MIN) { loose = loose.concat(list); continue; }
        rows.push({ id: 'svc-' + id + '-' + g, title: groups[g], service: id, items: dedupe(list, false).slice(0, ROW_CAP) });
        shown++;
      }
      for (var r = g; r < groups.length; r++) loose = loose.concat(byGroup[groups[r]]);
      if (loose.length) {
        rows.push({ id: 'svc-' + id, title: shown ? 'More from ' + svc.name : 'From ' + svc.name, service: id, items: dedupe(loose, false).slice(0, ROW_CAP) });
      }
    }
    return rows;
  }

  /*
   * The sports strip: live first (NHL first among them, then the leagues'
   * order), then what starts in the next 36 h by start time, then finals from
   * the last 12 h, most recent first. `leagues` is the order the user chose.
   */
  function buildSports(events, now, leagues) {
    var list = Array.isArray(events) ? events.slice() : [];
    var order = Array.isArray(leagues) && leagues.length ? leagues : (Shape ? Shape.DEFAULT_LEAGUES : []);
    var rank = function (ev) { var i = order.indexOf(ev.league); return i === -1 ? 99 : i; };
    var t = typeof now === 'number' ? now : Date.now();
    var live = list.filter(function (e) { return e.state === 'in'; })
      .sort(function (a, b) { return rank(a) - rank(b) || a.startsAt - b.startsAt; });
    var soon = list.filter(function (e) { return e.state === 'pre' && e.startsAt - t < 36 * 3600e3 && e.startsAt - t > -3 * 3600e3; })
      .sort(function (a, b) { return a.startsAt - b.startsAt || rank(a) - rank(b); });
    var done = list.filter(function (e) { return e.state === 'post' && t - e.startsAt < 15 * 3600e3; })
      .sort(function (a, b) { return b.startsAt - a.startsAt || rank(a) - rank(b); });
    return { live: live, soon: soon, done: done, any: live.length + soon.length + done.length > 0 };
  }

  /** True when the strip shows a game in progress or one starting within 10 min: ESPN reads every 2 min then. */
  function sportsHot(events, now) {
    var t = typeof now === 'number' ? now : Date.now();
    if (!Array.isArray(events)) return false;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.state === 'in') return true;
      if (e.state === 'pre' && e.startsAt - t < 10 * 60e3 && e.startsAt - t > -30 * 60e3) return true;
    }
    return false;
  }

  /*
   * Search across what the services already gave us: every word of the query
   * must appear in the title or subtitle. A title that starts with the query
   * ranks first, then a whole-word match, then any match; then the row's own
   * order. One entry per title per service (resume beats watchlist beats rec).
   */
  var KIND_RANK = { resume: 0, live: 1, watchlist: 2, upcoming: 3, rec: 4, replay: 5, search: 6 };
  function searchLocal(items, q, cap) {
    var needle = fold(q);
    if (!needle) return [];
    var words = needle.split(' ');
    var scored = [];
    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || !it.title) continue;
      var title = fold(it.title);
      var hay = title + ' ' + fold(it.subtitle);
      var ok = true;
      for (var w = 0; w < words.length; w++) if (hay.indexOf(words[w]) === -1) { ok = false; break; }
      if (!ok) continue;
      var score = title.indexOf(needle) === 0 ? 0 : ((' ' + title + ' ').indexOf(' ' + needle + ' ') !== -1 ? 1 : 2);
      scored.push({ it: it, score: score, kind: KIND_RANK[it.kind] === undefined ? 9 : KIND_RANK[it.kind], i: i });
    }
    scored.sort(function (a, b) { return a.score - b.score || a.kind - b.kind || a.i - b.i; });
    var seen = {};
    var out = [];
    for (var j = 0; j < scored.length && out.length < (cap || 24); j++) {
      var key = scored[j].it.service + '|' + fold(scored[j].it.title);
      if (seen[key]) continue;
      seen[key] = true;
      out.push(scored[j].it);
    }
    return out;
  }

  /** The per-service "search there" links for a query: [{ service, name, url }]. */
  function searchLinks(q) {
    var text = String(q || '').trim().slice(0, 200);
    if (!text || !Shape) return [];
    return Shape.SERVICES.map(function (s) {
      var enc = encodeURIComponent(text);
      var url = s.searchUrl + (s.id === 'espn' ? enc.replace(/%20/g, '-') : enc);
      return { service: s.id, name: s.name, url: url, edge: Shape.opensInEdge(url) };
    });
  }

  var API = {
    buildRows: buildRows,
    buildSports: buildSports,
    sportsHot: sportsHot,
    searchLocal: searchLocal,
    searchLinks: searchLinks,
    roundRobin: roundRobin,
    fold: fold,
    ROW_CAP: ROW_CAP
  };

  if (typeof module === 'object' && module && module.exports) module.exports = API;
  if (typeof window !== 'undefined' && window) window.WatchMerge = API;
})();
