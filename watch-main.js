'use strict';
/*
 * watch-main.js -- the MAIN-process half of Watch, Quartz's streaming hub.
 *
 *   watch/shape.js         the contract: services, item and event shapes, cleaning (pure, shared)
 *   watch/merge.js         cache -> the page's rows, local search, the sports strip (pure, shared)
 *   watch/adapters/*.js    one tolerant parser per service + the reads it needs (pure)
 *   watch-main.js          this file: runs those reads, keeps the cache, answers the page
 *   watch.html / watch.js  the page: a bundled, preload-less file:// guest like search.html
 *
 * HOW A SERVICE IS READ. One hidden reader at a time, never one of the user's tabs:
 *   - a VIEW step loads the service's own page in an off-screen, never-shown, muted
 *     BrowserWindow on session.defaultSession -- the cookies the user signed in with, no copy
 *     of them anywhere -- with images off and popups denied. It reads the page's own
 *     embedded state with executeJavaScript (YouTube's ytInitialData, Prime's hydration
 *     JSON) and/or captures the JSON the page itself fetches over CDP on THAT view only
 *     (Disney+'s explore API): Ghostery keeps webRequest, the user's tabs are never touched.
 *     The window is destroyed the moment the step ends (20 s budget at most).
 *   - a FETCH step is public JSON (ESPN's scoreboard) fetched straight from main.
 * Captured bodies are parsed in memory and never written; only the reduced item list is
 * cached, in <userData>/watch-cache.json. Nothing leaves the PC except the requests the
 * service pages make anyway.
 *
 * WHEN. Cache first: the page draws the cache the moment it says hello, then the services
 * that are due are read one by one and the page is patched after each. Due = older than
 * the service's floor (YouTube 15 min, Disney+/Prime 60, ESPN 15 or 2 while a game is
 * live). Reads happen ONLY while a Watch page is open, and never while the Quartz window
 * is hidden or minimised (unless the cache is very stale), while a game is running, or
 * with under 1.5 GB of memory free -- and each of those pauses is SHOWN on the page, with
 * its reason, never silent. One timer, armed only while a Watch page exists.
 *
 * THE PAGE (watch.html) asks over console lines, like search.html; only a guest whose URL
 * is OUR watch.html is heard, and every line is validated here:
 *   in    quartz-watch:hello    {}
 *         quartz-watch:refresh  {"service":"youtube"|null}     (null = every service)
 *         quartz-watch:open     {"url":"https://..."}           (a title: Quartz tab, or Edge for DRM)
 *         quartz-watch:signin   {"service":"disney"}            (the sign-in page, in a Quartz tab)
 *         quartz-watch:search   {"q":"bluey","seq":3}           (YouTube results + TMDB slot)
 *         quartz-watch:forget   {}                              (delete the cache)
 *         quartz-watch:settings {}                              (handled by app.js: Settings > Watch)
 *   out   window.__applyWatch(snapshot)       after hello, and after every change
 *         window.__applyWatchSearch(answer)
 *         window.__applyWatchResult({ action, ok, reason, how })
 *
 * TESTS: create({ test: { rebase, openStub, ... } }) -- main.js passes these ONLY to a
 * --test-profile instance (QUARTZ_WATCH_* env), so a live Quartz always reads the real
 * services. watch-harness.js drives create() with fakes (runStep, fetch, clock);
 * watch-e2e.js drives a real hidden test instance against a local mock of each service.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Shape = require('./watch/shape');
const Merge = require('./watch/merge');

const ADAPTERS = {};
for (const id of Shape.SERVICE_IDS) {
  try { ADAPTERS[id] = require('./watch/adapters/' + id); } catch (err) { ADAPTERS[id] = null; }
}

/* TMDB "where to watch" (watch/tmdb.js): only with a key the user pastes in Settings > Watch. */
let Tmdb = null;
try { Tmdb = require('./watch/tmdb'); } catch (err) { Tmdb = null; }

const LINE_PREFIX = 'quartz-watch:';
const PAGE_FILE = 'watch.html';
const CACHE_FILE = 'watch-cache.json';
const PREFS_FILE = 'watch.json';
const CACHE_VERSION = 1;

const STEP_BUDGET_MS = 20000;
const WATCHDOG_GRACE_MS = 5000;     // a step that outlives its budget by this much is ended from outside
const POLL_MS = 500;
const DEFAULT_SETTLE_MS = 2500;
const MAX_CAPTURES = 40;
const MAX_CAPTURE_BYTES = 12 * 1024 * 1024;
const MAX_EXTRACT_CHARS = 16 * 1024 * 1024;
const MAX_FETCH_CHARS = 8 * 1024 * 1024;
const ITEMS_PER_SERVICE = 300;
const MIN_FREE_GB = 1.5;
const FORCE_GAP_MS = 30 * 1000;          // a Retry clicked twice reads once
const STALE_FACTOR = 4;                  // hidden/minimised: read only when 4x past the floor
const HIDDEN_RECHECK_MS = 10 * 60 * 1000;
const TIMER_MIN_MS = 30 * 1000;
const TIMER_MAX_MS = 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 1500;
const GAME_CHECK_TTL_MS = 60 * 1000;
const SEARCH_GAP_MS = 1200;
const SEARCH_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 20;
const QUERY_MAX = 200;

/* Games whose process means "do not start a hidden page now" (The user plays VALORANT). */
const GAME_PROCESSES = ['valorant-win64-shipping.exe', 'league of legends.exe', 'fortniteclient-win64-shipping.exe',
  'cs2.exe', 'rocketleague.exe', 'overwatch.exe', 'r5apex.exe', 'cod.exe'];

/* ------------------------------------------------------------------ pure helpers */

/** Watch's own settings, checked: which services are on, which leagues, the TMDB key. */
function cleanPrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const enabled = {};
  for (const id of Shape.SERVICE_IDS) {
    enabled[id] = !(r.enabled && typeof r.enabled === 'object' && r.enabled[id] === false);
  }
  let leagues = Array.isArray(r.leagues) ? r.leagues.filter((l) => !!Shape.leagueById(l)) : null;
  if (!leagues) leagues = Shape.DEFAULT_LEAGUES.slice();
  leagues = leagues.filter((l, i) => leagues.indexOf(l) === i);
  const tmdbKey = cleanKey(r.tmdbKey);
  return { enabled, leagues, tmdbKey };
}

