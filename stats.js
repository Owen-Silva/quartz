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
//      and a child that never manages a single row is retried slowly.
//
//      But a dash must be RARE. On the user's machine disk, network and GPU read
//      "-" while their graphs still had data, because the old code treated
//      every unexpected stdout line as a fatal failure: typeperf prints a
//      warning when one of the `(*)` instances it latched onto at startup
//      goes away (a network adapter, a GPU engine, a process that exited),
//      and one of those warnings blanked the strip for a whole minute. Now:
//      a blank field is a vanished instance and counts as 0 inside a sum, a
//      line that is not a data row is SKIPPED, and a field goes null only
//      after 5 s with no valid row at all.
//
//   4. `(*)` IS RESOLVED ONCE, AT SPAWN. Every instance that starts later --
//      a new GPU engine, and above all every process started after the child
//      -- is invisible to it forever. So the child is replaced every 30 s,
//      with OVERLAP: the replacement is spawned alongside, we switch to it on
//      its first data row, and only then is the old one killed. The sample
//      never has a gap.
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
const SAMPLE_MS = 1000;   // Task Manager's own cadence; the user wanted it faster than 2 s

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

/**
 * A child that died comes back in two seconds. It used to be a minute, which
 * meant one hiccup cost the strip a minute of dashes -- and the strip is a
 * live readout, so a minute of dashes reads as "broken".
 */
const RESPAWN_MS = 2000;

/**
 * ...unless nothing ever works. A child that dies without ever producing a
 * data row is barren; after BARREN_LIMIT of those in a row (typeperf missing,
 * a localised counter set, a disabled perf library) the retry slows to a
 * minute, because that machine is not going to start answering.
 */
const RETRY_MS = 60000;
const BARREN_LIMIT = 5;

/**
 * Counter values older than this are not trusted: typeperf is alive but
 * wedged, or the machine slept. Better a dash than a number from four minutes
 * ago. This is the ONLY thing that makes a field null.
 */
const COUNTER_STALE_MS = 5000;

/**
 * How often the child is replaced so the `(*)` instance lists are re-resolved.
 * 30 s is a compromise: a process started now shows up in the table within
 * half a minute, and the spawn cost is paid twice a minute instead of once a
 * second.
 */
const REFRESH_MS = 30000;

/**
 * An overlapping replacement that never produces a row is given up on, so a
 * wedged spawn cannot sit around forever holding a second typeperf.
 */
const OVERLAP_TIMEOUT_MS = 10000;

/**
 * The active child gets the same patience: no data row for this long and it
 * is replaced rather than trusted.
 */
const WEDGED_MS = 10000;

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

/**
 * The process table's counters. They ride the SAME child as the machine-wide
 * ones: a second typeperf would double the process count, the startup cost
 * and the parse, for rows that arrive on the same clock anyway (measured:
 * one child with both sets costs less than two children with one each).
 *
 * `% Processor Time` here is per process over ALL cores, so it runs to
 * cores*100; dividing by the core count gives Task Manager's figure.
 * `Working Set - Private` is Task Manager's "Memory" column (the shared
 * pages of a 20-process browser must not be counted twenty times).
 * `ID Process` is the only way to map an instance name to a real pid, and
 * `Creating Process ID` is what lets us tell OUR helper processes apart from
 * every other Electron app on the machine.
 */
const PROCESS_COUNTERS = [
  '\\Process(*)\\% Processor Time',
  '\\Process(*)\\Working Set - Private',
  '\\Process(*)\\ID Process',
  '\\Process(*)\\IO Data Bytes/sec',
  '\\Process(*)\\Creating Process ID',
];

/** Groups pushed to the page. It shows 10 and reveals up to 30. */
const MAX_PROC_GROUPS = 30;

function typeperfArgs(withProcesses) {
  const counters = withProcesses === false
    ? TYPEPERF_COUNTERS.slice()
    : TYPEPERF_COUNTERS.concat(PROCESS_COUNTERS);
  return counters.concat(['-si', String(SAMPLE_MS / 1000)]);
}

