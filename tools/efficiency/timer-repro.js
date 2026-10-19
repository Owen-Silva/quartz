// tools/efficiency/timer-repro.js -- plain Electron (bare-main.js's window: off-screen, shown
// inactive, a static page) plus ONLY a few main-process timers, to see which timer shape wakes
// the main thread hundreds of times a second. Used by wake-bisect.js (cond option "repro=<mode>").
//
//   electron tools/efficiency/timer-repro.js --timers=<mode>
//     none            no timers (= bare-main.js)
//     unref3s         setInterval(noop, 3000).unref()
//     ref3s           setInterval(noop, 3000)
//     unref3s-push    every 3 s an unref'd setTimeout(100) (notes-pane-main.js's readTimer + schedulePush)
//     ref3s-push      the same, both ref'd
//     unref3s-async   unref3s-push, the push made after an await (readOnce is async)
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', path.join(os.tmpdir(), 'timer-repro-' + process.pid));
const arg = process.argv.find((a) => a.startsWith('--timers='));
const full = arg ? arg.slice('--timers='.length) : 'none';
const gm = /-guard(id|all)?$/.exec(full);
const mode = full.replace(/-guard(id|all)?$/, '');
// -guard: uvquiet's default mode (Electron 44: 'all'); -guardid: the async-id rule; -guardall: 'all'.
if (gm) require(path.join(__dirname, '..', '..', 'uvquiet.js')).install({ mode: gm[1] === 'id' ? 'asyncid' : gm[1] === 'all' ? 'all' : undefined });

//     unref3s-push<N>     the push is N ms instead of 100
//     unref3s-pushimm     the push is armed from a setImmediate, outside the timer callback
//     child1s             a typeperf child streaming one CSV row a second to a 'data' listener
//                         (stats.js's sampler without the rest of Quartz)
//     con2s           the page logs a console line every 2 s; main's console-message handler (a
//                     CHROMIUM task, not a uv callback) calls process.activateUvLoop()
//     con2s-http      that handler makes an http GET to a closed loopback port, 600 ms timeout
//                     (the now-playing probe with no bridge running)
//     con2s-httpok    that handler makes an http GET to a server in this process (a live bridge)
//     <mode>-guardid      <mode> with uvquiet's async-id rule; -guardall: every activation skipped
//     <mode>-guard        <mode> with ../../uvquiet.js installed first (no activateUvLoop from
//                         inside Node's own callbacks)
function startTimers() {
  const unref = !/^ref/.test(mode);
  const keep = (t) => { if (unref && t.unref) t.unref(); return t; };
  const m = /-push(imm)?(\d+)?$/.exec(mode);
  const pushMs = m && m[2] ? Number(m[2]) : 100;
  const push = () => keep(setTimeout(() => {}, pushMs));
  if (mode === 'child1s') {
    const child = require('child_process').spawn('typeperf', [String.raw`\Processor(_Total)\% Processor Time`, '-si', '1'], { windowsHide: true });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    app.on('before-quit', () => { try { child.kill(); } catch (e) { /* gone */ } });
  } else if (mode === 'unref3s' || mode === 'ref3s') keep(setInterval(() => {}, 3000));
  // The push through timers/promises: the same Node timer, WITHOUT Electron's setTimeout wrapper
  // (which calls process.activateUvLoop(), a uv_async_send, on every call).
  else if (mode === 'unref3s-pushpromise') keep(setInterval(() => { require('timers/promises').setTimeout(100, null, { ref: false }).then(() => {}); }, 3000));
  // Only the wrapper's side effect, no new timer.
  else if (mode === 'unref3s-activate') keep(setInterval(() => { process.activateUvLoop(); }, 3000));
  else if (mode === 'unref3s-async') keep(setInterval(() => { Promise.resolve((async () => { await null; push(); })()).then(() => {}); }, 3000));
  else if (m && m[1]) keep(setInterval(() => setImmediate(push), 3000));
  else if (m) keep(setInterval(push, 3000));
  else if (mode === 't2s-http' || mode === 't2s-httpok') startTimerHttp(mode === 't2s-httpok');
}