/** A TMDB key as pasted (a v3 key or a v4 read token), or ''. */
function cleanKey(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 600 || /[\s\u0000-\u001f\u007f]/.test(s)) return '';
  return s;
}

function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return '••••' + s.slice(-4);
}

/**
 * One console line from the page, as { verb, ...args }, or null when it is not a
 * well-formed Watch request. Pure and the whole of the validation.
 */
function parseGuestLine(text) {
  if (typeof text !== 'string') return null;
  const line = text.trim();
  if (line.indexOf(LINE_PREFIX) !== 0) return null;
  const rest = line.slice(LINE_PREFIX.length);
  const space = rest.indexOf(' ');
  const verb = space === -1 ? rest : rest.slice(0, space);
  let msg = {};
  if (space !== -1) {
    try { msg = JSON.parse(rest.slice(space + 1)); } catch { return null; }
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  switch (verb) {
    case 'hello': case 'forget': case 'settings':
      return { verb };
    case 'refresh':
      if (msg.service === null || msg.service === undefined) return { verb, service: null };
      return Shape.SERVICE_IDS.indexOf(msg.service) !== -1 ? { verb, service: msg.service } : null;
    case 'signin':
      return Shape.SERVICE_IDS.indexOf(msg.service) !== -1 ? { verb, service: msg.service } : null;
    case 'open': {
      const url = Shape.cleanHttps(msg.url);
      if (!url) return null;
      // Watch opens titles on the services it reads (and TMDB's where-to-watch
      // pages, which front JustWatch's links), and nothing else.
      if (!Shape.serviceForUrl(url) && !isTmdbPage(url)) return null;
      return { verb, url };
    }
    case 'search': {
      const q = typeof msg.q === 'string' ? msg.q.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, QUERY_MAX) : '';
      const seq = Number.isInteger(msg.seq) && msg.seq >= 0 ? msg.seq : 0;
      if (!q) return null;
      return { verb, q, seq };
    }
    default:
      return null;
  }
}

function isTmdbPage(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return u.protocol === 'https:' && (h === 'www.themoviedb.org' || h === 'themoviedb.org');
  } catch { return false; }
}

/** Chromium's net error (an Error from loadURL / fetch, or a code) -> { code, detail }. */
function classifyNetError(err, host) {
  const text = String((err && (err.code || err.message)) || err || '');
  const errno = err && typeof err.errno === 'number' ? err.errno : null;
  const where = host ? host : 'the service';
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed/i.test(text)
    || [-106, -21, -105, -137, -109, -102, -101, -100, -118, -7].indexOf(errno) !== -1) {
    return { code: 'offline', detail: /DISCONNECTED/i.test(text) ? "you're offline" : where + " didn't answer (offline?)" };
  }
  if (/ERR_BLOCKED_BY_CLIENT/i.test(text) || errno === -20) {
    return { code: 'load-failed', detail: "Quartz's ad blocker stopped the page loading" };
  }
  if (/abort/i.test(text)) return { code: 'timeout', detail: 'timed out after ' + Math.round(STEP_BUDGET_MS / 1000) + ' s' };
  const short = text.replace(/^Error:\s*/, '').slice(0, 120) || 'unknown error';
  return { code: 'load-failed', detail: 'the page failed to load (' + short + ')' };
}

