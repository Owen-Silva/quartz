// tools/efficiency/timer-repro.js -- plain Electron (bare-main.js's window: off-screen, shown
// inactive, a static page) plus ONLY a few main-process timers, to see which timer shape wakes
// the main thread hundreds of times a second. Used by wake-bisect.js (cond option "repro=<mode>").
//
//   electron tools/efficiency/timer-repro.js --timers=<mode>
//     none            no timers (= bare-main.js)
//     unref3s         setInterval(noop, 3000).unref()
//     ref3s           setInterval(noop, 3000)
//     unref3s-push    every 3 s an unref'd setTimeout(100) (school.js's readTimer + schedulePush)
//     ref3s-push      the same, both ref'd
//     unref3s-async   unref3s-push, the push made after an await (readOnce is async)
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', path.join(os.tmpdir(), 'timer-repro-' + process.pid));
const arg = process.argv.find((a) => a.startsWith('--timers='));
const mode = arg ? arg.slice('--timers='.length) : 'none';

//     unref3s-push<N>     the push is N ms instead of 100
//     unref3s-pushimm     the push is armed from a setImmediate, outside the timer callback
function startTimers() {
  const unref = !/^ref/.test(mode);
  const keep = (t) => { if (unref && t.unref) t.unref(); return t; };
  const m = /-push(imm)?(\d+)?$/.exec(mode);
  const pushMs = m && m[2] ? Number(m[2]) : 100;
  const push = () => keep(setTimeout(() => {}, pushMs));
  if (mode === 'unref3s' || mode === 'ref3s') keep(setInterval(() => {}, 3000));
  // The push through timers/promises: the same Node timer, WITHOUT Electron's setTimeout wrapper
  // (which calls process.activateUvLoop(), a uv_async_send, on every call).
  else if (mode === 'unref3s-pushpromise') keep(setInterval(() => { require('timers/promises').setTimeout(100, null, { ref: false }).then(() => {}); }, 3000));
  // Only the wrapper's side effect, no new timer.
  else if (mode === 'unref3s-activate') keep(setInterval(() => { process.activateUvLoop(); }, 3000));
  else if (mode === 'unref3s-async') keep(setInterval(() => { Promise.resolve((async () => { await null; push(); })()).then(() => {}); }, 3000));
  else if (m && m[1]) keep(setInterval(() => setImmediate(push), 3000));
  else if (m) keep(setInterval(push, 3000));
}

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 820, x: -20000, y: -20000, show: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, sandbox: false } });
  win.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><title>timer-repro</title><p>' + mode + '</p>'));
  win.once('ready-to-show', () => win.showInactive());
  startTimers();
});
app.on('window-all-closed', () => app.quit());
