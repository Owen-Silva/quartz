// tests/scores-test.js -- Lumen's pinned scores, the pure half (watch/scores.js): parsing each feed and
// the event diff, from fixtures only (tests/scores-fixtures/, trimmed from ONE read-only probe of the
// public feeds on 2026-10-17). No Electron, no network.
//
//   node tests/scores-test.js
//
// Covers: ESPN (hockey, college football, soccer, baseball, basketball) and the NHL landing parsed into
// one shape; the ESPN -> NHL game match; a goal (with scorer, season total and strength); a penalty
// and the power play it starts; the power play running out; a disallowed / corrected goal; a card
// that just opened (history never replayed); a feed outage (an unreadable body, the back-off, the
// card's words); the move to Final (and polling stopping); a quiet catch-up after a long gap; a
// source switch that must not fake a goal; touchdown / field goal / run / basket labels; soccer
// goals and cards; the poll cadence; and the pin request's checks. One line: "scores-test: N passed, M failed".
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('../watch/scores');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 400)));
}
const FIX = path.join(__dirname, 'scores-fixtures');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n + '.json'), 'utf8'));
const clone = (j) => JSON.parse(JSON.stringify(j));

const NHL_PIN = S.cleanPin({
  id: 'espn:401892522', league: 'nhl', startsAt: Date.parse('2026-10-17T23:00Z'),
  away: { abbr: 'SEA', name: 'Kraken', logo: 'https://a.espncdn.com/i/teamlogos/nhl/500/scoreboard/sea.png' },
  home: { abbr: 'FLA', name: 'Panthers', logo: 'https://a.espncdn.com/i/teamlogos/nhl/500/scoreboard/fla.png' },
  gamecastUrl: 'https://www.espn.com/nhl/game/_/gameId/401892522'
});

/* A live NHL landing at a given score and situation, built from the real fixture. */
function landing(opts) {
  const j = clone(fx('nhle-landing'));
  const o = opts || {};
  j.gameState = o.state || 'LIVE';
  j.clock = { timeRemaining: o.clock || '12:41', secondsRemaining: 761, running: true, inIntermission: !!o.intermission };
  j.periodDescriptor = { number: o.period || 2, periodType: 'REG', maxRegulationPeriods: 3 };
  if (o.away !== undefined) j.awayTeam.score = o.away;
  if (o.home !== undefined) j.homeTeam.score = o.home;
  j.situation = Object.assign({}, j.situation, { situationCode: o.code || '1551', secondsRemaining: o.ppLeft === undefined ? 120 : o.ppLeft });
  (o.goals || []).forEach((g) => {
    let p = j.summary.scoring.find((x) => x.periodDescriptor.number === 2);
    if (!p) { p = { periodDescriptor: { number: 2, periodType: 'REG' }, goals: [] }; j.summary.scoring.push(p); }
    p.goals.push(Object.assign({ goalModifier: 'none', firstName: { default: 'X' } }, g));
  });
  (o.penalties || []).forEach((x) => {
    let p = j.summary.penalties.find((q) => q.periodDescriptor.number === 2);
    if (!p) { p = { periodDescriptor: { number: 2, periodType: 'REG' }, penalties: [] }; j.summary.penalties.push(p); }
    p.penalties.push(x);
  });
  return j;
}

