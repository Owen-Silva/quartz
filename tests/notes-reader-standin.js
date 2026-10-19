// tests/notes-reader-standin.js -- a stand-in for the reader app, for notes-reader-e2e.js.
// Electron main script.
//
// The reader app this was shaped on is a WinUI 3 app around a WebView2: Chromium's
// accessibility tree under a native window. This is the closest shape that runs without any
// real reader app: a Chromium window
// holding a question page (course header, lesson title, question, four radio answers, Submit),
// changed in place like a single-page app. It runs as a hardlinked copy of electron.exe named
// notesstandin.exe, so the reader finds it by process name exactly as it finds the real reader
// app (whatever reader.exe in notes-pane.json names).
//
// The window is created at -20000,-20000 and shown INACTIVE: never on the visible desktop and
// never focused. It prints {"ready":true,"pid":N,"port":P} on stdout, then takes commands as
// GET http://127.0.0.1:P/<cmd> (Electron's main process on Windows never sees piped stdin):
//   /q?n=2   show question 2                      -> {"ok":true,"cmd":"q","n":2}
//   /anim?on=0  pause (1: run) the header spinner, the page's only animation
//   /cpu     CPU time of all its processes, in ms -> {"ok":true,"cmd":"cpu","ms":1234}
//   /quit
'use strict';
const http = require('http');
const { app, BrowserWindow } = require('electron');

// Its own throwaway profile: never the default %APPDATA%/Electron another app may hold.
app.setPath('userData', require('path').join(require('os').tmpdir(), 'notes-reader-standin-' + process.pid));
app.disableHardwareAcceleration();   // no GPU process churn in a CPU measurement
// STANDIN_MSAA=1: Chromium's older MSAA/IAccessible2 tree instead of native UIA, as a WebView2
// without the UIA provider exposes it. No TextPattern: the reader has to walk every node's Name.
if (process.env.STANDIN_MSAA === '1') app.commandLine.appendSwitch('disable-features', 'UiaProvider');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Reader app</title>
<style>
  body { font: 16px Segoe UI, sans-serif; margin: 0; background: #f4f5f7; color: #1d1f23; }
  header { display: flex; gap: 24px; align-items: center; padding: 12px 20px; background: #0f4c81; color: #fff; }
  nav a { color: #fff; margin-right: 14px; }
  main { padding: 24px 40px; max-width: 900px; }
  .q { font-size: 20px; margin: 18px 0; }
  label { display: block; padding: 8px 0; }
  .spin { width: 18px; height: 18px; border: 3px solid #ccc; border-top-color: #0f4c81; border-radius: 50%;
          animation: r 1s linear infinite; }
  @keyframes r { to { transform: rotate(360deg); } }
</style></head><body>
<header><strong>Sample Reader</strong><nav><a href="#">Courses</a><a href="#">Grades</a><a href="#">Help</a></nav>
  <div class="spin" aria-hidden="true"></div></header>
<main>
  <h1 id="course">Sample Course</h1>
  <h2 id="lesson">Lesson 12 - Sample Topic</h2>
  <p class="q" id="question"></p>
  <form id="answers"></form>
  <button type="button">Submit</button>
  <p>Problem <span id="num"></span> of 20</p>
</main>
<script>
  const QUESTIONS = [
    ['A gas occupies 4.0 L at 300 K. At constant pressure, what volume does it occupy at 450 K?', ['2.7 L', '4.0 L', '6.0 L', '8.0 L']],
    ['Which law relates pressure and volume of a gas at constant temperature?', ["Boyle's law", "Charles's law", "Avogadro's law", "Dalton's law"]],
    ['How many moles of an ideal gas occupy 22.4 L at STP?', ['0.5 mol', '1 mol', '2 mol', '22.4 mol']],
    ['What is the partial pressure of oxygen in air at 1.00 atm if air is 21% oxygen?', ['0.21 atm', '0.79 atm', '1.00 atm', '21 atm']],
    ['Which gas diffuses fastest at the same temperature?', ['H2', 'He', 'N2', 'CO2']],
  ];
  window.setAnim = (on) => { document.querySelector('.spin').style.animationPlayState = on ? 'running' : 'paused'; return on; };
  window.setQ = (n) => {
    const q = QUESTIONS[(n - 1) % QUESTIONS.length];
    document.getElementById('question').textContent = 'Question ' + n + ': ' + q[0];
    document.getElementById('num').textContent = String(n);
    document.getElementById('answers').innerHTML = q[1].map((a, i) =>
      '<label><input type="radio" name="a" value="' + i + '"> ' + a.replace(/</g, '&lt;') + '</label>').join('');
    return n;
  };
  setQ(1);
</script></body></html>`;

let win = null;
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  let out = { ok: false, reason: 'unknown command' };
  try {
    if (u.pathname === '/quit') { res.end('{"ok":true}'); setTimeout(() => app.exit(0), 50); return; }
    if (u.pathname === '/q') {
      const n = await win.webContents.executeJavaScript('setQ(' + Number(u.searchParams.get('n')) + ')');
      out = { ok: true, cmd: 'q', n };
    } else if (u.pathname === '/anim') {
      const on = await win.webContents.executeJavaScript('setAnim(' + (u.searchParams.get('on') === '1') + ')');
      out = { ok: true, cmd: 'anim', on };
    } else if (u.pathname === '/cpu') {
      // cumulativeCPUUsage is in seconds.
      const ms = app.getAppMetrics().reduce((s, m) => s + ((m.cpu && m.cpu.cumulativeCPUUsage) || 0), 0) * 1000;
      out = { ok: true, cmd: 'cpu', ms: Math.round(ms) };
    }
  } catch (e) { out = { ok: false, reason: String(e && e.message || e) }; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(out));
});

app.whenReady().then(async () => {
  win = new BrowserWindow({
    x: -20000, y: -20000, width: 1280, height: 800, show: false, title: 'Reader app stand-in',
    skipTaskbar: true, focusable: false,
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  // STANDIN_EXTRA=N: a course outline of N links beside the question, for a page as heavy as a real one.
  const extra = Number(process.env.STANDIN_EXTRA || 0);
  if (extra > 0) {
    await win.webContents.executeJavaScript('(() => { const n = document.createElement("nav"); for (let i = 1; i <= '
      + extra + '; i++) { const a = document.createElement("a"); a.href = "#"; a.textContent = "Lesson " + i + " outline item"; '
      + 'n.appendChild(a); n.appendChild(document.createElement("br")); } document.body.appendChild(n); return 1; })()');
  }
  win.showInactive();
  win.setPosition(-20000, -20000);
  server.listen(0, '127.0.0.1', () => say({ ready: true, pid: process.pid, port: server.address().port }));
});
// The harness died without saying quit: do not outlive it.
const parent = Number(process.env.STANDIN_PARENT_PID || 0);
if (parent) setInterval(() => { try { process.kill(parent, 0); } catch (e) { app.exit(0); } }, 5000).unref();
