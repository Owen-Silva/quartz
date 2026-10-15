// tools/efficiency/mem-bench.js -- where Quartz's memory goes, per PROCESS, next to Edge and plain
// Electron. idle-bench.js sums a browser's whole process tree; this one splits it.
//
//   node tools/efficiency/mem-bench.js --conds=Q-1x2,E-1x2,P-1,X-wv [--load=60] [--settle=30]
//        [--idle=180] [--every=30] [--out=mem-out] [--make-a=<overlay dir>] [--max-min=20]
//
// RUNNER ONLY (CI=true or QUARTZ_BENCH_OK=1): it starts several browsers at once and kills each one
// it started by PID tree at the end.
//
// Conditions (--conds, comma separated, "x<n>" = n separate instances):
//   Q-1      Quartz, one tab (Wikipedia), opened the way idle-bench.js does: createTab + close Home
//   Q-10     Quartz, the 10 idle-bench sites
//   Q-home   Quartz on its Home page only
//   P-1      Q-1 with the main process started under --inspect-brk and V8's sampling heap profiler
//            running from the first line: the main process's live JS heap by module. Its numbers
//            carry the probe's cost; use it for attribution, not for the headline.
//   E-1 / E-10   Edge, fresh --user-data-dir, the same URLs on the command line
//   X-wv     plain Electron (bare-main.js), acrylic window with one <webview> of the Wikipedia page
//   X-bare   plain Electron, one static window
//   <cond>w  Quartz WARM: the ad blocker's saved engine (from a cold instance earlier in the run)
//            is in the profile before launch, as on every launch after the first. Without "w" the
//            profile is brand new (first run: the engine is downloaded or built from the lists).
//   A:<cond> the same, but the "A" app: a copy of this tree with --make-a's files laid on top
//            (the baseline in a before/after run). --app-<NAME>=<overlay dir> adds more copies,
//            run by "<NAME>:<cond>". Unprefixed Quartz conditions run this tree.
// P-* also run an experiment after the clean snapshot: one HeapProfiler.collectGarbage in the main
// process, and its commit before and 5 s after. Every Quartz instance's quartz.log lines about the
// ad blocker and the start-up memory clean-up are copied into the notes.
//
// Timeline: launch (staggered 3 s) -> open the tabs -> --load s -> --settle s -> the --idle window
// (a snapshot every --every s) -> the final snapshot -> per-target V8 heaps over CDP -> kill.
//
// Memory per process, from memsnap.ps1 at each snapshot (bytes, shown as MB):
//   commit  PrivateBytes (Win32_Process.PrivatePageCount). THE number compared: Windows cannot trim
//           it, so it does not move when the box is short of RAM (the working set does).
//   wsPriv  WorkingSetPrivate, Task Manager's "Memory" column.
// Process kinds come from each command line: browser (the main process), gpu-process,
// utility:<service>, renderer (Quartz's are numbered in start order: renderer#1 is the chrome
// page), crashpad-handler.
//
// The 2026-10-15 runs (lane quartz-memory; results in next-week/quartz-efficiency.md), each through
//   cloudtest --recipe quartz-core --timeout 22 --artifacts "mem-out/**" -- "node tools/efficiency/mem-bench.js ..."
//   R1 38703667354: --conds=Q-1x2,E-1x2,P-1,X-wv --idle=120
//   R2 38706070012: --make-a=.mem-a --conds=A:Q-1,Q-1,A:Q-1wx2,Q-1wx2,A:Q-10w,Q-10w,E-1,A:P-1w --idle=150
//   R3 38707554165: --make-a=.mem-a --conds=A:Q-1,A:P-1w,Q-1w,X-wv,E-1 --idle=60 (regions + memory-infra)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const { Cdp } = require(path.join(REPO, 'tests', 'e2e-kit'));
const { OFFSCREEN_ARGS } = require(path.join(REPO, 'testwatch'));

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
const num = (k, d) => (argv[k] === undefined ? d : Number(argv[k]));
const LOAD_S = num('load', 60), SETTLE_S = num('settle', 30), IDLE_S = num('idle', 180), EVERY_S = num('every', 30);
const MAX_MIN = num('max-min', 20);
const OUT = path.resolve(argv.out || 'mem-out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (l) => console.log('[mem ' + new Date().toISOString().slice(11, 19) + '] ' + l);

if (!(process.env.CI === 'true' || process.env.QUARTZ_BENCH_OK === '1')) {
  console.log('mem-bench: refused: runner only (set CI=true there). It launches several browsers and kills them by PID.');
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

// --make-a=<overlay dir>: the "A" app, a copy of this tree (node_modules junctioned back) with the
// overlay's files on top; "<name>.delete" in the overlay removes <name>.
// --app-<NAME>=<overlay dir> (any number; --make-a is --app-A): conditions prefixed "<NAME>:" run
// that copy. Unprefixed Quartz conditions run this tree as it is.
const APPS = {};
for (const [k, v] of Object.entries(argv)) {
  const m = k === 'make-a' ? ['', 'A'] : /^app-(\w+)$/.exec(k);
  if (!m) continue;
  const overlay = path.resolve(String(v));
  const dest = path.join(path.dirname(REPO), 'quartz-mem' + m[1]);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(REPO, dest, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git|mem-out|eff-out|suite-out|\.cloudtest|\.mem-\w+)([\\/]|$)/.test(path.relative(path.dirname(REPO), src)) || path.relative(REPO, src) === '' });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dest, 'node_modules'), 'junction');
  for (const f of fs.readdirSync(overlay)) {
    if (f.endsWith('.delete')) fs.rmSync(path.join(dest, f.slice(0, -'.delete'.length)), { force: true });
    else fs.copyFileSync(path.join(overlay, f), path.join(dest, f));
  }
  APPS[m[1]] = dest;
}