/* ---- parsing ------------------------------------------------------------------------------------- */
{
  const r = S.parseEspn(fx('espn-nhl-event'), NHL_PIN);
  check(!r.error && r.source === 'espn' && r.sport === 'hockey', 'ESPN NHL event parses', r);
  check(r.away.abbr === 'SEA' && r.home.abbr === 'FLA' && r.away.score === 1 && r.home.score === 3, 'ESPN NHL teams and scores', [r.away, r.home]);
  check(r.phase === 'break' && r.line === 'End of 1st', 'ESPN NHL intermission reads as a break', [r.phase, r.line]);
  check(r.goals === null && r.penalties === null && r.strength === null, 'ESPN hockey has no goal/penalty list (null, not empty)');
  check(r.away.logo === NHL_PIN.away.logo, "the pin's own logo wins over the feed's");
}
{
  const r = S.parseNhl(fx('nhle-landing'), NHL_PIN);
  check(!r.error && r.source === 'nhl' && r.away.score === 1 && r.home.score === 3, 'NHL landing parses (score)', r.error || [r.away, r.home]);
  check(r.goals.length === 4 && r.goals[3].scorer === 'Verhaeghe' && r.goals[3].total === 5 && r.goals[3].strength === 'PP', 'NHL goals: scorer, season total, strength', r.goals);
  check(r.penalties.length === 4 && r.penalties[0].desc === 'Tripping' && r.penalties[0].minutes === 2 && r.penalties[1].kind === 'bench', 'NHL penalties: description, minutes, bench minor', r.penalties);
  check(r.phase === 'break' && r.line === 'End of 1st', 'NHL intermission reads as a break', [r.phase, r.line]);
  check(S.matchNhlGame(fx('nhle-score'), NHL_PIN) === '2026020124', 'ESPN game -> NHL game id by both teams');
  const tb = S.cleanPin({ id: '401892999', league: 'nhl', away: { abbr: 'TB' }, home: { abbr: 'NJ' } });
  check(S.matchNhlGame({ games: [{ id: 2026020777, awayTeam: { abbrev: 'TBL' }, homeTeam: { abbrev: 'NJD' } }] }, tb) === '2026020777', 'ESPN TB/NJ match the NHL TBL/NJD');
  check(S.matchNhlGame({ games: [{ id: 2026020777, awayTeam: { abbrev: 'NJD' }, homeTeam: { abbrev: 'TBL' } }] }, tb) === '', 'home/away swapped is not a match');
  check(S.nhlDay(Date.parse('2026-10-18T02:30Z')) === '2026-10-17', 'the NHL day is the Eastern date');
}
{
  const cfb = fx('espn-cfb-event');
  const pin = S.cleanPin({ id: cfb.id, league: 'cfb', away: { abbr: 'AUB' }, home: { abbr: 'UGA' } });
  const r = S.parseEspn(cfb, pin);
  check(!r.error && r.sport === 'football' && r.away.score === 24 && r.home.score === 24 && r.line === '1:12 - 4th', 'ESPN college football parses', r);
  check(r.lastPlay && r.lastPlay.type === 'Timeout', 'football lastPlay read');
  const epl = fx('espn-epl-event');
  const pe = S.parseEspn(epl, S.cleanPin({ id: epl.id, league: 'epl', away: { abbr: 'CHE' }, home: { abbr: 'EVE' } }));
  check(!pe.error && pe.phase === 'final' && pe.line === 'Final', 'soccer full time reads Final', [pe.phase, pe.line]);
  check(pe.goals.length === 2 && pe.goals[0].scorer === 'Neto' && pe.penalties.every((p) => p.kind === 'yellow' || p.kind === 'red'), 'soccer goals and cards from details', [pe.goals, pe.penalties.length]);
  const mlb = fx('espn-mlb-event');
  const pm = S.parseEspn(mlb, S.cleanPin({ id: mlb.id, league: 'mlb', away: { abbr: 'TB' }, home: { abbr: 'CLE' } }));
  check(!pm.error && pm.state === 'pre' && pm.away.score === null, 'baseball pre-game: no score yet', pm);
  const nba = fx('espn-nba-event');
  const pn = S.parseEspn(nba, S.cleanPin({ id: nba.id, league: 'nba', away: { abbr: 'BOS' }, home: { abbr: 'DET' } }));
  check(!pn.error && pn.sport === 'basketball' && pn.phase === 'pre', 'basketball parses', pn);
  check(S.parseEspn({ nope: 1 }, NHL_PIN).error && S.parseNhl('<html>', NHL_PIN).error && S.parseNhl(null, NHL_PIN).error, 'garbage gives { error }, never a throw');
  check(/changed shape/.test(S.parseNhl({ awayTeam: {}, homeTeam: {}, gameState: 'WAT' }, NHL_PIN).error), 'an unknown game state is named');
}

