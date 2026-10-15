// tools/efficiency/wake-hook.js -- preloaded into Quartz's MAIN process by wake-bisect.js through
// Electron's own `electron.exe -r <this file> . ...` (default_app's --require). Test-only: nothing
// in the app requires it.
//
//   QWAKE_OFF=a,b,c   every require() whose request is './a' (any dir) or exactly 'a' gets a
//                     do-nothing stub instead of the module: a Proxy where every property is the
//                     stub, every call returns the stub, `then` is undefined, iteration is empty.
//                     ALL = every './x' require made by main.js itself.
//   QWAKE_NO=fswatch,interval,...  neutralize one Node API for the whole process (fs.watch,
//                     setInterval) -- a coarser cut than a module.
//   QWAKE_DIAG=<file> at QWAKE_DIAG_AT s after start, count async_hooks inits by type and by stack
//                     for QWAKE_DIAG_FOR s; snapshot the live handles / requests; write <file>.
//   QWAKE_SCHOOL=...  change school.create()'s options, or load an older school.js (see below).
//                     ab-<name> needs tools/efficiency/ab/school-<name>.js, made with e.g.
//                     `git show 58be603:school.js > tools/efficiency/ab/school-master.js` (not
//                     committed: a copy of a 1,400-line file per A/B).
//
// What it found (2026-10-15, rounds wake-r1..r5.txt, results in next-week/quartz-efficiency.md):
// school.js's 3 s reader armed a 100 ms push timer on every read; each setTimeout in Electron's
// main process calls process.activateUvLoop(), and that, from a timer callback every few seconds,
// locks the main thread and Electron's libuv poll thread into waking each other for long spells.
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const OFF = new Set(list(process.env.QWAKE_OFF));
const NO = new Set(list(process.env.QWAKE_NO));
const T0 = Date.now();
const stubbed = [];

function makeStub(name) {
  const target = function qwakeStub() {};
  const p = new Proxy(target, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* empty() {};
      if (k === 'then') return undefined;
      if (k === 'toJSON') return () => null;
      if (k === '__qwakeStub') return name;
      return p;
    },
    apply() { return p; },
    construct() { return p; },
    has() { return false; },
  });
  return p;
}

// QWAKE_SCHOOL=a,b: change what main.js passes to school.create() (a bisect INSIDE school.js):
//   noauto      autoStart: false (no watch, no policy read, no presence/read timers)
//   run-false   isRunning: () => false (no koffi, no tasklist)
//   run-null    isRunning: () => null (the tasklist path, as master did)
//   tmpdir      notesDir: a fresh temp dir that exists (so fs.watch succeeds, as on the user's box)
//   kill<ms>    a setInterval of exactly <ms> made inside create() is never started
//   noreg       spawn: refuses `reg` (the policy read), passes everything else to the real spawn
const SCHOOL = new Set(list(process.env.QWAKE_SCHOOL));
const KEEP = new Set([...OFF].filter((x) => x.startsWith('-')).map((x) => x.slice(1)));
// QWAKE_AB=<name>: every './x' main.js requires is tools/efficiency/ab/x-<name>.js when that file
// exists (a whole older build's changed modules, e.g. made with
// `git show 5959017:stats.js > tools/efficiency/ab/stats-master.js`; not committed).
const AB = String(process.env.QWAKE_AB || '').trim();

