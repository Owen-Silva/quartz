'use strict';

/**
 * Icons for the new tab's process list.
 *
 * The sampler (stats.js) hands the page groups keyed by the typeperf instance
 * base name -- 'spotify', 'svchost', 'valorant-win64-shipping', 'claude'. Task
 * Manager puts the real executable's icon left of each of those names, and so
 * does this: one 32 px NativeImage per group, as a data URL, resolved from the
 * exe the group's live pids actually came from.
 *
 * The whole point is that it costs nothing once warm. A key that has been seen
 * before answers out of a Map in the same tick -- no spawn, no shell icon
 * extraction, no disk -- because this is asked once a second for as long as a
 * new tab sits in front. Only a name that has never been resolved does work,
 * and even then the order is cheapest-first:
 *
 *   1. our own process        -> process.execPath
 *   2. the apps index         -> lookupPath(key), when main.js supplies it
 *   3. the Windows folders    -> System32 / SysWOW64 / Windows, fs.access only
 *   4. one PowerShell batch   -> Get-Process -Id <every unresolved pid>
 *   5. app.getFileIcon(path)  -> data URL
 *
 * Step 4 is the only one that spawns, so it is debounced, batched across every
 * key that needs it, single-flighted, and rate-limited to one spawn per ten
 * seconds. A key that is still unresolved when the caller's 3 s budget runs out
 * answers null for that ask and is picked up on the next one -- the background
 * resolve keeps going and lands in the cache either way.
 *
 * Nothing here requires Electron: `app` and every filesystem and child-process
 * call is injected, so the cache policy, the debounce and the Get-Process
 * parsing can be driven under plain node with fakes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const fsp = fs.promises;

/** <userData>/proc-icons.json */
const CACHE_NAME = 'proc-icons.json';
const CACHE_VERSION = 1;

/** Task Manager tops out around 250 distinct names; 300 is a whole machine. */
const MAX_ENTRIES = 300;

/** One ask is one visible list. */
const MAX_KEYS_PER_ASK = 64;

/** Keeps the Get-Process command line short enough to never be a problem. */
const MAX_PIDS_PER_BATCH = 64;

/** How long an ask may wait for cold keys before answering null for them. */
const RESOLVE_BUDGET_MS = 3000;

/** Collect every cold key that shows up in this window into one spawn. */
const BATCH_DEBOUNCE_MS = 500;

/** Hard floor between two PowerShell spawns. */
const SPAWN_GAP_MS = 10000;

/** A Get-Process that has not answered by now is a failure. */
const BATCH_TIMEOUT_MS = 8000;

/** A name with no icon is not asked about again for an hour. */
const NULL_RETRY_MS = 60 * 60 * 1000;

/** ...unless it was the batch itself that failed, which is worth a retry. */
const FAIL_RETRY_MS = 60 * 1000;

/** A hit is trusted for a day before its path is checked again. */
const PATH_RECHECK_MS = 24 * 60 * 60 * 1000;

const SAVE_DEBOUNCE_MS = 1000;

/** 32 px on Windows -- the size the list draws at 16 px on a 2x display. */
const ICON_SIZE = 'normal';

const POWERSHELL = 'powershell.exe';
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command'];

/**
 * A key becomes a path (`System32\<key>.exe`), so it may only ever be a bare
 * file name: no separators, no drive, no '..'. Everything the sampler produces
 * already looks like this; anything else is refused rather than sanitised.
 */
const SAFE_KEY_RE = /^[a-z0-9][a-z0-9 ._+-]{0,63}$/;

// ---------------------------------------------------------------------------
// Pure parts (also the harness's surface)
// ---------------------------------------------------------------------------

/** Whatever the caller passed -> the lowercase base name stats.js uses. */
function normalizeKey(raw) {
  let k = String(raw == null ? '' : raw).trim().toLowerCase();
  if (k.endsWith('.exe')) k = k.slice(0, -4);
  return k;
}

function isSafeKey(key) {
  const k = String(key == null ? '' : key);
  return SAFE_KEY_RE.test(k) && k.indexOf('..') < 0;
}

/** The three places a Windows system exe lives, cheapest guess first. */
function systemGuesses(key, env) {
  const e = env || process.env;
  const root = e.SystemRoot || e.windir || 'C:\\Windows';
  return [
    path.join(root, 'System32', key + '.exe'),
    path.join(root, 'SysWOW64', key + '.exe'),
    path.join(root, key + '.exe'),
  ];
}

