// tests/sports-test.js -- Lumen's sports pages, the pure half (watch/sports.js) and sports-main.js driven
// by a fake fetch: hand-made ESPN-shaped fixtures only (tests/sports-fixtures/, plus the score pins' NHL
// fixtures). No Electron, no network: a real call to ESPN or the NHL fails the run.
//
//   node tests/sports-test.js
//
// Covers: the NHL game summary live / final / OT / shootout / pre-game / postponed and bad bodies; goals by
// period with PP / SH tags, penalties, goalies (a dressed backup dropped), team stats; NFL scoring plays,
// MLB line score, NBA (no scoring summary), college hockey; three stars from the NHL landing; teams;
// standings with the NHL wild card (tie-breaks); a team's schedule, results, postponed, live overlay,
// off-season; "Watch this game" for ESPN+, ESPN, Hulu, Prime, TNT, regional and nothing; big games; the
// open page's poll cadence; and sports-main: lines only from Lumen, favourites saved, the game answer, a
// score pin's click waiting for a Lumen page. One line: "sports-test: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../watch/sports');
const SportsMain = require('../sports-main');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 500)));
}
const FIX = path.join(__dirname, 'sports-fixtures');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n + '.json'), 'utf8'));
const sfx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'scores-fixtures', n + '.json'), 'utf8'));
const clone = (j) => JSON.parse(JSON.stringify(j));
const NOW = Date.parse('2026-10-17T20:00:00Z');
/** The schedule fixture's '@-4d' / '@0' dates -> ISO times relative to `now` (22:00 Z that day). */
function dated(j, now) {
  const s = JSON.stringify(j).replace(/"@([+-]?\d+)?d?"/g, (m, n) => {
    const day = new Date(now + (Number(n) || 0) * 86400e3);
    day.setUTCHours(22, 0, 0, 0);
    return JSON.stringify(day.toISOString().replace(':00.000Z', 'Z'));
  });
  return JSON.parse(s);
}
function finalOf(j, detail, extra) {
  const f = clone(j);
  const c = f.header.competitions[0];
  c.status = { period: 3, displayClock: '0:00', type: { name: 'STATUS_FINAL', state: 'post', completed: true, detail: detail || 'Final', shortDetail: detail || 'Final' } };
  c.competitors[0].linescores.push({ displayValue: '1' });
  c.competitors[1].linescores.push({ displayValue: '0' });
  c.competitors[0].score = '4'; c.competitors[0].winner = true;
  (extra || []).forEach((e) => { c.competitors[0].linescores.push({ displayValue: e[0] }); c.competitors[1].linescores.push({ displayValue: e[1] }); });
  return f;
}

