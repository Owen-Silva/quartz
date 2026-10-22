// tests/watch-multi-test.js -- Lumen multiview's pure parts, no Electron, no network:
//   watch-player-multi.js: the YouTube embed address for a tile (and its start time);
//   watch-player-main.js:  the simulated free RAM (test.freeFile), the multiview keys a tile's page
//                          hands over (1-4, F, X, M) and its focus, only in grid mode; CPU in memory().
// One summary line: "watch-multi-test: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined && !cond ? '  ' + JSON.stringify(detail).slice(0, 300) : ''));
}
const ROOT = path.join(__dirname, '..');
const Hosts = require(path.join(ROOT, 'watch-player-hosts'));

/* ---- watch-player-multi.js in a bare window ---------------------------------------------------- */
// A tile's YouTube address is watch-player-yt.js's alone (one path): multi only asks it.
const YT = require(path.join(ROOT, 'watch-player-yt'));
const win = { WatchPlayerHosts: Hosts };
const ctx = vm.createContext({ window: win, document: {}, URL, setTimeout, clearTimeout, Promise, console, JSON, Math, Number, String, Object, Date });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'watch-player-multi.js'), 'utf8'), ctx, { filename: 'watch-player-multi.js' });
const Multi = win.WatchPlayerMulti;
check(!!Multi && typeof Multi.open === 'function' && typeof Multi.layout === 'function', 'watch-player-multi.js loads and exposes its hooks');
check(!('view' in Multi) && !('_withStart' in Multi), 'multi has no Referer or embed address of its own (watch-player-yt.js has them)');
const E = Multi._embedFor;
check(E('https://www.youtube.com/watch?v=abcdefghijk') === '', 'with watch-player-yt.js missing: no embed (the watch page plays as it is)');
win.WatchPlayerYT = YT;
const Q = '?autoplay=1&playsinline=1&rel=0';
check(E('https://www.youtube.com/watch?v=abcdefghijk') === 'https://www.youtube.com/embed/abcdefghijk' + Q, 'a watch page -> its embed');
check(E('https://www.youtube.com/watch?v=abcdefghijk&t=90') === 'https://www.youtube.com/embed/abcdefghijk' + Q + '&start=90', 't=90 -> start=90');
check(E('https://www.youtube.com/watch?v=abcdefghijk&t=1m30s') === 'https://www.youtube.com/embed/abcdefghijk' + Q + '&start=90', 't=1m30s -> start=90');
check(E('https://youtu.be/abcdefghijk?t=5') === 'https://www.youtube.com/embed/abcdefghijk' + Q + '&start=5', 'youtu.be -> www.youtube.com embed');
check(E('https://www.youtube.com/live/abcdefghijk') === 'https://www.youtube.com/embed/abcdefghijk' + Q, 'a /live/ video -> its embed');
check(E('https://www.youtube.com/@channel') === '' && E('https://www.youtube.com/feed/subscriptions') === '' && E('not a url') === '', 'a channel, a feed, junk: no embed (the page plays as it is)');
check(E('https://www.youtube.com/watch?v=<script>') === '', 'a bad id: no embed');
check(E('http://127.0.0.1:5555/watch?v=hiLockupB02') === 'http://127.0.0.1:5555/embed/hiLockupB02' + Q, 'a rebased (test) origin keeps its origin');
check(E('https://www.youtube.com/watch?v=abcdefghijk&t=4', 61.7) === 'https://www.youtube.com/embed/abcdefghijk' + Q + '&start=61', 'a start time given (the single page’s own) replaces the address’s, whole seconds');
check(E('https://www.youtube.com/watch?v=abcdefghijk&t=4', 0) === 'https://www.youtube.com/embed/abcdefghijk' + Q, 'start 0: no start');
for (const u of ['https://www.youtube.com/watch?v=abcdefghijk&t=90', 'https://youtu.be/abcdefghijk', 'http://127.0.0.1:5555/watch?v=hiLockupB02']) {
  check(E(u) === YT.slotUrlFor(u, { service: 'youtube', multi: true }), 'the same embed as the layer’s own slotUrl for a tile: ' + u);
}

/* ---- watch-player-main.js with fakes ------------------------------------------------------------ */
const Main = require(path.join(ROOT, 'watch-player-main'));
function fakes(test) {
  const handlers = {};
  const sent = [];
  const win2 = { isDestroyed: () => false, webContents: { id: 1 }, on() {}, contentView: { addChildView() {}, removeChildView() {} } };
  const guests = new Map();
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const p = Main.create({
    ipcMain,
    app: { getPath: () => os.tmpdir(), getAppMetrics: () => [{ pid: 11, type: 'Browser', memory: { workingSetSize: 102400 }, cpu: { percentCPUUsage: 3, cumulativeCPUUsage: 2.5 } }, { pid: 22, type: 'Tab', memory: { workingSetSize: 204800 }, cpu: { percentCPUUsage: 9, cumulativeCPUUsage: 7.25 } }] },
    webContents: { fromId: (id) => guests.get(id) || null },
    send: (ch, m) => sent.push([ch, m]),
    getWindow: () => win2,
    isChromeSender: () => true,
    dir: os.tmpdir(),
    test,
    log: () => {},
  });
  p.registerIpc();
  const call = (ch, payload) => handlers[ch]({ sender: {} }, payload || {});
  const guest = (id) => {
    const c = new EventEmitter();
    Object.assign(c, { isDestroyed: () => false, getType: () => 'webview', hostWebContents: win2.webContents, setWindowOpenHandler() {}, getOSProcessId: () => 22, loadURL: () => Promise.resolve(), getURL: () => '' });
    guests.set(id, c);
    return c;
  };
  return { p, call, sent, guest };
}