/** TEST ONLY: swap a real origin for the mock's. `map` is [[from, to], ...]. */
function rebaseUrl(url, map) {
  if (!Array.isArray(map) || !map.length || typeof url !== 'string') return url;
  for (const pair of map) {
    if (Array.isArray(pair) && typeof pair[0] === 'string' && url.indexOf(pair[0]) === 0) return pair[1] + url.slice(pair[0].length);
  }
  return url;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function emptyServiceState() {
  return { state: 'never', reason: '', readAt: 0, attemptAt: 0, lastOkAt: 0, items: [], profile: '', events: null, captured: 0, warnings: [] };
}

/** The cache file's contents, checked. Anything broken becomes "never read". */
function cleanCache(raw) {
  const out = { v: CACHE_VERSION, services: {} };
  const src = raw && typeof raw === 'object' && raw.v === CACHE_VERSION && raw.services && typeof raw.services === 'object' ? raw.services : {};
  for (const id of Shape.SERVICE_IDS) {
    const s = src[id] && typeof src[id] === 'object' ? src[id] : {};
    const e = emptyServiceState();
    if (Shape.STATES.indexOf(s.state) !== -1 && s.state !== 'off') e.state = s.state;
    e.reason = Shape.cleanText(s.reason, 240);
    for (const k of ['readAt', 'attemptAt', 'lastOkAt']) e[k] = Number.isFinite(s[k]) && s[k] > 0 ? s[k] : 0;
    e.items = Shape.cleanItems(s.items, ITEMS_PER_SERVICE).filter((it) => it.service === id);
    e.profile = Shape.cleanText(s.profile, 60);
    e.warnings = Array.isArray(s.warnings) ? s.warnings.map((x) => Shape.cleanText(x, 160)).filter(Boolean).slice(0, 5) : [];
    e.events = id === 'espn' && Array.isArray(s.events) ? Shape.cleanEvents(s.events) : null;
    out.services[id] = e;
  }
  return out;
}

/* ------------------------------------------------------------------ the module */

function create(deps) {
  const d = deps || {};
  const electronApp = d.app || null;
  const test = d.test && typeof d.test === 'object' ? d.test : {};
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const log = typeof d.log === 'function' ? d.log : (line) => console.log('[watch] ' + line);
  const send = typeof d.send === 'function' ? d.send : () => {};
  const isBundledPage = typeof d.isBundledPage === 'function' ? d.isBundledPage : () => false;
  const openInEdge = typeof d.openInEdge === 'function' ? d.openInEdge : () => Promise.resolve({ ok: false, how: '', reason: 'Edge is not wired in this build' });
  const getWindow = typeof d.getWindow === 'function' ? d.getWindow : () => null;
  const setTimer = typeof d.setTimeout === 'function' ? d.setTimeout : setTimeout;
  const clearTimer = typeof d.clearTimeout === 'function' ? d.clearTimeout : clearTimeout;
  const freeGb = typeof d.freeGb === 'function' ? d.freeGb : () => os.freemem() / (1024 ** 3);
  const minFreeGb = Number.isFinite(test.minFreeGb) ? test.minFreeGb : MIN_FREE_GB;
  const rebaseMap = Array.isArray(test.rebase) ? test.rebase : [];
  const rebase = (url) => rebaseUrl(url, rebaseMap);
  const adapters = d.adapters || ADAPTERS;
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; } catch { return 'America/New_York'; } })();

  const userData = () => {
    if (d.dir) return d.dir;
    if (!electronApp || typeof electronApp.getPath !== 'function') return '';
    try { return electronApp.getPath('userData'); } catch { return ''; }
  };
  const fileIn = (name) => { const dir = userData(); return dir ? path.join(dir, name) : ''; };

  let prefs = null;
  let cache = null;
  let saveTimer = null;
  let timer = null;
  let timerAt = 0;
  let stopped = false;
  const guests = new Set();
  const queue = [];
  let reading = null;            // service id being read now
  let pumping = false;
  let currentView = null;        // the one reader window alive, if any
  let epoch = 0;                 // bumped by forget(): a read from before it is dropped
  const paused = {};             // id -> reason the last due read did not start
  const lastForced = {};
  let gameCache = { at: 0, name: '' };
  let searchNext = 0;
  const searchCache = new Map();

  /* --- files --------------------------------------------------------------------- */

  function loadPrefs() {
    if (prefs) return prefs;
    let raw = null;
    const file = fileIn(PREFS_FILE);
    if (file) { try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { raw = null; } }
    prefs = cleanPrefs(raw);
    return prefs;
  }

  function savePrefs() {
    const file = fileIn(PREFS_FILE);
    if (!file) return false;
    try {
      fs.writeFileSync(file, JSON.stringify(prefs, null, 2), { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch (err) {
      log('Watch settings could not be saved: ' + ((err && err.code) || 'unknown'));
      return false;
    }
  }

  function loadCache() {
    if (cache) return cache;
    let raw = null;
    const file = fileIn(CACHE_FILE);
    if (file) {
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
        if (err && err.code !== 'ENOENT') log('Watch cache was unreadable and starts empty: ' + ((err && err.code) || 'bad JSON'));
      }
    }
    cache = cleanCache(raw);
    return cache;
  }

  function saveCacheNow() {
    if (saveTimer) { clearTimer(saveTimer); saveTimer = null; }
    const file = fileIn(CACHE_FILE);
    if (!file || !cache) return false;
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      log('Watch cache could not be saved: ' + ((err && err.code) || 'unknown'));
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to tidy */ }
      return false;
    }
  }

  function saveCacheSoon() {
    if (saveTimer) return;
    saveTimer = setTimer(() => { saveTimer = null; saveCacheNow(); }, SAVE_DEBOUNCE_MS);
    if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  /* --- gates ----------------------------------------------------------------------- */

  function everyMs(id) {
    const svc = Shape.serviceById(id);
    if (!svc) return 60 * 60e3;
    if (id === 'espn' && svc.liveEveryMin) {
      const ev = loadCache().services.espn.events;
      if (Merge.sportsHot(ev, now())) return svc.liveEveryMin * 60e3;
    }
    return svc.everyMin * 60e3;
  }

  function windowShowing() {
    if (typeof test.windowShowing === 'function') return !!test.windowShowing();
    const w = getWindow();
    if (!w || (typeof w.isDestroyed === 'function' && w.isDestroyed())) return false;
    try { return w.isVisible() && !w.isMinimized(); } catch { return false; }
  }

  /**
   * The running game, or ''. Synchronous and free: it answers from the last look, which
   * checkGame() refreshes (one async tasklist a minute at most, only when a read is due).
   * Never a sync child process on the main thread: that would stall every tab.
   */
  function gameRunning() {
    if (typeof test.gameRunning === 'function') return test.gameRunning() || '';
    return gameCache.name;
  }

  function checkGame() {
    if (typeof test.gameRunning === 'function' || process.platform !== 'win32') return Promise.resolve(gameRunning());
    if (now() - gameCache.at < GAME_CHECK_TTL_MS) return Promise.resolve(gameCache.name);
    return new Promise((resolve) => {
      cp.execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 4000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        let name = '';
        if (!err && typeof out === 'string') {
          const lower = out.toLowerCase();
          for (const g of GAME_PROCESSES) if (lower.indexOf('"' + g + '"') !== -1) { name = g.replace(/\.exe$/, '').replace(/-win64-shipping$/, ''); break; }
        }
        // No answer is not a reason to stop reading; it counts as "no game" for a minute.
        gameCache = { at: now(), name };
        resolve(name);
      });
    });
  }

  function usesView(id) {
    const a = adapters[id];
    if (!a || typeof a.steps !== 'function') return false;
    try { return a.steps(ctx()).some((s) => s && s.type === 'view'); } catch { return false; }
  }

  /** Why a due read must not start now ('' = it may), for the page to show. */
  function blocker(id, forced) {
    const s = loadCache().services[id];
    const game = gameRunning();
    if (game) return 'paused while ' + (game === 'valorant' ? 'VALORANT' : game) + ' is running';
    if (usesView(id)) {
      const free = freeGb();
      if (free < minFreeGb) return 'paused: only ' + free.toFixed(1) + ' GB of memory free (Watch reads with at least ' + minFreeGb + ' GB)';
    }
    if (!forced && !windowShowing()) {
      const stale = !s.lastOkAt || now() - s.lastOkAt > STALE_FACTOR * everyMs(id);
      if (!stale) return 'waiting until Quartz is back on screen';
    }
    return '';
  }

  function ctx() {
    return { now: now(), tz, leagues: loadPrefs().leagues.slice() };
  }

  /* --- one read ------------------------------------------------------------------- */

  function blankStep(step, url) {
    return { ok: false, url, finalUrl: '', title: '', status: 0, extracted: null, json: null, text: null, captures: [], error: null, name: step.name };
  }

  function getFetch() {
    if (typeof d.fetch === 'function') return d.fetch;
    if (d.session && d.session.defaultSession && typeof d.session.defaultSession.fetch === 'function') {
      return (u, o) => d.session.defaultSession.fetch(u, o);
    }
    return typeof fetch === 'function' ? fetch : null;
  }

  /**
   * For watch/tmdb.js: one JSON GET -> { status, json, error }. Never rejects. The
   * key travels only in the URL or header TMDB asks for, and is never logged.
   */
  async function fetchJson(url, headers) {
    const f = getFetch();
    const target = rebase(String(url || ''));
    if (!f) return { status: 0, json: null, error: { code: 'load-failed', detail: 'this build cannot fetch' } };
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = setTimer(() => { try { if (ctrl) ctrl.abort(); } catch { /* gone */ } }, 10000);
    try {
      const res = await f(target, { signal: ctrl ? ctrl.signal : undefined, headers: Object.assign({ accept: 'application/json' }, headers || {}) });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { json = null; }
      return { status: res.status || 0, json, error: null };
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
      return { status: 0, json: null, error: aborted ? { code: 'timeout', detail: 'TMDB did not answer within 10 s' } : classifyNetError(err, 'TMDB') };
    } finally {
      clearTimer(t);
    }
  }

  async function runFetchStep(step) {
    const url = rebase(String(step.url || ''));
    const out = blankStep(step, url);
    const fetchImpl = getFetch();
    if (!fetchImpl) { out.error = { code: 'load-failed', detail: 'this build cannot fetch' }; return out; }
    const budget = Number.isFinite(step.budgetMs) ? step.budgetMs : STEP_BUDGET_MS;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = setTimer(() => { try { if (ctrl) ctrl.abort(); } catch { /* gone */ } }, budget);
    try {
      const res = await fetchImpl(url, { signal: ctrl ? ctrl.signal : undefined, headers: { accept: step.as === 'text' ? 'text/html,*/*' : 'application/json' } });
      out.status = res.status || 0;
      out.finalUrl = res.url || url;
      if (!res.ok) {
        out.error = { code: 'http', detail: hostOf(url) + ' answered HTTP ' + res.status };
        return out;
      }
      let text = await res.text();
      if (text.length > MAX_FETCH_CHARS) text = text.slice(0, MAX_FETCH_CHARS);
      if (step.as === 'text') { out.text = text; out.ok = true; return out; }
      try { out.json = JSON.parse(text); out.ok = true; } catch {
        out.error = { code: 'bad-json', detail: hostOf(url) + ' answered something that is not JSON' };
      }
      return out;
    } catch (err) {
      const aborted = (err && (err.name === 'AbortError' || /abort/i.test(String(err.message || ''))));
      out.error = aborted ? { code: 'timeout', detail: 'timed out after ' + Math.round(budget / 1000) + ' s' } : classifyNetError(err, hostOf(url));
      return out;
    } finally {
      clearTimer(t);
    }
  }

  function sleep(ms) { return new Promise((r) => { const h = setTimer(r, ms); if (h && h.unref) h.unref(); }); }

  async function runViewStep(step) {
    const url = rebase(String(step.url || ''));
    const out = blankStep(step, url);
    const BW = d.BrowserWindow;
    const ses = d.session && d.session.defaultSession;
    if (!BW || !ses) { out.error = { code: 'load-failed', detail: 'this build cannot open a reader' }; return out; }
    const budget = Number.isFinite(step.budgetMs) ? step.budgetMs : STEP_BUDGET_MS;
    const deadline = now() + budget;
    const patterns = Array.isArray(step.capture) ? step.capture.filter((r) => r instanceof RegExp) : [];
    const pending = new Map();
    const bodyJobs = [];
    let captureBytes = 0;
    let crashed = '';
    let loadErr = null;
    let loaded = false;
    let w = null;
    let dbg = null;
    try {
      w = new BW({
        show: false, width: 1280, height: 900, x: -32000, y: -32000, skipTaskbar: true, focusable: false, frame: false,
        paintWhenInitiallyHidden: true,
        webPreferences: {
          session: ses, offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true,
          nodeIntegration: false, images: false, spellcheck: false, autoplayPolicy: 'user-gesture-required',
        },
      });
      currentView = w;
      const wc = w.webContents;
      try { wc.setAudioMuted(true); } catch { /* fine */ }
      try { wc.setFrameRate(1); } catch { /* not offscreen */ }
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', (e, to) => { if (!/^https?:/i.test(String(to))) e.preventDefault(); });
      wc.on('render-process-gone', (_e, details) => { crashed = (details && details.reason) || 'gone'; });
      wc.on('did-navigate', (_e, to, code) => { out.finalUrl = String(to || ''); if (code) out.status = code; });
      wc.on('did-fail-load', (_e, code, desc, failedUrl, isMain) => {
        if (isMain && code !== -3) loadErr = { errno: code, code: desc, message: desc };
      });
      if (patterns.length) {
        dbg = wc.debugger;
        dbg.attach('1.3');
        dbg.on('message', (_e, method, params) => {
          if (method === 'Network.responseReceived') {
            const r = params && params.response;
            if (!r || !patterns.some((re) => { re.lastIndex = 0; return re.test(String(r.url)); })) return;
            pending.set(params.requestId, { url: String(r.url), status: r.status || 0 });
          } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
            const hit = pending.get(params.requestId);
            if (!hit) return;
            pending.delete(params.requestId);
            if (method === 'Network.loadingFailed' || out.captures.length + bodyJobs.length >= MAX_CAPTURES) return;
            bodyJobs.push(dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then((b) => {
              let body = String((b && b.body) || '');
              if (b && b.base64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
              if (!body || captureBytes + body.length > MAX_CAPTURE_BYTES) return;
              captureBytes += body.length;
              try { out.captures.push({ url: hit.url, status: hit.status, json: JSON.parse(body) }); } catch { /* not JSON: not ours */ }
            }, () => { /* evicted or gone */ }));
          }
        });
        // Sent, NOT awaited: on a page that has never navigated, Electron 44 does not answer
        // Network.enable until the first load starts (watch-e2e found the read hanging here
        // forever). The command is queued ahead of the load, so capture still sees every response.
        const enabled = dbg.sendCommand('Network.enable', { maxTotalBufferSize: 40 * 1024 * 1024, maxResourceBufferSize: 12 * 1024 * 1024 });
        if (enabled && typeof enabled.catch === 'function') enabled.catch(() => { /* reported by the capture count */ });
      }
      const loadP = wc.loadURL(url).then(() => { loaded = true; }, (err) => {
        if (err && (err.errno === -3 || /ERR_ABORTED/.test(String(err.code || err.message)))) { loaded = true; return; }
        loadErr = err;
      });
      // The load itself, inside the budget.
      while (!loaded && !loadErr && !crashed && now() < deadline) {
        await Promise.race([loadP, sleep(POLL_MS)]);
      }
      if (loadErr && !loaded) {
        out.error = classifyNetError(loadErr, hostOf(url));
      } else if (crashed) {
        out.error = { code: 'crashed', detail: 'the reader page crashed (' + crashed + ')' };
      } else {
        const settleUntil = Math.min(deadline, now() + (Number.isFinite(step.settleMs) ? step.settleMs : DEFAULT_SETTLE_MS));
        const ready = typeof step.ready === 'function' ? step.ready : (v) => v !== null && v !== undefined;
        let scrolled = 0;
        let isReady = !step.extract;
        let enough = !patterns.length;
        while (now() < deadline && !crashed) {
          if (step.extract) {
            out.extracted = await extractFrom(wc, step.extract, Math.min(5000, Math.max(0, deadline - now())));
            try { isReady = !!ready(out.extracted); } catch { isReady = false; }
          }
          if (patterns.length) {
            let early = false;
            try { early = typeof step.enough === 'function' && !!step.enough(out.captures); } catch { early = false; }
            enough = early || now() >= settleUntil;
          }
          if (isReady && enough) break;
          if (step.scroll && scrolled < step.scroll) {
            scrolled++;
            try { await within(wc.executeJavaScript('window.scrollBy(0, Math.round(window.innerHeight * 0.9)), 1', true), Math.min(2000, Math.max(0, deadline - now()))); } catch { /* gone */ }
          }
          await sleep(POLL_MS);
        }
        if (bodyJobs.length) await Promise.race([Promise.all(bodyJobs), sleep(1500)]);
        if (crashed) out.error = { code: 'crashed', detail: 'the reader page crashed (' + crashed + ')' };
        else if (!(isReady && (enough || out.captures.length))) {
          out.error = { code: 'timeout', detail: 'timed out after ' + Math.round(budget / 1000) + ' s' };
        }
        out.ok = !out.error;
      }
      try { out.finalUrl = wc.getURL() || out.finalUrl; out.title = wc.getTitle() || ''; } catch { /* gone */ }
    } catch (err) {
      out.error = out.error || { code: 'load-failed', detail: 'the reader could not start (' + String((err && err.message) || err).slice(0, 100) + ')' };
    } finally {
      try { if (dbg && dbg.isAttached()) dbg.detach(); } catch { /* gone */ }
      try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* gone */ }
      if (currentView === w) currentView = null;
    }
    return out;
  }

  /** p, or `fallback` once ms have passed: no await in a read may outlive its budget. */
  function within(p, ms, fallback) {
    let h = null;
    const cap = new Promise((r) => { h = setTimer(() => r(fallback === undefined ? null : fallback), ms); if (h && h.unref) h.unref(); });
    return Promise.race([Promise.resolve(p).finally(() => clearTimer(h)), cap]);
  }

  async function extractFrom(wc, expr, ms) {
    try {
      const v = await within(wc.executeJavaScript('(function(){try{return (' + expr + ');}catch(e){return null;}})()', true), ms || 5000);
      if (v === undefined) return null;
      // A page cannot hand back something absurd: past the cap it is dropped, not truncated.
      try { if (JSON.stringify(v).length > MAX_EXTRACT_CHARS) return null; } catch { return null; }
      return v;
    } catch { return null; }
  }

  async function runStep(step) {
    const budget = Number.isFinite(step.budgetMs) ? step.budgetMs : STEP_BUDGET_MS;
    const run = typeof d.runStep === 'function' ? d.runStep(step, rebase)
      : (step.type === 'fetch' ? runFetchStep(step) : runViewStep(step));
    // The watchdog: a step gets its budget plus WATCHDOG_GRACE_MS, then it is over, whatever
    // inside it is still waiting. Its window is destroyed so nothing leaks, and the queue moves.
    const late = Object.assign(blankStep(step, rebase(String(step.url || ''))), {
      error: { code: 'timeout', detail: 'timed out after ' + Math.round(budget / 1000) + ' s (the reader stopped answering)' },
    });
    const r = await within(run, budget + WATCHDOG_GRACE_MS, late);
    if (r === late) {
      log('Watch reader step ' + step.name + ' hit the watchdog after ' + Math.round((budget + WATCHDOG_GRACE_MS) / 1000) + ' s');
      try { if (currentView && !currentView.isDestroyed()) currentView.destroy(); } catch { /* gone */ }
      currentView = null;
    }
    return r;
  }

  async function readService(id) {
    const a = adapters[id];
    const svc = Shape.serviceById(id);
    const s = loadCache().services[id];
    s.attemptAt = now();
    if (!a || typeof a.steps !== 'function' || typeof a.parse !== 'function') {
      s.state = 'error';
      s.reason = 'this build has no reader for ' + svc.name;
      s.readAt = now();
      return;
    }
    const c = ctx();
    let steps = [];
    try { steps = (a.steps(c) || []).filter((x) => x && typeof x.name === 'string'); } catch (err) { steps = []; }
    const read = { now: c.now, steps: {} };
    let captured = 0;
    for (const step of steps) {
      if (stopped) return;
      // A required step that failed makes the rest pointless only when the service is gone
      // entirely (offline): the adapter still gets what was read, to say so in its words.
      let r;
      try { r = await runStep(step); } catch (err) { r = Object.assign(blankStep(step, step.url), { error: { code: 'load-failed', detail: String((err && err.message) || err).slice(0, 120) } }); }
      read.steps[step.name] = r;
      captured += Array.isArray(r.captures) ? r.captures.length : 0;
      if (r.error && r.error.code === 'offline' && !step.optional) break;
    }
    let result;
    try { result = Shape.cleanResult(a.parse(read, c)); } catch (err) {
      result = Shape.cleanResult({ state: 'error', reason: 'its reader failed (' + String((err && err.message) || err).slice(0, 100) + ')' });
    }
    s.readAt = now();
    s.captured = captured;
    s.state = result.state;
    s.reason = result.reason;
    s.warnings = result.state === 'ok' ? result.warnings : [];
    if (s.warnings.length) log('Watch read ' + svc.name + ' with warnings: ' + s.warnings.join('; '));
    if (result.state === 'ok') {
      s.items = result.items.filter((it) => it.service === id).slice(0, ITEMS_PER_SERVICE);
      s.profile = result.profile || '';
      s.lastOkAt = s.readAt;
      if (id === 'espn') s.events = result.events || [];
    } else if (result.state === 'signed-out') {
      // Rows from an account that is no longer signed in are not shown as his.
      s.items = [];
      s.profile = '';
    }
    // An error keeps the last good rows: the page greys them with "as of".
    if (result.state !== 'ok') {
      const steps2 = Object.keys(read.steps).length;
      log('Watch could not read ' + svc.name + ': ' + (result.state === 'signed-out' ? 'signed out' : result.reason)
        + ' (' + steps2 + ' page' + (steps2 === 1 ? '' : 's') + ', ' + captured + ' response' + (captured === 1 ? '' : 's') + ' captured)');
    }
    saveCacheSoon();
  }

  /* --- the queue -------------------------------------------------------------------- */

  function enqueue(id, forced) {
    if (stopped || !loadPrefs().enabled[id]) return false;
    if (reading === id || queue.indexOf(id) !== -1) return false;
    const why = blocker(id, forced);
    if (why) { paused[id] = why; pushAll(); return false; }
    delete paused[id];
    queue.push(id);
    pump();
    return true;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && !stopped) {
        const id = queue.shift();
        const gen = epoch;
        // Conditions can change while earlier services read (a game starts): look again.
        await checkGame();
        if (gen !== epoch) continue;   // forgotten while it waited
        const why = blocker(id, true);
        if (why && why.indexOf('waiting') !== 0) { paused[id] = why; pushAll(); continue; }
        reading = id;
        pushAll();
        try { await readService(id); } catch (err) { log('Watch reader error: ' + ((err && err.message) || err)); }
        reading = null;
        pushAll();
      }
    } finally {
      pumping = false;
      reading = null;
      schedule();
    }
  }

  function dueIds() {
    const p = loadPrefs();
    const c = loadCache();
    const t = now();
    return Shape.SERVICE_IDS.filter((id) => p.enabled[id] && t - (c.services[id].attemptAt || 0) >= everyMs(id));
  }

  function schedule() {
    if (timer) { clearTimer(timer); timer = null; timerAt = 0; }
    if (stopped || !guests.size) return;
    const p = loadPrefs();
    const c = loadCache();
    let soonest = Infinity;
    for (const id of Shape.SERVICE_IDS) {
      if (!p.enabled[id]) continue;
      soonest = Math.min(soonest, (c.services[id].attemptAt || 0) + everyMs(id));
    }
    if (soonest === Infinity) return;
    let delay = Math.max(TIMER_MIN_MS, Math.min(TIMER_MAX_MS, soonest - now()));
    if (!windowShowing()) delay = Math.max(delay, HIDDEN_RECHECK_MS);
    timerAt = now() + delay;
    timer = setTimer(tick, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function tick() {
    timer = null;
    timerAt = 0;
    if (stopped || !guests.size) return;
    const due = dueIds();
    if (!due.length) { schedule(); return; }
    checkGame().then(() => {
      for (const id of due) enqueue(id, false);
      if (!pumping) schedule();
    });
  }

  /* --- the page ---------------------------------------------------------------------- */

  function serviceView(id) {
    const svc = Shape.serviceById(id);
    const s = loadCache().services[id];
    const p = loadPrefs();
    const counts = { resume: 0, rec: 0, watchlist: 0, live: 0, upcoming: 0 };
    for (const it of s.items) if (counts[it.kind] !== undefined) counts[it.kind]++;
    return {
      id, name: svc.name, short: svc.short, covers: svc.covers, edge: svc.edge, needsSignIn: svc.needsSignIn,
      enabled: !!p.enabled[id],
      state: p.enabled[id] ? s.state : 'off',
      reason: s.reason,
      warnings: s.warnings || [],
      readAt: s.readAt, lastOkAt: s.lastOkAt, profile: s.profile,
      reading: reading === id, queued: queue.indexOf(id) !== -1,
      paused: p.enabled[id] ? (paused[id] || '') : '',
      next: p.enabled[id] ? (s.attemptAt || 0) + everyMs(id) : 0,
      counts,
      home: svc.home, signIn: svc.signIn,
      hasReader: !!(adapters[id] && typeof adapters[id].parse === 'function'),
    };
  }

  function snapshot() {
    const c = loadCache();
    const p = loadPrefs();
    const services = {};
    for (const id of Shape.SERVICE_IDS) services[id] = { enabled: p.enabled[id], items: c.services[id].items, state: c.services[id].state };
    const events = p.enabled.espn ? (c.services.espn.events || []) : [];
    const items = [];
    for (const id of Shape.SERVICE_IDS) if (p.enabled[id]) for (const it of c.services[id].items) items.push(it);
    return {
      v: 1,
      now: now(),
      services: Shape.SERVICE_IDS.map(serviceView),
      rows: Merge.buildRows(services),
      sports: Merge.buildSports(events, now(), p.leagues),
      leagues: p.leagues.slice(),
      items,
      tmdb: { hasKey: !!p.tmdbKey },
      reading,
    };
  }

  function isWatchPage(url) {
    if (!isBundledPage(url)) return false;
    try { return path.basename(new URL(url).pathname).toLowerCase() === PAGE_FILE; } catch { return false; }
  }

  function pushTo(contents, fn, payload) {
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) { guests.delete(contents); return; }
    let url = '';
    try { url = contents.getURL(); } catch { guests.delete(contents); return; }
    if (!isWatchPage(url)) { guests.delete(contents); return; }
    let json;
    try { json = JSON.stringify(payload); } catch { return; }
    try {
      const pr = contents.executeJavaScript('window.' + fn + ' && window.' + fn + '(' + json + ')');
      if (pr && typeof pr.catch === 'function') pr.catch(() => { /* the page went away */ });
    } catch { /* destroyed mid-call */ }
  }

  let pushQueued = false;
  function pushAll() {
    if (!guests.size || pushQueued) return;
    // Several state changes in one turn become one push.
    pushQueued = true;
    Promise.resolve().then(() => {
      pushQueued = false;
      if (!guests.size) { schedule(); return; }
      const snap = snapshot();
      for (const g of Array.from(guests)) pushTo(g, '__applyWatch', snap);
      if (!guests.size) schedule();
    });
  }

  function hello(contents) {
    guests.add(contents);
    // Cache first: the page draws what it had before anything is read.
    pushTo(contents, '__applyWatch', snapshot());
    const due = dueIds();
    if (!due.length) { schedule(); return; }
    checkGame().then(() => {
      for (const id of due) enqueue(id, false);
      schedule();
    });
  }

  function refresh(service) {
    const ids = service ? [service] : Shape.SERVICE_IDS.filter((id) => loadPrefs().enabled[id]);
    const t = now();
    let started = 0;
    for (const id of ids) {
      if (lastForced[id] && t - lastForced[id] < FORCE_GAP_MS && reading !== id) continue;
      lastForced[id] = t;
      if (enqueue(id, true)) started++;
    }
    pushAll();
    return started;
  }

  async function openTitle(url) {
    const clean = Shape.cleanHttps(url);
    if (!clean || (!Shape.serviceForUrl(clean) && !isTmdbPage(clean))) return { ok: false, how: '', reason: 'Watch only opens pages on the services it reads' };
    if (test.openStub) {
      try { fs.appendFileSync(test.openStub, JSON.stringify({ url: clean, edge: Shape.opensInEdge(clean) }) + '\n'); } catch { /* the e2e will see it missing */ }
    }
    if (Shape.opensInEdge(clean)) {
      let r;
      try { r = await openInEdge(clean); } catch (err) { r = { ok: false, how: '', reason: String((err && err.message) || err) }; }
      return { ok: !!(r && r.ok), how: 'edge', reason: (r && r.reason) || '' };
    }
    send('open-url', { url: rebase(clean), background: false });
    return { ok: true, how: 'tab', reason: '' };
  }

  function signIn(service) {
    const svc = Shape.serviceById(service);
    if (!svc) return { ok: false, how: '', reason: 'unknown service' };
    send('open-url', { url: rebase(svc.signIn), background: false });
    return { ok: true, how: 'tab', reason: '' };
  }

  function forget() {
    epoch++;
    cache = cleanCache(null);
    // A read in flight writes into the old cache object, so its rows are dropped; a queued
    // one is cancelled; and nothing reads again until its normal floor (or a Retry), so
    // "Forget" leaves the page empty instead of refilling it a second later.
    queue.length = 0;
    for (const id of Shape.SERVICE_IDS) cache.services[id].attemptAt = now();
    const file = fileIn(CACHE_FILE);
    let ok = true;
    let freed = 0;
    if (file) { try { freed = fs.statSync(file).size; } catch { freed = 0; } }
    if (file) { try { fs.rmSync(file, { force: true }); } catch (err) { ok = false; log('Watch cache could not be deleted: ' + ((err && err.code) || 'unknown')); } }
    if (saveTimer) { clearTimer(saveTimer); saveTimer = null; }
    pushAll();
    return { ok, freed: ok ? freed : 0, reason: ok ? '' : 'the cache file could not be deleted' };
  }

  /* --- search ------------------------------------------------------------------------- */

  async function search(q, seq) {
    const p = loadPrefs();
    const links = Merge.searchLinks(q);
    // TMDB runs beside YouTube, not after it: two independent answers, one push.
    const tmdbP = searchTmdb(q, p.tmdbKey);
    const base = { seq, q, links, tmdb: null };
    const yt = await searchYouTube(q, p);
    base.tmdb = await tmdbP;
    return Object.assign(base, { youtube: yt });
  }

  async function searchTmdb(q, key) {
    if (!key) return { state: 'no-key', reason: 'Add a free TMDB key in Settings to search every service', results: [] };
    if (!Tmdb || typeof Tmdb.search !== 'function') return { state: 'error', reason: 'this build has no TMDB search', results: [] };
    const ck = 'tmdb|' + q.toLowerCase();
    const hit = searchCache.get(ck);
    if (hit && now() - hit.at < SEARCH_TTL_MS) return hit.answer;
    let answer;
    try { answer = await Tmdb.search(q, key, fetchJson, { region: 'US' }); } catch (err) {
      answer = { state: 'error', reason: 'TMDB search failed (' + String((err && err.message) || err).slice(0, 100) + ')', results: [] };
    }
    if (!answer || typeof answer !== 'object') answer = { state: 'error', reason: 'TMDB search returned nothing', results: [] };
    if (answer.state === 'ok') {
      searchCache.set(ck, { at: now(), answer });
      while (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
    } else if (answer.state !== 'empty') {
      log('Watch search on TMDB failed: ' + (answer.state || 'error'));   // the state only: never the key, never the query
    }
    return answer;
  }

  async function searchYouTube(q, p) {
    if (!p.enabled.youtube) return { ok: false, state: 'off', reason: 'YouTube is turned off in Settings > Watch', items: [] };
    const yt = adapters.youtube;
    if (!yt || typeof yt.searchUrl !== 'function' || typeof yt.parseSearch !== 'function') {
      return { ok: false, state: 'error', reason: 'this build has no YouTube search', items: [] };
    }
    const key = 'yt|' + q.toLowerCase();
    const hit = searchCache.get(key);
    if (hit && now() - hit.at < SEARCH_TTL_MS) return hit.answer;
    const wait = searchNext - now();
    searchNext = Math.max(now(), searchNext) + SEARCH_GAP_MS;
    if (wait > 0) await sleep(wait);
    const r = await runStep({ name: 'search', type: 'fetch', as: 'text', url: yt.searchUrl(q), budgetMs: 10000 });
    let answer;
    if (r.error) answer = { ok: false, state: 'error', reason: r.error.detail, items: [] };
    else {
      let items = [];
      try { items = Shape.cleanItems(yt.parseSearch(r.text || ''), 20); } catch { items = []; }
      answer = items.length ? { ok: true, state: 'ok', reason: '', items }
        : { ok: false, state: 'error', reason: "YouTube's results page had nothing Watch could read (YouTube changed its layout?)", items: [] };
    }
    if (answer.ok) {
      searchCache.set(key, { at: now(), answer });
      while (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
    } else {
      log('Watch search on YouTube failed: ' + answer.reason);
    }
    return answer;
  }

  /* --- guests -------------------------------------------------------------------------- */

  function messageOf(first, args) {
    if (first && typeof first === 'object' && typeof first.message === 'string') return first.message;
    if (typeof args[2] === 'string') return args[2];
    if (typeof args[1] === 'string') return args[1];
    return '';
  }

  /** One console line from one guest. True when it was a Watch request from our page. */
  function handleGuestLine(contents, line) {
    let url = '';
    try { url = contents.getURL(); } catch { return false; }
    if (!isWatchPage(url)) return false;
    const req = parseGuestLine(line);
    if (!req) return false;
    switch (req.verb) {
      case 'hello': hello(contents); break;
      case 'refresh': guests.add(contents); refresh(req.service); break;
      case 'open':
        openTitle(req.url).then((r) => pushTo(contents, '__applyWatchResult', Object.assign({ action: 'open', url: req.url }, r)));
        break;
      case 'signin': pushTo(contents, '__applyWatchResult', Object.assign({ action: 'signin', service: req.service }, signIn(req.service))); break;
      case 'search':
        search(req.q, req.seq).then((a) => pushTo(contents, '__applyWatchSearch', a),
          (err) => pushTo(contents, '__applyWatchSearch', { seq: req.seq, q: req.q, links: Merge.searchLinks(req.q), youtube: { ok: false, state: 'error', reason: String((err && err.message) || err), items: [] }, tmdb: null }));
        break;
      case 'forget': pushTo(contents, '__applyWatchResult', Object.assign({ action: 'forget' }, forget())); break;
      case 'settings': break;   // app.js opens Settings > Watch; nothing for main to do
      default: return false;
    }
    return true;
  }

  function watchGuest(contents) {
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return;
    contents.on('console-message', function (details) {
      try { handleGuestLine(contents, messageOf(details, arguments)); } catch (err) {
        log('Watch guest line failed: ' + ((err && err.message) || 'error'));
      }
    });
    contents.on('destroyed', () => { if (guests.delete(contents)) schedule(); });
    contents.on('did-start-navigation', (_e, to, inPage, isMain) => {
      if (isMain && !inPage && !isWatchPage(String(to)) && guests.delete(contents)) schedule();
    });
  }

  /* --- Settings ------------------------------------------------------------------------- */

  function describe() {
    const p = loadPrefs();
    let cacheBytes = 0;
    const file = fileIn(CACHE_FILE);
    if (file) { try { cacheBytes = fs.statSync(file).size; } catch { cacheBytes = 0; } }
    return {
      services: Shape.SERVICE_IDS.map(serviceView),
      leagues: p.leagues.slice(),
      allLeagues: Shape.LEAGUES.map((l) => ({ id: l.id, name: l.name })),
      tmdb: { hasKey: !!p.tmdbKey, keyMask: maskKey(p.tmdbKey), signupUrl: 'https://www.themoviedb.org/settings/api' },
      cacheBytes,
      reading,
    };
  }

  function setEnabled(id, on) {
    if (Shape.SERVICE_IDS.indexOf(id) === -1) return Object.assign(describe(), { error: 'unknown service' });
    loadPrefs().enabled[id] = !!on;
    if (!on) { const i = queue.indexOf(id); if (i !== -1) queue.splice(i, 1); delete paused[id]; }
    savePrefs();
    if (on && guests.size) enqueue(id, true);
    pushAll();
    return describe();
  }

  function setLeagues(list) {
    const p = loadPrefs();
    const next = Array.isArray(list) ? list.filter((l) => !!Shape.leagueById(l)) : [];
    p.leagues = next.filter((l, i) => next.indexOf(l) === i);
    savePrefs();
    // New leagues are worth a read now, not in 15 minutes.
    if (guests.size && p.enabled.espn) { loadCache().services.espn.attemptAt = 0; enqueue('espn', true); }
    pushAll();
    return describe();
  }

  function setTmdbKey(raw) {
    const p = loadPrefs();
    const typed = String(raw == null ? '' : raw).trim();
    const next = cleanKey(raw);
    if (typed && !next) return Object.assign(describe(), { error: 'That does not look like a key: it has spaces or odd characters in it.' });
    p.tmdbKey = next;
    savePrefs();
    pushAll();
    return describe();
  }

  /** Settings' "Check key": one tiny TMDB request with the saved key -> describe() + { check }. */
  async function testTmdb() {
    const p = loadPrefs();
    if (!p.tmdbKey) return Object.assign(describe(), { check: { ok: false, title: 'No key saved', detail: 'Paste a key first.' } });
    if (!Tmdb || typeof Tmdb.check !== 'function') return Object.assign(describe(), { check: { ok: false, title: 'Not available', detail: 'This build has no TMDB support.' } });
    let check;
    try { check = await Tmdb.check(p.tmdbKey, fetchJson); } catch (err) {
      check = { ok: false, title: 'Check failed', detail: String((err && err.message) || err).slice(0, 120) };
    }
    return Object.assign(describe(), { check });
  }

  function registerIpc(ipc, isChromeSender) {
    if (!ipc || typeof ipc.handle !== 'function') return;
    const gate = typeof isChromeSender === 'function' ? isChromeSender : () => false;
    ipc.handle('watch:describe', (e) => (gate(e) ? describe() : null));
    ipc.handle('watch:set-enabled', (e, id, on) => (gate(e) ? setEnabled(String(id), !!on) : null));
    ipc.handle('watch:set-leagues', (e, list) => (gate(e) ? setLeagues(list) : null));
    ipc.handle('watch:set-tmdb-key', (e, k) => (gate(e) ? setTmdbKey(k) : null));
    ipc.handle('watch:forget', (e) => (gate(e) ? Object.assign(describe(), { forgot: forget() }) : null));
    ipc.handle('watch:test-tmdb', (e) => (gate(e) ? testTmdb() : null));
    ipc.handle('watch:refresh', (e, id) => (gate(e) ? Object.assign(describe(), { started: refresh(Shape.SERVICE_IDS.indexOf(id) !== -1 ? id : null) }) : null));
  }

  /** The Quartz window came back on screen: whatever fell due while it was away reads now. */
  function windowShown() {
    if (stopped || !guests.size) return;
    for (const id of dueIds()) enqueue(id, false);
    schedule();
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimer(timer); timer = null; }
    queue.length = 0;
    try { if (currentView && !currentView.isDestroyed()) currentView.destroy(); } catch { /* gone */ }
    currentView = null;
    if (saveTimer) saveCacheNow();
    guests.clear();
  }

  if (electronApp && typeof electronApp.on === 'function') {
    electronApp.on('web-contents-created', (_event, contents) => {
      try { if (contents && contents.getType() === 'webview') watchGuest(contents); } catch { /* died already */ }
    });
  }
  if (d.ipcMain) registerIpc(d.ipcMain, d.isChromeSender);

  return {
    handleGuestLine, watchGuest, registerIpc, snapshot, describe, refresh, enqueue, readService, search,
    openTitle, signIn, forget, setEnabled, setLeagues, setTmdbKey, windowShown, stop, schedule,
    flush: saveCacheNow,
    state: () => ({ guests: guests.size, queue: queue.slice(), reading, timerAt, paused: Object.assign({}, paused), viewAlive: !!currentView }),
  };
}

module.exports = {
  create,
  cleanPrefs,
  cleanCache,
  cleanKey,
  maskKey,
  parseGuestLine,
  classifyNetError,
  rebaseUrl,
  LINE_PREFIX,
  CACHE_FILE,
  PREFS_FILE,
  STEP_BUDGET_MS,
  MIN_FREE_GB,
  GAME_PROCESSES,
};
