try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine: no cap needed */ }
// sports-e2e.js -- Lumen's sports pages end to end: a REAL hidden Quartz test instance whose ESPN and NHL
// feeds point at a LOCAL mock (tests/sports-fixtures/ + the score pins' NHL fixtures; never the real feeds,
// never an account). Edge is a stub file and every open is recorded (QUARTZ_EDGE_STUB, QUARTZ_WATCH_OPEN_STUB).
//
//   node sports-e2e.js [--cdp 9243] [--shots C:\Users\you\next-week\morning-shots]
//
// Checks: a game card's tap opens the game page (box score, scoring by period, penalties, goalies, shots,
// period scores); it polls only while open and live, and a new goal arrives; Final brings the three stars
// and stops the polling; "Watch this game" routes ESPN+ into the player layer; a postponed game; favourites
// from the picker -> the My teams row and Live now led by his team; the team page and its schedule; the
// off-season; standings with the NHL wild card; a failed read with its reason and Retry; a score pin's click
// opening the game page. One line: "sports-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Snap = require('./tests/watch-snapshot');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9243'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'lumen-sports-shots'));
const TAG = 'lumen-sports-e2e-' + process.pid;
const OPEN_STUB = path.join(os.tmpdir(), TAG + '-open.txt');
const EDGE_STUB = path.join(os.tmpdir(), TAG + '-edge.txt');
const FIX = path.join(__dirname, 'tests', 'sports-fixtures');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n + '.json'), 'utf8'));
const sfx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'tests', 'scores-fixtures', n + '.json'), 'utf8'));
const clone = (j) => JSON.parse(JSON.stringify(j));
function dated(j, now, shiftDays) {
  return JSON.parse(JSON.stringify(j).replace(/"@([+-]?\d+)?d?"/g, (m, n) => {
    const day = new Date(now + ((Number(n) || 0) + (shiftDays || 0)) * 86400e3);
    day.setUTCHours(22, 0, 0, 0);
    return JSON.stringify(day.toISOString().replace(':00.000Z', 'Z'));
  }));
}

