'use strict';
/*
 * watch/alerts.js -- Lumen Alerts, the pure half: what is new, how it is said, and when it may be
 * said at all. No Electron, no files, no timers; watch-alerts-main.js owns those.
 *
 *   watch/alerts.js           this file: the subscriptions diff, the batch, the favourite-team game
 *                             moves (start / final), the gates, the saved prefs' shape
 *   watch-alerts-main.js      main process: hooks Lumen's existing reads, keeps the prefs, sends alerts
 *   watch-alerts-chrome.js    the chrome: shows an alert (Quartz's own notification path), the
 *                             Settings > Lumen "Alerts" field
 *   watch-alerts.css          the in-Quartz alert card and the Settings field
 *
 * NOTHING HERE READS. An alert only ever comes out of a read Lumen already made for its own rows:
 * the Subscriptions feed (watch/ytlib-main.js) and ESPN's scoreboard (watch-main.js's espn read).
 *
 * THE SUBSCRIPTIONS DIFF. The first good read is the baseline (nothing is "new" to an alert that has
 * never looked; the row's own "new since you last opened Lumen" marks are watch/ytlib.js's business).
 * After that, a video whose id was never in an earlier good read is new. Upcoming premieres are not
 * uploads and are skipped. One check makes at most ONE alert, however many videos it found.
 *
 * GAME MOVES. Per ESPN event key ('nhl:401892517') the last state seen ('pre' | 'in' | 'post').
 * pre -> in is a start; anything -> post is a final. A game first seen already 'in' is a start only
 * if it began within START_FRESH_MS (Lumen was closed, or he was gaming); a game first seen 'post'
 * is never announced, and a final more than FINAL_FRESH_MS after the start's planned time plus a
 * game's length is stale and dropped. Only games with one of the user's favourite teams count.
 */

var MAX_SEEN = 600;              // video ids remembered for the diff
var BATCH_LINES = 3;             // videos named in one alert's body
var MAX_GAMES = 120;             // event states remembered
var START_FRESH_MS = 30 * 60e3;  // a start announced up to 30 min late
var FINAL_FRESH_MS = 90 * 60e3;  // a final announced up to 90 min late (beyond a 4 h game)
var GAME_LONG_MS = 4 * 3600e3;
var HOT_BEFORE_MS = 10 * 60e3;   // ESPN reads at the live cadence from 10 min before a favourite's start
var GAME_KEEP_MS = 2 * 24 * 3600e3;
var MIN_FREE_GB = 2.5;           // the same floor as Lumen's background refresh

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function str(v) { return typeof v === 'string' ? v : ''; }
function text(v, max) { return str(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200); }
function isVideoId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id); }

/* --- prefs ------------------------------------------------------------------------------------ */

/**
 * The saved prefs, checked. subs: on unless turned off. teams: null = not chosen (on once a team is
 * picked), true / false = his choice. seen / baselined: the subscriptions diff. games: key -> state.
 */
function cleanPrefs(raw) {
  var r = obj(raw) || {};
  var seen = (Array.isArray(r.seen) ? r.seen : []).filter(isVideoId);
  var games = {};
  var g = obj(r.games) || {};
  var keys = Object.keys(g).filter(function (k) { return /^[a-z0-9.-]{2,16}:\d{3,15}$/.test(k); });
  keys.forEach(function (k) {
    var v = obj(g[k]);
    if (v && /^(pre|in|post)$/.test(v.state) && isFinite(v.at)) games[k] = { state: v.state, at: Number(v.at), said: str(v.said).slice(0, 8) };
  });
  return {
    v: 1,
    subs: r.subs !== false,
    teams: r.teams === true ? true : (r.teams === false ? false : null),
    baselined: r.baselined === true,
    seen: seen.slice(0, MAX_SEEN),
    games: games,
  };
}

/** Are team alerts on? An explicit choice wins; otherwise on once a favourite exists. */
function teamsOn(prefs, favCount) {
  if (prefs.teams === false) return false;
  if (prefs.teams === true) return true;
  return favCount > 0;
}

/* --- gates ------------------------------------------------------------------------------------ */

/**
 * Why no alert (and no extra read) may happen now ('' = it may). g: { gaming: '' | name,
 * gamingFlag: bool, freeGb: number, minFreeGb?: number }. Cheapest first.
 */
