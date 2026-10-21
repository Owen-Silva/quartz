require('./tools/lowcpu-optional.js');   // first: one capped browser at a time (2026-09-17)
// log-e2e.js -- quartz.log end to end, against a REAL Quartz test instance and LOCAL pages.
//
//   node log-e2e.js [--cdp 9427] [--no-gate] [--keep]
//
// 1. A local server: plain.html; slowimg.html (the HTML is quick, an image takes 4 s, so the page
//    is past dom-ready but still loading); hang.html (served on "localhost", its own renderer).
// 2. Quartz: --test-profile --profile-name=loge2e<pid> --offscreen --show-inactive --measure-visible,
//    QUARTZ_LOG_MEMORY_MS=8000. testwatch.js fails the run if the window ever touches the screen.
//    Not launched under 2.5 GB free.
// 3. Checks, all read back from <profile>/quartz.log:
//    - the start line (first run); an adblock line (ready, or could not load: either says so);
//    - a forced guest crash (chrome://crash) -> exactly ONE "A tab on ... crashed" line + the card;
//    - a hang (a busy loop + input) -> exactly ONE "stopped responding" line;
//    - a refused connection -> one "A page failed to load" line;
//    - tab sleep and wake lines; a memory line (8 s cadence in this run);
//    - 15 executeJavaScript pushes into a still-loading page all land, with NO MaxListeners warning
//      (with --no-gate, QUARTZ_TEST_NO_JS_GATE=1 turns the fix off and the warning MUST appear: this
//      proves the check can see it);
//    - closing the window -> the quit line, last in the file.
// Kills ONLY the process it started and deletes its temp profile. One summary line:
// "log-e2e: N passed, M failed".
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
const KEEP = argv.includes('--keep');
const NO_GATE = argv.includes('--no-gate');
const APP = __dirname;
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROFILE = 'loge2e' + process.pid;
const PROFILE_DIR = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);
const LOG = path.join(PROFILE_DIR, 'quartz.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
}
const logLines = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } };
const matching = (re) => logLines().filter((l) => re.test(l));
async function waitLine(re, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = matching(re); if (m.length) return m; await sleep(250); }
  return [];
}

/* ---- the pages ------------------------------------------------------------------------------ */
const PAGES = {
  '/plain.html': '<!doctype html><title>Plain</title><p>plain</p>',
  '/slowimg.html': '<!doctype html><title>Slow image</title><p>loading an image for 4 s</p><img src="/slow.png">',
  '/hang.html': '<!doctype html><title>Hang</title><input id="i" autofocus><p>busy soon</p>',
};
const server = http.createServer((req, res) => {
  const p = String(req.url || '').split('?')[0];
  if (p === '/slow.png') { setTimeout(() => { res.writeHead(404); res.end(); }, 4000); return; }
  const body = PAGES[p];
  if (!body) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
});
const listen = (srv, port) => new Promise((r, j) => { srv.once('error', j); srv.listen(port, '127.0.0.1', () => r(srv.address().port)); });

/* ---- CDP ------------------------------------------------------------------------------------ */
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
  /** Fire and forget: for calls into a renderer that is about to hang. */
  post(method, params) { try { this.ws.send(JSON.stringify({ id: ++this.id, method, params: params || {} })); } catch (e) { /* gone */ } }
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

