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
 * that are due are read one by one and the page is patched after each.
 *   ON SCREEN (a Watch page open AND visible -- the page reports its visibilityState plus
 *   the chrome's "this tab is in front"):
 *     - the moment it comes on screen (hello, its tab brought forward, the window shown or
 *       focused again), every service last read over FRESH_ON_OPEN_MS (10 min) ago reads,
 *       one at a time, oldest first -- and a service whose title the user opened from Watch reads
 *       FIRST when they come back (its Continue watching moved), whatever its age;
 *     - then the one timer keeps each service to its floor: every 15 min (ESPN every 2 while
 *       one of his games is live).
 *   OFF SCREEN (no Watch page visible, or none open): the light background refresh, when
 *   Settings > Watch "Keep Watch up to date in the background" is on (off on a fresh install; see cleanPrefs): at most
 *   one read per BG_EVERY_MS (60 min) per service, one at a time and BG_GAP_MS apart, only for
 *   a service that has read fine before (a signed-out one would only say so again), never in
 *   the first BG_BOOT_DELAY_MS after create(), and only while Quartz is on screen (not
 *   minimised), no game runs, BG_MIN_FREE_GB (2.5 GB) of memory is free and Windows' battery
 *   saver is off. A blocked background read waits BG_PAUSE_MS and looks again; its reason
 *   is in Settings > Watch, never silent.
 * Every read: never in the first 10 s after create() (the boot grace: they wait, shown as
 * queued), never while a game is running or with under 1.5 GB of memory free (on screen,
 * those pauses are SHOWN on the page with their reason), never while the Quartz window is
 * hidden or minimised unless the cache is very stale, and never longer than its time limit
 * (readLimitMs: every step's budget + watchdog grace, plus 10 s) -- past it the read is
 * stopped and the service says so, with Retry. A Retry or Read now always reads.
 *
 * SEARCH is a cookie-less fetch (credentials 'omit') of YouTube's public results page, so
 * it never lands in the user's YouTube history; a newer search from the same page aborts the
 * one in flight. Only the home/feed VIEW reads use their signed-in session.
 *
 * THE PAGE (watch.html) asks over console lines, like search.html; only a guest whose URL
 * is OUR watch.html is heard, and every line is validated here:
 *   in    quartz-watch:hello    {"visible":true|false}         (no flag = visible; reads start only for a visible page)
 *         quartz-watch:visible  {"visible":true|false}         (on every visibilitychange)
 *         quartz-watch:refresh  {"service":"youtube"|null}     (null = every service)
 *         quartz-watch:open     {"url":"https://..."}           (a title: Quartz tab, or Edge for DRM)
 *         quartz-watch:signin   {"service":"disney"}            (the sign-in page, in a Quartz tab)
 *         quartz-watch:search   {"q":"bluey","seq":3}           (YouTube results + TMDB slot)
 *         quartz-watch:find     {"q":"bluey","seq":4}           (Enter: every service's own search, watch-find-main.js)
 *         quartz-watch:show     {"what":"show","service","id",..}   (a tile's show page: watch-shows-main.js)
 *         quartz-watch:preview  {"title":"Terminator 2","tv":false,"seq":4}  (the hover preview's TMDB trailer)
 *         quartz-watch:forget   {}                              (delete the cache)
 *         quartz-watch:settings {}                              (handled by app.js: Settings > Watch)
 *   out   window.__applyWatch(snapshot)       after hello, and after every change; when the
 *                                             snapshot itself fails: { v: 1, now, fatal: reason }
 *         window.__applyWatchSearch(answer)
 *         window.__applyWatchFind(part)          one per service as each answers (watch-find-main.js)
 *         window.__applyWatchShow(answer)        a show page's seasons and episodes (watch-shows-main.js)
 *         window.__applyWatchResult({ action, ok, reason, how })
 *         window.__applyWatchPreview({ seq, state, reason, videoId })
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
const Play = require('./watch/playurl');

const ADAPTERS = {};
for (const id of Shape.SERVICE_IDS) {
  try { ADAPTERS[id] = require('./watch/adapters/' + id); } catch (err) { ADAPTERS[id] = null; }
}

/* YouTube past the home row (watch/ytlib.js + watch/ytlib-main.js): Subscriptions, channels, the Library. */
let YtLib = null;
let YtLibMain = null;
try { YtLib = require('./watch/ytlib'); YtLibMain = require('./watch/ytlib-main'); } catch (err) { YtLib = null; YtLibMain = null; }

/* TMDB "where to watch" (watch/tmdb.js): only with a key the user pastes in Settings > Watch. */
let Tmdb = null;
try { Tmdb = require('./watch/tmdb'); } catch (err) { Tmdb = null; }
/* The hover preview's pure half (watch/preview.js): the embed Referer watch.json may set. */
let Preview = null;
try { Preview = require('./watch/preview'); } catch (err) { Preview = null; }
let TilePv = null;   // the hover previews inside tiles: the gate's words (watch-tilepreview.js)
try { TilePv = require('./watch-tilepreview'); } catch (err) { TilePv = null; }

/* Lumen's one search box, on Enter: every service's own search (watch-find-main.js). */
let FindMain = null;
try { FindMain = require('./watch-find-main'); } catch (err) { FindMain = null; }
/* Lumen's show pages: seasons, episodes, progress, Resume SxEy (watch-shows-main.js). */
let ShowsMain = null;
try { ShowsMain = require('./watch-shows-main'); } catch (err) { ShowsMain = null; }

const LINE_PREFIX = 'quartz-watch:';
const PAGE_FILE = 'watch.html';
const CACHE_FILE = 'watch-cache.json';
const PREFS_FILE = 'watch.json';
const PREFS_VERSION = 2;              // watch.json "v": 2 = written since Lumen became opt-in (cleanPrefs)
const CACHE_VERSION = 1;

const STEP_BUDGET_MS = 20000;
const WATCHDOG_GRACE_MS = 5000;     // a step that outlives its budget by this much is ended from outside
const READER_GONE_MS = 3000;        // the longest a reader waits for the last destroyed reader's page to go (readerGone)
const POLL_MS = 500;
const DEFAULT_SETTLE_MS = 2500;
// The view steps that read at dom-ready instead of the load (runViewStep's EARLY READ): YouTube's
// own pages, whose rows are server-rendered into the document (watch/adapters/youtube.js, watch/ytlib.js).
const EARLY_READ_URL = /^https:\/\/(www\.|m\.)?youtube\.com\//;
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
const PAUSE_BACKOFF_MS = 5 * 60 * 1000;  // a game / low-memory pause: the timer looks again in 5 min, not every 30 s
const BOOT_GRACE_MS = 10 * 1000;         // no reader starts in the first 10 s after create() (reads wait, queued)
// Fresh on open: a page coming on screen re-reads what is older than this. 10 min, not the
// 15-min floor: rows are never more than ~10 min old when he looks, while flipping between
// tabs (every flip is a "came on screen") does not launch a hidden page each time.
const FRESH_ON_OPEN_MS = 10 * 60 * 1000;
const WATCHED_AWAY_MS = 20 * 1000;       // a title opened from Watch: its service re-reads on return if he was away this long
const READ_LIMIT_SLACK_MS = 10 * 1000;   // a read's time limit: its steps' budgets + watchdog grace, plus this
// The background refresh (no Watch page on screen): see WHEN above.
const BG_EVERY_MS = 60 * 60 * 1000;
const BG_GAP_MS = 2 * 60 * 1000;         // two background reads never closer than this (no burst)
const BG_BOOT_DELAY_MS = 2 * 60 * 1000;  // nothing in the background while Quartz itself is starting
const BG_MIN_FREE_GB = 2.5;
const BG_PAUSE_MS = 10 * 60 * 1000;      // a blocked background read looks again in 10 min
const SEARCH_GAP_MS = 1200;
const SEARCH_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 20;
const QUERY_MAX = 200;
const TRAILER_TTL_MS = 24 * 60 * 60 * 1000;   // a title's trailer barely changes; a failure is not kept
const TRAILER_CACHE_MAX = 200;

/* Games whose process means "do not start a hidden page now" (VALORANT, for example). */
const GAME_PROCESSES = ['valorant-win64-shipping.exe', 'league of legends.exe', 'fortniteclient-win64-shipping.exe',
  'cs2.exe', 'rocketleague.exe', 'overwatch.exe', 'r5apex.exe', 'cod.exe'];

/* ------------------------------------------------------------------ pure helpers */

/*
 * Watch's own settings, checked: which services are on, which leagues, the TMDB key, the
 * background refresh, hover previews and the optional embed Referer (watch/preview.js).
 *
 * OPT-IN (watch.json "v": 2). Lumen reads signed-in pages of services that offer it no API,
 * so a fresh install reads NOTHING until the person turns a service on in Settings > Lumen:
 *   raw null (no watch.json)      a fresh install: every service off, background off;
 *   raw without "v"               a watch.json from before opt-in: everything absent reads ON,
 *                                 exactly as it always did (loadPrefs() then rewrites the file
 *                                 with those values made explicit, plus v: 2, once);
 *   raw with "v" >= 2             only an explicit true turns a service or the background on.
 * Hover previews stay on unless turned off in every case: they play only on tiles, and tiles
 * come only from a service the person turned on.
 */
function cleanPrefs(raw) {
  const fresh = !(raw && typeof raw === 'object');
  const r = fresh ? {} : raw;
  const legacy = !fresh && !(Number(r.v) >= PREFS_VERSION);
  const asked = r.enabled && typeof r.enabled === 'object' ? r.enabled : {};
  const enabled = {};
  for (const id of Shape.SERVICE_IDS) {
    enabled[id] = legacy ? asked[id] !== false : asked[id] === true;
  }
  let leagues = Array.isArray(r.leagues) ? r.leagues.filter((l) => !!Shape.leagueById(l)) : null;
  if (!leagues) leagues = Shape.DEFAULT_LEAGUES.slice();
  leagues = leagues.filter((l, i) => leagues.indexOf(l) === i);
  const tmdbKey = cleanKey(r.tmdbKey);
  // Keep Watch up to date in the background: a pre-opt-in file, on unless turned off; else only when turned on.
  const background = legacy ? r.background !== false : r.background === true;
  // Settings > Lumen "Preview videos when I hover": on unless turned off.
  const tilePreview = r.tilePreview !== false;
  const out = { v: PREFS_VERSION, enabled, leagues, tmdbKey, background, tilePreview };
  // The YouTube embed's Referer (watch/preview.js): kept only when watch.json names a valid one.
  const ref = Preview && typeof Preview.cleanReferer === 'function' ? Preview.cleanReferer(r.embedReferer) : '';
  if (ref) out.embedReferer = ref;
  return out;
}

/** A parsed watch.json written before opt-in (no "v": 2): what loadPrefs() migrates once. */
function isLegacyPrefs(raw) {
  return !!(raw && typeof raw === 'object') && !(Number(raw.v) >= PREFS_VERSION);
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
/** The opened tile, as "Up next" needs it: { id, service, title, subtitle } on the url's own service, or null. */
function cleanOpenItem(raw, service) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = Shape.cleanText(raw.id, 300);
  const title = Shape.cleanText(raw.title, 200);
  if (!service || !title || id.indexOf(service + ':') !== 0) return null;
  return { id, service, title, subtitle: Shape.cleanText(raw.subtitle, 200) };
}

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
    case 'hello':
      // An old page sends no flag: it counts as visible.
      return { verb, visible: msg.visible !== false };
    case 'visible':
      return typeof msg.visible === 'boolean' ? { verb, visible: msg.visible } : null;
    case 'forget': case 'settings':
      return { verb };
    case 'yt': {
      const req = YtLib ? YtLib.cleanLine(msg) : null;
      return req ? { verb, req } : null;
    }
    case 'show': {
      const req = ShowsMain ? ShowsMain.cleanLine(msg) : null;
      return req ? { verb, req } : null;
    }
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
      // title: the player layer's top bar; multi: "Add to multiview".
      const title = typeof msg.title === 'string' ? msg.title.replace(/[ -]+/g, ' ').trim().slice(0, 200) : '';
      // fallback: the title page when url goes straight to the player (watch/playurl.js), same service only;
      // item: what was opened, for "Up next" when it ends.
      const fb = Shape.cleanHttps(msg.fallback);
      const fallback = fb && fb !== url && Shape.serviceForUrl(fb) === Shape.serviceForUrl(url) ? fb : '';
      return { verb, url, title, multi: msg.multi === true, fallback, item: cleanOpenItem(msg.item, Shape.serviceForUrl(url)) };
    }
    case 'profile':
      return Shape.SERVICE_IDS.indexOf(msg.service) !== -1 && Play.profilePage(msg.service) ? { verb, service: msg.service } : null;
    case 'tilepv': {
      const seq = Number.isInteger(msg.seq) && msg.seq >= 0 ? msg.seq : 0;
      return { verb, seq };
    }
    case 'preview': {
      const title = typeof msg.title === 'string' ? msg.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, QUERY_MAX) : '';
      const seq = Number.isInteger(msg.seq) && msg.seq >= 0 ? msg.seq : 0;
      if (!title) return null;
      return { verb, title, tv: msg.tv === true, seq };
    }
    case 'find': {
      const q = typeof msg.q === 'string' ? msg.q.replace(/[ -]/g, ' ').trim().slice(0, QUERY_MAX) : '';
      const seq = Number.isInteger(msg.seq) && msg.seq >= 0 ? msg.seq : 0;
      if (!q) return null;
      const only = typeof msg.only === 'string' && Shape.SERVICE_IDS.indexOf(msg.only) !== -1 ? msg.only : '';
      return { verb, q, seq, only, force: msg.force === true };
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
    if (Shape.cleanHttps(s.avatar)) e.avatar = Shape.cleanHttps(s.avatar);
    if (s.picker === true && e.state === 'error') e.picker = true;
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
  // drm-main's route(url): { edge, rule, reason }. Without it, every protected title goes to Edge.
  const drmRoute = typeof d.drmRoute === 'function' ? d.drmRoute : () => ({ edge: true, rule: '', reason: 'Quartz can’t play protected video here' });
  const getWindow = typeof d.getWindow === 'function' ? d.getWindow : () => null;
  // The player layer (watch-player-main.js): with "Play inside Watch" on, a title plays in
  // Watch itself instead of a new tab. Without it (an older main), titles open in tabs.
  const player = d.player && typeof d.player.play === 'function' && typeof d.player.inside === 'function' ? d.player : null;
  // watch-leaks.js: each time Lumen has to send a page to a tab or Edge, one log line and the count.
  const leaks = d.leaks && typeof d.leaks.record === 'function' ? d.leaks : null;
  function leftLumen(kind, reason, url, line) {
    if (leaks) { try { leaks.record({ kind, reason, url, line }); return; } catch { /* the plain line */ } }
    log(line);
  }
  function whyTab() { return player ? 'Play inside Lumen is off' : 'no player layer'; }
  const setTimer = typeof d.setTimeout === 'function' ? d.setTimeout : setTimeout;
  const clearTimer = typeof d.clearTimeout === 'function' ? d.clearTimeout : clearTimeout;
  const freeGb = typeof d.freeGb === 'function' ? d.freeGb : () => os.freemem() / (1024 ** 3);
  const minFreeGb = Number.isFinite(test.minFreeGb) ? test.minFreeGb : MIN_FREE_GB;
  const bgMinFreeGb = Number.isFinite(test.bgMinFreeGb) ? test.bgMinFreeGb : BG_MIN_FREE_GB;
  const bgEveryMs = Number.isFinite(test.bgEveryMs) && test.bgEveryMs > 0 ? test.bgEveryMs : BG_EVERY_MS;
  const bgGapMs = Number.isFinite(test.bgGapMs) && test.bgGapMs >= 0 ? test.bgGapMs : BG_GAP_MS;
  const bgBootDelayMs = Number.isFinite(test.bgBootDelayMs) && test.bgBootDelayMs >= 0 ? test.bgBootDelayMs : BG_BOOT_DELAY_MS;
  const bgTimerMinMs = Number.isFinite(test.bgTimerMinMs) && test.bgTimerMinMs > 0 ? test.bgTimerMinMs : TIMER_MIN_MS;
  const bgPauseMs = Number.isFinite(test.bgPauseMs) && test.bgPauseMs > 0 ? test.bgPauseMs : BG_PAUSE_MS;
  const watchedAwayMs = Number.isFinite(test.watchedAwayMs) && test.watchedAwayMs >= 0 ? test.watchedAwayMs : WATCHED_AWAY_MS;
  // Battery saver on? true / false / null (cannot say: counts as off). powersaver.js is one kernel32 call.
  const saverOn = typeof test.saverOn === 'function' ? test.saverOn
    : (typeof d.saverOn === 'function' ? d.saverOn : (() => { try { return require('./powersaver').on(); } catch { return null; } }));
  const rebaseMap = Array.isArray(test.rebase) ? test.rebase : [];
  const rebase = (url) => rebaseUrl(url, rebaseMap);
  // The hover preview: 'live' in a live Quartz; main.js passes 'off' (or, with
  // QUARTZ_WATCH_PREVIEW_MOCK=1, 'mock') ONLY to a --test-profile instance. Off: the page is told so
  // and no trailer is ever looked up. Mock: the page's frame loads watch/preview.js MOCK_ORIGIN, and
  // a trailer is looked up only when TMDB is rebased to a local mock (never the real TMDB).
  const previewMode = test.preview === 'off' || test.preview === 'mock' ? test.preview : 'live';
  const adapters = d.adapters || ADAPTERS;
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; } catch { return 'America/New_York'; } })();

  const userData = () => {
    if (d.dir) return d.dir;
    if (!electronApp || typeof electronApp.getPath !== 'function') return '';
    try { return electronApp.getPath('userData'); } catch { return ''; }
  };
  const fileIn = (name) => { const dir = userData(); return dir ? path.join(dir, name) : ''; };

  let prefs = null;
  let prefsNote = '';                // watch.json could not be read: why, for Settings > Lumen ('' = fine)
  let cache = null;
  let saveTimer = null;
  let timer = null;
  let timerAt = 0;
  let stopped = false;
  const guests = new Set();
  const guestVisible = new Map(); // guest webContents -> its page's last visibilityState === 'visible'
  const queue = [];
  const forcedQueued = new Set(); // ids in the queue by a Retry or Read now: they read even out of sight
  let reading = null;            // service id being read now
  let starting = null;           // service id taken off the queue, waiting on checkGame() before it reads
  let pumping = false;
  const liveReaders = new Map(); // every hidden reader window alive now -> its step handle { win, killed }
  const readerContents = new Set(); // ...and their webContents (isReaderContents)
  // Readers Lumen has destroyed whose page is not gone yet: webContents -> when destroy() was called.
  // Electron deletes a window's page a moment AFTER destroy() returns ('destroyed' marks the end), and
  // a page closed mid-load (the dom-ready early read) takes longer to go. The next reader waits for
  // it (readerGone), so at most ONE reader page is ever alive.
  const readersGoing = new Map();
  let goneWaiters = [];          // resolvers waiting for readersGoing to empty
  let epoch = 0;                // bumped by forget(): a read from before it is dropped
  let forgottenAt = 0;           // when Forget last emptied the cache (memory only; the page says so until a read lands)
  const paused = {};             // id -> reason the last due read did not start
  const pausedUntil = {};        // id -> a game / memory pause: timed reads do not look again before this
  const lastForced = {};
  let gameCache = { at: 0, name: '' };
  let gameLooking = null;        // the one look (tasklist) on its way, shared by every caller
  let searchNext = 0;
  const searchCache = new Map();
  const trailerCache = new Map();   // 'tv|title' -> { at, answer }; hover previews, never written to disk
  const searchLive = new Map();  // guest -> its one search in flight { seq, ctrl, stale }
  const ytFlights = new Map();   // 'yt|query' -> the one YouTube results fetch for it in flight (ytFlight)
  let finder = null;            // watch-find-main.js: Enter's search on every service (made on first use)
  let shows = null;              // watch-shows-main.js: the show pages' reads (made on first use)
  // Boot grace: reads enqueued in the first bootGraceMs stay queued (the page says "Waiting to
  // read X") and the first reader starts at create() + bootGraceMs. The harness passes 0.
  const bootGraceMs = Number.isFinite(d.bootGraceMs) && d.bootGraceMs >= 0 ? d.bootGraceMs : BOOT_GRACE_MS;
  const bootUntil = now() + bootGraceMs;
  let bootTimer = null;
  let lastFatal = '';
  // Fresh after watching: service id -> when the user opened one of its titles from Watch.
  const watched = {};
  // The read in flight: when it started and its time limit (the page shows both).
  let readStartedAt = 0;
  let readLimit = 0;
  // The background refresh (no Watch page on screen).
  const createdAt = now();
  let bgTimer = null;
  let bgTimerAt = 0;
  const bgQueued = new Set();     // ids in the queue by the background refresh
  let bgLastAt = 0;               // the last background read's start
  let bgWaiting = '';             // why the last due background read did not start ('' = it did)
  let bgPausedUntil = 0;
  let bgReads = 0;
  // Subscriptions, channels and the Library (watch/ytlib-main.js): its reads go through runStep and
  // take turns with the services' (pump() holds its lock around each service read).
  // Lumen Alerts (watch-alerts-main.js, set by main.js through setAlerts): rides on these reads only.
  let alerts = null;
  const ytlib = YtLibMain && d.ytlib !== false ? YtLibMain.create({
    wantSubs: () => { try { return !!(alerts && alerts.wantSubs()); } catch { return false; } },
    onSubs: (answer) => { if (alerts) alerts.onSubs(answer); },
    runStep: (step) => runStep(step), now, log, setTimeout: setTimer, clearTimeout: clearTimer,
    file: () => fileIn('watch-ytlib.json'),
    push: (contents, answer) => pushTo(contents, '__applyWatchYt', answer),
    bootLeft: () => bootUntil - now(),
    visible: () => anyVisible(),
    canRead: () => (!loadPrefs().enabled.youtube ? 'YouTube is off in Settings > Lumen' : blocker('youtube', true)),
  }) : null;

  /* --- files --------------------------------------------------------------------- */

  /*
   * watch.json, read once (see cleanPrefs for what each kind of file means):
   *   - no file: a fresh install, every service off; nothing is written until a setting changes;
   *   - a file from before opt-in (no "v"): read as it always was (absent = on) and rewritten
   *     ONCE with those values explicit plus v: 2; every other key (leagues, the TMDB key, any
   *     key this build does not know) is copied through untouched;
   *   - a file that exists but cannot be read or parsed: read as a pre-opt-in file (absent = on,
   *     what Lumen always did), NOT rewritten, and Settings > Lumen says so (prefsNote).
   */
  function loadPrefs() {
    if (prefs) return prefs;
    let raw = null;
    let unreadable = '';
    const file = fileIn(PREFS_FILE);
    if (file) {
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!raw || typeof raw !== 'object') { raw = null; unreadable = 'it holds no settings'; }
      } catch (err) {
        raw = null;
        if (!err || err.code !== 'ENOENT') unreadable = err && err.code ? err.code : 'it is not valid JSON';
      }
    }
    if (unreadable) {
      prefsNote = 'watch.json could not be read (' + unreadable + '), so Lumen used its older defaults: every service on. ' +
        'Changing any Lumen setting writes a fresh file.';
      log('Lumen settings could not be read (' + unreadable + '): using the pre-opt-in defaults');
      raw = {};
    }
    prefs = cleanPrefs(raw);
    if (!unreadable && isLegacyPrefs(raw)) {
      // Made explicit + v: 2, so this install keeps reading what it read before opt-in existed.
      const enabled = Object.assign({}, prefs.enabled);
      if (writePrefsFile(Object.assign({ v: PREFS_VERSION }, raw, { v: PREFS_VERSION, enabled, background: prefs.background, tilePreview: prefs.tilePreview }))) {
        log('Lumen settings moved to opt-in (v' + PREFS_VERSION + '): every choice kept as it was');
      }
    }
    if (Preview && typeof Preview.setEmbedReferer === 'function') Preview.setEmbedReferer(prefs.embedReferer || '');
    return prefs;
  }

  /** Write watch.json whole (a temp file, then a rename: a crash mid-write never leaves half a file). */
  function writePrefsFile(obj) {
    const file = fileIn(PREFS_FILE);
    if (!file) return false;
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
      return true;
    } catch (err) {
      log('Lumen settings could not be saved: ' + ((err && err.code) || 'unknown'));
      return false;
    }
  }

  function savePrefs() {
    if (!writePrefsFile(prefs)) return false;
    prefsNote = '';
    return true;
  }

  function loadCache() {
    if (cache) return cache;
    let raw = null;
    const file = fileIn(CACHE_FILE);
    if (file) {
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
        if (err && err.code !== 'ENOENT') log('Lumen cache was unreadable and starts empty: ' + ((err && err.code) || 'bad JSON'));
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
      log('Lumen cache could not be saved: ' + ((err && err.code) || 'unknown'));
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

  /** True when checkGame() would look now (a tasklist), false when it answers from the last look. */
  function gameLookDue() {
    if (typeof test.gameRunning === 'function') return false;
    if (process.platform !== 'win32' && typeof test.gameLook !== 'function') return false;
    return now() - gameCache.at >= GAME_CHECK_TTL_MS;
  }

  function checkGame() {
    if (typeof test.gameRunning === 'function' || (process.platform !== 'win32' && typeof test.gameLook !== 'function')) return Promise.resolve(gameRunning());
    if (now() - gameCache.at < GAME_CHECK_TTL_MS) return Promise.resolve(gameCache.name);
    if (gameLooking) return gameLooking;
    // test.gameLook (the harness): an async stand-in for the tasklist, cached exactly like it.
    if (typeof test.gameLook === 'function') {
      gameLooking = Promise.resolve().then(() => test.gameLook()).then((n) => String(n || ''), () => '').then((name) => {
        gameCache = { at: now(), name };
        gameLooking = null;
        return name;
      });
      return gameLooking;
    }
    gameLooking = new Promise((resolve) => {
      cp.execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 4000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        let name = '';
        if (!err && typeof out === 'string') {
          const lower = out.toLowerCase();
          for (const g of GAME_PROCESSES) if (lower.indexOf('"' + g + '"') !== -1) { name = g.replace(/\.exe$/, '').replace(/-win64-shipping$/, ''); break; }
        }
        // No answer is not a reason to stop reading; it counts as "no game" for a minute.
        gameCache = { at: now(), name };
        gameLooking = null;
        resolve(name);
      });
    });
    return gameLooking;
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
      if (free < minFreeGb) return 'paused: only ' + free.toFixed(1) + ' GB of memory free (Lumen reads with at least ' + minFreeGb + ' GB)';
    }
    if (!forced && !windowShowing()) {
      const stale = !s.lastOkAt || now() - s.lastOkAt > STALE_FACTOR * everyMs(id);
      if (!stale) return 'waiting until Quartz is back on screen';
    }
    return '';
  }

  /**
   * Why a BACKGROUND read must not start now ('' = it may). Cheapest first; the game answer is
   * the last checkGame() (the caller refreshes it). Stricter than blocker(): 2.5 GB, the
   * window on screen whatever the cache's age, and battery saver.
   */
  function bgBlocker() {
    if (!loadPrefs().background) return 'turned off';
    if (!windowShowing()) return 'waiting while Quartz is minimised';
    let saver = null;
    try { saver = saverOn(); } catch { saver = null; }
    if (saver === true) return 'waiting while battery saver is on';
    const free = freeGb();
    if (free < bgMinFreeGb) return 'waiting: only ' + free.toFixed(1) + ' GB of memory free (it needs ' + bgMinFreeGb + ' GB)';
    const game = gameRunning();
    if (game) return 'waiting while ' + (game === 'valorant' ? 'VALORANT' : game) + ' is running';
    return '';
  }

  /** One read's time limit: every step's budget plus its watchdog grace, plus READ_LIMIT_SLACK_MS. */
  function readLimitMs(id) {
    if (Number.isFinite(test.readLimitMs) && test.readLimitMs > 0) return test.readLimitMs;
    const a = adapters[id];
    let steps = [];
    try { steps = a && typeof a.steps === 'function' ? (a.steps(ctx()) || []) : []; } catch { steps = []; }
    let ms = READ_LIMIT_SLACK_MS;
    for (const s of steps) ms += (s && Number.isFinite(s.budgetMs) ? s.budgetMs : STEP_BUDGET_MS) + WATCHDOG_GRACE_MS;
    return ms;
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
  async function fetchJson(url, headers, cancel) {
    const f = getFetch();
    const target = rebase(String(url || ''));
    if (!f) return { status: 0, json: null, error: { code: 'load-failed', detail: 'this build cannot fetch' } };
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = setTimer(() => { try { if (ctrl) ctrl.abort(); } catch { /* gone */ } }, 10000);
    const unlink = linkAbort(cancel, ctrl);
    try {
      // credentials 'omit': TMDB needs no cookie, and none of the user's goes with it.
      const res = await f(target, { signal: ctrl ? ctrl.signal : undefined, credentials: 'omit', headers: Object.assign({ accept: 'application/json' }, headers || {}) });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { json = null; }
      return { status: res.status || 0, json, error: null };
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
      return { status: 0, json: null, error: aborted ? { code: 'timeout', detail: 'TMDB did not answer within 10 s' } : classifyNetError(err, 'TMDB') };
    } finally {
      clearTimer(t);
      unlink();
    }
  }

  /** When `outer` (an AbortSignal, or nothing) aborts, so does `ctrl`. -> the unhook. */
  function linkAbort(outer, ctrl) {
    if (!outer || !ctrl || typeof outer.addEventListener !== 'function') return () => {};
    const onAbort = () => { try { ctrl.abort(); } catch { /* gone */ } };
    if (outer.aborted) { onAbort(); return () => {}; }
    outer.addEventListener('abort', onAbort, { once: true });
    return () => { try { outer.removeEventListener('abort', onAbort); } catch { /* gone */ } };
  }

  async function runFetchStep(step) {
    const url = rebase(String(step.url || ''));
    const out = blankStep(step, url);
    const fetchImpl = getFetch();
    if (!fetchImpl) { out.error = { code: 'load-failed', detail: 'this build cannot fetch' }; return out; }
    const budget = Number.isFinite(step.budgetMs) ? step.budgetMs : STEP_BUDGET_MS;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = setTimer(() => { try { if (ctrl) ctrl.abort(); } catch { /* gone */ } }, budget);
    const unlink = linkAbort(step.signal, ctrl);
    try {
      // Every fetch step is public (ESPN's JSON, YouTube's results page for search):
      // credentials 'omit', so no cookie of the user's is sent and a search never lands in their
      // YouTube history. The home/feed reads are VIEW steps and keep their cookies.
      const res = await fetchImpl(url, { signal: ctrl ? ctrl.signal : undefined, credentials: 'omit', headers: { accept: step.as === 'text' ? 'text/html,*/*' : 'application/json' } });
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
      if (aborted && step.signal && step.signal.aborted) out.error = { code: 'cancelled', detail: 'cancelled' };
      else out.error = aborted ? { code: 'timeout', detail: 'timed out after ' + Math.round(budget / 1000) + ' s' } : classifyNetError(err, hostOf(url));
      return out;
    } finally {
      clearTimer(t);
      unlink();
    }
  }

  function sleep(ms) { return new Promise((r) => { const h = setTimer(r, ms); if (h && h.unref) h.unref(); }); }

  /** A destroyed reader's page is gone ('destroyed'): forget it, and wake the reader waiting on it. */
  function readerPageGone(wc) {
    if (!readersGoing.delete(wc) || readersGoing.size) return;
    const ws = goneWaiters;
    goneWaiters = [];
    // 'destroyed' comes from inside the page's teardown: the next reader opens on the next turn of
    // the event loop, once that teardown has finished, not in the middle of it.
    const wake = () => { for (const r of ws) r(); };
    if (typeof setImmediate === 'function') setImmediate(wake); else wake();
  }

  /**
   * Before a reader opens: wait until every reader page Lumen destroyed is really gone, so two hidden
   * pages (two renderers, on a machine short of memory) never live at once. r64's early read ends a
   * YouTube step at dom-ready, mid-load, and such a page outlives its destroy() by a moment; the next
   * step's page used to open beside it. Waits at most READER_GONE_MS (and never past `deadline`); a
   * page that has still not gone by then is logged by name and no longer waited on, never silently.
   * Resolves to the ms waited.
   */
  async function readerGone(deadline) {
    if (!readersGoing.size) return 0;
    const t0 = now();
    const cap = Math.max(0, Math.min(READER_GONE_MS, deadline - t0));
    let h = null;
    await new Promise((r) => {
      goneWaiters.push(r);
      h = setTimer(r, cap);
      if (h && h.unref) h.unref();
    });
    clearTimer(h);
    if (readersGoing.size) {
      const stuck = Array.from(readersGoing.keys());
      readersGoing.clear();
      const ws = goneWaiters;
      goneWaiters = [];
      for (const r of ws) r();
      let url = '';
      try { url = hostOf(stuck[0].getURL()); } catch { url = ''; }
      log('Lumen reader: ' + stuck.length + ' closed reader page' + (stuck.length === 1 ? '' : 's') + (url ? ' (' + url + ')' : '')
        + ' still not gone after ' + Math.round(now() - t0) + ' ms; the next reader opens beside it');
    }
    return now() - t0;
  }

  /**
   * `handle` is this step's own record: runViewStep puts its window on it, and the watchdog
   * (or a cancel) destroys THAT window only -- never another step's reader -- and sets
   * handle.killed so every loop below ends at once.
   */
  async function runViewStep(step, handle) {
    const h0 = handle || { win: null, killed: '' };
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
    let captureBroken = '';      // why this view could not watch the page's own requests, or ''
    let loadErr = null;
    let loaded = false;
    let w = null;
    let dbg = null;
    // At most one reader page alive: the last destroyed one goes first (inside this step's budget).
    await readerGone(deadline);
    if (h0.killed) {
      out.error = { code: h0.killed === 'cancelled' ? 'cancelled' : 'timeout', detail: h0.killed === 'cancelled' ? 'cancelled' : 'the reader stopped answering' };
      return out;
    }
    try {
      w = new BW({
        show: false, width: 1280, height: 900, x: -32000, y: -32000, skipTaskbar: true, focusable: false, frame: false,
        paintWhenInitiallyHidden: true,
        webPreferences: {
          session: ses, offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true,
          nodeIntegration: false, images: false, spellcheck: false, autoplayPolicy: 'user-gesture-required',
        },
      });
      h0.win = w;
      liveReaders.set(w, h0);
      const wc = w.webContents;
      // Every reader's webContents is known (isReaderContents) from birth to death, so main.js
      // can deny its permission requests without a dialog the user never asked for.
      if (wc) {
        readerContents.add(wc);
        try { wc.once('destroyed', () => { readerContents.delete(wc); readerPageGone(wc); }); } catch { /* fine */ }
      }
      try { w.once('closed', () => { liveReaders.delete(w); readerContents.delete(wc); }); } catch { /* fine */ }
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
        // Electron 44 does not answer Network.enable on a window that has never navigated
        // (watch-e2e: the read hung forever), and sending it un-awaited raced the page's own
        // first fetches (watch-e2e: the FIRST Disney+ read captured 0 of 7 responses). So:
        // navigate to about:blank first, then enable and WAIT for the answer (bounded), and
        // only then load the service. Every response the page makes is seen.
        try { await within(wc.loadURL('about:blank'), Math.min(3000, Math.max(0, deadline - now())), null); } catch { /* the enable below says */ }
        const ENABLE_TIMEOUT = {};
        const enabled = await within(
          dbg.sendCommand('Network.enable', { maxTotalBufferSize: 40 * 1024 * 1024, maxResourceBufferSize: 12 * 1024 * 1024 }).then(() => true, () => false),
          Math.min(3000, Math.max(0, deadline - now())), ENABLE_TIMEOUT);
        if (enabled !== true) captureBroken = enabled === ENABLE_TIMEOUT ? 'DevTools did not answer' : 'DevTools refused';
      }
      // EARLY READ (r64). YouTube server-renders its rows into an inline <script> (ytInitialData,
      // ytcfg's LOGGED_IN): they are complete when the document is parsed (dom-ready), while the
      // load event waits on the rest of YouTube's app (its scripts, styles, fonts, frames) -- the part
      // Lumen throws away. So a YouTube step that has an extract and a ready() test reads at dom-ready
      // and every POLL_MS after, and ends the moment ready() says the tree is there; its window goes at
      // once (no YouTube app left running beside Lumen's own page). Not ready yet: it waits for the
      // load and reads exactly as before. wc.executeJavaScript would itself wait for the load
      // (Electron holds it until did-stop-loading), so the early read runs in wc.mainFrame.
      const earlyOk = !patterns.length && !!step.extract && typeof step.ready === 'function' && EARLY_READ_URL.test(String(step.url || ''))
        && !!wc.mainFrame && typeof wc.mainFrame.executeJavaScript === 'function';
      let domReady = false;
      let early = null;
      let onDom = null;
      const domP = earlyOk ? new Promise((r) => { onDom = () => { domReady = true; r(); }; try { wc.once('dom-ready', onDom); } catch { r(); } }) : null;
      const loadP = wc.loadURL(url).then(() => { loaded = true; }, (err) => {
        if (err && (err.errno === -3 || /ERR_ABORTED/.test(String(err.code || err.message)))) { loaded = true; return; }
        loadErr = err;
      });
      // The load itself, inside the budget (or, for an early read, until ready() says so).
      while (!loaded && !loadErr && !crashed && !h0.killed && now() < deadline) {
        await Promise.race(domP && !domReady ? [loadP, domP, sleep(POLL_MS)] : [loadP, sleep(POLL_MS)]);
        if (!domReady || loaded || loadErr || crashed || h0.killed) continue;
        const v = await extractFrom(wc, step.extract, Math.min(5000, Math.max(0, deadline - now())), true);
        let ok = false;
        try { ok = !!step.ready(v); } catch { ok = false; }
        if (ok) { early = v; break; }
      }
      if (onDom && !domReady) { try { wc.removeListener('dom-ready', onDom); } catch { /* fake or gone */ } }
      if (early && !h0.killed && !crashed) {
        out.extracted = early;
        out.early = true;
        out.ok = true;
      } else if (h0.killed) {
        out.error = { code: h0.killed === 'cancelled' ? 'cancelled' : 'timeout', detail: h0.killed === 'cancelled' ? 'cancelled' : 'the reader stopped answering' };
      } else if (loadErr && !loaded) {
        out.error = classifyNetError(loadErr, hostOf(url));
      } else if (crashed) {
        out.error = { code: 'crashed', detail: 'the reader page crashed (' + crashed + ')' };
      } else {
        const settleUntil = Math.min(deadline, now() + (Number.isFinite(step.settleMs) ? step.settleMs : DEFAULT_SETTLE_MS));
        const ready = typeof step.ready === 'function' ? step.ready : (v) => v !== null && v !== undefined;
        let scrolled = 0;
        let isReady = !step.extract;
        let enough = !patterns.length;
        while (now() < deadline && !crashed && !h0.killed) {
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
            // userGesture false: a gesture would give the hidden page sticky activation
            // (autoplaying trailers, fullscreen/clipboard, beforeunload prompts).
            try { await within(wc.executeJavaScript('window.scrollBy(0, Math.round(window.innerHeight * 0.9)), 1', false), Math.min(2000, Math.max(0, deadline - now()))); } catch { /* gone */ }
          }
          await sleep(POLL_MS);
        }
        if (bodyJobs.length && !h0.killed) await Promise.race([Promise.all(bodyJobs), sleep(1500)]);
        if (h0.killed) out.error = { code: h0.killed === 'cancelled' ? 'cancelled' : 'timeout', detail: h0.killed === 'cancelled' ? 'cancelled' : 'the reader stopped answering' };
        else if (crashed) out.error = { code: 'crashed', detail: 'the reader page crashed (' + crashed + ')' };
        else if (captureBroken && !out.captures.length) {
          // Not a layout change and not the service's fault: say what actually broke.
          out.error = { code: 'load-failed', detail: "the reader could not watch the page's data (" + captureBroken + ')' };
        } else if (!(isReady && (enough || out.captures.length))) {
          out.error = { code: 'timeout', detail: 'timed out after ' + Math.round(budget / 1000) + ' s' };
        }
        out.ok = !out.error;
      }
      try { out.finalUrl = wc.getURL() || out.finalUrl; out.title = wc.getTitle() || ''; } catch { /* gone */ }
    } catch (err) {
      out.error = out.error || { code: 'load-failed', detail: 'the reader could not start (' + String((err && err.message) || err).slice(0, 100) + ')' };
    } finally {
      try { if (dbg && dbg.isAttached()) dbg.detach(); } catch { /* gone */ }
      destroyReader(w);
    }
    return out;
  }

  /**
   * Destroy one reader window (and forget it and its webContents). Never throws. `why`
   * ('watchdog' | 'cancelled') ends the step that owns it at once; none = its own step ending.
   */
  function destroyReader(w, why) {
    if (!w) return;
    const h = liveReaders.get(w);
    if (why && h && !h.killed) h.killed = why;
    let wc = null;
    try { wc = w.webContents; } catch { wc = null; }
    // Its page goes a moment after destroy() (its 'destroyed', registered in runViewStep, ends
    // readersGoing's entry; a fake that says so at once never lands in it). The next reader waits.
    try { if (wc && readerContents.has(wc) && !wc.isDestroyed()) readersGoing.set(wc, now()); } catch { /* gone */ }
    try { if (!w.isDestroyed()) w.destroy(); } catch { /* gone */ }
    liveReaders.delete(w);
    if (wc) readerContents.delete(wc);
  }

  /** True only for the webContents of a hidden reader that is alive now (main.js: deny its permissions). */
  function isReaderContents(wc) {
    if (!wc || !readerContents.has(wc)) return false;
    try { if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) { readerContents.delete(wc); return false; } } catch { return false; }
    return true;
  }

  /** p, or `fallback` once ms have passed: no await in a read may outlive its budget. */
  function within(p, ms, fallback) {
    let h = null;
    const cap = new Promise((r) => { h = setTimer(() => r(fallback === undefined ? null : fallback), ms); if (h && h.unref) h.unref(); });
    return Promise.race([Promise.resolve(p).finally(() => clearTimer(h)), cap]);
  }

  async function extractFrom(wc, expr, ms, inFrame) {
    try {
      // userGesture false, as for the scroll: reading globals needs no activation. inFrame: the
      // early read, in the main frame now, without waiting for the page's load (runViewStep).
      const code = '(function(){try{return (' + expr + ');}catch(e){return null;}})()';
      const v = await within(inFrame ? wc.mainFrame.executeJavaScript(code, false) : wc.executeJavaScript(code, false), ms || 5000);
      if (v === undefined) return null;
      // A page cannot hand back something absurd: past the cap it is dropped, not truncated.
      try { if (JSON.stringify(v).length > MAX_EXTRACT_CHARS) return null; } catch { return null; }
      return v;
    } catch { return null; }
  }

  /**
   * One step, under its watchdog. `step.signal` (an AbortSignal, optional) cancels it: the
   * fetch is aborted / this step's own window destroyed, and the answer is { code:'cancelled' }.
   */
  async function runStep(step) {
    const budget = Number.isFinite(step.budgetMs) ? step.budgetMs : STEP_BUDGET_MS;
    const handle = { win: null, killed: '' };
    const blank = () => blankStep(step, rebase(String(step.url || '')));
    const cancelled = Object.assign(blank(), { error: { code: 'cancelled', detail: 'cancelled' } });
    if (step.signal && step.signal.aborted) return cancelled;
    const run = typeof d.runStep === 'function' ? d.runStep(step, rebase)
      : (step.type === 'fetch' ? runFetchStep(step) : runViewStep(step, handle));
    // The watchdog: a step gets its budget plus WATCHDOG_GRACE_MS, then it is over, whatever
    // inside it is still waiting. ITS OWN window is destroyed so nothing leaks -- never another
    // step's (a hung search must not kill the Disney+ read beside it) -- and the queue moves.
    const late = Object.assign(blank(), {
      error: { code: 'timeout', detail: 'timed out after ' + Math.round(budget / 1000) + ' s (the reader stopped answering)' },
    });
    let onAbort = null;
    const abortP = step.signal && typeof step.signal.addEventListener === 'function'
      ? new Promise((r) => { onAbort = () => r(cancelled); step.signal.addEventListener('abort', onAbort, { once: true }); })
      : null;
    const r = await within(abortP ? Promise.race([run, abortP]) : run, budget + WATCHDOG_GRACE_MS, late);
    if (onAbort) { try { step.signal.removeEventListener('abort', onAbort); } catch { /* gone */ } }
    if (r === late || r === cancelled) {
      if (r === late) log('Lumen reader step ' + step.name + ' hit the watchdog after ' + Math.round((budget + WATCHDOG_GRACE_MS) / 1000) + ' s');
      handle.killed = r === late ? 'watchdog' : 'cancelled';
      destroyReader(handle.win);
      if (run && typeof run.catch === 'function') run.catch(() => { /* ended from outside */ });
    }
    return r;
  }

  async function readService(id, token) {
    const dead = () => !!(token && token.dead);   // stopped by its time limit: it writes nothing more
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
    const gen = epoch;
    for (const step of steps) {
      if (stopped || gen !== epoch || dead()) return;   // stopped, forgotten or out of time mid-read: no further page loads
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
    if (dead()) return;
    if (token) token.wrote = true;   // pump: a game look that ends after this point stops nothing
    s.readAt = now();
    s.captured = captured;
    s.state = result.state;
    s.reason = result.reason;
    s.warnings = result.state === 'ok' ? result.warnings : [];
    if (result.picker === true) s.picker = true; else delete s.picker;
    if (s.warnings.length) log('Lumen read ' + svc.name + ' with warnings: ' + s.warnings.join('; '));
    if (result.state === 'ok') {
      s.items = result.items.filter((it) => it.service === id).slice(0, ITEMS_PER_SERVICE);
      s.profile = result.profile || '';
      if (result.avatar) s.avatar = result.avatar; else delete s.avatar;
      s.lastOkAt = s.readAt;
      if (id === 'espn') s.events = result.events || [];
    } else if (result.state === 'signed-out') {
      // Rows from an account that is no longer signed in are not shown as his.
      s.items = [];
      s.profile = '';
      delete s.avatar;
    }
    // An error keeps the last good rows: the page greys them with "as of".
    if (result.state !== 'ok') {
      const steps2 = Object.keys(read.steps).length;
      log('Lumen could not read ' + svc.name + ': ' + (result.state === 'signed-out' ? 'signed out' : result.reason)
        + ' (' + steps2 + ' page' + (steps2 === 1 ? '' : 's') + ', ' + captured + ' response' + (captured === 1 ? '' : 's') + ' captured)');
    }
    saveCacheSoon();
  }

  /* --- the queue -------------------------------------------------------------------- */

  /** A due read that may not start: say why, and for a game / low memory back the timer off. */
  function setPaused(id, why) {
    paused[id] = why;
    if (why.indexOf('paused') === 0) pausedUntil[id] = now() + PAUSE_BACKOFF_MS;
    else delete pausedUntil[id];
  }

  function enqueue(id, forced) {
    if (stopped || !loadPrefs().enabled[id]) return false;
    // `starting`: taken off the queue and waiting on checkGame() -- in neither the queue nor
    // `reading`, but already on its way. Without this the same service could read twice.
    if (reading === id || starting === id || queue.indexOf(id) !== -1) return false;
    const why = blocker(id, forced);
    if (why) { setPaused(id, why); pushAll(); return false; }
    delete paused[id];
    delete pausedUntil[id];
    if (forced) forcedQueued.add(id);
    queue.push(id);
    pushAll();    // the page shows it queued at once (it may wait out the boot grace)
    pump();
    return true;
  }

  /** In the boot grace: arm the one timer that starts the first reader at its end. -> waiting? */
  function bootWait() {
    const left = bootUntil - now();
    if (left <= 0) return false;
    if (!bootTimer) {
      bootTimer = setTimer(() => { bootTimer = null; pump(); }, left);
      if (bootTimer && typeof bootTimer.unref === 'function') bootTimer.unref();
    }
    return true;
  }

  async function pump() {
    if (pumping || stopped) return;
    if (bootWait()) return;      // reads stay queued until create() + bootGraceMs
    pumping = true;
    try {
      while (queue.length && !stopped) {
        const id = queue.shift();
        const gen = epoch;
        // A due read that was queued while a page was in sight waits for one to be in sight again
        // (the page went behind another tab, or the boot grace outlasted its front time); a Retry
        // or Read now (forced) reads regardless.
        // A background read (bg) runs out of sight, under its own stricter gates.
        const forced = forcedQueued.delete(id);
        const bg = bgQueued.delete(id);
        if (!forced && !bg && !anyVisible()) { pushAll(); continue; }
        // Conditions can change while earlier services read (a game starts): look again. The look
        // is one tasklist (r64: 0.3-0.8 s), and a read the user is waiting on (a Retry / Read now,
        // or a Lumen page in sight) used to sit behind it before its first page even started
        // loading. Such a read, when the last look found no game, now starts BESIDE the look:
        // a game this look finds stops it at once (gameLook below: its reader destroyed, nothing
        // written) and pauses it with the game's reason, exactly as a look before it would have.
        // Background reads still wait for the look: nobody is waiting on them.
        let gameLook = null;
        if ((forced || anyVisible()) && !gameRunning() && gameLookDue()) {
          gameLook = checkGame();
        } else {
          starting = id;
          try { await checkGame(); } finally { starting = null; }
        }
        if (gen !== epoch) continue;   // forgotten while it waited
        if (!loadPrefs().enabled[id]) continue;   // turned off while it waited
        const why = blocker(id, true);
        if (why && why.indexOf('waiting') !== 0) { setPaused(id, why); pushAll(); continue; }
        let bgRun = false;   // this read is the background refresh's (its cadence, its gates)
        if (bg && !forced && !anyVisible()) {
          const bgWhy = bgBlocker();
          if (bgWhy) { bgPause(bgWhy); pushAll(); continue; }
          bgLastAt = now();
          bgWaiting = '';
          bgReads++;
          bgRun = true;
        }
        if (ytlib) {
          // A Subscriptions / channel read in flight ends first: one hidden reader at a time.
          starting = id;
          try { await ytlib.acquire(); } finally { starting = null; }
          if (stopped || gen !== epoch || !loadPrefs().enabled[id]) { ytlib.release(); continue; }
        }
        // The look beside it answered while this read waited for the lock, and found a game.
        if (gameLook && gameRunning()) {
          setPaused(id, blocker(id, true) || ('paused while ' + gameRunning() + ' is running'));
          if (ytlib) ytlib.release();
          pushAll();
          continue;
        }
        reading = id;
        const watchedAt = watched[id];
        delete watched[id];      // this read picks up whatever he watched
        readStartedAt = now();
        readLimit = readLimitMs(id);
        pushAll();
        // The time limit: past it the read is stopped (its reader destroyed, its late answer
        // dropped) and the service says so -- the page never sits on "Updating…" forever.
        const token = { dead: false, done: false, wrote: false };
        const LATE = {};
        let r = null;
        // The look started beside this read (above) found a game: stop the read now, quietly --
        // its readers destroyed, nothing written (readService checks token.dead before it writes).
        let gameStop = '';
        if (gameLook) {
          gameLook.then((name) => {
            if (!name || token.dead || token.done || token.wrote) return;
            gameStop = name;
            token.dead = true;
            for (const w of Array.from(liveReaders.keys())) destroyReader(w, 'cancelled');
          });
        }
        try {
          r = await within(readService(id, token).then(() => null, (err) => { log('Lumen reader error: ' + ((err && err.message) || err)); return null; }), readLimit, LATE);
        } catch (err) { log('Lumen reader error: ' + ((err && err.message) || err)); }
        token.done = true;
        const gameStopped = !!gameStop && !token.wrote;
        if (gameStopped) {
          // Paused with the game's reason, as blocker() says it; the rows stay as they were.
          const why = blocker(id, true) || ('paused while ' + gameStop + ' is running');
          setPaused(id, why);
          if (watchedAt && !watched[id]) watched[id] = watchedAt;
          log('Lumen stopped reading ' + Shape.serviceById(id).name + ': ' + why);
        } else if (r === LATE) {
          token.dead = true;
          for (const w of Array.from(liveReaders.keys())) destroyReader(w, 'watchdog');
          const s = loadCache().services[id];
          s.state = 'error';
          s.reason = 'it took longer than ' + Math.round(readLimit / 1000) + ' s, so the read was stopped';
          s.readAt = now();
          s.warnings = [];
          log('Lumen stopped reading ' + Shape.serviceById(id).name + ' after its ' + Math.round(readLimit / 1000) + ' s limit');
          saveCacheSoon();
        }
        reading = null;
        readStartedAt = 0;
        readLimit = 0;
        // The feed may follow a background-refresh read with no Lumen page open (Lumen Alerts) only
        // while the background gates still pass (bgBlocker: battery saver, a game, 2.5 GB, minimised).
        if (ytlib) { ytlib.release(); if (!gameStopped) ytlib.afterRead(id, loadCache().services[id].state, bgRun && !bgBlocker()); }
        if (alerts && !gameStopped) { try { alerts.onRead(id, loadCache().services[id]); } catch (err) { log('Lumen Alerts failed after a read: ' + ((err && err.message) || err)); } }
        // A read that failed (or ran out of time) can be retried at once: the 30-s gap only
        // folds a double click on a read still on its way.
        if (loadCache().services[id].state === 'error') delete lastForced[id];
        pushAll();
      }
    } catch (err) {
      failLoud('run its reads', err);
    } finally {
      pumping = false;
      reading = null;
      starting = null;
      if (ytlib) ytlib.release();
      readStartedAt = 0;
      readLimit = 0;
      try { schedule(); } catch (err) { failLoud('plan its next read', err); }
    }
  }

  /** Enabled services past their floor. `timed` (the timer): a game / memory pause waits its backoff. */
  function dueIds(timed) {
    const p = loadPrefs();
    const c = loadCache();
    const t = now();
    return Shape.SERVICE_IDS.filter((id) => p.enabled[id] && t - (c.services[id].attemptAt || 0) >= everyMs(id)
      && !(timed && pausedUntil[id] > t));
  }

  /** Is any Watch page on screen (its document visible)? Reads start only then. */
  function anyVisible() {
    for (const [g, v] of guestVisible) if (v && guests.has(g)) return true;
    return false;
  }

  /**
   * The timers: the visible one while a Watch page is on screen, else the background one (off
   * screen, or no Watch page open at all). Never both.
   */
  function schedule() {
    if (timer) { clearTimer(timer); timer = null; timerAt = 0; }
    if (bgTimer) { clearTimer(bgTimer); bgTimer = null; bgTimerAt = 0; }
    if (stopped) return;
    if (!guests.size || !anyVisible()) { scheduleBg(); return; }
    const p = loadPrefs();
    const c = loadCache();
    let soonest = Infinity;
    for (const id of Shape.SERVICE_IDS) {
      if (!p.enabled[id]) continue;
      soonest = Math.min(soonest, Math.max((c.services[id].attemptAt || 0) + everyMs(id), pausedUntil[id] || 0));
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
    if (stopped || !guests.size || !anyVisible()) return;
    try {
      const due = dueIds(true);
      if (!due.length) { schedule(); return; }
      checkGame().then(() => {
        if (anyVisible()) for (const id of due) enqueue(id, false);
        if (!pumping) schedule();
      }).catch((err) => failLoud('start its next read', err));
    } catch (err) { failLoud('start its next read', err); }
  }

  /**
   * Fresh on open: what a page coming on screen reads, in order. A service whose title he
   * opened from Watch (and was away from for WATCHED_AWAY_MS) first, whatever its age; then
   * every service last tried over FRESH_ON_OPEN_MS ago (or past its own floor, if that is
   * shorter: ESPN with a game live), oldest first.
   */
  function openDueIds() {
    const p = loadPrefs();
    const c = loadCache();
    const t = now();
    const ids = Shape.SERVICE_IDS.filter((id) => p.enabled[id]);
    const back = ids.filter((id) => watched[id] && t - watched[id] >= watchedAwayMs);
    const stale = ids.filter((id) => back.indexOf(id) === -1 && t - (c.services[id].attemptAt || 0) >= Math.min(FRESH_ON_OPEN_MS, everyMs(id)))
      .sort((a, b) => (c.services[a].attemptAt || 0) - (c.services[b].attemptAt || 0));
    return back.concat(stale);
  }

  /** A Watch page is on screen (hello, its tab brought forward, the window back or focused): fresh on open. */
  function readDue() {
    if (stopped || !anyVisible()) { schedule(); return; }
    const due = openDueIds();
    if (!due.length) { schedule(); return; }
    const go = () => {
      if (anyVisible()) for (const id of due) enqueue(id, false);
      schedule();
    };
    // The last look found no game and a new one is due (r64): queue now, so the first read
    // starts beside that look (pump) instead of behind it. A game it finds stops that read and
    // pauses the rest, as a look before them would have.
    if (!gameRunning() && gameLookDue()) {
      try { go(); } catch (err) { failLoud('start its reads', err); }
      return;
    }
    checkGame().then(go).catch((err) => failLoud('start its reads', err));
  }

  /** Fresh after watching: a title opened from Watch marks its service to re-read when he comes back. */
  function noteOpened(url) {
    try {
      const clean = Shape.cleanHttps(url);
      const svc = clean ? Shape.serviceForUrl(clean) : null;
      const id = svc && typeof svc === 'object' ? svc.id : svc;
      if (id && Shape.SERVICE_IDS.indexOf(id) !== -1 && loadPrefs().enabled[id]) watched[id] = now();
    } catch { /* not a service page: nothing to re-read */ }
  }

  /* --- the background refresh (no Watch page on screen) ------------------------------ */

  /** Services the background refresh keeps up: enabled, read fine before, past BG_EVERY_MS. Oldest first. */
  function bgDueIds() {
    const p = loadPrefs();
    const c = loadCache();
    const t = now();
    return Shape.SERVICE_IDS.filter((id) => {
      const s = c.services[id];
      return p.enabled[id] && s.lastOkAt > 0 && s.state !== 'signed-out' && t - (s.attemptAt || 0) >= bgEvery(id);
    }).sort((a, b) => (c.services[a].attemptAt || 0) - (c.services[b].attemptAt || 0));
  }

  /** A service's background floor: hourly, or ESPN's live cadence while Lumen Alerts says a favourite's game is on. */
  function bgEvery(id) {
    if (id !== 'espn' || !alerts) return bgEveryMs;
    const svc = Shape.serviceById('espn');
    try { if (svc && svc.liveEveryMin && alerts.espnHot(loadCache().services.espn.events)) return Math.min(bgEveryMs, Math.max(bgGapMs, svc.liveEveryMin * 60e3)); } catch { /* hourly */ }
    return bgEveryMs;
  }

  /** The earliest a background read may start (boot delay, the gap since the last, a pause). */
  function bgEarliest() {
    return Math.max(createdAt + bgBootDelayMs, bgLastAt ? bgLastAt + bgGapMs : 0, bgPausedUntil);
  }

  function bgPause(why) {
    if (why !== bgWaiting) log('Lumen background refresh ' + why);
    bgWaiting = why;
    bgPausedUntil = now() + bgPauseMs;
  }

  function scheduleBg() {
    if (stopped || !loadPrefs().background) return;
    const p = loadPrefs();
    const c = loadCache();
    let soonest = Infinity;
    for (const id of Shape.SERVICE_IDS) {
      const s = c.services[id];
      if (!p.enabled[id] || !(s.lastOkAt > 0) || s.state === 'signed-out') continue;
      soonest = Math.min(soonest, (s.attemptAt || 0) + bgEvery(id));
    }
    if (soonest === Infinity) return;
    soonest = Math.max(soonest, bgEarliest());
    const delay = Math.max(bgTimerMinMs, Math.min(TIMER_MAX_MS, soonest - now()));
    bgTimerAt = now() + delay;
    bgTimer = setTimer(bgTick, delay);
    if (bgTimer && typeof bgTimer.unref === 'function') bgTimer.unref();
  }

  /** One background read at most per tick; the next one is BG_GAP_MS later at the earliest. */
  function bgTick() {
    bgTimer = null;
    bgTimerAt = 0;
    try {
      if (stopped || anyVisible() || !loadPrefs().background) { schedule(); return; }
      if (pumping || queue.length || now() < bgEarliest()) { if (!pumping) schedule(); return; }
      const id = bgDueIds()[0];
      if (!id) { schedule(); return; }
      // The free gates first; the game check (one async tasklist) only if they pass.
      const pre = bgBlocker();
      if (pre) { bgPause(pre); schedule(); return; }
      checkGame().then(() => {
        if (stopped || anyVisible()) { schedule(); return; }
        const why = bgBlocker();
        if (why) { bgPause(why); schedule(); return; }
        if (reading === id || starting === id || queue.indexOf(id) !== -1 || !loadPrefs().enabled[id]) { if (!pumping) schedule(); return; }
        bgQueued.add(id);
        queue.push(id);
        pump();
      }).catch((err) => failLoud('start its background read', err));
    } catch (err) { failLoud('start its background read', err); }
  }

  function setBackground(on) {
    const p = loadPrefs();
    p.background = !!on;
    savePrefs();
    if (!p.background) {
      // Off: a background read not yet started leaves the queue.
      for (const id of Array.from(bgQueued)) { const i = queue.indexOf(id); if (i !== -1 && !forcedQueued.has(id)) queue.splice(i, 1); }
      bgQueued.clear();
      bgWaiting = '';
      bgPausedUntil = 0;
    }
    schedule();
    return describe();
  }

  /** The Quartz window got focus back (from Edge, say): a Watch page on screen reads what is stale. */
  function windowFocused() {
    if (stopped || !guests.size || !anyVisible()) return;
    try { readDue(); } catch (err) { failLoud('start its reads', err); }
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
      // Profiles in Lumen (watch/profiles.js): the picture, the picker state, the picker's own button.
      avatar: s.avatar || '', picker: !!(p.enabled[id] && s.picker && s.state === 'error'), profilePage: Play.profilePage(id),
      reading: reading === id, queued: queue.indexOf(id) !== -1 || starting === id,
      // The read in flight: since when, and its time limit (the page's header counts against it).
      readingSince: reading === id ? readStartedAt : 0, readLimitMs: reading === id ? readLimit : 0,
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
      player: player ? { inside: !!player.inside() } : null,
      // the page never previews until a snapshot says on (a snapshot without this keeps its last word)
      preview: { on: previewMode !== 'off', mock: previewMode === 'mock', tiles: p.tilePreview !== false },
      reading,
      forgottenAt,
    };
  }

  function isWatchPage(url) {
    if (!isBundledPage(url)) return false;
    try { return path.basename(new URL(url).pathname).toLowerCase() === PAGE_FILE; } catch { return false; }
  }

  /**
   * The snapshot, or -- when building it throws -- { v: 1, now, fatal: reason }: the page shows
   * the reason with a Retry (which says hello again). Never a page left on "Reading…".
   */
  function safeSnapshot() {
    try {
      const snap = snapshot();
      try { snap.drm = drmView(); } catch { /* the page then labels by address, as before */ }
      lastFatal = '';
      return snap;
    } catch (err) {
      return fatalSnapshot('build its page', err);
    }
  }

  function fatalSnapshot(what, err) {
    const msg = String((err && err.message) || err || 'unknown error').replace(/\s+/g, ' ').slice(0, 160);
    const reason = 'Lumen could not ' + what + ' (' + msg + ')';
    if (reason !== lastFatal) { lastFatal = reason; log(reason); }   // once per distinct failure, not every push
    return { v: 1, now: now(), fatal: reason };
  }

  /** Something that should never fail did: log it and put the reason on every Watch page. */
  function failLoud(what, err) {
    let snap;
    try { snap = fatalSnapshot(what, err); } catch { snap = { v: 1, now: Date.now(), fatal: 'Lumen could not ' + what }; }
    for (const g of Array.from(guests)) pushTo(g, '__applyWatch', snap);
  }

  /** A guest leaves (closed, navigated away): out of the set, its visibility and its search too. */
  function dropGuest(contents) {
    const had = guests.delete(contents);
    guestVisible.delete(contents);
    if (ytlib) { ytlib.dropGuest(contents); ytlib.sight(anyVisible()); }
    if (shows) shows.dropGuest(contents);
    const job = searchLive.get(contents);
    if (job) { cancelSearch(job); searchLive.delete(contents); }
    if (finder) finder.cancel(contents);
    return had;
  }

  function pushTo(contents, fn, payload) {
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) { dropGuest(contents); return; }
    let url = '';
    try { url = contents.getURL(); } catch { dropGuest(contents); return; }
    if (!isWatchPage(url)) { dropGuest(contents); return; }
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
      const snap = safeSnapshot();
      for (const g of Array.from(guests)) pushTo(g, '__applyWatch', snap);
      if (!guests.size) schedule();
    }).catch((err) => {
      pushQueued = false;
      failLoud('update its page', err);
    });
  }

  /**
   * hello: the cache snapshot always goes back at once; reads that are due start only when
   * this page is visible (a tab restored in the background reads nothing until it is looked at).
   */
  function hello(contents, visible) {
    guests.add(contents);
    guestVisible.set(contents, visible !== false);
    if (ytlib) ytlib.sight(anyVisible());
    // Cache first: the page draws what it had before anything is read.
    pushTo(contents, '__applyWatch', safeSnapshot());
    try {
      if (visible !== false) readDue();
      else schedule();   // a hidden page: the snapshot only (and no timer, unless another page is on screen)
    } catch (err) { failLoud('start its reads', err); }
  }

  /** The page's visibilitychange. Turning visible reads what is due; hidden stops the timer if no page is left on screen. */
  function setVisible(contents, visible) {
    if (!guests.has(contents)) { hello(contents, visible); return; }
    const was = guestVisible.get(contents) === true;
    guestVisible.set(contents, !!visible);
    if (ytlib) ytlib.sight(anyVisible());
    try {
      if (visible && !was) readDue();
      else if (!visible) {
        // Out of sight: due reads not yet started leave the queue (they stay due for next time).
        if (!anyVisible()) {
          const keep = queue.filter((id) => forcedQueued.has(id) || bgQueued.has(id));
          if (keep.length !== queue.length) { queue.length = 0; queue.push(...keep); pushAll(); }
        }
        schedule();
      }
    } catch (err) { failLoud('start its reads', err); }
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

  /*
   * Where a protected title goes. Shape.opensInEdge says the page NEEDS Widevine;
   * drm-main says whether this Quartz can play it (CDM in, signed for streaming)
   * or the person chose Edge for that service. { edge, why }: why is said to the
   * person whenever the title goes to Edge.
   */
  function routeFor(clean) {
    if (!Shape.opensInEdge(clean)) return { edge: false, why: '' };
    let r;
    try { r = drmRoute(clean) || {}; } catch (err) { r = { edge: true, reason: 'Quartz could not check its Widevine (' + String((err && err.message) || err).slice(0, 80) + ')' }; }
    return r.edge === false ? { edge: false, why: '' } : { edge: true, why: String(r.reason || '').slice(0, 200) };
  }

  /** What the page needs to label tiles "Opens in Edge": the same answer openTitle gets. */
  function drmView() {
    const hosts = Shape.EDGE_HOSTS.concat(['tv.apple.com', 'tv.youtube.com', 'espn.com']);
    const edgeHosts = [];
    let playable = true;
    let reason = '';
    for (const h of hosts) {
      const probe = h === 'espn.com' ? 'https://www.espn.com/watch/player' : 'https://www.' + h + '/';
      const r = routeFor(probe);
      if (r.edge) { edgeHosts.push(h); if (!/^you chose/.test(r.why)) { playable = false; if (!reason) reason = r.why; } }
    }
    return { playable, reason, edgeHosts };
  }

  async function openTitle(url, extra) {
    const x = extra && typeof extra === 'object' ? extra : {};
    const clean = Shape.cleanHttps(url);
    if (!clean || (!Shape.serviceForUrl(clean) && !isTmdbPage(clean))) return { ok: false, how: '', reason: 'Lumen only opens pages on the services it reads' };
    const route = routeFor(clean);
    if (test.openStub) {
      try { fs.appendFileSync(test.openStub, JSON.stringify({ url: clean, edge: route.edge }) + '\n'); } catch { /* the e2e will see it missing */ }
    }
    const inLayer = !!(player && player.inside());
    // TMDB's where-to-watch page (JustWatch's links) is no service of ours, but it is still
    // watching, and leaving Lumen for a tab is a bug: it opens in the layer as the 'tmdb' guide
    // (watch-player-hosts.js), and a link from it to a service comes back here (the player's
    // handoff) to be routed like any title. A link to another site leaves the layer with its own
    // log line. Logged either way.
    if (isTmdbPage(clean)) {
      if (inLayer && player.play({ url: rebase(clean), service: 'tmdb', title: x.title || 'Where to watch' })) {
        log('Lumen: a TMDB where-to-watch page opened in the player layer: ' + hostOf(clean));
        return { ok: true, how: 'layer', reason: '' };
      }
      leftLumen('tab', 'a TMDB where-to-watch page, in a tab (' + whyTab() + ')', clean, 'Lumen: a TMDB where-to-watch page opened in a tab (' + whyTab() + '): ' + hostOf(clean));
      send('open-url', { url: rebase(clean), background: false });
      return { ok: true, how: 'tab', reason: '' };
    }
    // A multiview tile that cannot play says why inside its tile; it never launches Edge by itself.
    if (route.edge && inLayer && x.multi) {
      player.play({ url: rebase(clean), service: Shape.serviceForUrl(clean), title: x.title, multi: true, blocked: route.why || 'Quartz can’t play protected video here' });
      return { ok: true, how: 'layer', reason: '' };
    }
    if (route.edge) {
      let r;
      try { r = await openInEdge(x.fallback || clean); } catch (err) { r = { ok: false, how: '', reason: String((err && err.message) || err) }; }
      // The player's where-to-watch handoff counts its own way out (via: 'handoff').
      if (x.via !== 'handoff') {
        const svcName = (Shape.serviceById(Shape.serviceForUrl(clean)) || {}).name || hostOf(clean);
        leftLumen('edge', svcName + ' in Edge' + (route.why ? ': ' + route.why : '') + (r && r.ok ? '' : ' (Edge did not open)'), clean,
          'Lumen: opened ' + hostOf(clean) + ' in Edge' + (route.why ? ' (' + route.why + ')' : '') + (r && r.ok ? '' : '; Edge did not open: ' + String((r && r.reason) || '').slice(0, 80)));
      }
      return { ok: !!(r && r.ok), how: 'edge', reason: (r && r.reason) || '', why: route.why };
    }
    if (inLayer && player.play({ url: rebase(clean), service: Shape.serviceForUrl(clean), title: x.title || '', multi: !!x.multi,
      fallback: x.fallback ? rebase(x.fallback) : '', item: x.item || null })) {
      return { ok: true, how: 'layer', reason: '' };
    }
    if (x.via !== 'handoff') leftLumen('tab', 'a title, in a tab (' + (inLayer ? 'no window for the layer' : whyTab()) + ')', clean, 'Lumen: opened ' + hostOf(clean) + ' in a tab (' + (inLayer ? 'no window for the layer' : whyTab()) + ')');
    send('open-url', { url: rebase(clean), background: false });
    return { ok: true, how: 'tab', reason: '' };
  }

  function signIn(service) {
    const svc = Shape.serviceById(service);
    if (!svc) return { ok: false, how: '', reason: 'unknown service' };
    // Signing in is part of watching: the layer too, when it is on.
    if (player && player.inside() && player.play({ url: rebase(svc.signIn), service: svc.id, title: 'Sign in to ' + svc.name })) {
      return { ok: true, how: 'layer', reason: '' };
    }
    leftLumen('tab', 'Sign in to ' + svc.name + ', in a tab (' + whyTab() + ')', svc.signIn, 'Lumen: Sign in to ' + svc.name + ' opened in a tab (' + whyTab() + ')');
    send('open-url', { url: rebase(svc.signIn), background: false });
    return { ok: true, how: 'tab', reason: '' };
  }

  /*
   * "Switch profile" / "Pick profile": the service's own picker, in the layer. The pick is a write the
   * service makes itself; Lumen reads that service again when the layer closes (afterWatching), even
   * inside Read now's 30 s gap, because the rows on screen belong to the old profile.
   */
  const profilePending = {};
  function pickProfile(service) {
    const svc = Shape.serviceById(service);
    const pg = Play.profilePage(service);
    if (!svc || !pg) return { ok: false, how: '', reason: (svc ? svc.name : 'This service') + ' has no profiles to pick' };
    profilePending[svc.id] = true;
    noteOpened(pg.url);
    if (player && player.inside() && player.play({ url: rebase(pg.url), service: svc.id, title: pg.label + ' · ' + svc.name, purpose: 'profile', note: pg.where })) {
      return { ok: true, how: 'layer', reason: '' };
    }
    leftLumen('tab', pg.label + ' for ' + svc.name + ', in a tab (' + whyTab() + ')', pg.url, 'Lumen: ' + pg.label + ' for ' + svc.name + ' opened in a tab (' + whyTab() + ')');
    send('open-url', { url: rebase(pg.url), background: false });
    return { ok: true, how: 'tab', reason: '' };
  }

  /*
   * Up next (watch-player-extras.js): what follows `item` on its service, from that service's own rows.
   * A title that just ended moves on in the service's Continue watching, so the service is read again
   * first (afterWatching's re-read, forced) and the answer comes from the fresh rows. Resolves to
   * { ok, next: item | null, reason } within waitMs.
   */
  async function upNext(o, waitMs) {
    const x = o && typeof o === 'object' ? o : {};
    const raw = x.item && typeof x.item === 'object' ? x.item : {};
    const item = cleanOpenItem(raw, Shape.SERVICE_IDS.indexOf(raw.service) !== -1 ? raw.service : '');
    if (!item) return { ok: false, next: null, reason: 'Lumen doesn’t know what was playing' };
    const id = item.service;
    if (!loadPrefs().enabled[id]) return { ok: false, next: null, reason: Shape.serviceById(id).name + ' is off in Settings > Lumen' };
    const pick = () => Play.upNextFor(item, loadCache().services[id].items);
    const before = loadCache().services[id].readAt;
    delete lastForced[id];
    refresh(id);
    const limit = Math.max(0, Math.min(Number.isFinite(waitMs) ? waitMs : 45000, 120000));
    const t0 = now();
    while (now() - t0 < limit && !stopped) {
      if (loadCache().services[id].readAt > before && reading !== id) break;
      await sleep(500);
    }
    const fresh = loadCache().services[id].readAt > before;
    const next = pick();
    if (next) return { ok: true, next: Object.assign({}, next, { url: rebase(next.playUrl || next.url), fallback: next.playUrl ? rebase(next.url) : '' }), reason: '' };
    const s = loadCache().services[id];
    return { ok: true, next: null, reason: !fresh ? Shape.serviceById(id).name + ' wasn’t read again in time' : s.state !== 'ok' ? 'Couldn’t read ' + Shape.serviceById(id).name + ': ' + (s.reason || s.state) : 'No next episode in ' + Shape.serviceById(id).name + '’s Continue watching' };
  }

  function forget() {
    epoch++;
    forgottenAt = now();
    cache = cleanCache(null);
    if (ytlib) ytlib.forget();
    if (shows) shows.forget();
    // A read in flight writes into the old cache object, so its rows are dropped; a queued
    // one is cancelled; and nothing reads again until its normal floor (or a Retry), so
    // "Forget" leaves the page empty instead of refilling it a second later.
    queue.length = 0;
    forcedQueued.clear();
    for (const id of Shape.SERVICE_IDS) cache.services[id].attemptAt = now();
    // Nothing of his stays in memory either: the search answers (keyed by what he typed; a
    // search in flight still answers the page but is not cached), the pause reasons and Retry
    // stamps, and the reader page open now (the read it belonged to stops at once).
    searchCache.clear();
    trailerCache.clear();
    if (finder) finder.forget();
    searchNext = 0;
    // A YouTube fetch in flight still answers the searches waiting on it (uncached: their epoch is
    // old), but no search after Forget joins it.
    ytFlights.clear();
    for (const k of Object.keys(paused)) delete paused[k];
    for (const k of Object.keys(pausedUntil)) delete pausedUntil[k];
    for (const k of Object.keys(lastForced)) delete lastForced[k];
    for (const w of Array.from(liveReaders.keys())) destroyReader(w, 'cancelled');
    const file = fileIn(CACHE_FILE);
    let ok = true;
    let freed = 0;
    if (file) { try { freed = fs.statSync(file).size; } catch { freed = 0; } }
    if (file) { try { fs.rmSync(file, { force: true }); } catch (err) { ok = false; log('Lumen cache could not be deleted: ' + ((err && err.code) || 'unknown')); } }
    if (saveTimer) { clearTimer(saveTimer); saveTimer = null; }
    pushAll();
    return { ok, freed: ok ? freed : 0, reason: ok ? '' : 'the cache file could not be deleted' };
  }

  /* --- the one search box (Enter): watch-find-main.js ------------------------------------ */

  /** Why Enter's hidden search readers must wait ('' = they may): the same gates as a read. */
  function findBlocker() {
    const game = gameRunning();
    if (game) return 'paused while ' + (game === 'valorant' ? 'VALORANT' : game) + ' is running';
    const free = freeGb();
    if (free < minFreeGb) return 'paused: only ' + free.toFixed(1) + ' GB of memory free (Lumen reads with at least ' + minFreeGb + ' GB)';
    return '';
  }

  function findMain() {
    if (finder || !FindMain || stopped) return finder;
    finder = FindMain.create({
      runStep, now, log, sleep,
      readers: test.findReaders || undefined,
      gapMs: Number.isFinite(test.findGapMs) ? test.findGapMs : undefined,
      enabled: (id) => !!loadPrefs().enabled[id],
      serviceState: (id) => { const s = loadCache().services[id]; return s ? s.state : ''; },
      blocker: findBlocker,
      epoch: () => epoch,
      youtube: (q, job) => searchYouTube(q, loadPrefs(), job),
      tmdb: (q, job) => searchTmdb(q, loadPrefs().tmdbKey, job),
      push: (contents, part) => pushTo(contents, '__applyWatchFind', part),
    });
    return finder;
  }

  /* --- the show pages: watch-shows-main.js --------------------------------------------- */

  function showsMain() {
    if (shows || !ShowsMain || stopped) return shows;
    shows = ShowsMain.create({
      runStep, now, log,
      fetchJson: (u, h) => fetchJson(u, h),
      tmdbKey: () => loadPrefs().tmdbKey,
      enabled: (id) => !!loadPrefs().enabled[id],
      serviceState: (id) => { const s = loadCache().services[id]; return s ? s.state : ''; },
      blocker: findBlocker,
      readers: test.showReaders || undefined,
      push: (contents, a) => pushTo(contents, '__applyWatchShow', a),
    });
    return shows;
  }

  /* --- search ------------------------------------------------------------------------- */

  function cancelSearch(job) {
    if (!job || job.stale) return;
    job.stale = true;
    try { if (job.ctrl) job.ctrl.abort(); } catch { /* gone */ }
  }

  /**
   * One search -> the answer for the page, or null when a newer search from the same page
   * replaced it while it ran (its fetches are aborted; nothing is cached; the page ignores a
   * stale seq anyway). `contents` is the asking guest; without one (tests) nothing is replaced.
   */
  async function search(q, seq, contents) {
    const job = { seq, stale: false, gen: epoch, ctrl: typeof AbortController === 'function' ? new AbortController() : null };
    const owner = contents || null;
    if (owner) { cancelSearch(searchLive.get(owner)); searchLive.set(owner, job); }
    try {
      const p = loadPrefs();
      const links = Merge.searchLinks(q);
      // TMDB runs beside YouTube, not after it: two independent answers, one push.
      const tmdbP = searchTmdb(q, p.tmdbKey, job);
      const base = { seq, q, links, tmdb: null };
      const yt = await searchYouTube(q, p, job);
      base.tmdb = await tmdbP;
      if (job.stale) return null;
      return Object.assign(base, { youtube: yt });
    } finally {
      if (owner && searchLive.get(owner) === job) searchLive.delete(owner);
    }
  }

  /** Cache a search answer -- unless Forget ran since the search began. */
  function rememberSearch(key, job, answer) {
    if (job && job.gen !== epoch) return;
    searchCache.set(key, { at: now(), answer });
    while (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
  }

  async function searchTmdb(q, key, job) {
    if (!key) return { state: 'no-key', reason: 'Add a free TMDB key in Settings to search every service', results: [] };
    if (!Tmdb || typeof Tmdb.search !== 'function') return { state: 'error', reason: 'this build has no TMDB search', results: [] };
    const ck = 'tmdb|' + q.toLowerCase();
    const hit = searchCache.get(ck);
    if (hit && now() - hit.at < SEARCH_TTL_MS) return hit.answer;
    const signal = job && job.ctrl ? job.ctrl.signal : null;
    let answer;
    try { answer = await Tmdb.search(q, key, (u, h) => fetchJson(u, h, signal), { region: 'US' }); } catch (err) {
      answer = { state: 'error', reason: 'TMDB search failed (' + String((err && err.message) || err).slice(0, 100) + ')', results: [] };
    }
    if (job && job.stale) return { state: 'error', reason: 'cancelled', results: [] };   // never shown: the whole answer is dropped
    if (!answer || typeof answer !== 'object') answer = { state: 'error', reason: 'TMDB search returned nothing', results: [] };
    if (answer.state === 'ok') {
      rememberSearch(ck, job, answer);
    } else if (answer.state !== 'empty') {
      log('Lumen search on TMDB failed: ' + (answer.state || 'error'));   // the state only: never the key, never the query
    }
    return answer;
  }

  async function searchYouTube(q, p, job) {
    if (!p.enabled.youtube) return { ok: false, state: 'off', reason: 'YouTube is turned off in Settings > Lumen', items: [] };
    const yt = adapters.youtube;
    if (!yt || typeof yt.searchUrl !== 'function' || typeof yt.parseSearch !== 'function') {
      return { ok: false, state: 'error', reason: 'this build has no YouTube search', items: [] };
    }
    const key = ytSearchKey(q);
    const hit = searchCache.get(key);
    if (hit && now() - hit.at < SEARCH_TTL_MS) return hit.answer;
    const cancelled = { ok: false, state: 'cancelled', reason: 'cancelled', items: [] };   // never shown
    // The one fetch of this query's results page, shared with every search waiting for the same
    // words (ytFlight). This search leaves it when its own job is cancelled.
    const fl = ytFlight(key, q, yt);
    fl.adopted = false;
    fl.users++;
    const sig = job && job.ctrl ? job.ctrl.signal : null;
    let left = false;
    const leave = (early) => {
      if (left) return;
      left = true;
      fl.users--;
      if (early && fl.users <= 0 && !fl.adopted) dropFlight(key, fl);
    };
    let onAbort = null;
    const abortP = sig && typeof sig.addEventListener === 'function' ? new Promise((r) => {
      onAbort = () => { leave(true); r(cancelled); };
      if (sig.aborted) onAbort(); else sig.addEventListener('abort', onAbort, { once: true });
    }) : null;
    let answer;
    try {
      answer = await (abortP ? Promise.race([fl.p, abortP]) : fl.p);
    } finally {
      if (onAbort) { try { sig.removeEventListener('abort', onAbort); } catch { /* gone */ } }
      leave(false);
    }
    if ((job && job.stale) || !answer || answer.state === 'cancelled') return cancelled;
    if (answer.ok) rememberSearch(key, job, answer);
    return answer;
  }

  function ytSearchKey(q) { return 'yt|' + String(q || '').toLowerCase(); }

  /**
   * One YouTube results fetch per query at a time (r64). Typing "bluey" sends the as-you-type search;
   * Enter on the same words a moment later used to abort that fetch and queue the same page again
   * behind SEARCH_GAP_MS (+1.2 s and a second fetch before the tiles). Now every search for the same
   * words waits on this one: { users, adopted, dead, ctrl, p }. It is aborted only when the last
   * search waiting on it is cancelled (a newer query replaced them), so "the next search aborts the
   * one in flight" still holds for different words. `adopted`: Enter took it over from the typed
   * search it cancelled and joins on its next turn (watch-find-main.js calls youtube() in a
   * microtask), so that cancel does not abort it.
   * Searches still go out SEARCH_GAP_MS apart. One replaced while it waits never fetches at all,
   * and does not hold a slot: the newest search goes as soon as the gap allows. Its answer (or
   * failure, logged once) resolves fl.p; each search caches it under its own Forget epoch.
   */
  function ytFlight(key, q, yt) {
    const had = ytFlights.get(key);
    if (had && !had.dead) return had;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const fl = { users: 0, adopted: false, dead: false, ctrl, p: null };
    const gone = () => fl.dead || !!(ctrl && ctrl.signal.aborted);
    const cancelled = { ok: false, state: 'cancelled', reason: 'cancelled', items: [] };
    ytFlights.set(key, fl);
    fl.p = (async () => {
      for (;;) {
        if (gone()) return cancelled;
        const wait = searchNext - now();
        if (wait <= 0) break;
        await sleep(wait);
      }
      searchNext = now() + SEARCH_GAP_MS;
      const r = await runStep({ name: 'search', type: 'fetch', as: 'text', url: yt.searchUrl(q), budgetMs: 10000, signal: ctrl ? ctrl.signal : undefined });
      if (gone() || (r.error && r.error.code === 'cancelled')) return cancelled;
      let answer;
      if (r.error) answer = { ok: false, state: 'error', reason: r.error.detail, items: [] };
      else {
        let items = [];
        try { items = Shape.cleanItems(yt.parseSearch(r.text || ''), 20); } catch { items = []; }
        const channels = FindMain ? FindMain.channelsFrom(r.text || '') : [];
        answer = items.length ? { ok: true, state: 'ok', reason: '', items, channels }
          : { ok: false, state: 'error', reason: "YouTube's results page had nothing Lumen could read (YouTube changed its layout?)", items: [] };
      }
      if (!answer.ok) log('Lumen search on YouTube failed: ' + answer.reason);
      return answer;
    })().catch((err) => ({ ok: false, state: 'error', reason: String((err && err.message) || err).slice(0, 160), items: [] }))
      .finally(() => { if (ytFlights.get(key) === fl) ytFlights.delete(key); });
    return fl;
  }

  /** No search waits on this fetch any more: stop it (a fetch still waiting for the gap never goes out). */
  function dropFlight(key, fl) {
    if (fl.dead) return;
    fl.dead = true;
    if (ytFlights.get(key) === fl) ytFlights.delete(key);
    try { if (fl.ctrl) fl.ctrl.abort(); } catch { /* gone */ }
  }

  /* --- hover-preview trailers (watch/preview.js, watch/tmdb.js trailer()) -------------------- */

  /**
   * The official YouTube trailer for a title, from TMDB -> { state, reason, videoId }. Only with
   * the TMDB key the user saved for search; without one the page never asks (it says why itself),
   * and a late ask is answered 'no-key' with the reason. Answers that found a trailer, or found
   * that there is none, are kept a day; failures are not kept, so the next hover tries again.
   */
  async function previewTrailer(title, tv) {
    if (previewMode === 'off') return { state: 'off', reason: 'No preview: previews are off in a test profile', videoId: '' };
    if (previewMode === 'mock' && (!Tmdb || rebase(String(Tmdb.API_BASE || '')) === String(Tmdb.API_BASE || ''))) {
      return { state: 'off', reason: 'No preview: this test profile has no TMDB mock (QUARTZ_WATCH_REBASE), so no trailer is looked up', videoId: '' };
    }
    const p = loadPrefs();
    if (!p.tmdbKey) return { state: 'no-key', reason: 'No trailer preview: trailers are looked up on TMDB. Add the free TMDB key in Settings > Lumen', videoId: '' };
    if (!Tmdb || typeof Tmdb.trailer !== 'function') return { state: 'error', reason: 'No trailer preview: this build has no TMDB trailer lookup', videoId: '' };
    const ck = (tv ? 'tv|' : 'mv|') + title.toLowerCase();
    const hit = trailerCache.get(ck);
    if (hit && now() - hit.at < TRAILER_TTL_MS) return hit.answer;
    const gen = epoch;
    let a;
    try { a = await Tmdb.trailer(title, { tv }, p.tmdbKey, (u, h) => fetchJson(u, h)); } catch (err) {
      a = { state: 'error', reason: 'TMDB trailer lookup failed (' + String((err && err.message) || err).slice(0, 100) + ')', videoId: '' };
    }
    if (!a || typeof a !== 'object') a = { state: 'error', reason: 'TMDB trailer lookup returned nothing', videoId: '' };
    const answer = { state: String(a.state || 'error'), reason: String(a.reason || ''), videoId: /^[A-Za-z0-9_-]{11}$/.test(String(a.videoId || '')) ? String(a.videoId) : '' };
    if (answer.state === 'ok' && !answer.videoId) { answer.state = 'none'; answer.reason = answer.reason || 'No trailer preview: TMDB sent no usable video'; }
    if ((answer.state === 'ok' || answer.state === 'none') && gen === epoch) {
      trailerCache.set(ck, { at: now(), answer });
      while (trailerCache.size > TRAILER_CACHE_MAX) trailerCache.delete(trailerCache.keys().next().value);
    } else if (answer.state !== 'ok' && answer.state !== 'none') {
      log('Lumen trailer lookup on TMDB failed: ' + answer.state);   // the state only: never the key, never the title
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
    if (req.verb === 'open') noteOpened(req.url);   // fresh after watching: re-read it when he comes back
    switch (req.verb) {
      case 'hello': hello(contents, req.visible); break;
      case 'visible': setVisible(contents, req.visible); break;
      case 'refresh':
        guests.add(contents);
        if (!guestVisible.has(contents)) guestVisible.set(contents, true);   // a click: it is on screen
        refresh(req.service);
        break;
      case 'open':
        openTitle(req.url, { title: req.title, multi: req.multi, fallback: req.fallback, item: req.item }).then((r) => pushTo(contents, '__applyWatchResult', Object.assign({ action: 'open', url: req.url }, r)));
        break;
      case 'signin': pushTo(contents, '__applyWatchResult', Object.assign({ action: 'signin', service: req.service }, signIn(req.service))); break;
      case 'profile': pushTo(contents, '__applyWatchResult', Object.assign({ action: 'profile', service: req.service }, pickProfile(req.service))); break;
      case 'search':
        search(req.q, req.seq, contents).then((a) => { if (a) pushTo(contents, '__applyWatchSearch', a); },
          (err) => pushTo(contents, '__applyWatchSearch', { seq: req.seq, q: req.q, links: Merge.searchLinks(req.q), youtube: { ok: false, state: 'error', reason: String((err && err.message) || err), items: [] }, tmdb: null }));
        break;
      case 'find': {
        const f = findMain();
        if (!f) { pushTo(contents, '__applyWatchFind', { seq: req.seq, q: req.q, kind: 'fatal', reason: 'this build has no search across services' }); break; }
        // Enter replaces the as-you-type search: one YouTube read, not two. When that search is
        // fetching these same words, Enter adopts its fetch (ytFlight) instead of starting over.
        if (!req.only) {
          const job = searchLive.get(contents);
          if (job) {
            const fl = ytFlights.get(ytSearchKey(req.q));
            if (fl && !fl.dead) fl.adopted = true;
            cancelSearch(job);
            searchLive.delete(contents);
          }
        }
        f.run(req.q, req.seq, contents, { only: req.only, force: req.force }).catch((err) => log('Lumen search failed: ' + ((err && err.message) || err)));
        break;
      }
      case 'tilepv':
        tilePreviewGate().then((a) => pushTo(contents, '__applyWatchTilePreview', Object.assign({ seq: req.seq }, a)),
          (err) => pushTo(contents, '__applyWatchTilePreview', { seq: req.seq, ok: false, reason: 'No preview: ' + String((err && err.message) || err).slice(0, 120) }));
        break;
      case 'preview':
        previewTrailer(req.title, req.tv).then((a) => pushTo(contents, '__applyWatchPreview', Object.assign({ seq: req.seq }, a)),
          (err) => pushTo(contents, '__applyWatchPreview', { seq: req.seq, state: 'error', reason: 'No preview: ' + String((err && err.message) || err).slice(0, 120), videoId: '' }));
        break;
      case 'forget': pushTo(contents, '__applyWatchResult', Object.assign({ action: 'forget' }, forget())); break;
      case 'yt': if (ytlib) ytlib.line(contents, req.req); break;
      case 'show': {
        const sm = showsMain();
        if (sm) sm.line(contents, req.req);
        else pushTo(contents, '__applyWatchShow', { what: req.req.what, seq: req.req.seq, state: 'error', reason: 'this build has no show pages', show: null });
        break;
      }
      case 'settings': break;   // app.js opens Settings > Watch; nothing for main to do
      default: return false;
    }
    return true;
  }

  function watchGuest(contents) {
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return;
    contents.on('console-message', function (details) {
      try { handleGuestLine(contents, messageOf(details, arguments)); } catch (err) {
        log('Lumen guest line failed: ' + ((err && err.message) || 'error'));
      }
    });
    const left = () => { try { schedule(); } catch (err) { log('Lumen could not re-plan its reads: ' + ((err && err.message) || 'error')); } };
    contents.on('destroyed', () => { if (dropGuest(contents)) left(); });
    contents.on('did-start-navigation', (_e, to, inPage, isMain) => {
      if (isMain && !inPage && !isWatchPage(String(to)) && dropGuest(contents)) left();
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
      background: { on: !!p.background, waiting: p.background ? bgWaiting : '', lastAt: bgLastAt, nextAt: bgTimerAt, reads: bgReads },
      tilePreview: { on: p.tilePreview !== false },
      // watch.json could not be read ('' = fine): Settings > Lumen shows it.
      prefsNote,
      // The YouTube embed's Referer (watch/preview.js; watch.json "embedReferer"): the chrome's player sends it too.
      embedReferer: Preview && typeof Preview.currentEmbedReferer === 'function' ? Preview.currentEmbedReferer() : '',
    };
  }

  /** Settings > Lumen "Preview videos when I hover": saved, and every Lumen page hears it. */
  function setTilePreview(on) {
    const p = loadPrefs();
    p.tilePreview = !!on;
    savePrefs();
    pushAll();
    return describe();
  }

  /*
   * May a tile start a hover preview now? -> { ok, reason }. Asked once per hover that rested
   * HOVER_DELAY_MS (never per frame): the setting, a running game (checkGame: one tasklist a minute
   * at most), battery saver, and free memory (MIN_FREE_GB; a TEST profile may change it).
   */
  async function tilePreviewGate() {
    if (!TilePv) return { ok: false, reason: 'No preview: this build is missing watch-tilepreview.js' };
    let game = '';
    try { game = await checkGame(); } catch { game = gameRunning(); }
    let saver = null;
    try { saver = saverOn(); } catch { saver = null; }
    const why = TilePv.gateMain({ mode: previewMode, on: loadPrefs().tilePreview !== false, gaming: game, saver, freeGb: freeGb(),
      minFreeGb: Number.isFinite(test.tpvMinFreeGb) ? test.tpvMinFreeGb : TilePv.MIN_FREE_GB });
    return { ok: !why, reason: why };
  }

  function setEnabled(id, on) {
    if (Shape.SERVICE_IDS.indexOf(id) === -1) return Object.assign(describe(), { error: 'unknown service' });
    loadPrefs().enabled[id] = !!on;
    if (!on) {
      const i = queue.indexOf(id);
      if (i !== -1) queue.splice(i, 1);
      forcedQueued.delete(id);
      delete paused[id];
      delete pausedUntil[id];
      delete lastForced[id];
      // Off means gone, not hidden: its rows, profile name and games leave the cache AND
      // watch-cache.json now (a read in flight writes into the dropped record). Turned back
      // on, it is "never read" and reads at once.
      const c = loadCache();
      c.services[id] = emptyServiceState();
      saveCacheNow();
      if (id === 'youtube') for (const k of Array.from(searchCache.keys())) if (k.indexOf('yt|') === 0) searchCache.delete(k);
    }
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
    ipc.handle('watch:set-background', (e, on) => (gate(e) ? setBackground(!!on) : null));
    ipc.handle('watch:set-tile-preview', (e, on) => (gate(e) ? setTilePreview(!!on) : null));
    ipc.handle('watch:refresh', (e, id) => (gate(e) ? Object.assign(describe(), { started: refresh(Shape.SERVICE_IDS.indexOf(id) !== -1 ? id : null) }) : null));
  }

  /** The Quartz window came back on screen: whatever fell due while it was away reads now. */
  function windowShown() {
    if (stopped || !guests.size || !anyVisible()) return;
    try { readDue(); } catch (err) { failLoud('start its reads', err); }
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimer(timer); timer = null; }
    if (bootTimer) { clearTimer(bootTimer); bootTimer = null; }
    if (bgTimer) { clearTimer(bgTimer); bgTimer = null; }
    queue.length = 0;
    forcedQueued.clear();
    bgQueued.clear();
    if (ytlib) ytlib.stop();
    if (shows) shows.stop();
    for (const w of Array.from(liveReaders.keys())) destroyReader(w, 'cancelled');
    for (const job of searchLive.values()) cancelSearch(job);
    searchLive.clear();
    if (finder) finder.stop();
    if (saveTimer) saveCacheNow();
    guests.clear();
    guestVisible.clear();
  }

  if (electronApp && typeof electronApp.on === 'function') {
    electronApp.on('web-contents-created', (_event, contents) => {
      try { if (contents && contents.getType() === 'webview') watchGuest(contents); } catch { /* died already */ }
    });
  }
  if (d.ipcMain) registerIpc(d.ipcMain, d.isChromeSender);
  // watch.json now (a small file): a pre-opt-in one is made explicit at boot, and its embed
  // Referer is in place before any page can ask for an embed.
  try { loadPrefs(); } catch (err) { log('Lumen settings could not be loaded: ' + ((err && err.message) || 'error')); }
  // The background refresh's first look, at the end of its boot delay (no Watch page needs to
  // be open). The cache is not loaded now: bgTick reads it when it fires.
  bgTimerAt = now() + Math.max(bgTimerMinMs, bgBootDelayMs);
  bgTimer = setTimer(bgTick, Math.max(bgTimerMinMs, bgBootDelayMs));
  if (bgTimer && typeof bgTimer.unref === 'function') bgTimer.unref();

  return {
    handleGuestLine, watchGuest, registerIpc, snapshot, describe, refresh, enqueue, readService, search,
    openTitle, signIn, pickProfile, upNext, forget, setEnabled, setLeagues, setTmdbKey, setBackground, setTilePreview, tilePreviewGate, windowShown, windowFocused, stop, schedule, previewTrailer,
    isReaderContents, routeFor, drmView,
    // Lumen Alerts: the hooks (watch-alerts-main.js), the cached game answer, and what its Settings field needs.
    setAlerts: (a) => { alerts = a && typeof a === 'object' ? a : null; try { schedule(); } catch { /* next tick */ } },
    gaming: () => gameRunning(),
    // Is this service turned on in Settings > Lumen? (sports-main.js reads ESPN only while it is.)
    isEnabled: (id) => Shape.SERVICE_IDS.indexOf(id) !== -1 && !!loadPrefs().enabled[id],
    alertsView: () => { const p = loadPrefs(); const c = loadCache(); return { leagues: p.leagues.slice(), background: p.background, youtube: p.enabled.youtube ? c.services.youtube.state : 'off', espn: p.enabled.espn ? c.services.espn.state : 'off' }; },
    // drm-main's state changed (Widevine arrived, a rule was added): re-label the tiles.
    drmChanged: () => pushAll(),
    // Fresh after watching (watch-player-main.js): the layer closed on this service; read it
    // again now, so what he just watched moves in Continue watching. Same 30 s gap as Read now.
    afterWatching: (id) => {
      if (Shape.SERVICE_IDS.indexOf(id) === -1 || !loadPrefs().enabled[id]) return false;
      if (profilePending[id]) { delete profilePending[id]; delete lastForced[id]; }
      log('re-reading ' + id + ' after watching');
      return refresh(id) > 0;
    },
    flush: saveCacheNow,
    state: () => ({
      guests: guests.size, visible: Array.from(guestVisible.entries()).filter(([g, v]) => v && guests.has(g)).length,
      queue: queue.slice(), reading, starting, timerAt, bootTimer: !!bootTimer, paused: Object.assign({}, paused),
      pausedUntil: Object.assign({}, pausedUntil), viewAlive: liveReaders.size > 0, readers: liveReaders.size,
      searchCache: searchCache.size, trailerCache: trailerCache.size, searchesLive: searchLive.size, ytFlights: ytFlights.size, lastForced: Object.keys(lastForced).length,
      bgTimerAt, bgQueued: Array.from(bgQueued), bgLastAt, bgWaiting, bgPausedUntil, bgReads, watched: Object.assign({}, watched),
      readStartedAt, readLimit, find: finder ? finder.state() : null,
    }),
  };
}

module.exports = {
  create,
  cleanPrefs,
  isLegacyPrefs,
  cleanCache,
  cleanKey,
  maskKey,
  parseGuestLine,
  classifyNetError,
  rebaseUrl,
  LINE_PREFIX,
  CACHE_FILE,
  PREFS_FILE,
  PREFS_VERSION,
  STEP_BUDGET_MS,
  MIN_FREE_GB,
  GAME_PROCESSES,
  FRESH_ON_OPEN_MS,
  WATCHED_AWAY_MS,
  BG_EVERY_MS,
  BG_GAP_MS,
  BG_BOOT_DELAY_MS,
  BG_MIN_FREE_GB,
  BG_PAUSE_MS,
};
