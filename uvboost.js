// uvboost.js -- keep Chromium's browser main thread from preempting Electron's libuv poll
// ("embed") thread, which is what locks the two into waking each other thousands of times a
// second (the focused-Home wakeup storm). By default the embed thread's priority goes up one
// notch above the main thread's (DEFAULT_LEVEL); a guard puts it back if it ever burns CPU.
//
// Why (next-week/quartz-efficiency.md, rounds 3-4, 2026-10-15; Electron 44.3 shell/common/
// node_bindings.cc + node_bindings_win.cc). Electron runs Node's loop with two threads sharing
// libuv's I/O completion port, which libuv creates with a CONCURRENCY OF 1:
//   - the embed thread: uv_sem_wait, then GetQueuedCompletionStatus(timeout); a real packet is put
//     straight back on the port; then it posts UvRunOnce to the main thread and loops;
//   - the main thread's UvRunOnce: uv_run(NOWAIT), whose poll takes packets with a zero timeout,
//     then uv_sem_post.
// A concurrency-1 port gives no packet to a caller while another thread associated with it is
// RUNNING (ready counts too), and both threads are associated. Chromium runs CrBrowserMain at
// AboveNormal (base 9); the embed thread is Normal (8). So when the embed thread's post wakes the
// main thread on the same CPU, the main thread preempts it BEFORE it reaches its semaphore wait,
// its zero-timeout poll comes back empty (the embed thread still counts as running), it posts the
// semaphore, and the moment it goes idle the embed thread finds the semaphore already posted and
// the packet still on the port, takes it, puts it back, posts again -- and the main thread
// preempts it again. Measured (rounds 9-11): two threads at the same rate, uv_run iterating
// 300-4,000 times a second with ~0 packets taken, every other process quiet, no JS. Electron knows
// the single-CPU form of it ("cpu pegging likely caused by a busy loop in PollEvents": it makes the
// port concurrency 2 on one-CPU machines); pinning plain Electron to one CPU reproduces it at
// ~6,000 wakeups/s. On more CPUs it happens in episodes, whenever the scheduler puts the woken main
// thread on the embed thread's CPU. Any packet can start one: Node I/O (the stats sampler's
// typeperf pipe, the now-playing HTTP poll), uv_async_send, libuv's own handle-start interrupts.
// That is why focus "causes" it: focus starts those Home pollers.
//
// How: in this process, 15 s after start (koffi, no child process), find the embed
// thread and raise its priority, so the main thread cannot preempt it between its post and its
// semaphore wait. It is identified as the one UNNAMED thread that starts at the same address as the
// threads Node and libuv create and name (V8Worker, DelayedTaskSchedulerWorker, libuv-worker):
// libuv's uv_thread_create trampoline. Exactly one, or nothing changes (state 'failed', logged in
// quartz.log with the reason). It runs for microseconds per wakeup; the guard reads its CPU time
// once a minute and puts its old priority back if it ever used more than GUARD_MAX_SHARE of a core.
// Chromium's own threads, the main thread and every other process keep their priorities.
//
//   QUARTZ_UVBOOST=0 | off                      do nothing (bench A/B)
//   QUARTZ_UVBOOST=abovenormal|highest|timecritical   that level instead of the default (bench)
'use strict';

// 15 s: the find (koffi load + a system-wide thread snapshot) holds the main thread ~50 ms, up to
// ~230 ms on a loaded machine; at 15 s that is past the boot and first paint. The storm needs Home
// focused and idle for a while, so nothing is lost before then.
const DEFAULT_DELAY_MS = 15000;
/** Win32 SetThreadPriority values by the names QUARTZ_UVBOOST takes. */
const LEVELS = { abovenormal: 1, highest: 2, timecritical: 15 };
/**
 * The level the embed thread gets unless QUARTZ_UVBOOST says otherwise. Round 4 (local, n=2 per
 * cell, pinned to one CPU; storm = uv_run loops far above packets taken): AboveNormal, the main
 * thread's own base, stormed in 2 of 4 runs (the main thread's wake boost still lifts it above);
 * Highest and TimeCritical stopped it in 4 of 4, the thread then using under 0.1% of a core.
 * Highest is the lowest level that works.
 */