if (OFF.size || SCHOOL.size || AB) {
  const load = Module._load;
  Module._load = function qwakeLoad(request, parent, isMain) {
    const rel = /^\.\.?[\\/]/.test(request);
    const base = rel ? path.basename(request).replace(/\.js$/, '') : request;
    const fromMain = parent && /[\\/]main\.js$/.test(parent.filename || '');
    if (!KEEP.has(base) && (OFF.has(base) || (OFF.has('ALL') && rel && fromMain))) {
      stubbed.push(base);
      return makeStub(base);
    }
    // ab-<name>: main.js's './school' is tools/efficiency/ab/school-<name>.js (an older school.js
    // for an A/B in one run); that copy's own './x' requires resolve against the app dir.
    if (AB && rel && fromMain) {
      const alt = path.join(__dirname, 'ab', base + '-' + AB + '.js');
      if (fs.existsSync(alt)) { stubbed.push(base + '@' + AB); return load.call(this, alt, parent, isMain); }
    }
    const ab = [...SCHOOL].find((x) => x.startsWith('ab-'));
    if (ab && base === 'school' && fromMain) {
      return load.call(this, path.join(__dirname, 'ab', 'school-' + ab.slice(3) + '.js'), parent, isMain);
    }
    if (rel && parent && /[\\/]efficiency[\\/]ab[\\/]/.test(parent.filename || '')) {
      return load.call(this, path.join(__dirname, '..', '..', request), parent, isMain);
    }
    const mod = load.apply(this, arguments);
    if (base === 'school' && SCHOOL.size && mod && typeof mod.create === 'function' && !mod.__qwake) {
      const create = mod.create;
      const wrapped = Object.assign({}, mod, { __qwake: true });
      wrapped.create = function qwakeSchool(options) {
        const o = Object.assign({}, options);
        if (SCHOOL.has('noauto')) o.autoStart = false;
        if (SCHOOL.has('run-false')) o.isRunning = () => false;
        if (SCHOOL.has('run-null')) o.isRunning = () => null;
        if (SCHOOL.has('tmpdir')) o.notesDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'qwake-notes-'));
        if (SCHOOL.has('noreg')) {
          const cp = require('child_process');
          if (!o.isRunning) o.isRunning = (n) => require(path.join(path.dirname(parent.filename), 'procfind')).running(n);
          o.spawn = (file, args, opt) => { if (file === 'reg') throw new Error('qwake: reg blocked'); return cp.spawn(file, args, opt); };
        }
        const kills = [...SCHOOL].filter((x) => /^kill\d+$/.test(x)).map((x) => Number(x.slice(4)));
        const realSI = global.setInterval;
        if (kills.length || [...SCHOOL].some((x) => /^noop\d+$/.test(x))) {
          global.setInterval = function qwakeSI(fn, ms, ...rest) {
            if (kills.includes(ms)) return { unref() { return this; }, ref() { return this; }, hasRef() { return false; } };
            if (SCHOOL.has('noop' + ms)) return realSI.call(this, () => {}, ms, ...rest);
            return realSI.call(this, fn, ms, ...rest);
          };
        }
        try { return create.call(this, o); } finally { global.setInterval = realSI; }
      };
      return wrapped;
    }
    return mod;
  };
}