const TYPEPERF_ARGS = typeperfArgs(true);

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
    /** instance name -> { cpu, mem, pid, io, ppid } column indices. */
    procs: new Map(),
    /** True once a `Creating Process ID` column exists for the instances. */
    hasPpid: false,
  };

  const procSlot = (instance) => {
    let slot = cols.procs.get(instance);
    if (!slot) {
      slot = { cpu: -1, mem: -1, pid: -1, io: -1, ppid: -1 };
      cols.procs.set(instance, slot);
    }
    return slot;
  };

  for (let i = 1; i < fields.length; i++) {
    const p = parseCounterPath(fields[i]);
    if (!p) continue;
    const object = p.object.toLowerCase();
    const counter = p.counter.toLowerCase();
    if (object === 'process') {
      // `_Total` is a sum we would only have to subtract again, and `Idle` is
      // pid 0 -- the machine doing nothing, which is not a task anyone ends.
      const bare = baseName(p.instance).toLowerCase();
      if (!p.instance || bare === '_total' || bare === 'idle') continue;
      if (counter === '% processor time') procSlot(p.instance).cpu = i;
      else if (counter === 'working set - private') procSlot(p.instance).mem = i;
      else if (counter === 'id process') procSlot(p.instance).pid = i;
      else if (counter === 'io data bytes/sec') procSlot(p.instance).io = i;
      else if (counter === 'creating process id') { procSlot(p.instance).ppid = i; cols.hasPpid = true; }
      continue;
    }
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
    || cols.netDown.length || cols.netUp.length || cols.gpu3d.length || cols.procs.size;
  return matched ? cols : null;
}

/**
 * One data row -> the raw counter values, or null when the line is not a data
 * row (typeperf's leading blank line, its "Exiting, please wait..." on the way
 * out, an error it printed instead). The column count has to match the header
 * exactly: that is a locale-independent test, where a date-format regex would
 * fail on a machine that writes 11.09.2026.
 *
 * A field that is not a number (PDH writes " " for an instance that went away
 * between the header and this row) is ZERO inside a sum -- a network adapter
 * that unplugged is carrying no traffic, a GPU engine that vanished is doing
 * no work, and blanking the whole figure because one of twelve instances left
 * is exactly the bug that put dashes on the user's strip. A `_Total` field is
 * taken as it comes: blank means this one row has no answer for it, and the
 * 5 s rule upstream decides whether that is worth a dash.
 */
function parseTypeperfLine(line, cols, opts) {
  if (!cols) return null;
  let fields;
  if (Array.isArray(line)) fields = line;
  else if (typeof line === 'string') {
    const trimmed = line.trim();
    if (!trimmed) return null;
    fields = splitCsv(trimmed);
  } else return null;
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
  // A blank instance is an instance that went away: it contributes 0, and the
  // sum stays a number. Only "we never asked for this counter" is null.
  const sumOf = (idxs) => {
    if (!idxs || !idxs.length) return null;
    let total = 0;
    for (const i of idxs) {
      const v = at(i);
      if (v !== null) total += v;
    }
    return total;
  };

  const out = {
    stamp: fields[0].trim(),
    diskPercent: at(cols.diskPercent),
    diskReadBps: at(cols.diskRead),
    diskWriteBps: at(cols.diskWrite),
    netDownBps: sumOf(cols.netDown),
    netUpBps: sumOf(cols.netUp),
    gpuPercent: sumOf(cols.gpu3d),
    procs: null,
  };
  if (cols.procs && cols.procs.size) out.procs = parseProcessRows(fields, cols, opts);
  // A row has to carry at least one real number somewhere, or it is the
  // header reprinted, or a goodbye line that happens to have the right shape.
  if (!sawNumber && !(out.procs && out.procs.length)) return null;
  return out;
}

/** `chrome#12` -> `chrome`. PDH numbers duplicate instance names from #1 up. */
function baseName(instance) {
  const s = String(instance == null ? '' : instance).trim();
  const hash = s.lastIndexOf('#');
  if (hash <= 0) return s;
  return /^\d+$/.test(s.slice(hash + 1)) ? s.slice(0, hash) : s;
}