/* ---- the diff: hockey ----------------------------------------------------------------------------- */
const base = S.parseNhl(landing({ away: 1, home: 3 }), NHL_PIN);
check(S.diff(null, base).length === 0, 'a card that just opened replays nothing (no prev, no events)');
check(S.diff(base, base).length === 0, 'the same reading twice: no events');
{
  const next = S.parseNhl(landing({ away: 2, home: 3, goals: [{ eventId: 600, strength: 'pp', lastName: { default: 'Wright' }, name: { default: 'S. Wright' }, teamAbbrev: { default: 'SEA' }, goalsToDate: 4, timeInPeriod: '07:19', isHome: false }] }), NHL_PIN);
  const ev = S.diff(base, next);
  check(ev.length === 1 && ev[0].kind === 'score' && ev[0].side === 'away' && ev[0].sound === 'horn', 'goal: one score event for the scoring side, with the horn', ev);
  check(ev[0] && ev[0].strip === 'GOAL · SEA · Wright (4) · PP', 'goal strip: GOAL · SEA · Wright (4) · PP', ev[0] && ev[0].strip);
  // The goal is then disallowed (coach's challenge): the score drops back and the goal leaves the list.
  const back = S.parseNhl(landing({ away: 1, home: 3 }), NHL_PIN);
  const ov = S.diff(next, back);
  check(ov.length === 1 && ov[0].kind === 'overturned' && ov[0].side === 'away' && ov[0].sound === '' && /GOAL OVERTURNED · SEA · SEA 1–3 FLA/.test(ov[0].strip), 'disallowed goal: an overturned event, no horn', ov);
}
{
  const pen = { timeInPeriod: '09:30', type: 'MIN', duration: 2, committedByPlayer: { lastName: { default: 'Ekblad' } }, teamAbbrev: { default: 'FLA' }, descKey: 'tripping' };
  const pp = S.parseNhl(landing({ away: 1, home: 3, code: '1541', ppLeft: 120, penalties: [pen] }), NHL_PIN);
  const ev = S.diff(base, pp);
  check(ev.length === 1 && ev[0].kind === 'penalty' && ev[0].side === 'home' && ev[0].sound === 'tone', 'penalty: one event, the soft tone', ev);
  check(ev[0] && ev[0].strip === 'PENALTY · FLA · Tripping · 2:00', 'penalty strip: PENALTY · FLA · Tripping · 2:00', ev[0] && ev[0].strip);
  check(pp.strength && pp.strength.kind === 'pp' && pp.strength.side === 'away' && pp.strength.text === 'SEA PP' && pp.strength.secondsLeft === 120, 'the power play: side, words, time left', pp.strength);
  check(S.nextPollMs(pp, 0, 0) === S.POLL.hot, 'a power play polls at the faster rate');
  const later = S.parseNhl(landing({ away: 1, home: 3, code: '1541', ppLeft: 64, penalties: [pen] }), NHL_PIN);
  check(S.diff(pp, later).length === 0 && later.strength.secondsLeft === 64, 'the power play counting down is not an event');
  const over = S.parseNhl(landing({ away: 1, home: 3, code: '1551', penalties: [pen] }), NHL_PIN);
  const end = S.diff(later, over);
  check(end.length === 1 && end[0].kind === 'pp-end' && end[0].side === 'away' && end[0].sound === '' && over.strength === null, 'power play expires: a quiet pp-end, indicator gone', end);
  const fiveThree = S.parseNhl(landing({ code: '1531' }), NHL_PIN);
  check(fiveThree.strength && fiveThree.strength.text === 'SEA 5-on-3', 'a two-man advantage reads 5-on-3', fiveThree.strength);
  const pulled = S.parseNhl(landing({ code: '0651' }), NHL_PIN);
  check(pulled.strength && pulled.strength.kind === 'en' && pulled.strength.text === 'SEA goalie pulled', 'an empty net reads goalie pulled', pulled.strength);
}
{
  // Feed outage: an unreadable body is an error the diff ignores; the cadence backs off; the words.
  const bad = S.parseNhl('<html>Service Unavailable</html>', NHL_PIN);
  check(bad.error && S.diff(base, bad).length === 0, 'outage: an unreadable body is an error, never events', bad);
  check(S.nextPollMs(base, 0, 1) === 30000 && S.nextPollMs(base, 0, 2) === 60000 && S.nextPollMs(base, 0, 3) === 120000 && S.nextPollMs(base, 0, 9) === 120000, 'outage: back-off 30 / 60 / 120 s, capped');
  check(S.pausedLine('ESPN', 'timed out after 10 s', 30000) === "Scores paused: ESPN didn't answer (timed out after 10 s), retrying in 30 s", 'outage: the card says what failed and when it retries');
  // Recovering after the outage with a goal that happened meanwhile, after a long gap: quiet.
  const caught = S.parseNhl(landing({ away: 1, home: 4, goals: [{ eventId: 700, strength: 'ev', lastName: { default: 'Reinhart' }, teamAbbrev: { default: 'FLA' }, goalsToDate: 9, timeInPeriod: '11:00', isHome: true }] }), NHL_PIN);
  const q = S.diff(base, caught, { quiet: true });
  check(q.length === 1 && q[0].quiet === true && q[0].strip === 'GOAL · FLA · Reinhart (9)', 'after a long gap the goal still shows, marked quiet (no sound)', q);
}
{
  const fin = S.parseNhl(landing({ state: 'OFF', away: 1, home: 3 }), NHL_PIN);
  const ev = S.diff(base, fin);
  check(ev.length === 1 && ev[0].kind === 'final' && ev[0].strip === 'FINAL · SEA 1–3 FLA', 'Final: one final event', ev);
  check(fin.line === 'Final' && S.nextPollMs(fin, 0, 0) === null, 'Final: the card says Final and polling stops');
  const ot = landing({ state: 'OFF' }); ot.periodDescriptor = { number: 4, periodType: 'OT' };
  check(S.parseNhl(ot, NHL_PIN).line === 'Final/OT', 'Final in overtime reads Final/OT');
}
{
  // NHL feed down for a tick -> the score came from ESPN (no lists). Back on NHL at the same score: nothing.
  const espn = S.parseEspn(fx('espn-nhl-event'), NHL_PIN);
  const nhl = S.parseNhl(fx('nhle-landing'), NHL_PIN);
  check(S.diff(espn, nhl).length === 0 && S.diff(nhl, espn).length === 0, 'a source switch at the same score fakes no goal and no penalty');
  const nhl2 = S.parseNhl(landing({ away: 1, home: 4, goals: [{ eventId: 800, strength: 'sh', lastName: { default: 'Lundell' }, teamAbbrev: { default: 'FLA' }, goalsToDate: 2, timeInPeriod: '03:00', isHome: true }] }), NHL_PIN);
  const ev = S.diff(espn, nhl2);
  check(ev.length === 1 && ev[0].strip === 'GOAL · FLA · Lundell (2) · SH', 'a goal across a source switch takes the side\'s newest goal', ev);
}

