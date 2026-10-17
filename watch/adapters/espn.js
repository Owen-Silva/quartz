'use strict';
/*
 * watch/adapters/espn.js -- the Live & Upcoming sports strip, from ESPN's
 * public JSON (FEASIBILITY.md section 4). No login, no view: fetch steps only.
 *
 *   <league>  https://site.api.espn.com/apis/site/v2/sports/<path>/scoreboard   (one per league, optional)
 *   watch     https://watch.product.api.espn.com/api/product/v3/watchespn/web/home?...  (optional)
 *
 * A watch listing's eventId IS the scoreboard gameId, so the two join: a game
 * with a live/replay airing gets https://www.espn.com/watch/player?id=<airing>,
 * otherwise it links to its gamecast.
 *
 * parse() never throws: any input gives { state, reason, items, events }.
 */
var shape = require('../shape');

var ID = 'espn';
var BUDGET_MS = 20000;
var SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/';
var WATCH_HOME = 'https://watch.product.api.espn.com/api/product/v3/watchespn/web/home';
var PLAYER = 'https://www.espn.com/watch/player?id=';
var UPCOMING_WINDOW_MS = 36 * 3600 * 1000;
var DEFAULT_TZ = 'America/Los_Angeles';
var MAX_REPLAYS = 12;

/* ESPN's own gamecast paths, used only when a scoreboard event carries no gamecast link. */
var GAMECAST_PATH = {
  nhl: 'nhl/game', nfl: 'nfl/game', nba: 'nba/game', mlb: 'mlb/game',
  cfb: 'college-football/game', mls: 'soccer/match', wnba: 'wnba/game'
};

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }

function leagueList(ctx) {
  var ids = ctx && Array.isArray(ctx.leagues) ? ctx.leagues : shape.DEFAULT_LEAGUES;
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var l = shape.leagueById(ids[i]);
    if (l && out.indexOf(l) === -1) out.push(l);
  }
  return out;
}

function tzOf(ctx) {
  var tz = ctx && typeof ctx.tz === 'string' ? ctx.tz : '';
  return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) ? tz : DEFAULT_TZ;
}

function steps(ctx) {
  var out = leagueList(ctx).map(function (l) {
    return { name: l.id, type: 'fetch', url: SCOREBOARD + l.path + '/scoreboard', as: 'json', optional: true, budgetMs: BUDGET_MS };
  });
  out.push({
    name: 'watch', type: 'fetch', as: 'json', optional: true, budgetMs: BUDGET_MS,
    url: WATCH_HOME + '?lang=en&countryCode=US&tz=' + encodeURIComponent(tzOf(ctx))
  });
  return out;
}

/* ---------------------------------------------------------------- reasons */

function reasonForError(err, status) {
  var e = obj(err) || {};
  var code = str(e.code);
  var detail = shape.cleanText(str(e.detail), 120);
  if (code === 'timeout') return 'timed out after ' + Math.round(BUDGET_MS / 1000) + ' s';
  if (code === 'offline') return "you're offline";
  if (code === 'http') return typeof status === 'number' && status ? 'HTTP ' + status : (detail || 'an HTTP error');
  if (code === 'bad-json') return 'it sent data that is not JSON';
  if (code === 'load-failed') return detail ? "it didn't load (" + detail + ')' : "it didn't load";
  if (code === 'crashed') return 'the reader crashed';
  return detail || 'the fetch failed';
}

/* { ok, json, reason, code } for one fetch step. */
function stepState(step) {
  if (!step || typeof step !== 'object') return { ok: false, json: null, reason: 'not fetched', code: 'missing' };
  if (step.error) {
    var code = str(obj(step.error) ? step.error.code : '') || 'failed';
    return { ok: false, json: null, reason: reasonForError(step.error, step.status), code: code };
  }
  if (step.ok === false) return { ok: false, json: null, reason: 'the fetch failed', code: 'failed' };
  var json = obj(step.json);
  if (!json) {
    if (step.json != null) return { ok: false, json: null, reason: 'it came back in a shape the reader does not know', code: 'shape' };
    return { ok: false, json: null, reason: 'it sent no JSON', code: 'nojson' };
  }
  return { ok: true, json: json, reason: '', code: '' };
}

/* ---------------------------------------------------------------- watch listings */

var LISTING_STATUS = { live: 'live', upcoming: 'upcoming', replay: 'replay', 'on-demand': 'replay', ondemand: 'replay' };