/** The one command this module ever runs. */
function batchCommand(pids) {
  return 'Get-Process -Id ' + pids.join(',')
    + ' -ErrorAction SilentlyContinue | Select-Object Id,Path | ConvertTo-Json -Compress';
}

/**
 * Get-Process | ConvertTo-Json output -> Map pid -> path|null.
 *
 * One match is a bare object, several are an array, none is an empty string --
 * all three are normal. Anything else (a PowerShell error on stdout, a half
 * written buffer) returns null, which the caller treats as a failed batch.
 *
 * @returns {Map<number,string|null>|null}
 */
function parseProcessJson(stdout) {
  const text = String(stdout == null ? '' : stdout).trim();
  const out = new Map();
  if (!text) return out; // nothing matched: a valid, empty answer
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    if (!row || typeof row !== 'object') return null;
    const pid = Number(row.Id);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const p = typeof row.Path === 'string' && row.Path.trim() ? row.Path.trim() : null;
    out.set(pid, p);
  }
  return out;
}

/** Map -> the on-disk shape. */
function serializeCache(entries) {
  const obj = { version: CACHE_VERSION, entries: {} };
  for (const [key, e] of entries) {
    if (!e) continue;
    obj.entries[key] = {
      path: typeof e.path === 'string' ? e.path : null,
      dataUrl: typeof e.dataUrl === 'string' ? e.dataUrl : null,
      at: Number.isFinite(e.at) ? e.at : 0,
    };
  }
  return obj;
}

/**
 * The on-disk shape -> Map. A file from another version, a truncated file or a
 * hand-edited one costs the cache and nothing else: an empty Map is a cold
 * start, which is a state this module handles on every fresh profile anyway.
 */
function parseCache(text) {
  const out = new Map();
  let data;
  try {
    data = JSON.parse(String(text == null ? '' : text));
  } catch {
    return out;
  }
  if (!data || typeof data !== 'object') return out;
  if (data.version !== CACHE_VERSION) return out;
  const src = data.entries;
  if (!src || typeof src !== 'object') return out;
  for (const rawKey of Object.keys(src)) {
    const key = normalizeKey(rawKey);
    if (!isSafeKey(key)) continue;
    const e = src[rawKey];
    if (!e || typeof e !== 'object') continue;
    const at = Number(e.at);
    const dataUrl = typeof e.dataUrl === 'string' && e.dataUrl.startsWith('data:image/')
      ? e.dataUrl
      : null;
    out.set(key, {
      path: typeof e.path === 'string' && e.path ? e.path : null,
      dataUrl,
      at: Number.isFinite(at) ? at : 0,
    });
  }
  return out;
}

