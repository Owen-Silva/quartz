require('./tools/lowcpu-optional.js');   // first: the CPU cap, when one is configured (tools/lowcpu-optional.js; none on a cloud runner)
// drm-route-e2e.js -- Watch's click routing for protected titles, both ways, in a REAL Quartz
// (castlabs build, off-screen, temp profile). The Watch page asks main to open a title on its own
// channel (the "quartz-watch:open" console line, exactly what a tile click prints), and:
//   ready    QUARTZ_TEST_VMP=signed: the CDM really loads, the signature is taken as EVS-signed
//            -> Disney+, Prime Video, Hulu and the ESPN+ player open in a QUARTZ TAB, Edge untouched.
//   missing  QUARTZ_TEST_CDM=missing: no Widevine -> the same titles go to Edge, and Watch's toast
//            says why ("Widevine is switched off for this test run").
//   real     no override: the test copy as it is (development signature only) -> Edge, and the toast
//            says "this copy of Quartz isn't signed for streaming services yet".
// Edge is NEVER launched: QUARTZ_EDGE_STUB makes drm-main append the URL to a file instead. Watch
// reads nothing (QUARTZ_WATCH_MIN_FREE_GB=99 pauses its readers), and every service address is
// rebased onto a local server, so no real streaming site is ever loaded.
//   node drm-route-e2e.js [--cdp 9431]
// One summary line: "drm-route-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WS = require(path.join(__dirname, 'node_modules', 'ws'));
const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher } = require('./testwatch');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
let CDP_PORT = Number(opt('cdp', '9431'));
const PORT0 = CDP_PORT;
const APP = __dirname;
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>stand-in</title><p>' + String(req.url).replace(/[<&]/g, '') + '</p>');
});
const listen = (srv) => new Promise((r, j) => { srv.once('error', j); srv.listen(0, '127.0.0.1', () => r(srv.address().port)); });

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WS(this.wsUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { this.ws.on('open', r); this.ws.on('error', j); });
    this.ws.on('message', (raw) => { const m = JSON.parse(String(raw)); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m); } });
    return this;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
  async ev(expr) {
    const m = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (m.error) throw new Error(JSON.stringify(m.error));
    if (m.result.exceptionDetails) throw new Error('threw: ' + ((m.result.exceptionDetails.exception || {}).description || m.result.exceptionDetails.text));
    return m.result.result.value;
  }
  async waitFor(expr, ms) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < (ms || 10000)) { try { last = await this.ev(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(100); }
    throw new Error('timed out: ' + expr.slice(0, 160) + ' (last ' + JSON.stringify(last).slice(0, 200) + ')');
  }
  close() { try { this.ws.close(); } catch (e) { /* gone */ } }
}
async function targets() { return (await fetch('http://127.0.0.1:' + CDP_PORT + '/json')).json(); }
async function waitTarget(pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 10000)) {
    try { const t = (await targets()).find(pred); if (t) return t; } catch (e) { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('no such target');
}
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };

const TITLES = [
  ['disney', 'https://www.disneyplus.com/browse/entity-e2e'],
  ['prime', 'https://www.primevideo.com/detail/E2E/'],
  ['hulu', 'https://www.hulu.com/watch/e2e'],
  ['espn', 'https://www.espn.com/watch/player/_/id/e2e'],
];