function imageOf(l) {
  var direct = str(l.imageHref) || str(obj(l.image) ? l.image.href : l.image) || str(l.thumbnail);
  if (direct) return direct;
  var imgs = arr(l.images);
  for (var i = 0; i < imgs.length; i++) {
    var u = str(obj(imgs[i]) ? (imgs[i].url || imgs[i].href) : imgs[i]);
    if (u) return u;
  }
  return '';
}

function networkOf(l) {
  var n = obj(l.network) ? (str(l.network.name) || str(l.network.shortName)) : str(l.network);
  if (n) return n;
  var streams = arr(l.streams);
  for (var i = 0; i < streams.length; i++) {
    var s = obj(streams[i]);
    if (s && (str(s.name) || str(s.source))) return str(s.name) || str(s.source);
  }
  return '';
}

/*
 * Every airing in the watch API home, wherever the buckets put it: an object
 * with a string airing id plus an eventId or a live/upcoming/replay status.
 * Bucket and league cards (no status, no eventId) are walked through, not taken.
 */
function listingsFrom(json) {
  var out = [];
  if (!json) return out;
  var seen = {};
  shape.walk(json, function (node) {
    var l = obj(node);
    if (!l) return true;
    var id = str(l.id);
    var status = LISTING_STATUS[str(l.status).toLowerCase()] || '';
    var eventId = str(l.eventId);
    if (!id || (!eventId && !status) || (!status && !str(l.name))) return true;
    if (!/^[A-Za-z0-9-]{4,80}$/.test(id)) return false;
    if (seen[id]) return false;
    seen[id] = true;
    out.push({
      id: id,
      eventId: eventId,
      status: status,
      name: shape.cleanText(str(l.name) || str(l.title) || str(l.headline), 200),
      subtitle: shape.cleanText(str(l.subtitle), 120),
      network: shape.cleanText(networkOf(l), 24),
      image: shape.cleanHttps(imageOf(l)),
      locked: typeof l.isLocked === 'boolean' ? l.isLocked : null,
      startsAt: Date.parse(str(l.startTime) || str(l.date) || '') || null
    });
    return false;
  });
  return out;
}

/* ---------------------------------------------------------------- scoreboard events */

function teamOf(c, state) {
  var t = obj(c && c.team) || {};
  var logo = str(t.logo);
  if (!logo) {
    var logos = arr(t.logos);
    if (logos.length && obj(logos[0])) logo = str(logos[0].href);
  }
  var score = '';
  if (state !== 'pre' && c) score = obj(c.score) ? str(c.score.displayValue) : str(c.score);
  var rec = arr(c && c.records);
  var record = '';
  for (var i = 0; i < rec.length; i++) {
    var r = obj(rec[i]);
    if (r && str(r.summary) && (!record || r.type === 'total' || r.name === 'overall')) { record = str(r.summary); if (r.type === 'total' || r.name === 'overall') break; }
  }
  return {
    name: str(t.displayName) || str(t.name) || str(t.shortDisplayName),
    abbr: str(t.abbreviation),
    logo: logo,
    score: score,
    record: record
  };
}

function gamecastOf(ev, league) {
  var links = arr(ev.links);
  var best = '';
  for (var i = 0; i < links.length; i++) {
    var l = obj(links[i]);
    if (!l) continue;
    var rel = arr(l.rel).map(function (r) { return str(r).toLowerCase(); });
    if (rel.indexOf('summary') === -1 && rel.indexOf('gamecast') === -1) continue;
    var href = shape.cleanHttps(str(l.href));
    if (!href) continue;
    if (!best || rel.indexOf('desktop') !== -1) best = href;
    if (rel.indexOf('desktop') !== -1) break;
  }
  if (best) return best;
  var id = str(ev.id);
  if (/^\d{4,15}$/.test(id) && GAMECAST_PATH[league.id]) return 'https://www.espn.com/' + GAMECAST_PATH[league.id] + '/_/gameId/' + id;
  return '';
}

function broadcastsOf(comp) {
  var out = [];
  arr(comp.broadcasts).forEach(function (b) {
    arr(b && b.names).forEach(function (n) { if (str(n)) out.push(str(n)); });
  });
  arr(comp.geoBroadcasts).forEach(function (g) {
    var n = obj(g) && obj(g.media) ? str(g.media.shortName) : '';
    if (n) out.push(n);
  });
  return out;
}

