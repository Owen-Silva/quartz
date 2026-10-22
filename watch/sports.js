'use strict';
/*
 * watch/sports.js -- Lumen's sports pages, the PURE half: ESPN's public JSON read into the
 * shapes the game page, the team page, the standings page, "My teams" and "Watch this game"
 * draw. No Electron, no network, no clock of its own (every "now" is passed in), so
 * tests/sports-test.js drives all of it from hand-made fixtures. sports-main.js fetches;
 * watch/sportspage.js draws.
 *
 * It sits beside watch/scores.js (the pinned scores) and reuses it: the league table, the
 * text cleaners, the NHL game match (an ESPN game -> the NHL's own gamecenter id) and the
 * gamecast URLs. Nothing here duplicates the score pins' diff or their cadence.
 *
 * THE FEEDS (public JSON only: no cookies, no account, nothing written anywhere):
 *   game       site.api.espn.com/apis/site/v2/sports/<path>/summary?event=<id>
 *                header.competitions[0]  status, both teams, linescores (period scores), records
 *                boxscore.teams          team stats (shots, power play, hits ...)
 *                boxscore.players        goalies (hockey): saves, shots against, SV%, TOI
 *                scoringPlays | plays    the scoring summary by period (plays[].scoringPlay)
 *                plays (type Penalty)    the penalties by period (hockey)
 *                gameInfo.venue, broadcasts
 *              The same shape covers the NHL, NFL, NBA, MLB, college hockey and football.
 *   stars      the NHL's own landing (api-web.nhle.com, summary.threeStars), NHL finals only;
 *              its game id is found through scores.js matchNhlGame, exactly as the pins do.
 *   teams      .../<path>/teams                      the favourite picker's list
 *   schedule   .../<path>/teams/<teamId>/schedule     a team's season: next game, last result
 *   standings  site.api.espn.com/apis/v2/sports/<path>/standings (NHL ?level=3: divisions)
 *
 * Every parse*() never throws: a bad body gives { error: words }.
 */
var Scores = require('./scores');

var SITE = 'https://site.api.espn.com/apis/site/v2/sports/';
var V2 = 'https://site.api.espn.com/apis/v2/sports/';

/* The score pins' leagues, plus men's college hockey (the same summary shape as the NHL). */
var LEAGUES = Object.assign({}, Scores.LEAGUES, {
  chky: { name: 'College hockey', sport: 'hockey', path: 'hockey/mens-college-hockey', game: 'mens-college-hockey/game' }
});
/* The leagues with a standings page, in the order the page's tabs show them. */
var STANDINGS_LEAGUES = ['nhl', 'nfl', 'nba', 'mlb', 'chky', 'cfb', 'wnba', 'mls'];