/* ---- the diff: other sports ------------------------------------------------------------------------ */
{
  const cfb = fx('espn-cfb-event');
  const pin = S.cleanPin({ id: cfb.id, league: 'cfb', away: { abbr: 'AUB' }, home: { abbr: 'UGA' } });
  const a = S.parseEspn(cfb, pin);
  const td = clone(cfb);
  td.competitions[0].competitors.find((c) => c.homeAway === 'home').score = '31';
  td.competitions[0].situation.lastPlay = { id: '1', type: { text: 'Passing Touchdown', abbreviation: 'TD' }, text: 'G. Stockton pass to L. Humphreys for 4 yds, for a TD (P. Woodring KICK)', scoreValue: 6, team: { id: '61' } };
  const ev = S.diff(a, S.parseEspn(td, pin));
  check(ev.length === 1 && /^TOUCHDOWN · UGA · G. Stockton pass to L. Humphreys/.test(ev[0].strip) && ev[0].strip.length <= 64 && ev[0].sound === 'horn', 'football: TOUCHDOWN with the play', ev);
  const fg = clone(cfb);
  fg.competitions[0].competitors.find((c) => c.homeAway === 'away').score = '27';
  fg.competitions[0].situation.lastPlay = { id: '2', type: { text: 'Kickoff', abbreviation: 'K' }, text: 'Kickoff', scoreValue: 0, team: { id: '2' } };
  const ev2 = S.diff(a, S.parseEspn(fg, pin));
  check(ev2.length === 1 && ev2[0].strip === 'FIELD GOAL · AUB', 'football: +3 with no scoring play reads FIELD GOAL', ev2);
}
{
  const epl = fx('espn-epl-event');
  const pin = S.cleanPin({ id: epl.id, league: 'epl', away: { abbr: 'CHE' }, home: { abbr: 'EVE' } });
  const live = clone(epl);
  live.status.type = { name: 'STATUS_SECOND_HALF', state: 'in', shortDetail: "89'" };
  const before = clone(live);
  before.competitions[0].details = before.competitions[0].details.filter((d) => d.clock.value < 5000);
  before.competitions[0].competitors.find((c) => c.homeAway === 'away').score = '1';
  const a = S.parseEspn(before, pin), b = S.parseEspn(live, pin);
  const ev = S.diff(a, b);
  const goal = ev.find((e) => e.kind === 'score');
  check(goal && goal.strip === 'GOAL · CHE · Neto · 90\'' && goal.sound === 'horn', 'soccer: a goal with the scorer and minute', ev);
  const red = clone(live);
  red.competitions[0].details.push({ type: { id: '93', text: 'Red Card' }, clock: { value: 5300, displayValue: "88'" }, team: { id: '368' }, scoringPlay: false, redCard: true, yellowCard: false, athletesInvolved: [{ id: '9', shortName: 'J. Tarkowski' }] });
  const ev2 = S.diff(b, S.parseEspn(red, pin));
  check(ev2.length === 1 && ev2[0].kind === 'card' && ev2[0].card === 'red' && ev2[0].strip === "RED CARD · EVE · Tarkowski 88'" && ev2[0].sound === 'tone', 'soccer: a red card, the soft tone', ev2);
}
{
  const nba = fx('espn-nba-event');
  const pin = S.cleanPin({ id: nba.id, league: 'nba', away: { abbr: 'BOS' }, home: { abbr: 'DET' } });
  const live = clone(nba);
  live.status.type = { name: 'STATUS_IN_PROGRESS', state: 'in', shortDetail: '5:12 - 2nd' };
  live.competitions[0].competitors.forEach((c) => { c.score = '40'; });
  const a = S.parseEspn(live, pin);
  const b2 = clone(live); b2.competitions[0].competitors[0].score = '42';
  const ev = S.diff(a, S.parseEspn(b2, pin));
  check(ev.length === 1 && ev[0].minor === true && ev[0].sound === '' && ev[0].strip === '', 'basketball: a basket rolls the number only (no strip, no horn)', ev);
  const mlb = fx('espn-mlb-event');
  const mp = S.cleanPin({ id: mlb.id, league: 'mlb', away: { abbr: 'TB' }, home: { abbr: 'CLE' } });
  const ml = clone(mlb);
  ml.status.type = { name: 'STATUS_IN_PROGRESS', state: 'in', shortDetail: 'Bot 7th' };
  ml.competitions[0].competitors.forEach((c) => { c.score = '2'; });
  const m1 = S.parseEspn(ml, mp);
  const m2 = clone(ml);
  m2.competitions[0].competitors.find((c) => c.homeAway === 'home').score = '4';
  m2.competitions[0].situation = { lastPlay: { id: '5', type: { text: 'Play Result' }, text: 'J. Ramirez homered to left (412 feet), S. Kwan scored.', scoreValue: 2, team: { id: '5' } }, outs: 1, balls: 0, strikes: 0, onFirst: false };
  const me = S.diff(m1, S.parseEspn(m2, mp));
  check(me.length === 1 && /^2 RUNS · CLE · J. Ramirez homered to left/.test(me[0].strip) && me[0].sound === 'horn', 'baseball: 2 RUNS with the play', me);
}

