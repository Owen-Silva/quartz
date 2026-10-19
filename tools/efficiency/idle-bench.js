// tools/efficiency/idle-bench.js -- Quartz vs Edge at idle: private working set MB, CPU seconds and
// context switches (the wakeup proxy) over an idle window, plus a probe of Quartz's own idle work.
//
//   node tools/efficiency/idle-bench.js [--plan=measure|ab] [--idle=600] [--settle=60] [--load=90]
//        [--reps=2] [--every=30] [--out=eff-out] [--app-b=<dir>] [--max-min=22]
//
// RUNNER ONLY. It starts a dozen browsers at once and kills each one it started by PID tree at the
// end, so it must never run on the user's laptop (his live Quartz runs from ~/browser). It refuses to
// start unless CI=true or QUARTZ_BENCH_OK=1.
//
// Every condition runs as its own browser instance, all of them AT THE SAME TIME, so every
// instance sees the same network, the same minute and the same box. Each condition runs --reps
// times (separate instances, separate profiles). Timeline: launch (staggered 3 s) -> open the tabs
// -> wait --load s -> sleep tabs where the condition says so -> wait --settle s -> the idle window
// (--idle s) -> read everything -> kill.
//
// Quartz: electron.exe from the app dir, --test-profile with its own --profile-name, off-screen and
// never focused, with --measure-visible (Windows occlusion tracking off, so it renders as a visible
// window would). Edge: msedge.exe with a fresh --user-data-dir, --no-first-run, the same occlusion
// switch, 1280x820 like Quartz's default window. Every other setting is each browser's default
// (Quartz: tab sleep 30 min, its ad blocker; Edge: tracking prevention balanced, sleeping tabs 2 h).
//
// Numbers per instance, over the process TREE of its main process (every process it started):
//   wsPrivMB   sum of WorkingSetPrivate at the end of the window (Task Manager's Memory column)
//   commitMB   sum of PrivateBytes at the same sample
//   cpuS       CPU seconds (user+kernel) used inside the window, scaled to exactly --idle seconds
//   ctxPerS    context switches per second inside the window (each is a thread being woken)
// sampler.ps1 reads the counters every --every s; a process that ends inside the window keeps the
// CPU it had at its last sample.
//
// Plans:
//   measure  Q-10 Q-10-slept E-10 Q-1 E-1 Q-home E-ntp, x reps, plus P-10 and P-home: Quartz with
//            the probes on (probe.js: main-process timers/IPC/spawns/fetches through --inspect, the
//            chrome page's and the Home page's timers and rAF, a CPU profile of each, and
//            Performance.getMetrics of every guest). P-* numbers are NOT comparable: probes cost.
//   ab       Q-10 and Q-home for the app in this tree (A) and the one in --app-b (B), x reps, plus
//            P-home for both.
//   full     what the 2026-10-15 Q3 run used: --make-a=<dir of master's files> builds the
//            baseline copy next to this tree; Q-10 E-10 Q-1 E-1 Q-home B:Q-home x reps, then
//            Q-10-slept E-ntp B:Q-1 Q-1-onscreen X-bare X-acrylic-webview P-home once each.
//            B:* run this tree (the fix); X-* are plain Electron (bare-main.js).
//   Every instance runs in its own job object (jobhost.ps1), so jobCpuS counts short-lived
//   children too and "procs started" counts every process it launched in the window.
//
// The 2026-10-15 run: cloudtest --recipe quartz-core --timeout 32 --artifacts "eff-out/**" --
//   "node tools/efficiency/idle-bench.js --plan=full --make-a=.ab-a --reps=2 --idle=600 --settle=30
//    --load=60 --every=30 --out=eff-out --max-min=27"   (.ab-a = git show master:notes-pane-main.js)
//   job 18:33 on a 2-vCPU / 8 GB windows-latest runner.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const { Cdp } = require(path.join(REPO, 'tests', 'e2e-kit'));
const { OFFSCREEN_ARGS } = require(path.join(REPO, 'testwatch'));
const { RENDERER_PROBE, RENDERER_READ, MAIN_PROBE, MAIN_READ, foldProfile } = require('./probe');

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
const num = (k, d) => (argv[k] !== undefined && isFinite(Number(argv[k])) ? Number(argv[k]) : d);
const IDLE_S = num('idle', 600), SETTLE_S = num('settle', 60), LOAD_S = num('load', 90), REPS = num('reps', 2), EVERY_S = num('every', 30);
const OUT = path.resolve(argv.out || 'eff-out');
const PLAN = argv.plan || 'measure';
const APP_A = REPO;
let APP_B = argv['app-b'] ? path.resolve(argv['app-b']) : null;
// --make-a=<overlay dir>: build the "A" app next to this tree (a copy without node_modules,
// which is junctioned back, with the overlay's files on top) and use it as --app-b. In --plan=full
// that copy is the BASELINE (master), and this tree is the fix.
let APP_B_IS_A = null;
if (argv['make-a']) {
  const overlay = path.resolve(argv['make-a']);
  const dest = path.join(path.dirname(REPO), 'quartz-A');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(REPO, dest, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git|eff-out|\.cloudtest)([\\/]|$)/.test(path.relative(path.dirname(REPO), src)) || path.relative(REPO, src) === '' });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dest, 'node_modules'), 'junction');
  for (const f of fs.readdirSync(overlay)) {
    if (f.endsWith('.delete')) fs.rmSync(path.join(dest, f.slice(0, -'.delete'.length)), { force: true });
    else fs.copyFileSync(path.join(overlay, f), path.join(dest, f));
  }
  APP_B = dest;
}
APP_B_IS_A = APP_B;
const MAX_MIN = num('max-min', 22);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (l) => console.log('[bench ' + new Date().toISOString().slice(11, 19) + '] ' + l);