const DEFAULT_LEVEL = 'highest';
const LEVEL_WORDS = { '-15': 'Idle', '-2': 'Lowest', '-1': 'BelowNormal', 0: 'Normal', 1: 'AboveNormal', 2: 'Highest', 15: 'TimeCritical' };
/** The threads Node and libuv create with uv_thread_create and then name. */
const LIBUV_NAMES = ['libuv-worker', 'V8Worker', 'DelayedTaskSchedulerWorker'];
/** The guard: how often it reads the raised thread's CPU time, and the share of one core that undoes it. */
const GUARD_EVERY_MS = 60000;
const GUARD_MAX_SHARE = 0.25;

const TH32CS_SNAPTHREAD = 0x4;
const THREAD_SET_INFORMATION = 0x20;
const THREAD_QUERY_INFORMATION = 0x40;
const THREAD_QUERY_LIMITED_INFORMATION = 0x800;
const ThreadQuerySetWin32StartAddress = 9;
const PRIORITY_ERROR = 0x7fffffff;
const INVALID = BigInt.asUintN(64, -1n);

const words = (p) => (Object.prototype.hasOwnProperty.call(LEVEL_WORDS, String(p)) ? LEVEL_WORDS[String(p)] : 'priority ' + p);

/** The env value as 'off' or a LEVELS key (anything unrecognised: the default). */
function settingFrom(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_-]/g, '');
  if (s === '0' || s === 'off' || s === 'false' || s === 'no') return 'off';
  if (Object.prototype.hasOwnProperty.call(LEVELS, s)) return s;
  return DEFAULT_LEVEL;
}

/**
 * Pick the embed thread from a process's threads: rows of { tid, start, name } where start is the
 * Win32 start address as a hex string (null: unreadable) and name the thread description ('' for
 * none; null: unreadable). Returns { tid, start, named } or { why } in plain words.
 */
function pickEmbed(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const named = list.filter((r) => r && r.start && LIBUV_NAMES.includes(r.name));
  if (!named.length) return { why: 'none of the threads Node names (' + LIBUV_NAMES.join(', ') + ') were found among ' + list.length + ' threads' };
  const starts = [...new Set(named.map((r) => r.start))];
  if (starts.length !== 1) return { why: "the threads Node names start at " + starts.length + ' different addresses, not one' };
  const there = list.filter((r) => r && r.start === starts[0]);
  const unknown = there.filter((r) => r.name == null).length;
  if (unknown) return { why: unknown + " thread(s) at libuv's start address could not be read, so the right one cannot be told apart" };
  const cands = there.filter((r) => r.name === '');
  if (cands.length !== 1) return { why: cands.length + " unnamed threads start at libuv's start address, not exactly one" };
  return { tid: cands[0].tid, start: starts[0], named: named.length };
}

let api;          // undefined: not tried yet; null: unavailable; object: bound
let whyNot = '';

