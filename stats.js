'use strict';

// stats.js — the new tab page's system stats, main-process side.
//
// The new tab page used to carry a search field. The user searches from the
// address bar instead, so the field is gone and a Task-Manager-ish strip
// (CPU, memory, disk, network, GPU) took its place. This module is where
// those numbers come from.
//
// Three rules shape everything here:
//
//   1. NOTHING RUNS WHILE NOBODY IS LOOKING. Subscribers are ref-counted per
//      webContents; at zero the interval stops and the counter child is
//      killed. A browser sitting on a normal page costs exactly nothing.
//
//   2. ONE CHILD PROCESS, NOT ONE PER SAMPLE. Disk, network and GPU are not
//      in Node's standard library on Windows, and spawning a PowerShell every
//      two seconds would cost more than everything it measures. Instead a
//      single long-lived `typeperf` streams CSV at the same 2 s cadence and
//      we read its stdout. Its stdout IS the clock for those three fields.
//
//   3. A MISSING COUNTER IS A DASH, NEVER A CRASH. typeperf is absent or
//      refuses on some machines (localised counter names, a disabled perf
//      library, group policy). Those fields go null, the page draws a dash,
//      and we retry at most once a minute.
//
// CPU and memory need no child: os.cpus() deltas and
// process.getSystemMemoryInfo() cover them, and they are the two figures that
// must never be missing.

const os = require('os');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cadence of the pushed sample, and of typeperf's own -si. Keep them equal. */
const SAMPLE_MS = 2000;

/**
 * The first sample must not make the page sit on dashes for two seconds, so
 * the first tick fires on a short window instead. Two os.cpus() readings this
 * close still give a usable percentage -- it is the same thing Task Manager
 * does on its first paint.
 */
const FIRST_SAMPLE_MS = 400;

/**
 * How long the sampler keeps running after the last unsubscribe. Switching
 * away from the new tab and back (or clicking into another window for a
 * second) must not pay the typeperf startup cost again -- it is a process
 * spawn plus a ~2 s wait for its first row.
 */
const GRACE_MS = 5000;

/** A failed typeperf is retried no more often than this. */
const RETRY_MS = 60000;

/**
 * Counter rows older than this are not trusted: typeperf is alive but wedged,
 * or the machine slept. Better a dash than a number from four minutes ago.
 */
const COUNTER_STALE_MS = 8000;

/**
 * The counters, in the order the header will name them. `_Total` for disk,
 * every instance for network (a machine has wifi + ethernet + loopback-ish
 * virtual adapters and Task Manager's figure is the sum), and every GPU
 * engine -- we filter to the 3D ones from the header, since the instance list
 * is per-process and only known at runtime.
 */
const TYPEPERF_COUNTERS = [
  '\\PhysicalDisk(_Total)\\% Disk Time',
  '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec',
  '\\PhysicalDisk(_Total)\\Disk Write Bytes/sec',
  '\\Network Interface(*)\\Bytes Received/sec',
  '\\Network Interface(*)\\Bytes Sent/sec',
  '\\GPU Engine(*)\\Utilization Percentage',
];

const TYPEPERF_ARGS = TYPEPERF_COUNTERS.concat(['-si', String(SAMPLE_MS / 1000)]);

// ---------------------------------------------------------------------------
// Pure helpers (exported for the harness)
// ---------------------------------------------------------------------------