const freeFile = path.join(os.tmpdir(), 'watch-multi-test-free-' + process.pid + '.txt');
try { fs.unlinkSync(freeFile); } catch (e) { /* none */ }
{
  const f = fakes({ freeFile });
  const real = f.call('watch-player:free');
  check(real.freeGb > 0 && real.floorGb === 1.5, 'no file: the real free RAM, and the 1.5 GB floor', real);
  fs.writeFileSync(freeFile, '0.8');
  const low = f.call('watch-player:free');
  check(low.freeGb === 0.8, 'the test file stands in for the free RAM', low);
  fs.writeFileSync(freeFile, 'junk');
  check(f.call('watch-player:free').freeGb === real.freeGb || f.call('watch-player:free').freeGb > 0, 'a junk file: the real number again');
  fs.unlinkSync(freeFile);
  const g = fakes({});
  fs.writeFileSync(freeFile, '0.2');
  check(g.call('watch-player:free').freeGb !== 0.2, 'without test.freeFile the file means nothing (a live Quartz)');
  fs.unlinkSync(freeFile);

  // Keys from a tile's page.
  const c = f.guest(7);
  const r = f.call('watch-player:adopt', { wcId: 7, service: 'youtube', origin: 'https://www.youtube.com' });
  check(r && r.ok, 'a fake guest is adopted', r);
  const key = (k, mods) => { let prevented = false; c.emit('before-input-event', { preventDefault: () => { prevented = true; } }, Object.assign({ type: 'keyDown', key: k }, mods || {})); return prevented; };
  f.sent.length = 0;
  check(!key('x') && !key('m') && !key('1') && f.sent.length === 0, 'single player: X, M and 1 stay the page’s own');
  f.call('watch-player:mode', { mode: 'grid' });
  const got = ['1', '4', 'f', 'F', 'x', 'X', 'm'].map((k) => key(k));
  check(got.every(Boolean), 'multiview: 1, 4, F, X, M are taken from the page', got);
  check(JSON.stringify(f.sent.map((s) => s[1].key)) === JSON.stringify(['1', '4', 'f', 'f', 'x', 'x', 'm']) && f.sent.every((s) => s[0] === 'watch-player:key' && s[1].wcId === 7), 'and handed to the chrome, lower-cased, with the tile', f.sent);
  f.sent.length = 0;
  check(!key('5') && !key('k') && !key('x', { control: true }) && !key('m', { shift: true }) && f.sent.length === 0, 'multiview: 5, K, Ctrl+X, Shift+M stay the page’s own');
  // A tile's text field (a sign-in, a PIN, the search box) keeps 1-4/F/X/M: they were swallowed while he typed.
  let typing = true, asked = 0;
  c.focusedFrame = { executeJavaScript: (code) => { asked++; return { then: (ok) => ok(/activeElement/.test(code) ? typing : null) }; } };
  c.emit('before-input-event', { preventDefault() {} }, { type: 'keyUp', key: 'Tab' });
  const inField = ['1', '4', 'f', 'x', 'm'].map((k) => key(k));
  check(asked === 1 && inField.every((x) => !x) && f.sent.length === 0, 'multiview: typing in a tile’s text field, 1-4/F/X/M stay the page’s own', { asked, inField, sent: f.sent });
  typing = false;
  c.emit('input-event', {}, { type: 'mouseUp' });
  check(asked === 2 && key('1') === true && f.sent.length === 1 && f.sent[0][1].key === '1', 'and once a click takes the focus out of the field, 1 picks the tile again', { asked, sent: f.sent });
  f.sent.length = 0;
  typing = true;
  f.call('watch-player:mode', { mode: 'single' });
  f.call('watch-player:mode', { mode: 'grid' });
  check(asked === 3 && key('x') === false && f.sent.length === 0, 'the switch to multiview asks too (a field already focused keeps X)', { asked, sent: f.sent });
  typing = false;
  c.emit('before-input-event', { preventDefault() {} }, { type: 'keyUp', key: 'Escape' });
  f.sent.length = 0;
  c.emit('focus');
  check(f.sent.length === 1 && f.sent[0][1].key === 'focus' && f.sent[0][1].wcId === 7, 'multiview: a click into a tile (its focus) is told to the chrome', f.sent);
  f.sent.length = 0;
  c.emit('input-event', {}, { type: 'mouseDown' });
  c.emit('input-event', {}, { type: 'mouseMove' });
  check(f.sent.length === 1 && f.sent[0][1].key === 'focus', 'multiview: a mouse-down in a tile is told once (a move is not)', f.sent);
  f.call('watch-player:mode', { mode: 'single' });
  f.sent.length = 0;
  c.emit('focus');
  c.emit('input-event', {}, { type: 'mouseDown' });
  check(f.sent.length === 0, 'single player: focus is not told');

  const mem = f.call('watch-player:memory');
  check(mem.cpuSec === 9.75 && mem.cpuByType.Tab === 7.25 && mem.players[0].cpuSec === 7.25 && mem.players[0].mb === 200, 'memory(): cumulative CPU seconds, per type and per player', mem);
}

console.log('watch-multi-test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