/* ---- the NHL game ----------------------------------------------------------------------------- */
const live = S.parseSummary(fx('nhl-summary-live'), 'nhl');
const g = live.game;
check(!live.error && g.state === 'in' && g.status === 'live' && g.line === '1:48 - 2nd' && g.period === 2, 'NHL live: state, status and the period/clock line', live.error || [g.state, g.status, g.line]);
check(g.away.abbr === 'SEA' && g.home.abbr === 'FLA' && g.away.score === '2' && g.home.score === '3' && g.home.record === '5-1-1', 'NHL live: both teams, scores and records', [g.away, g.home]);
check(JSON.stringify(g.periods) === '["1st","2nd"]' && g.away.linescores.join() === '1,1' && g.home.linescores.join() === '2,1', 'NHL live: period scores', [g.periods, g.away.linescores, g.home.linescores]);
check(g.scoring.length === 2 && g.scoring[0].label === '1st period' && g.scoring[0].plays.length === 3 && g.scoring[1].plays.length === 2, 'NHL: the scoring summary grouped by period', g.scoring.map((x) => [x.label, x.plays.length]));
const g1 = g.scoring[0].plays;
check(g1[0].side === 'home' && g1[0].abbr === 'FLA' && g1[0].clock === '18:55' && /Sam Bennett \(1\)/.test(g1[0].text) && g1[0].score === '0–1' && g1[0].tag === '', 'NHL: a goal has its team, clock, scorer text and the score after it', g1[0]);
check(g1[1].tag === 'PP' && g1[1].side === 'away' && g.scoring[1].plays[1].tag === 'SH', 'NHL: power-play and short-handed goals are tagged', [g1[1].tag, g.scoring[1].plays[1].tag]);
check(g.penalties.length === 2 && g.penalties[0].plays.length === 1 && g.penalties[1].plays.length === 2 && g.penalties[0].plays[0].minutes === 2 && g.penalties[0].plays[0].abbr === 'FLA', 'NHL: penalties by period, with minutes and team', g.penalties);
check(g.goalies.length === 2 && g.goalies[0].name === 'Joey Daccord' && g.goalies[0].saves === '24' && g.goalies[0].shots === '27' && g.goalies[0].svPct === '.889' && g.goalies[1].abbr === 'FLA', 'NHL: goalies with saves, shots against, SV% (the backup who never played is dropped)', g.goalies);
const shots = g.teamStats.find((x) => x.label === 'Shots'), pp = g.teamStats.find((x) => x.label === 'Power play');
check(shots && shots.away === '21' && shots.home === '27' && pp && pp.away === '1/2' && pp.home === '0/2' && g.teamStats[0].label === 'Shots', 'NHL: team stats, shots first, power play as goals/chances', g.teamStats);
check(g.venue === 'Amerant Bank Arena' && g.broadcasts.indexOf('ESPN+') !== -1 && g.broadcasts.indexOf('SCRIPPS') !== -1 && g.gamecastUrl === 'https://www.espn.com/nhl/game/_/gameId/401892522', 'NHL: venue, broadcasts, gamecast', [g.venue, g.broadcasts, g.gamecastUrl]);

const fin = S.parseSummary(finalOf(fx('nhl-summary-live'), 'Final'), 'nhl').game;
check(fin.state === 'post' && fin.status === 'final' && fin.periods.join() === '1st,2nd,3rd' && fin.home.winner === true, 'NHL final: three periods, the winner marked', [fin.status, fin.periods]);
const ot = S.parseSummary(finalOf(fx('nhl-summary-live'), 'Final/OT', [['1', '0']]), 'nhl').game;
check(ot.periods.join() === '1st,2nd,3rd,OT', 'NHL final in overtime: an OT column', ot.periods);
const so = S.parseSummary(finalOf(fx('nhl-summary-live'), 'Final/SO', [['0', '0'], ['1', '0']]), 'nhl').game;
check(so.periods.join() === '1st,2nd,3rd,OT,SO', 'NHL final in a shootout: OT then SO', so.periods);
const preJ = clone(fx('nhl-summary-live'));
preJ.header.competitions[0].status = { type: { name: 'STATUS_SCHEDULED', state: 'pre', detail: 'Sat, October 17th at 6:00 PM EDT', shortDetail: '10/17 - 6:00 PM EDT' } };
preJ.header.competitions[0].competitors.forEach((c) => { c.linescores = []; });
preJ.plays = [];
const pre = S.parseSummary(preJ, 'nhl').game;
check(pre.state === 'pre' && pre.status === 'scheduled' && pre.home.score === '' && pre.periods.length === 0 && pre.scoring.length === 0 && pre.startsAt === Date.parse('2026-10-17T22:00Z'), 'NHL pre-game: no score, no periods, its start time', pre);
const ppJ = clone(preJ);
ppJ.header.competitions[0].status = { type: { name: 'STATUS_POSTPONED', state: 'post', detail: 'Postponed', shortDetail: 'Postponed' } };
const ppd = S.parseSummary(ppJ, 'nhl').game;
check(ppd.status === 'postponed' && ppd.line === 'Postponed', 'a postponed game says so', [ppd.status, ppd.line]);
check(S.parseSummary(null, 'nhl').error && /no header/.test(S.parseSummary({}, 'nhl').error) && /no teams/.test(S.parseSummary({ header: { competitions: [{ status: { type: { state: 'in' } }, competitors: [] }] } }, 'nhl').error) && /league/.test(S.parseSummary({}, 'xyz').error), 'bad bodies give words, never a throw');
const ch = S.parseSummary(fx('nhl-summary-live'), 'chky').game;
check(ch && ch.leagueName === 'College hockey' && ch.sport === 'hockey' && ch.goalies.length === 2 && /mens-college-hockey\/game/.test(ch.gamecastUrl), 'college hockey: the same summary shape reads');

