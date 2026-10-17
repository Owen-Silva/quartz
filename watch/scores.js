'use strict';
/*
 * watch/scores.js -- Lumen's pinned scores: the feeds, read into one shape, and the
 * diff that turns two readings of a game into the events a pinned card animates.
 *
 * PURE. No Electron, no network, no clock of its own (every "now" is passed in), so
 * tests/scores-test.js drives all of it from fixtures. score-pins-main.js does the
 * fetching and the windows; score-pin.js draws what this file decides.
 *
 * THE FEEDS (public JSON only: no cookies, no account, nothing written anywhere):
 *
 *   every league   ESPN's single-event scoreboard
 *                    https://site.api.espn.com/apis/site/v2/sports/<path>/scoreboard/<eventId>
 *                  ~16 KB a game: score, period, clock, status. Per sport it also has
 *                    football  situation.lastPlay (the scoring play's type and text), down & distance
 *                    baseball  situation (balls, strikes, outs, runners) and lastPlay
 *                    soccer    competitions[0].details: goals, own goals, penalty kicks, yellow and red cards
 *                    basketball and hockey: nothing beyond the score (no penalties, no strength)
 *   NHL            the NHL's own gamecenter landing, which ESPN does not match for hockey:
 *                    https://api-web.nhle.com/v1/gamecenter/<nhlGameId>/landing
 *                  ~7-60 KB: score, period, clock (running / intermission), the on-ice
 *                  situation (situationCode + the power play's time left), every goal
 *                  (scorer, season total, strength, eventId) and every penalty (type,
 *                  minutes, team). Its game id is found ONCE per pin from
 *                    https://api-web.nhle.com/v1/score/<YYYY-MM-DD>
 *                  by matching both teams' abbreviations (ESPN says TB / NJ / SJ / LA,
 *                  the NHL TBL / NJD / SJS / LAK, so a prefix match either way).
 *                  When the NHL feed fails, the same tick falls back to ESPN for the score,
 *                  and the card says penalties are paused (score-pins-main.js).
 *
 * THE SHAPE (a "reading"; parse*() never throw, a bad body gives { error }):
 *   { key, league, sport, source: 'espn'|'nhl', state: 'pre'|'in'|'post', phase:
 *     'pre'|'live'|'break'|'final'|'off', startsAt, line (the period/clock text the card
 *     shows), period, clock, away/home: { abbr, name, logo, score (number|null) },
 *     strength: null | { kind: 'pp'|'en'|'even', side, text, secondsLeft },
 *     goals: [...] | null, penalties: [...] | null, lastPlay: null | {...}, situation }
 *   goals/penalties are null when the source has no such list (ESPN hockey): the diff
 *   then never invents penalty events from a list that simply was not there.
 *
 * THE DIFF (diff(prev, next, opts) -> [event]):
 *   - no prev (a card that just opened, or a restored pin) -> no events: history is
 *     never replayed, and never makes a sound.
 *   - a side's score went UP -> one score event (goal / touchdown / field goal / run ...),
 *     labelled from the newest goal or scoring play of that side when the feed has one.
 *     Score deltas drive it, so a source switch (NHL <-> ESPN) never fakes a goal.
 *   - a side's score went DOWN -> 'overturned' (a disallowed or corrected goal).
 *   - a new penalty / card in the same source's list -> 'penalty' (or 'card').
 *   - a power play that was on and is not -> 'pp-end' (quiet: the indicator goes).
 *   - state turned post -> 'final'.
 *   opts.quiet (a long gap, e.g. the PC slept) marks every event quiet: it animates
 *   but plays no sound.
 */

var ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/';
var NHL_BASE = 'https://api-web.nhle.com/v1/';