if (!(process.env.CI === 'true' || process.env.QUARTZ_BENCH_OK === '1')) {
  console.log('idle-bench: refused: runner only (set CI=true there). It launches a dozen browsers and kills them by PID.');
  process.exit(3);
}

const SITES = [
  'https://en.wikipedia.org/wiki/Ice_baking',
  'https://github.com/electron/electron',
  'https://news.ycombinator.com/',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
  'https://www.bbc.com/news',
  'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array',
  'https://www.weather.gov/',
  'https://www.theverge.com/',
  'https://docs.python.org/3/tutorial/index.html',
  'https://www.apple.com/',
];

const ELECTRON = (app) => path.join(app, 'node_modules', 'electron', 'dist', 'electron.exe');
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));

function plan() {
  const list = [];
  const add = (cond, browser, setup, extra) => list.push(Object.assign({ cond, browser, setup }, extra || {}));
  if (PLAN === 'full') {
    // Q-* / P-* run the "A" app (this tree with the --overlay-a files put back: master's code);
    // B:* run this tree as it is (the fix). X-* are the plain-Electron controls.
    if (!APP_B) throw new Error('--plan=full needs --app-b (made by --make-a)');
    for (let r = 0; r < REPS; r++) {
      add('Q-10', 'quartz', 'sites10', { app: APP_B_IS_A }); add('E-10', 'edge', 'sites10');
      add('Q-1', 'quartz', 'site1', { app: APP_B_IS_A }); add('E-1', 'edge', 'site1');
      add('Q-home', 'quartz', 'home', { app: APP_B_IS_A }); add('B:Q-home', 'quartz', 'home', { app: REPO });
    }
    add('Q-10-slept', 'quartz', 'sites10-slept', { app: APP_B_IS_A }); add('E-ntp', 'edge', 'ntp');
    add('B:Q-1', 'quartz', 'site1', { app: REPO });
    add('Q-1-onscreen', 'quartz', 'site1', { app: APP_B_IS_A, onscreen: true });
    add('X-bare', 'bare', 'bare'); add('X-acrylic-webview', 'bare', 'bare-acrylic');
    add('P-home', 'quartz', 'home', { app: APP_B_IS_A, profiled: true });
    return list;
  }
  if (PLAN === 'ab') {
    if (!APP_B) throw new Error('--plan=ab needs --app-b');
    for (let r = 0; r < REPS; r++) {
      add('A:Q-10', 'quartz', 'sites10', { app: APP_A }); add('B:Q-10', 'quartz', 'sites10', { app: APP_B });
      add('A:Q-home', 'quartz', 'home', { app: APP_A }); add('B:Q-home', 'quartz', 'home', { app: APP_B });
    }
    add('A:P-home', 'quartz', 'home', { app: APP_A, profiled: true }); add('B:P-home', 'quartz', 'home', { app: APP_B, profiled: true });
    return list;
  }
  for (let r = 0; r < REPS; r++) {
    add('Q-10', 'quartz', 'sites10'); add('E-10', 'edge', 'sites10');
    add('Q-10-slept', 'quartz', 'sites10-slept');
    add('Q-1', 'quartz', 'site1'); add('E-1', 'edge', 'site1');
    add('Q-home', 'quartz', 'home'); add('E-ntp', 'edge', 'ntp');
  }
  add('P-10', 'quartz', 'sites10', { profiled: true });
  add('P-home', 'quartz', 'home', { profiled: true });
  return list;
}