function gate(g) {
  var o = obj(g) || {};
  if (o.gamingFlag) return 'paused while a game is running';
  if (o.gaming) return 'paused while ' + (String(o.gaming).toLowerCase() === 'valorant' ? 'VALORANT' : String(o.gaming)) + ' is running';
  var floor = isFinite(o.minFreeGb) ? Number(o.minFreeGb) : MIN_FREE_GB;
  if (isFinite(o.freeGb) && Number(o.freeGb) < floor) return 'paused: only ' + Number(o.freeGb).toFixed(1) + ' GB of memory free (alerts need ' + floor + ' GB)';
  return '';
}

/* --- subscriptions ---------------------------------------------------------------------------- */

/**
 * The diff of one good read against what earlier reads held. prefs is changed in place (seen,
 * baselined) and the new videos come back in feed order (newest first): [{ vid, url, title, channel }].
 */
function diffSubs(prefs, items) {
  var list = (Array.isArray(items) ? items : []).filter(function (it) { return obj(it) && isVideoId(it.vid); });
  var known = {};
  prefs.seen.forEach(function (v) { known[v] = true; });
  var fresh = [];
  if (prefs.baselined) {
    list.forEach(function (it) {
      if (known[it.vid] || it.upcoming) return;
      fresh.push({
        vid: it.vid,
        url: /^https:\/\/(www\.|m\.)?youtube\.com\//.test(str(it.url)) ? it.url : 'https://www.youtube.com/watch?v=' + it.vid,
        title: text(it.title, 140) || 'a new video',
        channel: text(obj(it.channel) ? it.channel.name : it.channel, 60),
        live: !!it.live,
      });
    });
  }
  // Every id of this read joins the front of the remembered list (an upcoming one too: when it
  // premieres it is no surprise).
  var next = [];
  var have = {};
  list.forEach(function (it) { if (!have[it.vid]) { have[it.vid] = true; next.push(it.vid); } });
  prefs.seen.forEach(function (v) { if (!have[v]) { have[v] = true; next.push(v); } });
  prefs.seen = next.slice(0, MAX_SEEN);
  prefs.baselined = true;
  return fresh;
}

/** One line of a batch: "Channel: Title" (or just the title). */
function videoLine(v) {
  return (v.channel ? v.channel + ': ' : '') + v.title + (v.live ? ' (live now)' : '');
}

/**
 * The one alert for a check's new videos, or null. { kind: 'subs', id, title, body, lines, more,
 * items: [{ vid, url, title, channel }], action: 'play' }.
 */
function subsAlert(fresh, at) {
  if (!Array.isArray(fresh) || !fresh.length) return null;
  var n = fresh.length;
  var shown = fresh.slice(0, BATCH_LINES);
  var lines = shown.map(videoLine);
  var more = n - shown.length;
  return {
    kind: 'subs',
    id: 'subs-' + (Number(at) || 0) + '-' + fresh[0].vid,
    title: n === 1 ? 'New from ' + (fresh[0].channel || 'your subscriptions') : n + ' new from your subscriptions',
    body: n === 1 ? fresh[0].title + (fresh[0].live ? ' (live now)' : '') : lines.join('\n') + (more > 0 ? '\n…and ' + more + ' more' : ''),
    lines: lines,
    more: more,
    items: fresh.slice(0, 8).map(function (v) { return { vid: v.vid, url: v.url, title: v.title, channel: v.channel }; }),
    action: 'play',
    at: Number(at) || 0,
  };
}

/* --- favourite teams -------------------------------------------------------------------------- */

function eventKey(e) {
  var id = str(e && e.id).replace(/^espn:/, '');
  var lg = str(e && e.league).toLowerCase();
  return /^\d{3,15}$/.test(id) && /^[a-z0-9.-]{2,16}$/.test(lg) ? lg + ':' + id : '';
}

/** The favourite (if any) playing in this event: { fav, side: 'home' | 'away' }. */
function favIn(e, favs) {
  var list = Array.isArray(favs) ? favs : [];
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    if (!f || f.league !== e.league) continue;
    if (e.home && f.abbr && e.home.abbr === f.abbr) return { fav: f, side: 'home' };
    if (e.away && f.abbr && e.away.abbr === f.abbr) return { fav: f, side: 'away' };
  }
  return null;
}

/**
 * The start / final moves in one ESPN read, against prefs.games (changed in place: the new states,
 * old games dropped). Returns [{ type: 'start' | 'final', key, event, fav }].
 */
