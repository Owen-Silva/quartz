try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine: no cap needed */ }
// score-pins-e2e.js -- Lumen's pinned scores end to end: a REAL hidden Quartz test instance whose score
// feeds point at a LOCAL mock (fixtures from tests/scores-fixtures/, never the real feeds, never an account).
//
//   node score-pins-e2e.js [--cdp 9241] [--shots C:\Users\you\morning-shots] [--measure]
//
// The cards are the windows the user would see, so this run proves they never are: main.js puts every
// --test-profile card at -20000,-20000 and mutes its audio before the page exists, and e2e-kit's
// testwatch.js watcher (started before launch) FAILS the run if any window of it touches the screen.
// Sounds are asserted by count (the card reports each one it WOULD play), never by playing them.
//
// Checks: nothing runs with nothing pinned; pinning from Lumen's game card (the console-line path) and
// from the palette (api.scores.pin); the card's window state (alwaysOnTop, never focusable or focused,
// shown inactive, audio muted, off-screen, stacked in the corner); a penalty -> its strip, the tone and
// the power-play pill counting down; a power-play goal -> the roll, the strip, the horn, the pill gone;
// a disallowed goal; a power play running out (no sound); a feed outage -> the card's words, the last
// update and the retry, then recovery; the global sound switch and a card's mute; reduced motion; two
// pins stacking; the palette's rows; light and dark; a click opening the gamecast (never Edge); the Lumen
// tab closing (the pins stay); Final (polling stops); a restart restoring the pins and a dragged card's
// place with no sound replayed; the close control. One line: "score-pins-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Snap = require('./tests/watch-snapshot');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9241'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'lumen-scores-shots'));
const MEASURE = argv.includes('--measure');
const TAG = 'lumen-scores-e2e-' + process.pid;
const OPEN_STUB = path.join(os.tmpdir(), TAG + '-open.txt');
const FIX = path.join(__dirname, 'tests', 'scores-fixtures');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n + '.json'), 'utf8'));
const clone = (j) => JSON.parse(JSON.stringify(j));

/* ---- the mock feeds ---------------------------------------------------------------------------- */
const NHL_ESPN = '401802517', NBA_ESPN = '401810231', NHL_ID = 2026020999;
const BASE_GOALS = [
  { eventId: 11, isHome: true, lastName: { default: 'Matthews' }, goalsToDate: 11, strength: 'ev', teamAbbrev: { default: 'TOR' }, timeInPeriod: '03:12', goalModifier: 'none' },
  { eventId: 12, isHome: false, lastName: { default: 'Suzuki' }, goalsToDate: 5, strength: 'ev', teamAbbrev: { default: 'MTL' }, timeInPeriod: '09:40', goalModifier: 'none' },
  { eventId: 13, isHome: true, lastName: { default: 'Nylander' }, goalsToDate: 7, strength: 'ev', teamAbbrev: { default: 'TOR' }, timeInPeriod: '01:05', goalModifier: 'none' },
];
const PEN_MTL = { timeInPeriod: '07:30', type: 'MIN', duration: 2, committedByPlayer: { lastName: { default: 'Guhle' } }, teamAbbrev: { default: 'MTL' }, descKey: 'tripping' };
const PEN_TOR = { timeInPeriod: '10:02', type: 'MIN', duration: 2, committedByPlayer: { lastName: { default: 'Rielly' } }, teamAbbrev: { default: 'TOR' }, descKey: 'hooking' };
const GOAL_PP = { eventId: 20, isHome: true, lastName: { default: 'Matthews' }, goalsToDate: 12, strength: 'pp', teamAbbrev: { default: 'TOR' }, timeInPeriod: '08:55', goalModifier: 'none' };