/* The leagues a pin may be for. id = Lumen's league id (watch/shape.js) where it has one. */
var LEAGUES = {
  nhl: { name: 'NHL', sport: 'hockey', path: 'hockey/nhl', game: 'nhl/game' },
  nfl: { name: 'NFL', sport: 'football', path: 'football/nfl', game: 'nfl/game' },
  cfb: { name: 'College football', sport: 'football', path: 'football/college-football', game: 'college-football/game' },
  nba: { name: 'NBA', sport: 'basketball', path: 'basketball/nba', game: 'nba/game' },
  wnba: { name: 'WNBA', sport: 'basketball', path: 'basketball/wnba', game: 'wnba/game' },
  mcbb: { name: 'College basketball', sport: 'basketball', path: 'basketball/mens-college-basketball', game: 'mens-college-basketball/game' },
  mlb: { name: 'MLB', sport: 'baseball', path: 'baseball/mlb', game: 'mlb/game' },
  mls: { name: 'MLS', sport: 'soccer', path: 'soccer/usa.1', game: 'soccer/match' },
  epl: { name: 'Premier League', sport: 'soccer', path: 'soccer/eng.1', game: 'soccer/match' },
  ucl: { name: 'Champions League', sport: 'soccer', path: 'soccer/uefa.champions', game: 'soccer/match' }
};

/* Poll cadence (ms). Live 15 s, a power play or a close finish 10 s, a break 60 s,
   pre-game at most every 5 min, a failure backs off 30 / 60 / 120 s. Final = stop. */
var POLL = {
  live: 15000, hot: 10000, brk: 60000, preMax: 300000, preLate: 60000,
  backoff: [30000, 60000, 120000]
};
var QUIET_GAP_MS = 180000;   // events after a gap longer than this animate but stay silent

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
function loc(v) { return obj(v) ? str(v.default) : str(v); }   // the NHL's { default: 'Seattle' } strings

function leagueOf(id) { return Object.prototype.hasOwnProperty.call(LEAGUES, id) ? LEAGUES[id] : null; }
function espnEventUrl(league, espnId) { var l = leagueOf(league); return l ? ESPN_BASE + l.path + '/scoreboard/' + espnId : ''; }
function nhlScoreUrl(day) { return NHL_BASE + 'score/' + day; }
function nhlLandingUrl(nhlId) { return NHL_BASE + 'gamecenter/' + nhlId + '/landing'; }
function gamecastUrl(league, espnId) { var l = leagueOf(league); return l ? 'https://www.espn.com/' + l.game + '/_/gameId/' + espnId : ''; }

/* The NHL's calendar day for a start time: the US Eastern date. */
function nhlDay(startsAt) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(startsAt));
  } catch (e) { return new Date(startsAt).toISOString().slice(0, 10); }
}

/* --------------------------------------------------------------- the pin itself */

/**
 * A pin request from the Lumen page or the palette (untrusted: a console line or IPC),
 * checked into { key, league, espnId, title, away, home, startsAt, url } or null.
 * Accepts Lumen's event shape: { id: 'espn:401892522', league, startsAt, home, away, gamecastUrl }.
 */
