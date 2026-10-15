// tests/uvboost-e2e-main.js -- the Electron main script uvboost-e2e.js launches: a hidden window
// (so the process has a window-owning UI thread), uvboost installed with no delay, and one line
//   UVB-READY {"pid":..,"hwnd":"<decimal>","status":{...},"electron":"44.x"}
// once uvboost has applied or failed (or 25 s passed). Then, once the file UVB_POKE_FILE exists, 40
// process.activateUvLoop() calls 25 ms apart (each one a uv_async_send: one packet on libuv's port
// for the embed thread to wake for), then "POKED". It quits after 90 s or when killed.
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.setPath('userData', path.join(os.tmpdir(), 'uvboost-e2e-' + process.pid));
const ub = require(path.join(__dirname, '..', 'uvboost.js'));

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
  const status = ub.install({ delayMs: 0 });
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (status.state === 'pending' && Date.now() - t0 < 25000) return;
    clearInterval(iv);
    const h = win.getNativeWindowHandle();
    const hwnd = h.length >= 8 ? h.readBigUInt64LE(0).toString() : String(h.readUInt32LE(0));
    process.stdout.write('UVB-READY ' + JSON.stringify({ pid: process.pid, hwnd, status, electron: process.versions.electron }) + '\n');
  }, 100);
  // The driver says go by creating UVB_POKE_FILE (polled with a synchronous stat: no I/O of our own).
  const pokeFile = process.env.UVB_POKE_FILE;
  if (pokeFile) { const pv = setInterval(() => { if (fs.existsSync(pokeFile)) { clearInterval(pv); poke(); } }, 100); }
  setTimeout(() => app.quit(), 90000).unref();
});
app.on('window-all-closed', () => app.quit());
