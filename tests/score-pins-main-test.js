// tests/score-pins-main-test.js -- score-pins-main.js with a FAKE Electron (windows, IPC, screen) and a fake
// fetch serving tests/scores-fixtures/: no window, no network. The real-window half is score-pins-e2e.js.
//
//   node tests/score-pins-main-test.js
//
// Covers: nothing created or armed with nothing pinned; a pin opens one card (frameless, focusable:false,
// alwaysOnTop, skipTaskbar, show:false then showInactive, sandboxed, contextIsolation, in-memory partition,
// muted in a test); the NHL id lookup then the landing; the cadence after each read; a failure's words and
// back-off; an NHL-only failure falling back to ESPN; Final stopping the timer; the stack's geometry; a drag
// saving a place; the saved file and a restore (old games dropped); the global sound and per-card mute;
// the Lumen page's console lines (only from OUR watch.html); the chrome IPC refusing other senders; a card
// opening its gamecast (open-url, never Edge); the main window closing every card; and the
// re-pin of a pinned game. One line: "score-pins-main-test: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 400)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIX = path.join(__dirname, 'scores-fixtures');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n + '.json'), 'utf8'));

/* ---- fake Electron ------------------------------------------------------------------------------- */
let nextId = 1;
const windows = [];
class FakeContents extends EventEmitter {
  constructor(win) { super(); this.id = nextId++; this.win = win; this.sent = []; this.muted = false; this.url = ''; this.destroyed = false; }
  send(ch, payload) { this.sent.push([ch, JSON.parse(JSON.stringify(payload))]); }
  setAudioMuted(m) { this.muted = m; }
  isAudioMuted() { return this.muted; }
  isCurrentlyAudible() { return false; }
  setWindowOpenHandler() {}
  getOSProcessId() { return 4242; }
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; }
}
class FakeWindow extends EventEmitter {
  constructor(opts) {
    super(); this.opts = opts; this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
    this.webContents = new FakeContents(this); this.shown = false; this.destroyed = false; this.top = false; this.level = '';
    windows.push(this);
  }
  setAlwaysOnTop(on, level) { this.top = on; this.level = level; }
  isAlwaysOnTop() { return this.top || !!this.opts.alwaysOnTop; }
  isFocusable() { return this.opts.focusable !== false; }
  isFocused() { return false; }
  isVisible() { return this.shown; }
  isDestroyed() { return this.destroyed; }
  getBounds() { return Object.assign({}, this.bounds); }
  setBounds(b) { this.bounds = Object.assign({}, b); }
  setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; }
  showInactive() { this.shown = true; }
  loadURL(u) { this.webContents.url = u; setImmediate(() => this.emit('ready-to-show')); return Promise.resolve(); }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.webContents.destroyed = true; this.emit('closed'); }
}
class FakeIpc {
  constructor() { this.handlers = {}; this.listeners = {}; }
  handle(ch, fn) { this.handlers[ch] = fn; }
  on(ch, fn) { this.listeners[ch] = fn; }
  invoke(ch, sender, ...a) { return this.handlers[ch]({ sender }, ...a); }
  emit(ch, sender, ...a) { return this.listeners[ch]({ sender }, ...a); }
}
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'score-pins-main-test-'));
const app = new EventEmitter();
app.getPath = () => userData;
let ready = null;
app.whenReady = () => new Promise((r) => { ready = r; });
app.getAppMetrics = () => [];
const AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const screen = { getPrimaryDisplay: () => ({ workArea: AREA }), getAllDisplays: () => [{ workArea: AREA }] };
const power = new EventEmitter();
const mainWin = new EventEmitter();
mainWin.isDestroyed = () => false; mainWin.isMinimized = () => false; mainWin.show = () => { mainWin.shownCount = (mainWin.shownCount || 0) + 1; }; mainWin.focus = () => {};