/** Bind the Win32 calls once (koffi, already a dependency: procfind.js, embed.js). Null when it cannot. */
function load() {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== 'win32') { whyNot = 'not Windows'; return api; }
  try {
    const koffi = require('koffi');
    const k32 = koffi.load('kernel32.dll');
    const ntdll = koffi.load('ntdll.dll');
    api = {
      koffi,
      ptrSize: koffi.sizeof('void *'),
      snapshot: k32.func('void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)'),
      first: k32.func('bool __stdcall Thread32First(void *h, _Inout_ uint8_t *te)'),
      next: k32.func('bool __stdcall Thread32Next(void *h, _Inout_ uint8_t *te)'),
      open: k32.func('void * __stdcall OpenThread(uint32_t access, bool inherit, uint32_t tid)'),
      close: k32.func('bool __stdcall CloseHandle(void *h)'),
      describe: k32.func('int32_t __stdcall GetThreadDescription(void *h, _Out_ void **desc)'),
      localFree: k32.func('void * __stdcall LocalFree(void *p)'),
      queryThread: ntdll.func('int32_t __stdcall NtQueryInformationThread(void *h, int32_t cls, _Inout_ uint8_t *info, uint32_t len, void *ret)'),
      getPriority: k32.func('int32_t __stdcall GetThreadPriority(void *h)'),
      setPriority: k32.func('bool __stdcall SetThreadPriority(void *h, int32_t p)'),
      times: k32.func('bool __stdcall GetThreadTimes(void *h, _Out_ uint64_t *c, _Out_ uint64_t *e, _Out_ uint64_t *k, _Out_ uint64_t *u)'),
      cycles: k32.func('bool __stdcall QueryThreadCycleTime(void *h, _Out_ uint64_t *c)'),
      address: (p) => koffi.address(p),
    };
  } catch (err) {
    api = null;
    whyNot = (err && err.message) || 'koffi failed to load';
  }
  return api;
}

/** The thread ids of process `pid` (a Toolhelp thread snapshot). Throws in plain words. */
function threadIds(pid, w) {
  const h = w.snapshot(TH32CS_SNAPTHREAD, 0);
  const at = h ? BigInt(w.address(h)) : 0n;
  if (!h || at === 0n || at === INVALID) throw new Error('the thread snapshot failed');
  try {
    const te = Buffer.alloc(28); // THREADENTRY32
    te.writeUInt32LE(28, 0);
    const out = [];
    let ok = w.first(h, te);
    while (ok) {
      if (te.readUInt32LE(12) === pid) out.push(te.readUInt32LE(8));
      ok = w.next(h, te);
    }
    return out;
  } finally {
    try { w.close(h); } catch (e) { /* closed */ }
  }
}

/** { tid, start, name } for one thread (start/name null when unreadable; a gone thread is both). */
function readThread(tid, w) {
  const h = w.open(THREAD_QUERY_INFORMATION | THREAD_QUERY_LIMITED_INFORMATION, false, tid);
  if (!h) return { tid, start: null, name: null };
  try {
    let name = null;
    const d = [null];
    if (w.describe(h, d) >= 0 && d[0]) {
      try { name = String(w.koffi.decode(d[0], 'char16_t', -1)); } finally { w.localFree(d[0]); }
    }
    let start = null;
    const b = Buffer.alloc(8);
    if (w.queryThread(h, ThreadQuerySetWin32StartAddress, b, w.ptrSize, null) === 0) {
      start = (w.ptrSize === 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0))).toString(16);
    }
    return { tid, start, name };
  } finally {
    w.close(h);
  }
}

/** Find process `pid`'s embed thread: { tid, start, named, threads } or { why, threads }. */
function findEmbed(pid, w) {
  const tids = threadIds(pid, w);
  const rows = tids.map((t) => readThread(t, w));
  return Object.assign({ threads: rows.length }, pickEmbed(rows));
}

/** Set thread `tid` to Win32 priority `value`: { ok, was, now, why }. */
function setPriority(tid, value, w) {
  const h = w.open(THREAD_SET_INFORMATION | THREAD_QUERY_INFORMATION, false, tid);
  if (!h) return { ok: false, why: 'thread ' + tid + ' could not be opened' };
  try {
    const was = w.getPriority(h);
    if (was === PRIORITY_ERROR) return { ok: false, why: 'thread ' + tid + "'s priority could not be read" };
    if (!w.setPriority(h, value)) return { ok: false, was, why: 'Windows refused to change thread ' + tid + "'s priority" };
    const now = w.getPriority(h);
    return now === value ? { ok: true, was, now } : { ok: false, was, now, why: 'thread ' + tid + ' reads back as ' + words(now) + ', not ' + words(value) };
  } finally {
    w.close(h);
  }
}