/**
 * One data row -> one entry per live process:
 * `{ instance, base, pid, ppid, cpu, memBytes, ioBps }`.
 *
 * `cpu` is already divided by the core count, so it is the share of the WHOLE
 * machine, which is the number Task Manager prints (the raw counter is per
 * process over all cores and a busy 4-thread job reads 400 there).
 *
 * An instance with no `ID Process` this round is one that exited since the
 * header: it is dropped rather than guessed at, because a row without a pid
 * cannot be grouped, attributed, or ended.
 */
function parseProcessRows(line, cols, opts) {
  if (!cols || !cols.procs || !cols.procs.size) return [];
  let fields;
  if (Array.isArray(line)) fields = line;
  else if (typeof line === 'string') fields = splitCsv(line.trim());
  else return [];
  if (fields.length !== cols.count) return [];

  const o = opts || {};
  const cores = Number.isFinite(o.cores) && o.cores > 0 ? o.cores : 1;

  const num = (i) => {
    if (i < 0 || i >= fields.length) return null;
    const raw = fields[i].trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const out = [];
  for (const [instance, slot] of cols.procs) {
    const pid = num(slot.pid);
    if (pid === null) continue;
    const id = Math.round(pid);
    if (id <= 0) continue;              // 0 is Idle; negatives are nonsense
    const base = baseName(instance);
    if (!base) continue;
    const cpuRaw = num(slot.cpu);
    const mem = num(slot.mem);
    const io = num(slot.io);
    const ppidRaw = num(slot.ppid);
    out.push({
      instance,
      base,
      pid: id,
      ppid: ppidRaw === null ? 0 : Math.max(0, Math.round(ppidRaw)),
      cpu: cpuRaw === null ? 0 : Math.max(0, cpuRaw) / cores,
      memBytes: mem === null ? 0 : Math.max(0, mem),
      ioBps: io === null ? 0 : Math.max(0, io),
    });
  }
  return out;
}

/**
 * Task Manager does not show `MsMpEng` or `dwm`, it shows "Antimalware
 * Service Executable" and "Desktop Window Manager", and that is most of what
 * makes its list readable. This is the same courtesy for the names a person
 * is actually likely to see on this machine; anything else keeps its process
 * name, which is still better than a blank.
 */
const FRIENDLY_NAMES = {
  claude: 'Claude Code',
  electron: 'Electron',
  spotify: 'Spotify',
  explorer: 'Windows Explorer',
  dwm: 'Desktop Window Manager',
  msmpeng: 'Antimalware Service Executable',
  taskmgr: 'Task Manager',
  lessonplayer: 'LessonPlayer',
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  msedgewebview2: 'Microsoft Edge WebView2',
  opera: 'Opera',
  opera_gx: 'Opera GX',
  firefox: 'Firefox',
  code: 'Visual Studio Code',
  node: 'Node.js',
  powershell: 'Windows PowerShell',
  pwsh: 'PowerShell',
  typeperf: 'typeperf',
  svchost: 'Service Host',
  searchindexer: 'Microsoft Windows Search Indexer',
  searchhost: 'Search',
  startmenuexperiencehost: 'Start',
  shellexperiencehost: 'Windows Shell Experience Host',
  textinputhost: 'Text Input Host',
  runtimebroker: 'Runtime Broker',
  applicationframehost: 'Application Frame Host',
  audiodg: 'Windows Audio Device Graph Isolation',
  wininit: 'Windows Start-Up Application',
  winlogon: 'Windows Logon Application',
  csrss: 'Client Server Runtime Process',
  services: 'Services and Controller app',
  lsass: 'Local Security Authority Process',
  smss: 'Session Manager',
  fontdrvhost: 'Usermode Font Driver Host',
  system: 'System',
  registry: 'Registry',
  'memory compression': 'Memory Compression',
  'secure system': 'Secure System',
  securityhealthservice: 'Windows Security Health Service',
  ctfmon: 'CTF Loader',
  sihost: 'Shell Infrastructure Host',
  git: 'Git',
  bash: 'Bash',
  cmd: 'Command Prompt',
  conhost: 'Console Window Host',
  wmiprvse: 'WMI Provider Host',
  dllhost: 'COM Surrogate',
  steam: 'Steam',
  discord: 'Discord',
  obs64: 'OBS Studio',
  nvcontainer: 'NVIDIA Container',
};

function friendlyName(base) {
  const s = String(base == null ? '' : base).trim();
  if (!s) return 'Unknown';
  const hit = FRIENDLY_NAMES[s.toLowerCase()];
  return hit || s;
}

/**
 * Processes that end the session, the desktop or the machine when they die.
 * Task Manager refuses these too (its End task is greyed out or the kill is
 * denied outright); refusing them HERE means the page never has to know which
 * is which, and a misclick on a hairline row cannot black-screen the user.
 */
const PROTECTED_PIDS = new Set([0, 4]);
const PROTECTED_NAMES = new Set([
  'system', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services',
  'lsass', 'svchost', 'dwm', 'fontdrvhost', 'memory compression',
  'secure system', 'msmpeng', 'securityhealthservice', 'audiodg', 'sihost',
  'ctfmon',
]);

function isProtected(name, pid) {
  if (Number.isFinite(Number(pid)) && PROTECTED_PIDS.has(Number(pid))) return true;
  const base = baseName(String(name == null ? '' : name)).trim().toLowerCase().replace(/\.exe$/, '');
  return !!base && PROTECTED_NAMES.has(base);
}

/**
 * Our own pids: `root` plus every descendant reachable through the
 * `Creating Process ID` counter. Without that counter the answer is the root
 * alone, which still keeps End task away from the main process.
 *
 * The walk is over the instances in THIS row only, so a pid that was reused
 * after its parent exited cannot drag an unrelated tree in.
 */
function selfPids(rows, root) {
  const out = new Set();
  const rootPid = Number(root);
  if (Number.isFinite(rootPid) && rootPid > 0) out.add(rootPid);
  if (!Array.isArray(rows) || !rows.length || !out.size) return out;

  const children = new Map();
  for (const r of rows) {
    if (!r || !Number.isFinite(r.ppid) || r.ppid <= 0) continue;
    let list = children.get(r.ppid);
    if (!list) { list = []; children.set(r.ppid, list); }
    list.push(r.pid);
  }
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.pop();
    const kids = children.get(pid);
    if (!kids) continue;
    for (const kid of kids) {
      if (out.has(kid)) continue;
      out.add(kid);
      queue.push(kid);
    }
  }
  return out;
}

