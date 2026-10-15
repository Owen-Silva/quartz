// tests/uvboost-e2e-main.js -- the Electron main script uvboost-e2e.js launches: a hidden window
// (so the process has a window-owning UI thread), then these lines on stdout:
//   UVB-PRE {"pid":..,"hwnd":"<decimal>","electron":"44.x"}      before uvboost has run
//   UVB-READY {"status":{...}}     uvboost installed with no delay, once the file UVB_GO_FILE exists
//   UVB-LINE <text>                every line uvboost would put in quartz.log
//   POKED 40                       once UVB_POKE_FILE exists: 40 process.activateUvLoop() calls 25 ms
//                                  apart (each a uv_async_send: one packet on libuv's port)
//   UVB-GUARD {"status":{...}}     UVB_GUARD_MS * 2.5 after READY (the guard has run twice)
// UVB_GUARD_MS / UVB_GUARD_MAX set the guard's interval and its CPU limit (share of a core).
// It quits after 90 s or when killed. The files are polled with a synchronous stat: no I/O of ours.
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.setPath('userData', path.join(os.tmpdir(), 'uvboost-e2e-' + process.pid));
const ub = require(path.join(__dirname, '..', 'uvboost.js'));
ub.onLine((l) => process.stdout.write('UVB-LINE ' + l + '\n'));
const say = (tag, o) => process.stdout.write(tag + ' ' + JSON.stringify(o) + '\n');
const whenFile = (f, fn) => {
  if (!f) return;
  const iv = setInterval(() => { if (fs.existsSync(f)) { clearInterval(iv); fn(); } }, 100);
};

function poke() {
  let n = 0;
  const iv = setInterval(() => {
    process.activateUvLoop();
    if (++n >= 40) { clearInterval(iv); process.stdout.write('POKED ' + n + '\n'); }
  }, 25);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 400, height: 300, show: false, skipTaskbar: true });
  win.loadURL('data:text/html,<title>uvboost-e2e</title>');
  const h = win.getNativeWindowHandle();
  const hwnd = h.length >= 8 ? h.readBigUInt64LE(0).toString() : String(h.readUInt32LE(0));
  say('UVB-PRE', { pid: process.pid, hwnd, electron: process.versions.electron });
  whenFile(process.env.UVB_GO_FILE, () => {
    const guardMs = Number(process.env.UVB_GUARD_MS) || 0;
    const opts = { delayMs: 0 };
    if (guardMs > 0) opts.guardEveryMs = guardMs;
    if (process.env.UVB_GUARD_MAX) opts.guardMaxShare = Number(process.env.UVB_GUARD_MAX);
    const status = ub.install(opts);
    say('UVB-READY', { status });
    if (guardMs > 0) setTimeout(() => say('UVB-GUARD', { status }), Math.round(guardMs * 2.5));
    whenFile(process.env.UVB_POKE_FILE, poke);
  });
  setTimeout(() => app.quit(), 90000).unref();
});
app.on('window-all-closed', () => app.quit());