/* ---- run ------------------------------------------------------------------------------------ */
(async () => {
  let child = null, watcher = null, chrome = null, exited = false;
  try {
    const free = freeRamGb();
    if (!(free >= MIN_FREE_GB)) { console.log('log-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }
    const port = await listen(server, 0);
    const B = 'http://127.0.0.1:' + port;
    const H = 'http://localhost:' + port; // another site, so the hang has a renderer of its own
    watcher = startWatcher((l) => console.log('[e2e] ' + l));
    await watcher.ready;
    const env = Object.assign({}, process.env, { QUARTZ_LOG_MEMORY_MS: '8000' });
    if (NO_GATE) env.QUARTZ_TEST_NO_JS_GATE = '1';
    child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + CDP_PORT, '--test-profile', '--profile-name=' + PROFILE, ...OFFSCREEN_ARGS], { cwd: APP, stdio: 'ignore', env });
    child.on('exit', () => { exited = true; });
    watcher.watch(child.pid);
    console.log('[e2e] quartz pid ' + child.pid + ', pages :' + port + (NO_GATE ? ', executeJavaScript gate OFF' : ''));

    const ct = await waitTarget((x) => x.type === 'page' && /index\.html/.test(String(x.url)), 30000);
    chrome = await new Cdp(ct.webSocketDebuggerUrl).open();
    await chrome.waitFor('typeof createTab === "function" && typeof sleepTab === "function" && !!(window.api && window.api.log)', 20000);
    check(true, 'chrome up, api.log exposed');

    // ---- 1. start + adblock ---------------------------------------------------------------------
    const start = await waitLine(/ Quartz \S+ started \(/, 5000);
    check(start.length === 1 && /test profile "loge2e\d+"\)\. This is the first run with a log file\.$/.test(start[0]), 'start line, first run', start[0]);
    const ab = await waitLine(/ The ad blocker (is ready in \d+ ms|could not load)/, 45000);
    check(ab.length === 1, 'one adblock line (ready or could not load, either in words)', ab[0]);

    const open = (name, url) => chrome.ev(`(() => { window.__t = window.__t || {}; const t = createTab(${JSON.stringify(url)}); window.__t[${JSON.stringify(name)}] = t; activateTab(t.id); return t.id; })()`);
    const T = (name) => `window.__t[${JSON.stringify(name)}]`;

    // ---- 2. executeJavaScript into a page that is still loading --------------------------------------
    await open('slow', B + '/slowimg.html');
    await chrome.waitFor(`${T('slow')}.ready === true`, 15000);
    const stillLoading = await chrome.ev(`${T('slow')}.viewEl.isLoading()`);
    const pushes = await chrome.ev(`Promise.all(Array.from({ length: 15 }, (_, i) => ${T('slow')}.viewEl.executeJavaScript(String(i) + ' * 2'))).then((r) => r.join(','))`);
    check(stillLoading === true, 'the page was past dom-ready and still loading when the pushes went in', stillLoading);
    check(pushes === Array.from({ length: 15 }, (_, i) => i * 2).join(','), '15 pushes into a loading page all landed, in order', pushes);
    // A new tab page too: the case that warned on every new tab.
    await chrome.ev('createTab(), 1');
    await sleep(3000);
    const warned = matching(/MaxListenersExceededWarning/);
    if (NO_GATE) check(warned.length >= 1, 'gate OFF: the MaxListeners warning appears (the check can see it)', warned[0] || 'no warning line');
    else check(warned.length === 0, 'no MaxListeners warning (room made for Electron\'s own per-call waits)', warned[0]);

    // ---- 3. a forced guest crash -----------------------------------------------------------------
    await open('crash', B + '/plain.html');
    await chrome.waitFor(`${T('crash')}.ready === true`, 15000);
    await chrome.ev(`${T('crash')}.viewEl.loadURL('chrome://crash').catch(() => 0), 1`);
    let crashed = await waitLine(/ A tab on .* crashed: /, 10000);
    if (!crashed.length) {
      // chrome://crash refused: crash the guest's renderer over CDP instead (still a real crash).
      console.log('[e2e] chrome://crash did not crash the guest; using Page.crash');
      const gt = await waitTarget((x) => x.type === 'webview' && /plain\.html|chrome:\/\/crash/.test(String(x.url)), 5000);
      const g = await new Cdp(gt.webSocketDebuggerUrl).open();
      g.post('Page.crash');
      crashed = await waitLine(/ A tab on .* crashed: /, 10000);
      g.close();
    }
    await sleep(1500);
    crashed = matching(/ A tab on .* crashed: /);
    check(crashed.length === 1, 'forced crash: exactly ONE log line', crashed);
    check(/ A tab on (127\.0\.0\.1:\d+|chrome:\/\/crash) crashed: its process (crashed|exited with an error|ended).*\. Its "This page crashed" card is showing\.$/.test(crashed[0] || ''), 'forced crash: plain words', crashed[0]);
    check(await chrome.ev(`!!${T('crash')}.cardEl`), 'forced crash: the crash card is up too');
    check(matching(/ The Quartz window crashed/).length === 0, 'the window itself did not crash');

    // ---- 4. a hang -----------------------------------------------------------------------------
    await open('hang', H + '/hang.html');
    await chrome.waitFor(`${T('hang')}.ready === true`, 15000);
    // NO DevTools session on the guest: Chromium ignores a hang in a page a debugger is attached to
    // (WebContentsImpl::ShouldIgnoreUnresponsiveRenderer), which is what a first version of this did.
    // The loop starts from the chrome, and the input goes in through the CHROME's own target, over the
    // guest's rectangle, on a second connection (an input the guest never acks stalls its session).
    await chrome.ev(`${T('hang')}.viewEl.executeJavaScript('setTimeout(() => { for (;;) {} }, 150), 1')`);
    const rect = await chrome.ev(`(() => { const r = ${T('hang')}.viewEl.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 200)) }; })()`);
    await sleep(700);
    const inputConn = await new Cdp(ct.webSocketDebuggerUrl).open();
    // Input the renderer cannot answer starts Chromium's hang timer (15 s); never awaited.
    for (let i = 0; i < 3; i++) {
      inputConn.post('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      inputConn.post('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      inputConn.post('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65 });
      await sleep(400);
    }
    let hung = await waitLine(/ stopped responding/, 45000);
    inputConn.close();
    await sleep(1500);
    hung = matching(/ stopped responding/);
    check(hung.length === 1, 'hang: exactly ONE log line', hung);
    check(/ A tab on localhost:\d+ stopped responding \(its page is busy or stuck\)\.$/.test(hung[0] || ''), 'hang: plain words', hung[0]);
    await chrome.ev(`closeTab(${T('hang')}.id), 1`);
    await sleep(1500);
    check(matching(/ A tab on localhost:\d+ crashed/).length === 0, 'closing the hung tab is not logged as a crash');
    check(matching(/ localhost:\d+ is responding again/).length === 0, 'closing the hung tab is not logged as a recovery', matching(/responding again/)[0]);

    // ---- 5. a failed load ----------------------------------------------------------------------
    // A port nothing listens on (taken and let go), not port 1: Chromium refuses that one as unsafe.
    const deadPort = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    await open('refused', 'http://127.0.0.1:' + deadPort + '/');
    const failed = await waitLine(new RegExp(' A page failed to load: 127\\.0\\.0\\.1:' + deadPort + ': '), 15000);
    check(failed.length === 1 && /: the site refused the connection\.$/.test(failed[0]), 'refused connection: one line, in words', failed[0]);
    await sleep(500);
    check(matching(/Failed to load URL/).length === 0, "refused connection: Electron's own warning is not a second line", matching(/Failed to load URL/)[0]);

    // ---- 6. sleep and wake ---------------------------------------------------------------------
    await open('sleepy', B + '/plain.html?sleepy');
    await chrome.waitFor(`${T('sleepy')}.ready === true`, 15000);
    await open('front', B + '/plain.html?front');
    const slept = await chrome.ev(`sleepTab(${T('sleepy')}, 'idle')`);
    check(slept === true, 'sleepTab put the background tab to sleep', slept);
    const sl = await waitLine(/ went to sleep /, 4000);
    check(sl.length === 1 && / A tab on 127\.0\.0\.1:\d+ went to sleep after it went unused, to free its memory\.$/.test(sl[0]), 'sleep line', sl[0]);
    await sleep(1200);
    check(await chrome.ev(`wakeTab(${T('sleepy')})`) === true, 'wakeTab woke it');
    const wk = await waitLine(/ woke up/, 4000);
    check(wk.length === 1 && / A sleeping tab on 127\.0\.0\.1:\d+ woke up after sleeping \d+ s\.$/.test(wk[0]), 'wake line, with how long it slept', wk[0]);

    // ---- 6b. a Settings failure: plain words on screen, the raw error only in quartz.log -----------
    const RAW = 'E2E_RAW_THEME_ERR at fake.js:9';
    await chrome.ev(`(() => { window.__e2eSetMode = QuartzTheme.setMode; QuartzTheme.setMode = () => Promise.reject(new TypeError(${JSON.stringify(RAW)})); Settings.open(); return 1; })()`);
    const lightBtn = await chrome.waitFor(`(() => { const b = [...document.querySelectorAll('#settings-panel [data-field="theme"] .set-seg-opt')].find((x) => x.textContent === 'Light'); return b ? (b.click(), true) : null; })()`, 8000).catch((e) => e.message);
    check(lightBtn === true, 'Settings: the theme switch is there and Light was pressed', lightBtn);
    const toast = await chrome.waitFor(`(() => { const t = document.getElementById('settings-toast'); return t && !t.hidden && /theme/.test(t.textContent) ? t.textContent : null; })()`, 5000).catch((e) => e.message);
    check(/^Couldn’t switch the theme to Light: Quartz hit an error, so the window keeps its current look\. The details are in quartz\.log\.$/.test(toast) && toast.indexOf('E2E_RAW') < 0,
      'theme failure: the toast says what happened in plain words, no raw error text', toast);
    const uiErr = await waitLine(/ Settings could not change the theme\. The error was: /, 4000);
    check(uiErr.length === 1 && uiErr[0].endsWith('The error was: TypeError: ' + RAW), 'theme failure: the raw error is ONE quartz.log line', uiErr[0]);
    await chrome.ev('(() => { QuartzTheme.setMode = window.__e2eSetMode; return 1; })()');
    const bgWords = await chrome.ev(`(() => { const W = Settings._bgFailureWords; const named = (n, m, step) => { const e = new Error(m); e.name = n; if (step) e.bgStep = step; return e; };
      return { kind: W(new Error('Pick a JPG, PNG or WebP')), decode: W(named('InvalidStateError', 'E2E_RAW The source image could not be decoded.', 'read')),
        save: W(named('UnknownError', 'E2E_RAW transaction failed', 'save')), full: W(named('QuotaExceededError', 'E2E_RAW quota', 'save')), other: W('E2E_RAW what') }; })()`);
    check(bgWords.kind === 'Pick a JPG, PNG or WebP' && /^Couldn’t open that picture: the file looks damaged/.test(bgWords.decode) && /^Couldn’t save that picture: Quartz’s picture storage refused it/.test(bgWords.save)
      && /^Couldn’t save that picture: the disk is too full/.test(bgWords.full) && /^Couldn’t use that picture as the background/.test(bgWords.other)
      && Object.values(bgWords).every((w) => w.indexOf('E2E_RAW') < 0), 'background picture failures: plain words per cause, never the raw error', JSON.stringify(bgWords));

    // ---- 6c. the tab palette's field matches Helm's .palette-input (52px, 0 14px 0 16px, --fs-l) ---
    await chrome.ev('TabSearch.open(), 1');
    const field = await chrome.waitFor(`(() => { const f = document.querySelector('#tabsearch .ts-field'); const i = document.getElementById('tabsearch-input');
      if (!f || !i || !TabSearch.isOpen()) return null; const s = getComputedStyle(f);
      return s.height + ' ' + s.paddingLeft + ' ' + s.paddingRight + ' ' + getComputedStyle(i).fontSize; })()`, 5000).catch((e) => e.message);
    check(field === '52px 16px 14px 16px', 'tab palette field = Helm\'s palette input (height, padding, type size)', field);
    await chrome.ev('TabSearch.close(), 1');

    // ---- 7. the memory line --------------------------------------------------------------------
    const mem = await waitLine(/ Memory: /, 12000);
    check(mem.length >= 1 && / Memory: [\d,]+ MB in use across \d+ processes \(Quartz itself [\d,]+ MB, the window [\d,]+ MB, \d+ tab process(es)? [\d,]+ MB, GPU [\d,]+ MB, other helpers [\d,]+ MB\)\. \d+ tabs? awake\. Running for /.test(mem[0]), 'memory line', mem[0]);
    const mb = mem.length ? Number((/ Memory: ([\d,]+) MB/.exec(mem[0]) || [])[1].replace(/,/g, '')) : 0;
    check(mb > 50 && mb < 8000, 'memory line: a believable total', mb);
    const fl = await waitLine(/ Since the last check, \d+ pages? failed to load: .*\d+ x the site refused the connection/, 12000);
    check(fl.length >= 1, 'the check counts the failed load by cause', fl[0] || matching(/ Since the last check/));

    // ---- 8. quit -------------------------------------------------------------------------------
    await chrome.ev('setTimeout(() => window.close(), 50), 1').catch(() => 0);
    chrome.close(); chrome = null;
    for (let i = 0; i < 60 && !exited; i++) await sleep(250);
    check(exited, 'closing the window quit Quartz');
    const all = logLines();
    const last = all[all.length - 1] || '';
    check(/ Quartz quit after \d+ (s|min)\. This run: 1 tab crash, 0 window crashes, \d+ helper process stops?, 1 hang, \d+ failed page loads?, 1 tab put to sleep, 0 unhandled errors\.$/.test(last), 'the quit line is the last line, and sums the run', last);
    check(all.every((l) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} [A-Z"]/.test(l)), 'every line: full date and time, then a sentence');
    console.log('[e2e] ---- quartz.log ----');
    for (const l of all) console.log('[log] ' + l);
  } catch (e) {
    check(false, 'HARNESS ERROR ' + (e && e.stack || e));
  } finally {
    if (watcher) { const v = watcher.verdict(); check(v.ok, v.line); watcher.stop(); }
    if (chrome) chrome.close();
    if (child && !exited && !KEEP) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ }
      await sleep(1200);
    }
    if (!KEEP) for (let i = 0; i < 10; i++) { try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
    server.close();
    console.log(`log-e2e: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