/* ---- the job host (jobhost.ps1): every browser in its own job object -------------------------- */
const jobhost = (() => {
  let ps = null, buf = '';
  const waiters = [];
  const start = () => new Promise((resolve, reject) => {
    ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'jobhost.ps1')], { stdio: ['pipe', 'pipe', 'inherit'] });
    ps.on('error', reject);
    ps.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (l === 'ready') { resolve(); continue; }
        const w = waiters.findIndex((x) => l.startsWith(x.prefix) || l.startsWith('error'));
        if (w >= 0) waiters.splice(w, 1)[0].resolve(l);
      }
    });
  });
  // One command at a time: the host answers in order.
  let chain = Promise.resolve();
  const ask = (line, prefix, ms) => (chain = chain.then(() => new Promise((resolve) => {
    const t = setTimeout(() => resolve('error timeout ' + prefix), ms || 30000);
    waiters.push({ prefix, resolve: (l) => { clearTimeout(t); resolve(l); } });
    ps.stdin.write(line + '\n');
  })));
  const quote = (a) => (/[\s"]/.test(a) ? '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"' : a);
  return {
    start,
    async launch(id, exe, args, cwd) {
      const l = await ask(['launch', id, exe, [exe, ...args].map(quote).join(' '), cwd].join('\t'), 'launched ' + id + ' ');
      const m = /^launched \S+ (\d+) (\d) (\S+)/.exec(l);
      if (!m || m[1] === '0') throw new Error('job launch failed: ' + l);
      return { pid: Number(m[1]), inJob: m[2] === '1', err: m[3] };
    },
    async acct() { const l = await ask('acct', 'acct '); try { return JSON.parse(l.slice(5)); } catch (e) { return {}; } },
    async threads(pids) { const l = await ask('threads ' + pids.join(','), 'threads ', 90000); try { return JSON.parse(l.slice(8)); } catch (e) { return null; } },
    kill(id) { return ask('kill ' + id, 'killed ' + id); },
    quit() { try { ps.stdin.write('quit\n'); } catch (e) { /* gone */ } },
  };
})();

/** Per-thread context switches between two `threads` dumps, top threads first, with the module
 *  each thread started in (its start address inside that module's range). */
function threadDiff(a, b, pid, dtS) {
  const ta = new Map(((a && a.threads && a.threads[pid]) || []).map((t) => [t[0], t]));
  const tb = (b && b.threads && b.threads[pid]) || [];
  const mods = ((b && b.modules && b.modules[pid]) || []).map((m) => ({ name: m[0], base: BigInt('0x' + m[1]), size: BigInt(m[2]) }));
  const modOf = (hex) => { try { const x = BigInt('0x' + hex); const m = mods.find((mm) => x >= mm.base && x < mm.base + mm.size); return m ? m.name : '?' + hex; } catch (e) { return '?'; } };
  const rows = tb.map((t) => { const o = ta.get(t[0]); return { tid: t[0], ctxPerS: +(((t[1] - (o ? o[1] : 0)) / dtS)).toFixed(1), cpuS: +((t[2] - (o ? o[2] : 0)) / 1e7).toFixed(2), start: modOf(t[3]), wait: t[4], new: !o }; });
  rows.sort((x, y) => y.ctxPerS - x.ctxPerS);
  return { threads: tb.length, top: rows.slice(0, 10) };
}

/* ---- launching ------------------------------------------------------------------------------- */
async function launchBare(inst) {
  const args = [path.join(__dirname, 'bare-main.js')];
  if (inst.setup === 'bare-acrylic') args.push('--acrylic', '--webview');
  const r = await jobhost.launch(String(inst.i), ELECTRON(REPO), args, REPO);
  inst.pid = r.pid; inst.inJob = r.inJob;
  await sleep(4000);
}
const getJson = async (port, p) => (await fetch('http://127.0.0.1:' + port + (p || '/json'))).json();