/** Thread `tid`'s CPU time (100 ns units, kernel + user) and cycle count, or null when unreadable. */
function threadCpu(tid, w) {
  const h = w.open(THREAD_QUERY_INFORMATION | THREAD_QUERY_LIMITED_INFORMATION, false, tid);
  if (!h) return null;
  try {
    const c = [0], e = [0], k = [0], u = [0], cy = [0];
    if (!w.times(h, c, e, k, u)) return null;
    const cycles = w.cycles(h, cy) ? Number(cy[0]) : null;
    return { cpu100ns: Number(k[0]) + Number(u[0]), cycles, priority: w.getPriority(h) };
  } finally {
    w.close(h);
  }
}

/** Share of one core a thread used between two threadCpu() readings `ms` apart (0..n). */
function cpuShare(a, b, ms) {
  if (!a || !b || !(ms > 0)) return null;
  return Math.max(0, b.cpu100ns - a.cpu100ns) / 1e4 / ms;
}

/**
 * Find process `pid`'s embed thread and set it to LEVELS[level]. Also the bench's way in from
 * outside the process (tools/efficiency/wake-bisect.js emb=<level>).
 * Returns { ok, tid, was, now, why, threads }.
 */
function boostProcess(pid, level, w) {
  const b = w || load();
  if (!b) return { ok: false, why: 'the Windows thread calls could not be loaded (' + whyNot + ')' };
  if (!Object.prototype.hasOwnProperty.call(LEVELS, level)) return { ok: false, why: 'unknown level ' + level };
  let found;
  try { found = findEmbed(pid, b); } catch (e) { return { ok: false, why: 'reading the threads failed: ' + ((e && e.message) || e) }; }
  if (!found.tid) return { ok: false, why: found.why, threads: found.threads };
  const r = setPriority(found.tid, LEVELS[level], b);
  return Object.assign({ tid: found.tid, threads: found.threads }, r);
}

let current = null;
const lines = [];
const listeners = [];

/**
 * Arm it once per process. Windows + Electron main process only; anything else returns
 * { state: 'skipped', reason }. Returns the live status object:
 *   { state: 'pending' | 'applied' | 'failed' | 'off' | 'skipped' | 'undone', level, tid, was, reason, ms, share }
 *   opts.proc      process object (harness)
 *   opts.env       env object (harness; default proc.env)
 *   opts.api       the Win32 bindings stand-in (harness; default koffi's)
 *   opts.delayMs   wait before applying (default 15 s: off the boot path; Node's threads are named by then)
 *   opts.guardEveryMs / opts.guardMaxShare / opts.clock / opts.timers   the guard (harness)
 *   opts.log       (line) => void; default: kept for onLine() subscribers, and console.log
 */