/* ---- other sports ----------------------------------------------------------------------------- */
const nfl = S.parseSummary(fx('nfl-summary'), 'nfl').game;
check(nfl.periods.join() === 'Q1,Q2,Q3,Q4' && nfl.scoring.length === 2 && nfl.scoring[0].label === 'Quarter 1' && nfl.scoring[0].plays.length === 2 && nfl.scoring[0].plays[0].kind === 'Touchdown' && nfl.penalties === null && nfl.goalies === null, 'NFL: quarters, scoring plays by quarter with their kind', nfl.scoring);
check(nfl.teamStats[0].label === 'Total yards' && nfl.teamStats[0].home === '402' && nfl.broadcasts[0] === 'Prime Video', 'NFL: team stats and the Prime broadcast', [nfl.teamStats, nfl.broadcasts]);
const mlbJ = { header: { id: '401800001', competitions: [{ id: '401800001', date: '2026-10-16T23:00Z', status: { type: { state: 'post', name: 'STATUS_FINAL', detail: 'Final' } },
  competitors: [{ homeAway: 'home', score: '5', hits: 9, errors: 0, team: { id: '10', abbreviation: 'NYY', displayName: 'New York Yankees' }, linescores: [0, 1, 0, 2, 0, 0, 2, 0].map((v) => ({ displayValue: String(v) })) },
    { homeAway: 'away', score: '3', hits: 7, errors: 1, team: { id: '2', abbreviation: 'BOS', displayName: 'Boston Red Sox' }, linescores: [1, 0, 0, 0, 2, 0, 0, 0, 0].map((v) => ({ displayValue: String(v) })) }] }] },
  plays: [{ scoringPlay: true, text: 'Judge homered to left (402 feet)', period: { number: 2 }, team: { id: '10' }, awayScore: 1, homeScore: 1 }] };
const mlb = S.parseSummary(mlbJ, 'mlb').game;
check(mlb.periods.length === 9 && mlb.periods[8] === '9' && mlb.home.hits === '9' && mlb.away.errors === '1' && mlb.scoring[0].label === 'Inning 2', 'MLB: nine innings, hits and errors, runs by inning', [mlb.periods, mlb.home.hits]);
const nbaJ = clone(mlbJ);
nbaJ.plays = [{ scoringPlay: true, text: 'a layup', period: { number: 1 }, team: { id: '10' } }];
const nba = S.parseSummary(nbaJ, 'nba').game;
check(nba.scoring === null && nba.periods[3] === 'Q4' && nba.periods[4] === 'OT', 'NBA: no basket-by-basket summary; quarters then OT', [nba.scoring, nba.periods]);

/* ---- three stars (the NHL landing, found the way the pins find it) ----------------------------- */
const landing = sfx('nhle-landing');
landing.summary.threeStars = [
  { star: 2, playerId: 1, teamAbbrev: 'FLA', name: { default: 'S. Bennett' }, position: 'C', goals: 1, assists: 1, points: 2 },
  { star: 1, playerId: 2, teamAbbrev: { default: 'FLA' }, name: { default: 'M. Tkachuk' }, position: 'L', goals: 2, assists: 0, points: 2 },
  { star: 3, playerId: 3, teamAbbrev: 'SEA', name: { default: 'J. Daccord' }, position: 'G', goalsAgainstAverage: 4, savePctg: 0.889 }];
const stars = S.parseNhlStars(landing);
check(stars.length === 3 && stars[0].name === 'M. Tkachuk' && stars[0].line === '2 goals' && stars[1].line === '1 goal, 1 assist' && stars[2].line === '.889 SV%' && stars[0].abbr === 'FLA', 'three stars: in order, skaters by goals/assists, a goalie by SV%', stars);
check(S.parseNhlStars({}).length === 0 && S.parseNhlStars(sfx('nhle-landing')).length === 0, 'no three stars yet: an empty list');