async function launchQuartz(inst) {
  const app = inst.app || APP_A;
  inst.profile = 'bench' + inst.i + 'p' + process.pid;
  const args = [];
  if (inst.profiled) args.push('--inspect=' + inst.inspectPort);
  // --onscreen: the window where Windows puts it (the runner's desktop), not parked off-screen.
  const place = inst.onscreen ? OFFSCREEN_ARGS.filter((a) => a !== '--offscreen') : OFFSCREEN_ARGS;
  args.push('.', '--remote-debugging-port=' + inst.port, '--test-profile', '--profile-name=' + inst.profile, ...place);
  const r = await jobhost.launch(String(inst.i), ELECTRON(app), args, app);
  inst.pid = r.pid; inst.inJob = r.inJob;
  let ct = null;
  for (let i = 0; i < 300 && !ct; i++) {
    try { ct = (await getJson(inst.port)).find((x) => x.type === 'page' && /index\.html/.test(String(x.url))); } catch (e) { /* not up */ }
    if (!ct) await sleep(200);
  }
  if (!ct) throw new Error('chrome page never came up');
  const c = await new Cdp(ct.webSocketDebuggerUrl).open();
  await c.waitFor('typeof createTab === "function" && typeof activateTab === "function" && Array.isArray(tabs) && tabs.length > 0 && !restoring', 40000);
  const first = await c.ev('tabs[0].id');
  const open = async (url) => {
    const id = await c.ev(`(() => { const t = createTab(${JSON.stringify(url)}); activateTab(t.id); return t.id; })()`);
    try { await c.waitFor(`(tabs.find((t) => t.id === ${JSON.stringify(id)}) || {}).ready === true`, 20000); } catch (e) { inst.notes.push('not ready in 20 s: ' + url); }
    return id;
  };
  if (inst.setup === 'sites10' || inst.setup === 'sites10-slept') {
    for (const u of SITES) await open(u);
    await c.ev(`closeTab(${JSON.stringify(first)}), 1`);
  } else if (inst.setup === 'site1') {
    await open(SITES[0]);
    await c.ev(`closeTab(${JSON.stringify(first)}), 1`);
  }
  inst.chrome = c;
}

async function launchEdge(inst) {
  inst.udd = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-bench-'));
  const urls = inst.setup === 'sites10' ? SITES : inst.setup === 'site1' ? [SITES[0]] : [];
  const args = ['--user-data-dir=' + inst.udd, '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + inst.port,
    '--disable-features=CalculateNativeWinOcclusion', '--window-position=0,0', '--window-size=1280,820', ...urls];
  const r = await jobhost.launch(String(inst.i), EDGE, args, os.tmpdir());
  inst.pid = r.pid; inst.inJob = r.inJob;
  for (let i = 0; i < 150; i++) { try { await getJson(inst.port, '/json/version'); return; } catch (e) { await sleep(200); } }
  throw new Error('edge devtools never came up');
}