/* ---- fake feeds ---------------------------------------------------------------------------------- */
const feed = { mode: 'ok', nhlDown: false, hits: [], landing: fx('nhle-landing') };
global.fetch = async (url) => {
  feed.hits.push(url);
  const body = (code, j) => ({ ok: code === 200, status: code, text: async () => (typeof j === 'string' ? j : JSON.stringify(j)) });
  if (feed.mode === 'timeout') { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
  if (feed.mode === 'down') return body(503, '{}');
  if (/api-web\.nhle\.com\/v1\/score\//.test(url)) return feed.nhlDown ? body(502, '{}') : body(200, fx('nhle-score'));
  if (/api-web\.nhle\.com\/v1\/gamecenter\/2026020124\/landing/.test(url)) return feed.nhlDown ? body(502, '{}') : body(200, feed.landing);
  if (/hockey\/nhl\/scoreboard\/401892522$/.test(url)) return body(200, fx('espn-nhl-event'));
  if (/football\/college-football\/scoreboard\/401856719$/.test(url)) return body(200, fx('espn-cfb-event'));
  return body(404, '{}');
};

const sentToChrome = [];
const logs = [];
const ipc = new FakeIpc();
const chromeSender = { id: 'chrome' };
const opened = [];
const Pins = require('../score-pins-main');
function make(test) {
  return Pins.create({
    app, ipcMain: ipc, BrowserWindow: FakeWindow, screen, powerMonitor: power, test,
    isChromeSender: (e) => e.sender === chromeSender,
    send: (ch, p) => { sentToChrome.push([ch, p]); if (ch === 'open-url') opened.push(p); },
    getWindow: () => mainWin,
    getGames: () => [{ id: 'espn:401892522', league: 'nhl', leagueName: 'NHL', state: 'in', startsAt: Date.parse('2026-10-17T23:00Z'), detail: 'End of 1st', away: { abbr: 'SEA', name: 'Kraken', logo: '', score: '1' }, home: { abbr: 'FLA', name: 'Panthers', logo: '', score: '3' }, gamecastUrl: 'https://www.espn.com/nhl/game/_/gameId/401892522' }],
    log: (l) => logs.push(l),
  });
}
const NHL_GAME = { id: 'espn:401892522', league: 'nhl', startsAt: Date.now() - 3600e3, away: { abbr: 'SEA', name: 'Kraken', logo: 'https://a.espncdn.com/sea.png' }, home: { abbr: 'FLA', name: 'Panthers' }, url: 'https://www.espn.com/watch/player?id=999' };
const CFB_GAME = { id: '401856719', league: 'cfb', startsAt: Date.now() - 3600e3, away: { abbr: 'AUB', name: 'Auburn' }, home: { abbr: 'UGA', name: 'Georgia' } };
const lastState = (w) => { const s = w.webContents.sent.filter((x) => x[0] === 'scorepin:state'); return s.length ? s[s.length - 1][1] : null; };
const cardOf = (key) => windows.filter((w) => !w.destroyed && decodeURIComponent(w.webContents.url).indexOf('key=' + key) !== -1)[0];

(async () => {
  const P = make({ offscreen: false, silent: true, pollScale: 0.01 });
  ready();
  await sleep(2700);   // the restore delay (2.5 s) with an empty file
  check(windows.length === 0 && feed.hits.length === 0 && power.listenerCount('resume') === 0, 'nothing pinned: no window, no fetch, no power listener', { w: windows.length, hits: feed.hits.length });

  // Pin from the chrome (the palette path).
  check((await ipc.invoke('scores:pin', { id: 'evil' }, NHL_GAME)).reason === 'not allowed', 'the chrome IPC refuses any other sender');
  const r = await ipc.invoke('scores:pin', chromeSender, NHL_GAME);
  check(r.ok && r.key === 'nhl:401892522', 'pin: ok with its key', r);
  const w = cardOf('nhl:401892522');
  const o = w.opts;
  check(o.frame === false && o.focusable === false && o.alwaysOnTop === true && o.skipTaskbar === true && o.show === false && o.resizable === false, 'card window: frameless, never focusable, on top, no taskbar, created hidden', o);
  check(o.webPreferences.contextIsolation === true && o.webPreferences.sandbox === true && o.webPreferences.nodeIntegration === false && o.webPreferences.partition === 'scorepins' && /score-pin-preload\.js$/.test(o.webPreferences.preload), 'card window: sandboxed, isolated, its own preload, in-memory session');
  check(w.webContents.muted === true && /silent=1/.test(w.webContents.url), 'TEST SILENCE: muted before load and the page told to run silent');
  await sleep(30);
  check(w.shown === true && w.level === 'floating', 'shown with showInactive, always-on-top floating');
  ipc.emit('scorepin:ready', w.webContents);
  await sleep(80);
  let s = P.state().pins[0];
  check(s.nhlId === '2026020124' && feed.hits.some((u) => /v1\/score\/2026-10-17/.test(u)) && feed.hits.some((u) => /landing/.test(u)), 'NHL: the game id looked up once, then the landing read', feed.hits);
  check(s.reading && s.reading.source === 'nhl' && s.reading.phase === 'break' && s.timer === true, 'read, and the next poll armed', s.reading);
  const st0 = lastState(w);
  check(st0 && st0.reading && st0.reading.home.score === 3 && st0.events.length === 0 && st0.sound === true && st0.muted === false, 'the card got the reading, no events (history is never replayed)', st0 && st0.events);
  check(P.state().pins[0].bounds.x === 1920 - 16 - 300 && P.state().pins[0].bounds.y + P.state().pins[0].bounds.height === 1040 - 16, 'the card sits in the bottom-right corner, 16 px in', P.state().pins[0].bounds);
  const pinsFile = path.join(userData, Pins.PREFS_FILE);
  await sleep(500);
  const saved = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
  check(saved.pins.length === 1 && saved.pins[0].nhlId === '2026020124' && saved.pins[0].url === 'https://www.espn.com/nhl/game/_/gameId/401892522', 'saved: the pin, its NHL id and the gamecast (not the Edge player URL)', saved);
  check(sentToChrome.some((x) => x[0] === 'scores:changed'), 'the chrome is told the pins changed');

  // A goal arrives on the next poll.
  const live = JSON.parse(JSON.stringify(fx('nhle-landing')));
  live.clock.inIntermission = false; live.awayTeam.score = 2;
  live.summary.scoring[0].goals.push({ eventId: 999, strength: 'pp', lastName: { default: 'Wright' }, teamAbbrev: { default: 'SEA' }, goalsToDate: 4, timeInPeriod: '02:00', isHome: false, goalModifier: 'none' });
  feed.landing = live;
  await sleep(700);
  const st1 = w.webContents.sent.filter((x) => x[0] === 'scorepin:state').map((x) => x[1]).find((x) => x.events.length);
  check(st1 && st1.events[0].strip === 'GOAL · SEA · Wright (4) · PP', 'the next poll carries the goal event', st1 && st1.events);

  // Failure: timeout -> words + back-off; then recovery.
  feed.mode = 'timeout';
  await sleep(400);
  s = P.state().pins[0];
  check(s.failures >= 1 && s.health.ok === false && /^Scores paused: the NHL and ESPN didn't answer \(timed out after 10 s; timed out after 10 s\), retrying in \d+ s$/.test(s.health.text), 'a timeout: the card is told what failed and when it retries', s.health);
  check(logs.some((l) => /Scores paused/.test(l)), 'the failure is logged');
  feed.mode = 'ok';
  await sleep(2600);
  s = P.state().pins[0];
  check(s.failures === 0 && s.health.ok === true, 'recovered after the feed came back', s.health);
  // NHL only down: ESPN keeps the score, the card says penalties are paused.
  feed.nhlDown = true;
  await sleep(500);
  s = P.state().pins[0];
  check(s.health.ok === true && s.health.partial === true && /^Penalties paused: the NHL's feed didn't answer \(HTTP 502\)\. Score from ESPN, retrying in \d+ s$/.test(s.health.text) && s.reading.source === 'espn', 'NHL down, ESPN up: score from ESPN, penalties paused, said so', s.health);
  feed.nhlDown = false;
  await sleep(500);

  // A second pin stacks above the first? No: newest lowest; the first moves up.
  await ipc.invoke('scores:pin', chromeSender, CFB_GAME);
  const w2 = cardOf('cfb:401856719');
  await sleep(30);
  ipc.emit('scorepin:ready', w2.webContents);
  ipc.emit('scorepin:height', w2.webContents, 120);
  await sleep(60);
  const [a1, a2] = P.state().pins.map((x) => x.bounds);
  check(a2.y + a2.height === 1040 - 16 && a2.height === 120 && a1.y + a1.height === a2.y - 8 && a1.x === a2.x, 'two cards stack: newest at the corner, 8 px apart, each its own height', [a1, a2]);
  check((await ipc.invoke('scores:pin', chromeSender, NHL_GAME)).already === true && lastState(w).flash === true, 're-pinning a pinned game flashes its card, no second card');

  // Drag the first card; it leaves the stack and keeps its place.
  ipc.emit('scorepin:drag', w.webContents, { phase: 'start', dx: 0, dy: 0 });
  ipc.emit('scorepin:drag', w.webContents, { phase: 'move', dx: -500, dy: -400 });
  ipc.emit('scorepin:drag', w.webContents, { phase: 'end', dx: -600, dy: -500 });
  s = P.state().pins[0];
  check(s.pos && s.pos.x === a1.x - 600 && s.pos.y === a1.y - 500, 'a drag moves the card and saves its place', s.pos);
  const b2 = P.state().pins[1].bounds;
  check(b2.y + b2.height === 1040 - 16, 'the other card stays in the corner');
  ipc.emit('scorepin:drag', w2.webContents, { phase: 'start' });
  ipc.emit('scorepin:drag', w2.webContents, { phase: 'end', dx: 99999, dy: 0 });
  check(P.state().pins[1].pos === null && P.state().pins[1].bounds.x === 1920 - 16 - 300, 'a card dropped off every screen goes back to the stack');

  // Sound switches.
  ipc.emit('scorepin:mute', w.webContents, true);
  check(P.state().pins[0].muted === true && lastState(w).muted === true, "a card's mute is kept and sent back to it");
  await ipc.invoke('scores:set-sound', chromeSender, false);
  check(lastState(w).sound === false && lastState(w2).sound === false, 'the global switch reaches every card');
  const games = await ipc.invoke('scores:games', chromeSender);
  check(games.games.length === 1 && games.games[0].key === 'nhl:401892522' && games.pinned.length === 2 && games.sound === false, "the palette's list: Lumen's games, the pinned keys, the switch", games);
  await ipc.invoke('scores:set-sound', chromeSender, true);

  // The Lumen page's console lines: only from OUR watch.html.
  const page = new FakeContents(null);
  page.isDestroyed = () => false;
  page.getType = () => 'webview';
  const js = [];
  page.executeJavaScript = (code) => { js.push(code); return Promise.resolve(); };
  page.url = 'https://evil.example/watch.html';
  check(P.handleLine(page, 'quartz-scores:unpin {"key":"cfb:401856719"}') === false && P.state().pins.length === 2, 'a line from any other page is ignored');
  page.url = pathToFileURL(path.join(__dirname, '..', 'watch.html')).href + '?theme=dark';
  check(P.handleLine(page, 'quartz-scores:hello {}') === true && /__applyScorePins\(\["nhl:401892522","cfb:401856719"\]\)/.test(js[js.length - 1]), "hello from Lumen's page: it gets the pinned keys", js[js.length - 1]);
  check(P.handleLine(page, 'quartz-scores:pin {"game":{"id":"x","league":"nhl"}}') === true && /__scorePinFailed/.test(js.join('\n')), 'a bad pin from the page is refused out loud', js);
  P.handleLine(page, 'quartz-scores:unpin {"key":"cfb:401856719"}');
  check(P.state().pins.length === 1 && w2.destroyed === true, 'unpin from the page closes that card');

  // Open the game: a Quartz tab with the gamecast, Quartz forward.
  ipc.emit('scorepin:open', w.webContents);
  check(opened.length === 1 && opened[0].url === 'https://www.espn.com/nhl/game/_/gameId/401892522' && opened[0].background === false && mainWin.shownCount === 1, 'clicking a card opens its gamecast in a Quartz tab (never Edge)', opened);
  check(P.openGame('https://www.espn.com/watch/player?id=1').ok === false && P.openGame('https://evil.example/').ok === false, 'openGame refuses the Edge player and other sites');

  // Final stops the timer.
  const fin = JSON.parse(JSON.stringify(live));
  fin.gameState = 'OFF';
  feed.landing = fin;
  await sleep(600);
  s = P.state().pins[0];
  check(s.reading.phase === 'final' && s.timer === false, 'Final: no timer left', s);
  const hits0 = feed.hits.length;
  await sleep(400);
  check(feed.hits.length === hits0, 'Final: no more fetches');

  // Quartz's window closes: cards go, the pin stays saved; a restore brings it back with its place.
  mainWin.emit('closed');
  check(w.destroyed === true && windows.filter((x) => !x.destroyed).length === 0, "Quartz's window closing closes every card");
  const saved2 = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
  check(saved2.pins.length === 1 && saved2.pins[0].muted === true && saved2.pins[0].pos && saved2.pins[0].pos.x === s.pos.x, 'the pin is still saved, with its mute and place', saved2);
  // Restore in a fresh module instance, with one extra stale pin that must be dropped.
  saved2.pins.push(Object.assign({}, saved2.pins[0], { espnId: '401856719', league: 'cfb', key: 'cfb:401856719', startsAt: Date.now() - 20 * 3600e3, pos: null }));
  fs.writeFileSync(pinsFile, JSON.stringify(saved2));
  const app2 = app;  // same fake app; a new ipc so handlers do not collide
  const ipc2 = new FakeIpc();
  const before = windows.length;
  let ready2 = null;
  app2.whenReady = () => new Promise((rr) => { ready2 = rr; });
  const P2 = Pins.create({ app: app2, ipcMain: ipc2, BrowserWindow: FakeWindow, screen, powerMonitor: power, test: { silent: true, pollScale: 0.01, offscreen: false }, isChromeSender: () => true, send: () => {}, getWindow: () => mainWin, log: (l) => logs.push(l) });
  ready2();
  await sleep(2800);
  const rs = P2.state().pins;
  check(rs.length === 1 && rs[0].key === 'nhl:401892522' && rs[0].muted === true && logs.some((l) => /dropped at start: the game began over 16 h ago/.test(l)), 'restore: the pin comes back, a 16 h old one is dropped (and logged)', rs.map((x) => x.key));
  const w3 = windows.slice(before).find((x) => !x.destroyed);
  ipc2.emit('scorepin:ready', w3.webContents);
  await sleep(100);
  check(P2.state().pins[0].bounds.x === s.pos.x && P2.state().pins[0].bounds.y === s.pos.y, 'restore: the dragged card is where it was left');
  check(lastState(w3) && lastState(w3).events.length === 0, 'restore: the first reading replays no events');
  ipc2.emit('scorepin:close', w3.webContents);
  await sleep(500);
  check(P2.state().pins.length === 0 && JSON.parse(fs.readFileSync(pinsFile, 'utf8')).pins.length === 0 && power.listenerCount('resume') === 0, 'the close control drops the pin, the saved entry and the power listeners');
  P2.closeAll();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log('score-pins-main-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL HARNESS ERROR ' + (e && e.stack || e)); console.log('score-pins-main-test: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
