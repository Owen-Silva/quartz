'use strict';

/*
 * adblock-refresh.js -- keeps the ad blocker's filter lists fresh.
 *
 * Why this exists. main.js builds the engine with Ghostery's
 * fromPrebuiltAdsAndTracking(fetch, { path, read, write }). That call goes
 * through FiltersEngine.fromCached(): if the cache file reads, it is
 * deserialized and NOTHING is fetched again -- there is no TTL. So the lists a
 * profile downloaded on its first run were the lists it blocked with forever:
 * new ad and tracker hosts were never learned, and the breakage fixes the
 * list authors ship (YouTube and X scriptlet rules rot fastest) never arrived.
 *
 * What this module does instead. Startup keeps loading the cached engine at
 * once, exactly as before (50-95 ms, off disk). Separately, once the cache is
 * more than a day old -- checked a short while after startup, then on a timer
 * for as long as the browser runs -- a fresh engine is built in the
 * background, and only swapped in when it passes every check:
 *
 *   1. it was built at all (every list downloaded, none of them a web page);
 *   2. it is a sane size, and does not have suspiciously fewer filters than
 *      the lists it replaces (a truncated download or a captive portal would);
 *   3. it deserializes;
 *   4. it was saved to disk atomically (temp file + rename, the old file kept
 *      as .prev).
 *
 * Any failure keeps the engine already in use, says why in plain words (the
 * shield popover shows it, quartz.log records it) and tries again an hour
 * later. Nothing here touches Electron: the caller hands in the build, the
 * deserialize and the swap, which is what lets adblock-refresh-harness.js
 * drive every path with fakes.
 *
 * The CPU-heavy part (parsing ~100k filters takes seconds and is synchronous)
 * runs in adblock-build-worker.js on a worker thread, so the main process --
 * which is also the UI and IPC thread -- never stalls for it.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DEFAULTS = {
  /** A cache older than this is refreshed. */
  intervalMs: DAY_MS,
  /** After a failed attempt (offline, a bad list), try again this much later. */
  retryMs: HOUR_MS,
  /** The first check waits this long after startup, so it never competes with it. */
  firstDelayMs: 30 * 1000,
  /** A new engine with fewer than this share of the old filter count is rejected. */
  minRatio: 0.5,
  /** Size bounds for the serialized engine (the real one is ~7 MB). */
  minBytes: 256,
  maxBytes: 64 * 1024 * 1024,
};

/* ------------------------------------------------------------------------- */
/* Words                                                                      */
/* ------------------------------------------------------------------------- */

/** One line, at most `max` characters, for the UI and the log. */
function oneLine(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** "just now", "5 hours ago", "yesterday", "3 days ago". */
function ageWords(ms) {
  const v = Number(ms);
  if (!isFinite(v) || v < HOUR_MS) return 'just now';
  if (v < DAY_MS) {
    const h = Math.floor(v / HOUR_MS);
    return h === 1 ? '1 hour ago' : h + ' hours ago';
  }
  const d = Math.floor(v / DAY_MS);
  return d === 1 ? 'yesterday' : d + ' days ago';
}

/**
 * An error carrying the plain words the UI shows. Errors built here (a bad
 * status, a web page instead of a list) set .words themselves; anything else
 * goes through failureWords().
 */
function wordsError(words, code) {
  const err = new Error(words);
  err.words = words;
  if (code) err.code = code;
  return err;
}

const OFFLINE_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'ENONET',
  'ERR_INTERNET_DISCONNECTED', 'ERR_NAME_NOT_RESOLVED', 'ERR_NETWORK_CHANGED',
]);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const DISK_CODES = {
  ENOSPC: 'the disk is full',
  EACCES: 'the file was locked or not writable',
  EPERM: 'the file was locked or not writable',
  EBUSY: 'the file was in use',
  EROFS: 'the disk is read-only',
};

/**
 * The reason a refresh failed, short enough for one line of the shield
 * popover: "offline", "the download timed out", "the list server answered
 * 503", ... Never empty.
 */
function failureWords(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return oneLine(err, 140) || 'unknown error';
  if (err.words) return oneLine(err.words, 140);
  // Node's fetch rejects with TypeError('fetch failed') and the real reason
  // on .cause; walk down to the first error that has a code.
  let e = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = e.code || '';
    if (OFFLINE_CODES.has(code)) return 'offline';
    if (TIMEOUT_CODES.has(code)) return 'the download timed out';
    if (code === 'ECONNREFUSED') return 'the list server refused the connection';
    if (code === 'ECONNRESET') return 'the connection was cut off';
    if (code === 'CERT_HAS_EXPIRED' || /^ERR_TLS|CERT|SELF_SIGNED/.test(code)) return 'the list server\'s certificate was not trusted';
    if (DISK_CODES[code]) return 'couldn\'t save them: ' + DISK_CODES[code];
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'the download timed out';
    e = e.cause;
  }
  return oneLine(err.message || '', 140) || 'unknown error';
}