/* ---- plan ------------------------------------------------------------------------------------ */
// "<cond>w" (Quartz only) = WARM: the ad blocker's saved engine (adblock-engine.bin, written by a
// cold instance earlier in the same run) is put in the profile before launch, as on every launch
// after a user's first. Cold = a brand-new profile: the engine is downloaded/built.
function plan() {
  const list = [];
  for (const raw of String(argv.conds || 'Q-1x2,E-1x2,P-1,X-wv').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(?:(\w+):)?([A-Z]-[\w-]+?)(w)?(?:x(\d+))?$/.exec(raw);
    if (!m) throw new Error('bad condition ' + raw);
    const appName = m[1] || '', kind = m[2], reps = Number(m[4] || 1);
    if (appName && !APPS[appName]) throw new Error(raw + ' needs --app-' + appName);
    for (let r = 0; r < reps; r++) {
      const browser = kind[0] === 'E' ? 'edge' : kind[0] === 'X' ? 'bare' : 'quartz';
      const setup = /-10$/.test(kind) ? 'sites10' : /-home$/.test(kind) ? 'home' : /-ntp$/.test(kind) ? 'ntp' : kind === 'X-bare' ? 'bare' : 'site1';
      const warm = !!m[3] && browser === 'quartz';
      list.push({ cond: (appName ? appName + ':' : '') + kind + (warm ? 'w' : ''), browser, setup, warm, app: appName ? APPS[appName] : REPO, probed: kind[0] === 'P', notes: [] });
    }
  }
  list.forEach((x, i) => { x.i = i; x.port = 9420 + i; x.inspectPort = 9620 + i; });
  return list;
}

/* ---- snapshots ------------------------------------------------------------------------------- */
function snap() {
  const f = path.join(OUT, 'snap.tmp.json');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'memsnap.ps1'), '-Out', f], { stdio: 'ignore', timeout: 120000 });
  let rows = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(rows)) rows = [rows];
  return rows;
}

function kindOf(p) {
  const cmd = p.cmd || '';
  const t = /--type=([\w-]+)/.exec(cmd);
  if (!t) return /^(electron|msedge|quartz)\.exe$/i.test(p.name) ? 'browser' : 'other:' + p.name;
  if (t[1] === 'utility') { const s = /--utility-sub-type=([\w.]+)/.exec(cmd); return 'utility:' + (s ? s[1].replace(/\.mojom\..*$/, '') : '?'); }
  if (t[1] === 'renderer') return /--extension-process/.test(cmd) ? 'renderer:ext' : 'renderer';
  return t[1];
}

/** Every process descended from rootPid (and started after it), with its kind. */
function treeOf(rows, rootPid) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const root = byPid.get(rootPid);
  if (!root) return [];
  const t0 = Date.parse(root.created) || 0;
  const out = [root]; const seen = new Set([rootPid]);
  for (let k = 0; k < out.length; k++) {
    for (const r of rows) {
      if (r.ppid === out[k].pid && !seen.has(r.pid) && (Date.parse(r.created) || 0) >= t0 - 1000) { seen.add(r.pid); out.push(r); }
    }
  }
  const procs = out.map((r) => ({ pid: r.pid, kind: kindOf(r), created: r.created, commitMB: +(r.priv / 1048576).toFixed(1), wsPrivMB: +(r.wsPriv / 1048576).toFixed(1), wsMB: +(r.ws / 1048576).toFixed(1) }));
  procs.sort((a, b) => String(a.created).localeCompare(String(b.created)));
  let n = 0;
  for (const p of procs) if (p.kind === 'renderer') p.kind = 'renderer#' + (++n);
  return procs;
}
const sum = (procs, k) => +procs.reduce((s, p) => s + p[k], 0).toFixed(1);