/* ---- the probes (profiled Quartz only) ------------------------------------------------------- */
async function probeStart(inst) {
  inst.probe = { targets: [] };
  try {
    const list = await (await fetch('http://127.0.0.1:' + inst.inspectPort + '/json/list')).json();
    const m = await new Cdp(list[0].webSocketDebuggerUrl).open();
    const r = await m.send('Runtime.evaluate', { expression: MAIN_PROBE, includeCommandLineAPI: true, returnByValue: true });
    inst.probe.mainInstall = r.error ? r.error : (r.result.exceptionDetails ? String((r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text) : r.result.result.value);
    await m.send('Profiler.enable'); await m.send('Profiler.setSamplingInterval', { interval: 2000 }); await m.send('Profiler.start');
    inst.probe.main = m;
  } catch (e) { inst.probe.mainInstall = 'FAILED ' + e.message; }
  const targets = await getJson(inst.port);
  for (const t of targets) {
    const quartzPage = /index\.html|newtab\.html/.test(String(t.url)) && /^file:/.test(String(t.url));
    if (!quartzPage && t.type !== 'webview') continue;
    try {
      const c = await new Cdp(t.webSocketDebuggerUrl).open();
      const rec = { url: String(t.url).replace(/\?.*$/, '').slice(0, 100), type: t.type, quartz: quartzPage, c };
      await c.send('Performance.enable');
      rec.m0 = (await c.send('Performance.getMetrics')).result;
      if (quartzPage) rec.install = await c.ev(RENDERER_PROBE).catch((e) => 'FAILED ' + e.message);
      await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval', { interval: quartzPage ? 2000 : 10000 }); await c.send('Profiler.start');
      inst.probe.targets.push(rec);
    } catch (e) { inst.notes.push('probe attach failed ' + t.url + ': ' + e.message); }
  }
}

const metricsDiff = (a, b) => {
  const m = (x) => Object.fromEntries(((x && x.metrics) || []).map((e) => [e.name, e.value]));
  const A = m(a), B = m(b), out = {};
  for (const k of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount', 'Documents', 'JSEventListeners', 'JSHeapUsedSize']) {
    if (B[k] === undefined) continue;
    out[k] = /Duration/.test(k) ? +((B[k] - (A[k] || 0)) * 1000).toFixed(1) + ' ms' : /Size/.test(k) ? +(B[k] / 1048576).toFixed(1) + ' MB' : B[k] - (A[k] || 0);
  }
  return out;
};

async function probeEnd(inst) {
  const P = inst.probe; const out = { mainInstall: P.mainInstall, targets: [] };
  if (P.main) {
    try { out.main = await P.main.ev(MAIN_READ); } catch (e) { out.main = 'read failed: ' + e.message; }
    try { const prof = await P.main.send('Profiler.stop'); out.mainProfile = foldProfile(prof.result.profile, 40); } catch (e) { out.mainProfile = 'failed: ' + e.message; }
    P.main.close();
  }
  for (const rec of P.targets) {
    const r = { url: rec.url, type: rec.type, install: rec.install };
    try { r.metrics = metricsDiff(rec.m0, (await rec.c.send('Performance.getMetrics')).result); } catch (e) { r.metrics = 'failed'; }
    if (rec.quartz) { try { r.probe = await rec.c.ev(RENDERER_READ); } catch (e) { r.probe = 'failed: ' + e.message; } }
    try { const prof = await rec.c.send('Profiler.stop'); r.profile = foldProfile(prof.result.profile, rec.quartz ? 40 : 12); } catch (e) { r.profile = 'failed: ' + e.message; }
    rec.c.close();
    out.targets.push(r);
  }
  return out;
}

/** contentTracing in the main process for ms, folded: per thread, the tasks that ran most. */
async function traceMain(m, ms) {
  const expr = '(async () => { const { contentTracing } = require("electron"); await contentTracing.startRecording({ included_categories: ["toplevel", "mojom", "ipc", "electron", "base"] }); await new Promise((r) => setTimeout(r, ' + ms + ')); return await contentTracing.stopRecording(); })()';
  const r = await m.send('Runtime.evaluate', { expression: expr, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true });
  if (r.error || r.result.exceptionDetails) return { error: JSON.stringify(r.error || r.result.exceptionDetails).slice(0, 300) };
  const file = r.result.result.value;
  let ev = JSON.parse(fs.readFileSync(file, 'utf8'));
  ev = Array.isArray(ev) ? ev : ev.traceEvents || [];
  try { fs.rmSync(file); } catch (e) { /* keep */ }
  const tname = new Map(); const pname = new Map();
  for (const e of ev) { if (e.ph === 'M' && e.name === 'thread_name') tname.set(e.pid + ':' + e.tid, e.args && e.args.name); if (e.ph === 'M' && e.name === 'process_name') pname.set(e.pid, e.args && e.args.name); }
  const by = new Map();
  for (const e of ev) {
    if (e.ph !== 'X' && e.ph !== 'B' && e.ph !== 'I' && e.ph !== 'i') continue;
    const a = e.args || {};
    const from = a.src_func ? a.src_file + ':' + a.src_func : a.task && a.task.posted_from ? (a.task.posted_from.file_name || '') + ':' + (a.task.posted_from.function_name || '') : (a.chrome_mojo_event_info && a.chrome_mojo_event_info.mojo_interface_tag) || '';
    const k = (pname.get(e.pid) || e.pid) + ' | ' + (tname.get(e.pid + ':' + e.tid) || e.tid) + ' | ' + e.name + (from ? ' <- ' + String(from).replace(/^.*?(src|electron)[\/]/, '') : '');
    const o = by.get(k) || { n: 0, ms: 0 }; o.n++; o.ms += (e.dur || 0) / 1000; by.set(k, o);
  }
  const top = Array.from(by.entries()).sort((x, y) => y[1].n - x[1].n).slice(0, 45).map(([k, o]) => ({ k: k.slice(0, 220), perS: +(o.n / (ms / 1000)).toFixed(1), ms: +o.ms.toFixed(1) }));
  return { events: ev.length, seconds: ms / 1000, top };
}

/* ---- processes ------------------------------------------------------------------------------- */
function processTable() {
  const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2';
  const raw = execFileSync('powershell', ['-NoProfile', '-Command', ps], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  return JSON.parse(raw).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cl: String(p.CommandLine || '') }));
}
function procType(cl, name) {
  const t = /--type=([\w-]+)/.exec(cl);
  if (!t) return /^(electron|msedge)\.exe$/i.test(name) ? 'browser' : name.replace(/\.exe$/i, '');
  if (t[1] === 'utility') { const s = /--utility-sub-type=([\w.]+)/.exec(cl); return 'utility:' + (s ? s[1].split('.').slice(-1)[0] : '?'); }
  if (t[1] === 'renderer' && /--extension-process/.test(cl)) return 'renderer:extension';
  return t[1];
}

function readSamples(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean)
    .map((s) => ({ t: s.t, p: new Map(s.p.map((r) => [r[0], { pid: r[0], ppid: r[1], name: r[2], cpu: r[3], ws: r[4], priv: r[5], th: r[6], ctx: r[7] }])) }));
}

