// files-harness.js — end-to-end test: a NEW Files tab lists its folder on the first try.
//
// The bug it pins: files.js asks for its boot listing (`files:list {json}` on the
// console) from DOMContentLoaded, which can reach app.js BEFORE the <webview>'s
// dom-ready has marked the tab ready. handleFilesLine used to drop that line, so
// a fresh Files tab sat on "This PC" instead of the folder it was opened on.
//
// Run against an ISOLATED test instance only (never the live browser):
//   npx electron . --test-profile --profile-name=filesharness --show-inactive --remote-debugging-port=9241
//   powershell -NoProfile -File toback.ps1 -Match filesharness
//   CDP_PORT=9241 node files-harness.js [rounds]
// Kill that instance by pid afterwards (CommandLine contains --profile-name=filesharness).
//
// Two checks, `rounds` times each (default 10), every round a brand-new tab:
//   A. remembered folder: localStorage files.last = a temp folder, openFilesTab()
//   B. ?path=: createTab(filesUrl(folder)) with files.last pointing elsewhere
// A round passes when the guest's row list shows the marker file in that folder
// within LIST_WAIT_MS. A dropped request never arrives, so the wait only has to
// be longer than a slow listing on a loaded machine; it is not tuned to pass.
// Prints one summary line: "files-test: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.CDP_PORT);
if (!PORT) { console.error('set CDP_PORT to a --test-profile instance (never the live browser)'); process.exit(2); }
const ROUNDS = Math.max(1, Number(process.argv[2]) || 10);
const LIST_WAIT_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A folder only this run knows about, with one file whose name proves the listing.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-files-harness-'));
const marker = 'files-harness-marker-' + process.pid + '.txt';
fs.writeFileSync(path.join(dir, marker), 'x');

let ws = null;
let seq = 0;
const waiting = new Map();

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
  if (!page) throw new Error('no chrome page target on port ' + PORT);
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
    else if (msg.result.exceptionDetails) w.reject(new Error(msg.result.exceptionDetails.exception
      ? msg.result.exceptionDetails.exception.description : msg.result.exceptionDetails.text));
    else w.resolve(msg.result.result.value);
  });
}

/** Evaluate in the chrome document (app.js's globals live there). */
function evalChrome(expr) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    setTimeout(() => { if (waiting.delete(id)) reject(new Error('eval timeout')); }, 15000);
  });
}

const J = JSON.stringify;

/** Close every Files tab, so the next open is a brand-new guest. */
async function closeFilesTabs() {
  await evalChrome(`(() => { let t; let n = 0;
    while ((t = findFilesTab()) && n++ < 5) closeTab(t.id, { force: true });
    return !findFilesTab(); })()`);
}

/** Poll the Files guest until its rows show the marker, or LIST_WAIT_MS passes. */
async function waitForMarker() {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < LIST_WAIT_MS) {
    last = await evalChrome(`(async () => {
      const t = findFilesTab();
      if (!t) return { state: 'no-tab' };
      if (!t.ready || !t.viewEl) return { state: 'not-ready' };
      try {
        // Bounded: a guest that never answers is a failed look, not a hung run.
        return await Promise.race([
          t.viewEl.executeJavaScript(
            '({ state: "up", rows: (document.getElementById("rows") || {}).textContent || "",' +
            ' crumbs: (document.getElementById("crumbs") || {}).textContent || "" })'),
          new Promise((r) => setTimeout(() => r({ state: 'exec-slow' }), 3000))
        ]);
      } catch (err) { return { state: 'exec-failed', why: String(err && err.message) }; }
    })()`);
    if (last && last.state === 'up' && last.rows.indexOf(marker) !== -1) {
      return { ok: true, ms: Date.now() - start };
    }
    await sleep(100);
  }
  return { ok: false, ms: Date.now() - start, last };
}

let pass = 0, fail = 0;
const fails = [];
function record(name, res) {
  if (res.ok) pass++;
  else {
    fail++;
    const l = res.last || {};
    fails.push(name + ': no listing after ' + res.ms + ' ms (state ' + l.state +
      (l.crumbs !== undefined ? ', crumbs "' + String(l.crumbs).slice(0, 60) + '"' : '') + ')');
  }
}

(async () => {
  await connect();
  const hasApi = await evalChrome(`typeof openFilesTab === 'function' && typeof filesUrl === 'function'
    && typeof findFilesTab === 'function' && typeof createTab === 'function'`);
  if (!hasApi) throw new Error('app.js globals missing (is this Quartz?)');

  for (let i = 1; i <= ROUNDS; i++) {
    // A. the remembered folder, through the Ctrl+Alt+E route
    await closeFilesTabs();
    await evalChrome(`localStorage.setItem('files.last', ${J(dir)}); openFilesTab()`);
    record('A remembered folder, round ' + i, await waitForMarker());

    // B. the folder in the URL wins over the remembered one
    await closeFilesTabs();
    await evalChrome(`localStorage.setItem('files.last', ${J(os.homedir())}); !!createTab(filesUrl(${J(dir)}))`);
    record('B ?path= folder, round ' + i, await waitForMarker());
  }
  await closeFilesTabs();
  await evalChrome(`localStorage.removeItem('files.last'), true`);
})().catch((err) => { fail++; fails.push('harness error: ' + err.message); }).finally(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* temp */ }
  for (const f of fails) console.log('FAIL ' + f);
  console.log('files-test: ' + pass + ' passed, ' + fail + ' failed');
  try { ws && ws.close(); } catch (err) { /* gone */ }
  process.exit(fail ? 1 : 0);
});