/* ---- launching ------------------------------------------------------------------------------- */
const getJson = async (port, p) => (await fetch('http://127.0.0.1:' + port + (p || '/json'))).json();
/** Profile dirs of the cold Quartz instances: where a warm one takes its saved ad-block engine. */
const SEEDS = [];

function start(exe, args, cwd) {
  const child = spawn(exe, args, { cwd, stdio: 'ignore', windowsHide: false });
  child.on('error', () => { /* reported by the caller's wait */ });
  return child.pid;
}

async function launchBare(inst) {
  const args = [path.join(__dirname, 'bare-main.js')];
  if (inst.setup !== 'bare') args.push('--acrylic', '--webview', '--url=' + SITES[0]);
  inst.pid = start(ELECTRON(REPO), args, REPO);
  await sleep(4000);
}

/** P-*: attach to the paused main process, start the sampling heap profiler, let it run. */
async function attachHeapSampler(inst) {
  let list = null;
  for (let i = 0; i < 300 && !(list && list.length); i++) { try { list = await getJson(inst.inspectPort, '/json/list'); } catch (e) { /* not up */ } if (!(list && list.length)) await sleep(100); }
  if (!(list && list.length)) throw new Error('main inspector never came up');
  const m = await new Cdp(list[0].webSocketDebuggerUrl).open();
  let pausedResolve; const paused = new Promise((r) => { pausedResolve = r; });
  m.ws.on('message', (raw) => { try { if (JSON.parse(String(raw)).method === 'Debugger.paused') pausedResolve(); } catch (e) { /* not ours */ } });
  await m.send('Debugger.enable');
  await m.send('HeapProfiler.enable');
  const s = await m.send('HeapProfiler.startSampling', { samplingInterval: 16384 });
  if (s.error) inst.notes.push('startSampling: ' + JSON.stringify(s.error));
  await m.send('Runtime.runIfWaitingForDebugger');
  await Promise.race([paused, sleep(5000)]);
  await m.send('Debugger.resume');
  await m.send('Debugger.disable');
  inst.main = m;
}

async function launchQuartz(inst) {
  inst.profile = 'mem' + inst.i + 'p' + process.pid;
  inst.profileDir = path.join(os.tmpdir(), 'browser-test-profile-' + inst.profile); // main.js's --test-profile path
  if (inst.warm) {
    // The saved engine from any cold instance that already wrote one (main.js adblockCachePath).
    let seed = null;
    for (let i = 0; i < 240 && !seed; i++) {
      seed = SEEDS.map((d) => path.join(d, 'adblock-engine.bin')).find((f) => { try { return fs.statSync(f).size > 100000 && Date.now() - fs.statSync(f).mtimeMs > 2000; } catch (e) { return false; } });
      if (!seed) await sleep(500);
    }
    if (!seed) throw new Error('warm: no cold instance wrote adblock-engine.bin in 2 min');
    fs.mkdirSync(inst.profileDir, { recursive: true });
    fs.copyFileSync(seed, path.join(inst.profileDir, 'adblock-engine.bin'));
    inst.notes.push('warm from ' + path.basename(path.dirname(seed)) + ' (' + (fs.statSync(seed).size / 1048576).toFixed(1) + ' MB)');
  } else SEEDS.push(inst.profileDir);
  const args = [];
  if (inst.probed) args.push('--inspect-brk=' + inst.inspectPort);
  args.push('.', '--remote-debugging-port=' + inst.port, '--test-profile', '--profile-name=' + inst.profile, ...OFFSCREEN_ARGS);
  inst.pid = start(ELECTRON(inst.app), args, inst.app);
  if (inst.probed) await attachHeapSampler(inst);
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
  if (inst.setup === 'sites10') { for (const u of SITES) await open(u); await c.ev(`closeTab(${JSON.stringify(first)}), 1`); }
  else if (inst.setup === 'site1') { await open(SITES[0]); await c.ev(`closeTab(${JSON.stringify(first)}), 1`); }
  c.close();
}