function install(opts) {
  const o = opts || {};
  const proc = o.proc || process;
  if (current && !o.proc) return current;
  const env = o.env || proc.env || {};
  const level = settingFrom(env.QUARTZ_UVBOOST);
  const status = { state: 'pending', level, tid: null, was: null, reason: '', ms: null, share: null };
  if (!o.proc) current = status;
  const say = typeof o.log === 'function' ? o.log : emit;
  const clock = typeof o.clock === 'function' ? o.clock : Date.now;
  const timers = o.timers || { setTimeout, setInterval, clearInterval };
  if (proc.platform !== 'win32') { status.state = 'skipped'; status.reason = 'not Windows'; return status; }
  if (proc.type !== 'browser') { status.state = 'skipped'; status.reason = 'not the Electron main process'; return status; }
  if (level === 'off') {
    status.state = 'off'; status.reason = 'QUARTZ_UVBOOST=' + env.QUARTZ_UVBOOST;
    say('Idle wakeup-storm fix: off (QUARTZ_UVBOOST=' + env.QUARTZ_UVBOOST + '); Electron\'s Node I/O thread keeps its normal priority.');
    return status;
  }
  const fail = (why) => {
    status.state = 'failed'; status.reason = String(why).slice(0, 300);
    say('Idle wakeup-storm fix NOT on: ' + status.reason + '. Nothing was changed; Quartz runs as before, and a focused Home may wake the CPU thousands of times a second.');
  };
  const guard = (w, tid, was) => {
    const every = Number.isFinite(o.guardEveryMs) ? o.guardEveryMs : GUARD_EVERY_MS;
    const max = Number.isFinite(o.guardMaxShare) ? o.guardMaxShare : GUARD_MAX_SHARE;
    let last = threadCpu(tid, w), lastAt = clock();
    if (!last) return;
    const iv = timers.setInterval(() => {
      const now = threadCpu(tid, w), at = clock();
      if (!now) { timers.clearInterval(iv); return; } // the thread is gone: nothing left to guard
      const span = at - lastAt;
      const share = cpuShare(last, now, span);
      last = now; lastAt = at;
      status.share = share;
      if (share != null && share > max) {
        timers.clearInterval(iv);
        const r = setPriority(tid, was, w);
        status.state = 'undone';
        status.reason = 'used ' + Math.round(share * 100) + '% of a core';
        say('Idle wakeup-storm fix undone: Electron\'s Node I/O thread (thread ' + tid + ') used ' + Math.round(share * 100) +
          '% of a CPU core over the last ' + Math.round(span / 1000) + ' s at raised priority, so it ' +
          (r.ok ? 'is back at ' + words(was) : 'should go back to ' + words(was) + ' but could not (' + r.why + ')') + ', and other programs keep their share of the CPU.');
      }
    }, every);
    if (iv && typeof iv.unref === 'function') iv.unref();
  };
  const apply = () => {
    const t0 = clock();
    const w = o.api || load();
    if (!w) { fail('the Windows thread calls could not be loaded (' + whyNot + ')'); return; }
    let r;
    try { r = boostProcess(proc.pid, level, w); } catch (e) { fail('it threw: ' + ((e && e.message) || e)); return; }
    status.ms = clock() - t0;
    if (!r.ok) { status.tid = r.tid || null; fail(r.why || 'no reason given'); return; }
    status.state = 'applied'; status.tid = r.tid; status.was = r.was; status.reason = 'was ' + words(r.was);
    say('Idle wakeup-storm fix on: Electron\'s Node I/O thread (thread ' + r.tid + ', the one unnamed thread of ' + r.threads +
      ' at libuv\'s start address) now runs at ' + words(r.now) + ' priority, up from ' + words(r.was) + ', so the main thread cannot keep interrupting it; took ' + status.ms + ' ms.');
    try { guard(w, r.tid, r.was); } catch (e) { say('Idle wakeup-storm fix: its CPU guard could not start (' + ((e && e.message) || e) + ').'); }
  };
  const delayMs = Number.isFinite(o.delayMs) ? Math.max(0, o.delayMs) : DEFAULT_DELAY_MS;
  if (delayMs === 0) apply();
  else { const t = timers.setTimeout(apply, delayMs); if (t && typeof t.unref === 'function') t.unref(); }
  return status;
}

/** A line for quartz.log: kept, printed, and handed to every onLine() subscriber. */
function emit(text) {
  lines.push(text);
  try { console.log('[uvboost] ' + text); } catch (e) { /* no console */ }
  for (const fn of listeners) { try { fn(text); } catch (e) { /* a broken sink is not ours */ } }
}

/** fn(line) for every line so far and every later one (main.js: into quartz.log once it is open). */
function onLine(fn) {
  if (typeof fn !== 'function') return;
  listeners.push(fn);
  for (const l of lines) { try { fn(l); } catch (e) { /* as above */ } }
}

/** The status of this process's install() (null before it ran). */
function status() { return current; }

module.exports = {
  install, status, onLine, settingFrom, pickEmbed, boostProcess, findEmbed, setPriority, threadCpu, cpuShare, load,
  LEVELS, DEFAULT_LEVEL, DEFAULT_DELAY_MS, GUARD_EVERY_MS, GUARD_MAX_SHARE, LIBUV_NAMES,
};
