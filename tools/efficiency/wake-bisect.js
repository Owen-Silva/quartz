// tools/efficiency/wake-bisect.js -- which part of Quartz's main process keeps waking it at idle.
//
//   node tools/efficiency/wake-bisect.js --conds="base;bare:BARE;all:off=ALL;school:off=school+procfind;d:diag"
//        [--settle=45] [--window=60] [--stagger=3] [--out=wake-out]
//
// RUNNER ONLY (CI=true or QUARTZ_BENCH_OK=1): it starts several Quartz instances at once and kills
// each one it started by PID tree. Never on the user's laptop.
//
// Every condition is its own Quartz (Home, no tabs) with its own --test-profile, off-screen and
// never focused, all running AT THE SAME TIME. Each is launched as
//   electron.exe -r tools/efficiency/wake-hook.js . --test-profile ... (Electron's own --require)
// and the condition's options go to wake-hook.js through env:
//   off=a+b      stub those modules (QWAKE_OFF; ALL = every ./x main.js requires)
//   no=fswatch   neutralize a Node API (QWAKE_NO)
//   diag         async_hooks + live handles dump (QWAKE_DIAG): its rate is NOT comparable
//   snap         a live handles dump only (cheap; rate stays comparable)
//   nohook       launch without -r at all
//   BARE         plain Electron (bare-main.js --acrylic --webview), the framework's floor
//   ab=<name>    every module main.js requires that has tools/efficiency/ab/<mod>-<name>.js loads that
//                copy instead (QWAKE_AB): an older build in the same run
//   url=<u>      open one tab on <u> (the argv URL), on top of Home
//   env=K=V      one extra environment variable (e.g. TOPROW_PIPE=<a pipe nobody serves>: toprow
//                then retries every 2 s, as it does on a machine without Mantle)
//   focus        --focus-at s after boot, tell the chrome its window is focused (CDP: windowBlurred =
//                false, then the same sync calls the real focus edge makes), so Home's stats card
//                subscribes and the 1 s sampler runs. The OS-level focus itself is not simulated.
// After --settle s the main process's per-thread context switches are read at the start, the
// middle and the end of a --window s window. ctx/s of the main process is the wakeup rate.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
const num = (k, d) => (argv[k] !== undefined && isFinite(Number(argv[k])) ? Number(argv[k]) : d);
const SETTLE = num('settle', 45), WINDOW = num('window', 60), STAGGER = num('stagger', 3), FOCUS_AT = num('focus-at', 12);
const OUT = path.resolve(argv.out || 'wake-out');
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const HOOK = path.join(__dirname, 'wake-hook.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!(process.env.CI === 'true' || process.env.QUARTZ_BENCH_OK === '1')) {
  console.error('wake-bisect: runner only (set CI=true). It starts and kills browsers.');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

function parseConds(s) {
  return String(s || 'base;bare:BARE').split(';').map((x) => x.trim()).filter(Boolean).map((spec, i) => {
    const cut = spec.indexOf(':');
    const name = cut < 0 ? spec : spec.slice(0, cut), opts = cut < 0 ? '' : spec.slice(cut + 1);
    const c = { i, name, off: '', no: '', sch: '', ab: '', url: '', env: {}, focus: false, diag: false, snap: false, nohook: false, bare: false, port: 9600 + i };
    for (const o of opts.split(',').map((y) => y.trim()).filter(Boolean)) {
      if (o === 'BARE') c.bare = true;
      else if (o === 'diag') c.diag = true;
      else if (o === 'focus') c.focus = 'full';
      else if (o.startsWith('focus=')) c.focus = o.slice(6);
      else if (o.startsWith('ab=')) c.ab = o.slice(3);
      else if (o.startsWith('url=')) c.url = o.slice(4);
      else if (o.startsWith('env=')) { const kv = o.slice(4); const e = kv.indexOf('='); c.env[kv.slice(0, e)] = kv.slice(e + 1); }
      else if (o === 'snap') c.snap = true;
      else if (o === 'nohook') c.nohook = true;
      else if (o.startsWith('off=')) c.off = o.slice(4).split('+').join(',');
      else if (o.startsWith('no=')) c.no = o.slice(3).split('+').join(',');
      else if (o.startsWith('sch=')) c.sch = o.slice(4).split('+').join(',');
      else if (o.startsWith('repro=')) { c.bare = true; c.repro = o.slice(6); }
    }
    return c;
  });
}

function launch(c) {
  const env = Object.assign({}, process.env, { QWAKE_OFF: c.off, QWAKE_NO: c.no, QWAKE_SCHOOL: c.sch, QWAKE_AB: c.ab }, c.env);
  const at = SETTLE + 5;
  if (c.diag) Object.assign(env, { QWAKE_DIAG: path.join(OUT, 'diag-' + c.name + '.json'), QWAKE_DIAG_AT: String(at), QWAKE_DIAG_FOR: '20' });
  if (c.snap) Object.assign(env, { QWAKE_SNAP: path.join(OUT, 'snap-' + c.name + '.json'), QWAKE_DIAG_AT: String(at) });
  let args;
  if (c.repro) args = [path.join(__dirname, 'timer-repro.js'), '--timers=' + c.repro];
  else if (c.bare) args = [path.join(__dirname, 'bare-main.js'), '--acrylic', '--webview'];
  else {
    args = c.nohook ? [] : ['-r', HOOK];
    args.push('.', '--remote-debugging-port=' + c.port, '--test-profile', '--profile-name=wake' + c.i + 'p' + process.pid,
      '--offscreen', '--show-inactive', '--measure-visible');
    if (c.url) args.push(c.url);
  }
  const log = fs.openSync(path.join(OUT, 'log-' + c.name + '.txt'), 'w');
  const child = spawn(ELECTRON, args, { cwd: REPO, env, stdio: ['ignore', log, log], windowsHide: true });
  c.pid = child.pid;
  c.launchedAt = Date.now();
}

async function bootCheck(c) {
  if (c.bare) { c.boot = 'bare'; return; }
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + c.port + '/json')).json();
      const pages = list.filter((x) => x.type === 'page' || x.type === 'webview').map((x) => String(x.url).replace(/^.*[\\/]/, '').slice(0, 40));
      if (pages.some((u) => /index\.html/.test(u))) { c.boot = 'ok'; c.pages = pages; return; }
    } catch (e) { /* not up */ }
    await sleep(200);
  }
  c.boot = 'NO CHROME PAGE';
}