/** Does a downloaded "list" look like a web page (a captive portal, an error page)? */
function looksLikeHtml(text, contentType) {
  if (contentType && /text\/html/i.test(String(contentType))) return true;
  const head = String(text || '').slice(0, 512).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head');
}

/* ------------------------------------------------------------------------- */
/* Decisions                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Is a refresh due? `updatedAt` is when the cache was last written (its
 * mtime; 0 when there is none). A time in the future means the clock moved
 * back, and is treated as due rather than trusted for days.
 */
function isDue(updatedAt, now, intervalMs) {
  const at = Number(updatedAt) || 0;
  if (at <= 0) return true;
  if (at > now + HOUR_MS) return true;
  return now - at >= (intervalMs || DEFAULTS.intervalMs);
}

/** How long to wait before the next check. */
function nextDelay({ updatedAt, now, lastFailed, intervalMs, retryMs }) {
  const interval = intervalMs || DEFAULTS.intervalMs;
  const retry = retryMs || DEFAULTS.retryMs;
  if (lastFailed) return retry;
  if (isDue(updatedAt, now, interval)) return 0;
  return Math.max(0, updatedAt + interval - now);
}

/**
 * Checks a candidate engine before anything trusts it. Returns '' when it
 * passes, else the plain reason it was refused.
 *   bytes        the serialized engine (Uint8Array / Buffer)
 *   filters      how many filters it holds
 *   prevFilters  how many the engine in use holds (0/undefined = unknown)
 */
function validateCandidate({ bytes, filters, prevFilters }, limits) {
  const lim = Object.assign({}, DEFAULTS, limits || {});
  const size = bytes && typeof bytes.length === 'number' ? bytes.length : 0;
  if (size < lim.minBytes) return 'the new lists came back empty';
  if (size > lim.maxBytes) return 'the new lists were too large (' + Math.round(size / 1048576) + ' MB)';
  const n = Number(filters) || 0;
  if (n < 1) return 'the new lists had no filters in them';
  const prev = Number(prevFilters) || 0;
  if (prev > 0 && n < prev * lim.minRatio) {
    return 'the new lists had only ' + n + ' filters (the current ones have ' + prev + '), which looks broken';
  }
  return '';
}

/* ------------------------------------------------------------------------- */
/* Disk                                                                       */
/* ------------------------------------------------------------------------- */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Write `bytes` to `target` so a reader only ever sees the old file or the
 * whole new one: write a temp file beside it, keep a copy of the old one as
 * `<target>.prev`, then rename over. A rename Windows refuses for a moment (a
 * scanner holding the file) is retried twice. On failure the temp file is
 * removed and the original is untouched.
 */
async function writeAtomic(fsp, target, bytes) {
  const tmp = target + '.tmp';
  try {
    await fsp.writeFile(tmp, bytes);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch { /* never created */ }
    throw err;
  }
  try {
    await fsp.copyFile(target, target + '.prev');
  } catch { /* first save, or the old file is unreadable: nothing to keep */ }
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fsp.rename(tmp, target);
      return;
    } catch (err) {
      lastErr = err;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err && err.code)) break;
      await sleep(150 * (attempt + 1));
    }
  }
  try { await fsp.unlink(tmp); } catch { /* already gone */ }
  throw lastErr;
}

/* ------------------------------------------------------------------------- */
/* The refresher                                                              */
/* ------------------------------------------------------------------------- */

/**
 * d = {
 *   now(): number,
 *   cacheMtime(): Promise<number>        // 0 when there is no cache
 *   readMeta(): Promise<{filters}|null>  // the saved filter count of the cache
 *   writeMeta(meta): Promise<void>
 *   build({ countPrev }): Promise<{ bytes, filters, prevFilters? }>
 *   deserialize(bytes): engine           // throws when corrupt
 *   save(bytes): Promise<void>           // atomic write over the cache
 *   install(engine): void                // finish + swap; throws to refuse
 *   onState(state): void                 // the UI repaints from this
 *   log(line): void                      // quartz.log
 *   setTimeout, clearTimeout             // optional, for the harness
 *   intervalMs, retryMs, firstDelayMs, limits, force
 * }
 */