/* ---- teams and standings ---------------------------------------------------------------------- */
const teams = S.parseTeams(fx('nhl-teams'), 'nhl');
check(teams.teams.length === 20 && teams.teams[0].name === 'Boston Bruins' && teams.teams.every((t) => t.id && t.abbr && t.logo && t.league === 'nhl'), 'teams: the picker list, sorted by name', teams.teams && teams.teams.slice(0, 2));
check(/no teams/.test(S.parseTeams({ sports: [] }, 'nhl').error), 'teams: a changed shape says so');
const st = S.parseStandings(fx('nhl-standings'), 'nhl');
check(st.groups.length === 4 && st.groups[0].name === 'Atlantic Division' && st.groups[0].parent === 'Eastern Conference' && st.cols.join() === 'GP,W,L,OTL,PTS,RW,DIFF,STRK', 'standings: four divisions under their conferences, hockey columns', [st.groups.map((x) => x.name), st.cols]);
check(st.groups[0].rows[0].abbr === 'FLA' && st.groups[0].rows[0].cells[4] === '11', 'standings: a row carries the team and its points', st.groups[0].rows[0]);
const east = st.wildcard && st.wildcard[0];
check(east && east.conference === 'Eastern Conference' && east.divisions.map((d) => d.rows.map((r) => r.abbr).join()).join('|') === 'FLA,TOR,TBL|CAR,NJ,WSH', 'wild card: the top three of each division', east && east.divisions.map((d) => d.rows.map((r) => r.abbr)));
check(east && east.race.map((r) => r.abbr).join() === 'NYR,BOS,MTL,PIT' && east.cut === 2, 'wild card: the race by points, then fewer games played (NYR 7 in 6 ahead of BOS 7 in 7)', east && east.race.map((r) => [r.abbr, r.pts, r.gp]));
check(S.parseStandings({ children: [] }, 'nhl').empty === true && /no table/.test(S.parseStandings({ foo: 1 }, 'nhl').error), 'standings: an empty season vs a changed shape');
const nbaSt = S.parseStandings({ children: [{ name: 'Eastern Conference', standings: { entries: [{ team: { id: '1', abbreviation: 'BOS', displayName: 'Boston Celtics' }, stats: [{ name: 'wins', displayValue: '3' }, { name: 'losses', displayValue: '1' }, { name: 'winPercent', displayValue: '.750' }] }] } }] }, 'nba');
check(nbaSt.cols.join() === 'W,L,PCT' && nbaSt.wildcard === null, 'standings: empty columns dropped; no wild card outside the NHL', nbaSt.cols);

/* ---- a team's schedule and its My teams card --------------------------------------------------- */
const sch = S.parseSchedule(dated(fx('nhl-schedule-fla'), NOW), 'nhl', '26');
check(sch.events.length === 7 && sch.team.record === '5-1-1' && sch.team.standing === '1st in Atlantic Division', 'schedule: every game, the record and standing', [sch.events.length, sch.team]);
check(sch.events[0].result === 'W 4–2' && sch.events[1].result === 'L 2–3 OT' && sch.events[2].status === 'postponed' && sch.events[2].result === '' && sch.events[1].isHome === false && sch.events[1].opponent.abbr === 'TOR', 'schedule: results from his side, OT marked, a postponed game has no result', sch.events.slice(0, 3).map((e) => [e.result, e.status]));
const fav = { league: 'nhl', id: '26', abbr: 'FLA', name: 'Florida Panthers', logo: '' };
const card = S.teamCard(fav, sch, [], NOW);
check(!card.live && card.next && card.next.id === 'espn:401892522' && card.last && card.last.id === 'espn:401892510' && card.postponed && card.postponed.id === 'espn:401892515' && !card.offseason, 'My teams card: next game, last result, the postponed one', [card.next && card.next.id, card.last && card.last.id]);
const liveEv = { id: 'espn:401892522', league: 'nhl', state: 'in', detail: '1:48 - 2nd', home: { abbr: 'FLA', score: '3' }, away: { abbr: 'SEA', score: '2' }, url: 'https://www.espn.com/watch/player?id=abc-123' };
const card2 = S.teamCard(fav, sch, [liveEv], NOW);
check(card2.live && card2.live.home.score === '3' && card2.live.detail === '1:48 - 2nd' && card2.live.watchUrl === liveEv.url && card2.next.id === 'espn:401892540', "My teams card: Lumen's live scoreboard wins over the schedule", card2.live);
const old = S.parseSchedule(dated(fx('nhl-schedule-fla'), NOW), 'nhl', '26');
old.events = old.events.filter((e) => e.state === 'post');
check(S.teamCard(fav, old, [], NOW + 60 * 86400e3).offseason === true, 'My teams card: nothing ahead and nothing in three weeks is the off-season');
check(/no events/.test(S.parseSchedule({ team: {} }, 'nhl', '26').error), 'schedule: a changed shape says so');

