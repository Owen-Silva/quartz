// tools/efficiency/bare-main.js -- the control for idle-bench.js: plain Electron (the same
// electron.exe Quartz runs on), one window the size of Quartz's, off-screen and shown inactive
// like a Quartz test instance, occlusion tracking off like --measure-visible, showing a static
// page. What this costs at idle is the framework's floor, not Quartz's code.
//
//   electron tools/efficiency/bare-main.js [--acrylic] [--webview]
//     --acrylic   the window Quartz makes on Win11 22H2+: backgroundMaterial acrylic,
//                 transparent background, titleBarStyle hidden
//     --webview   the page hosts one <webview> of a static page, like a Quartz tab
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', path.join(os.tmpdir(), 'bare-electron-' + process.pid));
const acrylic = process.argv.includes('--acrylic');
const webview = process.argv.includes('--webview');

app.whenReady().then(() => {
  const opts = { width: 1280, height: 820, x: -20000, y: -20000, show: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, sandbox: false, webviewTag: webview } };
  if (acrylic) Object.assign(opts, { titleBarStyle: 'hidden', backgroundMaterial: 'acrylic', backgroundColor: '#00000000' });
  const win = new BrowserWindow(opts);
  const inner = webview ? '<webview src="data:text/html,<h1>tab</h1>" style="position:fixed;inset:80px 0 0 0"></webview>' : '';
  win.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><title>bare</title><body style="background:transparent;color:#ccc;font:14px sans-serif"><p>bare electron</p>' + inner + '</body>'));
  win.once('ready-to-show', () => win.showInactive());
});
app.on('window-all-closed', () => app.quit());