//     t2s-http        a MAIN-PROCESS setInterval (a uv timer callback, not a Chromium task) makes an
//                     http GET every 2 s to a closed loopback port, 600 ms timeout
//     t2s-httpok      the same to a server in this process (a live bridge)
function startTimerHttp(live) {
  const http = require('http');
  let port = 1;
  const go = () => {
    const req = http.get({ host: '127.0.0.1', port, path: '/now', timeout: 600 }, (res) => { res.resume(); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
  };
  if (!live) { setInterval(go, 2000); return; }
  const server = http.createServer((q, r) => r.end('{"ok":true,"status":"playing"}'));
  server.listen(0, '127.0.0.1', () => { port = server.address().port; setInterval(go, 2000); });
}

// wvexec1s: a second off-screen window hosting a <webview>; its page calls the webview's
// executeJavaScript once a second -- Quartz's stats push into the Home guest, without Quartz
// (the call goes through main's GUEST_VIEW_MANAGER_CALL handler, a Chromium task).
function startWebviewExec() {
  const w2 = new BrowserWindow({ width: 800, height: 600, x: -20000, y: -20000, show: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, sandbox: false, webviewTag: true } });
  const page = '<!doctype html><title>wv</title><webview src="data:text/html,<p>guest</p>" style="width:400px;height:300px"></webview>' +
    '<script>const wv = document.querySelector("webview"); wv.addEventListener("dom-ready", () => { let n = 0; setInterval(() => wv.executeJavaScript("window.__x = " + (n++)), 1000); });</script>';
  w2.loadURL('data:text/html,' + encodeURIComponent(page));
  w2.once('ready-to-show', () => w2.showInactive());
}

// The con2s family: Node work started from a Chromium task every 2 s (the page's own timer).
function startConsolePoll(win) {
  const http = require('http');
  let port = 1;   // closed on any runner: refused (or the 600 ms timeout)
  const go = () => {
    if (mode === 'con2s') { process.activateUvLoop(); return; }
    const req = http.get({ host: '127.0.0.1', port, path: '/now', timeout: 600 }, (res) => { res.resume(); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
  };
  const arm = () => {
    win.webContents.on('console-message', (...args) => {
      const msg = args[0] && typeof args[0].message === 'string' ? args[0].message : String(args[2] || '');
      if (msg === 'poll') go();
    });
    win.webContents.executeJavaScript('setInterval(() => console.log("poll"), 2000), 1').catch(() => {});
  };
  if (mode === 'con2s-httpok') {
    const server = http.createServer((q, r) => r.end('{"ok":true,"status":"playing"}'));
    server.listen(0, '127.0.0.1', () => { port = server.address().port; arm(); });
  } else win.webContents.once('did-finish-load', arm);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 820, x: -20000, y: -20000, show: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, sandbox: false } });
  win.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><title>timer-repro</title><p>' + mode + '</p>'));
  win.once('ready-to-show', () => win.showInactive());
  startTimers();
  if (/^con2s/.test(mode)) startConsolePoll(win);
  // libuv's loop counters every 10 s (see wake-hook.js's QWAKE_UVM).
  setInterval(() => { try { const m = require('perf_hooks').performance.nodeTiming.uvMetricsInfo; process.stdout.write('qwake-uvm ' + JSON.stringify({ t: Date.now(), loop: m.loopCount, ev: m.events, wait: m.eventsWaiting }) + '\n'); } catch { /* old Node */ } }, 10000).unref();
  // uvboost's fix, applied to plain Electron (the bench's boost= option does the same from outside).
  if (process.env.QREPRO_UVBOOST === '1') require(path.join(__dirname, '..', '..', 'uvboost.js')).install({ delayMs: 0 });
  if (mode === 'wvexec1s') startWebviewExec();
});
app.on('window-all-closed', () => app.quit());
