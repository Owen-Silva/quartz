// tests/watch-alerts-test.js -- Lumen Alerts without Electron: watch/alerts.js (the diff, the batch,
// the gates, the game moves on ESPN-shaped fixtures) and watch-alerts-main.js driven by fakes (the
// toggles, held checks, silence, clicks, every Settings state), plus watch/ytlib-main.js's two hooks.
// Fixtures only (tests/watch-fixtures): no network, no account. One summary line:
// "watch-alerts-test: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../watch/alerts');
const AM = require('../watch-alerts-main');
const YM = require('../watch/ytlib-main');
const L = require('../watch/ytlib');
const Espn = require('../watch/adapters/espn');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 300)));
}
const FX = path.join(__dirname, 'watch-fixtures');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FX, n), 'utf8'));
const SUBS_URL = 'https://www.youtube.com/feed/subscriptions';
function subsStep(f) { return { ok: true, url: SUBS_URL, finalUrl: SUBS_URL, title: 'YouTube', status: 200, extracted: { data: f.ytInitialData, loggedIn: f.loggedIn, url: SUBS_URL }, json: null, text: null, captures: [], error: null }; }
function subsRead(name) { return L.parseSubs({ now: Date.now(), steps: { subs: subsStep(fx(name)) } }); }

// ESPN-shaped: the NHL scoreboard fixture with one game's status moved, read by Lumen's own adapter.
const NHL = fx('espn-nhl.json');
function espnEvents(mutate) {
  const j = JSON.parse(JSON.stringify(NHL));
  if (mutate) mutate(j);
  const r = Espn.parse({ now: Date.now(), steps: { nhl: { ok: true, status: 200, json: j, extracted: j } } }, { leagues: ['nhl'], now: Date.now() });
  return r.events || [];
}
function setState(j, id, state, detail, scores) {
  const e = j.events.find((x) => String(x.id) === id);
  const names = { pre: 'STATUS_SCHEDULED', in: 'STATUS_IN_PROGRESS', post: 'STATUS_FINAL' };
  for (const st of [e.status, e.competitions[0].status]) {
    if (!st) continue;
    st.type = Object.assign({}, st.type, { state, name: names[state], completed: state === 'post', detail: detail, shortDetail: detail, description: detail });
  }
  if (scores) e.competitions[0].competitors.forEach((c) => { c.score = String(c.homeAway === 'home' ? scores[1] : scores[0]); });
}