// One Runtime.evaluate in the chrome page (index.html) of a condition's instance.
async function cdpEval(port, expr) {
  const WebSocket = require(path.join(REPO, 'node_modules', 'ws'));
  const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(String(t.url)));
  if (!page) return 'no chrome page';
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const out = await new Promise((resolve) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id === 1) resolve(m.result && m.result.result && 'value' in m.result.result ? m.result.result.value : JSON.stringify(m.error || m.result).slice(0, 300));
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    setTimeout(() => resolve('cdp timeout'), 5000);
  });
  try { ws.close(); } catch (e) { /* gone */ }
  return out;
}
// focus=<part>: only one of the things the real focus edge starts. stats = the stats sampler alone
// (subscribe through the chrome's API, the window stays blurred); board = Home's board un-paused;
// idle = the music player and the now-playing poll (syncIdlePresence).
const FOCUS_PART = {
  stats: '(statsApi().subscribe(), "stats subscribed")',
  board: '(windowBlurred = false, syncBoardPause(), "board un-paused")',
  idle: '(windowBlurred = false, syncIdlePresence(), "idle presence synced")',
};
const FOCUS_EXPR = '(windowBlurred = false, syncBoardPause(), syncStatsSubscription(), ' +
  'JSON.stringify({ statsSubscribed, tabs: tabs.length, active: String((getActiveTab() || {}).url || "").slice(-40) }))';

function readThreads(pids) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'wake-threads.ps1'), '-Pids', pids.join(',')], { encoding: 'utf8', windowsHide: true, timeout: 90000 });
  return JSON.parse(out.trim().split('\n').pop());
}

function rate(a, b, pid) {
  const pa = a.p[pid], pb = b.p[pid];
  if (!pa || !pb || !pb.th.length) return null;
  const dt = (b.t - a.t) / 1000;
  const old = new Map(pa.th.map((x) => [x[0], x[1]]));
  const per = pb.th.map((x) => [x[0], (x[1] - (old.get(x[0]) || 0)) / dt]).sort((x, y) => y[1] - x[1]);
  const total = per.reduce((s, x) => s + x[1], 0);
  // The whole tree: CPU per pid (a process that started inside the window counts all its CPU; one
  // that ended inside it loses what it used since the first reading), switches summed.
  let tree = null;
  if (pa.tree && pb.tree) {
    const before = new Map(pa.tree.pids.map((x) => [x[0], x[1]]));
    const cpu100ns = pb.tree.pids.reduce((s, x) => s + Math.max(0, x[1] - (before.get(x[0]) || 0)), 0);
    tree = { procs: pb.tree.n, cpuSper10min: +(cpu100ns / 1e7 / dt * 600).toFixed(2), ctxPerS: Math.round((pb.tree.ctx - pa.tree.ctx) / dt) };
  }
  return { ctxPerS: Math.round(total), top: per.slice(0, 3).map((x) => Math.round(x[1])), threads: per.length,
    cpuSper10min: pa.cpu >= 0 && pb.cpu >= 0 ? +((pb.cpu - pa.cpu) / dt * 600).toFixed(2) : null, tree };
}

