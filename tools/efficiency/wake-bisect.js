// tools/efficiency/wake-bisect.js -- which part of Quartz's main process keeps waking it at idle.
//
//   node tools/efficiency/wake-bisect.js --conds="base;bare:BARE;all:off=ALL;notes:off=notes-pane-main+procfind;d:diag"
//        [--settle=45] [--window=60] [--stagger=3] [--out=wake-out] [--bridge]
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
//   aff=<mask>   CPU affinity of the main process (PowerShell, right after launch)
//   emb[=<lvl>]  Electron's libuv embed thread to abovenormal|highest|timecritical (default), from
//                outside with uvboost.js's own finder, 5 s after launch (plain Electron rows; Quartz
//                rows use env=QUARTZ_UVBOOST=<lvl>, which applies it inside)
// After --settle s the main process's per-thread context switches are read at the start, the
// middle and the end of a --window s window. ctx/s of the main process is the wakeup rate. Every
// row also reports the embed thread (found read-only the same way): its ctx/s, its CPU as % of
// one core, its megacycles/s and its priority at the end, so a raised thread that spins shows.
// On the development laptop (round 4): ONE condition per call, through %TEMP%/thnames/lowrun.js (browser
// lock, RAM and game checks, BelowNormal), with QUARTZ_BENCH_OK=1.
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
      else if (o.startsWith('notes=')) c.sch = o.slice(6).split('+').join(',');
      else if (o.startsWith('repro=')) { c.bare = true; c.repro = o.slice(6); }
      else if (o.startsWith('aff=')) c.aff = Number(o.slice(4));
      else if (o.startsWith('boost=')) console.log('wake-bisect: ' + name + ': boost= was removed in round 4 (uvboost.js has no main-thread variants now); running without it');
      else if (o === 'emb') c.emb = 'timecritical';
      else if (o.startsWith('emb=')) c.emb = o.slice(4).toLowerCase();
    }
    return c;
  });
}