function createRefresher(d) {
  // An option passed as undefined keeps its default.
  const opt = Object.assign({}, DEFAULTS);
  for (const [k, v] of Object.entries(d)) if (v !== undefined) opt[k] = v;
  const setT = d.setTimeout || setTimeout;
  const clearT = d.clearTimeout || clearTimeout;
  const now = d.now || Date.now;

  const state = {
    updatedAt: 0,     // when the lists in use were downloaded (cache mtime)
    checkedAt: 0,     // when a refresh last finished, either way
    refreshing: false,
    error: '',        // plain reason the last refresh failed; '' after a success
    filters: 0,       // filter count of the lists in use, when known
  };
  let timer = null;
  let stopped = false;
  let force = !!opt.force;
  let running = null;

  function snapshot() { return Object.assign({}, state); }
  function emit() { try { d.onState && d.onState(snapshot()); } catch { /* a repaint never breaks a refresh */ } }
  function log(line) { try { d.log && d.log(line); } catch { /* logging is best effort */ } }

  function schedule(ms) {
    if (stopped) return;
    if (timer) clearT(timer);
    timer = setT(() => { timer = null; runOnce(); }, Math.max(0, ms));
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function start() {
    try { state.updatedAt = Number(await d.cacheMtime()) || 0; } catch { state.updatedAt = 0; }
    try {
      const meta = await d.readMeta();
      if (meta && Number(meta.filters) > 0) state.filters = Number(meta.filters);
    } catch { /* no count yet: the worker counts the cache itself */ }
    emit();
    const due = force || isDue(state.updatedAt, now(), opt.intervalMs);
    if (due) schedule(opt.firstDelayMs);
    else schedule(nextDelay({ updatedAt: state.updatedAt, now: now(), intervalMs: opt.intervalMs }));
    return snapshot();
  }

  async function attempt() {
    const t0 = now();
    const oldWords = state.updatedAt ? 'from ' + ageWords(now() - state.updatedAt) : 'missing';
    let built;
    try {
      built = await d.build({ countPrev: !(state.filters > 0) });
    } catch (err) {
      throw wordsError(failureWords(err));
    }
    const prevFilters = state.filters > 0 ? state.filters : (Number(built && built.prevFilters) || 0);
    const refused = validateCandidate({ bytes: built && built.bytes, filters: built && built.filters, prevFilters }, opt.limits);
    if (refused) throw wordsError(refused);

    let engine;
    try {
      engine = d.deserialize(built.bytes);
    } catch (err) {
      throw wordsError('the new lists could not be read back (' + oneLine((err && err.message) || err, 80) + ')');
    }
    if (!engine) throw wordsError('the new lists could not be read back');

    try {
      await d.save(built.bytes);
    } catch (err) {
      const w = failureWords(err);
      throw wordsError(w.startsWith('couldn\'t save') ? w : 'couldn\'t save them: ' + w);
    }

    try {
      d.install(engine);
    } catch (err) {
      throw wordsError('the new lists could not be switched on (' + oneLine((err && err.message) || err, 80) + ')');
    }

    state.updatedAt = now();
    state.filters = Number(built.filters) || 0;
    state.error = '';
    try { await d.writeMeta({ filters: state.filters, updatedAt: state.updatedAt }); } catch { /* the count is a nicety */ }
    log('The ad blocker\'s filter lists were updated (' + state.filters + ' filters, was '
      + (prevFilters || 'unknown') + '; the old lists were ' + oldWords
      + ') in ' + Math.round((now() - t0) / 1000) + ' s.');
  }

  /** One refresh. Concurrent calls share the one in flight. */
  function runOnce() {
    if (running) return running;
    if (stopped) return Promise.resolve(snapshot());
    state.refreshing = true;
    emit();
    running = (async () => {
      let failed = false;
      try {
        await attempt();
      } catch (err) {
        failed = true;
        state.error = failureWords(err);
        const age = state.updatedAt ? 'lists from ' + ageWords(now() - state.updatedAt) : 'no lists at all';
        log('The ad blocker could not update its filter lists (' + state.error + '); still using '
          + age + '. Trying again in ' + Math.round(opt.retryMs / 60000) + ' min.');
      } finally {
        force = false;
        state.refreshing = false;
        state.checkedAt = now();
        running = null;
        emit();
        schedule(nextDelay({ updatedAt: state.updatedAt, now: now(), lastFailed: failed,
          intervalMs: opt.intervalMs, retryMs: opt.retryMs }));
      }
      return snapshot();
    })();
    return running;
  }

  function stop() {
    stopped = true;
    if (timer) clearT(timer);
    timer = null;
  }

  return { start, runOnce, stop, state: snapshot };
}

module.exports = {
  DEFAULTS, HOUR_MS, DAY_MS,
  oneLine, ageWords, wordsError, failureWords, looksLikeHtml,
  isDue, nextDelay, validateCandidate, writeAtomic, createRefresher,
};