function eventFrom(ev, league) {
  if (!obj(ev)) return null;
  var comp = obj(arr(ev.competitions)[0]) || {};
  var status = obj(ev.status) || obj(comp.status) || {};
  var type = obj(status.type) || {};
  var state = str(type.state);
  var cs = arr(comp.competitors);
  var home = null;
  var away = null;
  for (var i = 0; i < cs.length; i++) {
    var c = obj(cs[i]);
    if (!c) continue;
    if (c.homeAway === 'home' && !home) home = c;
    else if (c.homeAway === 'away' && !away) away = c;
  }
  if (!home && cs.length >= 2) home = obj(cs[0]);
  if (!away && cs.length >= 2) away = obj(cs[1]);
  return {
    id: str(ev.id),
    league: league.id,
    leagueName: league.name,
    state: state,
    startsAt: Date.parse(str(ev.date) || str(comp.date)),
    detail: str(type.shortDetail) || str(type.detail) || str(type.description),
    home: teamOf(home, state),
    away: teamOf(away, state),
    broadcasts: broadcastsOf(comp),
    watchUrl: '',
    gamecastUrl: gamecastOf(ev, league),
    locked: null
  };
}

var WANT_STATUS = { 'in': 'live', pre: 'upcoming', post: 'replay' };

function pickListing(list, state) {
  if (!list || !list.length) return null;
  var want = WANT_STATUS[state];
  for (var i = 0; i < list.length; i++) if (list[i].status === want) return list[i];
  if (state === 'pre') return null;                // a replay of last night is not this game's stream
  for (var j = 0; j < list.length; j++) if (list[j].status === 'live' || !list[j].status) return list[j];
  return null;
}

/* ---------------------------------------------------------------- parse */

function fail(reason) {
  return { state: 'error', reason: reason, items: [], profile: '', events: [] };
}

function inferLeagues(read, ctx) {
  if (ctx && Array.isArray(ctx.leagues)) return leagueList(ctx);
  var out = [];
  shape.LEAGUES.forEach(function (l) { if (read.steps[l.id]) out.push(l); });
  return out.length ? out : leagueList(null);
}

function allSame(list) {
  for (var i = 1; i < list.length; i++) if (list[i] !== list[0]) return false;
  return true;
}

