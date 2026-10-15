// tests/uvquiet-e2e-main.js -- the Electron main script uvquiet-e2e.js launches.
//
// Installs ../uvquiet.js in its default mode (Electron 44: 'all', every process.activateUvLoop()
// skipped) and then arms Node work from each context Quartz arms it from, with the main
// process's loop otherwise idle: a Chromium task (a console-message event), a promise
// continuation inside a Chromium task, a callback inside uv_run, and a promise continuation
// inside uv_run. Every case must run on time. If the activation were still needed anywhere, that
// case would sit until something else woke Node's loop -- here the 60 s watchdog -- and time out.
//
// Prints one "UVQ {json}" line per case and "UVQ-DONE {json}" at the end, then quits.
// Argv: --mode=all|asyncid|none (none = no guard at all, the control).
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { performance } = require('perf_hooks');

const modeArg = (process.argv.find((a) => a.startsWith('--mode=')) || '').slice(7);
let counts = null;
if (modeArg !== 'none') {
  counts = require(path.join(__dirname, '..', 'uvquiet.js')).install(modeArg ? { mode: modeArg } : undefined);
}

const PROFILE = path.join(os.tmpdir(), 'uvquiet-e2e-' + process.pid);
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const out = (tag, obj) => process.stdout.write(tag + ' ' + JSON.stringify(obj) + '\n');
// The only other Node timer while the cases run: far away, so a missed wakeup shows as a timeout.
const watchdog = setTimeout(() => { out('UVQ-DONE', { error: 'watchdog: a case never finished', counts }); app.exit(1); }, 60000);

let server = null;
let port = 0;
const TIMER_MS = 40;

/** Each case gets `done(extra)` and must call it once; the latency is from the arm to `done`. */
const CASES = [
  { name: 'Chromium task: process.nextTick', run: (done) => process.nextTick(done) },
  { name: 'Chromium task: setImmediate', run: (done) => setImmediate(done) },
  { name: 'Chromium task: setTimeout(40)', wait: TIMER_MS, run: (done) => setTimeout(done, TIMER_MS) },
  { name: 'Chromium task: setInterval(40), first beat', wait: TIMER_MS, run: (done) => { const t = setInterval(() => { clearInterval(t); done(); }, TIMER_MS); } },
  { name: 'Chromium task: loopback http GET', run: (done) => {
    http.get({ host: '127.0.0.1', port, path: '/x' }, (res) => { res.resume(); res.on('end', () => done()); }).on('error', (e) => done({ error: e.message }));
  } },
  { name: 'Chromium promise continuation: setTimeout(40) after await', wait: TIMER_MS, run: (done) => { (async () => { await null; setTimeout(done, TIMER_MS); })(); } },
  { name: 'Chromium promise continuation: nextTick after executeJavaScript', run: (done, ctx) => {
    ctx.win.webContents.executeJavaScript('1').then(() => process.nextTick(done));
  } },
  { name: 'inside uv_run (fs callback): setTimeout(40)', wait: TIMER_MS, run: (done) => fs.stat(__filename, () => setTimeout(done, TIMER_MS)) },
  { name: 'inside uv_run (promise after fs.promises): setTimeout(40)', wait: TIMER_MS, run: (done) => { (async () => { await fs.promises.stat(__filename); setTimeout(done, TIMER_MS); })(); } },
  { name: 'inside uv_run (promise after http): nextTick + setImmediate', run: (done) => {
    (async () => {
      await new Promise((r) => http.get({ host: '127.0.0.1', port, path: '/y' }, (res) => { res.resume(); res.on('end', r); }).on('error', r));
      process.nextTick(() => setImmediate(done));
    })();
  } },
];

function runCase(i, win) {
  const c = CASES[i];
  return new Promise((resolve) => {
    let finished = false;
    const t0 = performance.now();
    const giveUp = Date.now() + 3000;
    const done = (extra) => {
      if (finished) return;
      finished = true;
      resolve(Object.assign({ name: c.name, ms: Math.round((performance.now() - t0) * 10) / 10, wait: c.wait || 0 }, extra || {}));
    };
    // The case is armed from INSIDE the console-message handler (a Chromium task); its own code
    // decides where the Node work is queued from.
    c.run(done, { win });
    // No Node timer for the give-up: that would wake the loop and hide the very bug under test.
    // The page polls instead (its own renderer timer), and asks again through console-message.
    pendingGiveUp = () => { if (!finished && Date.now() > giveUp) done({ error: 'did not run within 3 s' }); };
  });
}

let pendingGiveUp = null;
let onGo = null;

app.whenReady().then(async () => {
  server = http.createServer((req, res) => { res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { contextIsolation: true, sandbox: true } });
  win.webContents.on('console-message', (...args) => {
    // Electron 44: one event object with .message; older: (event, level, message).
    const msg = args[0] && typeof args[0].message === 'string' ? args[0].message : String(args[2] || '');
    if (msg === 'go' && onGo) { const f = onGo; onGo = null; f(); }
    else if (msg === 'poll' && pendingGiveUp) pendingGiveUp();
  });
  await win.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><title>uvquiet-e2e</title>'));
  // The page says "poll" every 500 ms, so a case that never runs is still noticed without a
  // main-process timer.
  await win.webContents.executeJavaScript('setInterval(() => console.log("poll"), 500), 1');

  const results = [];
  for (let i = 0; i < CASES.length; i++) {
    // ~1.2 s of quiet first, so Node's loop is parked with nothing due but the watchdog; then the
    // page's own timer sends "go" and the case is armed inside that console-message task.
    // onGo runs synchronously inside the console-message handler, so the case is armed in the
    // Chromium task itself, not in a continuation after it.
    const r = await new Promise((resolveCase) => {
      onGo = () => { runCase(i, win).then(resolveCase); };
      win.webContents.executeJavaScript('setTimeout(() => console.log("go"), 1200), 1');
    });
    out('UVQ', r);
    results.push(r);
  }
  clearTimeout(watchdog);
  out('UVQ-DONE', { counts, electron: process.versions.electron, mode: counts ? counts.mode : 'none' });
  server.close();
  win.destroy();
  app.quit();
});
app.on('window-all-closed', () => {});
app.on('quit', () => { try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* best effort */ } });