function clampPercent(n) {
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/**
 * One CSV record -> its fields, unquoted. PDH quote-wraps every field and
 * doubles an embedded quote; instance names never contain a comma in
 * practice, but a split(',') would still be wrong the day one does.
 */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') { cur += ch; continue; }
      if (line[i + 1] === '"') { cur += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * `\\MACHINE\Object(instance)\Counter` -> { object, instance, counter }.
 * The machine name is stripped because it is this machine, and an instance is
 * optional. PDH already replaced any backslash inside an instance name with
 * an underscore, so the last backslash is always the counter separator.
 */
function parseCounterPath(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const machine = /^\\\\[^\\]+\\(.*)$/.exec(s);
  const rest = machine ? machine[1] : s.replace(/^\\+/, '');
  const cut = rest.lastIndexOf('\\');
  if (cut <= 0) return null;
  const objectPart = rest.slice(0, cut);
  const counter = rest.slice(cut + 1);
  const inst = /^([^(]+)\((.*)\)$/.exec(objectPart);
  return {
    object: (inst ? inst[1] : objectPart).trim(),
    instance: inst ? inst[2] : '',
    counter: counter.trim(),
  };
}

/**
 * typeperf's first line names its columns, and the GPU/network instance lists
 * are only knowable from it. Returns the column indices we care about, or
 * null when this is not a PDH header at all (an error message, a blank line)
 * or when not one counter we asked for came back -- a localised Windows names
 * them in its own language, and there is nothing to salvage from that.
 */
function parseTypeperfHeader(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  const fields = splitCsv(trimmed);
  if (fields.length < 2) return null;
  if (!/^\(PDH-CSV/i.test(fields[0].trim())) return null;

  const cols = {
    count: fields.length,
    diskPercent: -1,
    diskRead: -1,
    diskWrite: -1,
    netDown: [],
    netUp: [],
    gpu3d: [],
  };

  for (let i = 1; i < fields.length; i++) {
    const p = parseCounterPath(fields[i]);
    if (!p) continue;
    const object = p.object.toLowerCase();
    const counter = p.counter.toLowerCase();
    if (object === 'physicaldisk') {
      if (counter === '% disk time') cols.diskPercent = i;
      else if (counter === 'disk read bytes/sec') cols.diskRead = i;
      else if (counter === 'disk write bytes/sec') cols.diskWrite = i;
    } else if (object === 'network interface') {
      if (counter === 'bytes received/sec') cols.netDown.push(i);
      else if (counter === 'bytes sent/sec') cols.netUp.push(i);
    } else if (object === 'gpu engine') {
      // Task Manager's "GPU %" is the 3D engine; the Copy / VideoDecode /
      // LegacyOverlay engines are separate instances of the same counter and
      // summing all of them would read far above what the user is shown.
      if (counter === 'utilization percentage' && /engtype_3d$/i.test(p.instance)) cols.gpu3d.push(i);
    }
  }

  const matched = cols.diskPercent >= 0 || cols.diskRead >= 0 || cols.diskWrite >= 0
    || cols.netDown.length || cols.netUp.length || cols.gpu3d.length;
  return matched ? cols : null;
}

/**
 * One data row -> the raw counter values, or null when the line is not a data
 * row (typeperf's leading blank line, its "Exiting, please wait..." on the way
 * out, an error it printed instead). The column count has to match the header
 * exactly: that is a locale-independent test, where a date-format regex would
 * fail on a machine that writes 11.09.2026.
 *
 * A field that is not a number (PDH writes " " for a counter it could not
 * collect this round) becomes null; a sum of instances is null only when not
 * one instance answered.
 */
function parseTypeperfLine(line, cols) {
  if (typeof line !== 'string' || !cols) return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  const fields = splitCsv(trimmed);
  if (fields.length !== cols.count) return null;
  // The first field is the timestamp. If it parses as a number this is not a
  // typeperf row at all.
  if (Number.isFinite(Number(fields[0].trim()))) return null;

  let sawNumber = false;
  const at = (i) => {
    if (i < 0 || i >= fields.length) return null;
    const raw = fields[i].trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    sawNumber = true;
    return n;
  };
  const sumOf = (idxs) => {
    let total = 0;
    let any = false;
    for (const i of idxs) {
      const v = at(i);
      if (v === null) continue;
      any = true;
      total += v;
    }
    return any ? total : null;
  };

  const out = {
    stamp: fields[0].trim(),
    diskPercent: at(cols.diskPercent),
    diskReadBps: at(cols.diskRead),
    diskWriteBps: at(cols.diskWrite),
    netDownBps: sumOf(cols.netDown),
    netUpBps: sumOf(cols.netUp),
    gpuPercent: sumOf(cols.gpu3d),
  };
  return sawNumber ? out : null;
}

/**
 * Two os.cpus() readings -> whole-machine and per-core busy percentages.
 * Busy is 1 - idle/total over the window, which is exactly what Task Manager
 * plots. Returns null until there are two readings to compare.
 */
function cpuPercentFromTimes(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return null;
  const n = Math.min(prev.length, next.length);
  if (!n) return null;

  const cores = [];
  let idleDelta = 0;
  let totalDelta = 0;

  for (let i = 0; i < n; i++) {
    const a = prev[i] && prev[i].times ? prev[i].times : prev[i];
    const b = next[i] && next[i].times ? next[i].times : next[i];
    if (!a || !b) return null;
    const aTotal = (a.user || 0) + (a.nice || 0) + (a.sys || 0) + (a.idle || 0) + (a.irq || 0);
    const bTotal = (b.user || 0) + (b.nice || 0) + (b.sys || 0) + (b.idle || 0) + (b.irq || 0);
    const dTotal = bTotal - aTotal;
    const dIdle = (b.idle || 0) - (a.idle || 0);
    cores.push(dTotal > 0 ? round1(clampPercent(100 * (1 - dIdle / dTotal))) : 0);
    idleDelta += dIdle;
    totalDelta += dTotal;
  }

  return {
    percent: totalDelta > 0 ? round1(clampPercent(100 * (1 - idleDelta / totalDelta))) : 0,
    cores,
  };
}

/**
 * The contract shape, from whatever pieces exist. Everything optional is
 * null rather than absent or zero, because the page draws a dash for null and
 * a zero would be a lie.
 *
 * parts: { t, cpu, mem: { totalBytes, freeBytes }, counters, uptimeSec }
 */
function buildSample(parts) {
  const p = parts || {};
  const cpu = p.cpu || null;
  const mem = p.mem || null;
  const c = p.counters || null;

  const totalBytes = mem && Number.isFinite(mem.totalBytes) && mem.totalBytes > 0 ? Math.round(mem.totalBytes) : 0;
  const freeBytes = mem && Number.isFinite(mem.freeBytes) ? Math.max(0, Math.min(totalBytes, Math.round(mem.freeBytes))) : 0;
  const usedBytes = Math.max(0, totalBytes - freeBytes);

  const bytes = (n) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : null);

  return {
    t: Number.isFinite(p.t) ? p.t : Date.now(),
    cpu: {
      percent: cpu && Number.isFinite(cpu.percent) ? round1(clampPercent(cpu.percent)) : 0,
      cores: cpu && Array.isArray(cpu.cores) ? cpu.cores.map((v) => round1(clampPercent(v)) || 0) : [],
    },
    mem: {
      usedBytes,
      totalBytes,
      percent: totalBytes > 0 ? round1((usedBytes / totalBytes) * 100) : 0,
    },
    disk: {
      percent: c ? round1(clampPercent(c.diskPercent)) : null,
      readBps: c ? bytes(c.diskReadBps) : null,
      writeBps: c ? bytes(c.diskWriteBps) : null,
    },
    net: {
      downBps: c ? bytes(c.netDownBps) : null,
      upBps: c ? bytes(c.netUpBps) : null,
    },
    gpu: {
      percent: c ? round1(clampPercent(c.gpuPercent)) : null,
    },
    uptimeSec: Number.isFinite(p.uptimeSec) ? Math.max(0, Math.round(p.uptimeSec)) : 0,
  };
}

// ---------------------------------------------------------------------------
// The sampler
// ---------------------------------------------------------------------------

/**
 * deps (all optional, all injected by the harness):
 *   spawn      - child_process.spawn stand-in for the typeperf child
 *   setTimer / clearTimer - so grace, retry and the tick run in virtual time
 *   now        - Date.now stand-in
 *   cpus       - os.cpus stand-in
 *   memory     - () => { totalBytes, freeBytes }
 *   uptime     - os.uptime stand-in
 */
function create(deps) {
  const d = deps || {};
  const spawnFn = d.spawn || spawn;
  const setTimer = d.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer || ((t) => clearTimeout(t));
  const now = d.now || (() => Date.now());
  const readCpus = d.cpus || (() => os.cpus());
  const readUptime = d.uptime || (() => os.uptime());
  const readMemory = d.memory || defaultMemory;

  /** webContents id -> { contents, count }. The whole on/off switch. */
  const subscribers = new Map();

  /** Last os.cpus() reading, so the next tick has something to subtract. */
  let prevCpus = null;

  /** The running tick timer, the grace timer, and the typeperf retry timer. */
  let tickTimer = null;
  let graceTimer = null;
  let retryTimer = null;

  /** The typeperf child and everything decoded from its stdout. */
  let child = null;
  let childStdout = '';
  let childCols = null;
  let counters = null;
  let countersAt = 0;
  let lastFailAt = 0;
  let lastError = null;
  /** True while WE are killing the child, so its exit is not read as failure. */
  let stopping = false;

  function totalCount() {
    let total = 0;
    for (const entry of subscribers.values()) total += entry.count;
    return total;
  }

  // -- typeperf -------------------------------------------------------------

  function noteFailure(message) {
    lastError = message || 'typeperf failed';
    counters = null;
    countersAt = 0;
    childCols = null;
    lastFailAt = now();
    killChild();
    scheduleRetry();
  }

  /**
   * Retry once a minute, never sooner -- a counter that is missing stays
   * missing, and a spawn every two seconds against a machine that cannot
   * answer is exactly the cost this module exists to avoid. Only worth doing
   * at all while somebody is still watching.
   */
  function scheduleRetry() {
    if (retryTimer || totalCount() === 0) return;
    const waited = lastFailAt > 0 ? now() - lastFailAt : RETRY_MS;
    const wait = Math.max(0, RETRY_MS - waited);
    retryTimer = setTimer(() => {
      retryTimer = null;
      lastFailAt = 0; // the cooldown is served; let startChild through
      if (totalCount() > 0) startChild();
    }, wait);
  }

  function handleChildLine(line) {
    if (stopping) return;
    if (!line.trim()) return; // typeperf opens with a blank line
    if (!childCols) {
      const cols = parseTypeperfHeader(line);
      if (cols) { childCols = cols; return; }
      // Anything before the header that is not the header is an error it
      // printed instead of collecting -- a missing counter, a locale we
      // cannot map, a permission refusal.
      noteFailure('typeperf: ' + line.trim().slice(0, 200));
      return;
    }
    const row = parseTypeperfLine(line, childCols);
    if (row) {
      counters = row;
      countersAt = now();
      lastError = null;
      return;
    }
    // A non-row after the header: typeperf is on its way out or complaining.
    noteFailure('typeperf: ' + line.trim().slice(0, 200));
  }

  function startChild() {
    if (child || stopping) return;
    if (lastFailAt > 0 && now() - lastFailAt < RETRY_MS) { scheduleRetry(); return; }
    childStdout = '';
    childCols = null;
    let proc;
    try {
      proc = spawnFn('typeperf', TYPEPERF_ARGS, { windowsHide: true });
    } catch (err) {
      noteFailure('typeperf could not start: ' + (err && err.message ? err.message : String(err)));
      return;
    }
    if (!proc) { noteFailure('typeperf could not start'); return; }
    child = proc;

    if (proc.stdout && proc.stdout.setEncoding) proc.stdout.setEncoding('utf8');
    if (proc.stdout && proc.stdout.on) {
      proc.stdout.on('data', (chunk) => {
        if (proc !== child) return;
        childStdout += String(chunk);
        // Guard against a child that never emits a newline: nothing usable is
        // ever going to arrive, and the buffer must not grow forever.
        if (childStdout.length > 1000000) { noteFailure('typeperf produced no usable rows'); return; }
        let nl = childStdout.indexOf('\n');
        while (nl !== -1) {
          const line = childStdout.slice(0, nl).replace(/\r$/, '');
          childStdout = childStdout.slice(nl + 1);
          handleChildLine(line);
          if (proc !== child) return; // handleChildLine killed us
          nl = childStdout.indexOf('\n');
        }
      });
    }
    if (proc.stderr && proc.stderr.on) {
      proc.stderr.on('data', (chunk) => {
        if (proc !== child) return;
        const text = String(chunk).trim();
        if (text) noteFailure('typeperf: ' + text.slice(0, 200));
      });
    }
    proc.on('error', (err) => {
      if (proc !== child) return;
      noteFailure('typeperf: ' + (err && err.message ? err.message : String(err)));
    });
    proc.on('exit', (code) => {
      if (proc !== child) return;
      child = null;
      if (stopping) return;
      noteFailure('typeperf exited (' + code + ')');
    });
  }

  function killChild() {
    if (!child) return;
    const proc = child;
    child = null;
    childStdout = '';
    childCols = null;
    counters = null;
    countersAt = 0;
    stopping = true;
    try { proc.kill(); } catch { /* already gone */ }
    stopping = false;
  }

  // -- sampling -------------------------------------------------------------

  function currentCounters() {
    if (!counters) return null;
    if (countersAt && now() - countersAt > COUNTER_STALE_MS) return null;
    return counters;
  }

  function tick() {
    tickTimer = null;

    // The CPU reading is taken even during the grace period, with nobody
    // subscribed: it is two array reads, and keeping the baseline warm is what
    // lets a re-subscribe inside the grace answer with a real percentage
    // instead of a zero. Only the sample itself is skipped.
    const next = readCpus();
    const cpu = prevCpus ? cpuPercentFromTimes(prevCpus, next) : null;
    prevCpus = next;

    if (subscribers.size) {
      const sample = buildSample({
        t: now(),
        cpu,
        mem: readMemory(),
        counters: currentCounters(),
        uptimeSec: readUptime(),
      });

      for (const entry of Array.from(subscribers.values())) {
        const contents = entry.contents;
        if (!contents) continue;
        try {
          if (contents.isDestroyed && contents.isDestroyed()) continue;
          contents.send('stats:sample', sample);
        } catch { /* the window went away mid-send */ }
      }
    }

    tickTimer = setTimer(tick, SAMPLE_MS);
  }

  function startSampling() {
    if (tickTimer) return;
    prevCpus = readCpus();
    tickTimer = setTimer(tick, FIRST_SAMPLE_MS);
    startChild();
  }

  function stopSampling() {
    if (tickTimer) { clearTimer(tickTimer); tickTimer = null; }
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    prevCpus = null;
    killChild();
  }

  function cancelGrace() {
    if (graceTimer) { clearTimer(graceTimer); graceTimer = null; }
  }

  /**
   * Zero subscribers does not stop anything for GRACE_MS: a tab switch away
   * and back, or a click into another window, would otherwise pay for a fresh
   * typeperf and leave the strip on dashes for two seconds.
   */
  function scheduleStop() {
    cancelGrace();
    graceTimer = setTimer(() => {
      graceTimer = null;
      if (totalCount() === 0) stopSampling();
    }, GRACE_MS);
  }

  // -- public ---------------------------------------------------------------

  function subscribe(contents) {
    if (!contents || typeof contents.id !== 'number') return;
    const entry = subscribers.get(contents.id);
    if (entry) entry.count += 1;
    else subscribers.set(contents.id, { contents, count: 1 });
    cancelGrace();
    startSampling();
  }

  function unsubscribe(contents) {
    if (!contents || typeof contents.id !== 'number') return;
    drop(contents.id, 1);
  }

  /**
   * `count` omitted drops the webContents entirely -- that is the destroyed
   * case, where the renderer never got to balance its subscribes.
   */
  function drop(id, count) {
    const entry = subscribers.get(id);
    if (!entry) return;
    if (count === undefined) subscribers.delete(id);
    else {
      entry.count -= count;
      if (entry.count <= 0) subscribers.delete(id);
    }
    if (totalCount() === 0) scheduleStop();
  }

  /** Everything off, now: app quit, or a test tearing down. */
  function stop() {
    subscribers.clear();
    cancelGrace();
    stopSampling();
  }

  return {
    subscribe,
    unsubscribe,
    drop,
    stop,
    // Inspection, for the harness and for a future diagnostics pane.
    counts: () => {
      const out = {};
      for (const [id, entry] of subscribers) out[id] = entry.count;
      return out;
    },
    isRunning: () => tickTimer !== null,
    hasChild: () => child !== null,
    lastError: () => lastError,
  };
}

/** Electron's figures where they exist (kB), Node's otherwise. */
function defaultMemory() {
  let totalBytes = os.totalmem();
  let freeBytes = os.freemem();
  try {
    if (typeof process.getSystemMemoryInfo === 'function') {
      const info = process.getSystemMemoryInfo();
      if (info && Number.isFinite(info.total) && info.total > 0) {
        totalBytes = info.total * 1024;
        if (Number.isFinite(info.free)) freeBytes = info.free * 1024;
      }
    }
  } catch { /* not Electron, or the call is gone: os.* already answered */ }
  return { totalBytes, freeBytes };
}

module.exports = {
  create,
  parseTypeperfHeader,
  parseTypeperfLine,
  cpuPercentFromTimes,
  buildSample,
  parseCounterPath,
  splitCsv,
  defaultMemory,
  TYPEPERF_COUNTERS,
  TYPEPERF_ARGS,
  SAMPLE_MS,
  FIRST_SAMPLE_MS,
  GRACE_MS,
  RETRY_MS,
  COUNTER_STALE_MS,
};
