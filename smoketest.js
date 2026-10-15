try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine (a cloud runner): no cap needed */ }   // first: one capped browser at a time (The user, 2026-09-17)
// Runtime smoke test. Launches the app, drives it over CDP, proves the
// Claude Code terminal actually spawns and renders.
// The window is created OFF-SCREEN (--offscreen, see main.js and testwatch.js) and a 25 ms
// watcher started before launch fails the run if it ever touches the user's screen. Not launched
// under 2.5 GB free RAM. Kills only its own process tree and deletes its own temp profile.
const { spawn, execFileSync } = require('child_process');
const os = require('os');
const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher } = require('./testwatch');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT) || 9222;
const OUT = process.argv[2] || path.join(__dirname, 'smoke');
// --keep leaves the app running (terminal pane open, still off-screen) for CDP
// probes afterwards; kill it by the pid printed at launch when done, never all electron.exe.
const KEEP = process.argv.includes('--keep');
const electron = require('electron'); // path to electron.exe

// Every id the chrome must expose. The first ten are the original contract,
// the rest arrived with the glass redesign.
const REQUIRED_IDS = [
  'tabstrip', 'newtab', 'back', 'forward', 'reload', 'omnibox', 'views',
  'titlebar', 'win-min', 'win-max', 'win-close',
  'theme',     // light/dark toggle
];

const log = [];
// Every check speaks through say(), so the tally lives here: a line that opens
// with OK is a pass, one that opens with FAIL (or a thrown HARNESS ERROR) is a
// failure. Nothing else in the log counts either way.
let okCount = 0;
let failCount = 0;
const say = (m) => {
  const text = String(m);
  if (/^OK\b/.test(text)) okCount += 1;
  else if (/^(FAIL|HARNESS ERROR)\b/.test(text)) failCount += 1;
  log.push(m);
  console.log(m);
};

// The last line of every run, then the transcript, then the exit code: 1 as
// soon as anything failed, so a caller can gate on the run instead of reading.
const finish = () => {
  const line = `smoke: ${okCount} ok, ${failCount} failed`;
  log.push(line);
  console.log(line);
  fs.writeFileSync(OUT + '.txt', log.join('\n'));
  process.exit(failCount ? 1 : 0);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await res.json();
      const page = targets.find(
        (t) => t.type === 'page' && String(t.url).includes('index.html')
      );
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (e) { /* not up yet */ }
    await sleep(500);
  }
  return null;
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
      setTimeout(() => {
        if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + method)); }
      }, 30000);
    });
  return { send, events };
}

const evaluate = async (c, expr) => {
  const r = await c.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) return { error: r.exceptionDetails.text || 'eval threw' };
  return { value: r.result.value };
};

let proc = null;
let watcher = null;
const PROFILE = 'smoke' + process.pid;
// Stop the watcher, kill ONLY our own tree, drop our temp profile (unless --keep).
function teardown() {
  if (watcher) { const v = watcher.verdict(); say((v.ok ? 'OK: ' : 'FAIL: ') + v.line); watcher.stop(); watcher = null; }
  if (proc && !KEEP) {
    try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ }
    const prof = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);
    for (let i = 0; i < 10; i++) { try { fs.rmSync(prof, { recursive: true, force: true }); break; } catch (e) { execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400']); } }
  }
}

