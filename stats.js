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
//   5. A GROUP CAN NAME ITS OWN PROCESSES. "Electron (12) · 7.4% · 2.8 GB" is
//      useless when one of the twelve is holding 1.5 GB and nothing says which
//      tab it is. So every group with more than one process carries
//      `children`: one entry per pid, biggest first, each with its role read
//      off the command line (renderer / gpu / audio / network / utility /
//      main) and, for OUR renderers, the tab it hosts, matched through
//      webContents.getOSProcessId().
//
//      A child row's shape:
//        { pid, cpu, memBytes, ioBps, role, label, url, wcIds? }
//      `wcIds` is the webContents ids living in that pid, and it is there only
//      on our own renderers. It exists because a title is all this process can
//      see and every new tab page is titled "New tab": seven renderers read as
//      seven identical rows. The chrome document is the only place that knows
//      which TAB and which WORKSPACE an id is, so it joins on these ids and
//      rewrites `label` on the way to the page (app.js, nameStatsRenderers).
//      `label` stays the honest fallback for anything it cannot place.
//
//      Command lines are not in a performance counter, so they cost a
//      PowerShell. It runs ONLY when a pid we care about is new, answers for
//      the whole batch at once, and its answer is cached until the pid exits.
//      A pid nobody could read says 'unknown' and a query that failed outright
//      puts its reason on the group, in words -- neither is ever a blank.
//
//      What it costs the per-second push, measured on a 163-process machine:
//      4.7 kB of JSON becomes 12.0 kB. That is the price of the whole feature
//      and the reason `children` stops at MAX_PROC_CHILDREN and is not sent
//      at all for a group of one process.
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

/**
 * Children pushed with a group, memory-heaviest first. Chrome can run forty
 * processes and every one of them rides a per-second payload, so the list is
 * a reading aid rather than a census: it is capped, and whatever it left out
 * is STATED (`childrenMore`) rather than dropped in silence.
 */
const MAX_PROC_CHILDREN = 24;

/**
 * The programs whose children are worth naming. Chromium's process model is
 * the only one where a command line says something a person wants (renderer
 * vs gpu vs the audio service), and our own renderers are the only ones whose
 * tab we can name. Everything else gets children that carry a pid and its
 * three numbers, role '' -- there is nothing to read off notepad's command
 * line that the group row has not already said, and asking would cost a
 * PowerShell per pid for it.
 */
const CHROMIUM_BASES = new Set([
  'electron', 'chrome', 'msedge', 'msedgewebview2', 'chromium',
  'brave', 'vivaldi', 'opera', 'opera_gx', 'code', 'discord', 'slack',
]);

/** Pids per command-line query, and how far apart two queries may be. */
const CMDLINE_BATCH = 80;
const CMDLINE_MIN_MS = 1500;     // a burst of new pids is one query, not ten
const CMDLINE_FAIL_MS = 60000;   // a query that failed outright is not retried fast
const CMDLINE_TIMEOUT_MS = 8000; // a wedged PowerShell is dropped, not waited on
const CMDLINE_MAX_CHARS = 1024;  // enough for --type= and --utility-sub-type=
const CMDLINE_CACHE_MAX = 500;   // one entry per live pid, with room to spare

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
 * A Chromium process's command line -> what that process IS. `--type=` is the
 * whole story: absent means the browser process itself, and a utility says
 * which service it runs in `--utility-sub-type=`.
 *
 * Three of the answers are states rather than roles, and they exist so the
 * page can say WHICH ONE it is instead of drawing a blank:
 *   'pending'  the lookup has not come back yet (undefined here),
 *   'unknown'  it came back with nothing -- another user's process, a denied
 *              query, or a pid that exited between the sample and the query,
 *   ''         we never asked, because this is not a Chromium program.
 */