const mock = { mode: 'ok', hits: {}, game: null, nba: null };
function landing(o) {
  const j = clone(fx('nhle-landing'));
  j.id = NHL_ID;
  j.gameState = o.state || 'LIVE';
  j.startTimeUTC = new Date(Date.now() - 3600e3).toISOString();
  j.awayTeam = { abbrev: 'MTL', commonName: { default: 'Canadiens' }, score: o.away, logo: '' };
  j.homeTeam = { abbrev: 'TOR', commonName: { default: 'Maple Leafs' }, score: o.home, logo: '' };
  j.periodDescriptor = { number: 2, periodType: 'REG', maxRegulationPeriods: 3 };
  j.clock = { timeRemaining: o.clock || '12:41', secondsRemaining: 761, running: true, inIntermission: false };
  j.situation = { situationCode: o.code || '1551', secondsRemaining: o.ppLeft || 120, awayTeam: { abbrev: 'MTL' }, homeTeam: { abbrev: 'TOR' } };
  j.summary = { scoring: [{ periodDescriptor: { number: 2, periodType: 'REG' }, goals: o.goals || BASE_GOALS }], penalties: [{ periodDescriptor: { number: 2, periodType: 'REG' }, penalties: o.pens || [] }] };
  return j;
}
function espnEvent(src, id, away, home, state, shortDetail) {
  const e = clone(fx(src));
  e.id = id;
  e.status.type = { name: state === 'in' ? 'STATUS_IN_PROGRESS' : 'STATUS_FINAL', state, shortDetail, completed: state === 'post' };
  const c = e.competitions[0];
  c.status = e.status;
  c.competitors.forEach((x) => {
    const t = x.homeAway === 'home' ? home : away;
    x.team = Object.assign({}, x.team, { abbreviation: t[0], shortDisplayName: t[1], displayName: t[1], logo: '' });
    x.score = String(t[2]);
  });
  return e;
}
const REST = { away: 1, home: 2 };
mock.game = landing(REST);
mock.nba = espnEvent('espn-nba-event', NBA_ESPN, ['BOS', 'Celtics', 54], ['NY', 'Knicks', 51], 'in', '4:12 - 3rd');
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  mock.hits[u] = (mock.hits[u] || 0) + 1;
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (mock.mode === 'down') return send(503, '{"error":"unavailable"}');
  if (u.indexOf('/nhle/v1/score/') === 0) return send(200, { games: [{ id: NHL_ID, gameState: 'LIVE', awayTeam: { abbrev: 'MTL' }, homeTeam: { abbrev: 'TOR' } }] });
  if (u === '/nhle/v1/gamecenter/' + NHL_ID + '/landing') return send(200, mock.game);
  if (u.endsWith('/basketball/nba/scoreboard/' + NBA_ESPN)) return send(200, mock.nba);
  const g = mock.game || mock.keep;
  if (u.endsWith('/hockey/nhl/scoreboard/' + NHL_ESPN)) return send(200, espnEvent('espn-nhl-event', NHL_ESPN, ['MTL', 'Canadiens', g.awayTeam.score], ['TOR', 'Maple Leafs', g.homeTeam.score], 'in', '12:41 - 2nd'));
  send(404, '{"error":"no such mock"}');
});
const hitsMatching = (re) => Object.keys(mock.hits).filter((k) => re.test(k)).reduce((n, k) => n + mock.hits[k], 0);