function gameMoves(prefs, events, favs, now) {
  var t = Number(now) || 0;
  var out = [];
  var games = prefs.games;
  (Array.isArray(events) ? events : []).forEach(function (e) {
    if (!obj(e) || !/^(pre|in|post)$/.test(e.state)) return;
    var key = eventKey(e);
    if (!key) return;
    var hit = favIn(e, favs);
    var was = games[key];
    if (!hit) { if (was) delete games[key]; return; }
    var startsAt = Number(e.startsAt) || 0;
    if (e.state === 'in' && (!was || was.state === 'pre')) {
      var late = startsAt ? t - startsAt : 0;
      if (was || late <= START_FRESH_MS) out.push({ type: 'start', key: key, event: e, fav: hit.fav });
    }
    if (e.state === 'post' && was && was.state !== 'post') {
      if (!startsAt || t - startsAt <= GAME_LONG_MS + FINAL_FRESH_MS) out.push({ type: 'final', key: key, event: e, fav: hit.fav });
    }
    games[key] = { state: e.state, at: t, said: was ? was.said : '' };
  });
  // Forget games not seen for two days, and keep the map small.
  var keys = Object.keys(games).sort(function (a, b) { return games[b].at - games[a].at; });
  keys.forEach(function (k, i) { if (i >= MAX_GAMES || t - games[k].at > GAME_KEEP_MS) delete games[k]; });
  return out;
}

function teamLabel(t) { return text(t && (t.abbr || t.name), 40); }
function scoreOf(t) { var s = t && t.score; return s === 0 || (typeof s === 'string' && s !== '') || isFinite(s) ? String(s) : ''; }

/**
 * One move -> its alert. A start offers "Pin this game" (score-pins-main.js does the pinning; an
 * alert never draws a score of its own) and "Open"; a final offers "Open".
 */
function gameAlert(move, at) {
  var e = move.event;
  var away = teamLabel(e.away);
  var home = teamLabel(e.home);
  var league = text(e.leagueName || str(e.league).toUpperCase(), 20);
  var detail = text(e.detail, 60);
  var tv = (Array.isArray(e.broadcasts) ? e.broadcasts : []).map(function (b) { return text(b, 24); }).filter(Boolean).slice(0, 2);
  var a = {
    kind: 'game',
    id: 'game-' + move.type + '-' + move.key,
    type: move.type,
    key: move.key,
    league: league,
    at: Number(at) || 0,
    event: e,
    actions: move.type === 'start' ? ['open', 'pin'] : ['open'],
    action: 'open',
  };
  if (move.type === 'start') {
    a.title = 'Game on: ' + away + ' at ' + home;
    a.body = [league, detail, tv.length ? 'on ' + tv.join(', ') : ''].filter(Boolean).join(' · ');
  } else {
    var as = scoreOf(e.away), hs = scoreOf(e.home);
    a.title = 'Final: ' + away + (as ? ' ' + as : '') + ', ' + home + (hs ? ' ' + hs : '');
    a.body = [league, detail && !/^final$/i.test(detail) ? detail : 'Final'].filter(Boolean).join(' · ');
  }
  return a;
}

/** Should ESPN read at its live cadence for the alerts? A favourite's game is on, or starts within 10 min. */
function espnHot(favs, events, now) {
  var t = Number(now) || 0;
  return (Array.isArray(events) ? events : []).some(function (e) {
    if (!obj(e) || !favIn(e, favs)) return false;
    if (e.state === 'in') return true;
    return e.state === 'pre' && Number(e.startsAt) > 0 && Number(e.startsAt) - t <= HOT_BEFORE_MS && t - Number(e.startsAt) <= START_FRESH_MS;
  });
}

module.exports = {
  cleanPrefs: cleanPrefs, teamsOn: teamsOn, gate: gate, diffSubs: diffSubs, subsAlert: subsAlert, videoLine: videoLine,
  eventKey: eventKey, favIn: favIn, gameMoves: gameMoves, gameAlert: gameAlert, espnHot: espnHot,
  MAX_SEEN: MAX_SEEN, BATCH_LINES: BATCH_LINES, START_FRESH_MS: START_FRESH_MS, FINAL_FRESH_MS: FINAL_FRESH_MS, MIN_FREE_GB: MIN_FREE_GB,
};