async function launchEdge(inst) {
  inst.udd = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-mem-'));
  const urls = inst.setup === 'sites10' ? SITES : inst.setup === 'site1' ? [SITES[0]] : [];
  const args = ['--user-data-dir=' + inst.udd, '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + inst.port,
    '--disable-features=CalculateNativeWinOcclusion', '--window-position=0,0', '--window-size=1280,820', ...urls];
  inst.pid = start(EDGE, args, os.tmpdir());
  for (let i = 0; i < 150; i++) { try { await getJson(inst.port, '/json/version'); return; } catch (e) { await sleep(200); } }
  throw new Error('edge devtools never came up');
}

/* ---- reading ---------------------------------------------------------------------------------- */
/** V8 heap of every page/webview target, over CDP. */
async function targetHeaps(inst) {
  if (inst.browser === 'bare') return [];
  let list = [];
  try { list = await getJson(inst.port); } catch (e) { return [{ error: e.message }]; }
  const out = [];
  for (const t of list) {
    if (!/^(page|webview|iframe|background_page|service_worker|shared_worker|worker|other)$/.test(t.type)) continue;
    const rec = { type: t.type, url: String(t.url).replace(/\?.*$/, '').slice(0, 90) };
    try {
      const c = await new Cdp(t.webSocketDebuggerUrl).open();
      const h = await Promise.race([c.send('Runtime.getHeapUsage'), sleep(5000).then(() => ({ error: { message: 'timeout' } }))]);
      if (h.result) { rec.heapUsedMB = +(h.result.usedSize / 1048576).toFixed(1); rec.heapTotalMB = +(h.result.totalSize / 1048576).toFixed(1); if (h.result.embedderHeapUsedSize !== undefined) rec.embedderMB = +(h.result.embedderHeapUsedSize / 1048576).toFixed(1); if (h.result.backingStorageSize !== undefined) rec.backingMB = +(h.result.backingStorageSize / 1048576).toFixed(1); } else rec.heapErr = (h.error || {}).message;
      const d = await Promise.race([c.send('Memory.getDOMCounters'), sleep(5000).then(() => ({ error: { message: 'timeout' } }))]);
      if (d.result) { rec.nodes = d.result.nodes; rec.docs = d.result.documents; rec.listeners = d.result.jsEventListeners; }
      c.close();
    } catch (e) { rec.err = e.message; }
    out.push(rec);
  }
  return out;
}

const MAIN_INFO = `(async () => {
  const require = (process.mainModule && process.mainModule.require.bind(process.mainModule)) || globalThis.require; const { app, webContents } = require('electron'); const v8 = require('v8');
  const wcs = webContents.getAllWebContents().map((w) => { let pid = 0; try { pid = w.getOSProcessId(); } catch (e) {} return { id: w.id, type: w.getType(), url: String(w.getURL()).replace(/\\?.*$/, '').slice(0, 100), pid }; });
  const metrics = app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name || '', service: m.serviceName || '', privMB: m.memory ? +(m.memory.privateBytes / 1024).toFixed(1) : null }));
  const mu = process.memoryUsage(); const MB = (b) => +(b / 1048576).toFixed(1);
  const pm = await process.getProcessMemoryInfo();
  const spaces = v8.getHeapSpaceStatistics().map((s) => ({ n: s.space_name, sizeMB: MB(s.space_size), usedMB: MB(s.space_used_size) }));
  const hs = v8.getHeapStatistics();
  const mods = Object.keys(require('module')._cache);
  return JSON.stringify({ wcs, metrics, mem: { rss: MB(mu.rss), heapTotal: MB(mu.heapTotal), heapUsed: MB(mu.heapUsed), external: MB(mu.external), arrayBuffers: MB(mu.arrayBuffers), privateMB: +(pm.private / 1024).toFixed(1), mallocedMB: MB(hs.malloced_memory), peakMallocedMB: MB(hs.peak_malloced_memory), codeMetaMB: MB(hs.used_global_handles_size || 0) }, spaces, modules: mods.length,
    nodeModules: Array.from(new Set(mods.map((m) => { const k = m.split(/node_modules[\\\\/]/)[1]; return k ? k.split(/[\\\\/]/).slice(0, k[0] === '@' ? 2 : 1).join('/') : null; }).filter(Boolean))) });
})()`;

/** One detailed memory-infra dump of every process, through Electron's contentTracing (main). */
const TRACE_MEM = `(async () => {
  const require = process.mainModule.require.bind(process.mainModule); const { contentTracing } = require('electron');
  await contentTracing.startRecording({ included_categories: ['disabled-by-default-memory-infra'], excluded_categories: ['*'], memory_dump_config: { triggers: [{ mode: 'detailed', periodic_interval_ms: 2000 }] } });
  await new Promise((r) => setTimeout(r, 5000));
  return await contentTracing.stopRecording();
})()`;