(async () => {
  // --conds-file: one condition per line (# comments), so no shell has to carry ';' or ':'.
  const spec = argv['conds-file']
    ? fs.readFileSync(path.resolve(REPO, argv['conds-file']), 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).join(';')
    : argv.conds;
  const conds = parseConds(spec);
  console.log('wake-bisect: ' + conds.length + ' conditions, settle ' + SETTLE + ' s, window ' + WINDOW + ' s');
  try {
    for (const c of conds) { launch(c); await sleep(STAGGER * 1000); }
    await Promise.all(conds.map(bootCheck));
    if (conds.some((c) => c.focus)) {
      await sleep(FOCUS_AT * 1000);
      for (const c of conds.filter((x) => x.focus && x.boot === 'ok')) {
        try { c.focusResult = await cdpEval(c.port, FOCUS_PART[c.focus] || FOCUS_EXPR); } catch (e) { c.focusResult = 'focus failed: ' + (e && e.message); }
        console.log('focus ' + c.name + ': ' + c.focusResult);
      }
    }
    const since = Math.max(...conds.map((c) => c.launchedAt));
    await sleep(Math.max(0, SETTLE * 1000 - (Date.now() - since)));
    const pids = conds.map((c) => c.pid);
    const s0 = readThreads(pids);
    await sleep(WINDOW * 500);
    const s1 = readThreads(pids);
    await sleep(WINDOW * 500);
    const s2 = readThreads(pids);
    for (const c of conds) {
      c.whole = rate(s0, s2, String(c.pid));
      c.half1 = rate(s0, s1, String(c.pid));
      c.half2 = rate(s1, s2, String(c.pid));
    }
    if (conds.some((c) => c.diag)) await sleep(15000); // the diag instance writes at settle+5+20 s
  } finally {
    for (const c of conds) { if (c.pid) { try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ } } }
  }
  const rows = conds.map((c) => ({ name: c.name, off: c.off, no: c.no, sch: c.sch, diag: c.diag, boot: c.boot,
    mainCtxPerS: c.whole && c.whole.ctxPerS, halves: [c.half1 && c.half1.ctxPerS, c.half2 && c.half2.ctxPerS],
    topThreads: c.whole && c.whole.top, mainCpuSper10min: c.whole && c.whole.cpuSper10min, tree: c.whole && c.whole.tree, pages: c.pages, ab: c.ab, url: c.url, env: c.env, focus: c.focusResult }));
  fs.writeFileSync(path.join(OUT, 'wake-result.json'), JSON.stringify({ settle: SETTLE, window: WINDOW, cpus: os.cpus().length, rows }, null, 1));
  console.log('name                 boot  main ctx/s [half1 half2]  top threads        main CPU s/10min  tree: procs ctx/s CPU s/10min  off / no');
  for (const r of rows) {
    console.log(String(r.name).padEnd(20) + ' ' + String(r.boot).slice(0, 5).padEnd(5) + ' ' + String(r.mainCtxPerS).padStart(6) + ' [' + r.halves.join(' ') + ']'.padEnd(4) +
      '  ' + JSON.stringify(r.topThreads).padEnd(18) + ' ' + String(r.mainCpuSper10min).padStart(8) + '  ' + (r.tree ? String(r.tree.procs).padStart(3) + ' ' + String(r.tree.ctxPerS).padStart(6) + ' ' + String(r.tree.cpuSper10min).padStart(7) : '      -') + '  ' + (r.off || '-') + ' / ' + (r.no || '-') + (r.sch ? ' / school ' + r.sch : '') + (r.diag ? ' (diag)' : ''));
  }
  for (const f of fs.readdirSync(OUT).filter((x) => /^(diag|snap)-/.test(x))) {
    const d = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    console.log('\n== ' + f + ' stubbed=' + JSON.stringify(d.stubbed) + (d.elu ? ' elu=' + JSON.stringify(d.elu) : ''));
    const snaps = d.snaps || [d];
    const last = snaps[snaps.length - 1] || {};
    const tally = {};
    for (const r of [].concat(last.resources || [])) tally[r] = (tally[r] || 0) + 1;
    console.log('resources: ' + JSON.stringify(tally));
    for (const h of [].concat(last.handles || [])) if (h.type !== 'Timeout' || h.ms < 1000) console.log('  handle ' + JSON.stringify(h));
    for (const t of [].concat(last.timers || [])) console.log('  timer ' + t.ms + 'ms' + (t.repeat ? ' rep' : '') + (t.ref === false ? ' unref' : '') + '  ' + String(t.site).slice(0, 200));
    console.log('  requests: ' + JSON.stringify(last.requests));
    if (d.inits) console.log('inits in ' + d.windowMs + ' ms: ' + JSON.stringify(d.inits));
    if (d.stacks) for (const [k, n] of Object.entries(d.stacks).slice(0, 25)) console.log('  ' + String(n).padStart(6) + '  ' + k.slice(0, 300));
    if (d.errors && d.errors.length) console.log('errors: ' + d.errors.slice(0, 3).join('\n'));
  }
  for (const c of conds) {
    if (c.boot !== 'ok' && !c.bare) {
      try { console.log('\n-- log ' + c.name + ':\n' + fs.readFileSync(path.join(OUT, 'log-' + c.name + '.txt'), 'utf8').split('\n').slice(-15).join('\n')); } catch (e) { /* none */ }
    }
  }
  console.log('\nwake-bisect: done');
})().catch((e) => { console.error('wake-bisect FAILED: ' + (e && e.stack)); process.exit(1); });