function measureTree(roots, samples, t0, t1, types) {
  const inWin = samples.filter((s) => s.t >= t0 - 1000 && s.t <= t1 + 1000);
  if (inWin.length < 2) return { error: 'fewer than 2 samples in the window' };
  const first = inWin[0], last = inWin[inWin.length - 1];
  const parent = new Map();
  for (const s of samples) for (const r of s.p.values()) parent.set(r.pid, r.ppid);
  const inTree = (pid) => { for (let p = pid, n = 0; p && n < 12; p = parent.get(p), n++) if (roots.has(p)) return true; return false; };
  const pids = new Set();
  for (const s of inWin) for (const pid of s.p.keys()) if (inTree(pid)) pids.add(pid);
  let cpu = 0, ctx = 0; const byType = {};
  for (const pid of pids) {
    let lastSeen = null; for (const s of inWin) if (s.p.has(pid)) lastSeen = s.p.get(pid);
    const base = first.p.get(pid);
    const dc = (lastSeen.cpu - (base ? base.cpu : 0)) / 1e7;
    const dx = lastSeen.ctx - (base ? base.ctx : 0);
    cpu += dc; ctx += Math.max(0, dx);
    const ty = types.get(pid) || lastSeen.name;
    const b = byType[ty] || (byType[ty] = { n: 0, wsPrivMB: 0, cpuS: 0, ctx: 0 });
    const end = last.p.get(pid);
    if (end) { b.n++; b.wsPrivMB += end.ws / 1048576; }
    b.cpuS += dc; b.ctx += Math.max(0, dx);
  }
  let ws = 0, priv = 0, nEnd = 0;
  for (const [pid, r] of last.p) if (pids.has(pid)) { ws += r.ws; priv += r.priv; nEnd++; }
  const meanWs = inWin.reduce((a, s) => { let x = 0; for (const [pid, r] of s.p) if (pids.has(pid)) x += r.ws; return a + x; }, 0) / inWin.length / 1048576;
  const winS = (last.t - first.t) / 1000;
  const scale = IDLE_S / winS;
  for (const b of Object.values(byType)) { b.wsPrivMB = +b.wsPrivMB.toFixed(1); b.cpuS = +(b.cpuS * scale).toFixed(2); b.ctxPerS = +(b.ctx / winS).toFixed(1); delete b.ctx; }
  return { windowS: +winS.toFixed(1), samples: inWin.length, procsAtEnd: nEnd, wsPrivMB: +(ws / 1048576).toFixed(1), meanWsPrivMB: +meanWs.toFixed(1), commitMB: +(priv / 1048576).toFixed(1),
    cpuS: +(cpu * scale).toFixed(2), cpuRawS: +cpu.toFixed(2), ctxPerS: +(ctx / winS).toFixed(1), byType };
}