/* ---- Watch this game -------------------------------------------------------------------------- */
const w1 = S.watchOptions({ league: 'nhl', broadcasts: ['ESPN+', 'SCRIPPS'], url: '', state: 'in' });
check(w1.options.length === 1 && w1.options[0].service === 'espn' && w1.options[0].url === 'https://www.espn.com/watch/' && w1.airsOn[0].name === 'SCRIPPS' && w1.airsOn[0].regional && /Out-of-market NHL games stream on ESPN\+/.test(w1.words), 'ESPN+: opens ESPN in Lumen; the regional channel and the blackout rule said', w1);
const w2 = S.watchOptions({ league: 'nhl', broadcasts: ['ESPN+'], url: 'https://www.espn.com/watch/player?id=abc-123', state: 'in' });
check(w2.options[0].url === 'https://www.espn.com/watch/player?id=abc-123' && w2.options[0].note === 'Plays in Lumen', "ESPN+ with ESPN's own airing: straight to its player", w2.options[0]);
const w3 = S.watchOptions({ league: 'nhl', broadcasts: ['TNT'], state: 'pre' });
check(w3.options.length === 1 && w3.options[0].maybe === true && w3.words === 'Not on your services. Airs on TNT (streams on HBO Max). Hulu + Live TV carries it, if your plan includes Live TV.', 'TNT: not on his services, where it streams, and Hulu + Live TV only as an "if"', w3);
const w3b = S.watchOptions({ league: 'nhl', broadcasts: ['NHL Net', 'SN'], state: 'pre' });
check(w3b.options.length === 0 && w3b.words === 'Not on your services. Airs on NHL Net, SN (regional TV).', 'NHL Network and a regional channel: named, nothing to open', w3b.words);
const w4 = S.watchOptions({ league: 'nhl', broadcasts: ['ESPN', 'Hulu'], state: 'pre' });
check(w4.options.map((o) => o.service).join() === 'espn,disney,hulu,hulu' && w4.options[1].url === 'https://www.disneyplus.com/browse/espn' && /Live TV/.test(w4.options[3].note), 'ESPN + Hulu: ESPN, the Disney+ ESPN tile, Hulu, Hulu + Live TV (said as "only if")', w4.options.map((o) => o.label));
const w5 = S.watchOptions({ league: 'nfl', broadcasts: ['Prime Video'], state: 'in' });
check(w5.options[0].service === 'prime' && /primevideo\.com/.test(w5.options[0].url), 'Prime Video (TNF): Prime in Lumen', w5.options);
const w6 = S.watchOptions({ league: 'nhl', broadcasts: [], state: 'pre' });
check(w6.options.length === 0 && /no broadcast/.test(w6.words), 'no broadcast listed: said plainly', w6.words);
check(S.isBigGame({ broadcasts: ['TNT'] }) && !S.isBigGame({ broadcasts: ['ESPN+', 'SCRIPPS'] }) && S.isBigGame({ broadcasts: [], postseason: true }), 'big games: national TV or the postseason');