async function run(mode, port, watcher) {
  const tag = 'drmroute' + mode + process.pid;
  const profileDir = path.join(os.tmpdir(), 'browser-test-profile-' + tag);
  const edgeStub = path.join(os.tmpdir(), 'quartz-' + tag + '-edge.txt');
  const openStub = path.join(os.tmpdir(), 'quartz-' + tag + '-open.txt');
  const base = 'http://127.0.0.1:' + port;
  const env = Object.assign({}, process.env, {
    QUARTZ_EDGE_STUB: edgeStub,
    QUARTZ_WATCH_OPEN_STUB: openStub,
    QUARTZ_WATCH_MIN_FREE_GB: '99',
    QUARTZ_WATCH_REBASE: JSON.stringify([
      ['https://www.disneyplus.com', base + '/disney'], ['https://www.primevideo.com', base + '/prime'],
      ['https://www.hulu.com', base + '/hulu'], ['https://www.espn.com', base + '/espn'],
      ['https://www.youtube.com', base + '/youtube'],
    ]),
  });
  delete env.QUARTZ_TEST_VMP; delete env.QUARTZ_TEST_CDM;
  if (mode === 'ready') env.QUARTZ_TEST_VMP = 'signed';
  if (mode === 'missing') env.QUARTZ_TEST_CDM = 'missing';
  let child = null, chrome = null, g = null;
  CDP_PORT = PORT0 + ['ready', 'missing', 'real'].indexOf(mode); // a port of its own per launch
  try {
    child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + CDP_PORT, '--test-profile', '--profile-name=' + tag, ...OFFSCREEN_ARGS], { cwd: APP, stdio: 'ignore', env });
    watcher.watch(child.pid);
    const ct = await waitTarget((x) => x.type === 'page' && /index\.html/.test(String(x.url)), 40000);
    chrome = await new Cdp(ct.webSocketDebuggerUrl).open();
    await chrome.waitFor('!!(window.Drm && typeof openWatchTab === "function" && window.Drm.state())', 20000);
    // A fresh profile downloads the CDM on first run, possibly after main's 4 s cap.
    if (mode !== 'missing') await chrome.waitFor('window.api.drm.state().then((s) => !!(s && s.widevine && s.widevine.available))', 90000).catch(() => null);
    const st = await chrome.ev('window.api.drm.state()');
    const wv = st && st.widevine;
    if (mode === 'ready') check(wv && wv.available === true && wv.services === true, mode + ': Widevine really loaded, services on (signature taken as signed)', wv);
    if (mode === 'missing') check(wv && wv.available === false && wv.services === false, mode + ': Widevine reported missing', wv);
    if (mode === 'real') check(wv && wv.available === true && wv.services === false && wv.vmp === 'development', mode + ': Widevine loaded, development signature only', wv);

    await chrome.ev('(openWatchTab(), 1)');
    const wt = await waitTarget((x) => /\/watch\.html(\?|#|$)/.test(String(x.url)) && x.webSocketDebuggerUrl, 30000).catch(() => { throw new Error('the Watch page never appeared as a CDP target'); });
    g = await new Cdp(wt.webSocketDebuggerUrl).open();
    await g.waitFor('!!document.body && !document.body.classList.contains("is-boot")', 20000);
    const toasts = [];
    const grabToasts = async () => {
      const now = await g.ev('Array.from(document.querySelectorAll(".toast .t-txt")).map((n) => n.textContent)').catch(() => []);
      for (const t of now || []) if (toasts.indexOf(t) === -1) toasts.push(t);
    };

    // Where an open landed: 'layer' (Lumen's player shows that address, and no tab opened), 'tab', or null.
    const where = (prefix, tabsBefore) => `(() => { const p = ${JSON.stringify(prefix)};
      const s = window.WatchPlayer && WatchPlayer._state();
      if (s && s.open && (s.slots || []).some((x) => String(x.url || '').indexOf(p) === 0) && tabs.length === ${tabsBefore}) return 'layer';
      if (tabs.length > ${tabsBefore} && tabs.some((t) => String(t.url || '').indexOf(p) === 0)) return 'tab';
      return null; })()`;

    for (const [id, url] of TITLES) {
      const before = await chrome.ev('tabs.length');
      await g.ev('(console.log("quartz-watch:open " + ' + JSON.stringify(JSON.stringify({ url })) + '), 1)');
      // The first open of a run can land before main has the Watch page wired: say it once more then.
      const say = () => g.ev('(console.log("quartz-watch:open " + ' + JSON.stringify(JSON.stringify({ url })) + '), 1)');
      let recorded = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 8000) { const line = readText(openStub).split('\n').find((l) => l.indexOf(JSON.stringify(url)) !== -1); if (line) return JSON.parse(line); await sleep(100); } return null; })();
      if (!recorded) { console.log('[e2e] ' + mode + ': ' + id + ' open not heard in 8 s, said again'); await say(); }
      if (!recorded) recorded = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 8000) { const line = readText(openStub).split('\n').find((l) => l.indexOf(JSON.stringify(url)) !== -1); if (line) return JSON.parse(line); await sleep(100); } return null; })();
      if (mode === 'ready') {
        const rebased = url.replace(/^https:\/\/www\.[a-z]+\.com/, (m) => base + '/' + m.split('.')[1].replace('disneyplus', 'disney').replace('primevideo', 'prime'));
        // "Play inside Lumen" is on by default (watch-player-main.js), and since the leak-proof layer an
        // open from the Lumen page plays in Lumen's own player layer, never a tab: "in Quartz, not Edge"
        // is that layer showing the (rebased, local) address, with no new tab.
        const opened = await chrome.waitFor(where(rebased, before), 8000).catch(() => null);
        check(recorded && recorded.edge === false && opened === 'layer' && !readText(edgeStub).includes(url),
          mode + ': ' + id + ' opens in Quartz (Lumen’s player layer, no tab), not Edge', { recorded, opened, rebased });
      } else {
        const sent = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 8000) { if (readText(edgeStub).includes(url)) return true; await sleep(100); } return false; })();
        const tabsNow = await chrome.ev('tabs.length');
        check(recorded && recorded.edge === true && sent && tabsNow === before, mode + ': ' + id + ' goes to Edge (stub), no Quartz tab', { recorded, sent, tabs: [before, tabsNow] });
      }
      for (let i = 0; i < 10; i++) { await grabToasts(); await sleep(100); }
    }
    if (mode === 'missing') check(toasts.some((t) => t === 'Opened in Microsoft Edge: Widevine is switched off for this test run'), mode + ': the toast says why it went to Edge', toasts);
    if (mode === 'real') check(toasts.some((t) => t === 'Opened in Microsoft Edge: this copy of Quartz isn\u2019t signed for streaming services yet'), mode + ': the toast says why it went to Edge', toasts);
    if (mode === 'ready') check(!toasts.some((t) => /Edge/.test(t)), mode + ': no Edge toast', toasts);
    // YouTube never asks drm-main: always Quartz (Lumen's layer), whatever the Widevine state.
    const ytBefore = await chrome.ev('tabs.length');
    await g.ev('(console.log("quartz-watch:open " + ' + JSON.stringify(JSON.stringify({ url: 'https://www.youtube.com/watch?v=e2e' })) + '), 1)');
    const yt = await chrome.waitFor(where(base + '/youtube/watch?v=e2e', ytBefore), 8000).catch(() => null);
    check(yt === 'layer', mode + ': YouTube opens in Quartz (Lumen’s player layer, no tab)', yt);
  } catch (e) {
    check(false, mode + ': HARNESS ERROR ' + (e && e.stack || e));
  } finally {
    if (g) g.close();
    if (chrome) chrome.close();
    if (child) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ }
      await sleep(1200);
      for (let i = 0; i < 10; i++) { try { fs.rmSync(profileDir, { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
    }
    for (const f of [edgeStub, openStub]) { try { fs.unlinkSync(f); } catch (e) { /* none */ } }
  }
}

(async () => {
  let watcher = null;
  try {
    const free = freeRamGb();
    if (!(free >= MIN_FREE_GB)) { console.log('drm-route-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }
    const port = await listen(server);
    watcher = startWatcher((l) => console.log('[e2e] ' + l));
    await watcher.ready;
    for (const mode of ['ready', 'missing', 'real']) await run(mode, port, watcher);
  } catch (e) {
    check(false, 'HARNESS ERROR ' + (e && e.stack || e));
  } finally {
    if (watcher) { const v = watcher.verdict(); check(v.ok, v.line); watcher.stop(); }
    server.close();
    console.log('drm-route-e2e: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
})();