function launch(c) {
  const env = Object.assign({}, process.env, { QWAKE_OFF: c.off, QWAKE_NO: c.no, QWAKE_NOTES: c.sch, QWAKE_AB: c.ab }, c.env);
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

// aff=<mask>: the process's CPU affinity, applied from OUTSIDE right after launch (PowerShell on the PID).
function applyTweaks(c) {
  if (!c.aff) return;
  const cmd = '(Get-Process -Id ' + c.pid + ').ProcessorAffinity = ' + Math.floor(c.aff) + "; 'aff ok ' + (Get-Process -Id " + c.pid + ').ProcessorAffinity';
  try {
    c.tweak = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim().replace(/\s+/g, ' ');
  } catch (e) { c.tweak = 'tweak failed: ' + String(e && e.message).slice(0, 200); }
  console.log('tweak ' + c.name + ': ' + c.tweak);
}

// emb / emb=<abovenormal|highest|timecritical>: uvboost.js's own finder and SetThreadPriority, from
// OUTSIDE (koffi in this node), 5 s after launch -- for plain Electron (repro=, BARE), which does
// not load uvboost. Quartz rows get it inside with env=QUARTZ_UVBOOST=<level>.
const ub = require(path.join(REPO, 'uvboost.js'));
async function raiseEmbed(list) {
  for (const c of list) {
    await sleep(Math.max(0, c.launchedAt + 5000 - Date.now()));
    const r = ub.boostProcess(c.pid, c.emb);
    const t = r.ok ? 'emb ' + c.emb + ' ok tid=' + r.tid + ' was=' + r.was + ' now=' + r.now : 'emb ' + c.emb + ' FAILED: ' + r.why;
    c.tweak = (c.tweak ? c.tweak + ' ' : '') + t;
    console.log('emb ' + c.name + ': ' + t);
  }
}

// Every row: the embed thread (found the same way, read-only), its CPU time and cycles at the
// window's start and end, so a raised thread that burns CPU shows up.
function embedReading(c) {
  try {
    if (c.embTid === undefined) { const f = ub.findEmbed(c.pid, ub.load()); c.embTid = f.tid || null; if (!f.tid) c.embWhy = f.why; }
    return c.embTid ? Object.assign({ t: Date.now() }, ub.threadCpu(c.embTid, ub.load())) : null;
  } catch (e) { c.embWhy = String(e && e.message); return null; }
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
  // The sampler runs and the chrome gets every sample, but nothing is pushed into the Home guest
  // (no webview.executeJavaScript round trip through main once a second).
  statsnopush: '(pushStatsToTab = function () {}, statsApi().subscribe(), "stats subscribed, no guest push")',
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

// libuv's loop counters over the window, from the qwake-uvm lines the instance printed to its log
// (wake-hook.js / timer-repro.js): uv_run iterations/s and completion packets taken/s.
function uvmRate(c, win) {
  try {
    const pts = fs.readFileSync(path.join(OUT, 'log-' + c.name + '.txt'), 'utf8').split(/\r?\n/)
      .filter((l) => l.startsWith('qwake-uvm ')).map((l) => JSON.parse(l.slice(10)))
      .filter((p) => p.t >= win[0] - 5000 && p.t <= win[1] + 5000);
    if (pts.length < 2) return null;
    const a = pts[0], b = pts[pts.length - 1], dt = (b.t - a.t) / 1000;
    return { loopPerS: Math.round((b.loop - a.loop) / dt), eventsPerS: +((b.ev - a.ev) / dt).toFixed(1), s: Math.round(dt) };
  } catch (e) { return null; }
}

// The embed thread over the window: its wakeups/s, CPU as % of one core, megacycles/s, priority at the end.
function embedRate(c, s0, s2) {
  if (!c.embTid) return c.embWhy ? { why: c.embWhy } : null;
  const a = c.e0, b = c.e2;
  const ms = a && b ? b.t - a.t : 0;
  const ctxOf = (s) => { const p = s && s.p[String(c.pid)]; const row = p && p.th.find((x) => x[0] === c.embTid); return row ? row[1] : null; };
  const ca = ctxOf(s0), cb = ctxOf(s2);
  const dt = s0 && s2 ? (s2.t - s0.t) / 1000 : 0;
  return { tid: c.embTid, level: b && b.priority != null ? ({ 0: 'Normal', 1: 'AboveNormal', 2: 'Highest', 15: 'TimeCritical' })[b.priority] || String(b.priority) : '?',
    ctxPerS: ca != null && cb != null && dt > 0 ? Math.round((cb - ca) / dt) : null,
    cpuPct: a && b && a.cpu100ns != null && b.cpu100ns != null && ms > 0 ? +(ub.cpuShare(a, b, ms) * 100).toFixed(3) : null,
    mcycPerS: a && b && a.cycles != null && b.cycles != null && ms > 0 ? +((b.cycles - a.cycles) / 1e6 / (ms / 1000)).toFixed(2) : null };
}

(async () => {
  // --conds-file: one condition per line (# comments), so no shell has to carry ';' or ':'.
  const spec = argv['conds-file']
    ? fs.readFileSync(path.resolve(REPO, argv['conds-file']), 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).join(';')
    : argv.conds;
  const conds = parseConds(spec);
  console.log('wake-bisect: ' + conds.length + ' conditions, settle ' + SETTLE + ' s, window ' + WINDOW + ' s');
  // --bridge: tools/efficiency/fake-bridge.js on 8787 for the whole run (every condition sees a
  // live Spotify bridge, as on the development machine); killed with the instances.
  let bridge = null;
  let winT = [0, 0];
  if (argv.bridge) {
    bridge = spawn(process.execPath, [path.join(__dirname, 'fake-bridge.js'), '--port=8787'], { cwd: REPO, stdio: ['ignore', fs.openSync(path.join(OUT, 'log-fake-bridge.txt'), 'w'), 'ignore'], windowsHide: true });
    await sleep(1000);
    console.log('wake-bisect: fake bridge up (pid ' + bridge.pid + ')');
  }
  try {
    for (const c of conds) { launch(c); await sleep(1500); applyTweaks(c); await sleep(Math.max(0, STAGGER * 1000 - 1500)); }
    await Promise.all(conds.map(bootCheck).concat([raiseEmbed(conds.filter((c) => c.emb))]));
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
    for (const c of conds) c.e0 = embedReading(c);
    const s0 = readThreads(pids);
    await sleep(WINDOW * 500);
    const s1 = readThreads(pids);
    await sleep(WINDOW * 500);
    const s2 = readThreads(pids);
    for (const c of conds) c.e2 = embedReading(c);
    winT = [s0 && s0.t, s2 && s2.t];
    for (const c of conds) {
      c.whole = rate(s0, s2, String(c.pid));
      c.half1 = rate(s0, s1, String(c.pid));
      c.half2 = rate(s1, s2, String(c.pid));
      c.embed = embedRate(c, s0, s2);
    }
    if (conds.some((c) => c.diag)) await sleep(15000); // the diag instance writes at settle+5+20 s
  } finally {
    for (const c of conds) { if (c.pid) { try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ } } }
    if (bridge) { try { execFileSync('taskkill', ['/PID', String(bridge.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ } }
  }
  const rows = conds.map((c) => ({ name: c.name, off: c.off, no: c.no, sch: c.sch, diag: c.diag, boot: c.boot,
    mainCtxPerS: c.whole && c.whole.ctxPerS, halves: [c.half1 && c.half1.ctxPerS, c.half2 && c.half2.ctxPerS],
    topThreads: c.whole && c.whole.top, mainCpuSper10min: c.whole && c.whole.cpuSper10min, tree: c.whole && c.whole.tree, pages: c.pages, ab: c.ab, url: c.url, env: c.env, focus: c.focusResult, tweak: c.tweak, uvm: uvmRate(c, winT), embed: c.embed }));
  fs.writeFileSync(path.join(OUT, 'wake-result.json'), JSON.stringify({ settle: SETTLE, window: WINDOW, cpus: os.cpus().length, rows }, null, 1));
  console.log('name                 boot  main ctx/s [half1 half2]  top threads        main CPU s/10min  tree: procs ctx/s CPU s/10min  off / no');
  for (const r of rows) {
    console.log(String(r.name).padEnd(20) + ' ' + String(r.boot).slice(0, 5).padEnd(5) + ' ' + String(r.mainCtxPerS).padStart(6) + ' [' + r.halves.join(' ') + ']'.padEnd(4) +
      '  ' + JSON.stringify(r.topThreads).padEnd(18) + ' ' + String(r.mainCpuSper10min).padStart(8) + '  ' + (r.tree ? String(r.tree.procs).padStart(3) + ' ' + String(r.tree.ctxPerS).padStart(6) + ' ' + String(r.tree.cpuSper10min).padStart(7) : '      -') + '  ' + (r.off || '-') + ' / ' + (r.no || '-') + (r.sch ? ' / notes ' + r.sch : '') + (r.diag ? ' (diag)' : '') +
      (r.uvm ? '  uv ' + r.uvm.loopPerS + ' loops/s ' + r.uvm.eventsPerS + ' ev/s' : '') +
      (r.embed ? '  emb t' + r.embed.tid + ' ' + r.embed.level + ' ' + r.embed.ctxPerS + ' ctx/s ' + r.embed.cpuPct + '% core ' + r.embed.mcycPerS + ' Mcyc/s' : '  emb ?') + (r.tweak ? '  [' + String(r.tweak).slice(0, 90) + ']' : ''));
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