/* How often an OPEN game page re-reads (nothing polls while it is closed). */
var POLL = { live: 20000, brk: 60000, soon: 60000, pre: 300000, backoff: [30000, 60000, 120000] };

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
function txt(v, max) {
  var s = str(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return max && s.length > max ? s.slice(0, max - 1).trim() + '…' : s;
}
function num(v) { var n = typeof v === 'number' ? v : parseFloat(str(v)); return isFinite(n) ? n : null; }
function https(u) {
  var s = str(u).trim();
  if (!/^https:\/\//i.test(s)) return '';
  try { return new URL(s).href; } catch (e) { return ''; }
}
function loc(v) { return obj(v) ? str(v.default) : str(v); }

function leagueOf(id) { return Object.prototype.hasOwnProperty.call(LEAGUES, id) ? LEAGUES[id] : null; }
function cleanId(v) { var s = str(v).replace(/^espn:/, ''); return /^\d{1,15}$/.test(s) ? s : ''; }
function summaryUrl(league, id) { var l = leagueOf(league); var e = cleanId(id); return l && e ? SITE + l.path + '/summary?event=' + e : ''; }
function teamsUrl(league) { var l = leagueOf(league); return l ? SITE + l.path + '/teams' + (/college/.test(l.path) ? '?limit=500' : '') : ''; }
function scheduleUrl(league, teamId) { var l = leagueOf(league); var t = cleanId(teamId); return l && t ? SITE + l.path + '/teams/' + t + '/schedule' : ''; }
function standingsUrl(league) { var l = leagueOf(league); return l ? V2 + l.path + '/standings' + (league === 'nhl' ? '?level=3' : '') : ''; }
function gamecastUrl(league, id) { var l = leagueOf(league); var e = cleanId(id); return l && e ? 'https://www.espn.com/' + l.game + '/_/gameId/' + e : ''; }
function teamPageUrl(league, abbr) {
  var l = leagueOf(league);
  return l && /^[a-z]{2,5}$/i.test(abbr) ? 'https://www.espn.com/' + l.game.split('/')[0] + '/team/_/name/' + abbr.toLowerCase() : '';
}
/** A gamecast URL -> { league, id }, or null (a score pin's click comes in as its gamecast). */
function gameFromUrl(url) {
  var m = /^https:\/\/(?:www\.)?espn\.com\/([a-z0-9-]+\/(?:game|match))\/_\/gameId\/(\d{4,15})/i.exec(str(url));
  if (!m) return null;
  for (var id in LEAGUES) if (LEAGUES[id].game === m[1].toLowerCase()) return { league: id, id: m[2] };
  return null;
}

/* ---------------------------------------------------------------- shared bits */

function logoOf(t) {
  var o = obj(t) || {};
  var l = https(o.logo);
  if (l) return l;
  var ls = arr(o.logos);
  for (var i = 0; i < ls.length; i++) if (obj(ls[i]) && https(ls[i].href)) return https(ls[i].href);
  return '';
}
function teamBasics(t) {
  var o = obj(t) || {};
  return {
    id: str(o.id),
    abbr: txt(o.abbreviation, 6).toUpperCase(),
    name: txt(o.displayName || o.name || o.shortDisplayName, 60),
    short: txt(o.shortDisplayName || o.name || o.displayName, 30),
    logo: logoOf(o)
  };
}
function scoreText(c) {
  if (!c) return '';
  if (obj(c.score)) return str(c.score.displayValue) || str(c.score.value);
  return str(c.score);
}
function recordOf(c) {
  var rs = arr(c && (c.record || c.records));
  for (var i = 0; i < rs.length; i++) {
    var r = obj(rs[i]);
    if (r && (r.type === 'total' || r.name === 'overall' || r.type === 'ytd')) return txt(r.summary || r.displayValue, 16);
  }
  var r0 = obj(rs[0]);
  return r0 ? txt(r0.summary || r0.displayValue, 16) : '';
}
function sides(comp) {
  var cs = arr(comp && comp.competitors), home = null, away = null;
  cs.forEach(function (c) { if (obj(c) && c.homeAway === 'home' && !home) home = c; else if (obj(c) && c.homeAway === 'away' && !away) away = c; });
  if (!home && cs.length >= 2) home = obj(cs[0]);
  if (!away && cs.length >= 2) away = obj(cs[1]);
  return { home: home, away: away };
}
/** ESPN's status -> { state, status, line, period, clock }. status: scheduled|live|break|final|postponed|canceled|suspended|delayed. */
function statusOf(st) {
  var s = obj(st) || {};
  var type = obj(s.type) || {};
  var state = str(type.state);
  if (state !== 'pre' && state !== 'in' && state !== 'post') state = '';
  var name = str(type.name).toUpperCase();
  var status = state === 'pre' ? 'scheduled' : state === 'in' ? 'live' : state === 'post' ? 'final' : '';
  if (/POSTPONED/.test(name)) status = 'postponed';
  else if (/CANCELED|CANCELLED/.test(name)) status = 'canceled';
  else if (/SUSPENDED/.test(name)) status = 'suspended';
  else if (/DELAYED|RAIN_DELAY/.test(name)) status = 'delayed';
  else if (state === 'in' && /END_PERIOD|HALFTIME|INTERMISSION|END_OF|END_REGULATION/.test(name)) status = 'break';
  return {
    state: state,
    status: status,
    line: txt(type.shortDetail || type.detail || type.description, 40),
    detail: txt(type.detail || type.shortDetail || type.description, 60),
    period: num(s.period),
    clock: txt(s.displayClock, 10)
  };
}
function broadcastNames(comp) {
  var out = [];
  var add = function (n) { n = txt(n, 30); if (n && out.indexOf(n) === -1) out.push(n); };
  arr(comp && comp.broadcasts).forEach(function (b) {
    if (!obj(b)) return;
    arr(b.names).forEach(add);
    if (obj(b.media)) add(b.media.shortName || b.media.name);
  });
  arr(comp && comp.geoBroadcasts).forEach(function (g) { if (obj(g) && obj(g.media)) add(g.media.shortName); });
  return out.slice(0, 6);
}

/* A period's label, from its number and the sport (hockey 1st/2nd/3rd/OT/SO, football Q1..). */
function periodLabel(sport, n, count, detail, isCollegeHoops) {
  if (!n) return '';
  if (sport === 'hockey') {
    if (n <= 3) return Scores_ordinal(n);
    if (n === 5 && /SO/.test(detail || '')) return 'SO';
    if (n === count && /SO/.test(detail || '') && n > 4) return 'SO';
    return n === 4 ? 'OT' : (n - 3) + 'OT';
  }
  if (sport === 'basketball') {
    if (isCollegeHoops) return n <= 2 ? (n === 1 ? '1st' : '2nd') : (n === 3 ? 'OT' : (n - 2) + 'OT');
    return n <= 4 ? 'Q' + n : (n === 5 ? 'OT' : (n - 4) + 'OT');
  }
  if (sport === 'football') return n <= 4 ? 'Q' + n : (n === 5 ? 'OT' : (n - 4) + 'OT');
  if (sport === 'soccer') return n === 1 ? '1st half' : n === 2 ? '2nd half' : 'ET';
  return String(n);   // baseball: innings
}
function Scores_ordinal(n) { return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n + 'th'; }
function periodHeading(sport, n, count, detail) {
  var l = periodLabel(sport, n, count, detail, false);
  if (sport === 'hockey') return n <= 3 ? l + ' period' : l === 'SO' ? 'Shootout' : l === 'OT' ? 'Overtime' : l + ' overtime';
  if (sport === 'football' || sport === 'basketball') return /^Q/.test(l) ? l.replace('Q', 'Quarter ') : l === 'OT' ? 'Overtime' : l;
  if (sport === 'baseball') return 'Inning ' + n;
  return l;
}

/* ---------------------------------------------------------------- the game */

var HOCKEY_STATS = [
  ['Shots', ['shotsTotal', 'shots', 'shotsOnGoal'], /^shots?( on goal)?$/i],
  ['Power play', ['powerPlay'], null],
  ['Faceoffs', ['faceoffPercent', 'faceOffPercent', 'faceoffsWonPct'], /^faceoff/i],
  ['Hits', ['hits'], /^hits$/i],
  ['Blocked shots', ['blockedShots'], /^blocked/i],
  ['Penalty minutes', ['penaltyMinutes'], /^penalty minutes|^pim$/i],
  ['Giveaways', ['giveaways'], /^giveaways$/i],
  ['Takeaways', ['takeaways'], /^takeaways$/i]
];
var FOOTBALL_STATS = [
  ['Total yards', ['totalYards'], /^total yards$/i], ['Passing', ['netPassingYards'], /^passing$/i],
  ['Rushing', ['rushingYards'], /^rushing$/i], ['Turnovers', ['turnovers'], /^turnovers$/i],
  ['1st downs', ['firstDowns'], /^1st downs$/i], ['3rd down', ['thirdDownEff'], /^3rd down/i],
  ['Possession', ['possessionTime'], /^possession/i], ['Penalties', ['totalPenaltiesYards'], /^penalties$/i]
];
var BASKETBALL_STATS = [
  ['Field goals', ['fieldGoalsMade-fieldGoalsAttempted'], /^fg$/i], ['FG %', ['fieldGoalPct'], /^field goal %$/i],
  ['3-pointers', ['threePointFieldGoalsMade-threePointFieldGoalsAttempted'], /^3pt$/i],
  ['Free throws', ['freeThrowsMade-freeThrowsAttempted'], /^ft$/i], ['Rebounds', ['totalRebounds'], /^rebounds$/i],
  ['Assists', ['assists'], /^assists$/i], ['Turnovers', ['turnovers', 'totalTurnovers'], /^turnovers$/i]
];

function flatStats(team) {
  // { name -> displayValue }, and label -> displayValue; baseball nests groups ({ name, stats: [] })
  var byName = {}, byLabel = {}, order = [];
  var put = function (s) {
    if (!obj(s)) return;
    var v = str(s.displayValue);
    if (!v) return;
    var n = str(s.name), l = txt(s.label || s.displayName || s.abbreviation, 30);
    if (n && !(n in byName)) byName[n] = v;
    if (l && !(l.toLowerCase() in byLabel)) byLabel[l.toLowerCase()] = v;
    if (l) order.push([l, n]);
  };
  arr(team && team.statistics).forEach(function (s) {
    if (obj(s) && Array.isArray(s.stats)) s.stats.forEach(put); else put(s);
  });
  return { byName: byName, byLabel: byLabel, order: order };
}
function pickStat(f, names, re) {
  for (var i = 0; i < names.length; i++) if (names[i] in f.byName) return f.byName[names[i]];
  if (re) for (var k in f.byLabel) if (re.test(k)) return f.byLabel[k];
  return '';
}
function teamStats(sport, away, home) {
  if (!away || !home) return [];
  var fa = flatStats(away), fh = flatStats(home);
  var table = sport === 'hockey' ? HOCKEY_STATS : sport === 'football' ? FOOTBALL_STATS : sport === 'basketball' ? BASKETBALL_STATS : null;
  var out = [];
  if (table) {
    table.forEach(function (row) {
      var a, h;
      if (row[1][0] === 'powerPlay') {
        var pp = function (f) {
          var g = pickStat(f, ['powerPlayGoals'], /^power play goals$/i), o = pickStat(f, ['powerPlayOpportunities'], /^power play opportunities$/i);
          return g !== '' && o !== '' ? g + '/' + o : '';
        };
        a = pp(fa); h = pp(fh);
      } else { a = pickStat(fa, row[1], row[2]); h = pickStat(fh, row[1], row[2]); }
      if (a !== '' || h !== '') out.push({ label: row[0], away: a || '–', home: h || '–' });
    });
  }
  if (!out.length) {
    // any sport we have no table for: the first stats both sides carry, in ESPN's order
    fa.order.forEach(function (p) {
      if (out.length >= 8) return;
      var h = p[1] ? fh.byName[p[1]] : fh.byLabel[p[0].toLowerCase()];
      var a = p[1] ? fa.byName[p[1]] : fa.byLabel[p[0].toLowerCase()];
      if (h !== undefined && a !== undefined && !out.some(function (o) { return o.label === p[0]; })) out.push({ label: p[0], away: a, home: h });
    });
  }
  return out;
}

function sideOfTeam(teamId, ids) {
  var t = str(teamId);
  if (t && t === ids.away) return 'away';
  if (t && t === ids.home) return 'home';
  return '';
}
function strengthTag(p) {
  var s = obj(p.strength);
  var words = (s ? str(s.abbreviation) + ' ' + str(s.text) : '') + ' ' + str(obj(p.type) && p.type.text) + ' ' + str(p.text);
  if (/\bshort[- ]?handed\b|\bSH\b/i.test(words)) return 'SH';
  if (/\bpower[- ]?play\b|\bPP\b/i.test(words)) return 'PP';
  if (/\bempty[- ]?net\b|\bEN\b/i.test(words)) return 'EN';
  if (/\bpenalty shot\b/i.test(words)) return 'PS';
  return '';
}
function groupByPeriod(list, sport, count, detail) {
  var groups = [];
  list.forEach(function (it) {
    var g = groups.length ? groups[groups.length - 1] : null;
    if (!g || g.period !== it.period) { g = { period: it.period, label: periodHeading(sport, it.period, count, detail), plays: [] }; groups.push(g); }
    g.plays.push(it.play);
  });
  return groups;
}

function goaliesOf(box, ids) {
  var out = [];
  arr(box && box.players).forEach(function (tp) {
    if (!obj(tp)) return;
    var side = sideOfTeam(obj(tp.team) && tp.team.id, ids);
    var abbr = obj(tp.team) ? txt(tp.team.abbreviation, 6).toUpperCase() : '';
    arr(tp.statistics).forEach(function (g) {
      if (!obj(g)) return;
      var keys = arr(g.keys).map(str), labels = arr(g.labels).map(function (l) { return str(l).toUpperCase(); });
      var isG = /goalie/i.test(str(g.name) + str(g.type)) || keys.indexOf('saves') !== -1 || labels.indexOf('SV') !== -1;
      if (!isG) return;
      var at = function (key, label) { var i = keys.indexOf(key); if (i === -1) i = labels.indexOf(label); return i; };
      var iSv = at('saves', 'SV'), iSa = at('shotsAgainst', 'SA'), iPct = at('savePct', 'SV%'), iToi = at('timeOnIce', 'TOI'), iGa = at('goalsAgainst', 'GA');
      arr(g.athletes).forEach(function (a) {
        if (!obj(a) || !obj(a.athlete)) return;
        var st = arr(a.stats).map(str);
        var toi = iToi >= 0 ? st[iToi] || '' : '';
        if (!toi && iSa >= 0 && !num(st[iSa])) return;          // dressed, never played
        if (toi && /^0?0:00$/.test(toi)) return;
        out.push({
          side: side, abbr: abbr,
          name: txt(a.athlete.displayName || a.athlete.shortName, 40),
          saves: iSv >= 0 ? st[iSv] || '' : '', shots: iSa >= 0 ? st[iSa] || '' : '',
          svPct: iPct >= 0 ? st[iPct] || '' : '', toi: toi, ga: iGa >= 0 ? st[iGa] || '' : '',
          starter: a.starter === true
        });
      });
    });
  });
  return out.slice(0, 6);
}

/** ESPN's summary JSON -> { game } or { error }. */
function parseSummary(json, league) {
  try {
    var lg = leagueOf(league);
    if (!lg) return { error: 'Lumen does not know the league "' + txt(league, 12) + '"' };
    var j = obj(json);
    if (!j) return { error: 'ESPN sent no game' };
    var header = obj(j.header);
    var comp = header ? obj(arr(header.competitions)[0]) : null;
    if (!comp) return { error: "ESPN's game data changed shape (no header)" };
    var st = statusOf(obj(comp.status) || obj(header.status));
    if (!st.state) return { error: "ESPN's game data changed shape (no game state)" };
    var sd = sides(comp);
    if (!sd.home || !sd.away) return { error: "ESPN's game data changed shape (no teams)" };
    var sport = lg.sport;
    var collegeHoops = sport === 'basketball' && /college/.test(lg.path);
    var mk = function (c) {
      var t = teamBasics(c.team);
      t.score = st.state === 'pre' ? '' : txt(scoreText(c), 6);
      t.record = recordOf(c);
      t.winner = c.winner === true;
      t.linescores = arr(c.linescores).map(function (l) { return obj(l) ? txt(l.displayValue !== undefined ? l.displayValue : l.value, 4) : txt(l, 4); });
      if (sport === 'baseball') { t.hits = txt(c.hits, 4); t.errors = txt(c.errors, 4); }
      return t;
    };
    var away = mk(sd.away), home = mk(sd.home);
    var ids = { away: away.id, home: home.id };
    var count = Math.max(away.linescores.length, home.linescores.length);
    var periods = [];
    for (var p = 1; p <= count; p++) periods.push(periodLabel(sport, p, count, st.detail, collegeHoops));

    // the scoring summary: scoringPlays when ESPN gives them (football), else plays[].scoringPlay;
    // basketball's every basket is not a summary, so it has none
    var plays = arr(j.plays);
    var scoringSrc = arr(j.scoringPlays).length ? arr(j.scoringPlays) : plays.filter(function (x) { return obj(x) && x.scoringPlay === true; });
    var scoring = null;
    if (sport !== 'basketball') {
      var sl = [];
      scoringSrc.forEach(function (x) {
        if (!obj(x)) return;
        var per = num(obj(x.period) ? x.period.number : x.period) || 0;
        var side = sideOfTeam(obj(x.team) && x.team.id, ids);
        var a = num(x.awayScore), h = num(x.homeScore);
        sl.push({ period: per, play: {
          clock: txt(obj(x.clock) ? x.clock.displayValue : x.clock, 10),
          side: side, abbr: side === 'away' ? away.abbr : side === 'home' ? home.abbr : '',
          text: txt(x.text, 220) || txt(obj(x.type) && x.type.text, 60),
          kind: txt(obj(x.scoringType) ? x.scoringType.displayName : (obj(x.type) ? x.type.text : ''), 30),
          tag: sport === 'hockey' ? strengthTag(x) : '',
          score: a !== null && h !== null ? a + '–' + h : ''
        } });
      });
      scoring = groupByPeriod(sl, sport, count, st.detail);
    }
    var penalties = null;
    if (sport === 'hockey') {
      var pl = [];
      plays.forEach(function (x) {
        if (!obj(x) || !/penalt/i.test(str(obj(x.type) && x.type.text))) return;
        var per = num(obj(x.period) ? x.period.number : x.period) || 0;
        var side = sideOfTeam(obj(x.team) && x.team.id, ids);
        var m = /(\d+)\s*(?:minutes?|min)\b/i.exec(str(x.text));
        pl.push({ period: per, play: {
          clock: txt(obj(x.clock) ? x.clock.displayValue : x.clock, 10),
          side: side, abbr: side === 'away' ? away.abbr : side === 'home' ? home.abbr : '',
          text: txt(x.text, 200), minutes: m ? Number(m[1]) : null
        } });
      });
      penalties = groupByPeriod(pl, sport, count, st.detail);
    }
    var box = obj(j.boxscore) || {};
    var bt = arr(box.teams), ta = null, th = null;
    bt.forEach(function (t) {
      if (!obj(t)) return;
      var s = sideOfTeam(obj(t.team) && t.team.id, ids) || (t.homeAway === 'home' ? 'home' : t.homeAway === 'away' ? 'away' : '');
      if (s === 'away' && !ta) ta = t; else if (s === 'home' && !th) th = t;
    });
    var info = obj(j.gameInfo) || {};
    var venue = obj(info.venue) ? txt(info.venue.fullName, 80) : '';
    var bc = broadcastNames(comp);
    arr(j.broadcasts).forEach(function (b) { var n = obj(b) && obj(b.media) ? txt(b.media.shortName, 30) : ''; if (n && bc.indexOf(n) === -1) bc.push(n); });
    var id = cleanId(header.id || comp.id);
    return { game: {
      id: id, league: league, leagueName: lg.name, sport: sport,
      state: st.state, status: st.status, line: st.line, detail: st.detail, period: st.period, clock: st.clock,
      startsAt: Date.parse(str(comp.date)) || null,
      away: away, home: home, periods: periods,
      scoring: scoring, penalties: penalties,
      goalies: sport === 'hockey' ? goaliesOf(box, ids) : null,
      teamStats: teamStats(sport, ta, th),
      venue: venue, broadcasts: bc.slice(0, 6),
      gamecastUrl: gamecastUrl(league, id),
      stars: null
    } };
  } catch (err) {
    return { error: "couldn't read ESPN's game (" + txt(err && err.message, 80) + ')' };
  }
}

/** The NHL landing's three stars -> [{ star, name, abbr, line }] (empty when it has none yet). */
function parseNhlStars(json) {
  var j = obj(json);
  var list = j && obj(j.summary) ? arr(j.summary.threeStars) : [];
  var out = [];
  list.forEach(function (s) {
    if (!obj(s)) return;
    var name = txt(loc(s.name) || [loc(s.firstName), loc(s.lastName)].join(' '), 40);
    if (!name) return;
    var line = '';
    if (num(s.savePctg) !== null || /G/.test(str(s.position))) {
      var pct = num(s.savePctg);
      line = pct !== null ? pct.toFixed(3).replace(/^0/, '') + ' SV%' : '';
    } else {
      var g = num(s.goals) || 0, a = num(s.assists) || 0;
      line = [g ? g + (g === 1 ? ' goal' : ' goals') : '', a ? a + (a === 1 ? ' assist' : ' assists') : ''].filter(Boolean).join(', ');
    }
    out.push({ star: num(s.star) || out.length + 1, name: name, abbr: txt(loc(s.teamAbbrev), 6).toUpperCase(), line: line });
  });
  return out.sort(function (a, b) { return a.star - b.star; }).slice(0, 3);
}

/** How long until an OPEN game page reads again (null: never; a final needs no polling). */
function nextPollMs(game, now, failures) {
  if (failures > 0) return POLL.backoff[Math.min(failures, POLL.backoff.length) - 1];
  if (!game) return POLL.live;
  if (game.state === 'post' || game.status === 'postponed' || game.status === 'canceled') return null;
  if (game.state === 'pre') {
    var until = (game.startsAt || 0) - now;
    return until <= 15 * 60e3 ? POLL.soon : POLL.pre;
  }
  if (game.status === 'break' || game.status === 'delayed' || game.status === 'suspended') return POLL.brk;
  return POLL.live;
}

/* ---------------------------------------------------------------- teams, schedules */

/** .../teams -> { teams: [{ id, abbr, name, short, logo }] } sorted by name, or { error }. */
function parseTeams(json, league) {
  var j = obj(json);
  if (!j) return { error: 'ESPN sent no team list' };
  var sp = obj(arr(j.sports)[0]);
  var lgs = sp ? arr(sp.leagues) : [];
  var raw = lgs.length && obj(lgs[0]) ? arr(lgs[0].teams) : arr(j.teams);
  var out = [];
  raw.forEach(function (t) {
    var b = teamBasics(obj(t) && obj(t.team) ? t.team : t);
    if (b.id && b.name && b.abbr) { b.league = league; out.push(b); }
  });
  if (!out.length) return { error: "ESPN's team list changed shape (no teams)" };
  out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return { teams: out };
}

/** A schedule/scoreboard event -> the event shape Lumen's game cards draw (watch.js normEvent). */
function eventOf(ev, league) {
  var e = obj(ev);
  var lg = leagueOf(league);
  if (!e || !lg) return null;
  var comp = obj(arr(e.competitions)[0]) || {};
  var st = statusOf(obj(comp.status) || obj(e.status));
  var sd = sides(comp);
  if (!sd.home || !sd.away || !st.state) return null;
  var mk = function (c) {
    var b = teamBasics(c.team);
    return { id: b.id, name: b.name || b.abbr, abbr: b.abbr, logo: b.logo, score: st.state === 'pre' ? '' : txt(scoreText(c), 6), record: recordOf(c), winner: c.winner === true };
  };
  var id = cleanId(e.id);
  if (!id) return null;
  return {
    id: 'espn:' + id, league: league, leagueName: lg.name,
    state: st.state, status: st.status, startsAt: Date.parse(str(e.date) || str(comp.date)) || null,
    detail: st.line, home: mk(sd.home), away: mk(sd.away),
    broadcasts: broadcastNames(comp), url: gamecastUrl(league, id), edge: false,
    postseason: (obj(e.seasonType) && num(e.seasonType.type) === 3) || (obj(e.season) && num(e.season.type) === 3)
  };
}
/** W 4-2 / L 1-3 / T 2-2 (or OTL), from the team's side. */
function resultFor(ev, teamId) {
  if (!ev || ev.state !== 'post' || ev.status === 'postponed' || ev.status === 'canceled') return '';
  var mine = ev.home.id === teamId ? ev.home : ev.away.id === teamId ? ev.away : null;
  var theirs = mine === ev.home ? ev.away : ev.home;
  if (!mine || mine.score === '' || theirs.score === '') return '';
  var a = Number(mine.score), b = Number(theirs.score);
  var tag = a > b || mine.winner ? 'W' : a === b ? 'T' : 'L';
  var ot = /OT|SO/.exec(ev.detail || '');
  return tag + ' ' + mine.score + '–' + theirs.score + (ot ? ' ' + ot[0] : '');
}

/** .../teams/<id>/schedule -> { team, events: [event + { result, opponent, home }] } or { error }. */
function parseSchedule(json, league, teamId) {
  var j = obj(json);
  if (!j) return { error: 'ESPN sent no schedule' };
  if (!Array.isArray(j.events)) return { error: "ESPN's schedule changed shape (no events)" };
  var t = obj(j.team) || {};
  var team = teamBasics(t);
  team.id = team.id || str(teamId);
  team.record = txt(t.recordSummary, 16);
  team.standing = txt(t.standingSummary, 60);
  var events = [];
  j.events.forEach(function (raw) {
    var e = eventOf(raw, league);
    if (!e) return;
    var isHome = e.home.id === team.id;
    e.isHome = isHome;
    e.opponent = isHome ? e.away : e.home;
    e.result = resultFor(e, team.id);
    events.push(e);
  });
  events.sort(function (a, b) { return (a.startsAt || 0) - (b.startsAt || 0); });
  return { team: team, events: events };
}

/**
 * One favourite's "My teams" card: the live game (fresher scoreboard events win), else the next
 * one, plus the last result. offseason: nothing ahead and the last game is over 3 weeks old.
 */
function teamCard(fav, sched, liveEvents, now) {
  var events = sched && sched.events ? sched.events.slice() : [];
  var fresh = {};
  arr(liveEvents).forEach(function (e) { if (obj(e) && e.league === fav.league) fresh[String(e.id)] = e; });
  events = events.map(function (e) {
    var f = fresh[e.id];
    if (!f) return e;
    var m = Object.assign({}, e, { state: f.state, detail: f.detail || e.detail, status: f.state === 'in' ? 'live' : e.status });
    m.home = Object.assign({}, e.home, { score: f.home && f.home.score !== undefined ? f.home.score : e.home.score });
    m.away = Object.assign({}, e.away, { score: f.away && f.away.score !== undefined ? f.away.score : e.away.score });
    m.result = resultFor(m, fav.id);
    if (f.url) m.watchUrl = f.url;
    return m;
  });
  // a live game on today's scoreboard that the schedule has not caught up with
  arr(liveEvents).forEach(function (f) {
    if (!obj(f) || f.league !== fav.league || f.state !== 'in') return;
    if (events.some(function (e) { return e.id === f.id; })) return;
    var ha = f.home && f.home.abbr === fav.abbr, aa = f.away && f.away.abbr === fav.abbr;
    if (ha || aa) events.push(Object.assign({}, f, { status: 'live', isHome: ha, opponent: ha ? f.away : f.home, result: '' }));
  });
  var live = null, next = null, last = null;
  events.forEach(function (e) {
    if (e.state === 'in') { if (!live) live = e; return; }
    if (e.state === 'pre' && e.status !== 'postponed' && e.status !== 'canceled' && (e.startsAt || 0) > now - 6 * 3600e3) { if (!next || e.startsAt < next.startsAt) next = e; return; }
    if (e.state === 'post' && e.result) { if (!last || e.startsAt > last.startsAt) last = e; }
  });
  var postponed = events.filter(function (e) { return e.status === 'postponed' && (e.startsAt || 0) > now - 3 * 86400e3; })[0] || null;
  var offseason = !live && !next && (!last || now - (last.startsAt || 0) > 21 * 86400e3);
  return {
    key: fav.league + ':' + fav.id, league: fav.league, leagueName: (leagueOf(fav.league) || {}).name || '',
    id: fav.id, abbr: fav.abbr, name: fav.name, logo: fav.logo,
    record: sched && sched.team ? sched.team.record : '', standing: sched && sched.team ? sched.team.standing : '',
    live: live, next: next, last: last, postponed: postponed, offseason: offseason
  };
}

/* ---------------------------------------------------------------- standings */

var STANDING_COLS = {
  hockey: [['GP', ['gamesPlayed'], ['GP']], ['W', ['wins'], ['W']], ['L', ['losses'], ['L']], ['OTL', ['otLosses', 'overtimeLosses'], ['OTL']],
    ['PTS', ['points'], ['PTS']], ['RW', ['regulationWins'], ['RW']], ['DIFF', ['pointDifferential', 'differential'], ['DIFF']], ['STRK', ['streak'], ['STRK']]],
  football: [['W', ['wins'], ['W']], ['L', ['losses'], ['L']], ['T', ['ties'], ['T']], ['PCT', ['winPercent'], ['PCT']],
    ['PF', ['pointsFor'], ['PF']], ['PA', ['pointsAgainst'], ['PA']], ['STRK', ['streak'], ['STRK']]],
  basketball: [['W', ['wins'], ['W']], ['L', ['losses'], ['L']], ['PCT', ['winPercent'], ['PCT']], ['GB', ['gamesBehind'], ['GB']], ['STRK', ['streak'], ['STRK']]],
  baseball: [['W', ['wins'], ['W']], ['L', ['losses'], ['L']], ['PCT', ['winPercent'], ['PCT']], ['GB', ['gamesBehind'], ['GB']], ['STRK', ['streak'], ['STRK']]],
  soccer: [['GP', ['gamesPlayed'], ['GP']], ['W', ['wins'], ['W']], ['D', ['ties'], ['D']], ['L', ['losses'], ['L']], ['GD', ['pointDifferential'], ['GD']], ['PTS', ['points'], ['P', 'PTS']]]
};
function statMap(stats) {
  var byName = {}, byAbbr = {}, val = {};
  arr(stats).forEach(function (s) {
    if (!obj(s)) return;
    var dv = str(s.displayValue) || str(s.value);
    if (str(s.name)) { byName[s.name] = dv; val[s.name] = num(s.value); }
    if (str(s.abbreviation)) byAbbr[s.abbreviation.toUpperCase()] = dv;
  });
  return { byName: byName, byAbbr: byAbbr, val: val };
}
function colValue(m, names, abbrs) {
  for (var i = 0; i < names.length; i++) if (names[i] in m.byName) return m.byName[names[i]];
  for (var k = 0; k < abbrs.length; k++) if (abbrs[k] in m.byAbbr) return m.byAbbr[abbrs[k]];
  return '';
}
function entriesOf(node, sport, league, cols) {
  var es = obj(node.standings) ? arr(node.standings.entries) : [];
  return es.map(function (e, i) {
    if (!obj(e)) return null;
    var t = teamBasics(e.team);
    if (!t.id && !t.name) return null;
    var m = statMap(e.stats);
    var note = obj(e.note) ? txt(e.note.description, 40) : '';
    return {
      id: t.id, abbr: t.abbr, name: t.name, short: t.short, logo: t.logo, league: league,
      cells: cols.map(function (c) { return colValue(m, c[1], c[2]); }),
      pts: m.val.points !== undefined ? m.val.points : null, gp: m.val.gamesPlayed !== undefined ? m.val.gamesPlayed : null,
      rw: m.val.regulationWins !== undefined ? m.val.regulationWins : null, order: i, note: note
    };
  }).filter(Boolean);
}
function nhlOrder(a, b) {
  // points, then fewer games played (a better points percentage), then regulation wins, then ESPN's order
  var pa = a.pts === null ? -1 : a.pts, pb = b.pts === null ? -1 : b.pts;
  if (pa !== pb) return pb - pa;
  if (a.gp !== null && b.gp !== null && a.gp !== b.gp) return a.gp - b.gp;
  if (a.rw !== null && b.rw !== null && a.rw !== b.rw) return b.rw - a.rw;
  return a.order - b.order;
}

/** .../standings -> { league, cols, groups: [{ name, parent, rows }], wildcard: null | [{ conference, divisions, race }] } or { error }. */
function parseStandings(json, league) {
  var lg = leagueOf(league);
  if (!lg) return { error: 'Lumen does not know the league "' + txt(league, 12) + '"' };
  var j = obj(json);
  if (!j) return { error: 'ESPN sent no standings' };
  var cols = STANDING_COLS[lg.sport] || STANDING_COLS.basketball;
  var groups = [];
  var walk = function (node, parent, depth) {
    if (!obj(node) || depth > 4) return;
    var name = txt(node.name || node.abbreviation, 60);
    if (obj(node.standings) && arr(node.standings.entries).length) groups.push({ name: name, parent: parent, rows: entriesOf(node, lg.sport, league, cols) });
    arr(node.children).forEach(function (c) { walk(c, name, depth + 1); });
  };
  walk(j, '', 0);
  if (!groups.length) {
    if (obj(j) && (Array.isArray(j.children) || obj(j.standings))) return { league: league, cols: cols.map(function (c) { return c[0]; }), groups: [], wildcard: null, empty: true };
    return { error: "ESPN's standings changed shape (no table)" };
  }
  // drop columns that are empty everywhere (a league that has no OTL, no RW)
  var keep = cols.map(function (c, i) { return groups.some(function (g) { return g.rows.some(function (r) { return r.cells[i] !== ''; }); }); });
  groups.forEach(function (g) { g.rows.forEach(function (r) { r.cells = r.cells.filter(function (_, i) { return keep[i]; }); }); });
  var colNames = cols.filter(function (_, i) { return keep[i]; }).map(function (c) { return c[0]; });
  var wildcard = null;
  if (league === 'nhl') {
    var byConf = {};
    groups.forEach(function (g) { if (g.parent && /division/i.test(g.name)) (byConf[g.parent] = byConf[g.parent] || []).push(g); });
    var confs = Object.keys(byConf);
    if (confs.length) {
      wildcard = confs.map(function (conf) {
        var divs = byConf[conf].map(function (g) {
          var sorted = g.rows.slice().sort(nhlOrder);
          return { name: g.name, top: sorted.slice(0, 3), rest: sorted.slice(3) };
        });
        var race = [];
        divs.forEach(function (d) { race = race.concat(d.rest); });
        race.sort(nhlOrder);
        return { conference: conf, divisions: divs.map(function (d) { return { name: d.name, rows: d.top }; }), race: race, cut: 2 };
      });
    }
  }
  return { league: league, cols: colNames, groups: groups, wildcard: wildcard };
}

/* ---------------------------------------------------------------- "Watch this game" */
/*
 * The broadcast names ESPN lists -> where it streams on the user's services, opened in Lumen's
 * player layer. Never a workaround: a blacked-out game shows the service's own "not
 * available in your area". Channels none of their services carry are named, with what
 * streams them, so the user knows where it is.
 */
var ESPN_NETS = /^(ESPN|ESPN2|ESPNU|ESPNEWS|ESPN Deportes|ABC|SECN|SEC Network|ACCN|ACC Network|ACCNX|SECN\+|Longhorn Network|ESPN Unlimited)$/i;
var HULU_LIVE = /^(ABC|ESPN|ESPN2|ESPNU|SECN|SEC Network|ACCN|ACC Network|FOX|FS1|FS2|NBC|USA Net|USA|CBS|CBSSN|TNT|TBS|truTV|NFL Net|NFL Network|BTN|Big Ten Network|Golf)$/i;
var ELSEWHERE = [
  [/^(TNT|TBS|truTV|Max|HBO Max)$/i, 'HBO Max'],
  [/^(NBC|Peacock|USA Net|USA|NBCSN)$/i, 'Peacock'],
  [/^(FOX|FS1|FS2|Fox Sports|BTN|Big Ten Network|FOX One)$/i, 'FOX One'],
  [/^(CBS|CBSSN|Paramount\+)$/i, 'Paramount+'],
  [/^(Apple TV|Apple TV\+|MLS Season Pass)$/i, 'Apple TV'],
  [/^(Netflix)$/i, 'Netflix'],
  [/^(NHL Net|NHL Network|MLB Net|MLB Network|MLB\.TV|NBA TV|NBA League Pass|NFL Net|NFL Network|NFL\+|NHL\.TV)$/i, '']
];
var ESPN_WATCH = 'https://www.espn.com/watch/';

/**
 * -> { options: [{ service, label, url, note }], airsOn: [names no service of theirs carries], words }.
 * ev: { league, broadcasts, url (a WatchESPN player URL when ESPN listed an airing), state }.
 */
function watchOptions(ev) {
  var e = obj(ev) || {};
  var names = arr(e.broadcasts).map(function (b) { return txt(b, 30); }).filter(Boolean);
  var player = /^https:\/\/(www\.)?espn\.com\/watch\/player/i.test(str(e.url)) ? https(e.url) : '';
  var options = [], airsOn = [], seen = {};
  var add = function (o) { if (!seen[o.service + o.label]) { seen[o.service + o.label] = 1; options.push(o); } };
  var espnPlus = names.some(function (n) { return /^ESPN\+$/i.test(n); });
  var espnNet = names.filter(function (n) { return ESPN_NETS.test(n); });
  var hulu = names.some(function (n) { return /^Hulu$/i.test(n); });
  var prime = names.some(function (n) { return /^(Prime Video|Amazon Prime Video|Prime|Amazon)$/i.test(n); });
  var disney = names.some(function (n) { return /^Disney\+$/i.test(n); });
  if (espnPlus) add({ service: 'espn', label: 'ESPN+', url: player || ESPN_WATCH, note: player ? 'Plays in Lumen' : "Opens ESPN's live listings in Lumen" });
  if (espnNet.length) {
    add({ service: 'espn', label: espnNet[0] + ' on ESPN', url: player || ESPN_WATCH, note: 'Needs ESPN Unlimited or a TV provider sign-in' });
    add({ service: 'disney', label: 'ESPN in Disney+', url: 'https://www.disneyplus.com/browse/espn', note: "The ESPN tile in Disney+ (with an ESPN plan)" });
  }
  if (prime) add({ service: 'prime', label: 'Prime Video', url: 'https://www.primevideo.com/', note: "Live games lead Prime Video's home page" });
  if (hulu) add({ service: 'hulu', label: 'Hulu', url: 'https://www.hulu.com/hub/sports', note: "Hulu's sports hub" });
  if (disney && !espnNet.length) add({ service: 'disney', label: 'Disney+', url: 'https://www.disneyplus.com/browse/espn', note: 'The ESPN tile in Disney+' });
  // Hulu + Live TV carries the big networks; whether the user has it is unknown, so it is said plainly
  var liveNet = names.filter(function (n) { return HULU_LIVE.test(n); })[0];
  if (liveNet) add({ service: 'hulu', label: liveNet + ' on Hulu + Live TV', url: 'https://www.hulu.com/live', note: 'Only if your Hulu plan includes Live TV', maybe: true });
  if (player && !options.length) add({ service: 'espn', label: 'ESPN', url: player, note: 'Plays in Lumen' });
  names.forEach(function (n) {
    if (/^ESPN\+$/i.test(n) || ESPN_NETS.test(n) || /^(Hulu|Disney\+|Prime Video|Amazon Prime Video|Prime|Amazon)$/i.test(n)) return;
    var where = '';
    for (var i = 0; i < ELSEWHERE.length; i++) if (ELSEWHERE[i][0].test(n)) { where = ELSEWHERE[i][1]; break; }
    var known = ELSEWHERE.some(function (x) { return x[0].test(n); });
    airsOn.push({ name: n, streams: where, regional: !known });
  });
  var words = '';
  var sure = options.filter(function (o) { return !o.maybe; });
  if (!sure.length) {
    if (!airsOn.length) words = e.state === 'post' ? 'ESPN lists no broadcast for this game.' : 'ESPN lists no broadcast for this game yet.';
    else words = 'Not on your services. Airs on ' + airsOn.map(function (a) { return a.name + (a.streams ? ' (streams on ' + a.streams + ')' : a.regional ? ' (regional TV)' : ''); }).join(', ') + '.' + (options.length ? ' Hulu + Live TV carries it, if your plan includes Live TV.' : '');
  } else if (airsOn.length) {
    words = 'Also on ' + airsOn.map(function (a) { return a.name; }).join(', ') + '.';
  }
  if (e.league === 'nhl' && espnPlus && !player) words = (words ? words + ' ' : '') + 'Out-of-market NHL games stream on ESPN+; local ones are blacked out there.';
  return { options: options.slice(0, 4), airsOn: airsOn, words: words };
}

/** A "big game": a national broadcast, or the postseason. The Live now row leads with these. */
var NATIONAL = /^(ABC|ESPN|ESPN2|TNT|TBS|truTV|NBC|FOX|CBS|Prime Video|Amazon Prime Video|NFL Network|NFL Net|Peacock|Netflix|Max|HBO Max|Apple TV)$/i;
function isBigGame(ev) {
  var e = obj(ev);
  if (!e) return false;
  if (e.postseason === true) return true;
  return arr(e.broadcasts).some(function (b) { return NATIONAL.test(txt(b, 30)); });
}

module.exports = {
  LEAGUES: LEAGUES,
  STANDINGS_LEAGUES: STANDINGS_LEAGUES,
  POLL: POLL,
  leagueOf: leagueOf,
  cleanId: cleanId,
  summaryUrl: summaryUrl,
  teamsUrl: teamsUrl,
  scheduleUrl: scheduleUrl,
  standingsUrl: standingsUrl,
  gamecastUrl: gamecastUrl,
  teamPageUrl: teamPageUrl,
  gameFromUrl: gameFromUrl,
  parseSummary: parseSummary,
  parseNhlStars: parseNhlStars,
  parseTeams: parseTeams,
  parseSchedule: parseSchedule,
  parseStandings: parseStandings,
  eventOf: eventOf,
  resultFor: resultFor,
  teamCard: teamCard,
  nextPollMs: nextPollMs,
  watchOptions: watchOptions,
  isBigGame: isBigGame,
  periodLabel: periodLabel,
  // reused from the score pins, so the game page finds the NHL game exactly as a pin does
  nhlScoreUrl: Scores.nhlScoreUrl,
  nhlLandingUrl: Scores.nhlLandingUrl,
  nhlDay: Scores.nhlDay,
  matchNhlGame: Scores.matchNhlGame
};