/* ---- the run --------------------------------------------------------------------------------- */
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const samplesFile = path.join(OUT, 'samples.jsonl');
  const stopFile = path.join(OUT, 'sampler.stop');
  try { fs.rmSync(samplesFile); } catch (e) { /* none */ }
  try { fs.rmSync(stopFile); } catch (e) { /* none */ }
  const insts = plan().map((p, i) => Object.assign(p, { i, port: 9500 + i, inspectPort: 9800 + i, notes: [] }));
  log(`plan=${PLAN} instances=${insts.length} idle=${IDLE_S}s settle=${SETTLE_S}s load=${LOAD_S}s every=${EVERY_S}s edge=${EDGE || 'MISSING'} cpus=${os.cpus().length} ramGB=${(os.totalmem() / 2 ** 30).toFixed(1)}`);
  const killAll = () => {
    for (const inst of insts) jobhost.kill(String(inst.i));
    for (const inst of insts) for (const pid of [inst.pid, ...(inst.extraRoots || [])]) { if (!pid) continue; try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ } }
  };
  const watchdog = setTimeout(() => { log('WATCHDOG: --max-min reached, killing everything'); try { fs.writeFileSync(stopFile, '1'); } catch (e) { /* */ } killAll(); setTimeout(() => process.exit(2), 4000); }, MAX_MIN * 60000);
  watchdog.unref();

  await jobhost.start();
  const sampler = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'sampler.ps1'), '-Out', samplesFile, '-EverySec', String(EVERY_S), '-StopFile', stopFile], { stdio: 'ignore' });

  // Launch, staggered, each instance opening its own tabs on its own.
  const ready = [];
  for (const inst of insts) {
    const fn = inst.browser === 'edge' ? launchEdge : inst.browser === 'bare' ? launchBare : launchQuartz;
    ready.push(fn(inst).then(() => log(`up ${inst.i} ${inst.cond} pid ${inst.pid}`), (e) => { inst.failed = e.message; log(`FAILED ${inst.i} ${inst.cond}: ${e.message}`); }));
    await sleep(3000);
  }
  await Promise.all(ready);
  log(`all launched; load wait ${LOAD_S}s`);
  await sleep(LOAD_S * 1000);

  for (const inst of insts) {
    if (inst.failed || inst.browser !== 'quartz') continue;
    if (inst.setup === 'sites10-slept') {
      inst.slept = await inst.chrome.ev(`tabs.filter((t) => t.id !== activeTabId).map((t) => sleepTab(t, 'asked')).filter(Boolean).length`).catch((e) => 'failed: ' + e.message);
      log(`${inst.i} ${inst.cond}: slept ${inst.slept}`);
    }
    inst.start = await inst.chrome.ev(`({ tabs: tabs.length, active: (tabs.find((t) => t.id === activeTabId) || {}).url, home: activeIsNewTab(), focus: windowHasFocus(), stats: statsSubscribed, mediaPoll: mediaPollTimer != null })`).catch((e) => 'failed: ' + e.message);
    // Leave no DevTools session on the measured instances during the window.
    if (!inst.profiled) { inst.chrome.close(); inst.chrome = null; }
  }
  log(`settle ${SETTLE_S}s`);
  await sleep(SETTLE_S * 1000);

  for (const inst of insts) if (inst.profiled && !inst.failed) await probeStart(inst).catch((e) => inst.notes.push('probeStart: ' + e.message));
  const threadPids = () => { const seen = new Set(); return insts.filter((x) => !x.failed && !x.profiled && !seen.has(x.cond) && seen.add(x.cond) && /^(Q-1|E-1|Q-home|B:Q-home|X-|Q-1-onscreen|B:Q-1)/.test(x.cond)).map((x) => x.pid); };
  const acct0 = await jobhost.acct();
  const t0 = Date.now();
  log(`IDLE WINDOW START (${IDLE_S}s)`);
  let th0At = 0;
  const th0P = jobhost.threads(threadPids()).then((x) => { th0At = Date.now(); log('threads dump 0 in'); return x; });
  // A Chromium trace of the profiled instances' main process, 20 s inside the window: which
  // tasks run on which browser-process thread, and who posted them (probe.js traceMain).
  const traceP = sleep(Math.min(60, IDLE_S / 3) * 1000).then(() => Promise.all(insts.filter((x) => x.profiled && !x.failed && x.probe && x.probe.main).map(async (x) => { x.trace = await traceMain(x.probe.main, 20000).catch((e) => ({ error: e.message })); log('trace in for ' + x.cond); })));
  await sleep(IDLE_S * 1000);
  const th0 = await th0P;
  await traceP;
  const t1 = Date.now();
  const acct1 = await jobhost.acct();
  const th1 = await jobhost.threads(threadPids());
  const thDt = (Date.now() - (th0At || t0)) / 1000;
  log('IDLE WINDOW END');
  await sleep(Math.min(EVERY_S, 10) * 1000 + 3000); // let one more sample land after t1 if it is close
  for (const inst of insts) if (inst.profiled && !inst.failed) inst.probeOut = await probeEnd(inst).catch((e) => ({ error: e.message }));

  // What was really open, from each browser's own DevTools list.
  const table = processTable();
  for (const inst of insts) {
    if (inst.failed) continue;
    try { inst.openTargets = (await getJson(inst.port)).filter((t) => t.type === 'page' || t.type === 'webview').map((t) => t.type + ' ' + String(t.url).replace(/\?.*$/, '').slice(0, 90)); } catch (e) { inst.openTargets = 'failed: ' + e.message; }
    if (inst.browser === 'edge') inst.extraRoots = table.filter((p) => p.cl.includes(inst.udd) && !/--type=/.test(p.cl) && p.pid !== inst.pid).map((p) => p.pid);
  }
  fs.writeFileSync(stopFile, '1');
  await new Promise((r) => { sampler.on('exit', r); setTimeout(r, 15000); });

  const types = new Map(table.map((p) => [p.pid, procType(p.cl, p.name)]));
  const samples = readSamples(samplesFile);
  for (const inst of insts) {
    if (inst.failed) continue;
    inst.result = measureTree(new Set([inst.pid, ...(inst.extraRoots || [])]), samples, t0, t1, types);
    const a0 = acct0[String(inst.i)], a1 = acct1[String(inst.i)];
    if (inst.result && !inst.result.error && a0 && a1) {
      // The job's CPU: every process that ran in it, short-lived ones included. Scaled to --idle s.
      inst.result.jobCpuS = +(((a1[0] + a1[1]) - (a0[0] + a0[1])) / 1e7 * IDLE_S / ((t1 - t0) / 1000)).toFixed(2);
      inst.result.jobProcsStarted = a1[2] - a0[2];
      inst.result.jobActive = a1[3];
    }
    if (th0 && th1 && th1.threads && th1.threads[inst.pid]) inst.result.mainThreads = threadDiff(th0, th1, String(inst.pid), thDt);
  }
  killAll();
  await sleep(4000);
  jobhost.quit();

  // Summary per condition: median and spread over the reps.
  const conds = [...new Set(insts.map((x) => x.cond))];
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
  const lines = [];
  lines.push(`idle-bench plan=${PLAN} idle=${IDLE_S}s reps=${REPS} sampled every ${EVERY_S}s, runner cpus=${os.cpus().length} ram=${(os.totalmem() / 2 ** 30).toFixed(1)}GB`);
  lines.push('cond            n  wsPrivMB med [min-max]      commitMB med   cpuS/idle med [min-max]   ctx/s med [min-max]    jobCpuS med [min-max]  procs started');
  const summary = {};
  for (const c of conds) {
    const rs = insts.filter((x) => x.cond === c && x.result && !x.result.error).map((x) => x.result);
    if (!rs.length) { lines.push(c.padEnd(15) + ' 0  (no result)'); continue; }
    const f = (k) => rs.map((r) => r[k]);
    const jc = rs.map((r) => r.jobCpuS).filter((x) => typeof x === 'number');
    const s = { jobCpuS: jc.length ? med(jc) : NaN, jobMin: jc.length ? Math.min(...jc) : NaN, jobMax: jc.length ? Math.max(...jc) : NaN, procs: med(rs.map((r) => r.jobProcsStarted || 0)), n: rs.length, wsPrivMB: med(f('wsPrivMB')), wsMin: Math.min(...f('wsPrivMB')), wsMax: Math.max(...f('wsPrivMB')), commitMB: med(f('commitMB')),
      cpuS: med(f('cpuS')), cpuMin: Math.min(...f('cpuS')), cpuMax: Math.max(...f('cpuS')), ctxPerS: med(f('ctxPerS')), ctxMin: Math.min(...f('ctxPerS')), ctxMax: Math.max(...f('ctxPerS')) };
    summary[c] = s;
    lines.push(`${c.padEnd(15)} ${s.n}  ${String(Math.round(s.wsPrivMB)).padStart(6)} [${Math.round(s.wsMin)}-${Math.round(s.wsMax)}]`.padEnd(46) + `${String(Math.round(s.commitMB)).padStart(6)}`.padEnd(15) +
      `${s.cpuS.toFixed(1).padStart(7)} [${s.cpuMin.toFixed(1)}-${s.cpuMax.toFixed(1)}]`.padEnd(26) + `${s.ctxPerS.toFixed(0).padStart(6)} [${s.ctxMin.toFixed(0)}-${s.ctxMax.toFixed(0)}]`.padEnd(23) +
      `${isNaN(s.jobCpuS) ? '   n/a' : s.jobCpuS.toFixed(1).padStart(6) + ' [' + s.jobMin.toFixed(1) + '-' + s.jobMax.toFixed(1) + ']'}`.padEnd(23) + String(s.procs));
  }
  const failed = insts.filter((x) => x.failed);
  if (failed.length) lines.push('FAILED instances: ' + failed.map((x) => x.i + ' ' + x.cond + ': ' + x.failed).join('; '));
  const text = lines.join('\n');
  console.log(text);
  const dump = insts.map((x) => ({ i: x.i, cond: x.cond, browser: x.browser, setup: x.setup, app: x.app ? path.basename(x.app) : undefined, profiled: !!x.profiled, pid: x.pid, extraRoots: x.extraRoots, failed: x.failed,
    inJob: x.inJob, notes: x.notes, trace: x.trace, slept: x.slept, start: x.start, openTargets: x.openTargets, result: x.result, probe: x.probeOut }));
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ plan: PLAN, idleS: IDLE_S, settleS: SETTLE_S, loadS: LOAD_S, reps: REPS, everyS: EVERY_S, sites: SITES, t0, t1, summary, instances: dump }, null, 1));
  fs.writeFileSync(path.join(OUT, 'summary.txt'), text + '\n');
  log('idle-bench: done, ' + conds.length + ' conditions, ' + failed.length + ' failed instances');
  process.exit(0);
}

main().catch((e) => { console.log('idle-bench: HARNESS ERROR ' + (e && e.stack || e)); process.exit(1); });