function roleFromCommandLine(cmd) {
  if (cmd === undefined) return 'pending';
  if (cmd === null || !String(cmd).trim()) return 'unknown';
  const s = String(cmd);
  const typed = /--type=([^\s"]+)/.exec(s);
  if (!typed) return 'main';
  const type = typed[1].toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (type === 'renderer') return 'renderer';
  if (type === 'gpu-process') return 'gpu';
  if (type === 'utility') {
    const sub = /--utility-sub-type=([^\s"]+)/.exec(s);
    const name = sub ? sub[1] : '';
    if (/audio\.mojom\.AudioService/i.test(name)) return 'audio';
    if (/network\.mojom\.NetworkService/i.test(name)) return 'network';
    return 'utility';
  }
  // zygote, crashpad-handler, ppapi...: stated as itself rather than folded
  // into 'utility', because a person reading the row wants the real word.
  return type || 'unknown';
}

/** Our own file:// pages, named the way their tab chip names them. */
const BUNDLED_PAGES = {
  'newtab.html': 'New tab',
  'index.html': 'Browser UI',
  'phone.html': 'Phone',
  'files.html': 'Files',
  'reader.html': 'Reader',
  'historypage.html': 'History',
};

/** A tab title is a whole sentence sometimes. One line, and bounded. */
const LABEL_MAX = 64;

function tidyLabel(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length <= LABEL_MAX ? s : s.slice(0, LABEL_MAX - 1).trimEnd() + '\u2026';
}

/** `file:///c:/.../newtab.html?theme=dark` -> `newtab.html`, else ''. */
function bundledFileName(url) {
  const s = String(url == null ? '' : url);
  if (!/^file:\/\//i.test(s)) return '';
  const path = s.replace(/[?#].*$/, '');
  let last = path.slice(path.lastIndexOf('/') + 1);
  try { last = decodeURIComponent(last); } catch { /* keep it as written */ }
  return last.toLowerCase();
}

/**
 * The host of a url and nothing else. What a renderer is SHOWING is the
 * user's business: the label says `youtube.com`, never the watch id. The
 * whole url rides in the row's `url`, where the title attribute reads it.
 */
function urlHost(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(url == null ? '' : url));
  if (!m) return '';
  return m[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '');
}

/** One webContents -> the words its row wears. */
function labelForContents(type, title, url) {
  const file = bundledFileName(url);
  if (file && BUNDLED_PAGES[file]) return BUNDLED_PAGES[file];
  if (String(type) === 'window') return 'Browser UI';
  const named = tidyLabel(title);
  if (named) return named;
  const host = urlHost(url);
  if (host) return host;
  if (file) return file;
  return 'untitled page';
}

/**
 * Every webContents -> `pid -> { label, url, wcIds }`. Chromium shares one
 * process between pages of the same site, so a pid can hold several: they are
 * joined, three named and the rest counted, in the order Electron lists them.
 *
 * `wcIds` is those pages' webContents ids, in the same order as the names. A
 * title is all main can see, and EVERY new-tab page is titled "New tab" -- so
 * a seven-renderer Electron group expanded into seven identical rows and none
 * of them said which tab it was. Which tab, and which workspace it lives in,
 * is knowledge only the chrome document has; the ids are the key it joins on,
 * and app.js rewrites `label` from them before the sample reaches the page.
 * `label` and `url` stay exactly what they always were: they are what the row
 * falls back to when nothing in this window claims the id.
 *
 * A webContents with no readable `id` contributes its name and no id, which
 * costs that one page its tab name and nothing else.
 *
 * Every call into a webContents is wrapped: this runs a second and one of
 * them being destroyed mid-loop must cost the sample nothing.
 */
function webContentsLabels(list) {
  const seen = new Map();
  if (!Array.isArray(list)) return new Map();

  for (const wc of list) {
    if (!wc) continue;
    try { if (wc.isDestroyed && wc.isDestroyed()) continue; } catch { continue; }

    let pid = null;
    try { pid = Number(wc.getOSProcessId()); } catch { pid = null; }
    if (!Number.isFinite(pid) || pid <= 0) continue;

    let type = '';
    let title = '';
    let url = '';
    try { type = String(wc.getType()); } catch { /* a type we do not need */ }
    try { title = String(wc.getTitle()); } catch { /* an empty title is fine */ }
    try { url = String(wc.getURL()); } catch { /* so is an empty url */ }

    // The id is a plain property, so it is read the same defensive way as the
    // methods above: a destroyed webContents can lose it between two lines.
    let id = null;
    try { id = Number(wc.id); } catch { id = null; }

    let entry = seen.get(pid);
    if (!entry) { entry = { labels: [], urls: [], ids: [] }; seen.set(pid, entry); }
    entry.labels.push(labelForContents(type, title, url));
    if (url) entry.urls.push(url);
    if (Number.isFinite(id) && id > 0) entry.ids.push(id);
  }

  const out = new Map();
  for (const [pid, entry] of seen) {
    const names = entry.labels;
    let label = names.slice(0, 3).join(', ');
    if (names.length > 3) label += ' +' + (names.length - 3);
    out.set(pid, {
      label,
      url: entry.urls.slice(0, 3).join('\n'),
      wcIds: entry.ids.slice(),
    });
  }
  return out;
}

/**
 * A Map, a plain object or nothing -> a lookup that answers `undefined` for
 * "not asked yet". The distinction matters: `null` is "asked, unreadable".
 */
function lookupIn(src) {
  if (src instanceof Map) return (pid) => (src.has(pid) ? src.get(pid) : undefined);
  if (src && typeof src === 'object') {
    return (pid) => (Object.prototype.hasOwnProperty.call(src, String(pid)) ? src[String(pid)] : undefined);
  }
  return null;
}

/**
 * Per-process rows -> Task Manager's grouped list. One row per base name,
 * summing cpu, private memory and I/O, so a 19-process Chrome is one line
 * that reads "Google Chrome (19)" instead of nineteen lines of 0.1%.
 *
 * Sorted busiest first, memory breaking the tie -- the same order Task
 * Manager lands on when you click CPU, and the reason anyone opens this at
 * all is to find what is eating the machine right now.
 *
 * A group of more than one process also carries `children`: its own pids,
 * memory-heaviest first, each `{ pid, cpu, memBytes, ioBps, role, label, url }`
 * plus `wcIds` on the rows that hold webContents of ours.
 * That is the answer to "twelve Electrons, which one is the 1.5 GB tab".
 * opts:
 *   selfPids     Set of our own pids (marks `self`, and only these get labels)
 *   cmdlines     Map pid -> command line (null = read and empty). Absent
 *                altogether means nobody asked, and every role stays ''.
 *   labels       Map pid -> { label, url, wcIds } from webContentsLabels()
 *   cmdlineNote  why the last command-line query gave nothing, in words
 */
function groupProcesses(rows, opts) {
  const o = opts || {};
  const mine = o.selfPids instanceof Set
    ? o.selfPids
    : new Set(Array.isArray(o.selfPids) ? o.selfPids : []);
  const cmdline = lookupIn(o.cmdlines);
  const label = lookupIn(o.labels);
  const note = typeof o.cmdlineNote === 'string' ? o.cmdlineNote : '';

  const map = new Map();
  const members = new Map();     // key -> the rows themselves, for the children
  for (const r of rows || []) {
    if (!r || !Number.isFinite(r.pid)) continue;
    const key = String(r.base).toLowerCase();
    let g = map.get(key);
    if (!g) {
      g = { key, name: friendlyName(r.base), count: 0, pids: [], cpu: 0, memBytes: 0, ioBps: 0, self: false };
      map.set(key, g);
      members.set(key, []);
    }
    g.count += 1;
    g.pids.push(r.pid);
    g.cpu += Number.isFinite(r.cpu) ? r.cpu : 0;
    g.memBytes += Number.isFinite(r.memBytes) ? r.memBytes : 0;
    g.ioBps += Number.isFinite(r.ioBps) ? r.ioBps : 0;
    if (mine.has(r.pid)) g.self = true;
    members.get(key).push(r);
  }

  const groups = Array.from(map.values());
  for (const g of groups) {
    g.cpu = round1(clampPercent(g.cpu)) || 0;
    g.memBytes = Math.round(g.memBytes);
    g.ioBps = Math.round(g.ioBps);
    g.pids.sort((a, b) => a - b);
    attachChildren(g, members.get(g.key) || [], { cmdline, label, note });
  }
  groups.sort((a, b) => (b.cpu - a.cpu) || (b.memBytes - a.memBytes) || a.name.localeCompare(b.name));
  return groups;
}

/**
 * The children of one group, written onto it. Memory-heaviest first: the
 * question this list answers is always "which of them is holding the gigabyte".
 *
 * A one-process group gets no children at all -- its own row already says
 * everything a child row could, and the page draws no chevron for it, so
 * sending twelve hundred bytes a second for it would buy nothing.
 */
function attachChildren(g, rows, ctx) {
  g.children = [];
  g.childrenMore = 0;
  g.childrenNote = '';
  if (!Array.isArray(rows) || rows.length < 2) return;

  // Roles come off a command line, and we only pay for the command lines of
  // programs whose command lines say something: Chromium's, and our own.
  const bare = String(g.key).replace(/\.exe$/, '');
  const detail = !!ctx.cmdline && (g.self === true || CHROMIUM_BASES.has(bare));

  const sorted = rows.slice().sort((a, b) => (
    (b.memBytes - a.memBytes) || (b.cpu - a.cpu) || (a.pid - b.pid)
  ));
  const kept = sorted.slice(0, MAX_PROC_CHILDREN);
  g.childrenMore = sorted.length - kept.length;

  let missing = false;
  g.children = kept.map((r) => {
    const role = detail ? roleFromCommandLine(ctx.cmdline(r.pid)) : '';
    if (role === 'unknown' || role === 'pending') missing = true;

    // Only OUR renderers can be named: a webContents in this process is a tab,
    // the chrome document, or a bundled page. One that holds none is a
    // renderer Chromium is keeping warm, which is worth saying out loud.
    let named = null;
    if (ctx.label && g.self === true && role === 'renderer') {
      named = ctx.label(r.pid) || { label: 'idle renderer', url: '' };
    }

    const child = {
      pid: r.pid,
      cpu: round1(clampPercent(r.cpu)) || 0,
      memBytes: Math.round(Number.isFinite(r.memBytes) ? r.memBytes : 0),
      ioBps: Math.round(Number.isFinite(r.ioBps) ? r.ioBps : 0),
      role,
      label: named && named.label ? String(named.label) : '',
      url: named && named.url ? String(named.url) : '',
    };
    // The webContents ids behind this row, so the chrome can say WHICH tab it
    // is -- main only ever sees a title, and every new tab page is called
    // "New tab". Only on the rows that have any: an empty array on all 24 of
    // a group would be payload for nothing, and the per-second size of this
    // list is the whole reason `children` is capped at all (see the header).
    if (named && Array.isArray(named.wcIds) && named.wcIds.length) {
      child.wcIds = named.wcIds.slice();
    }
    return child;
  });

  // A failure gets carried to the page in words. Without this the rows would
  // just read "unknown" and nothing would say why.
  if (detail && missing && ctx.note) g.childrenNote = ctx.note;
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
  /** pids -> Promise<Map pid -> command line>. A PowerShell, unless stubbed. */
  const readCommandLines = d.commandLines || defaultCommandLines;
  /** Every live webContents, for naming the tab a renderer holds. */
  const readWebContents = d.webContents || defaultWebContents;

  /** webContents id -> { contents, count }. The whole on/off switch. */
  const subscribers = new Map();

  /** Last os.cpus() reading, so the next tick has something to subtract. */
  let prevCpus = null;

  /**
   * The last sample that actually went out, kept for main's sake: an IPC call
   * that has to name a process group (the icon lookup) reads the pids from
   * here rather than sampling again or trusting the renderer for them.
   */
  let lastSampleOut = null;

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

  /**
   * pid -> its command line, or null when the query answered and had nothing
   * for it. A pid that is not a key here has not been asked about yet, which
   * is a different thing and reads as "reading..." on the page. Entries are
   * dropped when their pid leaves the sample, so a machine that churns
   * processes does not accumulate them.
   */
  const cmdLines = new Map();
  /** The query in flight (the pids it asked about), so only one ever runs. */
  let cmdQuery = null;
  let cmdQueryAt = 0;
  /** Why the last query gave nothing, in the words the page will show. */
  let cmdNote = '';
  /** When the last query settled, and the pids a failed one gave up on. */
  let cmdAt = 0;
  let cmdRetryAt = 0;
  let cmdFailed = null;

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
      pruneCommandLines();
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

  // -- command lines ---------------------------------------------------------
  // The only thing here that is not free. One PowerShell, only when a pid we
  // care about is new to us, and the answer is kept until that pid exits.

  /** A pid that left the sample takes its command line with it. */
  function pruneCommandLines() {
    if (!cmdLines.size) return;
    const live = new Set();
    for (const r of procRows) live.add(r.pid);
    for (const pid of Array.from(cmdLines.keys())) {
      if (!live.has(pid)) cmdLines.delete(pid);
    }
    // A cache bigger than the machine's process table means something is
    // wrong upstream; drop the oldest rather than grow without a bound.
    while (cmdLines.size > CMDLINE_CACHE_MAX) {
      const oldest = cmdLines.keys().next();
      if (oldest.done) break;
      cmdLines.delete(oldest.value);
    }
  }

  /** The pids whose command line would tell the page something new. */
  function pidsNeedingCommandLines() {
    const out = [];
    for (const r of procRows) {
      if (cmdLines.has(r.pid)) continue;
      const bare = String(r.base).toLowerCase().replace(/\.exe$/, '');
      if (!procSelf.has(r.pid) && !CHROMIUM_BASES.has(bare)) continue;
      out.push(r.pid);
      if (out.length >= CMDLINE_BATCH) break;   // the rest ride the next query
    }
    return out;
  }

  /**
   * Ask, if there is anything to ask about and nothing already asking. Every
   * outcome is recorded: an answer fills the cache, a pid the answer skipped
   * is cached as null (it reads 'unknown'), and a query that failed outright
   * leaves `cmdNote` for the page to print under the group and backs off for
   * a minute before trying those pids again.
   */
  function maybeQueryCommandLines() {
    if (cmdFailed && cmdRetryAt && now() >= cmdRetryAt) {
      for (const pid of cmdFailed) cmdLines.delete(pid);
      cmdFailed = null;
      cmdRetryAt = 0;
      cmdNote = '';
    }
    // A query that never answers would stop every later one forever, so it is
    // dropped the way a wedged typeperf child is -- and says it was.
    if (cmdQuery && now() - cmdQueryAt > CMDLINE_TIMEOUT_MS * 2) {
      cmdQuery = null;
      cmdAt = now();
      cmdNote = 'process details: the query never answered';
      lastError = cmdNote;
    }
    if (cmdQuery) return;
    if (now() - cmdAt < CMDLINE_MIN_MS) return;

    const pids = pidsNeedingCommandLines();
    if (!pids.length) return;
    cmdQuery = pids;
    cmdQueryAt = now();

    const settle = (map, why) => {
      if (cmdQuery !== pids) return;             // a stop() beat the answer
      cmdQuery = null;
      cmdAt = now();
      const answers = map instanceof Map ? map : new Map();
      for (const pid of pids) {
        const line = answers.has(pid) ? answers.get(pid) : null;
        cmdLines.set(pid, typeof line === 'string' && line ? line.slice(0, CMDLINE_MAX_CHARS) : null);
      }
      if (why) {
        cmdNote = why;
        cmdFailed = new Set(pids);
        cmdRetryAt = cmdAt + CMDLINE_FAIL_MS;
        lastError = why;
      } else {
        cmdNote = '';
        cmdFailed = null;
        cmdRetryAt = 0;
      }
    };

    const failed = (err) => {
      const msg = err && err.message ? String(err.message) : String(err || 'no answer');
      settle(null, 'process details unavailable: ' + msg.slice(0, 120));
    };

    let pending;
    try {
      pending = readCommandLines(pids.slice());
    } catch (err) {
      failed(err);
      return;
    }
    Promise.resolve(pending).then((map) => settle(map, ''), failed);
  }

  /** The grouped process table, or null while there is nothing fresh. */
  function currentProcs() {
    if (!procRowsAt || now() - procRowsAt > COUNTER_STALE_MS) return null;
    maybeQueryCommandLines();
    let labels = null;
    try { labels = webContentsLabels(readWebContents()); } catch { labels = null; }
    const groups = groupProcesses(procRows, {
      selfPids: procSelf,
      cmdlines: cmdLines,
      labels,
      cmdlineNote: cmdNote,
    });
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
      lastSampleOut = sample;

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
    // The command lines go with them: pids are reused, and a stale one would
    // put yesterday's tab title on somebody else's process.
    cmdLines.clear();
    cmdQuery = null;
    cmdNote = '';
    cmdFailed = null;
    cmdRetryAt = 0;
    cmdAt = 0;
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
    /**
     * The last sample sent to a subscriber, or null before the first one (and
     * a stale one for the grace period after the last unsubscribe). Read-only:
     * callers get the object as sent, so nobody may mutate it.
     */
    lastSample: () => lastSampleOut,
    isRunning: () => tickTimer !== null,
    hasChild: () => active !== null,
    hasPending: () => pending !== null,
    childCount: () => (active ? 1 : 0) + (pending ? 1 : 0),
    procCount: () => procRows.length,
    /** The command-line cache, for the harness and for a diagnostics pane. */
    commandLines: () => new Map(cmdLines),
    commandLineNote: () => cmdNote,
    selfPids: () => new Set(procSelf),
    lastError: () => lastError,
  };
}

/**
 * Every live webContents, or an empty list outside Electron (the harness, and
 * anything that requires this file as a plain module). An empty list is not a
 * failure: it means no renderer can be named, and those rows say so with
 * their role instead of a tab title.
 */
function defaultWebContents() {
  try {
    const electron = require('electron');
    const wc = electron && electron.webContents;
    if (wc && typeof wc.getAllWebContents === 'function') return wc.getAllWebContents();
  } catch { /* not Electron */ }
  return [];
}

/**
 * The command lines of a batch of pids, in one PowerShell.
 *
 * Win32_Process is the only place a command line lives on Windows, and there
 * is no counter for it -- so this is the one thing in this file that spawns on
 * demand rather than on a clock. It is asked once per pid in a process's life
 * (see the cache in create()), never on the per-second path.
 *
 * A process owned by another user answers with an empty CommandLine rather
 * than an error; that pid simply does not come back, and the caller caches
 * null for it, which the page prints as 'unknown'.
 */
function defaultCommandLines(pids) {
  return new Promise((resolve, reject) => {
    const list = (Array.isArray(pids) ? pids : []).filter((p) => Number.isInteger(p) && p > 0);
    if (!list.length) { resolve(new Map()); return; }

    const filter = list.map((p) => 'ProcessId=' + p).join(' or ');
    const script = '$ErrorActionPreference=\'SilentlyContinue\';'
      + 'Get-CimInstance Win32_Process -Filter "' + filter + '"'
      + ' | ForEach-Object { $_.ProcessId.ToString() + \'|\' + ($_.CommandLine -replace \'[\\r\\n]+\', \' \') }';

    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    if (!child) { reject(new Error('powershell could not start')); return; }

    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* already gone */ }
      reject(new Error('the query took longer than ' + Math.round(CMDLINE_TIMEOUT_MS / 1000) + ' s'));
    }, CMDLINE_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (out.length < 1000000) out += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { if (err.length < 2000) err += chunk; });
    }
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const map = parseCommandLines(out);
      // A non-zero exit with nothing to show for it is a real failure and has
      // to be said; one that still printed rows is just a warning on stderr.
      if (!map.size && code !== 0) {
        reject(new Error(err.trim().split(/[\r\n]+/)[0] || ('powershell exited ' + code)));
        return;
      }
      resolve(map);
    });
  });
}

/** `1234|C:\\path\\app.exe --type=renderer` lines -> Map pid -> command line. */
function parseCommandLines(text) {
  const out = new Map();
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cut = line.indexOf('|');
    if (cut <= 0) continue;
    const pid = Number(line.slice(0, cut));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.set(pid, line.slice(cut + 1).trim());
  }
  return out;
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
  attachChildren,
  roleFromCommandLine,
  webContentsLabels,
  labelForContents,
  parseCommandLines,
  defaultCommandLines,
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
  MAX_PROC_CHILDREN,
  CHROMIUM_BASES,
  CMDLINE_BATCH,
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