/* ---- the run ------------------------------------------------------------------------------------- */
run('score-pins-e2e', async ({ check, launch, say }) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  fs.mkdirSync(SHOTS, { recursive: true });
  try { fs.unlinkSync(OPEN_STUB); } catch (e) { /* none */ }
  const env = {
    QUARTZ_SCORES_REBASE: JSON.stringify([['https://site.api.espn.com', 'http://127.0.0.1:' + port + '/espn'], ['https://api-web.nhle.com', 'http://127.0.0.1:' + port + '/nhle']]),
    QUARTZ_SCORES_OPEN_STUB: OPEN_STUB,
    QUARTZ_SCORES_POLL_SCALE: '0.02',
    QUARTZ_WATCH_BOOT_GRACE_MS: '3600000',       // Lumen reads no real service during this run
  };
  let q = await launch({ cdp: CDP_PORT, env });
  const T = (op) => q.chrome.ev('api.scores.test(' + JSON.stringify(op || {}) + ')');
  const state = () => T({ op: 'state' });
  const pinOf = async (key) => (await state()).pins.find((p) => p.key === key);
  const cards = {};
  async function cardCdp(key) {
    for (let i = 0; i < 100; i++) {
      const t = (await q.targets()).find((x) => x.type === 'page' && /score-pin\.html/.test(x.url) && x.url.indexOf(encodeURIComponent(key)) !== -1);
      if (t) { const c = await new Cdp(t.webSocketDebuggerUrl).open(); await c.waitFor('window.__scorePin && window.__scorePin.state && window.__scorePin.state.reading', 15000); return c; }
      await sleep(150);
    }
    throw new Error('no card page for ' + key);
  }
  async function shot(key, name) {
    const b64 = await T({ op: 'capture', key });
    const f = path.join(SHOTS, 'lumen-scores-' + name + '.png');
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    say('shot ' + f);
    return b64;
  }
  const stripIs = (c, re) => c.waitFor('(function(){var s=document.getElementById("strip");return !s.hidden && ' + re + '.test(document.getElementById("stripTxt").textContent) && document.getElementById("stripTxt").textContent;})()', 8000);
  const played = (c) => c.ev('window.__scorePin.soundsPlayed.slice()');

  // 1. Nothing pinned: no card, no timer, no request.
  await sleep(1500);
  let st = await state();
  check(st.pins.length === 0 && Object.keys(mock.hits).length === 0, 'nothing pinned: no card window, no poll, no request', { pins: st.pins.length, hits: mock.hits });

  // 2. Pin from Lumen's game card: the real snapshot shape drawn by watch.js, its "Pin score" button clicked.
  await q.chrome.ev('openWatchTab(), 1');
  let lt = null;
  for (let i = 0; i < 100 && !lt; i++) { lt = (await q.targets()).find((x) => /watch\.html/.test(x.url)); if (!lt) await sleep(150); }
  const lumen = await new Cdp(lt.webSocketDebuggerUrl).open();
  await lumen.waitFor('window.ScorePinButton && typeof window.__applyWatch === "function"', 15000);
  await sleep(1200);
  const snap = Snap.full(Date.now());
  await lumen.ev('window.__applyWatch(' + JSON.stringify(snap) + '), 1');
  const nhlKey = 'nhl:' + NHL_ESPN, nbaKey = 'nba:' + NBA_ESPN;
  await lumen.waitFor('document.querySelectorAll(".gw .spb").length >= 2', 15000);
  check(await lumen.ev('[].slice.call(document.querySelectorAll(".gw .spb")).every(function(b){return b.closest(".gw").querySelector(".gc")})'), "Lumen's game cards carry a Pin score control");
  await lumen.ev('[].slice.call(document.querySelectorAll(".gw .spb")).filter(function(b){return b._key===' + JSON.stringify(nhlKey) + '})[0].click(), 1');
  await q.chrome.waitFor('api.scores.test({op:"state"}).then(function(s){return s.pins.length===1 && s.pins[0].ready && s.pins[0].reading})', 15000);
  const lumenPinned = await lumen.waitFor('(function(){var b=[].slice.call(document.querySelectorAll(".gw .spb")).filter(function(b){return b._key===' + JSON.stringify(nhlKey) + '})[0];return b && b.getAttribute("aria-pressed")==="true" && b.textContent;})()', 8000).catch(() => '');
  check(/Pinned/.test(lumenPinned), 'the Lumen button says Pinned once main has pinned it', lumenPinned);
  let p = await pinOf(nhlKey);
  check(p.alwaysOnTop === true && p.focusable === false && p.focused === false && p.visible === true, 'the card: always on top, never focusable, not focused, shown (inactive)', p);
  check(p.audioMuted === true && p.audible === false, 'TEST SILENCE: the card window is audio-muted', { audioMuted: p.audioMuted, audible: p.audible });
  check(p.bounds.x < -10000 && p.bounds.y < -10000, 'the card is off every monitor in a test', p.bounds);
  check(p.bounds.x + p.bounds.width === st.area.x + st.area.width - 16 && p.bounds.y + p.bounds.height === st.area.y + st.area.height - 16, 'one card sits in the bottom-right corner of the work area', [p.bounds, st.area]);
  check(p.nhlId === String(NHL_ID) && p.reading.source === 'nhl' && p.reading.away === 1 && p.reading.home === 2, 'NHL game matched to the NHL feed, score read', p);
  cards.nhl = await cardCdp(nhlKey);
  const c = cards.nhl;
  const dom = await c.ev('({a:document.querySelector("#away .ab").textContent,h:document.querySelector("#home .ab").textContent,as:document.querySelector("#away .n").textContent,hs:document.querySelector("#home .n").textContent,line:document.getElementById("line").textContent,lg:document.getElementById("lg").textContent,theme:document.documentElement.dataset.theme})');
  check(dom.a === 'MTL' && dom.h === 'TOR' && dom.as === '1' && dom.hs === '2' && dom.line === '2nd 12:41' && dom.lg === 'NHL', 'the card shows both teams, the score, the period and clock', dom);
  check((await played(c)).length === 0, 'opening a card replays nothing and plays no sound');

  async function scenario(theme) {
    const sfx = '-' + theme;
    mock.game = landing(REST);
    await c.waitFor('document.querySelector("#home .n:last-child").textContent==="2" && document.getElementById("strip").hidden', 10000);
    await sleep(400);
    await shot(nhlKey, 'rest' + sfx);
    // Penalty: MTL trips, TOR goes on the power play.
    const before = (await played(c)).length;
    mock.game = landing(Object.assign({ pens: [PEN_MTL], code: '1451', ppLeft: 120 }, REST));
    const pen = await stripIs(c, '/^PENALTY/');
    check(pen === 'PENALTY \u00b7 MTL \u00b7 Tripping \u00b7 2:00', 'penalty strip' + sfx, pen);
    await sleep(350);
    await shot(nhlKey, 'penalty' + sfx);
    const pl = await played(c);
    check(pl.length === before + 1 && pl[pl.length - 1] === 'tone', 'a penalty WOULD play the soft tone (counted, muted)' + sfx, pl);
    mock.game = landing(Object.assign({ pens: [PEN_MTL], code: '1451', ppLeft: 64 }, REST));
    const pill = await c.waitFor('(function(){var p=document.getElementById("pp");return !p.hidden && p.textContent==="TOR PP 1:04" && p.textContent;})()', 8000).catch((e) => e.message);
    check(pill === 'TOR PP 1:04', 'the power-play pill counts down with the feed' + sfx, pill);
    await c.waitFor('document.getElementById("strip").hidden', 9000);
    await sleep(300);
    await shot(nhlKey, 'powerplay' + sfx);
    // A power-play goal: the number rolls, the side washes, the strip, the horn; the pill goes.
    mock.game = landing({ away: 1, home: 3, pens: [PEN_MTL], code: '1551', goals: BASE_GOALS.concat([GOAL_PP]) });
    const goal = await stripIs(c, '/^GOAL/');
    check(goal === 'GOAL \u00b7 TOR \u00b7 Matthews (12) \u00b7 PP', 'goal strip' + sfx, goal);
    await sleep(260);
    await shot(nhlKey, 'goal' + sfx);
    const anim = await c.ev('document.getAnimations().map(function(a){return a.effect && a.effect.getKeyframes().map(function(k){return Object.keys(k).filter(function(x){return ["offset","easing","composite","computedOffset"].indexOf(x)<0}).join("+")}).join(",")})');
    check(anim.length >= 2 && anim.every((k) => /^((transform|opacity)(\+(transform|opacity))?,?)+$/.test(k)), 'mid-goal: only transform/opacity animate' + sfx, anim);
    const pg = await played(c);
    check(pg[pg.length - 1] === 'horn', 'a goal WOULD play the horn (counted, muted)' + sfx, pg);
    await c.waitFor('document.getElementById("pp").hidden && document.querySelector("#home .n:last-child").textContent==="3"', 6000);
    check(true, 'after the PP goal the pill is gone and TOR shows 3' + sfx);
    // The goal is disallowed.
    const n0 = (await played(c)).length;
    mock.game = landing(Object.assign({ pens: [PEN_MTL] }, REST));
    const ov = await stripIs(c, '/OVERTURNED/');
    check(ov === 'GOAL OVERTURNED \u00b7 TOR \u00b7 MTL 1\u20132 TOR' && (await played(c)).length === n0, 'a disallowed goal: OVERTURNED strip, the score rolls back, no sound' + sfx, ov);
    await c.waitFor('document.getElementById("strip").hidden', 9000);
    // A power play that simply runs out: the pill goes, silently.
    mock.game = landing(Object.assign({ pens: [PEN_MTL, PEN_TOR], code: '1541' }, REST));
    await c.waitFor('!document.getElementById("pp").hidden && /MTL PP/.test(document.getElementById("pp").textContent)', 8000);
    await c.waitFor('document.getElementById("strip").hidden', 9000);
    const n1 = (await played(c)).length;
    mock.game = landing(Object.assign({ pens: [PEN_MTL, PEN_TOR], code: '1551' }, REST));
    await c.waitFor('document.getElementById("pp").hidden', 8000);
    await sleep(500);
    check((await played(c)).length === n1, 'a power play expiring hides the pill and makes no sound' + sfx);
    // Outage: both feeds 503 -> the card's words, last update, retry; then back.
    mock.mode = 'down';
    const words = await c.waitFor('(function(){var n=document.getElementById("note");return !n.hidden && document.getElementById("noteTxt").textContent;})()', 10000);
    check(/^Scores paused: the NHL and ESPN didn't answer \(HTTP 503; HTTP 503\), retrying (in \d+ s|now)\. Last updated \d/.test(words), 'outage: the card says what failed, when it retries and when it last updated' + sfx, words);
    await shot(nhlKey, 'failure' + sfx);
    mock.mode = 'ok';
    await c.waitFor('document.getElementById("note").hidden && !document.getElementById("card").classList.contains("paused")', 15000);
    check(true, 'the feed back: the paused note goes' + sfx);
  }
  await scenario('dark');

  // ESPN-only fallback when the NHL feed alone fails: says penalties are paused, keeps the score.
  const nhlOnlyDown = mock.game;
  mock.keep = mock.game;
  mock.game = null;   // the landing route answers JSON null -> "changed shape"
  const partial = await c.waitFor('(function(){var n=document.getElementById("note");return !n.hidden && n.classList.contains("partial") && document.getElementById("noteTxt").textContent;})()', 10000).catch((e) => e.message);
  check(/^Penalties paused: the NHL's feed didn't answer \(.+\)\. Score from ESPN, retrying in \d+ s\. Last updated/.test(partial), 'NHL feed failing, ESPN answering: the card says penalties are paused, score from ESPN', partial);
  mock.game = nhlOnlyDown;
  await c.waitFor('document.getElementById("note").hidden', 10000);

  // Sound switches: global off, then this card muted.
  let n2 = (await played(c)).length;
  await q.chrome.ev('api.scores.setSound(false)');
  await c.waitFor('document.getElementById("mute").classList.contains("off")', 5000);
  mock.game = landing({ away: 2, home: 2, goals: BASE_GOALS.concat([{ eventId: 30, isHome: false, lastName: { default: 'Caufield' }, goalsToDate: 9, strength: 'ev', teamAbbrev: { default: 'MTL' }, timeInPeriod: '11:00' }]) });
  await stripIs(c, '/^GOAL \u00b7 MTL/');
  check((await played(c)).length === n2, 'global sound off: the goal animates, no sound counted');
  await q.chrome.ev('api.scores.setSound(true)');
  await c.waitFor('!document.getElementById("mute").classList.contains("off")', 5000);
  await c.ev('document.getElementById("mute").click(), 1');
  await c.waitFor('window.__scorePin.state.muted === true', 5000);
  mock.game = landing(REST);
  await stripIs(c, '/OVERTURNED/');
  await c.waitFor('document.getElementById("strip").hidden', 9000);
  mock.game = landing({ away: 2, home: 2, goals: BASE_GOALS.concat([{ eventId: 31, isHome: false, lastName: { default: 'Caufield' }, goalsToDate: 9, strength: 'ev', teamAbbrev: { default: 'MTL' }, timeInPeriod: '11:00' }]) });
  await stripIs(c, '/^GOAL \u00b7 MTL/');
  check((await played(c)).length === n2 && (await pinOf(nhlKey)).muted === true, 'this card muted: no sound counted, the mute is saved on the pin');
  await c.ev('document.getElementById("mute").click(), 1');
  await c.waitFor('window.__scorePin.state.muted === false', 5000);
  // Reduced motion: nothing moves.
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await c.waitFor('document.getElementById("strip").hidden', 9000);
  mock.game = landing(REST);
  await stripIs(c, '/OVERTURNED/');
  const rmAnims = await c.ev('document.getAnimations().length');
  check(rmAnims === 0, 'reduced motion: the strip and number change with no animation', rmAnims);
  await c.send('Emulation.setEmulatedMedia', { features: [] });

  // A second pin, from the palette path (api.scores.pin); the two stack in the corner.
  const nbaGame = snap.sports.live.find((e) => e.league === 'nba');
  const r2 = await q.chrome.ev('api.scores.pin(' + JSON.stringify(nbaGame) + ')');
  check(r2 && r2.ok && r2.key === nbaKey, 'palette path: api.scores.pin pins a second game', r2);
  await q.chrome.waitFor('api.scores.test({op:"state"}).then(function(s){return s.pins.length===2 && s.pins.every(function(p){return p.ready && p.reading})})', 15000);
  cards.nba = await cardCdp(nbaKey);
  st = await state();
  const [b1, b2] = st.pins.map((x) => x.bounds);
  check(b1.x === b2.x && b2.y + b2.height === st.area.y + st.area.height - 16 && b1.y + b1.height === b2.y - 8, 'two cards stack in the corner, newest lowest, 8 px apart', [b1, b2]);
  const pal = await q.chrome.ev('(window.ScorePins.refresh(), new Promise(function(r){setTimeout(function(){r(window.ScorePins.commands({}).map(function(x){return x.label}))},400)}))');
  // Lumen's cache is empty in a test profile (no reads ran), so the palette offers its fallback row.
  check(pal.indexOf('Pin a game score') !== -1 && pal.indexOf('Turn score sounds off') !== -1, "the palette's rows: the fallback pin row (no cached games) and the sound switch", pal);
  async function stackShot(name) {
    const s2 = await state();
    const imgs = [];
    for (const x of s2.pins) imgs.push({ b: x.bounds, d: await T({ op: 'capture', key: x.key }) });
    const minY = Math.min(...imgs.map((i) => i.b.y)), maxY = Math.max(...imgs.map((i) => i.b.y + i.b.height));
    const out = await lumen.ev('(async function(){var imgs=' + JSON.stringify(imgs) + ';var cv=document.createElement("canvas");var pad=16,dpr=' + '1' + ';cv.width=' + (s2.pins[0].bounds.width + 32) + ';cv.height=' + (maxY - minY + 32) + ';var g=cv.getContext("2d");g.fillStyle=getComputedStyle(document.documentElement).getPropertyValue("--bg")||"#888";g.fillRect(0,0,cv.width,cv.height);for(var i=0;i<imgs.length;i++){var im=new Image();im.src="data:image/png;base64,"+imgs[i].d;await im.decode();g.drawImage(im,pad,pad+imgs[i].b.y-' + minY + ',imgs[i].b.width,imgs[i].b.height);}return cv.toDataURL("image/png").split(",")[1];})()');
    const f = path.join(SHOTS, 'lumen-scores-' + name + '.png');
    fs.writeFileSync(f, Buffer.from(out, 'base64'));
    say('shot ' + f);
  }
  await stackShot('stacked-dark');
  const ndom = await cards.nba.ev('({a:document.querySelector("#away .ab").textContent,as:document.querySelector("#away .n").textContent,line:document.getElementById("line").textContent})');
  check(ndom.a === 'BOS' && ndom.as === '54' && ndom.line === '4:12 - 3rd', 'the NBA card reads ESPN', ndom);
  mock.nba = espnEvent('espn-nba-event', NBA_ESPN, ['BOS', 'Celtics', 56], ['NY', 'Knicks', 51], 'in', '3:50 - 3rd');
  await cards.nba.waitFor('document.querySelector("#away .n:last-child").textContent==="56"', 8000);
  const nbaQuiet = await cards.nba.ev('({s:window.__scorePin.soundsPlayed.length,strip:document.getElementById("strip").hidden})');
  check(nbaQuiet.s === 0 && nbaQuiet.strip === true, 'a basket rolls the number only: no strip, no horn', nbaQuiet);

  // Light theme: Quartz's switch reaches the cards; the same states again.
  await q.chrome.ev('setTheme("light"), 1');
  await c.waitFor('document.documentElement.dataset.theme === "light"', 5000);
  check(true, "Quartz's light theme reaches the cards");
  await scenario('light');
  await stackShot('stacked-light');
  await q.chrome.ev('setTheme("dark"), 1');

  // A click on the card opens the gamecast (never Edge, never a new window): the open stub records it.
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 150, y: 60, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 150, y: 60, button: 'left', clickCount: 1 });
  await sleep(600);
  const opened = fs.existsSync(OPEN_STUB) ? fs.readFileSync(OPEN_STUB, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  check(opened.length === 1 && /^https:\/\/www\.espn\.com\/nhl\/game\/_\/gameId\/401802517$/.test(opened[0].url), 'clicking the card opens its gamecast through openGame()', opened);

  // The Lumen tab closes: the pins stay.
  await q.chrome.ev('(function(){var t=findWatchTab();if(t)closeTab(t.id);return 1})()');
  await sleep(1500);
  check((await state()).pins.length === 2, 'closing the Lumen tab leaves the pins up');

  // Drag the NHL card away from the stack (main's own move path), then Final: polling stops.
  await T({ op: 'drag', key: nhlKey, dx: -400, dy: -300 });
  st = await state();
  const moved = st.pins.find((x) => x.key === nhlKey);
  check(moved.pos && moved.bounds.x === moved.pos.x, 'a dragged card keeps its own place', moved);
  mock.game = landing({ state: 'OFF', away: 1, home: 2 });
  const fin = await stripIs(c, '/^FINAL/');
  check(fin === 'FINAL \u00b7 MTL 1\u20132 TOR', 'Final: one strip', fin);
  await c.waitFor('document.getElementById("line").textContent === "Final"', 9000);
  const h0 = mock.hits['/nhle/v1/gamecenter/' + NHL_ID + '/landing'];
  await sleep(2500);
  const fp = await pinOf(nhlKey);
  check(mock.hits['/nhle/v1/gamecenter/' + NHL_ID + '/landing'] === h0 && fp.timer === false, 'Final: the card says Final and polling stops', { before: h0, after: mock.hits['/nhle/v1/gamecenter/' + NHL_ID + '/landing'], timer: fp.timer });

  // Restart: both pins come back, the dragged card at its place, no sound replayed. Real cadence this time.
  for (const k of Object.keys(cards)) cards[k].close();
  lumen.close();
  await q.quit();
  mock.game = landing({ away: 1, home: 2 });
  const env2 = Object.assign({}, env, { QUARTZ_SCORES_POLL_SCALE: '1' });
  q = await launch({ cdp: CDP_PORT, env: env2 });
  await q.chrome.waitFor('api.scores.test({op:"state"}).then(function(s){return s.pins.length===2 && s.pins.every(function(p){return p.ready && p.reading})})', 20000);
  st = await state();
  const back = st.pins.find((x) => x.key === nhlKey);
  check(back && back.pos && back.bounds.x === moved.pos.x && back.bounds.y === moved.pos.y, 'after a restart the pins are back, the dragged card where it was left', [back && back.bounds, moved.pos]);
  const rc = await cardCdp(nhlKey);
  await sleep(800);
  check((await played(rc)).length === 0 && back.audioMuted === true, 'a restored card replays no history and plays nothing (and is muted)');
  if (MEASURE) {
    // Idle CPU, one live card at the real 15 s cadence: close the NBA card, sample 60 s.
    await q.chrome.ev('api.scores.unpin(' + JSON.stringify(nbaKey) + ')');
    await sleep(3000);
    const pid = (await state()).pins[0].pid;
    await T({ op: 'metrics' });
    await sleep(60000);
    const m = await T({ op: 'metrics' });
    const card = m.find((x) => x.pid === pid) || {};
    const total = m.reduce((n, x) => n + x.cpu, 0);
    say('IDLE CPU over 60 s, one live card at 15 s polls: card renderer ' + (card.cpu || 0).toFixed(2) + '% of one core, ' + (card.wakeups || 0) + ' wakeups/s; all Quartz processes ' + total.toFixed(2) + '%; ' + m.map((x) => x.type + ' ' + x.cpu.toFixed(2)).join(', '));
    check(card.cpu !== undefined && card.cpu < 1, 'idle: the card renderer stays under 1% of a core', card);
  }
  // The close control drops the pin and its saved entry.
  await rc.ev('document.getElementById("close").click(), 1');
  await q.chrome.waitFor('api.scores.test({op:"state"}).then(function(s){return !s.pins.some(function(p){return p.key===' + JSON.stringify(nhlKey) + '})})', 8000);
  check(true, 'the close control drops the pin');
  rc.close();
  const left = (await state()).pins.length;
  for (const k of (await state()).pins.map((x) => x.key)) await q.chrome.ev('api.scores.unpin(' + JSON.stringify(k) + ')');
  check((await state()).pins.length === 0, 'every pin closed (' + left + ' left before the sweep)');
  await q.quit();
  server.close();
  try { fs.unlinkSync(OPEN_STUB); } catch (e) { /* none */ }
});