/* ---- the mock feeds ---------------------------------------------------------------------------- */
const mock = { game: 'live', hits: [], down: { nba: true } };
function summary() {
  const j = fx('nhl-summary-live');
  const c = j.header.competitions[0];
  if (mock.game === 'live2' || mock.game === 'final') {
    j.plays.push({ id: '4018925220010', type: { text: 'Goal' }, text: 'Sam Reinhart (4) Slap Shot, assists: Aleksander Barkov (4)', period: { number: 2 }, clock: { displayValue: '0:41' }, scoringPlay: true, team: { id: '26' }, strength: { text: 'Power Play', abbreviation: 'PP' }, awayScore: 2, homeScore: 4 });
    c.competitors[0].score = '4';
    c.competitors[0].linescores[1].displayValue = '2';
    c.status.displayClock = '0:41';
    c.status.type.detail = '0:41 - 2nd Period'; c.status.type.shortDetail = '0:41 - 2nd';
  }
  if (mock.game === 'final') {
    c.status = { period: 3, displayClock: '0:00', type: { name: 'STATUS_FINAL', state: 'post', completed: true, detail: 'Final', shortDetail: 'Final' } };
    c.competitors[0].linescores.push({ displayValue: '0' }); c.competitors[1].linescores.push({ displayValue: '0' });
    c.competitors[0].winner = true;
  }
  return j;
}
function landing() {
  const l = sfx('nhle-landing');
  l.summary.threeStars = [
    { star: 1, teamAbbrev: 'FLA', name: { default: 'M. Tkachuk' }, position: 'L', goals: 2, assists: 1 },
    { star: 2, teamAbbrev: 'FLA', name: { default: 'S. Bobrovsky' }, position: 'G', savePctg: 0.905 },
    { star: 3, teamAbbrev: 'SEA', name: { default: 'S. Wright' }, position: 'C', goals: 1, assists: 0 }];
  return l;
}
function postponed() {
  const j = fx('nhl-summary-live');
  const c = j.header.competitions[0];
  c.id = j.header.id = '401892515';
  c.status = { type: { name: 'STATUS_POSTPONED', state: 'post', detail: 'Postponed', shortDetail: 'Postponed' } };
  c.competitors.forEach((x) => { x.linescores = []; x.score = '0'; });
  c.competitors[1].team = { id: '20', abbreviation: 'TBL', displayName: 'Tampa Bay Lightning', logos: [{ href: 'https://a.espncdn.com/i/teamlogos/nhl/500/tb.png' }] };
  j.plays = []; j.boxscore = { teams: [], players: [] };
  return j;
}
const server = http.createServer((req, res) => {
  const u = req.url;
  mock.hits.push(u);
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const now = Date.now();
  if (/\/hockey\/nhl\/summary\?event=401892522$/.test(u)) return send(200, summary());
  if (/\/hockey\/nhl\/summary\?event=401892515$/.test(u)) return send(200, postponed());
  if (/\/apis\/site\/v2\/sports\/hockey\/nhl\/teams$/.test(u)) return send(200, fx('nhl-teams'));
  if (/\/hockey\/nhl\/teams\/26\/schedule$/.test(u)) return send(200, dated(fx('nhl-schedule-fla'), now));
  if (/\/hockey\/nhl\/teams\/10\/schedule$/.test(u)) {
    const s = dated(fx('nhl-schedule-fla'), now, -120);
    s.team = { id: '10', abbreviation: 'MTL', displayName: 'Montreal Canadiens', recordSummary: '30-40-12' };
    s.events = s.events.filter((e) => e.competitions[0].status.type.state === 'post');
    return send(200, s);
  }
  if (/\/apis\/v2\/sports\/hockey\/nhl\/standings/.test(u)) return send(200, fx('nhl-standings'));
  if (/\/apis\/v2\/sports\/basketball\/nba\/standings/.test(u)) return mock.down.nba ? send(503, '{}') : send(200, { children: [] });
  if (/\/hockey\/nhl\/scoreboard\/401892522$/.test(u)) return send(200, sfx('espn-nhl-event'));
  if (/\/nhle\/v1\/score\//.test(u)) return send(200, sfx('nhle-score'));
  if (/\/nhle\/v1\/gamecenter\/2026020124\/landing$/.test(u)) return send(200, landing());
  return send(404, '{}');
});

/* ---- the run ------------------------------------------------------------------------------------- */
run('sports-e2e', async ({ check, launch, say }) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of [OPEN_STUB, EDGE_STUB]) { try { fs.unlinkSync(f); } catch (e) { /* none */ } }
  const rebase = JSON.stringify([['https://site.api.espn.com', base + '/espn'], ['https://api-web.nhle.com', base + '/nhle']]);
  const env = {
    QUARTZ_SPORTS_REBASE: rebase, QUARTZ_SCORES_REBASE: rebase, QUARTZ_SCORES_POLL_SCALE: '0.05',
    QUARTZ_WATCH_BOOT_GRACE_MS: '3600000',       // Lumen reads no real service during this run
    QUARTZ_WATCH_OPEN_STUB: OPEN_STUB, QUARTZ_EDGE_STUB: EDGE_STUB,
  };
  const q = await launch({ cdp: CDP_PORT, env });
  await q.chrome.ev('openWatchTab(), 1');
  let lt = null;
  for (let i = 0; i < 100 && !lt; i++) { lt = (await q.targets()).find((x) => /watch\.html/.test(x.url)); if (!lt) await sleep(150); }
  const L = await new Cdp(lt.webSocketDebuggerUrl).open();
  await L.waitFor('window.LumenSports && typeof window.__applyWatch === "function" && typeof window.__applySports === "function"', 15000);
  await sleep(1000);
  const LS = (expr) => L.ev('(function(){var S=window.LumenSports;return ' + expr + ';})()');
  const vis = (sel) => L.ev('(function(){var n=document.querySelector(' + JSON.stringify(sel) + ');return !!(n && n.offsetParent!==null);})()');
  const txt = (sel) => L.ev('(function(){var n=document.querySelector(' + JSON.stringify(sel) + ');return n?n.textContent:"";})()');
  const count = (sel) => L.ev('document.querySelectorAll(' + JSON.stringify(sel) + ').length');
  const click = (sel) => L.ev('(function(){var n=document.querySelector(' + JSON.stringify(sel) + ');if(!n)return false;n.scrollIntoView({block:"center"});n.click();return true;})()');
  const clickText = (sel, re) => L.ev('(function(){var a=[].slice.call(document.querySelectorAll(' + JSON.stringify(sel) + ')).filter(function(n){return ' + re + '.test(n.textContent)});if(!a[0])return false;a[0].click();return true;})()');

  async function shot(name, w, h) {
    const file = path.join(SHOTS, 'lumen-n-sports-' + name + '-' + w + '.png');
    const r = await q.chrome.ev('(() => { const t = findWatchTab(); const v = t && t.viewEl; if (!v) return null; const b = v.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })()').catch(() => null);
    let grown = false;
    if (r && (r.w < w || r.h < h)) {
      grown = !!(await q.chrome.ev('(() => { const v = findWatchTab().viewEl; v.dataset.e2eStyle = v.getAttribute("style") || ""; const s = v.style; s.setProperty("position", "fixed", "important"); s.setProperty("left", "0px", "important"); s.setProperty("top", "0px", "important"); s.setProperty("width", "' + w + 'px", "important"); s.setProperty("height", "' + h + 'px", "important"); s.setProperty("z-index", "2147483647", "important"); return 1; })()').catch(() => 0));
      await sleep(600);
    }
    try {
      await L.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(900);
      await L.shot(file);
      say('shot ' + file);
    } catch (e) { say('shot ' + name + ' failed: ' + e.message); }
    await L.send('Emulation.clearDeviceMetricsOverride');
    if (grown) { await q.chrome.ev('(() => { const v = findWatchTab().viewEl; v.setAttribute("style", v.dataset.e2eStyle || ""); delete v.dataset.e2eStyle; return 1; })()').catch(() => 0); await sleep(400); }
  }
  const both = async (name) => { await shot(name, 1536, 800); await shot(name, 1920, 1000); };

  // The snapshot: the test kit's full one, plus tonight's SEA at FLA live on ESPN+ (no national TV)
  const now = Date.now();
  const snap = Snap.full(now);
  const live0 = snap.sports.live[0];
  const fla = Object.assign(clone(live0), {
    id: String(live0.id).replace(/\d+$/, '401892522'), league: 'nhl', leagueName: 'NHL', state: 'in', startsAt: now - 50 * 60e3, detail: '1:48 - 2nd',
    away: { name: 'Seattle Kraken', abbr: 'SEA', logo: 'https://a.espncdn.com/i/teamlogos/nhl/500/scoreboard/sea.png', score: '2', record: '3-3-1' },
    home: { name: 'Florida Panthers', abbr: 'FLA', logo: 'https://a.espncdn.com/i/teamlogos/nhl/500/scoreboard/fla.png', score: '3', record: '5-1-1' },
    broadcasts: ['ESPN+', 'SCRIPPS'], watchUrl: 'https://www.espn.com/watch/player/_/id/0f1e2d3c-sea-fla', gamecastUrl: 'https://www.espn.com/nhl/game/_/gameId/401892522',
  });
  if (fla.url !== undefined) fla.url = fla.watchUrl;
  const quiet = clone(snap);
  quiet.sports.live = [fla].concat(quiet.sports.live.map((e) => Object.assign(e, { broadcasts: ['ESPN+'] })));
  const keys = () => L.ev('[].slice.call(document.querySelectorAll("#stack > .lrow")).map(function(r){return r.dataset.key})');

  // 1. Live now: no favourite and no big game live -> it stays after Continue
  await L.ev('window.__applyWatch(' + JSON.stringify(quiet) + '), 1');
  await L.waitFor('document.querySelectorAll("#stack .gc").length > 2', 15000);
  let k = await keys();
  check(k[0] !== 'sports' && k.indexOf('sports') > 0, 'Live now stays below Continue while no favourite or big game is live', k);
  // a big game (the NBA on ESPN) live -> Live now leads
  const big = clone(snap);
  big.sports.live = [fla].concat(big.sports.live);
  await L.ev('window.__applyWatch(' + JSON.stringify(big) + '), 1');
  await sleep(600);
  k = await keys();
  check(k[0] === 'sports', 'a big game live (national TV): Live now is the first row', k);
  check(await L.ev('[].slice.call(document.querySelectorAll(".lrow .lr-h button")).some(function(b){return /Standings/.test(b.textContent)})') && /Game page/.test(await txt('.lrow[data-key="sports"] .gc .ft')), 'the sports rows carry Standings; a game card says Game page');

  // 2. Tap the SEA at FLA card -> the game page
  const card = '.lrow[data-key="sports"] .gc[data-key="' + fla.id + '"]';
  await click(card); await sleep(250); if (!(await LS('S.isOpen()'))) await click(card);
  await L.waitFor('document.querySelector(".lsp") && !document.querySelector(".lsp").hidden && document.querySelectorAll(".lsp-plays li").length > 0', 15000);
  check(mock.hits.some((h) => /summary\?event=401892522$/.test(h)), 'the game page read the summary from the mock', mock.hits.slice(-3));
  check((await txt('.lsp-score')).replace(/\s/g, '') === '2\u20133' && /1:48 - 2nd/.test(await txt('.lsp-hero-st')) && /Live/.test(await txt('.lsp-hero-st')), 'game page: the live score and the period clock', [await txt('.lsp-score'), await txt('.lsp-hero-st')]);
  check(await count('.lsp-lines tbody tr') === 2 && /1st/.test(await txt('.lsp-lines thead')) && /2nd/.test(await txt('.lsp-lines thead')), 'game page: period scores');
  const secs = await L.ev('[].slice.call(document.querySelectorAll(".lsp-sec > h3")).map(function(h){return h.firstChild.textContent})');
  check(['By period', 'Scoring', 'Penalties', 'Goalies', 'Team stats'].every((s) => secs.indexOf(s) !== -1), 'game page: by period, scoring, penalties, goalies, team stats', secs);
  check(await count('.lsp-plays li') === 8 && await count('.lsp-tag') >= 2, 'game page: five goals and three penalties, PP/SH tagged', await count('.lsp-plays li'));
  check(/Joey Daccord/.test(await txt('.lsp-sec:nth-of-type(1)')) || (await L.ev('document.body.textContent.indexOf("Joey Daccord")!==-1 && document.body.textContent.indexOf("Sergei Bobrovsky")!==-1')), 'game page: both goalies');
  check(await L.ev('[].slice.call(document.querySelectorAll(".lsp-stat")).some(function(r){return /Shots/.test(r.textContent) && /21/.test(r.textContent) && /27/.test(r.textContent)})'), 'game page: shots 21-27');
  let st = await LS('S._state()');
  check(st.poll === true && st.pollMs === 20000 && /Updates every 20 s/.test(await txt('.lsp-upd')), 'live: it polls every 20 s, only while the page is open', st);
  await both('game-live');

  // 3. Watch this game -> ESPN+ in the player layer
  const wb = await L.ev('(function(){var b=document.querySelector(".lsp-watch .btn.primary");return b?{t:b.textContent,s:b.dataset.service}:null;})()');
  check(wb && wb.s === 'espn' && /ESPN\+/.test(wb.t) && /regional TV|SCRIPPS/.test(await txt('.lsp-watch')), 'Watch this game: ESPN+ first, the regional channel named', [wb, await txt('.lsp-watch')]);
  await click('.lsp-watch .btn.primary');
  let opened = '';
  for (let i = 0; i < 40 && !opened; i++) { try { opened = fs.readFileSync(OPEN_STUB, 'utf8'); } catch (e) { /* not yet */ } if (!opened) await sleep(150); }
  check(/espn\.com\/watch\/player\/_\/id\/0f1e2d3c-sea-fla/.test(opened), "Watch this game asked Lumen to open ESPN's own player for this game", opened);
  let layer = null;
  for (let i = 0; i < 40; i++) { layer = await q.chrome.ev('window.WatchPlayer ? window.WatchPlayer._state() : null').catch(() => null); if (layer && layer.open) break; await sleep(150); }
  let edge = ''; try { edge = fs.readFileSync(EDGE_STUB, 'utf8'); } catch (e) { /* none */ }
  check(layer && layer.open === true && !edge, 'it plays in the player layer, not Edge', { layer: layer && layer.open, edge });
  await q.chrome.ev('window.WatchPlayer && window.WatchPlayer.close(), 1').catch(() => 0);
  await sleep(500);

  // 4. A goal while it is open (the next poll), then Final: three stars, polling stops
  mock.game = 'live2';
  await L.waitFor('(document.querySelector(".lsp-score")||{}).textContent.replace(/\\s/g,"")==="2\u20134"', 30000);
  check(await count('.lsp-plays li') === 9, 'live: the next poll brought the new goal (2-4) without a reload');
  mock.game = 'final';
  await L.waitFor('/Final/.test((document.querySelector(".lsp-hero-st")||{}).textContent||"") && document.querySelectorAll(".lsp-stars li").length===3', 30000);
  st = await LS('S._state()');
  check(st.poll === false && st.pollMs === null, 'Final: the polling stopped', st);
  check(/M\. Tkachuk/.test(await txt('.lsp-stars')) && /\.905 SV%/.test(await txt('.lsp-stars')) && !(await vis('.lsp-watch')), 'Final: the three stars (NHL feed), no watch block', await txt('.lsp-stars'));
  await both('game-final');

  // 5. A postponed game
  await L.ev('window.__lumenOpenGame("nhl","401892515"), 1');
  await L.waitFor('/postponed/i.test((document.querySelector(".lsp-state.warn")||{}).textContent||"")', 15000);
  check(/Postponed/.test(await txt('.lsp-hero-st')) && (await LS('S._state().pollMs')) === null, 'postponed: said, and nothing polls');
  await L.ev('window.LumenSports.close(), 1');

  // 6. Favourites: the picker -> FLA -> My teams row, Live now led by his game
  await L.ev('window.LumenSports.openPicker("nhl"), 1');
  await L.waitFor('document.querySelectorAll(".lsp-pick").length === 20', 15000);
  await both('picker');
  await clickText('.lsp-pick', '/Florida Panthers/');
  await L.waitFor('window.LumenSports._state().favs === 1 && document.querySelector(".lsp-minec")', 15000);
  check(/Florida Panthers/.test(await txt('.lsp-mine')), 'picker: Florida Panthers is now one of his teams');
  await L.ev('window.LumenSports.close(), 1');
  await L.waitFor('!!document.querySelector(\'.lrow[data-key="myteams"] .lsp-tc .lsp-tc-r\') && !/Reading/.test(document.querySelector(\'.lrow[data-key="myteams"]\').textContent)', 15000);
  k = await keys();
  const myTxt = await txt('.lrow[data-key="myteams"] .lsp-tc');
  check(k.indexOf('myteams') !== -1 && /Next/.test(myTxt) && /Last/.test(myTxt) && /L 2\u20133 OT/.test(myTxt), 'My teams row: next game and time, last result', [k, myTxt]);
  const firstLive = await L.ev('(document.querySelector(\'.lrow[data-key="sports"] .gc\')||{}).dataset.key');
  check(firstLive === fla.id, "Live now: his team's game first", firstLive);
  await L.ev('window.__applyWatch(' + JSON.stringify(quiet) + '), 1');
  await sleep(500);
  k = await keys();
  check(k[0] === 'sports', "his team live (no national TV): Live now still leads", k);
  await L.ev('(function(){var r=document.querySelector(\'.lrow[data-key="myteams"]\');var i=[].indexOf.call(r.parentNode.children,r);return 1;})()');
  await both('rows');

  // 7. The team page from the My teams card
  await click('.lrow[data-key="myteams"] .lsp-tc'); await sleep(250); if (!(await LS('S.isOpen()'))) await click('.lrow[data-key="myteams"] .lsp-tc');
  await L.waitFor('document.querySelectorAll(".lsp-sched-r").length === 7', 15000);
  const sched = await txt('.lsp-sched');
  check(/W 4\u20132/.test(await txt('.lsp-body')) && /Postponed/.test(await txt('.lsp-body')) && /My team/.test(await txt('.lsp-fav')), 'team page: the schedule with results, the postponed game, his star', sched.slice(0, 200));
  check(await count('.lsp-tile') >= 2, 'team page: next game and last result tiles');
  await both('team');
  // the off-season
  await L.ev('window.LumenSports.openTeam({league:"nhl",id:"10",abbr:"MTL",name:"Montreal Canadiens"}), 1');
  await L.waitFor('/Off-season/.test((document.querySelector(".lsp-body")||{}).textContent||"")', 15000);
  check(true, 'team page: the off-season is said');
  await L.ev('window.LumenSports.close(), 1');

  // 8. Standings, the wild card, a failed read
  await L.ev('window.LumenSports.openStandings("nhl"), 1');
  await L.waitFor('document.querySelectorAll(".lsp-stand").length === 4', 15000);
  check(await count('.lsp-stand tr.mine') === 1 && /Atlantic Division/.test(await txt('.lsp-body')), 'standings: NHL by division, his team marked');
  await both('standings');
  await clickText('.lsp-seg .lsp-tab', '/Wild card/');
  await L.waitFor('document.querySelectorAll(".lsp-stand tr.cut").length === 2', 5000);
  check(/NYR/.test(await L.ev('(function(){var t=[].slice.call(document.querySelectorAll(".lsp-st")).filter(function(s){return /Wild card/.test(s.querySelector("h4").textContent)})[0];return t?t.querySelector("tbody tr .ab").textContent:"";})()')), 'wild card: the race with the cut line, NYR ahead on games played');
  await both('wildcard');
  await clickText('.lsp-tabs .lsp-tab', '/^NBA$/');
  await L.waitFor('/HTTP 503/.test((document.querySelector(".lsp-state.err")||{}).textContent||"")', 15000);
  check(await L.ev('!!document.querySelector(".lsp-state.err button")'), 'a failed read: the reason (HTTP 503) and Retry');
  await shot('error', 1536, 800);
  await L.ev('window.LumenSports.close(), 1');

  // 9. A score pin's click opens the game page in Lumen
  mock.game = 'live';
  const pinBtn = '.lrow[data-key="sports"] .gw .spb';
  const pinned = await L.ev('(function(){var b=[].slice.call(document.querySelectorAll(' + JSON.stringify(pinBtn) + ')).filter(function(b){return b._key==="nhl:401892522"})[0];if(!b)return false;b.click();return true;})()');
  let cardT = null;
  for (let i = 0; i < 100 && pinned && !cardT; i++) { cardT = (await q.targets()).find((x) => x.type === 'page' && /score-pin\.html/.test(x.url)); if (!cardT) await sleep(150); }
  if (cardT) {
    const c = await new Cdp(cardT.webSocketDebuggerUrl).open();
    await c.ev('window.api && window.api.open && window.api.open(), 1');
    c.close();
    await L.waitFor('window.LumenSports.isOpen() && /SEA at FLA/.test((document.querySelector(".lsp-crumbs")||{}).textContent||"")', 15000).catch(() => false);
  }
  check(!!cardT && (await LS('S.isOpen()')) && /SEA at FLA/.test(await txt('.lsp-crumbs')), "a score pin's click opens its game page in Lumen", { pinned, card: !!cardT });

  const own = mock.hits.length;
  check(own > 0, 'every sports read went to the local mock (' + own + ' requests)');
  await q.quit();
  server.close();
});