function cleanPin(raw) {
  var r = obj(raw);
  if (!r) return null;
  var league = str(r.league).toLowerCase();
  if (!leagueOf(league)) return null;
  var espnId = str(r.espnId || r.id).replace(/^espn:/, '');
  if (!/^\d{3,15}$/.test(espnId)) return null;
  var team = function (t) {
    var o = obj(t) || {};
    return { abbr: txt(o.abbr, 6).toUpperCase(), name: txt(o.name, 40), logo: https(o.logo) };
  };
  var away = team(r.away);
  var home = team(r.home);
  if (!(away.abbr || away.name) || !(home.abbr || home.name)) return null;
  if (!away.abbr) away.abbr = away.name.slice(0, 3).toUpperCase();
  if (!home.abbr) home.abbr = home.name.slice(0, 3).toUpperCase();
  var startsAt = num(r.startsAt);
  // The gamecast is the one page a card opens; anything that is not ESPN's gets ESPN's own.
  var url = https(r.url || r.gamecastUrl);
  if (!/^https:\/\/(www\.)?espn\.com\//i.test(url) || /\/watch\/player/i.test(url)) url = gamecastUrl(league, espnId);
  var nhlId = str(r.nhlId);
  return {
    key: league + ':' + espnId,
    league: league,
    espnId: espnId,
    nhlId: /^\d{10}$/.test(nhlId) ? nhlId : '',
    title: away.abbr + ' at ' + home.abbr,
    away: away,
    home: home,
    startsAt: startsAt === null ? null : Math.round(startsAt),
    url: url
  };
}

/* --------------------------------------------------------------- ESPN */

function ordinal(n) {
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return n + 'th';
}

/* ESPN's status.type.name, folded into the card's phase. */
function espnPhase(state, typeName) {
  var n = str(typeName).toUpperCase();
  if (state === 'pre') return n.indexOf('POSTPONED') !== -1 || n.indexOf('CANCELED') !== -1 ? 'off' : 'pre';
  if (state === 'post') return n.indexOf('POSTPONED') !== -1 || n.indexOf('CANCELED') !== -1 || n.indexOf('SUSPENDED') !== -1 ? 'off' : 'final';
  if (/END_PERIOD|HALFTIME|INTERMISSION|END_OF|DELAYED|RAIN_DELAY|END_REGULATION/.test(n)) return 'break';
  return 'live';
}

function espnTeam(c, pinTeam) {
  var t = obj(c && c.team) || {};
  var logo = https(t.logo);
  if (!logo) { var ls = arr(t.logos); if (ls.length && obj(ls[0])) logo = https(ls[0].href); }
  var p = pinTeam || {};
  return {
    id: str(t.id),
    abbr: txt(t.abbreviation, 6).toUpperCase() || p.abbr || '',
    name: txt(t.shortDisplayName || t.displayName || t.name, 40) || p.name || '',
    logo: p.logo || logo,
    score: num(obj(c && c.score) ? c.score.value : (c && c.score))
  };
}

/** ESPN's single-event JSON (or a scoreboard holding it) -> a reading, or { error }. */
function parseEspn(json, pin) {
  try {
    var j = obj(json);
    if (!j) return { error: 'it sent no game' };
    var ev = j;
    if (Array.isArray(j.events)) {
      ev = null;
      for (var i = 0; i < j.events.length; i++) if (obj(j.events[i]) && str(j.events[i].id) === pin.espnId) { ev = j.events[i]; break; }
      if (!ev) return { error: 'this game is not on its scoreboard any more' };
    }
    var comp = obj(arr(ev.competitions)[0]);
    if (!comp) return { error: 'its data changed shape (no competition)' };
    var status = obj(ev.status) || obj(comp.status) || {};
    var type = obj(status.type) || {};
    var state = str(type.state);
    if (state !== 'pre' && state !== 'in' && state !== 'post') return { error: 'its data changed shape (no game state)' };
    var cs = arr(comp.competitors);
    var home = null, away = null;
    cs.forEach(function (c) { if (obj(c) && c.homeAway === 'home') home = c; else if (obj(c) && c.homeAway === 'away') away = c; });
    if (!home || !away) return { error: 'its data changed shape (no teams)' };
    var league = leagueOf(pin.league);
    var sport = league.sport;
    var r = baseReading(pin, 'espn');
    r.state = state;
    r.phase = espnPhase(state, type.name);
    r.startsAt = Date.parse(str(ev.date) || str(comp.date)) || pin.startsAt;
    r.period = num(status.period) || 0;
    r.clock = txt(status.displayClock, 12);
    r.away = espnTeam(away, pin.away);
    r.home = espnTeam(home, pin.home);
    if (state === 'pre') { r.away.score = null; r.home.score = null; }
    r.line = txt(type.shortDetail || type.detail || type.description, 40);
    if (r.phase === 'final') r.line = /OT|SO|\//.test(r.line) ? r.line : 'Final';
    var sit = obj(comp.situation);
    if (sit) {
      var lp = obj(sit.lastPlay);
      if (lp) {
        r.lastPlay = {
          id: str(lp.id), text: txt(lp.text, 120), type: txt(obj(lp.type) ? lp.type.text : '', 40),
          abbr: txt(obj(lp.type) ? lp.type.abbreviation : '', 12), scoreValue: num(lp.scoreValue) || 0,
          teamId: str(obj(lp.team) ? lp.team.id : '')
        };
      }
      if (sport === 'football' && state === 'in') {
        var dd = txt(sit.shortDownDistanceText || sit.downDistanceText, 24);
        var pos = str(sit.possession);
        var side = pos && pos === r.home.id ? 'home' : pos && pos === r.away.id ? 'away' : '';
        r.situation = { possession: side, text: dd, redZone: sit.isRedZone === true };
      } else if (sport === 'baseball' && state === 'in') {
        r.situation = {
          balls: num(sit.balls), strikes: num(sit.strikes), outs: num(sit.outs),
          bases: [sit.onFirst === true, sit.onSecond === true, sit.onThird === true]
        };
      }
    }
    if (sport === 'soccer') {
      r.goals = [];
      r.penalties = [];
      arr(comp.details).forEach(function (d) {
        d = obj(d);
        if (!d) return;
        var teamId = str(obj(d.team) ? d.team.id : '');
        var who = obj(arr(d.athletesInvolved)[0]);
        var name = who ? txt(who.shortName || who.displayName, 30).replace(/^[A-Z]\.\s+/, '') : '';
        var minute = txt(obj(d.clock) ? d.clock.displayValue : '', 10);
        var sideOf = teamId === r.home.id ? 'home' : teamId === r.away.id ? 'away' : '';
        var id = [str(obj(d.type) ? d.type.id : ''), str(obj(d.clock) ? d.clock.value : ''), teamId, who ? str(who.id) : ''].join('/');
        if (d.scoringPlay === true) {
          r.goals.push({ id: id, side: d.ownGoal === true ? (sideOf === 'home' ? 'away' : sideOf === 'away' ? 'home' : '') : sideOf,
            scorer: name, total: null, strength: d.penaltyKick === true ? 'PEN' : d.ownGoal === true ? 'OG' : '', time: minute });
        } else if (d.redCard === true || d.yellowCard === true) {
          r.penalties.push({ id: id, side: sideOf, kind: d.redCard === true ? 'red' : 'yellow', player: name, desc: '', minutes: null, time: minute });
        }
      });
    }
    r.url = pin.url;
    return r;
  } catch (err) {
    return { error: 'the reader hit a bug (' + txt((err && err.message) || err, 80) + ')' };
  }
}

/* --------------------------------------------------------------- NHL */

function sameTeam(a, b) {
  a = str(a).toUpperCase(); b = str(b).toUpperCase();
  if (!a || !b) return false;
  return a === b || (a.length >= 2 && b.length >= 2 && (a.indexOf(b) === 0 || b.indexOf(a) === 0));
}

/** The NHL's day scoreboard -> the game id for this pin's two teams, or ''. */
function matchNhlGame(json, pin) {
  var games = arr(obj(json) && json.games);
  for (var i = 0; i < games.length; i++) {
    var g = obj(games[i]);
    if (!g) continue;
    var a = obj(g.awayTeam), h = obj(g.homeTeam);
    if (a && h && sameTeam(a.abbrev, pin.away.abbr) && sameTeam(h.abbrev, pin.home.abbr) && /^\d{10}$/.test(str(g.id))) return str(g.id);
  }
  return '';
}

var NHL_DESC_FIX = { 'too-many-men-on-the-ice': 'Too many men', 'delaying-game-puck-over-glass': 'Delay of game', 'roughing-removing-opponents-helmet': 'Roughing' };
function prettyDesc(key) {
  var k = str(key).toLowerCase();
  if (NHL_DESC_FIX[k]) return NHL_DESC_FIX[k];
  var s = k.replace(/-/g, ' ').trim();
  return txt(s.charAt(0).toUpperCase() + s.slice(1), 32);
}

/*
 * situationCode is four digits: away goalie, away skaters, home skaters, home goalie
 * ("1451" = the home side up a man). secondsRemaining is the power play's time left.
 */
function nhlStrength(sit, awayAbbr, homeAbbr) {
  var s = obj(sit);
  if (!s) return null;
  var code = str(s.situationCode);
  if (!/^\d{4}$/.test(code)) return null;
  var ag = +code[0], as = +code[1], hs = +code[2], hg = +code[3];
  var left = num(s.secondsRemaining);
  if (as !== hs) {
    var side = as > hs ? 'away' : 'home';
    var up = side === 'away' ? as : hs, down = side === 'away' ? hs : as;
    var abbr = side === 'away' ? awayAbbr : homeAbbr;
    var pulled = (side === 'away' ? ag : hg) === 0;
    if (pulled && up - down === 1 && (side === 'away' ? as : hs) === 6) return { kind: 'en', side: side, text: abbr + ' goalie pulled', secondsLeft: null };
    return { kind: 'pp', side: side, text: abbr + (up - down >= 2 ? ' ' + up + '-on-' + down : ' PP'), secondsLeft: left };
  }
  if (ag === 0 || hg === 0) return { kind: 'en', side: ag === 0 ? 'away' : 'home', text: (ag === 0 ? awayAbbr : homeAbbr) + ' goalie pulled', secondsLeft: null };
  if (as < 5) return { kind: 'even', side: '', text: as + '-on-' + hs, secondsLeft: null };
  return null;
}

function nhlPeriodLabel(pd) {
  var p = obj(pd) || {};
  var n = num(p.number) || 0;
  var t = str(p.periodType).toUpperCase();
  if (t === 'SO') return 'SO';
  if (t === 'OT') return n > 4 ? (n - 3) + 'OT' : 'OT';
  return n ? ordinal(n) : '';
}

/** The NHL's gamecenter landing -> a reading, or { error }. */
function parseNhl(json, pin) {
  try {
    var j = obj(json);
    if (!j || !obj(j.awayTeam) || !obj(j.homeTeam)) return { error: 'its data changed shape (no teams)' };
    var gs = str(j.gameState).toUpperCase();
    var state = gs === 'FUT' || gs === 'PRE' ? 'pre' : gs === 'LIVE' || gs === 'CRIT' ? 'in' : gs === 'FINAL' || gs === 'OFF' ? 'post' : '';
    if (!state) return { error: 'its data changed shape (game state "' + txt(gs, 12) + '")' };
    var sched = str(j.gameScheduleState).toUpperCase();
    var r = baseReading(pin, 'nhl');
    var clock = obj(j.clock) || {};
    r.state = state;
    r.phase = sched === 'PPD' || sched === 'CNCL' ? 'off' : state === 'pre' ? 'pre' : state === 'post' ? 'final' : clock.inIntermission === true ? 'break' : 'live';
    r.startsAt = Date.parse(str(j.startTimeUTC)) || pin.startsAt;
    r.period = num(obj(j.periodDescriptor) && j.periodDescriptor.number) || 0;
    r.clock = txt(clock.timeRemaining, 8);
    var team = function (t, p) { return { id: '', abbr: txt(t.abbrev, 6).toUpperCase() || p.abbr, name: txt(loc(t.commonName), 40) || p.name, logo: p.logo || https(t.logo), score: state === 'pre' ? null : num(t.score) }; };
    r.away = team(j.awayTeam, pin.away);
    r.home = team(j.homeTeam, pin.home);
    var per = nhlPeriodLabel(j.periodDescriptor);
    if (r.phase === 'final') r.line = per === 'OT' || per === 'SO' || /OT$/.test(per) ? 'Final/' + per : 'Final';
    else if (r.phase === 'break') r.line = per === 'SO' ? 'Shootout' : 'End of ' + per;
    else if (r.phase === 'live') r.line = per === 'SO' ? 'Shootout' : per + ' ' + r.clock;
    else if (r.phase === 'off') r.line = sched === 'PPD' ? 'Postponed' : 'Cancelled';
    else r.line = '';
    if (r.phase === 'live') r.strength = nhlStrength(j.situation, r.away.abbr, r.home.abbr);
    var summary = obj(j.summary) || {};
    r.goals = [];
    arr(summary.scoring).forEach(function (p) {
      var pl = obj(p) ? arr(p.goals) : [];
      var plabel = nhlPeriodLabel(obj(p) && p.periodDescriptor);
      pl.forEach(function (g) {
        g = obj(g);
        if (!g) return;
        var abbr = loc(g.teamAbbrev).toUpperCase();
        var side = g.isHome === true ? 'home' : g.isHome === false ? 'away' : sameTeam(abbr, r.home.abbr) ? 'home' : 'away';
        var st = str(g.strength).toLowerCase();
        var mod = str(g.goalModifier).toLowerCase();
        r.goals.push({
          id: str(g.eventId) || (plabel + '/' + str(g.timeInPeriod) + '/' + abbr),
          side: side,
          scorer: txt(loc(g.lastName) || loc(g.name), 30),
          total: num(g.goalsToDate),
          strength: mod === 'empty-net' ? 'EN' : mod === 'penalty-shot' ? 'PS' : st === 'pp' ? 'PP' : st === 'sh' ? 'SH' : '',
          time: plabel + ' ' + str(g.timeInPeriod)
        });
      });
    });
    r.penalties = [];
    arr(summary.penalties).forEach(function (p) {
      var pl = obj(p) ? arr(p.penalties) : [];
      var plabel = nhlPeriodLabel(obj(p) && p.periodDescriptor);
      pl.forEach(function (x) {
        x = obj(x);
        if (!x) return;
        var abbr = loc(x.teamAbbrev).toUpperCase();
        var who = obj(x.committedByPlayer);
        var player = who ? txt(loc(who.lastName), 30) : txt(loc(x.servedBy), 30);
        r.penalties.push({
          id: [plabel, str(x.timeInPeriod), abbr, str(x.descKey), player].join('/'),
          side: sameTeam(abbr, r.home.abbr) ? 'home' : 'away',
          kind: str(x.type).toUpperCase() === 'BEN' ? 'bench' : str(x.type).toLowerCase() || 'min',
          player: player,
          desc: prettyDesc(x.descKey),
          minutes: num(x.duration),
          time: plabel + ' ' + str(x.timeInPeriod)
        });
      });
    });
    r.url = pin.url;
    return r;
  } catch (err) {
    return { error: 'the reader hit a bug (' + txt((err && err.message) || err, 80) + ')' };
  }
}

function baseReading(pin, source) {
  return {
    key: pin.key, league: pin.league, leagueName: leagueOf(pin.league).name, sport: leagueOf(pin.league).sport,
    source: source, state: 'pre', phase: 'pre', startsAt: pin.startsAt, period: 0, clock: '', line: '',
    away: null, home: null, strength: null, goals: null, penalties: null, lastPlay: null, situation: null, url: pin.url
  };
}

/* --------------------------------------------------------------- the diff */

function abbrOf(r, side) { return r[side] ? r[side].abbr : ''; }
function mmss(minutes) { return minutes === null || minutes === undefined ? '' : Math.floor(minutes) + ':00'; }

/* What a score of `delta` points is called, per sport. */
function scoreWord(sport, delta, lastPlay) {
  var t = lastPlay ? (lastPlay.type + ' ' + lastPlay.abbr).toLowerCase() : '';
  if (sport === 'hockey' || sport === 'soccer') return delta > 1 ? delta + ' GOALS' : 'GOAL';
  if (sport === 'baseball') return delta > 1 ? delta + ' RUNS' : 'RUN';
  if (sport === 'basketball') return '+' + delta;
  if (sport === 'football') {
    if (/touchdown|\btd\b/.test(t) || delta >= 6) return 'TOUCHDOWN';
    if (/field goal|\bfg\b/.test(t) || delta === 3) return 'FIELD GOAL';
    if (/safety/.test(t)) return 'SAFETY';
    if (delta === 2) return '2-PT';
    if (delta === 1) return 'EXTRA POINT';
  }
  return 'SCORE';
}

/** The newest of `list` for `side` that `prevList` did not have (by id), or null. */
function newestFor(list, prevList, side) {
  if (!Array.isArray(list)) return null;
  var seen = {};
  if (Array.isArray(prevList)) prevList.forEach(function (g) { seen[g.id] = true; });
  for (var i = list.length - 1; i >= 0; i--) if (list[i].side === side && !seen[list[i].id]) return list[i];
  return null;
}

function goalStrip(word, abbr, g) {
  var parts = [word, abbr];
  if (g && g.scorer) parts.push(g.scorer + (g.total ? ' (' + g.total + ')' : ''));
  if (g && g.strength) parts.push(g.strength);
  else if (g && g.time && /'/.test(g.time)) parts.push(g.time);   // a soccer minute
  return parts.join(' · ');
}

/**
 * Two readings of one game -> the events a card plays, oldest first.
 * opts: { quiet: true } after a long gap (see QUIET_GAP_MS): nothing makes a sound.
 * Each event: { kind, side, strip, sound: 'horn'|'tone'|'', quiet, delta }.
 */
function diff(prev, next, opts) {
  var out = [];
  if (!prev || !next || prev.error || next.error || prev.key !== next.key) return out;
  var quiet = !!(opts && opts.quiet);
  var sport = next.sport;
  ['away', 'home'].forEach(function (side) {
    var a = prev[side] ? prev[side].score : null;
    var b = next[side] ? next[side].score : null;
    if (a === null || b === null || a === b) return;
    var abbr = abbrOf(next, side);
    if (b > a) {
      var delta = b - a;
      var word = scoreWord(sport, delta, next.lastPlay);
      var ev = { kind: 'score', side: side, delta: delta, word: word, strip: '', sound: 'horn', quiet: quiet };
      if (sport === 'basketball') {
        // A basket every 20 s: the number rolls and the side washes, no strip and no horn.
        ev.sound = '';
        ev.minor = true;
      } else if (sport === 'hockey' || sport === 'soccer') {
        var g = newestFor(next.goals, prev.source === next.source ? prev.goals : null, side);
        if (!g && Array.isArray(next.goals)) g = newestFor(next.goals, null, side);   // a source switch: the side's latest
        ev.strip = goalStrip(g && g.strength === 'OG' ? 'OWN GOAL' : word, abbr, g && g.strength === 'OG' ? Object.assign({}, g, { strength: '' }) : g);
      } else {
        var lp = next.lastPlay;
        var tail = lp && lp.scoreValue > 0 && lp.text ? txt(lp.text.replace(/\s*\(.*?\)\s*$/, ''), 44) : '';
        ev.strip = [word, abbr].concat(tail ? [tail] : []).join(' · ');
      }
      out.push(ev);
    } else {
      out.push({
        kind: 'overturned', side: side, delta: b - a, sound: '', quiet: quiet,
        strip: (sport === 'hockey' || sport === 'soccer' ? 'GOAL OVERTURNED' : 'SCORE CHANGED') + ' · ' + abbr + ' · ' + abbrOf(next, 'away') + ' ' + next.away.score + '–' + next.home.score + ' ' + abbrOf(next, 'home')
      });
    }
  });
  // Penalties and cards: only from the same source's list (never from one appearing).
  if (prev.source === next.source && Array.isArray(prev.penalties) && Array.isArray(next.penalties)) {
    var seen = {};
    prev.penalties.forEach(function (p) { seen[p.id] = true; });
    next.penalties.forEach(function (p) {
      if (seen[p.id]) return;
      var abbr = abbrOf(next, p.side);
      if (p.kind === 'red' || p.kind === 'yellow') {
        out.push({ kind: 'card', card: p.kind, side: p.side, sound: 'tone', quiet: quiet,
          strip: [p.kind === 'red' ? 'RED CARD' : 'YELLOW CARD', abbr].concat(p.player ? [p.player + (p.time ? ' ' + p.time : '')] : []).join(' · ') });
      } else {
        out.push({ kind: 'penalty', side: p.side, sound: 'tone', quiet: quiet, minutes: p.minutes,
          strip: ['PENALTY', abbr, p.desc].concat(p.minutes ? [mmss(p.minutes)] : []).join(' · ') });
      }
    });
  }
  var wasPP = prev.strength && prev.strength.kind === 'pp';
  var isPP = next.strength && next.strength.kind === 'pp';
  if (wasPP && (!isPP || next.strength.side !== prev.strength.side) && prev.source === next.source) {
    out.push({ kind: 'pp-end', side: prev.strength.side, sound: '', quiet: quiet, strip: '' });
  }
  if (prev.state !== 'post' && next.state === 'post' && next.phase === 'final') {
    out.push({ kind: 'final', side: '', sound: '', quiet: quiet,
      strip: (next.line || 'Final').toUpperCase() + ' · ' + abbrOf(next, 'away') + ' ' + next.away.score + '–' + next.home.score + ' ' + abbrOf(next, 'home') });
  }
  return out;
}

/* --------------------------------------------------------------- cadence */

/**
 * How long until the next poll, in ms, or null to stop (the game is over).
 * reading: the last good reading (or null before the first); failures: how many in a row.
 */
function nextPollMs(reading, now, failures) {
  if (failures > 0) return POLL.backoff[Math.min(failures, POLL.backoff.length) - 1];
  if (!reading) return POLL.hot;
  if (reading.phase === 'final' || reading.phase === 'off') return null;
  if (reading.phase === 'pre') {
    var until = (reading.startsAt || 0) - now;
    if (until <= 0) return POLL.preLate;                 // past the start time, not under way yet
    return Math.max(5000, Math.min(POLL.preMax, until));  // at most every 5 min; wake at the start
  }
  if (reading.phase === 'break') return POLL.brk;
  if (reading.strength && reading.strength.kind === 'pp') return POLL.hot;
  return POLL.live;
}

/* The card's words for a failed read. */
function pausedLine(feedName, reason, retryMs) {
  return 'Scores paused: ' + feedName + " didn't answer" + (reason ? ' (' + reason + ')' : '') + ', retrying in ' + Math.round(retryMs / 1000) + ' s';
}

module.exports = {
  LEAGUES: LEAGUES,
  POLL: POLL,
  QUIET_GAP_MS: QUIET_GAP_MS,
  leagueOf: leagueOf,
  cleanPin: cleanPin,
  espnEventUrl: espnEventUrl,
  nhlScoreUrl: nhlScoreUrl,
  nhlLandingUrl: nhlLandingUrl,
  gamecastUrl: gamecastUrl,
  nhlDay: nhlDay,
  parseEspn: parseEspn,
  parseNhl: parseNhl,
  matchNhlGame: matchNhlGame,
  nhlStrength: nhlStrength,
  diff: diff,
  nextPollMs: nextPollMs,
  pausedLine: pausedLine,
  _internals: { sameTeam: sameTeam, prettyDesc: prettyDesc, scoreWord: scoreWord, espnPhase: espnPhase }
};