/* ---- the open page's cadence, URLs ------------------------------------------------------------- */
check(S.nextPollMs(g, NOW, 0) === 20000 && S.nextPollMs(Object.assign({}, g, { status: 'break' }), NOW, 0) === 60000 && S.nextPollMs(fin, NOW, 0) === null && S.nextPollMs(ppd, NOW, 0) === null, 'poll: live 20 s, intermission 60 s, final and postponed never');
check(S.nextPollMs(pre, Date.parse('2026-10-17T21:50Z'), 0) === 60000 && S.nextPollMs(pre, Date.parse('2026-10-17T12:00Z'), 0) === 300000 && S.nextPollMs(g, NOW, 2) === 60000, 'poll: pre-game 1 min near the start, 5 min before; failures back off');
check(S.summaryUrl('nhl', 'espn:401892522') === 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/summary?event=401892522' && S.summaryUrl('nhl', '1;x') === '' && /apis\/v2\/sports\/hockey\/nhl\/standings\?level=3$/.test(S.standingsUrl('nhl')) && S.scheduleUrl('nhl', '../x') === '', 'URLs: only clean ids, standings on /apis/v2 with divisions');
check(JSON.stringify(S.gameFromUrl('https://www.espn.com/nhl/game/_/gameId/401892522')) === '{"league":"nhl","id":"401892522"}' && S.gameFromUrl('https://www.espn.com/mens-college-hockey/game/_/gameId/401700001/x').league === 'chky' && S.gameFromUrl('https://evil.com/nhl/game/_/gameId/1') === null, 'a score pin gamecast -> its league and game');

/* ---- sports-main, with a fake fetch ------------------------------------------------------------ */
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sports-test-'));
  const hits = [];
  const bodies = {
    '/hockey/nhl/summary?event=401892522': () => finalOf(fx('nhl-summary-live'), 'Final'),
    '/hockey/nhl/teams/26/schedule': () => dated(fx('nhl-schedule-fla'), Date.now()),
    'score/2026-10-17': () => sfx('nhle-score'),
    'gamecenter/2026020124/landing': () => landing,
  };
  let landingDown = false;
  const fakeFetch = async (url) => {
    hits.push(url);
    if (!/^http:\/\/mock\//.test(url)) throw new Error('a real network call: ' + url);
    if (landingDown && /landing/.test(url)) return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' };
    const k = Object.keys(bodies).find((x) => url.indexOf(x) !== -1);
    if (!k) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(bodies[k]()) };
  };
  const LUMEN = require('url').pathToFileURL(path.join(__dirname, '..', 'watch.html')).href;
  const pushed = [];
  const page = (url) => ({ getURL: () => url, isDestroyed: () => false, executeJavaScript: (code) => { pushed.push(code); return Promise.resolve(); }, on: () => {} });
  const lumen = page(LUMEN + '?theme=dark'), other = page('https://example.com/');
  const mk = () => SportsMain.create({ test: { fetch: fakeFetch, userData: tmp, rebase: [['https://site.api.espn.com/apis/site/v2/sports', 'http://mock/espn'], ['https://api-web.nhle.com/v1/', 'http://mock/nhle/']] }, log: () => {} });
  const m = mk();
  const last = (kind) => { for (let i = pushed.length - 1; i >= 0; i--) { const mm = /__applySports\((.*)\)$/.exec(pushed[i]); if (mm) { const j = JSON.parse(mm[1]); if (j.kind === kind) return j; } } return null; };
  const settle = () => new Promise((r) => setTimeout(r, 30));

  check(m.handleLine(other, 'quartz-sports:hello {}') === false && m.handleLine(lumen, 'quartz-sports:rm {}') === false && m.handleLine(lumen, 'quartz-sports:game {bad') === false, 'main: only Lumen pages, known verbs and JSON are heard');
  m.handleLine(lumen, 'quartz-sports:hello {}');
  await settle();
  check(last('favs') && last('favs').favs.length === 0 && hits.length === 0, 'main: hello answers the favourites; no favourites, no read');
  m.handleLine(lumen, 'quartz-sports:game {"league":"nhl","id":"401892522"}');
  await settle(); await settle();
  const gm = last('game');
  check(gm && gm.game && gm.game.status === 'final' && gm.game.stars && gm.game.stars[0].name === 'M. Tkachuk' && gm.game.watch && Array.isArray(gm.game.watch.options), 'main: a final NHL game comes back with its three stars (NHL landing, matched like the pins) and its watch options', gm && gm.game && [gm.game.status, gm.game.stars]);
  check(hits.some((h) => /nhle\/score\/2026-10-17$/.test(h)) && hits.some((h) => /gamecenter\/2026020124\/landing/.test(h)) && hits.every((h) => /^http:\/\/mock\//.test(h)), 'main: every read went to the rebased mock', hits);
  landingDown = true;
  const m2 = mk();
  const g2 = await m2._readGame('nhl', '401892522');
  check(g2.game && g2.game.stars === null && /NHL's own feed didn't answer/.test(g2.game.starsError), 'main: the NHL feed down -> no stars, and the reason', g2.game && g2.game.starsError);
  const bad = await m2._readGame('nhl', '999');
  check(/HTTP 404/.test(bad.error), 'main: a missing game says HTTP 404', bad);

  m.handleLine(lumen, 'quartz-sports:fav {"league":"nhl","team":{"id":"26","abbr":"FLA","name":"Florida Panthers","logo":"https://a.espncdn.com/i/teamlogos/nhl/500/fla.png"},"on":true}');
  await settle(); await settle();
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, SportsMain.PREFS_FILE), 'utf8'));
  const my = last('myteams');
  check(saved.favs.length === 1 && saved.favs[0].abbr === 'FLA' && last('favs').favs.length === 1, 'main: a favourite is saved locally and pushed', saved);
  check(my && my.teams.length === 1 && my.teams[0].next && my.teams[0].last && my.teams[0].record === '5-1-1', 'main: My teams follows from the schedule', my && my.teams[0]);
  m.handleLine(lumen, 'quartz-sports:fav {"league":"nhl","team":{"id":"27","abbr":"X","name":"Bad","logo":"https://evil.example/x.png"},"on":true}');
  await settle();
  check(SportsMain.cleanTeam({ id: '27', abbr: 'X', name: 'Bad', logo: 'https://evil.example/x.png' }, 'nhl').logo === '' && SportsMain.cleanTeam({ id: 'x', abbr: 'X', name: 'Bad' }, 'nhl') === null, 'main: a favourite is checked (clean id, ESPN logo hosts only)');
  check(mk().favourites().length === 2, 'main: favourites come back after a restart');
  m.handleLine(lumen, 'quartz-sports:fav {"league":"nhl","team":{"id":"27","abbr":"X","name":"Bad"},"on":false}');
  await settle();
  check(mk().favourites().length === 1, 'main: removing a favourite saves too');

  // a score pin's click with no Lumen page: waits, then the next hello opens it
  const m3 = mk();
  let shown = 0;
  const m4 = SportsMain.create({ test: { fetch: fakeFetch, userData: tmp }, log: () => {}, showLumen: () => { shown++; } });
  const r = m4.openGame('https://www.espn.com/nhl/game/_/gameId/401892522');
  check(r.ok && r.how === 'lumen-new' && shown === 1 && m3.openGame('https://evil.com/').ok === false, 'main: a pin click asks the chrome for Lumen; a bad URL is refused', r);
  pushed.length = 0;
  m4.handleLine(lumen, 'quartz-sports:hello {}');
  await settle();
  const op = last('open');
  check(op && op.league === 'nhl' && op.id === '401892522', "main: Lumen's hello collects the waiting game page", op);
  const r2 = m4.openGame('https://www.espn.com/nhl/game/_/gameId/401892522');
  check(r2.how === 'lumen' && last('open'), 'main: with Lumen open, the game page opens there at once', r2);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log('sports-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.log('FAIL sports-test crashed: ' + (err && err.stack)); console.log('sports-test: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