/* ---- cadence and the pin's checks ------------------------------------------------------------------ */
{
  const now = Date.parse('2026-10-17T20:00Z');
  const pre = Object.assign({}, base, { phase: 'pre', state: 'pre', startsAt: now + 3 * 3600e3 });
  check(S.nextPollMs(pre, now, 0) === 300000, 'pre-game hours out: every 5 min');
  check(S.nextPollMs(Object.assign({}, pre, { startsAt: now + 90e3 }), now, 0) === 90000, 'pre-game 90 s out: wakes at the start');
  check(S.nextPollMs(Object.assign({}, pre, { startsAt: now - 60e3 }), now, 0) === 60000, 'past the start, not under way: every 60 s');
  check(S.nextPollMs(Object.assign({}, base, { phase: 'break' }), now, 0) === 60000, 'intermission: every 60 s');
  check(S.nextPollMs(Object.assign({}, base, { phase: 'live' }), now, 0) === 15000, 'live: every 15 s');
  check(S.nextPollMs(Object.assign({}, base, { phase: 'off' }), now, 0) === null, 'postponed: stop');
}
{
  check(S.cleanPin({ id: '401892522', league: 'xfl', away: { abbr: 'A' }, home: { abbr: 'B' } }) === null, 'pin: unknown league refused');
  check(S.cleanPin({ id: 'abc', league: 'nhl', away: { abbr: 'A' }, home: { abbr: 'B' } }) === null, 'pin: a non-numeric id refused');
  check(S.cleanPin({ id: '401892522', league: 'nhl', away: {}, home: { abbr: 'B' } }) === null, 'pin: a team with no name refused');
  const p = S.cleanPin({ id: '401892522', league: 'nhl', away: { abbr: 'sea', logo: 'javascript:alert(1)' }, home: { abbr: 'FLA' }, url: 'https://www.espn.com/watch/player?id=1' });
  check(p && p.away.abbr === 'SEA' && p.away.logo === '' && p.url === 'https://www.espn.com/nhl/game/_/gameId/401892522', 'pin: non-https logo dropped; a player URL becomes the gamecast (never Edge)', p);
  const q = S.cleanPin({ id: '401892522', league: 'nhl', away: { abbr: 'SEA' }, home: { abbr: 'FLA' }, url: 'https://evil.example/' });
  check(q && q.url === 'https://www.espn.com/nhl/game/_/gameId/401892522', 'pin: a non-ESPN URL becomes the gamecast');
}

console.log('scores-test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
