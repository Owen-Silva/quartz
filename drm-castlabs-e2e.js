require('./tools/lowcpu-optional.js');   // first: the CPU cap, when one is configured (tools/lowcpu-optional.js; none on a cloud runner)
// drm-castlabs-e2e.js -- Quartz ITSELF on castlabs ECS, in the state a test copy really is in:
// the Widevine CDM loads before the window, but Quartz carries only castlabs' DEVELOPMENT signature
// (no EVS production signature: that needs the developer's account). Checks:
//   - a real Quartz <webview> tab (hardening intact, plugins=false) plays a public Widevine test stream
//     (Shaka's Angel One + Google's test licence proxy, which accepts the development signature), and
//     no bar goes up on it;
//   - a known streaming site DOES get the bar, and it says why: not signed for streaming services;
//   - a page whose licence is rejected (update() with junk), and one whose licence never comes, get the
//     'refused' bar with Open in Edge, because the key system was granted and playback still failed.
// Off-screen, Edge stubbed (never launched), temp profile.
//   node drm-castlabs-e2e.js [--cdp 9427]
// One summary line: "drm-castlabs-e2e: N passed, M failed".
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
const CDP_PORT = Number(opt('cdp', '9427'));
const APP = __dirname;
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROFILE = 'drmcl' + process.pid;
const PROFILE_DIR = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);
const STUB = path.join(os.tmpdir(), 'quartz-drmcl-edge-stub-' + process.pid + '.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
}
const PLAY = fs.readFileSync(path.join(__dirname, 'tests', 'drm-fixtures', 'widevine-play.html'), 'utf8');
// A page that gets Widevine, asks for a licence, then hands the CDM junk (mode=junk) or never answers
// (mode=silent): what a service that refuses this build looks like from inside the page.
const LICENCE_PAGE = `<!doctype html><title>Licence test</title><video id="v"></video><script>
(async () => {
  const mode = new URLSearchParams(location.search).get('mode');
  const say = (o) => console.log('lic:' + JSON.stringify(o));
  try {
    const access = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['webm', 'cenc'], videoCapabilities: [{ contentType: 'video/webm; codecs="vp8"' }] }]);
    const keys = await access.createMediaKeys();
    await document.getElementById('v').setMediaKeys(keys);
    const s = keys.createSession();
    s.addEventListener('message', (e) => {
      say({ message: e.messageType });
      if (mode === 'junk') s.update(new Uint8Array([8, 1, 18, 3, 1, 2, 3])).then(() => say({ update: 'accepted' }), (err) => say({ update: 'rejected', name: err.name }));
    });
    await s.generateRequest('webm', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
    say({ requested: true });
  } catch (err) { say({ error: String(err && err.name) + ': ' + String(err && err.message) }); }
})();
</script>`;
const server = http.createServer((req, res) => {
  const p = String(req.url || '').split('?')[0];
  const body = p === '/play.html' ? PLAY : p === '/watch.html' ? '<!doctype html><title>Test Stream</title><p>watch</p>' : p === '/licence.html' ? LICENCE_PAGE : null;
  if (!body) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
});
const listen = (srv, port) => new Promise((r, j) => { srv.once('error', j); srv.listen(port, '127.0.0.1', () => r(srv.address().port)); });

/* ---- CDP ----------------------------------------------------------------------------------- */
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
async function guest(urlRe) {
  const t = await waitTarget((x) => x.type === 'webview' && urlRe.test(String(x.url)), 15000);
  return new Cdp(t.webSocketDebuggerUrl).open();
}