/** execFile that reports rather than throws: { code, stdout, stderr }. */
function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs || BATCH_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) code = Number.isInteger(err.code) ? err.code : 1;
        resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 *   app         Electron's app -- getFileIcon and, without userDataDir, the
 *               cache location. Optional: a harness can pass getFileIcon alone.
 *   userDataDir where proc-icons.json lives (defaults to app's userData).
 *   lookupPath  (key) => path|null|Promise, the apps index by exe base name.
 *               A missing hook, a throw or a null is simply "not found".
 *   exec        (file, args, timeoutMs) => { code, stdout, stderr }
 *   getFileIcon (path) => Promise<NativeImage>
 *   fs          { access, readFile, writeFile, rename }
 *   now / hrNow / setTimer / clearTimer / env / execPath
 */
function create(deps) {
  const d = deps || {};
  const app = d.app || null;
  const env = d.env || process.env;
  const execPath = d.execPath || process.execPath;
  const exec = typeof d.exec === 'function' ? d.exec : run;
  const now = d.now || (() => Date.now());
  const hrNow = d.hrNow || (() => Number(process.hrtime.bigint()) / 1e6);
  const setTimer = d.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer || ((t) => clearTimeout(t));
  const fsx = Object.assign({
    access: (p) => fsp.access(p, fs.constants.R_OK),
    readFile: (p) => fsp.readFile(p, 'utf8'),
    writeFile: (p, data) => fsp.writeFile(p, data, 'utf8'),
    rename: (a, b) => fsp.rename(a, b),
  }, d.fs || {});
  const lookupPath = typeof d.lookupPath === 'function' ? d.lookupPath : null;
  const getFileIcon = typeof d.getFileIcon === 'function'
    ? d.getFileIcon
    : (app && typeof app.getFileIcon === 'function'
      ? (p) => app.getFileIcon(p, { size: ICON_SIZE })
      : null);

  /** key -> { path, dataUrl, at, retryMs? }. dataUrl null means "no icon". */
  const entries = new Map();
  /** key -> Promise<dataUrl|null>, so ten asks a second cost one resolve. */
  const inflight = new Map();
  /** key -> { pid, waiters: [] }, whatever the next spawn has to ask about. */
  const pendingBatch = new Map();

  let loaded = false;
  let loading = null;
  let dirty = false;
  let saveTimer = null;
  let batchTimer = null;
  let batchInFlight = false;
  let lastSpawnAt = 0;
  let stopped = false;

  let spawns = 0;
  let lastBatchMs = 0;
  let lastIconMs = 0;
  let iconCalls = 0;
  let iconMsTotal = 0;

  function cachePath() {
    const dir = d.userDataDir
      || (app && typeof app.getPath === 'function' ? app.getPath('userData') : os.tmpdir());
    return path.join(String(dir), CACHE_NAME);
  }

  // -- The cache file -------------------------------------------------------

  /** Read once, on the first ask. A missing file is the normal cold start. */
  function ensureLoaded() {
    if (loaded) return Promise.resolve();
    if (loading) return loading;
    loading = fsx.readFile(cachePath())
      .then((text) => { for (const [k, e] of parseCache(text)) entries.set(k, e); })
      .catch(() => {})
      .then(() => { loaded = true; loading = null; });
    return loading;
  }

  /** Oldest first out, so the cap holds without ever growing unbounded. */
  function prune() {
    if (entries.size <= MAX_ENTRIES) return;
    const byAge = Array.from(entries.entries()).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    for (let i = 0; i < byAge.length - MAX_ENTRIES; i += 1) entries.delete(byAge[i][0]);
  }

  function scheduleSave() {
    dirty = true;
    if (stopped || saveTimer) return;
    saveTimer = setTimer(() => { saveTimer = null; flush(); }, SAVE_DEBOUNCE_MS);
  }

  /** Temp file then rename: a crash mid-write leaves the old cache intact. */
  async function flush() {
    if (!dirty) return;
    dirty = false;
    prune();
    const file = cachePath();
    const tmp = file + '.tmp';
    try {
      await fsx.writeFile(tmp, JSON.stringify(serializeCache(entries)));
      await fsx.rename(tmp, file);
    } catch {
      // A cache that cannot be written costs the next cold start and nothing
      // else -- never the icons that are already in memory.
    }
  }

  function remember(key, filePath, dataUrl) {
    entries.set(key, { path: filePath || null, dataUrl: dataUrl || null, at: now() });
    scheduleSave();
  }

  function rememberNull(key, filePath, retryMs) {
    const e = { path: filePath || null, dataUrl: null, at: now() };
    if (retryMs && retryMs !== NULL_RETRY_MS) e.retryMs = retryMs;
    entries.set(key, e);
    scheduleSave();
  }

  // -- Step 5: path -> data URL --------------------------------------------

  /**
   * The shell's icon for one file. An empty NativeImage (a path that no longer
   * exists, an exe with no icon resource) and a throw are the same answer.
   */
  async function iconFor(filePath) {
    if (!getFileIcon) return null;
    const t0 = hrNow();
    try {
      const img = await getFileIcon(filePath);
      lastIconMs = hrNow() - t0;
      iconCalls += 1;
      iconMsTotal += lastIconMs;
      if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) return null;
      const url = typeof img.toDataURL === 'function' ? img.toDataURL() : null;
      return url && url.startsWith('data:image/') ? url : null;
    } catch {
      lastIconMs = hrNow() - t0;
      return null;
    }
  }

  async function exists(filePath) {
    try {
      await fsx.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // -- Step 4: the one spawn ------------------------------------------------

  /** Park a key on the next batch; resolves to its exe path, or null. */
  function queueBatch(key, pid) {
    return new Promise((resolve) => {
      const slot = pendingBatch.get(key);
      if (slot) {
        slot.waiters.push(resolve);
      } else {
        pendingBatch.set(key, { pid, waiters: [resolve] });
      }
      scheduleBatch();
    });
  }

  /**
   * One timer at a time. The first cold key opens a 500 ms window and every
   * other cold key in that window rides along; if the last spawn was under ten
   * seconds ago the window simply stretches to the end of that gap.
   */
  function scheduleBatch() {
    if (stopped || batchTimer || batchInFlight) return;
    const since = now() - lastSpawnAt;
    const wait = Math.max(BATCH_DEBOUNCE_MS, SPAWN_GAP_MS - since);
    batchTimer = setTimer(runBatch, wait);
  }

  function settle(slot, value) {
    for (const w of slot.waiters) w(value);
  }

  async function runBatch() {
    batchTimer = null;
    if (stopped || batchInFlight || !pendingBatch.size) return;

    /** Only as many pids as fit one command; the rest ride the next batch. */
    const take = Array.from(pendingBatch.entries()).slice(0, MAX_PIDS_PER_BATCH);
    for (const [key] of take) pendingBatch.delete(key);

    batchInFlight = true;
    lastSpawnAt = now();
    spawns += 1;
    const t0 = hrNow();
    let res = { code: 1, stdout: '', stderr: '' };
    try {
      res = await exec(POWERSHELL, PS_ARGS.concat(batchCommand(take.map(([, v]) => v.pid))), BATCH_TIMEOUT_MS);
    } catch (err) {
      res = { code: 1, stdout: '', stderr: String((err && err.message) || err) };
    }
    lastBatchMs = hrNow() - t0;
    batchInFlight = false;

    const byPid = res && res.code === 0 ? parseProcessJson(res.stdout) : null;
    for (const [key, slot] of take) {
      if (!byPid) {
        // The batch itself failed: worth asking again in a minute.
        rememberNull(key, null, FAIL_RETRY_MS);
        settle(slot, null);
        continue;
      }
      // A row with a null Path, or a pid that has since exited: there is no
      // icon to be had. Remembered, or every single sample asks again.
      const p = byPid.get(slot.pid) || null;
      if (!p) rememberNull(key, null, NULL_RETRY_MS);
      settle(slot, p);
    }

    if (pendingBatch.size) scheduleBatch();
  }

  // -- Steps 1-3, then 4, then 5 -------------------------------------------

  /** The apps index, defensive about whatever it hands back. */
  async function fromLookup(key) {
    if (!lookupPath) return null;
    try {
      const p = await Promise.resolve(lookupPath(key));
      if (typeof p !== 'string' || !p.trim()) return null;
      return (await exists(p)) ? p : null; // shell:AppsFolder ids fall through
    } catch {
      return null;
    }
  }

  async function fromSystemDirs(key) {
    for (const p of systemGuesses(key, env)) {
      if (await exists(p)) return p;
    }
    return null;
  }

  /** One cold key, all the way to a data URL (or a remembered null). */
  async function resolveKey(group) {
    const key = group.key;

    let filePath = group.self ? execPath : null;
    if (!filePath) filePath = await fromLookup(key);
    if (!filePath) filePath = await fromSystemDirs(key);

    if (!filePath) {
      const pid = group.pids.length ? group.pids[0] : 0;
      if (!pid) {
        rememberNull(key, null, NULL_RETRY_MS);
        return null;
      }
      filePath = await queueBatch(key, pid);
      // A failed batch has already remembered its own retry window.
      if (!filePath) return null;
    }

    const url = await iconFor(filePath);
    if (!url) {
      rememberNull(key, filePath, NULL_RETRY_MS);
      return null;
    }
    remember(key, filePath, url);
    return url;
  }

  /** Same key asked twice in the same second: one resolve, two answers. */
  function resolveOnce(group) {
    const cur = inflight.get(group.key);
    if (cur) return cur;
    const p = resolveKey(group).catch(() => null);
    inflight.set(group.key, p);
    p.then(() => { if (inflight.get(group.key) === p) inflight.delete(group.key); });
    return p;
  }

  /**
   * A hit older than a day: confirm the exe is still there. Gone (uninstalled,
   * updated into a versioned folder) means resolve it again from scratch.
   */
  async function recheck(group, entry) {
    if (entry.path && await exists(entry.path)) {
      entry.at = now();
      scheduleSave();
      return entry.dataUrl;
    }
    entries.delete(group.key);
    return resolveOnce(group);
  }

  /** Wait for the cold keys, but never past the budget. */
  function withBudget(work) {
    if (!work.length) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimer(timer);
        resolve();
      };
      const timer = setTimer(() => {
        if (done) return;
        done = true;
        resolve(); // the rest keep going in the background and land in cache
      }, RESOLVE_BUDGET_MS);
      Promise.all(work).then(finish, finish);
    });
  }

  /** [{key,pids,self}] -> the same, cleaned, deduped and capped. */
  function normalizeGroups(groups) {
    const out = [];
    const seen = new Set();
    for (const g of Array.isArray(groups) ? groups : []) {
      if (out.length >= MAX_KEYS_PER_ASK) break;
      const key = normalizeKey(g && (g.key != null ? g.key : g));
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const pids = [];
      for (const raw of Array.isArray(g && g.pids) ? g.pids : []) {
        const pid = Number(raw);
        if (Number.isInteger(pid) && pid > 0) pids.push(pid);
      }
      out.push({ key, pids, self: !!(g && g.self), safe: isSafeKey(key) });
    }
    return out;
  }

  /**
   * The whole public surface.
   * @param {Array<{key:string,pids:number[],self:boolean}>} groups
   * @returns {Promise<Object<string,string|null>>} every requested key, answered
   */
  async function getIcons(groups) {
    const list = normalizeGroups(groups);
    const answer = {};
    if (!list.length) return answer;

    const staged = Object.create(null);
    for (const g of list) staged[g.key] = null;

    await ensureLoaded();

    const work = [];
    for (const g of list) {
      // An unsafe key never becomes a path and never reaches a spawn.
      if (!g.safe) continue;
      const e = entries.get(g.key);
      if (e && e.dataUrl) {
        staged[g.key] = e.dataUrl;
        if (now() - (e.at || 0) > PATH_RECHECK_MS) {
          work.push(recheck(g, e).then((url) => { staged[g.key] = url || null; }));
        }
        continue;
      }
      if (e && !e.dataUrl && now() - (e.at || 0) < (e.retryMs || NULL_RETRY_MS)) continue;
      if (e) entries.delete(g.key); // the retry window is up
      work.push(resolveOnce(g).then((url) => { staged[g.key] = url || null; }));
    }

    await withBudget(work);

    // A copy, so a resolve that lands after the budget cannot mutate an answer
    // the caller has already been handed.
    for (const g of list) answer[g.key] = staged[g.key] || null;
    return answer;
  }

  /** For the report and the dev console: what has this actually cost? */
  function stats() {
    let known = 0;
    let nullCount = 0;
    for (const e of entries.values()) {
      if (e && e.dataUrl) known += 1;
      else nullCount += 1;
    }
    return {
      known,
      nullCount,
      spawns,
      lastBatchMs: Math.round(lastBatchMs * 100) / 100,
      lastIconMs: Math.round(lastIconMs * 100) / 100,
      iconCalls,
      iconMsAvg: iconCalls ? Math.round((iconMsTotal / iconCalls) * 100) / 100 : 0,
      entries: entries.size,
      pending: pendingBatch.size,
    };
  }

  /** Quit path: no more timers, no more spawns, last write goes out. */
  function stop() {
    stopped = true;
    if (batchTimer) { clearTimer(batchTimer); batchTimer = null; }
    if (saveTimer) { clearTimer(saveTimer); saveTimer = null; }
    for (const [, slot] of pendingBatch) settle(slot, null);
    pendingBatch.clear();
    return flush();
  }

  return { getIcons, stats, stop, flush, cachePath };
}

module.exports = {
  create,
  // pure parts, for the harnesses
  normalizeKey,
  isSafeKey,
  systemGuesses,
  batchCommand,
  parseProcessJson,
  serializeCache,
  parseCache,
  CACHE_NAME,
  CACHE_VERSION,
  MAX_ENTRIES,
  MAX_KEYS_PER_ASK,
  MAX_PIDS_PER_BATCH,
  RESOLVE_BUDGET_MS,
  BATCH_DEBOUNCE_MS,
  SPAWN_GAP_MS,
  NULL_RETRY_MS,
  FAIL_RETRY_MS,
  PATH_RECHECK_MS,
  SAVE_DEBOUNCE_MS,
  ICON_SIZE,
  POWERSHELL,
  PS_ARGS,
};
