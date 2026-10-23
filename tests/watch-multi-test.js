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

// watch-player-yt.js move() (r64): Up next / a title opened while a YouTube video plays moves the page in place
// (YouTube's own in-page move) instead of reloading it; anything the page doesn't take loads the old way, said.
(async () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  const W = 'https://www.youtube.com/watch?v=';
  const slot = (answer) => {
    const s = { service: 'youtube', multi: false, asked: [] };
    s.view = { executeJavaScript: (code) => { s.asked.push(code); return answer(); } };
    return s;
  };
  const ctxFor = () => { const c = { loads: [] }; c.load = (s, u, ref) => c.loads.push([u, ref]); return c; };
  const quiet = console.warn; console.warn = () => {};
  try {
    let c = ctxFor(), s = slot(() => Promise.resolve('ok'));
    check(YT.pageMove(c, s, W + 'aqz-KE-bpKQ', W + 'jNQXAC9IVRw&t=42s', undefined) === true && /"jNQXAC9IVRw",42,/.test(s.asked[0] || ''), 'move: a watch page to another video asks the page (the id and the start time)', s.asked[0] && s.asked[0].slice(-40));
    await tick();
    check(c.loads.length === 0 && YT._state().lastMove.how === 'in-page' && YT._state().lastMove.id === 'jNQXAC9IVRw', 'move: YouTube took it: no reload', { loads: c.loads, last: YT._state().lastMove });
    c = ctxFor(); s = slot(() => Promise.resolve('no YouTube app on the page'));
    YT.pageMove(c, s, W + 'aqz-KE-bpKQ', W + 'jNQXAC9IVRw', undefined);
    await tick();
    check(c.loads.length === 1 && c.loads[0][0] === W + 'jNQXAC9IVRw' && YT._state().lastMove.how === 'reload' && /no YouTube app/.test(YT._state().lastMove.why), 'move: refused: the page loads the old way, and the reason is kept', { loads: c.loads, last: YT._state().lastMove });
    c = ctxFor(); s = slot(() => Promise.reject(new Error('gone')));
    YT.pageMove(c, s, W + 'aqz-KE-bpKQ', W + 'jNQXAC9IVRw', undefined);
    await tick();
    check(c.loads.length === 1 && /did not answer/.test(YT._state().lastMove.why), 'move: the page failed to answer: it loads', YT._state().lastMove);
    c = ctxFor(); s = slot(() => new Promise(() => {}));
    YT.pageMove(c, s, W + 'aqz-KE-bpKQ', W + 'jNQXAC9IVRw', undefined);
    await tick(1300);
    check(c.loads.length === 1 && /did not answer in/.test(YT._state().lastMove.why), 'move: a page that never answers loads after a bounded wait', YT._state().lastMove);
    let later = null;
    c = ctxFor(); s = slot(() => new Promise((r) => { later = r; }));
    YT.pageMove(c, s, W + 'aqz-KE-bpKQ', W + 'jNQXAC9IVRw', undefined);
    s._ytMove++;   // another title opened meanwhile
    later('no YouTube app on the page');
    await tick();
    check(c.loads.length === 0, 'move: a late answer for an older move loads nothing', c.loads);
    c = ctxFor(); s = slot(() => Promise.resolve('ok'));
    const no = [
      ['the same video again', W + 'aqz-KE-bpKQ', W + 'aqz-KE-bpKQ&t=10s', undefined],
      ['to the embed (a Referer)', W + 'aqz-KE-bpKQ', 'https://www.youtube.com/embed/jNQXAC9IVRw', 'https://example.org/'],
      ['from a channel page', 'https://www.youtube.com/@x', W + 'jNQXAC9IVRw', undefined],
      ['to a Short', W + 'aqz-KE-bpKQ', 'https://www.youtube.com/shorts/jNQXAC9IVRw', undefined],
    ];
    for (const [what, from, to, ref] of no) check(YT.pageMove(c, s, from, to, ref) === undefined && s.asked.length === 0, 'move: not in place, ' + what + ' (the old load)');
    s.multi = true;
    check(YT.pageMove(c, s, W + 'aqz-KE-bpKQ', W + 'jNQXAC9IVRw', undefined) === undefined, 'move: not in place in a multiview tile (the embed)');

    // The move script itself (the code pageMove hands the page), run on a stand-in page: it acts only on a page
    // still on the video Lumen moves FROM (a script Electron held until a load ended may run in a newer document).
    c = ctxFor(); s = slot(() => new Promise(() => {}));
    YT.pageMove(c, s, W + 'aqz-KE-bpKQ', W + 'jNQXAC9IVRw&t=42s', undefined);
    const code = s.asked[0] || '';
    check(/\("aqz-KE-bpKQ","jNQXAC9IVRw",42,\d+\)$/.test(code), 'move: the script is told the video it moves from, then the next one', code.slice(-50));
    const runMove = (v) => {
      const sent = [];
      const ls = {};
      const app = { dispatchEvent: (e) => { sent.push(e.detail && e.detail.endpoint && e.detail.endpoint.watchEndpoint.videoId); (ls['yt-navigate-start'] || []).forEach((f) => f()); return true; } };
      const page = {
        location: { pathname: '/watch', search: '?v=' + v + '&list=x' },
        document: { querySelector: (q) => (q === 'ytd-app' ? app : null) },
        window: { addEventListener: (n, f) => { (ls[n] = ls[n] || []).push(f); }, removeEventListener: (n, f) => { ls[n] = (ls[n] || []).filter((g) => g !== f); } },
        CustomEvent: function (n, o) { this.type = n; this.detail = o && o.detail; },
        URLSearchParams, Promise, setTimeout, String,
      };
      return vm.runInNewContext(code, page).then((r) => ({ r, sent }));
    };
    const elsewhere = await runMove('dQw4w9WgXcQ');
    check(elsewhere.r === 'not the video Lumen moved from' && elsewhere.sent.length === 0, 'move script: a page on another video answers so and fires no move there', elsewhere);
    const onA = await runMove('aqz-KE-bpKQ');
    check(onA.r === 'ok' && onA.sent.length === 1 && onA.sent[0] === 'jNQXAC9IVRw', 'move script: the page still on the video it moves from fires YouTube\'s move to the next', onA);

    // A move YouTube took must land, and any newer load of the slot ends a pending move. The scenarios share one
    // wait past the landing check (4 s); each has its own slot and layer, so each is judged on its own loads.
    // The layer's real loadInto (watch-player.js): the load every reuse and every fallback goes through.
    const wpSrc = fs.readFileSync(path.join(ROOT, 'watch-player.js'), 'utf8');
    const li = wpSrc.indexOf('function loadInto(s, u, ref) {');
    let end = -1;
    for (let i = wpSrc.indexOf('{', li), depth = 0; li !== -1 && i < wpSrc.length; i++) {
      if (wpSrc[i] === '{') depth++;
      else if (wpSrc[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    const lctx = vm.createContext({});
    vm.runInContext(wpSrc.slice(li, end), lctx, { filename: 'watch-player.js loadInto' });
    const loadInto = lctx.loadInto;
    check(typeof loadInto === 'function', 'watch-player.js loadInto runs on its own (the unit below uses the real one)');
    const reuse = wpSrc.slice(wpSrc.indexOf('var from = one.url'), wpSrc.indexOf("X('pageMove', one"));
    check(/one\._ytMove = \(one\._ytMove \|\| 0\) \+ 1;/.test(reuse), 'watch-player.js reuse: an open supersedes a pending move before pageMove is asked');
    // A slot whose view records its loads and can say its address and its in-page moves (a <webview>'s).
    const live = (answer, url) => {
      const s = slot(answer);
      const ls = {};
      Object.assign(s.view, {
        url, loads: [],
        getURL: () => s.view.url,
        loadURL: (u) => { s.view.loads.push(u); s.view.url = u; return Promise.resolve(); },
        setAttribute: () => {},
        addEventListener: (n, f) => { (ls[n] = ls[n] || []).push(f); },
        removeEventListener: (n, f) => { ls[n] = (ls[n] || []).filter((g) => g !== f); },
        emit: (n, e) => (ls[n] || []).slice().forEach((f) => f(e)),
        heard: (n) => (ls[n] || []).length,
      });
      return s;
    };
    const layer = () => { const c = { loads: [], notes: [] }; c.load = (s, u, ref) => { c.loads.push(u); loadInto(s, u, ref); }; c.note = (t) => c.notes.push(t); return c; };
    const A = W + 'aqz-KE-bpKQ', B = W + 'jNQXAC9IVRw';
    // 2 (first: lastMove is the newest move's). Taken and landed: the page's own in-page move names B
    //    (did-navigate-in-page), at once.
    const c2 = layer(), s2 = live(() => Promise.resolve('ok'), A);
    YT.pageMove(c2, s2, A, B, undefined);
    await tick();
    check(s2.view.heard('did-navigate-in-page') === 1, 'move: a taken move listens for its landing', s2.view.heard('did-navigate-in-page'));
    s2.view.url = B; s2.view.emit('did-navigate-in-page', { url: B, isMainFrame: true });
    const landedRec = YT._state().lastMove;
    check(landedRec && landedRec.how === 'in-page' && landedRec.landed === true && s2.view.heard('did-navigate-in-page') === 0, 'move: the page names the next video: landed, and the listener is gone', landedRec);
    // 1. YouTube took the move ('ok') but the page stays on A (the move died on the way): B loads, said.
    const c1 = layer(), s1 = live(() => Promise.resolve('ok'), A);
    YT.pageMove(c1, s1, A, B, undefined);
    // 3. Taken, and the address names B when the check runs (no event heard): landed, nothing loads.
    const c3 = layer(), s3 = live(() => Promise.resolve('ok'), A);
    YT.pageMove(c3, s3, A, B, undefined);
    // 4. A page that never answers, then a channel opened on the same slot (the reuse's loadInto): the old
    //    move's fallback timer must not load B over the channel.
    const c4 = layer(), s4 = live(() => new Promise(() => {}), A);
    YT.pageMove(c4, s4, A, B, undefined);
    loadInto(s4, 'https://www.youtube.com/@channel');
    // 5. Taken, still moving, then the same video again (the reuse's loadInto): the landing check loads nothing.
    const c5 = layer(), s5 = live(() => Promise.resolve('ok'), A);
    YT.pageMove(c5, s5, A, B, undefined);
    await tick();
    s3.view.url = B + '&pp=x';
    loadInto(s5, A + '&t=5s');
    await tick(1300);
    check(c1.loads.length === 0, 'move: a taken move is given time to land (no load at 1.3 s)', c1.loads);
    check(s4.view.loads.length === 1 && s4.view.loads[0] === 'https://www.youtube.com/@channel' && c4.loads.length === 0 && c4.notes.length === 0, 'move: a newer load on the slot: the old move\'s fallback never loads its video over it', { view: s4.view.loads, layer: c4.loads });
    await tick(3000);
    check(c1.loads.length === 1 && c1.loads[0] === B && s1.view.loads[0] === B, 'move: taken but the page stayed on the last video: the next one loads the old way', { loads: c1.loads, view: s1.view.loads });
    check(c1.notes.length === 1 && c1.notes[0] === 'Loading the next video the slow way: YouTube started the move but stayed on the last video', 'move: that fallback is said in the bar, with its reason', c1.notes);
    check(c2.loads.length === 0 && c2.notes.length === 0 && s2.view.loads.length === 0, 'move: landed: no load and no note after the check', { loads: c2.loads, notes: c2.notes });
    check(c3.loads.length === 0 && c3.notes.length === 0 && s3.view.loads.length === 0, 'move: the address names the next video at the check: no load', { loads: c3.loads, notes: c3.notes });
    check(c5.loads.length === 0 && c5.notes.length === 0 && s5.view.loads.length === 1 && s5.view.loads[0] === A + '&t=5s', 'move: the same video opened again while a move was landing: that load stands, the landing check loads nothing', { loads: c5.loads, view: s5.view.loads });
    // The refusals are said in the bar too (not only the console and lastMove).
    const c6 = layer(), s6 = live(() => Promise.resolve('no YouTube app on the page'), A);
    YT.pageMove(c6, s6, A, B, undefined);
    await tick();
    check(c6.notes.length === 1 && c6.notes[0] === 'Loading the next video the slow way: no YouTube app on the page' && s6.view.loads[0] === B, 'move: a refused move says why in the bar and loads the old way', c6.notes);
  } finally { console.warn = quiet; }
  console.log('watch-multi-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