// QWAKE_GUARD=on: install ../../uvquiet.js before main.js runs (an A/B on a build without it).
// QWAKE_GUARD=asyncid|all: the same, in that mode ('asyncid' = master 63df0be's rule).
// QWAKE_GUARD=off: make main.js's own install a no-op (the guard is already in place, as a fake).
// QWAKE_GUARD_LOG=<file>: every 10 s, write the guard's counters and where the activations that
// still go through come from (top stack frames, tallied).
if (process.env.QWAKE_GUARD === 'off' && typeof process.activateUvLoop === 'function') {
  const real = process.activateUvLoop;
  const passthrough = function activateUvLoop() { return real.apply(process, arguments); };
  passthrough.__uvquiet = { skipped: 0, passed: 0, disabledByHook: true };
  process.activateUvLoop = passthrough;
} else if (process.env.QWAKE_GUARD === 'on' || process.env.QWAKE_GUARD === 'asyncid' || process.env.QWAKE_GUARD === 'all' || process.env.QWAKE_GUARD_LOG) {
  // QWAKE_GUARD=asyncid|all: install that mode first (main.js's own install is then a no-op), so
  // one build can be A/B'd against the old async-id rule in the same run.
  const stacks = {};
  const logFile = process.env.QWAKE_GUARD_LOG;
  const gmode = process.env.QWAKE_GUARD === 'asyncid' || process.env.QWAKE_GUARD === 'all' ? process.env.QWAKE_GUARD : undefined;
  const counts = require(path.join(__dirname, '..', '..', 'uvquiet.js')).install({
    mode: gmode,
    onPass: logFile ? () => {
      const lines = String(new Error().stack).split('\n').slice(3, 7).map((l) => l.trim().replace(/\(.*[\\/]/, '(')).join(' < ');
      stacks[lines] = (stacks[lines] || 0) + 1;
    } : null,
  });
  if (logFile && counts) {
    const t = setInterval(() => {
      const top = Object.entries(stacks).sort((a, b) => b[1] - a[1]).slice(0, 15);
      try { fs.writeFileSync(logFile, JSON.stringify({ atS: Math.round((Date.now() - T0) / 1000), counts, top }, null, 1)); } catch (e) { /* diag only */ }
    }, 10000);
    t.unref();
  }
}

if (NO.has('fswatch')) {
  const { EventEmitter } = require('events');
  fs.watch = function qwakeWatch() { const e = new EventEmitter(); e.close = () => {}; e.ref = () => e; e.unref = () => e; return e; };
}
if (NO.has('unref')) {
  // Every timer stays ref'd: Timeout.prototype.unref does nothing.
  const t = setTimeout(() => {}, 1);
  Object.getPrototypeOf(t).unref = function qwakeNoUnref() { return this; };
  clearTimeout(t);
}
if (NO.has('interval')) {
  global.setInterval = function qwakeInterval() { return { ref() { return this; }, unref() { return this; }, hasRef() { return false; }, refresh() { return this; }, [Symbol.toPrimitive]() { return 0; } }; };
}

function describeHandle(h) {
  const o = { type: h && h.constructor ? h.constructor.name : typeof h };
  try {
    if (o.type === 'Timeout') {
      o.ms = h._idleTimeout; o.repeat = h._repeat; o.ref = typeof h.hasRef === 'function' ? h.hasRef() : undefined;
      o.fn = String(h._onTimeout).replace(/\s+/g, ' ').slice(0, 160);
    } else if (o.type === 'ChildProcess') {
      o.file = h.spawnfile; o.args = (h.spawnargs || []).slice(1, 6).join(' ').slice(0, 160); o.pid = h.pid;
    } else if (o.type === 'Socket' || o.type === 'Server' || o.type === 'Pipe' || o.type === 'WriteStream' || o.type === 'ReadStream') {
      o.fd = h._handle && h._handle.fd; o.handle = h._handle && h._handle.constructor && h._handle.constructor.name;
      o.paused = typeof h.isPaused === 'function' ? h.isPaused() : undefined; o.reading = h._handle ? h._handle.reading : undefined;
      o.addr = h.remoteAddress || (typeof h.address === 'function' ? (() => { try { return JSON.stringify(h.address()); } catch (e) { return ''; } })() : undefined);
      o.isStdio = h === process.stdout ? 'stdout' : h === process.stderr ? 'stderr' : h === process.stdin ? 'stdin' : undefined;
      o.pipePath = h._pipeName || h.path;
    } else if (o.type === 'FSWatcher' || o.type === 'StatWatcher') {
      o.ref = h._handle && typeof h._handle.hasRef === 'function' ? h._handle.hasRef() : undefined;
    }
  } catch (e) { o.err = String(e && e.message); }
  return o;
}

function snapshot() {
  const out = {};
  try { out.resources = process.getActiveResourcesInfo(); } catch (e) { out.resources = String(e); }
  try { out.handles = process._getActiveHandles().map(describeHandle); } catch (e) { out.handles = String(e); }
  try { out.requests = process._getActiveRequests().map((r) => (r && r.constructor ? r.constructor.name : typeof r)); } catch (e) { out.requests = String(e); }
  if (liveTimers.size) out.timers = timersNow();
  return out;
}

const DIAG = process.env.QWAKE_DIAG;
// diag: remember where every live timer was made (Node 24's _getActiveHandles() no longer lists
// timers), so the dump can say which code holds which timer.
const liveTimers = new Set();
/** The first n frames of a stack that are app code (not node internals, not this hook). */
function userFrames(stack, n) {
  return String(stack || '').split('\n').slice(1).map((l) => l.trim().replace(/^at\s+/, ''))
    .filter((l) => !/node:|wake-hook\.js|^new Promise|^Promise\.|<anonymous>\)?$/.test(l) && /[\\/(]/.test(l))
    .slice(0, n).map((l) => l.replace(/\(.*[\\/]/, '(')).join(' < ');
}
if (DIAG) {
  const site = () => {
    const keep = Error.stackTraceLimit; Error.stackTraceLimit = 14;
    const s = userFrames(new Error().stack, 3);
    Error.stackTraceLimit = keep;
    return s;
  };
  for (const name of ['setTimeout', 'setInterval']) {
    const orig = global[name];
    global[name] = function qwakeTimer(fn, ms, ...rest) {
      const t = orig.call(this, fn, ms, ...rest);
      try { t.__qsite = site(); liveTimers.add(t); } catch (e) { /* primitive */ }
      return t;
    };
  }
}
function timersNow() {
  const out = [];
  for (const t of liveTimers) {
    if (t._destroyed) { liveTimers.delete(t); continue; }
    out.push({ ms: t._idleTimeout, repeat: !!t._repeat, ref: typeof t.hasRef === 'function' ? t.hasRef() : undefined, site: t.__qsite });
  }
  return out;
}
if (DIAG) {
  const ah = require('async_hooks');
  const AT = Number(process.env.QWAKE_DIAG_AT || 70) * 1000;
  const FOR = Number(process.env.QWAKE_DIAG_FOR || 20) * 1000;
  const result = { stubbed, off: [...OFF], no: [...NO], snaps: [], inits: {}, stacks: {}, errors: [] };
  process.on('uncaughtException', (e) => { result.errors.push(String(e && e.stack).slice(0, 600)); });
  const write = () => { try { fs.writeFileSync(DIAG, JSON.stringify(result, null, 1)); } catch (e) { /* nowhere to say */ } };
  setTimeout(() => {
    result.snaps.push(Object.assign({ at: Date.now() - T0 }, snapshot()));
    let elu0 = null;
    try { elu0 = require('perf_hooks').performance.eventLoopUtilization(); } catch (e) { /* old node */ }
    const inits = result.inits, stacks = result.stacks;
    let busy = false;
    const hook = ah.createHook({
      init(id, type) {
        if (busy) return;
        inits[type] = (inits[type] || 0) + 1;
        if (type === 'PROMISE') return;
        busy = true;
        try {
          const keep = Error.stackTraceLimit; Error.stackTraceLimit = 20;
          const s = userFrames(new Error().stack, 5) || '(no app frame)';
          Error.stackTraceLimit = keep;
          const k = type + ' | ' + s;
          stacks[k] = (stacks[k] || 0) + 1;
        } finally { busy = false; }
      },
    });
    hook.enable();
    const t1 = Date.now();
    setTimeout(() => {
      hook.disable();
      result.windowMs = Date.now() - t1;
      try { const p = require('perf_hooks').performance; const e = p.eventLoopUtilization(elu0); result.elu = { idleMs: e.idle, activeMs: e.active, utilization: e.utilization }; } catch (e) { /* old node */ }
      result.snaps.push(Object.assign({ at: Date.now() - T0 }, snapshot()));
      const top = Object.entries(stacks).sort((a, b) => b[1] - a[1]).slice(0, 40);
      result.stacks = Object.fromEntries(top);
      write();
    }, FOR).unref();
  }, AT).unref();
  setTimeout(write, 5000).unref();
}

if (process.env.QWAKE_SNAP) {
  // A cheap handles-only snapshot (no async_hooks) at QWAKE_DIAG_AT s.
  setTimeout(() => {
    try { fs.writeFileSync(process.env.QWAKE_SNAP, JSON.stringify(Object.assign({ stubbed, off: [...OFF], no: [...NO] }, snapshot()), null, 1)); } catch (e) { /* nowhere */ }
  }, Number(process.env.QWAKE_DIAG_AT || 70) * 1000).unref();
}