/** The last dump per process: top-level allocators (MB), plus the big depth-1/2 entries. */
function foldMemDump(file, procs) {
  let ev = JSON.parse(fs.readFileSync(file, 'utf8'));
  ev = Array.isArray(ev) ? ev : ev.traceEvents || [];
  try { fs.copyFileSync(file, path.join(OUT, 'memdump-' + path.basename(file))); } catch (e) { /* keep going */ }
  const last = new Map();
  for (const e of ev) if (e.ph === 'v' && e.args && e.args.dumps && e.args.dumps.allocators) last.set(e.pid, e.args.dumps);
  const kindOfPid = new Map((procs || []).map((p) => [p.pid, p.kind]));
  const MB = (b) => +(b / 1048576).toFixed(1);
  const out = {};
  for (const [pid, dumps] of last) {
    const sizes = {};
    for (const [k, v] of Object.entries(dumps.allocators)) { const s = v.attrs && v.attrs.size; if (s && s.value !== undefined) sizes[k] = parseInt(s.value, 16); }
    const tops = {};
    for (const [k, v] of Object.entries(sizes)) if (!k.includes('/')) tops[k] = v;
    for (const [k, v] of Object.entries(sizes)) { const parts = k.split('/'); if (parts.length === 2 && sizes[parts[0]] === undefined) tops[parts[0]] = (tops[parts[0]] || 0) + v; }
    const detail = Object.entries(sizes).filter(([k, v]) => k.split('/').length <= 3 && k.includes('/') && v >= 1048576).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => [k, MB(v)]);
    const pt = dumps.process_totals || {};
    out[(kindOfPid.get(pid) || 'pid') + ' ' + pid] = {
      footprintMB: pt.private_footprint_bytes ? MB(parseInt(pt.private_footprint_bytes, 16)) : undefined,
      top: Object.entries(tops).filter(([, v]) => v >= 262144).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, MB(v)]),
      detail,
    };
  }
  return out;
}