/* ---- run ------------------------------------------------------------------------------------ */
(async () => {
  let child = null, watcher = null, chrome = null;
  try {
    const free = freeRamGb();
    if (!(free >= MIN_FREE_GB)) { console.log('drm-castlabs-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }
    const port = await listen(server, 0);
    watcher = startWatcher((l) => console.log('[e2e] ' + l));
    await watcher.ready;
    const env = Object.assign({}, process.env, { QUARTZ_EDGE_STUB: STUB, QUARTZ_DRM_TEST_SITE: 'localhost' });
    child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + CDP_PORT, '--test-profile', '--profile-name=' + PROFILE, ...OFFSCREEN_ARGS], { cwd: APP, stdio: 'ignore', env });
    watcher.watch(child.pid);
    const ct = await waitTarget((x) => x.type === 'page' && /index\.html/.test(String(x.url)), 40000);
    chrome = await new Cdp(ct.webSocketDebuggerUrl).open();
    await chrome.waitFor('!!(window.Drm && typeof createTab === "function" && window.Drm.state())', 20000);
    // A fresh profile downloads the CDM on first run; past main's 4 s cap it lands later (drm:changed).
    const t0 = Date.now();
    await chrome.waitFor('(() => { const s = window.Drm.state(); return !!(s && s.widevine && s.widevine.available); })()', 90000).catch(() => null);
    console.log('[e2e] Widevine available ' + (Date.now() - t0) + ' ms after the chrome was ready');
    const st = await chrome.ev('window.Drm.state()');
    check(st.widevine && st.widevine.available === true, 'castlabs build: Widevine reported available', st.widevine);
    check(st.widevine && st.widevine.services === false && st.widevine.vmp === 'development', 'test copy: development signature only, so services are reported unable to play', st.widevine && { services: st.widevine.services, vmp: st.widevine.vmp });

    // A real Quartz tab plays the Widevine test stream.
    await chrome.ev('(() => { window.__p = createTab("http://127.0.0.1:' + port + '/play.html?ms=40000"); activateTab(window.__p.id); return 1; })()');
    const t = await waitTarget((x) => x.type === 'webview' && /play\.html/.test(String(x.url)), 15000);
    const g = await new Cdp(t.webSocketDebuggerUrl).open();
    const res = await new Promise((resolve) => {
      const done = setTimeout(() => resolve({ ok: false, error: 'no result in 70 s' }), 70000);
      g.ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.method !== 'Runtime.consoleAPICalled') return;
        const s = String((m.params.args[0] || {}).value || '');
        if (!s.startsWith('proto:')) return;
        const o = JSON.parse(s.slice(6));
        console.log('[e2e] page ' + s.slice(0, 300));
        if (o.done) { clearTimeout(done); resolve(o); }
      });
      g.send('Runtime.enable');
    });
    g.close();
    check(res.keySystemAccess === 'granted:com.widevine.alpha', 'Quartz tab: Widevine key system granted (plugins=false, hardening intact)', res.keySystemAccess);
    check(res.robustness && res.robustness.SW_SECURE_DECODE === 'granted' && /refused/.test(res.robustness.HW_SECURE_ALL), 'Quartz tab: software CDM (L3), no hardware path', res.robustness);
    check(Array.isArray(res.licence) && res.licence.length > 0 && res.licence.every((l) => l.status === 200), 'Quartz tab: licence served (development VMP accepted by the test proxy)', res.licence);
    check(res.ok === true, 'Quartz tab: encrypted video PLAYED', { t: res.currentTime, frames: res.totalFrames, h: res.h, err: res.error || res.shakaError });
    const bar = await chrome.ev('window.Drm._tab(window.__p).bar');
    check(bar === null, 'Quartz tab: no "needs DRM" bar on a page that plays', bar);

    // A known streaming site: the bar, saying why (the test copy is not signed for streaming).
    await chrome.ev('(() => { window.__k = createTab("http://localhost:' + port + '/watch.html"); activateTab(window.__k.id); return 1; })()');
    const kb = await chrome.waitFor('(() => { const b = window.Drm._tab(window.__k).bar; return b && b.mode === "need" ? b : null; })()', 10000).catch(() => null);
    check(!!kb && /can’t play yet: this copy of Quartz isn’t signed for streaming services yet\./.test(kb.text) && kb.buttons.indexOf('Open in Edge') !== -1,
      'known streaming site: the bar says it is not signed for streaming services, and offers Edge', kb);

    // Licence refused (junk licence), then no licence at all: the 'refused' bar, with Edge.
    for (const mode of ['junk', 'silent']) {
      await chrome.ev('(() => { window.__l = createTab("http://127.0.0.1:' + port + '/licence.html?mode=' + mode + '"); activateTab(window.__l.id); return 1; })()');
      const lg = await guest(/licence\.html/);
      const lines = [];
      lg.ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.method === 'Runtime.consoleAPICalled') { const s = String((m.params.args[0] || {}).value || ''); if (s.startsWith('lic:')) lines.push(s.slice(4)); } });
      await lg.send('Runtime.enable');
      const want = mode === 'junk' ? /refused to license this video to Quartz: this copy of Quartz isn’t signed/ : /didn’t send a licence for this video: this copy of Quartz isn’t signed/;
      const rb = await chrome.waitFor('(() => { const b = window.Drm._tab(window.__l).bar; return b && b.mode === "refused" ? b : null; })()', mode === 'silent' ? 25000 : 10000).catch(() => null);
      console.log('[e2e] licence page (' + mode + '): ' + lines.join(' ').slice(0, 300));
      check(!!rb && want.test(rb.text) && rb.buttons.indexOf('Open in Edge') !== -1,
        'licence ' + (mode === 'junk' ? 'rejected' : 'never sent') + ': the refused bar says so and offers Edge', rb || lines);
      lg.close();
      await chrome.ev('(() => { closeTab(window.__l.id); return 1; })()').catch(() => 0);
    }
    const stubText = (() => { try { return fs.readFileSync(STUB, 'utf8'); } catch (e) { return ''; } })();
    check(stubText === '', 'Edge never opened by itself (stub empty)', stubText.slice(0, 200));

    // RAM per process (the CDM is a utility process of its own).
    try {
      const ps = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*' + PROFILE + '*" } | ForEach-Object { [string]$_.ProcessId + "|" + [int]($_.WorkingSetSize/1MB) + "|" + ((($_.CommandLine -split " ") | Where-Object { $_ -like "--type=*" -or $_ -like "--utility-sub-type=*" }) -join " ") }';
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
      console.log('[e2e] processes (pid|MB working set|type):\n' + out.trim());
    } catch (e) { console.log('[e2e] process RAM not read: ' + e.message); }
  } catch (e) {
    check(false, 'HARNESS ERROR ' + (e && e.stack || e));
  } finally {
    if (watcher) { const v = watcher.verdict(); check(v.ok, v.line); watcher.stop(); }
    if (chrome) chrome.close();
    if (child) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ }
      await sleep(1200);
      for (let i = 0; i < 10; i++) { try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
    }
    try { fs.unlinkSync(STUB); } catch (e) { /* none */ }
    server.close();
    console.log('drm-castlabs-e2e: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
})();