/**
 * Per-process rows -> Task Manager's grouped list. One row per base name,
 * summing cpu, private memory and I/O, so a 19-process Chrome is one line
 * that reads "Google Chrome (19)" instead of nineteen lines of 0.1%.
 *
 * Sorted busiest first, memory breaking the tie -- the same order Task
 * Manager lands on when you click CPU, and the reason anyone opens this at
 * all is to find what is eating the machine right now.
 */
function groupProcesses(rows, opts) {
  const o = opts || {};
  const mine = o.selfPids instanceof Set
    ? o.selfPids
    : new Set(Array.isArray(o.selfPids) ? o.selfPids : []);

  const map = new Map();
  for (const r of rows || []) {
    if (!r || !Number.isFinite(r.pid)) continue;
    const key = String(r.base).toLowerCase();
    let g = map.get(key);
    if (!g) {
      g = { key, name: friendlyName(r.base), count: 0, pids: [], cpu: 0, memBytes: 0, ioBps: 0, self: false };
      map.set(key, g);
    }
    g.count += 1;
    g.pids.push(r.pid);
    g.cpu += Number.isFinite(r.cpu) ? r.cpu : 0;
    g.memBytes += Number.isFinite(r.memBytes) ? r.memBytes : 0;
    g.ioBps += Number.isFinite(r.ioBps) ? r.ioBps : 0;
    if (mine.has(r.pid)) g.self = true;
  }

  const groups = Array.from(map.values());
  for (const g of groups) {
    g.cpu = round1(clampPercent(g.cpu)) || 0;
    g.memBytes = Math.round(g.memBytes);
    g.ioBps = Math.round(g.ioBps);
    g.pids.sort((a, b) => a - b);
  }
  groups.sort((a, b) => (b.cpu - a.cpu) || (b.memBytes - a.memBytes) || a.name.localeCompare(b.name));
  return groups;
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
    // null, not an empty list: the page draws its dashed placeholder rows for
    // null and "no processes at all" would be a lie.
    procs: p.procs && Array.isArray(p.procs.top)
      ? { top: p.procs.top.slice(0, MAX_PROC_GROUPS), total: p.procs.total }
      : null,
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
  /** TerminateProcess, injectable so the harness can refuse without killing. */
  const killPid = d.kill || ((pid) => process.kill(pid));
  /** This process. Everything under it is `self` and cannot be ended. */
  const rootPid = Number.isFinite(d.rootPid) ? d.rootPid : process.pid;
  /** Core count, for turning the per-process counter into Task Manager's %. */
  const coreCount = d.coreCount || (() => {
    const list = readCpus();
    return Array.isArray(list) && list.length ? list.length : 1;
  });
  /**
   * The process table can be switched off: `procs: false`, or
   * BROWSER_STATS_NO_PROCS=1 in the environment. That second one exists so the
   * cost of the process counters can be measured on a real build without
   * editing this file, and so a machine where \Process(*) is expensive has an
   * escape hatch.
   */
  const wantProcs = d.procs === false || process.env.BROWSER_STATS_NO_PROCS === '1' ? false : true;

  /** webContents id -> { contents, count }. The whole on/off switch. */
  const subscribers = new Map();

  /** Last os.cpus() reading, so the next tick has something to subtract. */
  let prevCpus = null;

  /** The running tick timer, the grace timer, and the typeperf retry timer. */
  let tickTimer = null;
  let graceTimer = null;
  let retryTimer = null;
  /** The 30 s instance-list refresh. */
  let refreshTimer = null;

  /**
   * The active typeperf child and, during a refresh, its replacement. Both
   * are the same shape; `promote()` swaps them.
   */
  let active = null;
  let pending = null;

  /**
   * The last good value of each counter, and WHEN it was good. Per field, so
   * one blank `_Total` in one row cannot dash a strip whose other four
   * figures are fine. A field is reported null only once its timestamp is
   * more than COUNTER_STALE_MS old -- the 5 s rule, and the only null there
   * is.
   */
  const COUNTER_FIELDS = ['diskPercent', 'diskReadBps', 'diskWriteBps', 'netDownBps', 'netUpBps', 'gpuPercent'];
  const counterValues = {};
  const counterAt = {};

  /** The last process row set, and when it arrived (same 5 s rule). */
  let procRows = [];
  let procRowsAt = 0;
  let procSelf = new Set([rootPid]);

  let lastFailAt = 0;
  let lastError = null;
  /** Consecutive children that died without ever printing a data row. */
  let barren = 0;
  /** True while WE are killing a child, so its exit is not read as failure. */
  let stopping = false;

  function totalCount() {
    let total = 0;
    for (const entry of subscribers.values()) total += entry.count;
    return total;
  }

  // -- typeperf -------------------------------------------------------------

  /**
   * A child died (or never started). Nothing is blanked here: the counters
   * keep their timestamps, so a child that comes back inside 5 s never shows
   * the user a dash at all. Only time nulls a field.
   */
  function noteFailure(message, everGotRow) {
    lastError = message || 'typeperf failed';
    lastFailAt = now();
    barren = everGotRow ? 0 : barren + 1;
    scheduleRetry();
  }

  /**
   * Two seconds, not a minute: a child that dies on a warning has to be back
   * before the 5 s staleness rule turns anything into a dash. A machine where
   * typeperf never works at all (a localised counter set, a disabled perf
   * library) is a different case -- after BARREN_LIMIT fruitless spawns the
   * wait goes to a minute, because that one is not going to fix itself.
   */
  function scheduleRetry() {
    if (retryTimer || totalCount() === 0 || active || pending) return;
    const wait = barren >= BARREN_LIMIT ? RETRY_MS : RESPAWN_MS;
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (totalCount() > 0 && !active && !pending) startChild(false);
    }, wait);
  }

  /** Adopt one parsed row: per-field for the counters, wholesale for procs. */
  function takeRow(row) {
    const t = now();
    for (const field of COUNTER_FIELDS) {
      const v = row[field];
      if (v === null || v === undefined) continue;
      counterValues[field] = v;
      counterAt[field] = t;
    }
    if (row.procs) {
      procRows = row.procs;
      procRowsAt = t;
      procSelf = selfPids(procRows, rootPid);
    }
    lastError = null;
  }

  /**
   * One line of one child's stdout. NOTHING here is fatal. typeperf prints a
   * warning when an instance it latched onto at spawn goes away, it reprints
   * its header in some locales, and it says "Exiting, please wait..." on the
   * way out; every one of those used to blank the strip for a minute. They
   * are skipped now, and only the clock decides what is missing.
   */
  function handleChildLine(entry, line) {
    if (!line.trim()) return;            // typeperf opens with a blank line
    if (!entry.cols) {
      const cols = parseTypeperfHeader(line);
      if (cols) { entry.cols = cols; return; }
      entry.noise = (entry.noise || 0) + 1;
      if (entry.noise <= 3) lastError = 'typeperf: ' + line.trim().slice(0, 200);
      return;
    }
    const row = parseTypeperfLine(line, entry.cols, { cores: coreCount() });
    if (!row) return;                    // a warning, a repeated header: skip
    entry.gotRow = true;
    if (entry === pending) { promote(); }
    if (entry === active) takeRow(row);
  }

  /**
   * The replacement has data: switch to it and only THEN kill the old one, so
   * there is never an instant with no child answering. This is the whole
   * point of the overlap -- `(*)` is resolved at spawn, so a process started
   * a minute ago is invisible until a fresh child sees it.
   */
  function promote() {
    if (!pending) return;
    const next = pending;
    pending = null;
    const old = active;
    active = next;
    barren = 0;
    if (old) killEntry(old);
  }

  function startChild(asReplacement) {
    if (stopping) return;
    if (asReplacement ? pending : (active || pending)) return;
    let proc;
    try {
      proc = spawnFn('typeperf', typeperfArgs(wantProcs), { windowsHide: true });
    } catch (err) {
      noteFailure('typeperf could not start: ' + (err && err.message ? err.message : String(err)), false);
      return;
    }
    if (!proc) { noteFailure('typeperf could not start', false); return; }

    const entry = { proc, cols: null, buf: '', gotRow: false, at: now(), killed: false };
    if (asReplacement) pending = entry; else active = entry;

    // NOT `stdout.on('data')`. typeperf writes its CSV in tiny unbuffered
    // pieces -- measured at ~1,400 writes a second with the process counters
    // on -- and in flowing mode Node wakes up for every one of them: 2.5-4%
    // of a core in the main process before a single line is parsed. Left
    // PAUSED, the OS pipe coalesces those writes, and draining it once per
    // tick (see pump()) reads the same bytes in ~1 chunk a second for about
    // 0.05%. It also means the row we parse is the freshest one there is,
    // read microseconds before the sample is built.
    if (proc.stdout && proc.stdout.setEncoding) proc.stdout.setEncoding('utf8');
    if (proc.stdout && proc.stdout.pause) proc.stdout.pause();
    // Pausing is only half of it. Node keeps libuv reading the pipe until the
    // buffered bytes pass the stream's high-water mark, so a SMALL counter set
    // (few bytes a second, never reaching 16 kB) keeps waking us for every one
    // of typeperf's tiny writes anyway: measured 1.0% of a core for the
    // machine-only set against 0.05% for the bigger one, which is a lovely
    // inversion. A high-water mark of one byte stops the read after the first
    // chunk of each tick, whatever the counter set. It is a private field, so
    // it is best-effort: without it everything still works, just warmer.
    try {
      if (proc.stdout && proc.stdout._readableState) proc.stdout._readableState.highWaterMark = 1;
    } catch { /* a Node that keeps its stream state elsewhere */ }
    if (proc.stderr && proc.stderr.on) {
      // stderr is a complaint, not a death: typeperf writes its "the instance
      // no longer exists" chatter here and keeps collecting.
      proc.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) lastError = 'typeperf: ' + text.slice(0, 200);
      });
    }
    proc.on('error', (err) => {
      if (entry.killed) return;
      dropEntry(entry, 'typeperf: ' + (err && err.message ? err.message : String(err)));
    });
    proc.on('exit', (code) => {
      if (entry.killed) return;
      dropEntry(entry, 'typeperf exited (' + code + ')');
    });
  }

  /**
   * Read everything the child has written since the last tick and feed it
   * through the line handler. Called once a second from tick(), for the
   * active child and for a pending replacement.
   */
  function pump(entry) {
    if (!entry || entry.killed) return;
    const out = entry.proc.stdout;
    if (!out || typeof out.read !== 'function') return;
    for (;;) {
      let chunk;
      try { chunk = out.read(); } catch { return; }
      if (chunk === null || chunk === undefined) break;
      entry.buf += String(chunk);
      if (entry.buf.length > 4000000) { entry.buf = ''; dropEntry(entry, 'typeperf produced no usable rows'); return; }
    }
    // read() leaves libuv reading the pipe, which is exactly the per-write
    // wakeup we are trying to avoid. pause() stops it again until the next
    // tick, so the writes pile up in the OS buffer and arrive as one chunk.
    if (typeof out.pause === 'function') out.pause();
    let nl = entry.buf.indexOf('\n');
    while (nl !== -1) {
      const line = entry.buf.slice(0, nl).replace(/\r$/, '');
      entry.buf = entry.buf.slice(nl + 1);
      handleChildLine(entry, line);
      if (entry.killed) return;          // promote() killed the old one
      nl = entry.buf.indexOf('\n');
    }
  }

  /** A child we did not kill went away (or misbehaved). Forget it, respawn. */
  function dropEntry(entry, message) {
    const wasActive = entry === active;
    const wasPending = entry === pending;
    entry.killed = true;
    if (wasActive) active = null;
    if (wasPending) pending = null;
    if (wasPending && active) return;    // the old child is still answering
    if (!wasActive && !wasPending) return;
    if (stopping) return;
    noteFailure(message, entry.gotRow);
    // A pending child that died leaves the active one in charge; an active
    // one that died leaves nothing, so promote whatever is in flight.
    if (!active && pending && pending.gotRow) promote();
  }

  function killEntry(entry) {
    if (!entry) return;
    entry.killed = true;
    entry.buf = '';
    if (entry === active) active = null;
    if (entry === pending) pending = null;
    try { entry.proc.kill(); } catch { /* already gone */ }
  }

  function killChild() {
    stopping = true;
    killEntry(pending);
    killEntry(active);
    stopping = false;
  }

  /**
   * Replace the child so `(*)` is resolved again. The replacement runs
   * ALONGSIDE the current one until its first data row (see promote()), so
   * processes that started in the last 30 s appear without the table ever
   * going empty.
   */
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimer(() => {
      refreshTimer = null;
      if (totalCount() === 0) return;
      if (active && !pending) startChild(true);
      scheduleRefresh();
    }, REFRESH_MS);
  }

  // -- sampling -------------------------------------------------------------

  /**
   * The counters as of right now: each field's last good value if it is less
   * than 5 s old, null otherwise. Null is a clock decision, never a parse
   * decision -- that is the whole fix for the dashes.
   */
  function currentCounters() {
    const t = now();
    const out = {};
    let any = false;
    for (const field of COUNTER_FIELDS) {
      const at = counterAt[field];
      if (at && t - at <= COUNTER_STALE_MS) { out[field] = counterValues[field]; any = true; }
      else out[field] = null;
    }
    return any ? out : null;
  }

  /** The grouped process table, or null while there is nothing fresh. */
  function currentProcs() {
    if (!procRowsAt || now() - procRowsAt > COUNTER_STALE_MS) return null;
    const groups = groupProcesses(procRows, { selfPids: procSelf });
    return { top: groups.slice(0, MAX_PROC_GROUPS), total: groups.length };
  }

  /**
   * The active child is alive but has said nothing for WEDGED_MS: replace it.
   * (A wedged typeperf still holds its pipe open, so only the clock catches
   * this one.)
   */
  function checkWedged() {
    if (!active || pending) return;
    const since = Math.max(procRowsAt, counterAt.diskPercent || 0, counterAt.gpuPercent || 0, active.at);
    if (now() - since <= WEDGED_MS) return;
    lastError = 'typeperf: no rows for ' + Math.round((now() - since) / 1000) + ' s';
    killEntry(active);
    startChild(false);
  }

  /** A replacement that never produced a row is not going to. Drop it. */
  function checkOverlap() {
    if (!pending) return;
    if (now() - pending.at <= OVERLAP_TIMEOUT_MS) return;
    lastError = 'typeperf: the replacement never produced a row';
    killEntry(pending);
  }

  function tick() {
    tickTimer = null;
    // Read the children BEFORE building the sample: the row that lands in
    // this sample is the one typeperf wrote a moment ago.
    if (pending) pump(pending);
    if (active) pump(active);
    checkOverlap();
    checkWedged();

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
        procs: currentProcs(),
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
    barren = 0;
    startChild(false);
    scheduleRefresh();
  }

  function stopSampling() {
    if (tickTimer) { clearTimer(tickTimer); tickTimer = null; }
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    if (refreshTimer) { clearTimer(refreshTimer); refreshTimer = null; }
    prevCpus = null;
    killChild();
    for (const field of COUNTER_FIELDS) { delete counterValues[field]; delete counterAt[field]; }
    procRows = [];
    procRowsAt = 0;
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

  /**
   * End the processes behind one row of the page's table.
   *
   * `process.kill(pid)` on Windows is TerminateProcess -- the same thing Task
   * Manager's End task does. Never `taskkill /IM name`: the page groups by
   * name, and a name sweep would take out every process that happens to share
   * one, including ones the user never saw on the row.
   *
   * Three refusals, all of them here rather than in the page, so no future
   * caller can skip them:
   *   - `self`      our own root and every descendant. A browser that can kill
   *                 its own main process from a web page is a browser that
   *                 closes when a page says so.
   *   - `protected` pid 0 and 4, and the names that take the session, the
   *                 desktop or the machine with them.
   *   - `gone`      it exited between the sample and the click, which is not
   *                 a failure -- the user got what they wanted.
   */
  function endTask(pids) {
    const list = Array.isArray(pids) ? pids : [pids];
    const byPid = new Map();
    for (const r of procRows) byPid.set(r.pid, r);

    const out = [];
    const seen = new Set();
    for (const raw of list) {
      const pid = Number(raw);
      if (!Number.isInteger(pid) || pid < 0) { out.push({ pid: raw, ok: false, reason: 'invalid' }); continue; }
      if (seen.has(pid)) continue;
      seen.add(pid);

      if (pid === rootPid || procSelf.has(pid)) { out.push({ pid, ok: false, reason: 'self' }); continue; }
      const row = byPid.get(pid);
      if (isProtected(row ? row.base : '', pid)) { out.push({ pid, ok: false, reason: 'protected' }); continue; }

      try {
        killPid(pid);
        out.push({ pid, ok: true, reason: null });
      } catch (err) {
        const code = err && err.code ? String(err.code) : '';
        const reason = code === 'ESRCH' ? 'gone' : (code === 'EPERM' ? 'denied' : 'failed');
        out.push({ pid, ok: false, reason });
      }
    }
    return out;
  }

  return {
    subscribe,
    unsubscribe,
    drop,
    stop,
    endTask,
    // Inspection, for the harness and for a future diagnostics pane.
    counts: () => {
      const out = {};
      for (const [id, entry] of subscribers) out[id] = entry.count;
      return out;
    },
    isRunning: () => tickTimer !== null,
    hasChild: () => active !== null,
    hasPending: () => pending !== null,
    childCount: () => (active ? 1 : 0) + (pending ? 1 : 0),
    procCount: () => procRows.length,
    selfPids: () => new Set(procSelf),
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
  parseProcessRows,
  groupProcesses,
  friendlyName,
  isProtected,
  selfPids,
  baseName,
  cpuPercentFromTimes,
  buildSample,
  parseCounterPath,
  splitCsv,
  defaultMemory,
  typeperfArgs,
  TYPEPERF_COUNTERS,
  PROCESS_COUNTERS,
  TYPEPERF_ARGS,
  MAX_PROC_GROUPS,
  SAMPLE_MS,
  FIRST_SAMPLE_MS,
  GRACE_MS,
  RESPAWN_MS,
  RETRY_MS,
  BARREN_LIMIT,
  COUNTER_STALE_MS,
  REFRESH_MS,
  OVERLAP_TIMEOUT_MS,
  WEDGED_MS,
};