(async () => {
  /* --- the subscriptions diff --------------------------------------------------------------- */
  const first = subsRead('youtube-subs.json');
  const next = subsRead('youtube-subs-next.json');
  check(first.state === 'ok' && first.items.length === 10 && next.items.length === 11, 'fixtures: both Subscriptions reads parse (10, then 11 tiles)', [first.state, first.items.length, next.items.length]);
  let p = A.cleanPrefs(null);
  check(p.subs === true && p.teams === null && p.baselined === false && p.seen.length === 0, 'prefs: subscriptions on by default, teams not chosen, no baseline');
  let fresh = A.diffSubs(p, first.items);
  check(fresh.length === 0 && p.baselined && p.seen.length === 10, 'diff: the first good read is the baseline (nothing new, 10 remembered)', [fresh.length, p.seen.length]);
  fresh = A.diffSubs(p, first.items);
  check(fresh.length === 0, 'diff: the same feed again: nothing new');
  fresh = A.diffSubs(p, next.items);
  check(fresh.length === 2 && fresh[0].vid === 'sbNewVid011' && fresh[1].vid === 'sbNewVid012', 'diff: the next feed: exactly its 2 new uploads, newest first', fresh.map((f) => f.vid));
  check(fresh[0].channel && typeof fresh[0].channel === 'string' && /^https:\/\/www\.youtube\.com\/watch\?v=sbNewVid011/.test(fresh[0].url), 'diff: a new video carries its channel name and its watch URL', fresh[0]);
  check(A.diffSubs(p, next.items).length === 0, 'diff: once said, never again');
  const up = Object.assign({}, next.items[0], { vid: 'upcomingAA1', upcoming: true, title: 'Premiere' });
  check(A.diffSubs(p, [up].concat(next.items)).length === 0 && p.seen[0] === 'upcomingAA1', 'diff: an upcoming premiere is no upload (skipped, but remembered)');
  const roundTrip = A.cleanPrefs(JSON.parse(JSON.stringify(p)));
  check(roundTrip.baselined && roundTrip.seen.length === p.seen.length, 'prefs: the diff survives a save and load');
  const many = []; for (let i = 0; i < 700; i++) many.push({ vid: ('v' + String(i).padStart(10, '0')).slice(0, 11), url: '', title: 't' + i });
  A.diffSubs(p, many);
  check(p.seen.length === A.MAX_SEEN, 'diff: the remembered ids are capped', p.seen.length);

  /* --- batching ----------------------------------------------------------------------------- */
  check(A.subsAlert([], 1) === null, 'batch: nothing new, no alert');
  const one = A.subsAlert([{ vid: 'aaaaaaaaaaa', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'Fret work drills', channel: 'Coach R' }], 5);
  check(one.title === 'New from Coach R' && one.body === 'Fret work drills' && one.items.length === 1 && one.action === 'play', 'batch: one video: "New from <channel>", its title', one);
  const five = A.subsAlert(['a', 'b', 'c', 'd', 'e'].map((c) => ({ vid: c.repeat(11), url: 'https://www.youtube.com/watch?v=' + c.repeat(11), title: 'Video ' + c, channel: 'Ch ' + c })), 9);
  check(five.title === '5 new from your subscriptions' && five.lines.length === 3 && five.more === 2, 'batch: five videos make ONE alert naming 3, "and 2 more"', five);
  check(five.body.split('\n')[0] === 'Ch a: Video a' && /…and 2 more$/.test(five.body), 'batch: each line is "<channel>: <title>"', five.body);

  /* --- gates -------------------------------------------------------------------------------- */
  check(A.gate({ freeGb: 8 }) === '', 'gate: nothing running, memory free: open');
  check(/VALORANT/.test(A.gate({ gaming: 'valorant', freeGb: 8 })), 'gate: VALORANT running: paused, by name');
  check(/game/.test(A.gate({ gamingFlag: true, freeGb: 8 })), 'gate: the gaming flag file: paused');
  check(/1\.2 GB/.test(A.gate({ freeGb: 1.2 })), 'gate: under 2.5 GB free: paused with the number');
  check(A.gate({ freeGb: 3, minFreeGb: 4 }) !== '', 'gate: the floor is configurable');

  /* --- toggles ------------------------------------------------------------------------------ */
  const pt = A.cleanPrefs(null);
  check(A.teamsOn(pt, 0) === false && A.teamsOn(pt, 1) === true, 'toggle: teams off until a team is picked, then on');
  pt.teams = false;
  check(A.teamsOn(pt, 3) === false, 'toggle: teams turned off stays off with teams picked');
  check(A.cleanPrefs({ subs: false }).subs === false && A.cleanPrefs({ teams: true }).teams === true, 'toggle: both choices are kept');

  /* --- favourite teams: start / final on ESPN-shaped fixtures ------------------------------ */
  const base = espnEvents();
  const vanLa = base.find((e) => e.id === 'espn:401892518');
  check(vanLa && vanLa.state === 'pre' && vanLa.away.abbr === 'VAN' && vanLa.home.abbr === 'LA', 'fixture: VAN at LA is pre-game', vanLa && [vanLa.state, vanLa.away.abbr, vanLa.home.abbr]);
  const favs = [{ league: 'nhl', id: '13', abbr: 'VAN', name: 'Vancouver Canucks', logo: '' }];
  const gp = A.cleanPrefs(null);
  const t0 = vanLa.startsAt - 5 * 60e3;
  check(A.gameMoves(gp, base, favs, t0).length === 0 && gp.games['nhl:401892518'].state === 'pre', 'games: pre-game seen: no alert, its state kept');
  check(Object.keys(gp.games).length === 1, 'games: only the favourite\'s game is tracked (BOS-SEA live, NYR-TOR final ignored)', Object.keys(gp.games));
  check(A.espnHot(favs, base, t0) === true && A.espnHot(favs, base, vanLa.startsAt - 3600e3) === false, 'games: ESPN reads at the live cadence from 10 min before a favourite\'s start, not an hour before');
  const live = espnEvents((j) => setState(j, '401892518', 'in', '19:40 - 1st'));
  let mv = A.gameMoves(gp, live, favs, vanLa.startsAt + 60e3);
  check(mv.length === 1 && mv[0].type === 'start' && mv[0].key === 'nhl:401892518', 'games: pre -> in is a start', mv.map((m) => m.type));
  const sa = A.gameAlert(mv[0], 1);
  check(sa.title === 'Game on: VAN at LA' && sa.actions.join(',') === 'open,pin' && /NHL/.test(sa.body), 'games: the start alert offers Open and "Pin this game"', sa);
  check(A.espnHot(favs, live, vanLa.startsAt + 3600e3) === true, 'games: hot while the favourite plays');
  check(A.gameMoves(gp, live, favs, vanLa.startsAt + 120e3).length === 0, 'games: still live: nothing new');
  const fin = espnEvents((j) => setState(j, '401892518', 'post', 'Final', [4, 2]));
  mv = A.gameMoves(gp, fin, favs, vanLa.startsAt + 3 * 3600e3);
  check(mv.length === 1 && mv[0].type === 'final', 'games: in -> post is a final', mv.map((m) => m.type));
  const fa = A.gameAlert(mv[0], 2);
  check(fa.title === 'Final: VAN 4, LA 2' && fa.actions.join(',') === 'open', 'games: the final alert has the score and Open only', fa.title);
  check(A.gameMoves(gp, fin, favs, vanLa.startsAt + 3 * 3600e3 + 60e3).length === 0, 'games: a final is said once');
  // First seen already live: a start only while fresh; first seen final: never.
  const g2 = A.cleanPrefs(null);
  check(A.gameMoves(g2, live, favs, vanLa.startsAt + 10 * 60e3).length === 1, 'games: first seen 10 min into the game: still a start');
  const g3 = A.cleanPrefs(null);
  check(A.gameMoves(g3, live, favs, vanLa.startsAt + 2 * 3600e3).length === 0, 'games: first seen 2 h in (Lumen was closed): no stale start');
  const g4 = A.cleanPrefs(null);
  check(A.gameMoves(g4, fin, favs, vanLa.startsAt + 3 * 3600e3).length === 0, 'games: first seen final: never announced');
  // A home favourite too, and a team in no game.
  const g5 = A.cleanPrefs(null);
  A.gameMoves(g5, base, [{ league: 'nhl', abbr: 'LA' }], t0);
  check(A.gameMoves(g5, live, [{ league: 'nhl', abbr: 'LA' }], vanLa.startsAt).length === 1, 'games: the home side counts as well');
  check(A.gameMoves(A.cleanPrefs(null), base, [{ league: 'nba', abbr: 'VAN' }], t0).length === 0, 'games: same abbreviation, other league: no match');

  /* --- watch-alerts-main.js with fakes ------------------------------------------------------ */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-alerts-test-'));
  let t = 1_800_000_000_000;
  const sentMsgs = [];
  const opened = [], pinned = [], games = [];
  const gate = { gaming: '', flag: false, free: 8 };
  let favList = [];
  let lumenView = { leagues: ['nhl', 'nfl'], youtube: 'ok', espn: 'ok', background: true };
  const win = { isDestroyed: () => false, isMinimized: () => false, restore() {}, show() {}, focus() {} };
  const mk = (extra) => AM.create(Object.assign({
    test: Object.assign({ userData: dir, now: () => t, silent: true, offscreen: true, gaming: () => gate.gaming, gamingFlag: () => gate.flag, freeGb: () => gate.free }, (extra && extra.test) || {}),
    send: (ch, payload) => { sentMsgs.push({ ch, payload }); return true; },
    getWindow: () => win,
    getFavs: () => favList,
    lumenView: () => lumenView,
    openTitle: async (url, o) => { opened.push({ url, o }); return { ok: true, how: 'layer' }; },
    openGame: (url) => { games.push(url); return { ok: true, how: 'lumen' }; },
    pin: (ev) => { pinned.push(ev); return { ok: true, key: ev.league + ':' + String(ev.id).replace('espn:', '') }; },
    log: () => {},
  }, (() => { const x = Object.assign({}, extra || {}); delete x.test; return x; })()));
  let m = mk();
  let dsc = m.describe();
  check(dsc.subs.on && dsc.subs.state === 'never' && !dsc.teams.on && dsc.teams.favs.length === 0 && dsc.gate === '', 'main: a fresh profile: subscriptions on and never read, teams off with none picked', dsc);
  check(m.wantSubs() === true, 'main: with subscriptions on, the feed may follow a YouTube read with no page open');
  const okAns = (r, at) => ({ state: r.state, reason: r.reason || '', readAt: at, items: r.items });
  check(m.onSubs(okAns(first, t)) === null && sentMsgs.length === 0, 'main: the first read is the baseline: nothing sent');
  dsc = m.describe();
  check(dsc.subs.state === 'ok' && dsc.subs.found === 0 && dsc.subs.baselined, 'main: Settings: checked, nothing new', dsc.subs);
  t += 60e3;
  // Gaming: held, the diff not consumed.
  gate.gaming = 'valorant';
  check(m.wantSubs() === false, 'main: while VALORANT runs: no extra Subscriptions read');
  check(m.onSubs(okAns(next, t)) === null && sentMsgs.length === 0, 'main: while VALORANT runs: no alert');
  dsc = m.describe();
  check(/VALORANT/.test(dsc.subs.held) && /VALORANT/.test(dsc.gate), 'main: Settings says it is held, and why', dsc.subs.held);
  gate.gaming = ''; gate.flag = true;
  check(m.onSubs(okAns(next, t)) === null && sentMsgs.length === 0, 'main: the gaming flag file holds it too');
  gate.flag = false; gate.free = 1.1;
  check(m.onSubs(okAns(next, t)) === null && m.wantSubs() === false && sentMsgs.length === 0, 'main: under the RAM floor: no alert, no extra read');
  gate.free = 8;
  const al = m.onSubs(okAns(next, t));
  check(al && sentMsgs.length === 1 && sentMsgs[0].ch === 'lumen-alerts:show' && sentMsgs[0].payload.title === '2 new from your subscriptions', 'main: the gate clears: the held videos are said, once, batched', sentMsgs.map((x) => x.payload.title));
  check(sentMsgs[0].payload.silent === true && !('event' in sentMsgs[0].payload), 'main: a test profile marks the alert silent (no real notification)');
  check(m.onSubs(okAns(next, t + 1)) === null && sentMsgs.length === 1, 'main: the same feed again: nothing');
  m.shown({ id: al.id, surface: 'os', ok: true });
  check(m._counts().os === 1 && m.describe().last.surface === 'os', 'main: the chrome\'s answer is counted (os) and shown in Settings');
  const r = await m.act({ id: al.id, action: 'play', index: 1 });
  check(r.ok && opened.length === 1 && opened[0].url === al.items[1].url && opened[0].o.title === al.items[1].title, 'main: clicking a video plays it through Lumen\'s openTitle (the player layer)', opened);
  check((await m.act({ id: 'nope', action: 'play' })).ok === false, 'main: an unknown alert says why');
  // Signed out / error states.
  m.onSubs({ state: 'signed-out', reason: 'sign in to YouTube to see your subscriptions', readAt: t, items: [] });
  check(m.describe().subs.state === 'signed-out' && sentMsgs.length === 1, 'main: signed out: no alert, the state is there for Settings');
  m.onSubs({ state: 'error', reason: 'the page didn\'t load', readAt: t, items: [] });
  check(m.describe().subs.state === 'error' && /load/.test(m.describe().subs.reason), 'main: a failed read: its reason for Settings');
  // Toggles.
  m.set('subs', false);
  check(m.wantSubs() === false && m.onSubs(okAns(subsRead('youtube-subs.json'), t)) === null, 'main: subscriptions off: no extra read, no alert');
  m = mk();
  check(m.describe().subs.on === false, 'main: the toggle is saved', m.describe().subs);
  m.set('subs', true);

  // Teams.
  t = vanLa.startsAt - 5 * 60e3;
  check(m.onRead('espn', { state: 'ok', events: base, readAt: t }).length === 0 && !m.describe().teams.on, 'main: no team picked: no game alerts, teams off');
  favList = favs;
  check(m.describe().teams.on === true, 'main: a team is picked: game alerts turn on by themselves');
  check(m.espnHot(base) === true, 'main: ESPN may read at the live cadence around the start');
  m.onRead('espn', { state: 'ok', events: base, readAt: t });
  t = vanLa.startsAt + 60e3;
  gate.gaming = 'valorant';
  check(m.onRead('espn', { state: 'ok', events: live, readAt: t }).length === 0 && m.espnHot(live) === false, 'main: while VALORANT runs: no game alert, no faster ESPN reads');
  gate.gaming = '';
  const out = m.onRead('espn', { state: 'ok', events: live, readAt: t });
  check(out.length === 1 && out[0].title === 'Game on: VAN at LA', 'main: after the game: the start is still fresh, said once', out.map((a) => a.title));
  await m.act({ id: out[0].id, action: 'pin' });
  check(pinned.length === 1 && pinned[0].id === 'espn:401892518' && pinned[0].gamecastUrl, 'main: "Pin this game" hands the ESPN event to score pins (no score drawn here)', pinned[0] && pinned[0].id);
  await m.act({ id: out[0].id, action: 'open' });
  check(games.length === 1 && /401892518/.test(games[0]), 'main: Open hands its gamecast to Lumen\'s game page', games);
  t += 3 * 3600e3;
  const out2 = m.onRead('espn', { state: 'ok', events: fin, readAt: t });
  check(out2.length === 1 && /^Final: VAN 4, LA 2/.test(out2[0].title), 'main: the final', out2.map((a) => a.title));
  m.onRead('espn', { state: 'error', reason: 'ESPN timed out after 10 s', readAt: t });
  check(m.describe().teams.state === 'error' && /timed out/.test(m.describe().teams.reason), 'main: an ESPN failure: its reason for Settings');
  lumenView = { leagues: ['nfl'], youtube: 'ok', espn: 'ok' };
  check(m.describe().teams.missingLeagues.join() === 'nhl', 'main: a favourite whose league Lumen does not read is named', m.describe().teams.missingLeagues);
  m.set('teams', false);
  check(m.describe().teams.on === false && m.espnHot(live) === false, 'main: teams turned off: off, and ESPN back to hourly');
  // No window: the failure is kept, never silent.
  const m2 = mk({ getWindow: () => null, test: { userData: fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-alerts-test2-')) } });
  m2.onSubs(okAns(first, t)); m2.onSubs(okAns(next, t));
  check(m2.describe().last && m2.describe().last.ok === false && /window/.test(m2.describe().last.reason), 'main: no Quartz window: the alert failed, with the reason', m2.describe().last);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, AM.PREFS_FILE), 'utf8'));
  check(saved.subs === true && saved.teams === false && saved.baselined === true && Array.isArray(saved.seen) && !('favs' in saved), 'main: the file holds the toggles and the diff only (favourites stay sports-main\'s)', Object.keys(saved));

  /* --- watch/ytlib-main.js: the two hooks --------------------------------------------------- */
  const ydir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-alerts-yt-'));
  let want = true;
  const heard = [];
  let reads = 0;
  let feed = 'youtube-subs.json';
  let yt = 1_800_000_000_000;
  const ym = YM.create({
    now: () => yt, file: () => path.join(ydir, 'watch-ytlib.json'),
    setTimeout: (fn) => ({ fn }), clearTimeout: () => {},
    canRead: () => '', bootLeft: () => 0,
    runStep: async () => { reads++; return subsStep(fx(feed)); },
    wantSubs: () => want,
    onSubs: (a) => heard.push(a),
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res)); };
  ym.afterRead('youtube', 'ok');
  await settle();
  check(reads === 1 && heard.length === 1 && heard[0].state === 'ok' && heard[0].items.length === 10, 'ytlib hook: with alerts wanting it, a YouTube read is followed by one Subscriptions read with no page open, and alerts hear it', [reads, heard.length]);
  yt += 2 * 60e3;
  ym.afterRead('youtube', 'ok');
  await settle();
  check(reads === 1, 'ytlib hook: the feed is under 5 min old: no second read (still one per YouTube read at most)');
  yt += 10 * 60e3; want = false;
  ym.afterRead('youtube', 'ok');
  await settle();
  check(reads === 1, 'ytlib hook: alerts not wanting it and no page: no read (as before)');
  want = true; feed = 'youtube-subs-signedout.json';
  ym.afterRead('youtube', 'signed-out');
  await settle();
  check(heard.length >= 2 && heard[heard.length - 1].state === 'signed-out' && reads === 1, 'ytlib hook: YouTube signed out: alerts hear "signed out", no read', heard.map((h) => h.state));
  ym.stop();

  for (const x of [dir, ydir]) { try { fs.rmSync(x, { recursive: true, force: true }); } catch (e) { /* temp */ } }
  console.log('watch-alerts-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.log('FAIL watch-alerts-test crashed: ' + (err && err.stack)); console.log('watch-alerts-test: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