/** Fold a sampling heap profile: live bytes by leaf script, by owning Quartz file, by package. */
function foldHeap(profile, appDir) {
  const byLeaf = new Map(), byApp = new Map(), byPkg = new Map(), byAppFn = new Map();
  const norm = (u) => decodeURIComponent(String(u || '').replace(/^file:\/\/\/?/, '')).replace(/\\/g, '/');
  const appN = appDir.replace(/\\/g, '/').toLowerCase();
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  let total = 0;
  const walk = (node, owner, ownerFn, pkg) => {
    const u = norm(node.callFrame.url);
    const ul = u.toLowerCase();
    let o = owner, ofn = ownerFn, pk = pkg;
    if (ul.startsWith(appN)) {
      const rel = u.slice(appN.length).replace(/^\//, '');
      const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(rel);
      if (nm) pk = nm[1]; else { o = rel; ofn = rel + ':' + (node.callFrame.functionName || '(anon)'); pk = null; }
    } else if (u && !/^node:|^internal\//.test(u) && /node_modules\/((?:@[^/]+\/)?[^/]+)/.test(u)) {
      pk = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(u)[1];
    }
    if (node.selfSize) {
      total += node.selfSize;
      add(byLeaf, (u ? u.replace(/^.*\/(node_modules\/)/, '$1').slice(-80) : '(native/vm)') + ' ' + (node.callFrame.functionName || ''), node.selfSize);
      add(byApp, o || '(no Quartz frame)', node.selfSize);
      add(byAppFn, ofn || '(no Quartz frame)', node.selfSize);
      add(byPkg, pk ? 'pkg:' + pk : (u.startsWith('node:') || /^internal\//.test(u) ? 'node-internal' : (u ? 'quartz/app' : '(native/vm)')), node.selfSize);
    }
    for (const ch of node.children || []) walk(ch, o, ofn, pk);
  };
  walk(profile.head, null, null, null);
  const top = (m, n) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, +(v / 1048576).toFixed(2)]);
  return { totalMB: +(total / 1048576).toFixed(1), byQuartzFile: top(byApp, 30), byQuartzFn: top(byAppFn, 30), byPackage: top(byPkg, 20), byLeaf: top(byLeaf, 30) };
}

/* ---- the run ---------------------------------------------------------------------------------- */
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const insts = plan();
  log('plan: ' + insts.map((x) => x.cond).join(' ') + ' | load ' + LOAD_S + ' s, settle ' + SETTLE_S + ' s, idle ' + IDLE_S + ' s');
  log('box: ' + os.cpus().length + ' cpus, ' + (os.totalmem() / 1073741824).toFixed(1) + ' GB, free ' + (os.freemem() / 1073741824).toFixed(1) + ' GB; edge ' + EDGE);
  const kill = () => { for (const x of insts) { if (x.pid) { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(x.pid)], { stdio: 'ignore' }); } catch (e) { /* gone */ } } } };
  const guard = setTimeout(() => { log('max-min reached: killing everything'); kill(); process.exit(2); }, MAX_MIN * 60000);
  try {
    for (const inst of insts) {
      try {
        if (inst.browser === 'quartz') await launchQuartz(inst);
        else if (inst.browser === 'edge') await launchEdge(inst);
        else await launchBare(inst);
        log('up ' + inst.cond + ' #' + inst.i + ' pid ' + inst.pid + (inst.notes.length ? ' (' + inst.notes.join('; ') + ')' : ''));
      } catch (e) { inst.failed = e.message; log('FAILED ' + inst.cond + ' #' + inst.i + ': ' + e.message); }
      await sleep(3000);
    }
    log('loading ' + LOAD_S + ' s, settling ' + SETTLE_S + ' s');
    await sleep((LOAD_S + SETTLE_S) * 1000);
    const series = [];
    const t1 = Date.now();
    for (;;) {
      const rows = snap();
      const at = Math.round((Date.now() - t1) / 1000);
      series.push({ at, per: insts.map((x) => (x.failed ? null : { commitMB: sum(treeOf(rows, x.pid), 'commitMB'), wsPrivMB: sum(treeOf(rows, x.pid), 'wsPrivMB') })) });
      log('t+' + at + ' s: ' + insts.map((x, k) => x.cond + '=' + (series[series.length - 1].per[k] || {}).commitMB).join(' '));
      if (Date.now() - t1 >= IDLE_S * 1000) break;
      await sleep(Math.min(EVERY_S * 1000, Math.max(1000, IDLE_S * 1000 - (Date.now() - t1))));
    }
    const rows = snap();
    for (const inst of insts) {
      if (inst.failed) continue;
      inst.procs = treeOf(rows, inst.pid);
      inst.commitMB = sum(inst.procs, 'commitMB'); inst.wsPrivMB = sum(inst.procs, 'wsPrivMB');
    }
    // Where each process's commit lives (regions.ps1), still before any CDP attach.
    try {
      const pids = insts.filter((x) => !x.failed).flatMap((x) => x.procs.map((p) => p.pid));
      const f = path.join(OUT, 'regions.tmp.json');
      execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'regions.ps1'), '-Pids', pids.join(','), '-Out', f], { stdio: 'ignore', timeout: 180000 });
      const reg = new Map(JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')).map((r) => [r.pid, r]));
      for (const x of insts) if (!x.failed) for (const p of x.procs) p.regions = reg.get(p.pid) || null;
    } catch (e) { log('regions failed: ' + e.message); }
    // CDP and the main-process probe only AFTER the clean snapshot: attaching costs memory.
    for (const inst of insts) {
      if (inst.failed) continue;
      inst.heaps = await targetHeaps(inst);
      if (inst.profileDir) {
        try { inst.logLines = fs.readFileSync(path.join(inst.profileDir, 'quartz.log'), 'utf8').split(/\r?\n/).filter((l) => /ad blocker|memory clean-up|crashed|Node\.js warned/.test(l)).map((l) => l.slice(0, 220)); } catch (e) { inst.logLines = ['no quartz.log: ' + e.message]; }
        for (const l of inst.logLines) inst.notes.push('log: ' + l.replace(/^\S+\s+/, ''));
      }
      if (inst.main) {
        try {
          // includeCommandLineAPI: that is what gives the main-process inspector a require().
          const r = await inst.main.send('Runtime.evaluate', { expression: MAIN_INFO, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true });
          if (r.error || r.result.exceptionDetails) throw new Error(JSON.stringify(r.error || r.result.exceptionDetails).slice(0, 400));
          inst.mainInfo = JSON.parse(r.result.result.value);
        } catch (e) { inst.mainInfo = { error: e.message }; }
        try {
          const r = await inst.main.send('HeapProfiler.getSamplingProfile');
          if (r.result) {
            inst.mainHeap = foldHeap(r.result.profile, inst.app);
            fs.writeFileSync(path.join(OUT, 'main-heap-' + inst.i + '.heapprofile'), JSON.stringify(r.result.profile));
          } else inst.mainHeap = { error: JSON.stringify(r.error) };
        } catch (e) { inst.mainHeap = { error: e.message }; }
        // Chromium's own allocator accounting (memory-infra, one detailed dump) for every process
        // of this instance, BEFORE the GC experiment below.
        try {
          const r = await inst.main.send('Runtime.evaluate', { expression: TRACE_MEM, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true });
          if (r.error || r.result.exceptionDetails) throw new Error(JSON.stringify(r.error || r.result.exceptionDetails).slice(0, 300));
          inst.memInfra = foldMemDump(r.result.result.value, inst.procs);
        } catch (e) { inst.memInfra = { error: e.message }; }
        // The experiment: what one low-memory GC in the main process gives back (commit of the
        // main process before, and 5 s after; the sampled heap after is the truly live part).
        try {
          const mainCommit = () => { const p = snap().find((x) => x.pid === inst.pid); return p ? +(p.priv / 1048576).toFixed(1) : null; };
          const before = mainCommit();
          const t0 = Date.now();
          const g = await inst.main.send('HeapProfiler.collectGarbage');
          const ms = Date.now() - t0;
          await sleep(5000);
          inst.gcExperiment = { before, after: mainCommit(), ms, error: g.error ? JSON.stringify(g.error) : undefined };
          const r = await inst.main.send('Runtime.evaluate', { expression: MAIN_INFO, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true });
          if (r.result && r.result.result && typeof r.result.result.value === 'string') inst.gcExperiment.mainInfoAfter = JSON.parse(r.result.result.value).mem;
          const p2 = await inst.main.send('HeapProfiler.getSamplingProfile');
          if (p2.result) inst.mainHeapAfterGc = foldHeap(p2.result.profile, inst.app);
        } catch (e) { inst.gcExperiment = { error: e.message }; }
        inst.main.close(); delete inst.main;
      }
    }
    // Per condition: per-kind medians.
    const by = new Map();
    for (const inst of insts) { if (inst.failed) continue; if (!by.has(inst.cond)) by.set(inst.cond, []); by.get(inst.cond).push(inst); }
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? +(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(1) : null; };
    const lines = [];
    lines.push('mem-bench ' + new Date().toISOString() + ' | load ' + LOAD_S + ' s, settle ' + SETTLE_S + ' s, idle ' + IDLE_S + ' s | ' + os.cpus().length + ' cpus ' + (os.totalmem() / 1073741824).toFixed(1) + ' GB');
    const summary = {};
    for (const [cond, list] of by) {
      const kinds = new Set(); for (const x of list) for (const p of x.procs) kinds.add(p.kind);
      const row = { n: list.length, commitMB: med(list.map((x) => x.commitMB)), commitRange: [Math.min(...list.map((x) => x.commitMB)), Math.max(...list.map((x) => x.commitMB))], wsPrivMB: med(list.map((x) => x.wsPrivMB)), kinds: {} };
      for (const k of Array.from(kinds).sort()) {
        const per = list.map((x) => x.procs.filter((p) => p.kind === k));
        row.kinds[k] = { count: med(per.map((a) => a.length)), commitMB: med(per.map((a) => sum(a, 'commitMB'))), wsPrivMB: med(per.map((a) => sum(a, 'wsPrivMB'))) };
      }
      summary[cond] = row;
      lines.push('');
      lines.push(cond + ' (n=' + row.n + '): commit ' + row.commitMB + ' MB [' + row.commitRange.join('-') + '], private WS ' + row.wsPrivMB + ' MB');
      for (const [k, v] of Object.entries(row.kinds)) lines.push('  ' + k.padEnd(28) + ' x' + v.count + '  commit ' + String(v.commitMB).padStart(7) + '  privWS ' + String(v.wsPrivMB).padStart(7));
      for (const p of list[0].procs) {
        const g = p.regions;
        if (!g || g.error || !/^(browser|renderer#1|renderer#2|gpu-process)$/.test(p.kind)) continue;
        lines.push('  regions #' + list[0].i + ' ' + p.kind + ': private ' + g.privMB + ', image-writable ' + g.imageWMB + ', mapped ' + g.mappedMB + ' MB | by reservation ' + Object.entries(g.buckets).map((e) => e[0].slice(2) + ' ' + e[1]).join(', ') + ' | top ' + g.top.slice(0, 6).map((t) => t[1] + '/' + t[0]).join(' ') + ' | images ' + g.images.slice(0, 8).map((e) => e[0] + ' ' + e[1]).join(', '));
      }
      for (const x of list) for (const h of x.heaps || []) if (h.heapUsedMB !== undefined) lines.push('  heap #' + x.i + ' ' + h.type + ' ' + h.url.slice(0, 60) + ': used ' + h.heapUsedMB + ' / total ' + h.heapTotalMB + ' MB, nodes ' + h.nodes + ', listeners ' + h.listeners);
    }
    for (const inst of insts) {
      if (!inst.mainInfo && !inst.mainHeap) continue;
      lines.push('');
      lines.push('main probe #' + inst.i + ' ' + inst.cond + ': ' + JSON.stringify(inst.mainInfo && inst.mainInfo.mem));
      if (inst.mainInfo && inst.mainInfo.metrics) for (const m of inst.mainInfo.metrics) { const w = (inst.mainInfo.wcs || []).filter((c) => c.pid === m.pid).map((c) => c.type + ' ' + c.url.slice(0, 50)).join(' + '); lines.push('  ' + m.pid + ' ' + m.type + ' ' + m.service + ' ' + m.privMB + ' MB ' + w); }
      if (inst.mainInfo && inst.mainInfo.spaces) lines.push('  spaces: ' + inst.mainInfo.spaces.map((s) => s.n.replace('_space', '') + ' ' + s.usedMB + '/' + s.sizeMB).join(', '));
      if (inst.mainInfo && inst.mainInfo.nodeModules) lines.push('  modules ' + inst.mainInfo.modules + ', packages: ' + inst.mainInfo.nodeModules.join(' '));
      if (inst.mainHeap && inst.mainHeap.byQuartzFile) {
        lines.push('  live JS heap sampled: ' + inst.mainHeap.totalMB + ' MB');
        lines.push('  by package: ' + inst.mainHeap.byPackage.map((e) => e[0] + ' ' + e[1]).join(', '));
        lines.push('  by Quartz file: ' + inst.mainHeap.byQuartzFile.map((e) => e[0] + ' ' + e[1]).join(', '));
        lines.push('  by Quartz fn: ' + inst.mainHeap.byQuartzFn.slice(0, 20).map((e) => e[0] + ' ' + e[1]).join(', '));
        lines.push('  by leaf: ' + inst.mainHeap.byLeaf.slice(0, 20).map((e) => e[0] + ' ' + e[1]).join(', '));
      } else if (inst.mainHeap) lines.push('  heap: ' + JSON.stringify(inst.mainHeap));
      if (inst.memInfra) for (const [k, v] of Object.entries(inst.memInfra)) lines.push('  memory-infra ' + k + (v && v.top ? ': footprint ' + v.footprintMB + ' MB | ' + v.top.map((e) => e[0] + ' ' + e[1]).join(', ') + ' || ' + v.detail.map((e) => e[0] + ' ' + e[1]).join(', ') : ': ' + JSON.stringify(v)));
      if (inst.gcExperiment) lines.push('  GC experiment (HeapProfiler.collectGarbage): main commit ' + inst.gcExperiment.before + ' -> ' + inst.gcExperiment.after + ' MB (' + inst.gcExperiment.ms + ' ms)' + (inst.gcExperiment.error ? ' ERROR ' + inst.gcExperiment.error : '') + ' | after: ' + JSON.stringify(inst.gcExperiment.mainInfoAfter));
      if (inst.mainHeapAfterGc && inst.mainHeapAfterGc.byPackage) lines.push('  live JS heap after GC: ' + inst.mainHeapAfterGc.totalMB + ' MB; by package: ' + inst.mainHeapAfterGc.byPackage.slice(0, 8).map((e) => e[0] + ' ' + e[1]).join(', ') + '; by Quartz file: ' + inst.mainHeapAfterGc.byQuartzFile.slice(0, 10).map((e) => e[0] + ' ' + e[1]).join(', '));
    }
    for (const inst of insts) if (inst.failed || inst.notes.length) lines.push('note #' + inst.i + ' ' + inst.cond + ': ' + (inst.failed || inst.notes.join('; ')));
    fs.writeFileSync(path.join(OUT, 'summary.txt'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ argv, summary, series: series.map((s) => ({ at: s.at, per: s.per.map((p, k) => p && Object.assign({ cond: insts[k].cond }, p)) })), insts: insts.map((x) => { const o = Object.assign({}, x); delete o.main; return o; }) }, null, 1));
    console.log(lines.join('\n'));
  } finally {
    clearTimeout(guard);
    kill();
    for (const x of insts) if (x.udd) { try { fs.rmSync(x.udd, { recursive: true, force: true }); } catch (e) { /* locked */ } }
    log('done in ' + ((Date.now() - T0) / 60000).toFixed(1) + ' min');
  }
})().catch((e) => { console.error('mem-bench failed:', e && e.stack || e); process.exit(1); });