(async () => {
  const free = freeRamGb();
  if (!(free >= MIN_FREE_GB)) { console.log('smoke: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }
  watcher = startWatcher();
  await watcher.ready;
  // --test-profile keeps this run's storage out of the real profile (see main.js);
  // --profile-name gives this run its own, deleted afterwards.
  proc = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, '--test-profile', '--profile-name=' + PROFILE, ...OFFSCREEN_ARGS], {
    cwd: __dirname,
    stdio: 'ignore',
    detached: KEEP, // survive this script exiting when --keep is passed
  });
  watcher.watch(proc.pid);
  console.log('electron pid ' + proc.pid + ', profile ' + PROFILE);

  const target = await getPageTarget();
  if (!target) { say('FAIL: app never exposed a CDP page target'); teardown(); finish(); }
  say('OK: app window is up, CDP target found');

  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const c = cdp(ws);

  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Page.enable');
  await sleep(2500);

  // --- 1. chrome UI rendered ---
  const ids = await evaluate(c, `JSON.stringify(
    ${JSON.stringify(REQUIRED_IDS)}.filter(i => !document.getElementById(i))
  )`);
  say(ids.value === '[]' ? `OK: all ${REQUIRED_IDS.length} chrome elements present in the live DOM`
                         : 'FAIL: missing elements ' + ids.value);

  // The strip is built after the durable session copy is read (up to ~300ms),
  // and body.booted lands only then: poll for it before touching any tab.
  let flags = null;
  for (let i = 0; i < 40; i++) {
    flags = await evaluate(c, `JSON.stringify({
      booted: document.body.classList.contains('booted'),
      acrylic: document.body.classList.contains('acrylic'),
      maximized: document.body.classList.contains('maximized'),
    })`);
    if (/"booted":true/.test(String(flags.value))) break;
    await sleep(250);
  }
  say('BODY FLAGS: ' + flags.value);
  if (!/"booted":true/.test(String(flags.value))) say('FAIL: body.booted never set, launch animation would stay stuck');

  // A restored session may already hold Claude panes (they come back as fresh
  // sessions now). Close them so step 3 below measures the one it opens.
  await evaluate(c, `(() => { for (const t of tabs.filter((x) => x.kind === 'claude')) closeTab(t.id); return tabs.length; })()`);

  // --- 2. a tab webview was created and is loading a real page ---
  await sleep(3000);
  const tab = await evaluate(c, `(() => {
    const wv = document.querySelectorAll('#views webview');
    return JSON.stringify({ count: wv.length, src: wv[0] ? wv[0].getAttribute('src') : null });
  })()`);
  say('TAB: ' + tab.value);

  // --- 3. open the Claude pane beside the page (the only way a chamber opens) ---
  // The chamber is still a tab of kind 'claude' in the strip, but only ever as
  // one half of a split with the page it was opened beside.
  const opened = await evaluate(c, `(() => {
    const page = getActiveTab();
    if (!page || page.kind !== 'page') return 'NO_PAGE';
    return String(openClaudeBesideTab(page));
  })()`);
  say('OPEN BESIDE: ' + opened.value);
  await sleep(1500);
  const tabState = await evaluate(c, `JSON.stringify({
    chips: document.querySelectorAll('#tabstrip .tab').length,
    claudeChip: !!document.querySelector('#tabstrip .tab.claude'),
    view: !!document.querySelector('#views .claude-view'),
    viewShown: (() => { const v = document.querySelector('#views .claude-view'); return !!v && getComputedStyle(v).display !== 'none'; })(),
    // The partner's own webview, not just the first one: a restored session
    // can hold other page tabs whose views are rightly hidden.
    pageShown: (() => {
      const chamber = tabs.find((t) => t.kind === 'claude');
      const partner = chamber ? splitPartner(chamber) : null;
      const w = partner && partner.viewEl;
      return !!w && getComputedStyle(w).display !== 'none';
    })(),
    split: (() => {
      const chamber = tabs.find((t) => t.kind === 'claude');
      const partner = chamber ? splitPartner(chamber) : null;
      return !!partner && partner.kind === 'page';
    })(),
  })`);
  say('CLAUDE PANE: ' + tabState.value);
  const ok3 = /"claudeChip":true/.test(tabState.value) && /"viewShown":true/.test(tabState.value)
    && /"pageShown":true/.test(tabState.value) && /"split":true/.test(tabState.value);
  say(ok3 ? 'OK: Claude pane opened, split with the page, both halves on screen'
          : 'FAIL: Claude pane did not open beside the page');

  const xterm = await evaluate(c, `!!document.querySelector('#views .claude-view .xterm')`);
  say(xterm.value === true ? 'OK: xterm.js instance attached inside the Claude pane'
                           : 'FAIL: xterm never attached');

  // --- 4. the money check: did claude.exe actually boot and render? ---
  say('waiting 20s for claude.exe to boot inside the PTY...');
  await sleep(20000);
  const live = await evaluate(c, `JSON.stringify({
    chipLive: !!document.querySelector('#tabstrip .tab.claude.live'),
  })`);
  say('LIVE FLAGS: ' + live.value);
  const buf = await evaluate(c, `(() => {
    const rows = document.querySelector('#views .claude-view .xterm-rows');
    if (!rows) return 'NO_ROWS';
    return (rows.innerText || '').replace(/\\u00a0/g, ' ').trim().slice(0, 600);
  })()`);
  const text = String(buf.value || '');
  say('--- TERMINAL CONTENT ---');
  say(text || '(empty)');
  say('--- END TERMINAL CONTENT ---');
  const booted = /claude|welcome|anthropic|cwd|\/help|>/i.test(text) && text.length > 10;
  say(booted ? 'OK: Claude Code is running inside the browser terminal'
             : 'FAIL: terminal produced no recognisable Claude Code output');

  // --- 5. console errors ---
  const errs = c.events
    .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
    .map((e) => e.params.entry.text);
  say(errs.length ? 'CONSOLE ERRORS: ' + JSON.stringify(errs.slice(0, 6)) : 'OK: no console errors');

  // --- 6. screenshot ---
  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + '.png', Buffer.from(shot.data, 'base64'));
  say('screenshot: ' + OUT + '.png');

  ws.close();
  if (KEEP) {
    say('KEEP: app left running with the Claude pane open');
    proc.unref();
  }
  teardown();
  finish();
})().catch((e) => {
  say('HARNESS ERROR: ' + e.message);
  try { teardown(); } catch (e2) { /* best effort */ }
  finish();
});