function parseInner(read, ctx) {
  if (!read || typeof read !== 'object' || !read.steps || typeof read.steps !== 'object' || Array.isArray(read.steps)) {
    return fail('the reader returned nothing it could use');
  }
  var now = (typeof read.now === 'number' && isFinite(read.now)) ? read.now
    : ((ctx && typeof ctx.now === 'number' && isFinite(ctx.now)) ? ctx.now : Date.now());
  var leagues = inferLeagues(read, ctx);

  var okLeagues = [];
  var failed = [];         // { league, reason, code }
  var raw = [];
  leagues.forEach(function (l) {
    var s = stepState(read.steps[l.id]);
    if (s.ok && !Array.isArray(s.json.events)) s = { ok: false, reason: 'it came back in a shape the reader does not know', code: 'shape' };
    if (!s.ok) { failed.push({ league: l, reason: s.reason, code: s.code }); return; }
    okLeagues.push(l.id);
    s.json.events.forEach(function (ev) { var e = eventFrom(ev, l); if (e) raw.push(e); });
  });

  var watch = stepState(read.steps.watch);
  var listings = watch.ok ? listingsFrom(watch.json) : [];

  if (!okLeagues.length) {
    if (!leagues.length) {
      if (watch.ok) return { state: 'ok', reason: '', items: replayItems(listings, {}), profile: '', events: [], counts: { leagues: 0 } };
      return fail('no leagues are picked and ESPN Watch ' + (watch.code === 'missing' ? "wasn't fetched" : "didn't answer (" + watch.reason + ')'));
    }
    var codes = failed.map(function (f) { return f.code; });
    if (allSame(codes) && codes[0] === 'offline') return fail("you're offline");
    if (allSame(codes) && codes[0] === 'missing') return fail("the reader didn't fetch any ESPN scoreboard");
    if (allSame(codes) && codes[0] === 'shape') return fail("ESPN's scoreboard came back in a shape the reader doesn't know (ESPN changed its API?)");
    var reasons = failed.map(function (f) { return f.reason; });
    if (allSame(reasons)) return fail("ESPN's scoreboard didn't answer (" + reasons[0] + ')');
    return fail("ESPN's scoreboard didn't answer (" + failed.map(function (f) { return f.league.name + ': ' + f.reason; }).join('; ') + ')');
  }

  // Join the watch airings onto the games by eventId.
  var byEvent = {};
  listings.forEach(function (l) { if (l.eventId) (byEvent[l.eventId] = byEvent[l.eventId] || []).push(l); });
  var imageByEvent = {};
  raw.forEach(function (e) {
    var hit = pickListing(byEvent[e.id], e.state);
    if (hit) {
      e.watchUrl = PLAYER + encodeURIComponent(hit.id);
      e.locked = hit.locked;
      if (hit.image) imageByEvent[e.id] = hit.image;
    } else {
      var any = byEvent[e.id] && byEvent[e.id][0];
      if (any && any.image) imageByEvent[e.id] = any.image;
      if (any && any.locked !== null) e.locked = any.locked;
    }
  });

  var events = shape.cleanEvents(raw);
  var order = {};
  leagues.forEach(function (l, i) { order[l.id] = i; });
  var TIER = { 'in': 0, pre: 1, post: 2 };
  events.sort(function (a, b) {
    var t = TIER[a.state] - TIER[b.state];
    if (t) return t;
    var lg = (order[a.league] || 0) - (order[b.league] || 0);
    if (lg) return lg;
    return a.state === 'post' ? b.startsAt - a.startsAt : a.startsAt - b.startsAt;
  });

  var items = [];
  var byId = {};
  events.forEach(function (e) {
    byId[e.id.replace(/^espn:/, '')] = e;
    var kind = e.state === 'in' ? 'live' : (e.state === 'pre' && e.startsAt - now <= UPCOMING_WINDOW_MS ? 'upcoming' : '');
    if (!kind) return;
    items.push({
      id: e.id,
      service: ID,
      kind: kind,
      title: (e.away.name || e.away.abbr) + ' at ' + (e.home.name || e.home.abbr),
      subtitle: e.leagueName + (e.broadcasts.length ? ' · ' + e.broadcasts.join(', ') : ''),
      image: imageByEvent[e.id.replace(/^espn:/, '')] || '',
      progress: null,
      url: e.watchUrl || e.gamecastUrl,
      startsAt: e.startsAt,
      durationSec: null,
      badge: kind === 'live' ? 'Live' : (e.broadcasts[0] || ''),
      group: kind === 'live' ? 'Live now' : 'Starting soon'
    });
  });
  items = shape.cleanItems(items.concat(replayItems(listings, byId)));

  var warnings = failed.map(function (f) { return f.league.name + ': ' + f.reason; });
  if (!watch.ok && watch.code !== 'missing') warnings.push("ESPN Watch didn't answer (" + watch.reason + '), so games link to their gamecast');
  var counts = {
    events: events.length,
    live: events.filter(function (e) { return e.state === 'in'; }).length,
    upcoming: events.filter(function (e) { return e.state === 'pre'; }).length,
    final: events.filter(function (e) { return e.state === 'post'; }).length,
    replays: items.filter(function (i) { return i.kind === 'replay'; }).length,
    listings: listings.length,
    leaguesOk: okLeagues,
    leaguesFailed: failed.map(function (f) { return f.league.id; })
  };
  return { state: 'ok', reason: '', items: items, profile: '', events: events, counts: counts, warnings: warnings };
}

function replayItems(listings, byId) {
  var out = [];
  for (var i = 0; i < listings.length && out.length < MAX_REPLAYS; i++) {
    var l = listings[i];
    if (l.status !== 'replay') continue;
    var ev = l.eventId ? byId[l.eventId] : null;
    var title = ev ? (ev.away.name || ev.away.abbr) + ' at ' + (ev.home.name || ev.home.abbr) : l.name;
    var sub = [];
    if (ev) sub.push(ev.leagueName);
    if (l.subtitle && !ev) sub.push(l.subtitle);
    if (l.network) sub.push(l.network);
    out.push({
      id: ID + ':' + l.id,
      service: ID,
      kind: 'replay',
      title: title,
      subtitle: sub.join(' · '),
      image: l.image,
      progress: null,
      url: PLAYER + encodeURIComponent(l.id),
      startsAt: null,
      durationSec: null,
      badge: 'Replay',
      group: 'Replays'
    });
  }
  return out;
}

function parse(read, ctx) {
  try {
    return parseInner(read, ctx);
  } catch (err) {
    return fail('the reader hit a bug (' + shape.cleanText(String((err && err.message) || err), 80) + ')');
  }
}

module.exports = {
  id: ID,
  steps: steps,
  parse: parse,
  _internals: { listingsFrom: listingsFrom, eventFrom: eventFrom, reasonForError: reasonForError }
};
