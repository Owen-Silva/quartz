'use strict';

/*
 * app.js — tab strip, <webview> lifecycle, omnibox, navigation, Claude tabs.
 *
 * The renderer runs with contextIsolation ON and nodeIntegration OFF, so this is
 * plain browser script: no require(), no import, no bundler.
 *
 * Tabs come in two kinds and live side by side in #views:
 *   kind 'page'   — a <webview>, full browser behaviour (history, titles, nav).
 *   kind 'claude' — a <div class="claude-view"> hosting one Claude Code session,
 *                   driven by window.ClaudeTerminal (terminal.js, loaded AFTER
 *                   this file, so it is only ever touched from handlers). Each
 *                   one runs in a folder (tab.cwd), which is what names its chip
 *                   and what the session store rebuilds it from.
 * Exactly one child of #views is visible at a time; switching is a display swap,
 * never a teardown, so page state and live sessions both survive.
 *
 * New page tabs open the bundled newtab.html (resolved next to index.html). It
 * reads as "blank" in the omnibox and takes focus itself, so typing lands in its
 * own search field.
 *
 * Owned ids (agent D writes index.html):
 *   #tabstrip #newtab #newclaude #back #forward #reload #omnibox #zoom-badge
 *   #views #win-min #win-max #win-close #theme #titlebar #tabmenu
 * Body classes owned here: booted, maximized, acrylic, claude-live, tab-dragging.
 * Chip classes owned here: active, claude, live, loading, dragging, drag-shift,
 * broken, pinned, has-icon, split. Runtime panes owned here: #tabmenu rows,
 * .tab-card over a dead guest, and split view's .split-divider / .split-focus /
 * .split-scrim (siblings of the views in #views — a <webview> is never moved).
 * <html data-theme> is set before first paint by theme-boot.js and from here on.
 */

// The custom new-tab page ships next to index.html; resolving it against the
// chrome document keeps the absolute file:// path out of the source.
const NEWTAB_URL = new URL('newtab.html', window.location.href).href;
const HOME_URL = NEWTAB_URL;
const SEARCH_URL = 'https://www.google.com/search?q=';

// The new-tab page's own default shortcut chips (mirror of LINKS in newtab.js).
// settings.js seeds the editable list from here the first time it is changed.
window.DEFAULT_CHIPS = [
  { label: 'Wiki',    url: 'https://www.wikipedia.org' },
  { label: 'GitHub',  url: 'https://github.com' },
  { label: 'YouTube', url: 'https://www.youtube.com' },
  { label: 'Gmail',   url: 'https://mail.google.com' },
  { label: 'Claude',  url: 'https://claude.ai' },
];

/** The chosen search engine's results URL for a query; Google when settings are absent. */
function searchUrlFor(text) {
  const settings = window.Settings;
  if (settings && typeof settings.searchUrl === 'function') {
    try {
      const url = settings.searchUrl(text);
      if (typeof url === 'string' && url) return url;
    } catch (err) { /* fall through to the default engine */ }
  }
  return SEARCH_URL + encodeURIComponent(text);
}

/**
 * The new-tab page URL carrying everything it needs for its first paint: the
 * theme, and the accent / search engine / chips from settings when set. Later
 * changes are pushed into open pages by pushSettingsToTab.
 */
function newTabUrl() {
  const params = new URLSearchParams();
  params.set('theme', getTheme());
  const settings = window.Settings;
  if (settings && typeof settings.all === 'function') {
    try {
      const all = settings.all() || {};
      if (typeof all.accentHue === 'number' && isFinite(all.accentHue)) params.set('hue', String(all.accentHue));
      if (all.searchEngine && all.searchEngine !== 'google') params.set('engine', String(all.searchEngine));
      if (Array.isArray(all.chips)) params.set('chips', JSON.stringify(all.chips));
      if (all.palette && all.palette !== 'aurora') params.set('palette', String(all.palette));
      // Image users should never see the board flash before the picture (or
      // the clip, which arrives the same way) lands.
      const bgKind = (all.newtabBackground && all.newtabBackground.kind) || 'board';
      if (bgKind === 'aurora' || bgKind === 'image' || bgKind === 'video') params.set('bg', bgKind);
    } catch (err) { /* defaults are fine */ }
  }
  return NEWTAB_URL + '?' + params.toString();
}

/** Hand the current settings to one open new-tab guest (no-op for anything else). */
/**
 * The new-tab background (board / aurora / the user's image) is read from
 * IndexedDB by settings.js, so it travels separately from the plain settings.
 */
/**
 * The history page is a guest with no preload: it gets the whole list pushed
 * in and talks back through console lines that history.js knows how to parse.
 */
function isHistoryTab(tab) {
  const store = window.History;
  return !!(tab && tab.kind === 'page' && store && typeof store.isHistoryUrl === 'function'
    && store.isHistoryUrl(tab.url));
}

/*
 * Every push in this section is an executeJavaScript round trip into one guest,
 * and the chrome fires several of them at moments when nothing they carry has
 * moved: 'tabchange' hands the readout to every open new-tab page on every
 * single tab switch, carrying the same counts it carried a moment ago, and a
 * settings write hands every tab the same settings object again.
 *
 * The memo below drops a push whose payload is byte-for-byte what this guest
 * was last given — one IPC per guest per real change, instead of one per event.
 * Keyed on the ELEMENT like navCache, and cleared by dom-ready: a guest that
 * reloaded has forgotten everything and is pushed to again from scratch. A
 * push that fails to reach its guest un-records itself, so nothing is ever
 * skipped on the strength of a message that never landed.
 */
const pushMemo = new WeakMap();

/** True when this exact payload has already reached this guest. */
function pushUnchanged(tab, key, payload) {
  if (!tab || !tab.viewEl) return false;
  let seen = pushMemo.get(tab.viewEl);
  if (!seen) {
    seen = Object.create(null);
    pushMemo.set(tab.viewEl, seen);
  }
  if (seen[key] === payload) return true;
  seen[key] = payload;
  return false;
}

/** Undo the record above when the push it was taken for did not get through. */
function pushFailed(tab, key) {
  const seen = (tab && tab.viewEl) ? pushMemo.get(tab.viewEl) : null;
  if (seen) delete seen[key];
}

function dropPushMemo(tab) {
  if (tab && tab.viewEl) pushMemo.delete(tab.viewEl);
}

function pushHistoryToTab(tab) {
  const store = window.History;
  if (!store || typeof store.snapshot !== 'function') return;
  if (!isViewUsable(tab) || !isHistoryTab(tab)) return;
  try {
    const pending = tab.viewEl.executeJavaScript(
      'window.__applyHistory && window.__applyHistory(' + JSON.stringify(store.snapshot()) + ')'
    );
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (err) { /* guest went away */ }
}

function pushHistoryToAll() {
  for (const tab of tabs) pushHistoryToTab(tab);
}

function pushBackgroundToTab(tab) {
  const settings = window.Settings;
  if (!settings || typeof settings.background !== 'function') return;
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return;
  Promise.resolve()
    .then(() => settings.background())
    .then((bg) => {
      if (!bg || !isViewUsable(tab) || !isNewTabUrl(tab.url)) return;
      /* Exactly the fields the guest reads, and nothing else: the picture as a
         data URL, or the moving picture as the file:// URL of main's copy in
         <userData>/backgrounds/ (the name only so the page can pick <video>
         over <img> by extension). Never in the query string -- it is pushed. */
      const payload = { kind: bg.kind, boardOverImage: bg.boardOverImage, dim: bg.dim };
      if (typeof bg.dataUrl === 'string' && bg.dataUrl) payload.dataUrl = bg.dataUrl;
      if (bg.kind === 'video') {
        if (typeof bg.fileUrl === 'string' && bg.fileUrl) payload.fileUrl = bg.fileUrl;
        if (typeof bg.fileName === 'string' && bg.fileName) payload.fileName = bg.fileName;
      }
      const pending = tab.viewEl.executeJavaScript(
        'window.__applyBackground && window.__applyBackground(' + JSON.stringify(payload) + ')'
      );
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    })
    .catch(() => { /* guest went away, or no storage: the page keeps its default */ });
}

function pushSettingsToTab(tab) {
  const settings = window.Settings;
  if (!settings || typeof settings.all !== 'function') return;
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return;
  let all = null;
  try { all = settings.all(); } catch (err) { return; }
  const payload = JSON.stringify({
    accentHue: all.accentHue, searchEngine: all.searchEngine, chips: all.chips,
    palette: all.palette || null
  });
  // The store emits on every write, including ones this page cannot see.
  if (pushUnchanged(tab, 'settings', payload)) return;
  try {
    const pending = tab.viewEl.executeJavaScript(
      'window.__applySettings && window.__applySettings(' + payload + ')'
    );
    if (pending && typeof pending.catch === 'function') {
      pending.catch(() => pushFailed(tab, 'settings'));
    }
  } catch (err) { pushFailed(tab, 'settings'); /* guest went away mid-call */ }
}

/* ------------------------------------------------------------------ */
/* The new-tab readout                                                 */
/* ------------------------------------------------------------------ */

/*
 * The little live line on the new-tab page: how many tabs are open, how many
 * Claude chambers are live, and what Spotify auto-pause is doing right now.
 * The page is a guest on file:// and can see none of that for itself, so the
 * chrome pushes it — same shape, and the same two guards, as every other push
 * above.
 */

// Cached so a tab change never has to ask main again: main pushes every change
// down api.autopause.onStatus, and that is what refreshes this.
let autopauseReadout = 'unknown';

/** One autopause status object -> the four words the page understands. */
function autopauseWord(status) {
  if (!status || typeof status !== 'object') return 'unknown';
  // A hold that is actually out beats the switch: that is the state the user
  // can hear. `wePaused` is the bridge's word for it, `browserHold` is ours.
  if (status.browserHold || status.wePaused) return 'holding';
  if (status.enabled && status.bridge === 'running') return 'on';
  return 'off';
}

function readoutSnapshot() {
  let claude = 0;
  for (const tab of tabs) if (isClaudeTab(tab) && tab.live) claude += 1;
  // Every open tab, in every workspace: the page is describing the browser,
  // not the strip in front of it.
  return { tabs: tabs.length, claude: claude, autopause: autopauseReadout };
}

/** Hand the readout to one open new-tab guest (no-op for anything else). */
function pushReadoutToTab(tab) {
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return;
  const payload = JSON.stringify(readoutSnapshot());
  // Same three numbers as last time: the page is already showing them.
  if (pushUnchanged(tab, 'readout', payload)) return;
  try {
    const pending = tab.viewEl.executeJavaScript(
      'window.__applyReadout && window.__applyReadout(' + payload + ')'
    );
    if (pending && typeof pending.catch === 'function') {
      pending.catch(() => pushFailed(tab, 'readout'));
    }
  } catch (err) { pushFailed(tab, 'readout'); /* guest went away mid-call */ }
}

function pushReadoutToAll() {
  for (const tab of tabs) pushReadoutToTab(tab);
}

/**
 * Called once from init(): seed the cached word with one status() call, then
 * follow main's pushes for the rest of the window's life. Feature-detected —
 * a preload without the group leaves the readout saying 'unknown'.
 */
function wireAutopauseReadout() {
  const ap = (window.api && window.api.autopause) ? window.api.autopause : null;
  if (!ap) return;
  if (typeof ap.onStatus === 'function') {
    ap.onStatus((status) => {
      const word = autopauseWord(status);
      if (word === autopauseReadout) return; // nothing moved: no guest work
      autopauseReadout = word;
      pushReadoutToAll();
    });
  }
  if (typeof ap.status !== 'function') return;
  Promise.resolve()
    .then(() => ap.status())
    .then((status) => {
      const word = autopauseWord(status);
      if (word === autopauseReadout) return;
      autopauseReadout = word;
      pushReadoutToAll();
    })
    .catch(() => { /* nothing running: 'unknown' is the honest answer */ });
}

/* ------------------------------------------------------------------ */
/* The new-tab stats strip                                             */
/* ------------------------------------------------------------------ */

/*
 * Main samples the machine (CPU, memory, disk, network, GPU) only while
 * somebody is listening, so the chrome's whole job here is to hold that
 * subscription open for exactly as long as a new-tab page is IN FRONT of a
 * focused window, and to hand each sample to that one guest.
 *
 * Background new-tab pages get nothing: they are not on screen, and the
 * sampler — a long-lived typeperf child in main — is the expensive half. A
 * quick switch away and back costs nothing either: main keeps the child alive
 * for a few seconds after the count hits zero, so the pair of calls below is
 * cheap even when it happens twice in a second.
 *
 * Every call into the preload is feature-detected: an older preload with no
 * api.stats leaves the page showing dashes rather than throwing.
 */

// True while our subscribe() is outstanding. Every transition goes through
// syncStatsSubscription(), so main is never told the same thing twice.
let statsSubscribed = false;

/** The preload's stats group, or null when this build has none. */
function statsApi() {
  const api = (window.api && window.api.stats) ? window.api.stats : null;
  if (!api) return null;
  if (typeof api.subscribe !== 'function' || typeof api.unsubscribe !== 'function') return null;
  return api;
}

/**
 * Hand one sample to one open new-tab guest (no-op for anything else).
 *
 * Same two guards as every other push in this file, and deliberately NO memo:
 * consecutive samples differ by definition, and a dropped one is a gap in the
 * page's graph rather than a saved round trip.
 */
function pushStatsToTab(tab, sample) {
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return;
  if (!sample || typeof sample !== 'object') return;
  let payload = '';
  try { payload = JSON.stringify(sample); } catch (err) { return; }
  try {
    const pending = tab.viewEl.executeJavaScript(
      'window.__applyStats && window.__applyStats(' + payload + ')'
    );
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (err) { /* guest went away mid-call */ }
}

/** True when this tab is a new-tab page that is willing to show stats. */
function statsTabEligible(tab) {
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return false;
  // Only a page that said so OUT LOUD opts out; an older guest, or one whose
  // answer has not come back yet, is treated as wanting them.
  return tab.statsWanted !== false;
}

/**
 * The one rule: subscribed exactly while a usable new-tab guest is the active
 * tab and the window is focused. Called from every edge that can move either
 * half — activation, dom-ready, close, window focus — and idempotent, so a
 * caller never has to work out whether anything actually changed.
 */
function syncStatsSubscription() {
  const api = statsApi();
  if (!api) return;
  const want = !windowBlurred && statsTabEligible(getActiveTab());
  if (want === statsSubscribed) return;
  statsSubscribed = want;
  try {
    if (want) api.subscribe();
    else api.unsubscribe();
  } catch (err) { /* main went away: the next edge tries again */ }
}

/**
 * Ask a freshly loaded new-tab guest whether it wants stats at all, once per
 * document, and cache the answer on the tab. A page that never defines
 * `window.__statsWanted` is answering "yes".
 */
function queryStatsWanted(tab) {
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return;
  const viewEl = tab.viewEl;
  let pending = null;
  try {
    pending = viewEl.executeJavaScript(
      'typeof window.__statsWanted === "boolean" ? window.__statsWanted : true'
    );
  } catch (err) { return; }
  if (!pending || typeof pending.then !== 'function') return;
  pending.then((wanted) => {
    if (tab.viewEl !== viewEl) return; // the guest was replaced mid-flight
    tab.statsWanted = wanted !== false;
    syncStatsSubscription();
  }, () => { /* guest went away: it keeps the default */ });
}

/**
 * Called once from init(): one listener for the life of the window, forwarding
 * each sample to whichever new-tab page is in front. Samples that land while a
 * web page is active are dropped here — the unsubscribe is already on its way,
 * and main's grace period means a few can still arrive after it.
 */
function wireStats() {
  const api = statsApi();
  if (!api || typeof api.onSample !== 'function') return;
  try {
    api.onSample((sample) => {
      // The app dock's running dots come out of the same sample, and they are
      // kept up to date whoever is in front: the palette reads this map too.
      syncAppsRunning(sample);
      const tab = getActiveTab();
      if (!tab || !isNewTabUrl(tab.url)) return;
      pushStatsToTab(tab, sample);
      // The icons for this sample's rows, if any of them are new to us.
      requestProcIcons(sample);
    });
  } catch (err) { /* older preload: the page keeps its dashes */ }
}

/* ------------------------------------------------------------------ */
/* Process icons for the new tab's process table                       */
/* ------------------------------------------------------------------ */

/*
 * Each row of the process table shows the icon of the executable behind it.
 * Main resolves and caches those (procicons.js); this side keeps a copy for the
 * life of the window so a re-render, a reload or a second new-tab page costs no
 * IPC at all, and so the same key is never asked for twice.
 *
 * The samples arrive every second and the answer never changes that fast, so
 * the asking is deliberately lazy: only keys we have no icon for, at most one
 * request in flight, never more than one every PROC_ICON_MIN_GAP_MS, and a key
 * that came back without an icon is left alone for PROC_ICON_NULL_RETRY_MS
 * (that is the case where main had to spawn to find out, and the answer is
 * usually going to be the same the next time).
 */

/** A key that came back with no icon is not asked about again for this long. */
const PROC_ICON_NULL_RETRY_MS = 5 * 60 * 1000;
/** The floor between two requests, however fast the samples come. */
const PROC_ICON_MIN_GAP_MS = 3000;
/** Main's own limits, so a request is never trimmed on the other side. */
const PROC_ICON_MAX_KEYS = 64;
const PROC_ICON_MAX_KEY_LEN = 64;
/** Distinct process keys one window will remember. Oldest answer goes first. */
const PROC_ICON_CACHE_MAX = 300;

/** key -> { dataUrl: string|null, at: ms the ANSWER landed }. */
const procIconCache = new Map();
/** One request at a time, and when the last one went out. */
let procIconInFlight = false;
let procIconLastAsk = 0;

/** The clock, as one call: the harness replaces this to test the windows. */
function procIconNow() { return Date.now(); }

/**
 * Which of these process groups still need an icon: ones we have never asked
 * about, and ones whose "no icon" answer has gone stale. Deduped and capped to
 * what main will accept in one call.
 */
function procIconsMissing(groups, now) {
  const out = [];
  if (!Array.isArray(groups)) return out;
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const key = typeof group.key === 'string' ? group.key : '';
    if (!key || key.length > PROC_ICON_MAX_KEY_LEN) continue;
    if (out.indexOf(key) !== -1) continue;
    const entry = procIconCache.get(key);
    if (entry && entry.dataUrl) continue;                       // already have it
    if (entry && now - entry.at < PROC_ICON_NULL_RETRY_MS) continue; // asked lately
    out.push(key);
    if (out.length >= PROC_ICON_MAX_KEYS) break;
  }
  return out;
}

/** Oldest answers out, so a long-lived window cannot grow without a bound. */
function trimProcIconCache() {
  if (procIconCache.size <= PROC_ICON_CACHE_MAX) return;
  const oldest = Array.from(procIconCache.entries())
    .sort((a, b) => (a[1] ? a[1].at : 0) - (b[1] ? b[1].at : 0));
  for (const [key] of oldest) {
    if (procIconCache.size <= PROC_ICON_CACHE_MAX) break;
    procIconCache.delete(key);
  }
}

/**
 * Fold one answer into the cache and give back exactly what to push: the keys
 * main answered, plus the ones it did not (recorded as "no icon" so a build
 * whose main cannot answer is asked once every five minutes, not every 3 s).
 */
function mergeProcIcons(map, now, asked) {
  const out = {};
  const answer = (map && typeof map === 'object') ? map : {};
  const keys = [];
  for (const key of Object.keys(answer)) keys.push(key);
  if (Array.isArray(asked)) {
    for (const key of asked) if (keys.indexOf(key) === -1) keys.push(key);
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !key || key.length > PROC_ICON_MAX_KEY_LEN) continue;
    const raw = answer[key];
    // Only a data URL is an icon; anything else (a path, a number, undefined
    // for a key main dropped) is recorded as "none for now".
    const dataUrl = (typeof raw === 'string' && raw.slice(0, 5) === 'data:') ? raw : null;
    procIconCache.set(key, { dataUrl: dataUrl, at: now });
    out[key] = dataUrl;
  }
  trimProcIconCache();
  return out;
}

/**
 * Hand a map of icons to one open new-tab guest. Same two guards as every other
 * push in this file, and no memo: each key is pushed once per answer, and the
 * page merges rather than rebuilding its rows.
 */
function pushProcIconsToTab(tab, map) {
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return false;
  if (!map || typeof map !== 'object') return false;
  if (!Object.keys(map).length) return false;
  let payload = '';
  try { payload = JSON.stringify(map); } catch (err) { return false; }
  try {
    const pending = tab.viewEl.executeJavaScript(
      'window.__applyProcIcons && window.__applyProcIcons(' + payload + ')'
    );
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (err) { return false; /* guest went away mid-call */ }
  return true;
}

/**
 * Everything we know, once, for a guest that has just loaded: a reload, a
 * second new-tab page, or the first sample landing after the page is up. The
 * page has no icons of its own, and this is cheaper than re-resolving them.
 */
function pushProcIconCacheToTab(tab) {
  if (!procIconCache.size) return false;
  const map = {};
  for (const [key, entry] of procIconCache) map[key] = (entry && entry.dataUrl) || null;
  return pushProcIconsToTab(tab, map);
}

/**
 * One sample's worth of asking. Returns true when a request actually went out,
 * which is what the harness checks.
 */
function requestProcIcons(sample) {
  const api = statsApi();
  if (!api || typeof api.procIcons !== 'function') return false; // older preload
  const tab = getActiveTab();
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return false;
  if (procIconInFlight) return false;
  const now = procIconNow();
  if (procIconLastAsk && now - procIconLastAsk < PROC_ICON_MIN_GAP_MS) return false;

  const procs = (sample && typeof sample === 'object') ? sample.procs : null;
  const groups = (procs && Array.isArray(procs.top)) ? procs.top : [];
  const keys = procIconsMissing(groups, now);
  if (!keys.length) return false;   // every row is known: nothing runs anywhere

  let pending = null;
  procIconInFlight = true;
  procIconLastAsk = now;
  try { pending = api.procIcons(keys); } catch (err) { procIconInFlight = false; return false; }
  if (!pending || typeof pending.then !== 'function') { procIconInFlight = false; return false; }
  pending.then((map) => {
    procIconInFlight = false;
    const answered = mergeProcIcons(map, procIconNow(), keys);
    // Whoever is in front NOW -- the answer may have outlived the tab that
    // prompted it, and the guest that replaced it wants the same icons.
    pushProcIconsToTab(getActiveTab(), answered);
  }, () => { procIconInFlight = false; /* the next sample tries again */ });
  return true;
}

/* ------------------------------------------------------------------ */
/* End task, asked for over the console channel                        */
/* ------------------------------------------------------------------ */

/*
 * The new tab page is a guest with no preload, so it cannot call api.stats
 * itself. It asks the same way the history page does — one console line the
 * chrome is listening for:
 *
 *   newtab:end-task {"pids":[123,456],"key":"claude"}
 *
 * and the answer comes back on window.__applyEndTask({ key, results }) through
 * the same executeJavaScript push the readout and the samples use. The key is
 * the page's own row id, echoed untouched, so a slow answer still lands on the
 * right row. Anything that is not exactly this shape is ignored in silence: a
 * console line is not a trusted channel, and pids end processes.
 */

const END_TASK_PREFIX = 'newtab:end-task ';

/** The page may ask about at most this many pids at once; main caps it too. */
const END_TASK_MAX_PIDS = 64;

/**
 * Parse one console line into { pids, key }, or null when it is not an
 * end-task request or not a well-formed one. Pure, and the whole of the
 * validation: too many pids, a non-integer pid, a missing key and a broken
 * payload all come back null rather than partly honoured.
 */
function parseEndTaskLine(text) {
  if (typeof text !== 'string') return null;
  const line = text.trim();
  if (line.indexOf(END_TASK_PREFIX) !== 0) return null;

  let msg = null;
  try { msg = JSON.parse(line.slice(END_TASK_PREFIX.length)); } catch (err) { return null; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (typeof msg.key !== 'string' || !msg.key) return null;
  if (!Array.isArray(msg.pids) || !msg.pids.length) return null;
  if (msg.pids.length > END_TASK_MAX_PIDS) return null;

  const pids = [];
  for (const raw of msg.pids) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null;
    if (pids.indexOf(raw) === -1) pids.push(raw);
  }
  if (!pids.length) return null;
  return { pids: pids, key: msg.key };
}

/** Hand one end-task answer back to the guest that asked for it. */
function pushEndTaskToTab(tab, viewEl, key, results) {
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return;
  if (tab.viewEl !== viewEl) return; // the guest was replaced mid-flight
  let payload = '';
  try {
    payload = JSON.stringify({ key: key, results: Array.isArray(results) ? results : [] });
  } catch (err) { return; }
  try {
    const pending = viewEl.executeJavaScript(
      'window.__applyEndTask && window.__applyEndTask(' + payload + ')'
    );
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (err) { /* guest went away mid-call */ }
}

/**
 * One console line from one guest. Honoured only for a new-tab page whose
 * viewEl is still the one the listener was attached to — any other guest can
 * print the same line and nothing happens. Returns true when a request was
 * actually sent, which is what the harness checks.
 */
function handleEndTaskLine(tab, viewEl, text) {
  if (!tab || tab.viewEl !== viewEl) return false;
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return false;
  const req = parseEndTaskLine(text);
  if (!req) return false;

  const api = (window.api && window.api.stats) ? window.api.stats : null;
  if (!api || typeof api.endTask !== 'function') {
    pushEndTaskToTab(tab, viewEl, req.key,
      req.pids.map((pid) => ({ pid: pid, ok: false, reason: 'unavailable' })));
    return true;
  }

  let pending = null;
  try { pending = api.endTask(req.pids); } catch (err) { return false; }
  if (!pending || typeof pending.then !== 'function') {
    pushEndTaskToTab(tab, viewEl, req.key, pending);
    return true;
  }
  pending.then(
    (results) => pushEndTaskToTab(tab, viewEl, req.key, results),
    () => pushEndTaskToTab(tab, viewEl, req.key,
      req.pids.map((pid) => ({ pid: pid, ok: false, reason: 'failed' })))
  );
  return true;
}

/* ------------------------------------------------------------------ */
/* Native apps on the new tab page                                     */
/* ------------------------------------------------------------------ */

/*
 * The new tab page shows a dock of pinned native apps, and the palette offers
 * "Open <name>" for every installed one. Neither of them can see a .lnk or a
 * process, so this section is the whole of the chrome's half:
 *
 *   pins       Settings.appPins() -> ids, joined against the installed index
 *   installed  api.apps.list(), cached here for the life of the window
 *   running    derived from the stats sample the strip already receives
 *
 * Pushes go out as window.__applyApps({ pins, installed }) on dom-ready and
 * whenever the pins change, and as window.__applyAppsRunning(diff) on the
 * samples where a pin actually started or stopped — a whole dock per second
 * would be an IPC and a re-render for nothing.
 *
 * Requests come back the same preload-less way end-task does: one console
 * line, `newtab:app {json}`, answered on window.__applyAppResult.
 *
 * EVERY call into the preload is feature-detected. api.apps belongs to a
 * later build than some of these guests, and a browser without it shows an
 * empty dock and no palette rows rather than throwing.
 */

/* --- the bridge, and the shapes derived from it -------------------- */

/** The preload's apps group, or null when this build has none. */
function appsApi() {
  const api = (window.api && window.api.apps) ? window.api.apps : null;
  if (!api || typeof api !== 'object') return null;
  return api;
}

/** The pinned ids, or [] when settings.js is not loaded yet. */
function appPinIds() {
  const settings = window.Settings;
  if (!settings || typeof settings.appPins !== 'function') return [];
  let ids = null;
  try { ids = settings.appPins(); } catch (err) { return []; }
  return Array.isArray(ids) ? ids.slice() : [];
}

/*
 * The installed index, fetched once and kept: a rebuild is minutes of work in
 * main, and nothing in it changes while the window is open unless the user
 * asks for a refresh (which clears this). `appsIndexPending` makes the fetch
 * idempotent, so four guests loading at once cost one IPC.
 */
let appsIndex = null;          // { builtAt, apps: [...] } once it has landed
let appsIndexPending = null;   // the in-flight promise, if any

/**
 * The index, on a promise that always resolves: null when there is no bridge,
 * no answer, or a malformed one. Never rejects, so no caller needs a catch.
 */
function ensureAppsIndex() {
  if (appsIndex) return Promise.resolve(appsIndex);
  if (appsIndexPending) return appsIndexPending;
  const api = appsApi();
  if (!api || typeof api.list !== 'function') return Promise.resolve(null);
  let pending = null;
  try { pending = api.list(); } catch (err) { return Promise.resolve(null); }
  if (!pending || typeof pending.then !== 'function') {
    appsIndex = normalizeAppsIndex(pending);
    return Promise.resolve(appsIndex);
  }
  appsIndexPending = Promise.resolve(pending).then((answer) => {
    appsIndexPending = null;
    appsIndex = normalizeAppsIndex(answer);
    return appsIndex;
  }, () => {
    appsIndexPending = null;
    return null;   // main could not build it: the dock stays empty this time
  });
  return appsIndexPending;
}

/** Anything main hands over read as { builtAt, apps: [...] }, or null. */
function normalizeAppsIndex(answer) {
  if (!answer || typeof answer !== 'object') return null;
  const list = Array.isArray(answer.apps) ? answer.apps : (Array.isArray(answer) ? answer : null);
  if (!list) return null;
  const apps = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!id || !name) continue;
    apps.push({
      id: id,
      name: name,
      kind: entry.kind === 'store' ? 'store' : 'exe',
      exe: typeof entry.exe === 'string' && entry.exe ? entry.exe : null,
      iconDataUrl: typeof entry.iconDataUrl === 'string' && entry.iconDataUrl
        ? entry.iconDataUrl : null
    });
  }
  const builtAt = typeof answer.builtAt === 'number' ? answer.builtAt : 0;
  return { builtAt: builtAt, apps: apps };
}

/** The entries the chrome knows about right now (never null). */
function appsList() {
  return appsIndex ? appsIndex.apps : [];
}

function appById(id) {
  const list = appsList();
  for (const entry of list) if (entry.id === id) return entry;
  return null;
}

/* --- running state, derived from the stats sample ------------------ */

/*
 * The sampler's process groups are keyed on the perfmon instance name, which
 * is the executable's base name with no extension ('Spotify', 'chrome'). A
 * pin carries the basename WITH it ('spotify.exe'), so one of the two has to
 * be trimmed: that is the whole of the match, plus case, because perfmon's
 * casing is the binary's and a shortcut's target is whatever was typed.
 */

/** 'C:\x\Spotify.exe' or 'Spotify.exe' -> 'spotify'. '' for anything else. */
function procKeyForExe(exe) {
  if (typeof exe !== 'string') return '';
  let text = exe.trim();
  if (!text) return '';
  const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
  if (cut >= 0) text = text.slice(cut + 1);
  text = text.toLowerCase();
  if (text.length > 4 && text.slice(-4) === '.exe') text = text.slice(0, -4);
  return text;
}

// The last sample from main, kept so a fresh guest and the palette can both be
// told what is running without waiting for the next second to come round.
let lastStatsSample = null;

/** The process groups in the last sample (never null). */
function lastProcGroups() {
  const procs = (lastStatsSample && typeof lastStatsSample === 'object')
    ? lastStatsSample.procs : null;
  const top = (procs && typeof procs === 'object') ? procs.top : null;
  return Array.isArray(top) ? top : [];
}

/** { running, pids } for one app's exe against one list of process groups. */
function runningForExe(exe, groups) {
  const key = procKeyForExe(exe);
  if (!key) return { running: false, pids: [] };
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    if (typeof group.key !== 'string') continue;
    if (group.key.toLowerCase() !== key) continue;
    const pids = [];
    if (Array.isArray(group.pids)) {
      for (const pid of group.pids) {
        if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) pids.push(pid);
      }
    }
    return { running: true, pids: pids };
  }
  return { running: false, pids: [] };
}

/**
 * The running map for every app the chrome knows about: the pins (so the dock
 * is right even before the index has landed) and the whole index (so the
 * palette can hint at an app the dock has never shown).
 */
function computeAppRunning(pins, groups) {
  const out = Object.create(null);
  const seen = Object.create(null);
  const consider = (entry) => {
    if (!entry || !entry.id || seen[entry.id]) return;
    seen[entry.id] = true;
    out[entry.id] = runningForExe(entry.exe, groups);
  };
  for (const id of (Array.isArray(pins) ? pins : [])) consider(appById(id) || { id: id, exe: null });
  for (const entry of appsList()) consider(entry);
  return out;
}

// id -> { running, pids } as of the last sample. Replaced wholesale, so a
// reader never sees half of one update.
let appRunning = Object.create(null);

/** True when two { running, pids } entries say the same thing. */
function sameAppRunning(one, two) {
  if (!one || !two) return false;
  if (!one.running !== !two.running) return false;
  const p1 = Array.isArray(one.pids) ? one.pids : [];
  const p2 = Array.isArray(two.pids) ? two.pids : [];
  if (p1.length !== p2.length) return false;
  for (let i = 0; i < p1.length; i++) if (p1[i] !== p2[i]) return false;
  return true;
}

/** True when these two maps say anything different at all. */
function appRunningDiffers(a, b) {
  for (const k in a) if (!(k in b) || !sameAppRunning(a[k], b[k])) return true;
  for (const k in b) if (!(k in a)) return true;
  return false;
}

/** Only the ids whose state moved between two maps — what the guest is sent. */
function appRunningDiff(before, after) {
  const out = {};
  for (const k in after) {
    if (!sameAppRunning(before[k], after[k])) out[k] = after[k];
  }
  // An id that has left the map (the index was refreshed) is reported as
  // stopped rather than dropped: the dot has to come off the tile.
  for (const k in before) {
    if (!(k in after)) out[k] = { running: false, pids: [] };
  }
  return out;
}

/**
 * Read by tabsearch.js, which needs to know whether an app is already up
 * before it offers to launch it. A copy: the palette must never be able to
 * edit the chrome's state by holding onto the object.
 */
function appRunningState() {
  const out = {};
  for (const k in appRunning) {
    out[k] = { running: !!appRunning[k].running, pids: (appRunning[k].pids || []).slice() };
  }
  return out;
}

/**
 * Called from the stats listener with every sample. The map is recomputed
 * each time (it is a handful of string compares) but only a real change
 * reaches a guest.
 */
function syncAppsRunning(sample) {
  lastStatsSample = (sample && typeof sample === 'object') ? sample : null;
  const next = computeAppRunning(appPinIds(), lastProcGroups());
  if (!appRunningDiffers(appRunning, next)) return false;
  const diff = appRunningDiff(appRunning, next);
  appRunning = next;
  for (const tab of tabs) pushAppsRunning(tab, diff);
  return true;
}

/** Hand one running-state diff to one open new-tab guest. */
function pushAppsRunning(tab, diff) {
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return;
  if (!diff || typeof diff !== 'object') return;
  let keys = null;
  try { keys = Object.keys(diff); } catch (err) { return; }
  if (!keys || !keys.length) return;
  let payload = '';
  try { payload = JSON.stringify(diff); } catch (err) { return; }
  try {
    const pending = tab.viewEl.executeJavaScript(
      'window.__applyAppsRunning && window.__applyAppsRunning(' + payload + ')'
    );
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (err) { /* guest went away mid-call */ }
}

/* --- the dock push ------------------------------------------------- */

/**
 * One dock, as the page reads it: the pins with everything they need to draw
 * (icon included) and the installed list with only what the picker needs to
 * filter on. Icons are the heavy half — a 32px PNG data URL each — so they go
 * only to the pins.
 */
function appsPayload() {
  const groups = lastProcGroups();
  const pins = [];
  for (const id of appPinIds()) {
    const entry = appById(id);
    // A pin whose app is not in the index (uninstalled, or the index has not
    // landed) is left out of the drawing and kept in the settings: it comes
    // back on its own if the app does.
    if (!entry) continue;
    const state = appRunning[id] || runningForExe(entry.exe, groups);
    pins.push({
      id: entry.id,
      name: entry.name,
      iconDataUrl: entry.iconDataUrl || null,
      exe: entry.exe || null,
      running: !!state.running,
      pids: (state.pids || []).slice()
    });
  }
  const installed = appsList().map((entry) => ({
    id: entry.id, name: entry.name, kind: entry.kind, exe: entry.exe || null
  }));
  return { pins: pins, installed: installed };
}

/**
 * Push the dock to one new-tab guest. Asynchronous only because the index may
 * still be on its way; once it is in hand this is one memoised IPC, and a
 * build with no api.apps pushes an empty dock (the page clears its row rather
 * than keeping a stale one).
 */
function pushAppsToTab(tab) {
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return;
  const viewEl = tab.viewEl;
  ensureAppsIndex().then(() => {
    if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return;
    if (tab.viewEl !== viewEl) return;   // the guest was replaced mid-flight
    // The first push is also what seeds the running map for the palette, on a
    // window where no sample has arrived yet.
    if (!Object.keys(appRunning).length) {
      appRunning = computeAppRunning(appPinIds(), lastProcGroups());
    }
    let payload = '';
    try { payload = JSON.stringify(appsPayload()); } catch (err) { return; }
    if (pushUnchanged(tab, 'apps', payload)) return;
    try {
      const pending = viewEl.executeJavaScript(
        'window.__applyApps && window.__applyApps(' + payload + ')'
      );
      if (pending && typeof pending.catch === 'function') {
        pending.catch(() => pushFailed(tab, 'apps'));
      }
    } catch (err) { pushFailed(tab, 'apps'); /* guest went away mid-call */ }
  }, () => { /* ensureAppsIndex never rejects; here for the contract */ });
}

function pushAppsToAll() {
  for (const tab of tabs) pushAppsToTab(tab);
}

/* --- newtab:app, asked for over the console channel ---------------- */

/*
 * Exactly the end-task channel, one door down:
 *
 *   newtab:app {"action":"launch","id":"a1b2c3"}
 *   newtab:app {"action":"focus","pid":1234}
 *   newtab:app {"action":"pin","id":"a1b2c3"}
 *   newtab:app {"action":"unpin","id":"a1b2c3"}
 *   newtab:app {"action":"refresh"}
 *
 * and the answer on window.__applyAppResult({ action, id, ok, reason }).
 * Same reasoning as there: a console line is not a trusted channel, so
 * anything that is not exactly one of these five shapes is ignored in
 * silence, and only the guest the listener was attached to is heard.
 */

const APP_PREFIX = 'newtab:app ';

/** An id is a hash; a pid is a pid. Neither is ever this long. */
const APP_ID_MAX = 200;

/**
 * Parse one console line into { action, id, pid }, or null when it is not an
 * app request or not a well-formed one. Pure, and the whole of the
 * validation: a missing id, a fractional pid or a made-up action all come
 * back null rather than partly honoured.
 */
function parseAppLine(text) {
  if (typeof text !== 'string') return null;
  const line = text.trim();
  if (line.indexOf(APP_PREFIX) !== 0) return null;

  let msg = null;
  try { msg = JSON.parse(line.slice(APP_PREFIX.length)); } catch (err) { return null; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const action = msg.action;
  if (action !== 'launch' && action !== 'focus' && action !== 'pin'
    && action !== 'unpin' && action !== 'refresh') return null;

  if (action === 'refresh') return { action: action, id: '', pid: 0 };

  if (action === 'focus') {
    const pid = msg.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    const id = typeof msg.id === 'string' && msg.id.length <= APP_ID_MAX ? msg.id : '';
    return { action: action, id: id, pid: pid };
  }

  if (typeof msg.id !== 'string') return null;
  const id = msg.id.trim();
  if (!id || id.length > APP_ID_MAX) return null;
  return { action: action, id: id, pid: 0 };
}

/** Hand one answer back to the guest that asked for it. */
function pushAppResult(tab, viewEl, result) {
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return;
  if (tab.viewEl !== viewEl) return;   // the guest was replaced mid-flight
  let payload = '';
  try {
    payload = JSON.stringify({
      action: String(result && result.action || ''),
      id: String(result && result.id || ''),
      ok: !!(result && result.ok),
      reason: (result && typeof result.reason === 'string') ? result.reason : ''
    });
  } catch (err) { return; }
  try {
    const pending = viewEl.executeJavaScript(
      'window.__applyAppResult && window.__applyAppResult(' + payload + ')'
    );
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (err) { /* guest went away mid-call */ }
}

/** One api.apps call, whatever it answers with, as one pushed result. */
function answerAppCall(tab, viewEl, req, pending) {
  if (!pending || typeof pending.then !== 'function') {
    const ok = !!(pending && pending.ok);
    pushAppResult(tab, viewEl, {
      action: req.action, id: req.id, ok: ok,
      reason: (pending && pending.reason) || (ok ? '' : 'failed')
    });
    return;
  }
  pending.then((answer) => {
    const ok = !!(answer && answer.ok);
    pushAppResult(tab, viewEl, {
      action: req.action, id: req.id, ok: ok,
      reason: (answer && answer.reason) || (ok ? '' : 'failed')
    });
  }, () => {
    pushAppResult(tab, viewEl, { action: req.action, id: req.id, ok: false, reason: 'failed' });
  });
}

/**
 * One console line from one guest. Honoured only for a new-tab page whose
 * viewEl is still the one the listener was attached to — any other guest can
 * print the same line and nothing happens. Returns true when the request was
 * acted on (or answered 'unavailable'), which is what the harness checks.
 */
function handleAppLine(tab, viewEl, text) {
  if (!tab || tab.viewEl !== viewEl) return false;
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return false;
  const req = parseAppLine(text);
  if (!req) return false;

  // Pins are the chrome's own state: they work with no bridge at all.
  if (req.action === 'pin' || req.action === 'unpin') {
    const settings = window.Settings;
    if (!settings || typeof settings.setAppPins !== 'function') {
      pushAppResult(tab, viewEl, { action: req.action, id: req.id, ok: false, reason: 'unavailable' });
      return true;
    }
    const ids = appPinIds();
    const at = ids.indexOf(req.id);
    if (req.action === 'pin') { if (at === -1) ids.push(req.id); }
    else { if (at >= 0) ids.splice(at, 1); }
    let ok = true;
    try { settings.setAppPins(ids); } catch (err) { ok = false; }
    // The settings listener wired in wireSettings() re-pushes every dock.
    pushAppResult(tab, viewEl, {
      action: req.action, id: req.id, ok: ok, reason: ok ? '' : 'failed'
    });
    return true;
  }

  const api = appsApi();
  const method = req.action === 'launch' ? 'launch'
    : (req.action === 'focus' ? 'focus' : 'refresh');
  if (!api || typeof api[method] !== 'function') {
    pushAppResult(tab, viewEl, { action: req.action, id: req.id, ok: false, reason: 'unavailable' });
    return true;
  }

  let pending = null;
  try {
    if (req.action === 'launch') pending = api.launch(req.id);
    else if (req.action === 'focus') pending = api.focus(req.pid);
    else pending = api.refresh();
  } catch (err) {
    pushAppResult(tab, viewEl, { action: req.action, id: req.id, ok: false, reason: 'failed' });
    return true;
  }

  if (req.action === 'refresh') {
    // Whatever main answers, the cached index is now stale: drop it, re-fetch
    // it, and hand the new one to every dock and to the palette.
    appsIndex = null;
    appsIndexPending = null;
    const done = () => {
      appsIndex = null;
      appsIndexPending = null;
      ensureAppsIndex().then(() => {
        appRunning = computeAppRunning(appPinIds(), lastProcGroups());
        pushAppsToAll();
        notifyAppsChanged();
      }, () => {});
    };
    if (pending && typeof pending.then === 'function') pending.then(done, done);
    else done();
  }

  answerAppCall(tab, viewEl, req, pending);
  return true;
}

/** The palette caches its own copy of the list; tell it to drop that. */
function notifyAppsChanged() {
  const ts = window.TabSearch;
  if (!ts || typeof ts.appsChanged !== 'function') return;
  try { ts.appsChanged(); } catch (err) { /* the palette can look after itself */ }
}

// How many recent sites the new-tab page is given. Its own layout decides how
// many of them it shows.
const RECENT_SITES = 8;

/**
 * The new-tab page cannot read the history store (it is a guest, on file://),
 * so the chrome hands it the list. history.js is optional, and a missing store
 * pushes an empty list rather than nothing: the page still clears its section.
 */
function recentSites(limit) {
  const store = window.History;
  if (!store || typeof store.recent !== 'function') return [];
  let rows = null;
  try { rows = store.recent(limit); } catch (err) { return []; }
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    url: (row && row.url) || '',
    title: (row && row.title) || '',
    last: (row && row.last) || 0
  }));
}

/** Hand the recent list to one open new-tab guest (no-op for anything else). */
function pushRecentToTab(tab) {
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return;
  const payload = JSON.stringify(recentSites(RECENT_SITES));
  // Nothing new has been visited since this page was last given the list.
  if (pushUnchanged(tab, 'recent', payload)) return;
  try {
    const pending = tab.viewEl.executeJavaScript(
      'window.__applyRecent && window.__applyRecent(' + payload + ')'
    );
    if (pending && typeof pending.catch === 'function') {
      pending.catch(() => pushFailed(tab, 'recent'));
    }
  } catch (err) { pushFailed(tab, 'recent'); /* guest went away mid-call */ }
}

// Panes with a backdrop-filter over the new-tab page make its animated board
// re-blur every frame (+11% CPU measured). While any of them is open, the
// active new-tab guest is told to freeze; it resumes when the last one closes.
const OVERLAY_IDS = [
  'settings-panel', 'tabsearch', 'downloads-panel', 'shield-panel',
  'siteinfo-panel', 'omni-suggest', 'tabmenu', 'findbar', 'bm-overflow'
];
let overlayOpenLast = null;

function anyOverlayOpen() {
  return OVERLAY_IDS.some((id) => {
    const el = document.getElementById(id);
    return !!el && !el.hidden && getComputedStyle(el).display !== 'none';
  });
}

function pushBoardPaused(tab, paused) {
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return;
  try {
    const pending = tab.viewEl.executeJavaScript(
      'window.__boardPaused && window.__boardPaused(' + (paused ? 'true' : 'false') + ')'
    );
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (err) { /* guest went away */ }
}

let windowBlurred = false;

// The board also freezes while the whole window is behind something else:
// visible-but-unfocused is the common laptop case and the GPU cost is real.
function syncBoardPause() {
  const open = anyOverlayOpen() || windowBlurred;
  if (open === overlayOpenLast) return;
  overlayOpenLast = open;
  for (const tab of tabs) pushBoardPaused(tab, open);
}

function wireOverlayWatch() {
  // The panels toggle `hidden`; the menus and suggestions toggle it too, so one
  // attribute observer on the whole document catches every one of them.
  const observer = new MutationObserver(() => syncBoardPause());
  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['hidden'] });

  // The REAL window's focus, from main. This document's own blur/focus is the
  // wrong signal: clicking into a page focuses the <webview> guest, which
  // blurs the chrome document while the window itself never moved -- and the
  // board would freeze the moment the user touched the page. Only a preload
  // that predates api.win.onFocus falls back to the document events.
  const win = winApi();
  if (win && typeof win.onFocus === 'function') {
    win.onFocus((payload) => {
      windowBlurred = !(payload && payload.focused);
      syncBoardPause();
      // The stats sampler follows the same signal: nothing is measured for a
      // window the user is not looking at.
      syncStatsSubscription();
    });
  } else {
    window.addEventListener('blur', () => { windowBlurred = true; syncBoardPause(); syncStatsSubscription(); });
    window.addEventListener('focus', () => { windowBlurred = false; syncBoardPause(); syncStatsSubscription(); });
  }
  // A freshly loaded new-tab guest has to learn the current state too.
  document.addEventListener('tabready', (event) => {
    const tab = tabs.find((t) => t.id === (event.detail && event.detail.id));
    if (tab && overlayOpenLast) pushBoardPaused(tab, true);
  });
}

// Called from init(): settings.js loads after this file, so the hook is late-bound.
function wireSettings() {
  const settings = window.Settings;
  if (!settings || typeof settings.on !== 'function') return;
  pushClaudeSkipToPreload(); // the switch as it stands at boot
  settings.on((all, keys) => {
    pushClaudeSkipToPreload(); // ...and after any write, including that switch
    for (const tab of tabs) {
      pushSettingsToTab(tab);
      pushBackgroundToTab(tab); // the store emits on every image replace/remove too
    }
    // The dock is only redrawn when the pins themselves moved; an older
    // settings.js that emits no key list gets the push either way.
    if (!Array.isArray(keys) || keys.indexOf('apps') >= 0) pushAppsToAll();
  });
}

// Placeholder URL shown in the omnibox for Claude tabs. Never navigable.
const CLAUDE_URL = 'claude://session';
const CLAUDE_DEFAULT_TITLE = 'Claude';

/**
 * @type {Array<{
 *   id:number, kind:'page'|'claude', viewEl:Element, chipEl:Element,
 *   titleEl:Element, title:string, url:string, ready:boolean,
 *   lastActive:number, loading?:boolean, iconEl?:Element|null,
 *   term?:Object|null, live?:boolean, termOff?:Function[],
 *   cardEl?:Element|null, warnEl?:Element|null, broken?:boolean,
 *   failedThisLoad?:boolean, audible?:boolean, muted?:boolean,
 *   audioEl?:Element|null, pinned?:boolean, globeEl?:Element|null,
 *   asleep?:boolean, openedAt?:number, workspace?:string
 * }>}
 */
const tabs = [];
let activeTabId = null;
let nextTabId = 1;

/* ------------------------------------------------------------------ */
/* Workspaces: model state                                             */
/* ------------------------------------------------------------------ */

/*
 * A workspace is a named set of tabs. Every tab is in exactly one of them
 * (tab.workspace, default 'main') and the strip shows only the current one's
 * chips — the others are still in `tabs`, still in #views, still alive, just
 * hidden. Nothing is torn down on a switch, exactly like activateTab().
 *
 * 'main' always exists and can never be deleted: it is where a deleted
 * workspace's tabs go, and where an unknown id falls back to.
 */
const DEFAULT_WORKSPACE_ID = 'main';
const WORKSPACE_COLOURS = ['ion', 'ember', 'forest', 'ocean', 'midnight'];
const WORKSPACE_NAME_MAX = 40;

/**
 * @type {Array<{id:string, name:string, colour:string|null,
 *               lastActiveTabId:number|null}>}
 */
const workspaces = [
  { id: DEFAULT_WORKSPACE_ID, name: 'Home', colour: null, lastActiveTabId: null }
];
let currentWorkspaceId = DEFAULT_WORKSPACE_ID;
let nextWorkspaceSeq = 1;

// DOM refs, resolved in init() so this file can load from <head> or <body>.
let titlebarEl = null;
let tabstripEl = null;
let newTabBtn = null;
let newClaudeBtn = null;
let backBtn = null;
let forwardBtn = null;
let reloadBtn = null;
let omniboxEl = null;
let zoomBadgeEl = null;
let viewsEl = null;
// Glass-redesign chrome (index.html owns the markup; every lookup is null-guarded
// so the browser still boots against an older index.html).
let winMinBtn = null;
let winMaxBtn = null;
let winCloseBtn = null;
let themeBtn = null;

/* ------------------------------------------------------------------ */
/* URL handling                                                        */
/* ------------------------------------------------------------------ */

// Schemes we are willing to hand straight to the webview.
const NAVIGABLE_PROTOCOLS = new Set([
  'http:', 'https:', 'file:', 'about:', 'data:', 'chrome:', 'view-source:'
]);

// example.com, sub.example.co.uk:8080/path?q=1 — no whitespace, real-looking TLD.
const BARE_DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d{1,5})?([\/?#]\S*)?$/i;
// localhost, localhost:3000/foo
const LOCALHOST_RE = /^localhost(:\d{1,5})?([\/?#]\S*)?$/i;
// 127.0.0.1, 192.168.1.10:8080/x
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?([\/?#]\S*)?$/;

function parseUrlOrNull(text) {
  try {
    return new URL(text);
  } catch (err) {
    return null;
  }
}

/**
 * Turn whatever the user typed into something navigable.
 * Returns null for empty input.
 */
function toNavigationUrl(rawInput) {
  const text = String(rawInput == null ? '' : rawInput).trim();
  if (!text) return null;

  // An explicit, recognised scheme wins. Note "localhost:3000" also parses as a
  // URL (scheme "localhost:"), which is why the protocol allow-list matters.
  const parsed = parseUrlOrNull(text);
  if (parsed && NAVIGABLE_PROTOCOLS.has(parsed.protocol)) return parsed.href;

  // Bare domains get a scheme bolted on. Loopback/LAN dev servers are almost
  // always plain http, everything else defaults to https.
  if (LOCALHOST_RE.test(text) || IPV4_RE.test(text)) return 'http://' + text;
  if (BARE_DOMAIN_RE.test(text)) return 'https://' + text;

  // Anything else is a search.
  return searchUrlFor(text);
}

/** True for the bundled new-tab page, query string and hash included. */
function isNewTabUrl(url) {
  return typeof url === 'string' && url.indexOf(NEWTAB_URL) === 0;
}

// reader.html?src=<article url> is our own page wrapping someone else's article.
// Everywhere a URL is shown or stored, the article's address is what matters.
const READER_URL = new URL('reader.html', window.location.href).href;

/** The article URL behind a reader-view URL, or null for anything else. */
function readerSourceOf(url) {
  if (typeof url !== 'string' || url.indexOf(READER_URL) !== 0) return null;
  const parsed = parseUrlOrNull(url);
  const src = parsed && parsed.searchParams.get('src');
  const source = src && parseUrlOrNull(src);
  if (!source || (source.protocol !== 'http:' && source.protocol !== 'https:')) return null;
  return source.href;
}

function shortLabelFor(url) {
  const parsed = parseUrlOrNull(url);
  // Local pages (the new-tab page above all) have no hostname worth showing.
  if (parsed && parsed.protocol === 'file:') return 'New tab';
  if (parsed && parsed.hostname) return parsed.hostname.replace(/^www\./, '');
  return 'New tab';
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

// data-theme on <html> is the single source of truth. theme-boot.js stamps it
// synchronously from <head> (so nothing ever paints the wrong way round) and
// everything below reads it back rather than keeping a second copy.
const THEME_STORAGE_KEY = 'theme';
// Segoe Fluent Icons: E708 = moon (shown in dark, click for light),
//                     E706 = sun  (shown in light, click for dark).
const THEME_GLYPH = { dark: '\uE708', light: '\uE706' };
const THEME_TITLE = { dark: 'Switch to light theme', light: 'Switch to dark theme' };

function getTheme() {
  const value = document.documentElement.getAttribute('data-theme');
  return value === 'light' ? 'light' : 'dark';
}

/**
 * Hand the theme to one open new-tab guest. Everything else — remote pages,
 * Claude chambers, tabs that are not dom-ready — is skipped.
 */
function pushThemeToTab(tab, theme) {
  if (!isViewUsable(tab) || !isNewTabUrl(tab.url)) return;
  if (pushUnchanged(tab, 'theme', theme)) return; // already wearing it
  try {
    const pending = tab.viewEl.executeJavaScript(
      "document.documentElement.setAttribute('data-theme','" + theme + "')"
    );
    if (pending && typeof pending.catch === 'function') {
      pending.catch(() => pushFailed(tab, 'theme'));
    }
  } catch (err) { pushFailed(tab, 'theme'); /* guest went away mid-call */ }
}

/**
 * Apply a theme everywhere at once: the chrome attribute, storage, the toggle
 * glyph, every live terminal and every open new-tab page.
 */
function setTheme(input) {
  const theme = input === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (err) { /* storage blocked — the attribute still holds for this run */ }

  if (themeBtn) {
    const glyph = themeBtn.querySelector('span.glyph');
    if (glyph) glyph.textContent = THEME_GLYPH[theme];
    themeBtn.title = THEME_TITLE[theme];
    themeBtn.setAttribute('aria-label', THEME_TITLE[theme]);
  }

  // terminal.js loads after this file and may predate the hook, so feature-detect.
  const claudeTerminal = window.ClaudeTerminal;
  if (claudeTerminal && typeof claudeTerminal.setTheme === 'function') {
    try { claudeTerminal.setTheme(theme); } catch (err) { /* terminal not ready */ }
  }

  for (const tab of tabs) pushThemeToTab(tab, theme);
}

function toggleTheme() {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

/* ------------------------------------------------------------------ */
/* webview helpers — everything here is async-safe                     */
/* ------------------------------------------------------------------ */

function getActiveTab() {
  if (activeTabId === null) return null;
  return tabs.find((t) => t.id === activeTabId) || null;
}

function getTabByView(viewEl) {
  return tabs.find((t) => t.viewEl === viewEl) || null;
}

function isClaudeTab(tab) {
  return !!(tab && tab.kind === 'claude');
}

/**
 * <webview> methods do not exist until 'dom-ready' fires, and they throw once
 * the element has been detached. Every call site goes through this guard.
 * Claude tabs have no webview at all, so they never pass — and neither does a
 * sleeping tab, whose viewEl is a placeholder <div> with no guest behind it.
 */
function isViewUsable(tab) {
  if (!tab || tab.kind !== 'page' || tab.asleep) return false;
  return !!(tab.ready && tab.viewEl && tab.viewEl.isConnected);
}

/**
 * Newer Electron moved history APIs onto webContents.navigationHistory.
 * Prefer it when present, fall back to the classic webview methods.
 */
function historyTarget(viewEl) {
  if (viewEl && viewEl.navigationHistory && typeof viewEl.navigationHistory.canGoBack === 'function') {
    return viewEl.navigationHistory;
  }
  return viewEl;
}

/*
 * <webview>.getURL(), canGoBack(), canGoForward() and getZoomLevel() are not
 * property reads: each one is a SYNCHRONOUS IPC round trip to the main process
 * (Electron's invokeSync). One tab switch made six of them — 5.9 ms a switch on
 * the CPU profile, the single largest piece of JS in activateTab(), and 13 ms a
 * cycle on tab open/close — because the chrome, the reader, siteinfo, shield
 * and tabsearch all ask again for the same answer within the same task.
 *
 * None of those four answers can change without a navigation, and EVERY
 * navigation fires one of the view events wired in wireViewEvents(). So each
 * guest caches its four answers and every one of those events drops the cache
 * (dropNavCache below). The answers handed back are identical, in the same
 * order, at the same moment; only the round trip is gone.
 *
 * Keyed on the ELEMENT, not the tab: sleeping a tab replaces tab.viewEl with a
 * placeholder and waking it builds a fresh <webview>, so a stale entry can
 * never survive into a new guest, and a closed tab's entry is collected with
 * its element.
 */
const navCache = new WeakMap();

/** The cache record for this tab's live guest, or null when there is none. */
function navCacheFor(tab) {
  if (!tab || !tab.viewEl) return null;
  let entry = navCache.get(tab.viewEl);
  if (!entry) {
    entry = {};
    navCache.set(tab.viewEl, entry);
  }
  return entry;
}

/** Forget everything remembered about one guest: the next read asks it again. */
function dropNavCache(tab) {
  if (tab && tab.viewEl) navCache.delete(tab.viewEl);
}

function readCurrentUrl(tab) {
  if (!isViewUsable(tab)) return tab ? tab.url : '';
  const entry = navCacheFor(tab);
  if (entry && entry.url !== undefined) return entry.url;
  let url = null;
  try {
    url = tab.viewEl.getURL() || tab.url;
  } catch (err) {
    return tab.url;
  }
  if (entry) entry.url = url;
  return url;
}

/** Focus the guest a frame late, after the display swap has landed. */
function focusViewSoon(tab) {
  window.requestAnimationFrame(() => {
    if (!tab || tab.id !== activeTabId || !tab.viewEl || !tab.viewEl.isConnected) return;
    try { tab.viewEl.focus(); } catch (err) { /* not ready yet */ }
  });
}

/* ------------------------------------------------------------------ */
/* Omnibox                                                             */
/* ------------------------------------------------------------------ */

function omniboxHasFocus() {
  return !!omniboxEl && document.activeElement === omniboxEl;
}

/**
 * Never stomp on text the user is in the middle of typing. `force` is only used
 * by deliberate user actions (opening or switching tabs), not by page events.
 */
function setOmniboxValue(url, force) {
  if (!omniboxEl) return;
  if (!force && omniboxHasFocus()) return;
  // about:blank and the new-tab page both read as "empty": the user should see
  // the placeholder, never a file:// path they did not type.
  const store = window.History;
  const ours = !!(store && typeof store.isHistoryUrl === 'function' && store.isHistoryUrl(url));
  const blank = !url || url === 'about:blank' || isNewTabUrl(url) || ours;
  // A reader tab shows the article it is reading, not our wrapper page.
  omniboxEl.value = blank ? '' : (readerSourceOf(url) || url);
}

function syncOmniboxFromActive(force) {
  const tab = getActiveTab();
  if (isClaudeTab(tab)) {
    setOmniboxValue(CLAUDE_URL, force);
    return;
  }
  setOmniboxValue(tab ? readCurrentUrl(tab) : '', force);
}

/* ------------------------------------------------------------------ */
/* Nav button state                                                    */
/* ------------------------------------------------------------------ */

function updateNavState() {
  const tab = getActiveTab();
  let canBack = false;
  let canForward = false;

  if (isViewUsable(tab)) {
    // Two more synchronous IPC round trips, cached per guest exactly like the
    // url above: the history stack only moves across a navigation, and every
    // navigation drops the record.
    const entry = navCacheFor(tab);
    if (entry && entry.back !== undefined) {
      canBack = entry.back;
      canForward = entry.fwd;
    } else {
      const history = historyTarget(tab.viewEl);
      try {
        canBack = !!history.canGoBack();
        canForward = !!history.canGoForward();
      } catch (err) {
        canBack = false;
        canForward = false;
      }
      if (entry) {
        entry.back = canBack;
        entry.fwd = canForward;
      }
    }
  }

  // Nothing to navigate on a Claude tab: all three controls go dead.
  const claude = isClaudeTab(tab);

  if (backBtn) backBtn.disabled = claude || !canBack;
  if (forwardBtn) forwardBtn.disabled = claude || !canForward;
  if (reloadBtn) reloadBtn.disabled = claude || !tab;
}

/**
 * #reload doubles as Stop while the ACTIVE tab is loading. Segoe Fluent Icons:
 * E72C = refresh, E711 = cancel. Background tabs never touch the button, so it
 * has to be re-evaluated on every tab switch.
 */
function syncReloadButton() {
  if (!reloadBtn) return;
  const tab = getActiveTab();
  const loading = !!(tab && tab.kind === 'page' && tab.loading);
  reloadBtn.classList.toggle('stop', loading);
  const glyph = reloadBtn.querySelector('span.glyph');
  if (glyph) glyph.textContent = loading ? '\uE711' : '\uE72C';
  reloadBtn.title = loading ? 'Stop' : 'Reload';
  reloadBtn.setAttribute('aria-label', loading ? 'Stop' : 'Reload');
}

/** Single funnel for the loading flag: chip class and button stay in step. */
function setTabLoading(tab, loading) {
  if (!tab) return;
  const on = !!loading;
  tab.loading = on;
  if (tab.chipEl) tab.chipEl.classList.toggle('loading', on);
  if (tab.id === activeTabId) syncReloadButton();
}

/* ------------------------------------------------------------------ */
/* Tab chips                                                           */
/* ------------------------------------------------------------------ */

// Segoe Fluent Icons, the same family the nav buttons use.
//   E767 = speaker (the tab is making a sound), E74F = speaker muted,
//   E774 = globe (a pinned chip with no favicon of its own).
const TAB_GLYPH = { audible: '\uE767', muted: '\uE74F', globe: '\uE774', split: '\uE89F' };

function buildChip(tab) {
  const chip = document.createElement('div');
  chip.className = isClaudeTab(tab) ? 'tab claude' : 'tab';
  chip.dataset.tabId = String(tab.id);
  chip.setAttribute('role', 'tab');
  // activateTab() flips this; background tabs never go through it, so seed it.
  chip.setAttribute('aria-selected', 'false');

  // Claude chips lead with the liveness dot; chrome.css colours it off .live.
  if (isClaudeTab(tab)) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    chip.appendChild(dot);
  }

  // The globe stands in for a favicon on a pinned chip, which has no title to
  // read. chrome.css hides it everywhere else and whenever a real icon landed.
  if (!isClaudeTab(tab)) {
    const globe = document.createElement('span');
    globe.className = 'glyph tab-globe';
    globe.textContent = TAB_GLYPH.globe;
    globe.setAttribute('aria-hidden', 'true');
    chip.appendChild(globe);
    tab.globeEl = globe;

    // The two-panes glyph: chrome.css only shows it while the chip is .split,
    // so it is built once here rather than added and removed with the pair.
    const split = document.createElement('span');
    split.className = 'glyph tab-split';
    split.textContent = TAB_GLYPH.split;
    split.setAttribute('aria-hidden', 'true');
    chip.appendChild(split);
  }

  const title = document.createElement('span');
  title.className = 'tab-title';
  title.textContent = tab.title;

  const close = document.createElement('button');
  close.className = 'tab-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close tab');
  close.textContent = '×';

  chip.appendChild(title);
  chip.appendChild(close);
  tab.titleEl = title;
  // Truncation is chrome.css's job; the full string stays here for the tooltip.
  chip.title = chipTooltip(tab);
  if (tab.pinned) chip.classList.add('pinned');

  // Workspaces: a chip is in the strip only while its tab is in the workspace
  // on screen, and carries that workspace's colour for the underline.
  // syncChipWorkspace() keeps both in step from here on.
  chip.hidden = tabWorkspace(tab) !== currentWorkspaceId;
  const wsColour = (findWorkspace(tabWorkspace(tab)) || {}).colour || null;
  if (wsColour) chip.dataset.wsColour = wsColour;

  chip.addEventListener('click', () => {
    // A drag ends in a click on release. Swallowing that one keeps the plain
    // press-and-release path below exactly as it was.
    if (Date.now() - dragEndedAt < CLICK_AFTER_DRAG_MS) return;
    activateTab(tab.id);
  });
  // Middle-click closes the tab, the same as every other browser — except on a
  // pinned tab, which Chrome deliberately makes unclosable by accident.
  chip.addEventListener('auxclick', (event) => {
    if (!event || event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    if (tab.pinned) return;
    closeTab(tab.id);
  });
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    closeTab(tab.id);
  });

  wireChipDrag(tab, chip);
  return chip;
}

/** The chip's hover text: the page title, and the host it is showing. */
function chipTooltip(tab) {
  if (!tab) return '';
  // A Claude chamber has no url, but it does have a folder — and the chip only
  // ever shows that folder's last segment, so the tooltip carries the full path.
  if (isClaudeTab(tab)) {
    const cwd = typeof tab.cwd === 'string' ? tab.cwd : '';
    return (cwd && cwd !== tab.title) ? tab.title + ' — ' + cwd : tab.title;
  }
  const short = shortLabelFor(readCurrentUrl(tab) || tab.url);
  const base = (!short || short === tab.title) ? tab.title : tab.title + ' — ' + short;
  // A sleeping chip keeps its title and its favicon, so the tooltip is the only
  // place the state is spelled out.
  return tab.asleep ? 'Sleeping — ' + base : base;
}

/**
 * The speaker button on a chip, created on the first sound the page makes and
 * reused after. It sits left of the title, and never activates the tab: the
 * whole point is muting a background tab without leaving the one you are on.
 */
function tabAudioEl(tab) {
  if (!tab || isClaudeTab(tab) || !tab.chipEl) return null;
  if (tab.audioEl && tab.audioEl.isConnected) return tab.audioEl;

  const button = document.createElement('button');
  button.className = 'glyph tab-audio';
  button.type = 'button';
  button.hidden = true;
  button.addEventListener('click', (event) => {
    event.stopPropagation(); // never raise the tab: this is a background control
    event.preventDefault();
    setTabMuted(tab, !tab.muted);
  });

  try {
    tab.chipEl.insertBefore(button, tab.titleEl || tab.chipEl.firstChild);
  } catch (err) {
    return null;
  }
  tab.audioEl = button;
  return button;
}

/** Chip and button follow tab.audible / tab.muted; nothing else reads them. */
function syncTabAudio(tab) {
  if (!tab || isClaudeTab(tab)) return;
  const show = !!(tab.audible || tab.muted);
  // Nothing has ever made a sound: do not put a button on the chip at all.
  if (!show && !(tab.audioEl && tab.audioEl.isConnected)) return;
  const button = tabAudioEl(tab);
  if (!button) return;
  button.hidden = !show;
  button.textContent = tab.muted ? TAB_GLYPH.muted : TAB_GLYPH.audible;
  button.classList.toggle('is-muted', !!tab.muted);
  const label = tab.muted ? 'Unmute tab' : 'Mute tab';
  button.title = label;
  button.setAttribute('aria-label', label);
}

/** media-started-playing / media-paused. Only the chip cares. The new tab
 * page's moving picture is a muted loop: it fires media-started-playing like
 * any media, but a speaker on the new tab's chip would be a lie. */
function setTabAudible(tab, on) {
  if (!tab || isClaudeTab(tab) || isNewTabUrl(tab.url)) return;
  tab.audible = !!on;
  syncTabAudio(tab);
}

/** Mute or unmute one tab. An unattached guest throws; the flag still holds. */
function setTabMuted(tab, on) {
  if (!tab || isClaudeTab(tab)) return;
  const muted = !!on;
  tab.muted = muted;
  if (isViewUsable(tab)) {
    try { tab.viewEl.setAudioMuted(muted); } catch (err) { /* guest went away mid-call */ }
  }
  syncTabAudio(tab);
  saveSession(); // the mute rides along in the session entry
}

/**
 * dom-ready: a fresh guest is born unmuted, so a remembered mute is re-applied
 * rather than read. Otherwise the view is the source of truth.
 */
function syncTabMutedFromView(tab) {
  if (!isViewUsable(tab)) return;
  try {
    if (tab.muted) tab.viewEl.setAudioMuted(true);
    else tab.muted = !!tab.viewEl.isAudioMuted();
  } catch (err) { /* guest not attached yet */ }
  syncTabAudio(tab);
}

/**
 * The favicon <img> is created on the first icon a page reports and then reused.
 * Claude chips lead with their liveness dot and never get one.
 */
function tabIconEl(tab) {
  if (!tab || isClaudeTab(tab) || !tab.chipEl) return null;
  if (tab.iconEl && tab.iconEl.isConnected) return tab.iconEl;

  const img = document.createElement('img');
  img.className = 'tab-icon';
  img.alt = '';
  // A dead icon URL must never leave a broken-image box in the strip.
  img.addEventListener('error', () => {
    try { img.removeAttribute('src'); } catch (err) { /* already detached */ }
    // A pinned chip shows nothing but this icon: hand it back the globe.
    if (tab.chipEl) tab.chipEl.classList.remove('has-icon');
  });

  try {
    // Left to right: icon, speaker, title. The speaker is only there once the
    // page has made a sound, so it is the anchor when it exists.
    const anchor = (tab.audioEl && tab.audioEl.isConnected)
      ? tab.audioEl
      : (tab.titleEl || tab.chipEl.firstChild);
    tab.chipEl.insertBefore(img, anchor);
  } catch (err) {
    return null;
  }
  tab.iconEl = img;
  return img;
}

function setTabIcon(tab, url) {
  if (typeof url !== 'string' || !url) return;
  try {
    const img = tabIconEl(tab);
    if (img) img.setAttribute('src', url);
    // .has-icon is what a pinned chip reads to drop its globe fallback.
    if (img && tab.chipEl) tab.chipEl.classList.add('has-icon');
  } catch (err) { /* chip went away mid-load */ }
}

function clearTabIcon(tab) {
  try {
    if (tab && tab.iconEl) tab.iconEl.removeAttribute('src');
    if (tab && tab.chipEl) tab.chipEl.classList.remove('has-icon');
  } catch (err) { /* chip went away mid-load */ }
}

function setTabTitle(tab, title) {
  const fallback = isClaudeTab(tab) ? claudeDefaultTitle(tab) : shortLabelFor(tab.url);
  const text = (title && String(title).trim()) || fallback;
  tab.title = text;
  if (tab.titleEl) tab.titleEl.textContent = text;
  // A pinned chip has no title on it, so the tooltip is all the hover gives.
  if (tab.chipEl) tab.chipEl.title = chipTooltip(tab);
}

/* ------------------------------------------------------------------ */
/* Workspaces: lookup, chips, switching, API                           */
/* ------------------------------------------------------------------ */

/** The workspace record for an id, or null. */
function findWorkspace(id) {
  if (typeof id !== 'string' || !id) return null;
  return workspaces.find((w) => w.id === id) || null;
}

/** An id that certainly names a live workspace: anything unknown is 'main'. */
function validWorkspaceId(id) {
  return findWorkspace(id) ? id : DEFAULT_WORKSPACE_ID;
}

/** The workspace a tab belongs to. A stale or missing id reads as 'main'. */
function tabWorkspace(tab) {
  if (!tab) return DEFAULT_WORKSPACE_ID;
  return findWorkspace(tab.workspace) ? tab.workspace : DEFAULT_WORKSPACE_ID;
}

/**
 * The tabs in the current workspace, in strip order. Everything that used to
 * walk `tabs` to pick a neighbour — cycling, Ctrl+1..9, the Claude toggle, the
 * tab left behind by a close — goes through this instead, so a hidden chip can
 * never be raised by accident. tabsearch.js reads the whole `tabs` array (each
 * item now carries .workspace, so it can group); it can call this for the
 * current-workspace-only list.
 */
function visibleTabs() {
  return workspaceTabs(currentWorkspaceId);
}

/** One workspace's tabs, in array order. The strip order of that workspace. */
function workspaceTabs(id) {
  const want = validWorkspaceId(id);
  return tabs.filter((tab) => tabWorkspace(tab) === want);
}

/** Where a tab sits in its own workspace's strip, or -1. */
function stripSeat(tab) {
  return workspaceTabs(tabWorkspace(tab)).indexOf(tab);
}

/** A name the strip can show: trimmed, capped, never empty. */
function cleanWorkspaceName(name, fallback) {
  const text = (typeof name === 'string') ? name.trim().slice(0, WORKSPACE_NAME_MAX) : '';
  return text || (fallback || 'Workspace');
}

/** One of the five accents, or null for "no colour". */
function cleanWorkspaceColour(colour) {
  return WORKSPACE_COLOURS.indexOf(colour) === -1 ? null : colour;
}

/** A fresh id that cannot collide with a restored one. */
function newWorkspaceId() {
  let id = '';
  do { id = 'ws' + (nextWorkspaceSeq++); } while (findWorkspace(id));
  return id;
}

/**
 * One chip's workspace state: hidden unless its tab is in the workspace on
 * screen, and stamped with the workspace colour chrome.css underlines it in.
 */
function syncChipWorkspace(tab) {
  if (!tab || !tab.chipEl) return;
  const id = tabWorkspace(tab);
  tab.chipEl.hidden = id !== currentWorkspaceId;
  const colour = (findWorkspace(id) || {}).colour || null;
  if (colour) tab.chipEl.dataset.wsColour = colour;
  else delete tab.chipEl.dataset.wsColour;
}

/** The same for the whole strip. Cheap: one attribute pass, no layout read. */
function syncChipWorkspaces() {
  for (const tab of tabs) syncChipWorkspace(tab);
}

/** Move one tab between workspaces at the model level; callers handle focus. */
function setTabWorkspace(tab, id) {
  if (!tab) return;
  tab.workspace = validWorkspaceId(id);
  syncChipWorkspace(tab);
}

/**
 * Told on every model change — switch, create, rename, colour, delete, move,
 * and any change to a tab count. The switcher UI (workspaces.js) follows this
 * instead of reaching into the model, exactly as find.js follows 'tabchange'.
 */
function emitWorkspaceChange() {
  if (restoring) return; // one event at the end of the rebuild, not forty
  try {
    document.dispatchEvent(new CustomEvent('workspacechange', {
      detail: { id: currentWorkspaceId }
    }));
  } catch (err) { /* never fatal */ }
}

/**
 * A split is two tabs sharing one well, so it cannot straddle a switch: the
 * half in the other workspace would be hidden and the layout would be half
 * empty. Any pair whose halves have drifted apart is broken up.
 */
function unsplitAcrossWorkspaces() {
  for (const tab of tabs.slice()) {
    const other = splitPartner(tab);
    if (!other) continue;
    if (tabWorkspace(tab) !== tabWorkspace(other)) unsplit(tab);
  }
}

/**
 * Raise the current workspace's last active tab, falling back to the last chip
 * in it — and open a tab when the workspace is empty, because the window must
 * never sit with nothing on screen.
 */
function raiseCurrentWorkspace() {
  const ws = findWorkspace(currentWorkspaceId);
  const list = visibleTabs();
  if (!list.length) {
    createTab(HOME_URL); // createTab() stamps the current workspace on it
    return;
  }
  const wanted = (ws && list.find((t) => t.id === ws.lastActiveTabId)) || list[list.length - 1];
  activateTab(wanted.id);
}

/* --- the API the switcher UI (workspaces.js) drives ----------------- */

/** Copies, never the records themselves: the switcher must not mutate these. */
function workspaceList() {
  return workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    colour: w.colour,
    tabCount: tabs.reduce((n, t) => n + (tabWorkspace(t) === w.id ? 1 : 0), 0),
    current: w.id === currentWorkspaceId
  }));
}

/** The id of the workspace the strip is showing. */
function currentWorkspace() {
  return currentWorkspaceId;
}

/**
 * Show a different workspace. The outgoing chips and the outgoing view are
 * hidden (activateTab() does the view half, as it does for any switch) and the
 * workspace's own last active tab comes back up.
 * @returns {boolean} true when the strip actually changed workspace.
 */
function switchWorkspace(id) {
  const ws = findWorkspace(id);
  if (!ws || ws.id === currentWorkspaceId) return false;

  unsplitAcrossWorkspaces();
  currentWorkspaceId = ws.id;
  syncChipWorkspaces();
  raiseCurrentWorkspace();
  emitWorkspaceChange();
  saveSession();
  return true;
}

/** Ctrl+Alt+Right / Left (rebindable): the next or previous workspace, wrapping. */
function cycleWorkspace(step) {
  if (workspaces.length < 2) return;
  const from = workspaces.findIndex((w) => w.id === currentWorkspaceId);
  const at = from === -1 ? 0 : from;
  const next = (at + step + workspaces.length) % workspaces.length;
  switchWorkspace(workspaces[next].id);
}

/**
 * Make one and go there. A new workspace has no tabs, so switchWorkspace()
 * opens the first one in it.
 * @returns {string} the new workspace's id.
 */
function createWorkspace(name, colour) {
  const ws = {
    id: newWorkspaceId(),
    name: cleanWorkspaceName(name),
    colour: cleanWorkspaceColour(colour),
    lastActiveTabId: null
  };
  workspaces.push(ws);
  if (!switchWorkspace(ws.id)) {
    // Only reachable if the switch was refused; the list still changed.
    emitWorkspaceChange();
    saveSession();
  }
  return ws.id;
}

function renameWorkspace(id, name) {
  const ws = findWorkspace(id);
  if (!ws) return false;
  ws.name = cleanWorkspaceName(name, ws.name);
  emitWorkspaceChange();
  saveSession();
  return true;
}

function setWorkspaceColour(id, colour) {
  const ws = findWorkspace(id);
  if (!ws) return false;
  ws.colour = cleanWorkspaceColour(colour);
  syncChipWorkspaces(); // every chip in it wears the new underline
  emitWorkspaceChange();
  saveSession();
  return true;
}

/**
 * Delete a workspace. Its tabs are never closed — they move home to 'main',
 * which is why 'main' itself can never go.
 */
function deleteWorkspace(id) {
  const index = workspaces.findIndex((w) => w.id === id);
  if (index === -1 || id === DEFAULT_WORKSPACE_ID) return false;

  for (const tab of tabs) {
    if (tabWorkspace(tab) === id) setTabWorkspace(tab, DEFAULT_WORKSPACE_ID);
  }
  const wasCurrent = currentWorkspaceId === id;
  workspaces.splice(index, 1);

  if (wasCurrent) {
    currentWorkspaceId = DEFAULT_WORKSPACE_ID;
    syncChipWorkspaces();
    raiseCurrentWorkspace();
  } else {
    syncChipWorkspaces();
  }
  emitWorkspaceChange();
  saveSession();
  return true;
}

/**
 * Send one tab to another workspace. Its chip leaves the strip when it is on
 * its way out of the workspace on screen, and if it was the tab in front the
 * next visible one comes up in its place.
 */
function moveTabToWorkspace(tabId, wsId) {
  const tab = tabs.find((t) => t.id === tabId);
  const ws = findWorkspace(wsId);
  if (!tab || !ws) return false;
  if (tabWorkspace(tab) === ws.id) return true;

  // A pair cannot straddle two workspaces, and the tab is leaving this one.
  unsplit(tab);

  const wasActive = tab.id === activeTabId;
  const seat = wasActive ? visibleTabs().indexOf(tab) : -1;
  setTabWorkspace(tab, ws.id);

  if (wasActive) {
    const list = visibleTabs();
    if (!list.length) createTab(HOME_URL);
    else activateTab(list[Math.min(Math.max(seat, 0), list.length - 1)].id);
  }
  emitWorkspaceChange();
  saveSession();
  return true;
}

/** The chip menu's and the switcher's "send this tab there". */
function moveActiveTabToWorkspace(wsId) {
  if (activeTabId === null) return false;
  return moveTabToWorkspace(activeTabId, wsId);
}

/**
 * The switcher UI's home in the titlebar. index.html does not own it (it
 * predates workspaces), so the slot is built here, left of the strip, and
 * workspaces.js fills it. Empty and zero-width until it does.
 */
function ensureWorkspaceSlot() {
  if (!tabstripEl || !tabstripEl.parentNode) return null;
  let slot = document.getElementById('workspace-slot');
  if (slot) return slot;
  slot = document.createElement('div');
  slot.id = 'workspace-slot';
  slot.className = 'no-drag';
  try { tabstripEl.parentNode.insertBefore(slot, tabstripEl); } catch (err) { return null; }
  return slot;
}

/* ------------------------------------------------------------------ */
/* Tab order: drag to reorder                                          */
/* ------------------------------------------------------------------ */

/*
 * A chip is dragged with a transform, never by moving the node: the strip is
 * measured once on the first move and the DOM is reordered exactly once, on
 * drop. The chips that step aside slide on a stepped transition — the strip
 * sits on a backdrop-filter, so a continuous slide would re-blur every frame.
 */
const DRAG_THRESHOLD = 6;      // px of travel before a press becomes a drag
const CLICK_AFTER_DRAG_MS = 250;

let tabDrag = null;
let dragEndedAt = 0;

/** Put the chips in the strip in the order the tabs array holds them. */
function syncChipOrder() {
  if (!tabstripEl) return;
  for (const tab of tabs) {
    // appendChild MOVES a node that is already in the strip, so one pass in
    // array order is the whole reorder.
    if (tab.chipEl) tabstripEl.appendChild(tab.chipEl);
  }
  // Re-parenting drops nothing, but the strip is also the one place the
  // workspace state has to be right, so it is re-stamped on the same pass.
  syncChipWorkspaces();
}

/**
 * Pinned tabs other than this one, IN THIS STRIP. The strip keeps them all at
 * the left — and the strip is the current workspace, so a pinned tab parked in
 * another one does not push this workspace's seam along.
 */
function pinnedCountExcept(tab) {
  let n = 0;
  for (const other of workspaceTabs(tabWorkspace(tab))) {
    if (other === tab) continue;
    if (other.pinned) n++;
  }
  return n;
}

/**
 * The slots one tab is allowed to occupy — positions in the STRIP, so among
 * the current workspace's chips. Pinned and unpinned are two groups with a
 * hard seam between them: neither drag nor menu may cross it.
 */
function dropRangeFor(tab) {
  const others = workspaceTabs(tabWorkspace(tab)).length - 1;
  const pinned = pinnedCountExcept(tab);
  return tab && tab.pinned
    ? { min: 0, max: pinned }
    : { min: pinned, max: Math.max(pinned, others) };
}

/**
 * Move a tab to a position in the strip. Clamped into its own group (pinned or
 * unpinned), never wrapping.
 *
 * `toIndex` is a seat in the STRIP — a position among the current workspace's
 * chips, which is the only order the user can see. The array index it lands on
 * is worked back from the chip it is being seated in front of, so a workspace
 * whose tabs are scattered through `tabs` still reorders exactly.
 * @returns {boolean} true when the order actually changed.
 */
function moveTabToIndex(id, toIndex) {
  const from = tabs.findIndex((t) => t.id === id);
  if (from === -1) return false;
  const wanted = Number(toIndex);
  if (!isFinite(wanted)) return false;
  const range = dropRangeFor(tabs[from]);
  const to = Math.max(range.min, Math.min(wanted, range.max));
  // The tab's own workspace, not necessarily the one on screen: restoreSession
  // pins tabs that belong to a workspace nobody is looking at yet.
  const group = workspaceTabs(tabWorkspace(tabs[from]));
  const seat = group.indexOf(tabs[from]);
  if (to === seat) return false;

  const siblings = group.filter((t) => t.id !== id);
  const [tab] = tabs.splice(from, 1);
  // Indices are read AFTER the splice, so they already account for the gap.
  let at;
  if (!siblings.length) at = Math.min(from, tabs.length);
  else if (to >= siblings.length) at = tabs.indexOf(siblings[siblings.length - 1]) + 1;
  else at = tabs.indexOf(siblings[to]);
  tabs.splice(at, 0, tab);
  syncChipOrder();
  // A split is seated in STRIP order, so a chip dragged past its partner swaps
  // which half is on the left. The ratio rides on both tabs, so it survives.
  refreshSplit();
  saveSession(); // the stored active index is derived from this order
  return true;
}

/**
 * Ctrl+Shift+PageUp / PageDown. Chrome-side only: main.js does not replay those
 * keys, so they do nothing while a page holds focus.
 */
function moveActiveTab(step) {
  const tab = getActiveTab();
  if (!tab) return;
  const from = visibleTabs().indexOf(tab); // a seat in the strip, not in `tabs`
  if (from === -1) return;
  if (!moveTabToIndex(tab.id, from + step)) return;
  try {
    if (tab.chipEl) tab.chipEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } catch (err) { /* older engines: the strip just does not scroll */ }
}

/**
 * Pin or unpin a page tab. The flag and the move are one operation: a pinned
 * chip is icon-only and always sits with the other pinned tabs at the left, so
 * there is no state where the class is on and the position is wrong.
 *
 * Both directions land on the same index — the number of pinned tabs that are
 * not this one: pinning slots in behind the last pinned tab, unpinning steps
 * out to just past it.
 */
function setTabPinned(tab, on) {
  if (!tab || tab.kind !== 'page') return;
  const pinned = !!on;
  if (!!tab.pinned === pinned) return;
  tab.pinned = pinned;
  if (tab.chipEl) tab.chipEl.classList.toggle('pinned', pinned);
  moveTabToIndex(tab.id, pinnedCountExcept(tab));
  saveSession(); // pinned rides along in the session entry
}

/** Measure every chip once, at drag start: the drag itself reads no layout. */
function chipMetrics() {
  const rows = [];
  // The strip, not the tab list: a chip belonging to another workspace is
  // [hidden] and would measure as a zero-width box sitting at x=0.
  for (const tab of visibleTabs()) {
    if (!tab.chipEl) continue;
    const rect = tab.chipEl.getBoundingClientRect();
    rows.push({
      id: tab.id,
      el: tab.chipEl,
      left: rect.left,
      width: rect.width,
      center: rect.left + rect.width / 2
    });
  }
  return rows;
}

/** First move past the threshold: lift the chip and freeze the layout. */
function startTabDrag() {
  const drag = tabDrag;
  if (!drag || !tabstripEl) return false;

  drag.rows = chipMetrics();
  drag.home = drag.rows.findIndex((r) => r.id === drag.id);
  if (drag.home === -1) return false;
  drag.target = drag.home;

  // Pinned and unpinned are two groups: a chip may be hauled anywhere inside
  // its own, and nowhere outside it. Read once, here, not per pointer move.
  const range = dropRangeFor(tabs.find((t) => t.id === drag.id));
  drag.lowIndex = range.min;
  drag.highIndex = range.max;

  const me = drag.rows[drag.home];
  const strip = tabstripEl.getBoundingClientRect();
  const first = drag.rows[drag.lowIndex] || me;
  const last = drag.rows[drag.highIndex] || me;
  // The chip stays inside the strip AND inside its own group: dragged past
  // either edge there is no slot left to read off the pointer.
  drag.min = Math.max(strip.left, first.left) - me.left;
  drag.max = Math.min(strip.right, last.left + last.width) - (me.left + me.width);
  // The strip's flex gap, read off the measurements rather than hardcoded.
  drag.gap = drag.rows.length > 1
    ? Math.max(0, drag.rows[1].left - (drag.rows[0].left + drag.rows[0].width))
    : 0;

  drag.moved = true;
  drag.chip.classList.add('dragging');
  document.body.classList.add('tab-dragging');
  for (const row of drag.rows) {
    if (row.id !== drag.id) row.el.classList.add('drag-shift');
  }
  // Every browser raises the tab you start dragging; leaving it behind would
  // read as dragging some other window's tab.
  if (drag.id !== activeTabId) activateTab(drag.id);
  return true;
}

/** Follow the pointer and slide whatever the chip has passed out of its way. */
function dragTabTo(dx) {
  const drag = tabDrag;
  if (!drag || !drag.rows) return;

  const shift = Math.max(drag.min, Math.min(dx, drag.max));
  drag.chip.style.transform = 'translate3d(' + Math.round(shift) + 'px, 0, 0) scale(1.03)';

  const me = drag.rows[drag.home];
  const centre = me.center + shift;
  // <=, not <: hauled to either end the chip is clamped to exactly the outer
  // chip's centre, and a strict test would leave the last slot unreachable.
  let target = drag.home;
  for (let i = 0; i < drag.home; i++) {
    if (centre <= drag.rows[i].center) { target = i; break; }
  }
  if (target === drag.home) {
    for (let i = drag.rows.length - 1; i > drag.home; i--) {
      if (centre >= drag.rows[i].center) { target = i; break; }
    }
  }
  // Hauled past the end of the travel the chip is pinned to the outer chip's
  // LEFT edge, so a chip wider than the ones it passed lands with its centre
  // short of that chip's centre and the outermost slot is unreachable. The
  // pointer overshooting the allowed travel is the unambiguous "all the way
  // there" gesture, so read it as exactly that.
  if (dx < drag.min) target = drag.lowIndex;
  else if (dx > drag.max) target = drag.highIndex;

  // Never across the pinned/unpinned seam, whatever the pointer says.
  target = Math.max(drag.lowIndex, Math.min(target, drag.highIndex));
  if (target === drag.target) return; // the slot has not moved

  drag.target = target;
  const step = me.width + drag.gap;
  for (let i = 0; i < drag.rows.length; i++) {
    if (i === drag.home) continue;
    let move = 0;
    if (target > drag.home && i > drag.home && i <= target) move = -step;
    else if (target < drag.home && i >= target && i < drag.home) move = step;
    drag.rows[i].el.style.transform = move
      ? 'translate3d(' + Math.round(move) + 'px, 0, 0)'
      : '';
  }
}

/** Drop: clear every transform, then make the DOM match what was on screen. */
function endTabDrag() {
  const drag = tabDrag;
  tabDrag = null;
  if (!drag) return;

  try { drag.chip.releasePointerCapture(drag.pointerId); } catch (err) { /* already gone */ }
  if (!drag.moved) return; // never crossed the threshold: a plain click

  drag.chip.style.transform = '';
  drag.chip.classList.remove('dragging');
  document.body.classList.remove('tab-dragging');
  for (const row of drag.rows) {
    row.el.style.transform = '';
    row.el.classList.remove('drag-shift');
  }

  dragEndedAt = Date.now(); // the release fires a click; the chip ignores it
  // The clamp is repeated here because the strip can change under a drag
  // (a background tab closing), and moveTabToIndex clamps to the group again.
  const target = Math.max(drag.lowIndex, Math.min(drag.target, drag.highIndex));
  if (target !== drag.home) moveTabToIndex(drag.id, target);
}

/** Pointer wiring for one chip. Pointer capture keeps the drag on this chip. */
function wireChipDrag(tab, chip) {
  chip.addEventListener('pointerdown', (event) => {
    if (!event || event.button !== 0 || event.isPrimary === false) return;
    // The close and speaker buttons own their own clicks; a press on either is
    // never a drag.
    if (event.target && event.target.closest
        && event.target.closest('.tab-close, .tab-audio')) return;
    if (tabDrag) return;

    closeTabMenu();
    tabDrag = {
      id: tab.id,
      chip: chip,
      pointerId: event.pointerId,
      startX: event.clientX,
      moved: false,
      rows: null,
      home: -1,
      target: -1,
      lowIndex: 0,
      highIndex: 0,
      min: 0,
      max: 0,
      gap: 0
    };
    try {
      chip.setPointerCapture(event.pointerId);
    } catch (err) {
      tabDrag = null; // no capture, no drag: the chip stays a plain click
    }
  });

  chip.addEventListener('pointermove', (event) => {
    if (!tabDrag || tabDrag.chip !== chip) return;
    if (event.pointerId !== tabDrag.pointerId) return;
    const dx = event.clientX - tabDrag.startX;
    if (!tabDrag.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      // Nothing to measure (the chip left the strip mid-press): drop the whole
      // gesture, capture and all, rather than half-starting it.
      if (!startTabDrag()) { endTabDrag(); return; }
    }
    dragTabTo(dx);
  });

  const finish = (event) => {
    if (!tabDrag || tabDrag.chip !== chip) return;
    if (event && event.pointerId !== tabDrag.pointerId) return;
    endTabDrag();
  };
  chip.addEventListener('pointerup', finish);
  chip.addEventListener('pointercancel', finish);
  // Capture is lost when the chip is re-parented by syncChipOrder(); ending the
  // drag there too means state can never be stranded mid-drag.
  chip.addEventListener('lostpointercapture', finish);
}

/* ------------------------------------------------------------------ */
/* Tab lifecycle                                                       */
/* ------------------------------------------------------------------ */

/**
 * The one place a page tab's <webview> is built and wired. createTab() and
 * wakeTab() both come through here, so a woken tab is indistinguishable from a
 * fresh one — same attributes, same event wiring, same born-hidden state.
 * Sets tab.viewEl; the caller decides where in #views the element goes.
 */
function buildWebview(tab, url) {
  const viewEl = document.createElement('webview');
  // `allowpopups` is what makes Chromium ASK before opening a window rather
  // than dropping the request on the floor. It does not give the guest a
  // window: main's setWindowOpenHandler denies every one and hands the url
  // back as a tab. Without it, window.open() returns null and target="_blank"
  // is a no-op. main.js forces the same flag on in will-attach-webview, so
  // this line is the readable half of a belt-and-braces pair.
  viewEl.setAttribute('allowpopups', '');
  viewEl.setAttribute('src', url);
  viewEl.style.width = '100%';
  viewEl.style.height = '100%';
  viewEl.style.display = 'none'; // activateTab() reveals the active one

  tab.viewEl = viewEl;
  tab.ready = false; // dom-ready on the NEW element is what flips this
  wireViewEvents(tab);
  return viewEl;
}

/**
 * @param {string} [url]
 * @param {{background?:boolean, pinned?:boolean, muted?:boolean, afterId?:number,
 *          workspace?:string}} [options]
 *        background:true opens the tab behind the current one (Ctrl+click,
 *        target="_blank" with a background hint). pinned/muted are only used by
 *        restoreSession(), which rebuilds both from the stored entry. afterId
 *        slots the new tab in directly behind that tab id instead of at the end
 *        of the strip (the reader opens next to the page it was made from).
 *        workspace is restoreSession()'s too: a tab the user opens lands in the
 *        workspace they are looking at.
 */
function createTab(url, options) {
  if (!viewsEl || !tabstripEl) return null;

  const opts = options || {};
  let target = toNavigationUrl(url) || HOME_URL;
  // The new-tab page paints its own chrome, so it gets the theme in its URL and
  // is correct from the first frame instead of flashing dark then correcting.
  // isNewTabUrl() is a prefix test, so the query changes nothing downstream.
  if (target === HOME_URL || target === NEWTAB_URL) {
    target = newTabUrl();
  }

  const tab = {
    id: nextTabId++,
    kind: 'page',
    viewEl: null,   // buildWebview() fills this in, below
    chipEl: null,
    titleEl: null,
    title: shortLabelFor(target),
    url: target,
    ready: false,
    loading: false,
    iconEl: null,
    cardEl: null,   // a crash / load-failure card covering this tab's well
    warnEl: null,
    broken: false,
    failedThisLoad: false,
    audible: false,
    // The guest is born unmuted; dom-ready re-applies a restored mute to it.
    muted: !!opts.muted,
    audioEl: null,
    pinned: false,
    globeEl: null,
    asleep: false,
    // Split view: the partner's id while this tab is half of a pair, and that
    // pair's divider position. No elements — a split is layout on the view
    // that is already in #views, never a re-parent. Never persisted.
    splitWith: null,
    splitRatio: 0.5,
    lastActive: 0,
    // The workspace this tab lives in. Never null: an unknown id reads as
    // 'main' through tabWorkspace().
    workspace: validWorkspaceId(opts.workspace || currentWorkspaceId),
    // The idle clock a never-activated background tab is measured from; without
    // it lastActive 0 would read as "idle since 1970" and sleep it on sight.
    openedAt: Date.now()
  };

  const viewEl = buildWebview(tab, target);
  tab.chipEl = buildChip(tab);

  tabs.push(tab);
  viewsEl.appendChild(viewEl);
  tabstripEl.appendChild(tab.chipEl);
  // Both of these are moves inside the strip, so they run after the push. The
  // pinned move is last: a pinned tab belongs in its own group whatever else
  // was asked for.
  if (opts.afterId !== undefined && opts.afterId !== null) {
    // A seat in the strip: both tabs are in the same workspace, or the move is
    // meaningless and is skipped.
    const group = workspaceTabs(tab.workspace);
    const after = group.findIndex((t) => t.id === opts.afterId);
    if (after !== -1) moveTabToIndex(tab.id, after + 1);
  }
  // A restored pinned tab is already in place, so this is a no-op.
  if (opts.pinned) setTabPinned(tab, true);
  if (tab.muted) syncTabAudio(tab);
  emitWorkspaceChange(); // a tab count moved
  pushReadoutToAll();    // ...so every open new-tab page says so
  saveSession(); // debounced: activateTab() below folds into the same write

  // Never leave the window with nothing on screen: the very first tab is opened
  // in front even when the caller asked for a background one.
  if (opts.background && activeTabId !== null) return tab;

  activateTab(tab.id);
  return tab;
}

/* ------------------------------------------------------------------ */
/* Tab sleeping                                                        */
/* ------------------------------------------------------------------ */

/*
 * A background tab that has sat untouched gives its renderer back: the
 * <webview> is removed from #views (which is what destroys the guest) and a
 * placeholder <div> takes its place in the tab model. The chip does not move,
 * does not lose its title and does not lose its favicon — only the light goes
 * out of it — so waking a tab never reshuffles the strip.
 *
 * The placeholder exists for one reason: activateTab() toggles
 * tab.viewEl.style.display on EVERY tab, so a sleeping tab still has to have an
 * element there. It is hidden and never paints.
 */

const TAB_SLEEP_DEFAULT_MINUTES = 30;
const TAB_SLEEP_SWEEP_MS = 60000;

/** Idle minutes before a background tab sleeps; 0 means never. */
function tabSleepMinutes() {
  const value = settingGet('tabSleepMinutes');
  if (value === null || value === undefined || value === '') return TAB_SLEEP_DEFAULT_MINUTES;
  const minutes = Number(value);
  // A malformed setting is not an instruction to sleep everything.
  if (!isFinite(minutes) || minutes < 0) return TAB_SLEEP_DEFAULT_MINUTES;
  return minutes;
}

/** When this tab was last in front — its creation time until it ever has been. */
function tabIdleSince(tab) {
  if (!tab) return 0;
  return tab.lastActive || tab.openedAt || 0;
}

/**
 * Whether a tab may be slept right now, idle time aside. Everything excluded
 * here is something the user would notice losing: the tab on screen, a pinned
 * tab, anything playing (muted or not — media-started-playing fires either
 * way), a blank new tab (nothing to reload), a broken one (its card is the
 * page), and anything with no live guest to give back.
 */
function canSleepTab(tab) {
  if (!tab || tab.kind !== 'page') return false;
  if (tab.asleep) return false;
  if (tab.id === activeTabId) return false;
  if (tab.pinned) return false;
  if (tab.audible) return false;
  if (tab.broken) return false;
  // The other half of the split on screen is as visible as the active tab is.
  if (isTabOnScreen(tab)) return false;
  if (isNewTabUrl(readCurrentUrl(tab) || tab.url)) return false;
  return isViewUsable(tab);
}

/**
 * Put one tab to sleep. The url is snapshotted first: it can only be read while
 * the guest is still attached, and it is the whole of what wakeTab() needs.
 * @returns {boolean} true when the tab actually went to sleep.
 */
function sleepTab(tab) {
  if (!tab || tab.kind !== 'page' || tab.asleep) return false;
  if (tab.id === activeTabId) return false; // the tab on screen is never asleep
  if (!viewsEl || !tab.viewEl) return false;

  // Giving the guest back would leave half a split pointing at a placeholder,
  // so the pair breaks up first and the partner goes back to a well of its own.
  unsplit(tab);

  tab.url = readCurrentUrl(tab) || tab.url;

  const placeholder = document.createElement('div');
  placeholder.className = 'sleeping-view';
  placeholder.hidden = true;

  const viewEl = tab.viewEl;
  try {
    if (viewEl.isConnected && viewEl.parentNode) viewEl.parentNode.insertBefore(placeholder, viewEl);
    else viewsEl.appendChild(placeholder);
  } catch (err) {
    return false; // could not stand anything in for the view: leave it alone
  }
  // Removing the element from the document is what tears the guest down. It
  // also raises the same one-per-removal "Invalid guestInstanceId" from
  // Electron that closeTab() documents; closing the sleeping tab afterwards is
  // silent, because a placeholder <div> has no guest to detach.
  try { viewEl.remove(); } catch (err) { /* already detached */ }

  tab.viewEl = placeholder;
  tab.ready = false;
  tab.asleep = true;
  setTabLoading(tab, false); // a load in flight died with the guest
  if (tab.chipEl) {
    tab.chipEl.classList.add('asleep');
    tab.chipEl.title = chipTooltip(tab);
  }
  saveSession(); // the snapshotted url may be newer than the last write
  return true;
}

/**
 * Build the tab a guest again, on the url it was sleeping on. The mute and the
 * site's zoom are re-applied by the dom-ready handler, exactly as they are for
 * a tab that has just been restored from the session.
 * @returns {boolean} true when the tab actually woke.
 */
function wakeTab(tab) {
  if (!tab || !tab.asleep) return false;
  if (!viewsEl) return false;

  const placeholder = tab.viewEl;
  const viewEl = buildWebview(tab, tab.url || HOME_URL);
  try {
    // Back in its own slot, so #views keeps the strip's order.
    if (placeholder && placeholder.isConnected) viewsEl.insertBefore(viewEl, placeholder);
    else viewsEl.appendChild(viewEl);
  } catch (err) {
    try { viewsEl.appendChild(viewEl); } catch (err2) { return false; }
  }
  try { if (placeholder) placeholder.remove(); } catch (err) { /* already detached */ }

  tab.asleep = false;
  if (tab.chipEl) {
    tab.chipEl.classList.remove('asleep');
    tab.chipEl.title = chipTooltip(tab);
  }
  return true;
}

/**
 * One sweep of the strip, on the 60s interval init() starts.
 * @returns {number} how many tabs were put to sleep.
 */
function sleepIdleTabs() {
  const minutes = tabSleepMinutes();
  if (!minutes) return 0; // 0 = never
  const cutoff = Date.now() - minutes * 60000;
  let slept = 0;
  // A copy: sleepTab() only swaps one element, but the sweep should not care.
  for (const tab of tabs.slice()) {
    if (!canSleepTab(tab)) continue;
    if (tabIdleSince(tab) > cutoff) continue;
    if (sleepTab(tab)) slept++;
  }
  return slept;
}

/** Strip menu: sleep every eligible tab now. canSleepTab() spares the active one. */
function sleepOtherTabs() {
  let slept = 0;
  for (const tab of tabs.slice()) {
    if (canSleepTab(tab) && sleepTab(tab)) slept++;
  }
  return slept;
}

/* ------------------------------------------------------------------ */
/* Split view                                                          */
/* ------------------------------------------------------------------ */

/*
 * Two page tabs shown side by side in the same well. The pairing is symmetric
 * and lives on the tabs themselves — tab.splitWith holds the partner's id — so
 * there is no second list to keep in step with the strip.
 *
 * A <webview> is NEVER moved in the DOM. Re-parenting a guest leaves its
 * webContents alive (getWebContentsId() does not even change) but stops it
 * painting — a blank white pane — which is what the wrapper-pane version of
 * this got wrong. Every view is a direct child of #views from birth to close,
 * and a split is nothing but layout on the children that are already there:
 *   - #views is display:flex, so both halves get display:flex, an inline
 *     flex-basis carrying the ratio, and a CSS `order` seating them left and
 *     right in STRIP order;
 *   - one .split-divider is built into #views the first time a pair is made
 *     and then kept for the life of the window, hidden unless a pair is on
 *     screen, ordered between the two halves;
 *   - .split-focus is a 2px line parked over the focused half's top edge — a
 *     ::before cannot sit on a webview, so the mark is its own element,
 *     positioned off getBoundingClientRect();
 *   - a crash card is absolutely positioned against #views, so while split it
 *     is inset to its own half by the same rect maths.
 * Everything else in #views stays display:none, exactly as before.
 *
 * activeTabId stays the single source of truth: the omnibox, the nav buttons,
 * the zoom badge, find, shield and site info all still follow it. The second
 * pane is only a page you can see — clicking into it moves activeTabId to that
 * tab WITHOUT breaking the pair. A press that lands inside a guest never
 * reaches this document at all, so that path is main's: it forwards every
 * guest focus over api.onGuestFocus and onGuestFocused() below turns the
 * webContents id back into a tab.
 *
 * A Claude chamber splits exactly like a page does — that pairing (a page on
 * one side, Claude Code on the other) is the point of the window. Splits are
 * deliberately not part of the session snapshot either way.
 */

const SPLIT_RATIO_MIN = 0.2;
const SPLIT_RATIO_MAX = 0.8;
const SPLIT_RATIO_DEFAULT = 0.5;

/** The pair's ratio never collapses a pane to nothing. */
function clampSplitRatio(value) {
  const n = Number(value);
  if (!isFinite(n)) return SPLIT_RATIO_DEFAULT;
  return Math.max(SPLIT_RATIO_MIN, Math.min(SPLIT_RATIO_MAX, n));
}

/**
 * Any well can be half of a pair: a page OR a Claude chamber. A chamber is a
 * plain div with `min-width: 0`, so it takes the same inline order/flex-basis
 * seat a <webview> does, and terminal.js's ResizeObserver refits the PTY as
 * the divider moves. Page + Claude is the pair the whole browser exists for;
 * two chambers side by side is allowed too, because it costs nothing.
 */
function canSplitTab(tab) {
  return !!(tab && (tab.kind === 'page' || tab.kind === 'claude'));
}

/**
 * The tab this one is split with, or null. The pointer has to be symmetric:
 * a half-written pairing (a partner that closed, say) reads as no split at all,
 * which is what keeps every caller below from having to check twice.
 */
function splitPartner(tab) {
  if (!tab || tab.splitWith === null || tab.splitWith === undefined) return null;
  const other = tabs.find((t) => t.id === tab.splitWith) || null;
  if (!other || other.splitWith !== tab.id) return null;
  return other;
}

/** Both members in strip order, or just the tab itself when it is not split. */
function splitMembers(tab) {
  if (!tab) return [];
  const other = splitPartner(tab);
  if (!other) return [tab];
  return tabs.indexOf(tab) <= tabs.indexOf(other) ? [tab, other] : [other, tab];
}

/**
 * Whether this tab is on screen right now: the active one, or the other half
 * of the active one's pair. Everything that used to test `id === activeTabId`
 * to decide what to show goes through this instead.
 */
function isTabOnScreen(tab) {
  if (!tab || activeTabId === null) return false;
  if (tab.id === activeTabId) return true;
  const other = splitPartner(tab);
  return !!other && other.id === activeTabId;
}

/*
 * The two elements a split borrows from #views. Both are built once, on the
 * first split of the window, and then live there hidden — building them once
 * is what keeps the divider's drag wiring attached exactly once, and it means
 * a split never adds or removes a sibling next to a live guest.
 */
let splitDividerEl = null;
let splitFocusEl = null;
// A drag over a <webview> is swallowed by the guest, so the divider lays a
// transparent scrim over the whole window for the length of the drag: the
// pointer stays in the chrome document and the moves keep arriving.
let splitScrimEl = null;

function showSplitScrim() {
  if (splitScrimEl) return;
  const scrim = document.createElement('div');
  scrim.className = 'split-scrim';
  document.body.appendChild(scrim);
  splitScrimEl = scrim;
}

function hideSplitScrim() {
  if (!splitScrimEl) return;
  try { splitScrimEl.remove(); } catch (err) { /* already detached */ }
  splitScrimEl = null;
}

/** The divider, built into #views the first time anything asks for it. */
function ensureSplitDivider() {
  if (splitDividerEl && splitDividerEl.isConnected) return splitDividerEl;
  if (!viewsEl) return null;

  const divider = document.createElement('div');
  divider.className = 'split-divider';
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.title = 'Drag to resize — double-click to even out';
  divider.style.display = 'none';
  wireSplitDivider(divider);

  viewsEl.appendChild(divider);
  splitDividerEl = divider;
  return divider;
}

/** The focus mark, likewise built once and left in #views. */
function ensureSplitFocusMark() {
  if (splitFocusEl && splitFocusEl.isConnected) return splitFocusEl;
  if (!viewsEl) return null;

  const mark = document.createElement('div');
  mark.className = 'split-focus';
  mark.setAttribute('aria-hidden', 'true');
  mark.style.display = 'none';
  viewsEl.appendChild(mark);
  splitFocusEl = mark;
  return mark;
}

/**
 * The pair on screen right now, in strip order, or [] when nothing is split.
 * Both halves must still have a view: a sleeping placeholder is not a pane.
 */
function onScreenSplitPair() {
  const active = getActiveTab();
  if (!active) return [];
  const pair = splitMembers(active);
  if (pair.length !== 2) return [];
  if (!pair[0].viewEl || !pair[1].viewEl) return [];
  return pair;
}

/** The half the ratio describes: whichever member is seated on the left. */
function splitLeftTab() {
  const pair = onScreenSplitPair();
  return pair.length === 2 ? pair[0] : null;
}

/**
 * Seat one member's view as a flex item of #views.
 * @param {?string} basis a flex-basis for the left half, or null for "the rest"
 */
function seatSplitView(tab, order, basis) {
  const view = tab && tab.viewEl;
  if (!view) return;
  const style = view.style;
  style.order = String(order);
  style.display = 'flex';
  if (basis === null) {
    style.flexGrow = '1';
    style.flexShrink = '1';
    style.flexBasis = '0';
  } else {
    style.flexGrow = '0';
    style.flexShrink = '0';
    style.flexBasis = basis;
  }
}

/** Put one view back to the whole-well flex the stylesheet gives it. */
function clearSplitSeat(tab) {
  const view = tab && tab.viewEl;
  if (view) {
    const style = view.style;
    style.order = '';
    style.flexGrow = '';
    style.flexShrink = '';
    style.flexBasis = '';
  }
  // A card inset to half the well goes back to covering all of it.
  if (tab && tab.cardEl) {
    tab.cardEl.style.left = '';
    tab.cardEl.style.right = '';
  }
}

/**
 * Push the pair's ratio into #views as order + flex-basis, and hide the
 * divider whenever the thing in front is not half of a pair. Derived entirely
 * from activeTabId, so it is safe to call after any change at all.
 */
function applySplitLayout() {
  const pair = onScreenSplitPair();
  if (pair.length !== 2) {
    for (const tab of tabs) clearSplitSeat(tab);
    if (splitDividerEl) splitDividerEl.style.display = 'none';
    return;
  }

  const ratio = clampSplitRatio(pair[0].splitRatio);
  // Two decimals: enough to be exact on any window, short enough to read.
  const left = Math.round(ratio * 10000) / 100;

  for (const tab of tabs) {
    if (tab !== pair[0] && tab !== pair[1]) clearSplitSeat(tab);
  }
  // Odd orders for the halves, even for the divider between them: nothing else
  // in #views is visible, so the three of them are the whole row.
  seatSplitView(pair[0], 1, left + '%');
  seatSplitView(pair[1], 3, null);

  const divider = ensureSplitDivider();
  if (divider) {
    divider.style.order = '2';
    divider.style.display = 'block';
  }
}

/**
 * Park the overlays over live rects: the focus mark on the active half's top
 * edge, and any crash card on the half it belongs to. Measured rather than
 * styled because neither one can be a child of the <webview> it describes.
 */
function syncSplitOverlays() {
  const pair = onScreenSplitPair();
  if (pair.length !== 2) {
    if (splitFocusEl) splitFocusEl.style.display = 'none';
    return;
  }
  if (!viewsEl) return;

  const box = viewsEl.getBoundingClientRect();
  for (const tab of pair) {
    if (!tab.cardEl) continue;
    const half = tab.viewEl.getBoundingClientRect();
    tab.cardEl.style.left = Math.round(half.left - box.left) + 'px';
    tab.cardEl.style.right = Math.round(box.right - half.right) + 'px';
  }

  const mark = ensureSplitFocusMark();
  const active = getActiveTab();
  if (!mark) return;
  if (!active || !active.viewEl) { mark.style.display = 'none'; return; }
  const rect = active.viewEl.getBoundingClientRect();
  if (!rect.width) { mark.style.display = 'none'; return; }
  mark.style.display = 'block';
  mark.style.left = Math.round(rect.left - box.left) + 'px';
  mark.style.top = Math.round(rect.top - box.top) + 'px';
  mark.style.width = Math.round(rect.width) + 'px';
}

/** Everything a split has to re-do after any change: one call, idempotent. */
function refreshSplit() {
  applySplitLayout();
  syncSplitOverlays();
}

/**
 * Move the divider. The number is the LEFT pane's share of the well.
 * It is mirrored onto both members so that dragging a chip past its partner —
 * which swaps which one is "left" — cannot lose the ratio the user set.
 */
function setSplitRatio(tab, ratio) {
  const pair = splitMembers(tab);
  if (pair.length !== 2) return;
  const value = clampSplitRatio(ratio);
  pair[0].splitRatio = value;
  pair[1].splitRatio = value;
  refreshSplit();
}

/** The drag, wired onto the one divider element exactly once. */
function wireSplitDivider(divider) {
  let dragging = false;

  const ratioFromX = (clientX) => {
    if (!viewsEl) return;
    const box = viewsEl.getBoundingClientRect();
    if (!box.width) return;
    // The left tab is read per move, not captured: a chip dragged past its
    // partner mid-resize must not leave this pointing at the wrong half.
    const leftTab = splitLeftTab();
    if (!leftTab) return;
    setSplitRatio(leftTab, (clientX - box.left) / box.width);
  };

  const onMove = (event) => {
    if (!dragging) return;
    ratioFromX(event.clientX);
  };

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    hideSplitScrim();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
  };

  divider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault(); // no text selection, no focus move
    dragging = true;
    showSplitScrim();
    // Capture as well as the scrim: capture keeps a release OUTSIDE the window
    // from stranding the drag, the scrim keeps a guest page from eating the
    // moves. Neither one alone covers both.
    try { divider.setPointerCapture(event.pointerId); } catch (err) { /* the scrim is enough */ }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  });

  // Double-click is the way back to even halves, as in every split UI.
  divider.addEventListener('dblclick', () => {
    const leftTab = splitLeftTab();
    if (leftTab) setSplitRatio(leftTab, SPLIT_RATIO_DEFAULT);
  });
}

/** The two-panes glyph rides on BOTH chips: a pair is a pair from either end. */
function syncSplitChips() {
  for (const tab of tabs) {
    if (!tab.chipEl) continue;
    tab.chipEl.classList.toggle('split', !!splitPartner(tab));
  }
}

/** Back to one well at a time: shown only while this tab is the one in front. */
function showTabAsWell(tab) {
  if (!tab) return;
  const shown = isTabOnScreen(tab);
  if (tab.viewEl) tab.viewEl.style.display = shown ? 'flex' : 'none';
  if (tab.cardEl) tab.cardEl.style.display = shown ? 'flex' : 'none';
}

/**
 * Stop showing a tab beside its partner. Both tabs survive untouched — this is
 * only a layout change, no element moves — and a dangling pointer is cleared
 * either way.
 * @returns {boolean} true when a pair was actually broken up.
 */
function unsplit(tab) {
  if (!tab) return false;
  const other = splitPartner(tab);
  if (!other) {
    // Half a pairing (the partner closed first): tidy this side and stop.
    tab.splitWith = null;
    clearSplitSeat(tab);
    showTabAsWell(tab);
    if (tab.chipEl) tab.chipEl.classList.remove('split');
    refreshSplit();
    return false;
  }

  tab.splitWith = null;
  other.splitWith = null;
  clearSplitSeat(tab);
  clearSplitSeat(other);
  showTabAsWell(tab);
  showTabAsWell(other);
  syncSplitChips();
  refreshSplit();
  return true;
}

/**
 * Show two tabs side by side (page or Claude, in any mix). Either tab may
 * already be in another pair,
 * and either may be asleep — both are dealt with before the pair is made.
 * @returns {boolean} true when the pair is now on screen.
 */
function splitTabs(a, b) {
  if (!viewsEl || !a || !b || a === b) return false;
  if (!canSplitTab(a) || !canSplitTab(b)) return false;

  // A tab is only ever in one pair, so an older pairing on either side goes.
  unsplit(a);
  unsplit(b);
  // A sleeping tab has no guest to show: waking it is part of splitting to it.
  if (a.asleep) wakeTab(a);
  if (b.asleep) wakeTab(b);
  if (!a.viewEl || !b.viewEl) return false;
  // No divider, no split: better to leave both tabs whole than half-split.
  if (!ensureSplitDivider()) return false;

  a.splitWith = b.id;
  b.splitWith = a.id;

  const pair = splitMembers(a);
  const ratio = clampSplitRatio(pair[0].splitRatio);
  pair[0].splitRatio = ratio;
  pair[1].splitRatio = ratio;

  syncSplitChips();
  // The layout, the display swap and the focus mark are all activateTab()'s
  // job — including when the pair is already in front. Whichever half was
  // there keeps the chrome; otherwise the pair comes forward on the tab the
  // caller named first.
  activateTab(activeTabId === b.id ? b.id : a.id);
  return true;
}

/**
 * The next splittable tab after this one in strip order, wrapping. Strip order
 * is one workspace's chips: a pair whose halves are in different workspaces is
 * broken on the next switch anyway, so it is never offered.
 */
function nextSplittableTab(tab) {
  const strip = workspaceTabs(tabWorkspace(tab));
  const start = strip.indexOf(tab);
  if (start === -1) return null;
  for (let step = 1; step < strip.length; step++) {
    const candidate = strip[(start + step) % strip.length];
    if (candidate !== tab && canSplitTab(candidate)) return candidate;
  }
  return null;
}

/** Menu row on a chip: pair that tab with the next splittable tab along. */
function splitTabWithNext(tab) {
  if (!canSplitTab(tab)) return false;
  const next = nextSplittableTab(tab);
  if (!next) return false;
  return splitTabs(tab, next);
}

/** Command: split the ACTIVE tab with the next splittable tab in the strip. */
function splitWithNext() {
  return splitTabWithNext(getActiveTab());
}

/** Command: split the active tab with one named tab (its chip's menu). */
function splitWithTab(id) {
  const active = getActiveTab();
  const other = tabs.find((t) => t.id === id) || null;
  if (!active || !other) return false;
  return splitTabs(active, other);
}

/** Ctrl+\: break the pair if there is one, otherwise pair with the next tab. */
function toggleSplit() {
  const active = getActiveTab();
  if (!active) return false;
  if (splitPartner(active)) return unsplit(active);
  return splitWithNext();
}

/**
 * Chip menu on a page: open a NEW chamber in the default folder and stand it
 * beside this page. The chamber is built in the background and appended to the
 * end of the strip, so strip order puts the page on the left — which is the
 * way round the window is meant to be read — and splitTabs() brings the pair
 * forward on the page.
 */
function openClaudeBesideTab(tab) {
  if (!tab || tab.kind !== 'page') return false;
  const claude = createClaudeTab({ background: true });
  if (!claude) return false;
  return splitTabs(tab, claude);
}

/** Chip menu on a chamber: stand it beside the page you were last on. */
function splitClaudeWithRecentPage(tab) {
  if (!isClaudeTab(tab)) return false;
  const page = mostRecentTabOfKind('page');
  if (!page || page === tab) return false;
  return splitTabs(page, tab);
}

/**
 * Ctrl+Shift+\ — "Claude beside". One key for the pairing the whole browser is
 * for: a page on one side, a Claude Code session on the other.
 *   - already split (either half): break the pair;
 *   - on a page: pair it with the chamber you used last, opening one if there
 *     is none;
 *   - in a chamber: pair it with the page you were last on.
 * The halves sit in strip order, exactly as every other split does.
 */
function toggleClaudeSplit() {
  const active = getActiveTab();
  if (!active) return false;
  if (splitPartner(active)) return unsplit(active);

  if (isClaudeTab(active)) return splitClaudeWithRecentPage(active);
  if (active.kind !== 'page') return false;

  const claude = mostRecentTabOfKind('claude');
  if (claude) return splitTabs(active, claude);
  return openClaudeBesideTab(active);
}

/** The page tab whose live guest has this webContents id, or null. */
function tabForWebContentsId(wcId) {
  if (wcId === undefined || wcId === null) return null;
  for (const tab of tabs) {
    // A Claude chamber has no guest and a sleeping tab's element is a
    // placeholder: neither one answers getWebContentsId().
    if (tab.kind !== 'page' || tab.asleep || !tab.viewEl) continue;
    if (typeof tab.viewEl.getWebContentsId !== 'function') continue;
    try {
      if (tab.viewEl.getWebContentsId() === wcId) return tab;
    } catch (err) { /* not attached yet: it cannot be the one that took focus */ }
  }
  return null;
}

/**
 * A press inside a guest never reaches this document, so main forwards the
 * guest's own focus event: { wcId }. Reaching for the other half of a split
 * with the mouse is the same as asking for that tab — and the guard is the
 * whole of the safety here, so a stray focus from any page that is NOT the
 * active tab's partner is ignored rather than stealing the chrome.
 */
function onGuestFocused(payload) {
  const tab = tabForWebContentsId(payload && payload.wcId);
  if (!tab || tab.id === activeTabId) return;
  const other = splitPartner(tab);
  if (!other || other.id !== activeTabId) return;
  activateTab(tab.id);
}

/* ------------------------------------------------------------------ */
/* Claude tabs                                                         */
/* ------------------------------------------------------------------ */

/** body.claude-live is true while ANY Claude tab still has a live session. */
function recomputeClaudeLive() {
  const any = tabs.some((t) => isClaudeTab(t) && t.live);
  document.body.classList.toggle('claude-live', any);
  // A session coming up or ending moves the new-tab readout's Claude count;
  // this is the one place every such change already passes through.
  pushReadoutToAll();
}

/* ------------------------------------------------------------------ */
/* "Claude needs you"                                                  */
/* ------------------------------------------------------------------ */

/*
 * A session that has gone quiet has almost always stopped to ask something.
 * terminal.js turns that silence into 'idle' (and Claude Code's own BEL into
 * 'bell'); the only judgement here is WHERE the user was looking when it landed.
 * A chamber he is watching needs no mark — he can already see it.
 */

/** Has this tab ever put up a notification for the run of attention it is in? */
function claudeNotifyEnabled() {
  // A settings store that is missing or predates the key reads as "on", which
  // is what settingGet()'s null stands for. Only an explicit false silences it.
  return settingGet('claudeNotify') !== false;
}

let claudeNotifyAsked = false;

/**
 * The notification permission, asking for it at most once per window. A
 * 'default' answer means the prompt is out: this idle goes unannounced and the
 * next one gets the real answer.
 */
function claudeNotifyPermission() {
  if (typeof window.Notification !== 'function') return 'unsupported';
  let perm = 'default';
  try { perm = window.Notification.permission; } catch (err) { return 'unsupported'; }
  if (perm === 'granted' || perm === 'denied') return perm;
  if (!claudeNotifyAsked) {
    claudeNotifyAsked = true;
    try {
      const answer = window.Notification.requestPermission();
      if (answer && typeof answer.then === 'function') answer.then(() => {}, () => {});
    } catch (err) { /* an older shell with the callback form only */ }
  }
  return 'default';
}

/** The Windows toast, at most one per tab per run of attention. */
function notifyClaudeWaiting(tab) {
  if (tab.needsYouNotified) return;      // already announced this quiet spell
  if (!claudeNotifyEnabled()) return;
  if (document.hasFocus()) return;       // he is right here; the dot is enough
  if (claudeNotifyPermission() !== 'granted') return;

  const folder = folderBaseName(tab.cwd) || claudeDefaultTitle(tab);
  let note = null;
  try {
    // silent: the chime is Claude Code's job (BEL). This is the visual half.
    note = new window.Notification('Claude is waiting', { body: folder, silent: true });
  } catch (err) {
    return; // no toast: the chip still carries the mark
  }
  tab.needsYouNotified = true;
  try {
    note.onclick = () => {
      try { window.focus(); } catch (err) { /* not ours to raise */ }
      activateTab(tab.id);
      try { note.close(); } catch (err) { /* already dismissed */ }
    };
  } catch (err) { /* an implementation without onclick */ }
}

/** Mark one Claude chip as waiting on the user: amber glyph, faster dot, toast. */
function markClaudeNeedsYou(tab) {
  if (!isClaudeTab(tab)) return;
  tab.needsYou = true;
  if (tab.chipEl) {
    tab.chipEl.classList.add('needs-you');
    // A leading ● in front of the title, built on demand and dropped on clear
    // so a chip that is not waiting carries no extra node at all.
    if (!tab.attnEl) {
      const attn = document.createElement('span');
      attn.className = 'tab-attn';
      attn.textContent = '●';
      attn.setAttribute('aria-hidden', 'true');
      try {
        tab.chipEl.insertBefore(attn, tab.titleEl || null);
        tab.attnEl = attn;
      } catch (err) { /* chip went away mid-mark */ }
    }
    tab.chipEl.title = chipTooltip(tab);
  }
  recomputeClaudeAttn();
  notifyClaudeWaiting(tab);
}

/** He looked: the chip goes back to its ordinary live breathe. */
function clearClaudeNeedsYou(tab) {
  if (!isClaudeTab(tab)) return;
  tab.needsYou = false;
  tab.needsYouNotified = false;
  if (tab.chipEl) {
    tab.chipEl.classList.remove('needs-you');
    tab.chipEl.title = chipTooltip(tab);
  }
  if (tab.attnEl) {
    try { tab.attnEl.remove(); } catch (err) { /* already detached */ }
    tab.attnEl = null;
  }
  recomputeClaudeAttn();
}

/** The strip's own light: the pill pulses while ANY chamber is waiting. */
function recomputeClaudeAttn() {
  const any = tabs.some((t) => isClaudeTab(t) && t.needsYou);
  if (newClaudeBtn) newClaudeBtn.classList.toggle('attn', any);
}

/** Every waiting chamber that is on screen now has been seen. */
function clearClaudeNeedsYouOnScreen() {
  for (const tab of tabs) {
    if (isClaudeTab(tab) && tab.needsYou && isTabOnScreen(tab)) clearClaudeNeedsYou(tab);
  }
}

/**
 * ConPTY hands us the shell's executable path as the initial window title.
 * Anything that looks like a Windows path or an .exe is noise, not a title.
 */
function isNoiseTitle(text) {
  const t = String(text == null ? '' : text);
  return /\.exe$/i.test(t) || /^[A-Za-z]:\\/.test(t);
}

/** One setting, feature-detected: settings.js is optional and may predate a key. */
function settingGet(key) {
  const settings = window.Settings;
  if (!settings || typeof settings.get !== 'function') return null;
  try {
    const value = settings.get(key);
    return value === undefined ? null : value;
  } catch (err) {
    return null; // a settings store that throws is a store that is not there
  }
}

/** The user's home folder, or '' when preload predates api.homeDir. */
function homeDir() {
  return (window.api && typeof window.api.homeDir === 'string') ? window.api.homeDir : '';
}

/**
 * The folder a new Claude tab opens in: the one settings names, else home.
 * Whether it still exists cannot be checked from here without waiting, so the
 * path is passed through as written — pty.js falls back to home on a bad cwd.
 */
function defaultClaudeCwd() {
  const dir = settingGet('claudeDir');
  if (typeof dir === 'string' && dir.trim()) return dir.trim();
  return homeDir();
}

/** Windows paths are case-insensitive and differ freely in separator / trailing slash. */
function samePath(a, b) {
  const norm = (p) => String(p == null ? '' : p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const left = norm(a);
  return !!left && left === norm(b);
}

/** The last segment of a path. A drive root ("C:\") has none worth showing. */
function folderBaseName(path) {
  const text = String(path == null ? '' : path).replace(/[\\/]+$/, '');
  if (!text) return '';
  const at = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
  const base = at === -1 ? text : text.slice(at + 1);
  return /^[A-Za-z]:$/.test(base) ? '' : base;
}

/* ---- recent Claude folders ---------------------------------------------
 * The user works across several projects at once, so the folders a chamber has
 * actually opened in are worth keeping: the strip menu and the palette each
 * offer them as one click, with no folder picker in the way. localStorage,
 * so the list is there synchronously at boot and survives a relaunch.
 */
const CLAUDE_RECENT_KEY = 'claudeRecent';
const CLAUDE_RECENT_MAX = 8;

/** One spelling for storage and for comparison: forward slashes, no trailing one. */
function normaliseClaudeFolder(cwd) {
  let text = String(cwd == null ? '' : cwd).trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:$/.test(text)) text += '/'; // a drive root keeps its slash
  return text;
}

/** Windows: two spellings of one folder are one folder. */
function sameClaudeFolder(a, b) {
  const left = normaliseClaudeFolder(a).toLowerCase();
  return !!left && left === normaliseClaudeFolder(b).toLowerCase();
}

/** The stored list exactly as written — nothing merged in, nothing implied. */
function storedClaudeFolders() {
  let raw = null;
  try { raw = window.localStorage.getItem(CLAUDE_RECENT_KEY); } catch (err) { return []; }
  if (!raw) return [];
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (err) { return []; } // a corrupt list is no list
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const entry of parsed) {
    const cwd = normaliseClaudeFolder(entry);
    if (!cwd) continue;
    if (out.some((seen) => sameClaudeFolder(seen, cwd))) continue;
    out.push(cwd);
    if (out.length >= CLAUDE_RECENT_MAX) break;
  }
  return out;
}

function writeClaudeFolders(list) {
  try {
    window.localStorage.setItem(
      CLAUDE_RECENT_KEY, JSON.stringify(list.slice(0, CLAUDE_RECENT_MAX)));
  } catch (err) { /* storage blocked or full: the list is only a convenience */ }
}

/**
 * Most recent first. The folder Settings names is merged in at the front when
 * it is set and has not been opened yet, so a fresh profile still gets the one
 * row that matters. Read-time only: it is never written into the store.
 */
function claudeRecentFolders() {
  const list = storedClaudeFolders();
  const setting = normaliseClaudeFolder(settingGet('claudeDir'));
  if (setting && !list.some((seen) => sameClaudeFolder(seen, setting))) list.unshift(setting);
  return list.slice(0, CLAUDE_RECENT_MAX);
}

/** Called once a chamber has actually spawned in `cwd`. Empty is not a folder. */
function rememberClaudeFolder(cwd) {
  const folder = normaliseClaudeFolder(cwd);
  if (!folder) return claudeRecentFolders();
  const list = storedClaudeFolders().filter((seen) => !sameClaudeFolder(seen, folder));
  list.unshift(folder);
  writeClaudeFolders(list);
  return claudeRecentFolders();
}

/** Drop one folder from the list. Returns what is left. */
function forgetClaudeFolder(cwd) {
  const folder = normaliseClaudeFolder(cwd);
  if (!folder) return claudeRecentFolders();
  writeClaudeFolders(storedClaudeFolders().filter((seen) => !sameClaudeFolder(seen, folder)));
  return claudeRecentFolders();
}

/** What the recent rows call: a chamber in that folder, options passed through. */
function createClaudeTabIn(cwd, options) {
  const opts = options || {};
  return createClaudeTab({ cwd: cwd, resume: opts.resume, background: opts.background });
}

/**
 * The strip menu's recent rows. Labels are basenames, and basenames collide
 * across projects ("browser" in Downloads and in home), so a duplicate wears
 * its parent folder too. The full path rides along as the row's tooltip.
 */
function claudeRecentMenuItems(limit) {
  const folders = claudeRecentFolders().slice(0, limit || 5);
  const names = folders.map((cwd) => folderBaseName(cwd) || cwd);
  return folders.map((cwd, at) => {
    let name = names[at];
    const clash = names.some((other, i) => i !== at && other.toLowerCase() === name.toLowerCase());
    if (clash) {
      const parent = folderBaseName(cwd.replace(/\/[^/]*$/, ''));
      if (parent) name = name + ' (' + parent + ')';
    }
    return { label: 'Claude in ' + name, title: cwd, run: () => createClaudeTabIn(cwd) };
  });
}

/**
 * A Claude chip's title before the session names itself: the folder it runs in,
 * so a strip of chambers reads as a list of projects. Home (and anything with
 * no nameable basename) keeps the bare product name.
 */
function claudeTitleFor(cwd) {
  if (samePath(cwd, homeDir())) return CLAUDE_DEFAULT_TITLE;
  return folderBaseName(cwd) || CLAUDE_DEFAULT_TITLE;
}

/** The title one Claude tab falls back to whenever it has nothing better. */
function claudeDefaultTitle(tab) {
  return claudeTitleFor(tab && tab.cwd);
}

// Every chamber starts with this unless the Settings switch says otherwise:
// a session that stops to ask for a confirmation is a session nobody is
// watching. pty.js allowlists it; preload.js puts it on the Enter-to-restart
// spawn too (terminal.js drops the first-spawn flags on purpose).
const CLAUDE_SKIP_ARG = '--dangerously-skip-permissions';

/** The setting, read the same way everywhere: unset means yes. */
function claudeSkipPermissions() {
  return settingGet('claudeSkipPermissions') !== false;
}

/**
 * The one place a `resume` option becomes claude.exe flags.
 *
 * 'pick' -> `--resume` with no id, which is the CLI's own picker of past
 * conversations in that folder; true -> `--continue`, the latest one without
 * asking. pty.js allows exactly these, bare, and drops the rest.
 *
 * The skip-permissions flag is PREPENDED, so it is on the command line for a
 * plain new tab as well as for either resume spelling.
 */
function claudeStartArgs(resume) {
  const args = [];
  if (claudeSkipPermissions()) args.push(CLAUDE_SKIP_ARG);
  if (resume === 'pick') args.push('--resume');
  else if (resume) args.push('--continue');
  return args;
}

/**
 * Hand the preference down to preload, which is the one funnel EVERY spawn
 * goes through -- including terminal.js's Enter-to-restart, which deliberately
 * forgets the flags the first spawn was given. Called at init and again on
 * every settings write; a preload that predates it is simply skipped.
 */
function pushClaudeSkipToPreload() {
  const pty = (window.api && window.api.pty) ? window.api.pty : null;
  if (!pty || typeof pty.setPrefs !== 'function') return;
  try { pty.setPrefs({ skipPermissions: claudeSkipPermissions() }); } catch (err) { /* preload's problem */ }
}

/**
 * Order matters: the view is appended and activated BEFORE the session starts,
 * so the host element already has a size when ClaudeTerminal.create() measures
 * it. terminal.js is loaded after this file, hence the typeof guard.
 *
 * @param {{cwd?:string, resume?:boolean|'pick', background?:boolean, workspace?:string}} [options]
 *        cwd: the folder to run in, defaulting to settings / home.
 *        workspace: restoreSession() only; otherwise the one on screen.
 *        resume: true continues that folder's last conversation outright
 *        (restoreSession() only — a tab the user opens starts clean);
 *        'pick' hands the user Claude Code's own list of past conversations
 *        in that folder. Anything else starts clean. See claudeStartArgs().
 *        background: build it behind the current tab. The host is hidden while
 *        the session starts, so activateTab() fits it on first raise.
 */
function createClaudeTab(options) {
  if (!viewsEl || !tabstripEl) return null;

  const opts = options || {};
  const cwd = (typeof opts.cwd === 'string' && opts.cwd) ? opts.cwd : defaultClaudeCwd();

  const viewEl = document.createElement('div');
  viewEl.className = 'claude-view';
  viewEl.style.width = '100%';
  viewEl.style.height = '100%';
  viewEl.style.display = 'none'; // activateTab() reveals the active one

  const tab = {
    id: nextTabId++,
    kind: 'claude',
    viewEl: viewEl,
    chipEl: null,
    titleEl: null,
    title: claudeTitleFor(cwd),
    url: CLAUDE_URL,
    cwd: cwd,
    term: null,
    live: false,
    ready: true,
    lastActive: 0,
    workspace: validWorkspaceId(opts.workspace || currentWorkspaceId),
    termOff: [],
    // "Claude needs you": set while this chamber has gone quiet off screen.
    needsYou: false,
    needsYouNotified: false,
    attnEl: null
  };

  tab.chipEl = buildChip(tab);

  // Reaching into the chamber with the mouse is the same as asking for this
  // tab. A guest page reports its own focus through main (onGuestFocused);
  // a chamber is right here in this document, so the press is the signal.
  // Capture, so xterm's own handlers cannot swallow it first, and guarded to
  // the active tab's partner exactly as the guest path is — a stray press on
  // a hidden chamber must never move the chrome. activateTab() focuses the
  // terminal from its Claude branch, so nothing steals focus back.
  viewEl.addEventListener('mousedown', () => {
    if (tab.id === activeTabId) return;
    const other = splitPartner(tab);
    if (other && other.id === activeTabId) activateTab(tab.id);
  }, true);

  tabs.push(tab);
  viewsEl.appendChild(viewEl);
  tabstripEl.appendChild(tab.chipEl);
  emitWorkspaceChange(); // a tab count moved
  pushReadoutToAll();    // ...so every open new-tab page says so
  saveSession(); // a chamber is a session entry now; debounced with the rest

  // Never leave the window with nothing on screen: the very first tab of a boot
  // is raised even when the caller asked for a background one.
  if (!opts.background || activeTabId === null) activateTab(tab.id);

  const factory = (typeof window.ClaudeTerminal === 'object' && window.ClaudeTerminal)
    ? window.ClaudeTerminal
    : null;
  if (!factory || typeof factory.create !== 'function') {
    setTabTitle(tab, 'Claude (unavailable)');
    return tab;
  }

  try {
    // args is honoured by terminal.js on the FIRST spawn only; an older
    // terminal.js ignores the key entirely, which just means no resume.
    tab.term = factory.create(viewEl, {
      cwd: cwd || undefined,
      args: claudeStartArgs(opts.resume)
    });
  } catch (err) {
    tab.term = null;
    setTabTitle(tab, 'Claude (unavailable)');
    return tab;
  }

  // A folder is only "recent" once a chamber has actually started in it: the
  // two failure paths above return before here, and so never pollute the list.
  rememberClaudeFolder(cwd);

  wireTermEvents(tab);
  return tab;
}

/**
 * Shift+click on the Claude pill, Ctrl+Shift+` and the strip menu item: pick a
 * folder, then open a chamber there. Cancelling the dialog opens nothing.
 */
function newClaudeTabInFolder() {
  const app = (window.api && window.api.app) ? window.api.app : null;
  if (!app || typeof app.pickFolder !== 'function') {
    createClaudeTab(); // preload predates the picker: the default folder is all we have
    return;
  }
  let pending = null;
  try { pending = app.pickFolder(defaultClaudeCwd()); } catch (err) { return; }
  if (!pending || typeof pending.then !== 'function') return;
  pending.then((dir) => {
    if (typeof dir === 'string' && dir) createClaudeTab({ cwd: dir });
  }, () => { /* dialog failed: same as a cancel */ });
}

/**
 * Ctrl+click on the Claude pill, the strip menu and the palette: a chamber in
 * the default folder that opens on Claude Code's own list of past
 * conversations there. The picking happens inside the CLI, not in the chrome,
 * so there is nothing to cancel on this side — Escape in the picker just
 * leaves the session sitting at a fresh prompt.
 */
function resumeClaudeConversation() {
  return createClaudeTab({ resume: 'pick' });
}

/**
 * The Claude chip menu's resume row. Same folder as the chamber it was asked
 * from, and seated immediately after that chip rather than at the end of the
 * strip: the two sessions on one folder belong next to each other.
 */
function resumeClaudeBesideTab(tab) {
  if (!tab) return null;
  const seat = stripSeat(tab);
  const made = createClaudeTab({ cwd: tab.cwd, resume: 'pick' });
  if (made && seat !== -1) moveTabToIndex(made.id, seat + 1);
  return made;
}

function wireTermEvents(tab) {
  const term = tab.term;
  if (!term || typeof term.on !== 'function') return;

  const listen = (event, handler) => {
    try {
      const off = term.on(event, handler);
      if (typeof off === 'function') tab.termOff.push(off);
    } catch (err) { /* terminal.js does not publish this event */ }
  };

  listen('live', (on) => {
    const live = !!on;
    tab.live = live;
    if (tab.chipEl) tab.chipEl.classList.toggle('live', live);
    recomputeClaudeLive();
    // Only relabel a tab the session never got round to naming.
    if (!live && tab.title === claudeDefaultTitle(tab)) {
      setTabTitle(tab, claudeDefaultTitle(tab) + ' (ended)');
    }
  });

  // The session stopped talking, or rang the bell. Either only counts as a
  // call for help if the user was not already looking at it: a chamber in front of
  // him on a focused window says everything a mark could.
  const attention = () => {
    if (isTabOnScreen(tab) && document.hasFocus()) return;
    markClaudeNeedsYou(tab);
  };
  listen('idle', attention);
  listen('bell', attention);

  listen('title', (text) => {
    if (isNoiseTitle(text)) return;
    let clean = String(text == null ? '' : text).trim();
    // The CLI reports a bare lowercase "claude" as its title -- and "claude ·
    // resume" / "claude · continue" when it was launched with one of those
    // flags. Both say less than the folder does, so a picker session is
    // titled by its folder exactly like every other chamber.
    if (/^claude(\s*[·:\-|]\s*(resume|continue))?$/i.test(clean)) clean = '';
    setTabTitle(tab, clean ? clean.slice(0, 60) : '');
  });
}

function disposeClaudeTab(tab) {
  if (!isClaudeTab(tab)) return;

  if (Array.isArray(tab.termOff)) {
    for (const off of tab.termOff) {
      try { off(); } catch (err) { /* already unsubscribed */ }
    }
    tab.termOff = [];
  }

  if (tab.term && typeof tab.term.dispose === 'function') {
    try { tab.term.dispose(); } catch (err) { /* session already gone */ }
  }
  tab.term = null;
  tab.live = false;
}

function activateTab(id) {
  const target = tabs.find((t) => t.id === id);
  if (!target) return;

  // Synchronously, before the display swap: the tab in front is never asleep,
  // so everything below — and everything that reads getActiveTab().viewEl —
  // is looking at a real <webview> again.
  if (target.asleep) wakeTab(target);

  // The tab in front is always in the workspace on screen. Raising one from
  // another workspace (a restore, a reopened tab, a module reaching in) brings
  // its workspace forward with it rather than showing an empty strip.
  const targetWs = tabWorkspace(target);
  let workspaceMoved = false;
  if (targetWs !== currentWorkspaceId) {
    currentWorkspaceId = targetWs;
    unsplitAcrossWorkspaces();
    syncChipWorkspaces();
    workspaceMoved = true;
  }

  activeTabId = target.id;
  target.lastActive = Date.now();
  const ws = findWorkspace(currentWorkspaceId);
  if (ws) ws.lastActiveTabId = target.id; // where switchWorkspace() comes back to

  for (const tab of tabs) {
    const isActive = tab.id === activeTabId;
    // A split pair is shown whole: both halves are on screen whenever either
    // of them is the active tab, so this is not the same test as isActive.
    const shown = isTabOnScreen(tab);
    // Nothing is destroyed on switch — hiding preserves page state and live
    // PTYs. The view itself always carries the display, split or not: it never
    // leaves #views, so there is no wrapper to toggle instead. refreshSplit()
    // below then gives the pair its side of the well.
    if (tab.viewEl) tab.viewEl.style.display = shown ? 'flex' : 'none';
    // A crash / failure card covers one tab's well, so it follows exactly the
    // same display swap as the view it sits over.
    if (tab.cardEl) tab.cardEl.style.display = shown ? 'flex' : 'none';
    if (tab.chipEl) {
      tab.chipEl.classList.toggle('active', isActive);
      tab.chipEl.setAttribute('aria-selected', String(isActive));
    }
    // Raising a waiting chamber IS answering it — and a split raises both.
    if (shown && isClaudeTab(tab) && tab.needsYou) clearClaudeNeedsYou(tab);
  }

  if (isClaudeTab(target)) {
    // Synchronously first: the display swap above already landed, and a window
    // behind another one never gets the animation frame below, so a chamber
    // that has not opened yet would otherwise stay blank until the next paint.
    try { if (target.term && typeof target.term.fit === 'function') target.term.fit(); } catch (err) { /* not open yet */ }
    // One frame later: the display swap has to land before xterm measures.
    window.requestAnimationFrame(() => {
      const term = target.term;
      if (!term) return;
      try { if (typeof term.fit === 'function') term.fit(); } catch (err) { /* not open yet */ }
      try { if (typeof term.focus === 'function') term.focus(); } catch (err) { /* not open yet */ }
    });
  } else if (isNewTabUrl(readCurrentUrl(target))) {
    // The new-tab page autofocuses its own search box, so the guest gets focus
    // rather than the omnibox. dom-ready repeats this for a tab still loading.
    focusViewSoon(target);
  }

  // The pair's order and flex-basis, the divider, and the mark on whichever
  // half the chrome is now describing. A no-op when nothing is split.
  refreshSplit();

  syncOmniboxFromActive(true);
  updateNavState();
  syncReloadButton(); // the incoming tab may be mid-load, the outgoing one not
  saveSession(); // the active index is part of the session

  // Chrome modules (find bar, downloads, history) follow the active tab
  // through this event instead of reaching into the tab model.
  document.dispatchEvent(new CustomEvent('tabchange', {
    detail: { id: target.id, kind: target.kind }
  }));
  // The machine sampler runs only while a new-tab page is the one in front.
  syncStatsSubscription();
  if (workspaceMoved) emitWorkspaceChange();
}

function closeTab(id) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return;

  const tab = tabs[index];
  const wasActive = tab.id === activeTabId;
  // Where in the STRIP the closing tab sat — the strip being this workspace's
  // chips, not the whole array, so the tab left in front is one you can see.
  const seat = wasActive ? visibleTabs().indexOf(tab) : -1;

  // A pair cannot outlive either half: this puts the partner's view back in
  // #views on its own, before anything here starts removing elements.
  unsplit(tab);

  pushClosedTab(tab); // read the url while the view is still attached

  tab.ready = false;
  disposeClaudeTab(tab); // no-op for page tabs
  clearTabCard(tab);     // the card lives in #views, not on the view
  // On a sleeping tab this drops the placeholder: the guest is long gone.
  //
  // On a page tab this line also raises one UNCATCHABLE "Invalid
  // guestInstanceId: N" in the console, from Electron, not from here. Taking a
  // live <webview> out of the document destroys its guest webContents first;
  // Electron's guest view manager deletes its registry entry on that guest's
  // 'destroyed', and only then does the element's queued disconnectedCallback
  // send its detach — which main answers through getGuestForFrame(), and that
  // throws on a missing entry (the detachGuest() behind it is already
  // tolerant). Electron 44 and upstream main both still do this. Verified with
  // a twenty-line Electron app holding one bare <webview>: same error, no app
  // code involved, and no sequence on this side avoids it (clearing src,
  // loadURL('about:blank'), stop(), or destroying the guest first all still
  // detach a guest the registry has already dropped). The error cannot be
  // caught here either: it is thrown inside Electron's own custom-element
  // reaction. It leaves nothing behind — no element, no guest, no listeners —
  // so it is console noise, except under an attached debugger, where the
  // stored exception keeps the detached <webview> (and so the tab object)
  // alive until the entries are discarded. Fix belongs upstream.
  try { tab.viewEl.remove(); } catch (err) { /* already detached */ }
  try { if (tab.chipEl) tab.chipEl.remove(); } catch (err) { /* already detached */ }
  tabs.splice(index, 1);
  recomputeClaudeLive();
  recomputeClaudeAttn(); // the pill must not keep pulsing for a closed chamber
  emitWorkspaceChange(); // a tab count moved
  pushReadoutToAll();    // ...so every open new-tab page says so
  // The tab that just went may have been the new-tab page holding the sampler
  // open; activateTab() below takes it straight back if its seat-mate is one.
  syncStatsSubscription();
  saveSession();

  if (tabs.length === 0) {
    activeTabId = null;
    createTab(HOME_URL); // never sit at zero tabs
    return;
  }

  if (wasActive) {
    // The workspace on screen must not empty out either: the last chip in it
    // closing opens a fresh tab here, not a jump to somebody else's tabs.
    const list = visibleTabs();
    if (!list.length) {
      activeTabId = null;
      createTab(HOME_URL);
      return;
    }
    const neighbour = list[Math.min(Math.max(seat, 0), list.length - 1)];
    activateTab(neighbour.id);
  } else {
    updateNavState();
  }
}

/**
 * Ctrl+W and the window action. Chrome-like: this never closes a pinned tab —
 * it steps to the next one instead, so the shortcut still feels like it did
 * something. The menu's own Close goes straight to closeTab() and does close it.
 */
function closeActiveTab() {
  if (activeTabId === null) return;
  const tab = getActiveTab();
  if (tab && tab.pinned) {
    cycleTab(1);
    return;
  }
  closeTab(activeTabId);
}

/** Open a tab and slot it straight into a position instead of at the end. */
function openTabAt(url, at) {
  const made = createTab(url);
  if (made) moveTabToIndex(made.id, at);
  return made;
}

/**
 * Ctrl+P and the chip menu. A <webview> prints itself, chrome and all, through
 * Chromium's own preview window. A Claude chamber has nothing to print.
 */
function printTab(tab) {
  if (!isViewUsable(tab)) return;
  try { tab.viewEl.print(); } catch (err) { /* guest went away mid-call */ }
}

function printActiveTab() {
  printTab(getActiveTab());
}

function reloadTab(tab) {
  // A sleeping tab has no guest to reload; waking it loads the page from
  // scratch, which is exactly what was asked for.
  if (tab && tab.asleep) { wakeTab(tab); return; }
  if (!isViewUsable(tab)) return;
  try { tab.viewEl.reload(); } catch (err) { /* view went away mid-call */ }
}

// Both sweeps leave pinned tabs alone: pinning a tab is the user saying it
// outlives the browsing around it. Both are also the STRIP's sweeps — another
// workspace's tabs are not "the other tabs", they are somewhere else entirely.
function closeOtherTabs(id) {
  // Snapshot the ids first: closeTab() splices the array as it goes.
  const doomed = visibleTabs().filter((t) => t.id !== id && !t.pinned).map((t) => t.id);
  for (const other of doomed) closeTab(other);
}

function closeTabsToRight(id) {
  const strip = visibleTabs();
  const index = strip.findIndex((t) => t.id === id);
  if (index === -1) return;
  const doomed = strip.slice(index + 1).filter((t) => !t.pinned).map((t) => t.id);
  for (const other of doomed) closeTab(other);
}

/* ------------------------------------------------------------------ */
/* Tab context menu                                                    */
/* ------------------------------------------------------------------ */

/*
 * A chrome-side menu, not a native one: Menu.popup() would paint a grey Win32
 * panel in the middle of the glass and take the pointer with it. #tabmenu is
 * position:fixed on --panel-bg, so it also reads over a <webview>.
 *
 * Items are plain objects { label, run, disabled }; a null entry is a separator.
 */
let tabMenuEl = null;
let tabMenuRows = [];  // enabled rows only, in DOM order — this is what arrows walk
let tabMenuIndex = -1;

/** Ctrl+Shift+T has something to bring back. Also gates the menu item. */
function hasClosedTabs() {
  return closedStack.length > 0;
}

function tabMenuIsOpen() {
  return !!(tabMenuEl && !tabMenuEl.hidden);
}

function closeTabMenu() {
  if (!tabMenuEl || tabMenuEl.hidden) return;
  tabMenuEl.hidden = true;
  tabMenuEl.textContent = '';
  tabMenuRows = [];
  tabMenuIndex = -1;
}

function highlightTabMenu(index) {
  tabMenuIndex = index;
  for (let i = 0; i < tabMenuRows.length; i++) {
    tabMenuRows[i].el.classList.toggle('is-hi', i === index);
  }
}

/** Arrow keys. Disabled items are not in tabMenuRows, so they are skipped. */
function moveTabMenuHighlight(step) {
  if (!tabMenuRows.length) return;
  const count = tabMenuRows.length;
  const next = tabMenuIndex === -1
    ? (step > 0 ? 0 : count - 1)
    : (tabMenuIndex + step + count) % count;
  highlightTabMenu(next);
}

function runTabMenuRow(index) {
  const row = tabMenuRows[index];
  closeTabMenu(); // the action may rebuild the strip under the menu
  if (row && typeof row.run === 'function') row.run();
}

function openTabMenu(x, y, items) {
  if (!tabMenuEl || !Array.isArray(items) || !items.length) return;
  closeTabMenu();

  for (const item of items) {
    if (!item) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      sep.setAttribute('role', 'separator');
      tabMenuEl.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = item.disabled ? 'menu-item is-off' : 'menu-item';
    row.setAttribute('role', 'menuitem');
    row.textContent = item.label;
    // A row whose label is a short name (a recent folder) can carry the long
    // one as its tooltip; every other row leaves the attribute off entirely.
    if (item.title) row.title = item.title;
    tabMenuEl.appendChild(row);
    if (item.disabled) {
      row.setAttribute('aria-disabled', 'true');
      continue; // dimmed: not clickable, not reachable with the arrows
    }
    const at = tabMenuRows.length;
    tabMenuRows.push({ el: row, run: item.run });
    row.addEventListener('mousemove', () => highlightTabMenu(at));
    row.addEventListener('click', () => runTabMenuRow(at));
  }

  // Laid out at the origin first: the size is only measurable once visible, and
  // both axes are clamped so a chip near an edge never hangs the menu off-window.
  tabMenuEl.style.left = '0px';
  tabMenuEl.style.top = '0px';
  tabMenuEl.hidden = false;
  const rect = tabMenuEl.getBoundingClientRect();
  const left = Math.max(6, Math.min(x, window.innerWidth - rect.width - 6));
  const top = Math.max(6, Math.min(y, window.innerHeight - rect.height - 6));
  tabMenuEl.style.left = Math.round(left) + 'px';
  tabMenuEl.style.top = Math.round(top) + 'px';

  // Focus moves off the page so the arrows and Escape land here, not in a guest.
  try { tabMenuEl.focus(); } catch (err) { /* never fatal */ }
  highlightTabMenu(-1);
}

/** Right-click on a chip. Page-only items are dropped for a Claude chamber. */
function tabMenuItemsForTab(tab) {
  const page = tab.kind === 'page';
  const items = [
    { label: 'New tab to the right', run: () => openTabAt(HOME_URL, stripSeat(tab) + 1) }
  ];

  if (page) {
    items.push({ label: 'Reload', run: () => reloadTab(tab) });
    // The CURRENT url, not the one the tab was opened on.
    items.push({
      label: 'Duplicate',
      run: () => openTabAt(readCurrentUrl(tab) || tab.url, stripSeat(tab) + 1)
    });
    items.push({
      label: tab.pinned ? 'Unpin tab' : 'Pin tab',
      run: () => setTabPinned(tab, !tab.pinned)
    });
    items.push({
      label: tab.muted ? 'Unmute tab' : 'Mute tab',
      run: () => setTabMuted(tab, !tab.muted)
    });
    // Split view. A pair is broken from either chip; otherwise the two ways in
    // are "pair this chip with the tab after it" and, when the tab in front is
    // a different page tab, "pair the tab in front with this chip".
    const partner = splitPartner(tab);
    const active = getActiveTab();
    if (partner) {
      items.push({ label: 'Unsplit', run: () => unsplit(tab) });
    } else {
      items.push({
        label: 'Split with next tab',
        run: () => splitTabWithNext(tab),
        disabled: !nextSplittableTab(tab)
      });
      if (active && active !== tab && canSplitTab(active)) {
        items.push({ label: 'Split with this tab', run: () => splitWithTab(tab.id) });
      }
      // The pairing this window is for: a fresh chamber on the right of it.
      items.push({
        label: 'Open Claude beside this page',
        run: () => openClaudeBesideTab(tab)
      });
    }
    // The same gesture as the page's own context menu, from the chip: a
    // chamber beside this page with the page already quoted into its input.
    items.push({
      label: 'Ask Claude about this page',
      run: () => askClaudeAboutTab(tab)
    });
    // …and the same thing with the page's picture attached: a PNG in Downloads
    // and its path in the chamber's input, which Claude Code can open.
    items.push({
      label: 'Show Claude this page',
      run: () => showClaudeThisPage({
        url: readCurrentUrl(tab) || tab.url || '',
        title: tab.title || ''
      })
    });
    // ...and the same thing with the article's words: only offered when the
    // reader probe has not already said there is nothing to read here.
    if (readerSaysArticle(tab) !== false) {
      items.push({
        label: 'Ask Claude about this article',
        run: () => askClaudeAboutArticle({
          url: readCurrentUrl(tab) || tab.url || '',
          title: tab.title || ''
        })
      });
    }
    items.push({ label: 'Print…', run: () => printTab(tab) });
    // Sleeping is reversible and costs nothing to offer, so the row is always
    // there: disabled on a tab that is not allowed to sleep right now.
    items.push(tab.asleep
      ? { label: 'Wake tab', run: () => wakeTab(tab) }
      : { label: 'Sleep tab', run: () => sleepTab(tab), disabled: !canSleepTab(tab) });
  } else {
    // Same folder, fresh session — the chamber already running is untouched.
    // Duplicate is deliberately not offered: a PTY cannot be copied.
    items.push({
      label: 'Open folder in new Claude tab',
      run: () => createClaudeTab({ cwd: tab.cwd })
    });
    // ...and the same folder's history: the CLI's picker, in a tab seated
    // right after this one.
    items.push({
      label: 'Resume another conversation here',
      run: () => resumeClaudeBesideTab(tab)
    });
    // A chamber splits like anything else now: broken from either chip, and
    // paired with whichever page the user was reading before they came here.
    if (splitPartner(tab)) {
      items.push({ label: 'Unsplit', run: () => unsplit(tab) });
    } else {
      const recent = mostRecentTabOfKind('page');
      items.push({
        label: 'Split with the page I was on',
        run: () => splitClaudeWithRecentPage(tab),
        disabled: !recent
      });
    }
  }

  // Workspaces. The picker itself belongs to workspaces.js, so this row is
  // feature-detected: an older chrome without that module just greys it out.
  const mover = (window.Workspaces && typeof window.Workspaces.openMove === 'function')
    ? window.Workspaces.openMove : null;
  items.push({
    label: 'Move to workspace…',
    run: () => { if (mover) mover(tab.id); },
    disabled: !mover || workspaces.length < 2
  });

  items.push(null);
  // Close is the one route that still closes a pinned tab: the user asked for
  // this tab by name, so it is not the accident the middle-click guard is for.
  items.push({ label: 'Close', run: () => closeTab(tab.id) });
  items.push({
    label: 'Close other tabs',
    run: () => closeOtherTabs(tab.id),
    disabled: !visibleTabs().some((t) => t.id !== tab.id && !t.pinned)
  });
  items.push({
    label: 'Close tabs to the right',
    run: () => closeTabsToRight(tab.id),
    disabled: !visibleTabs().slice(stripSeat(tab) + 1).some((t) => !t.pinned)
  });
  items.push(null);
  items.push({ label: 'Reopen closed tab', run: reopenClosedTab, disabled: !hasClosedTabs() });
  return items;
}

/**
 * Right-click on bare strip: there is no tab to act on, so only these five —
 * plus a row per recent Claude folder, which is nothing at all on a profile
 * that has never opened one.
 */
function tabMenuItemsForStrip() {
  const items = [
    { label: 'New tab', run: () => createTab(HOME_URL) },
    { label: 'New Claude tab in folder…', run: newClaudeTabInFolder },
    // The default folder, opened straight onto its past conversations.
    { label: 'Resume a Claude conversation…', run: resumeClaudeConversation }
  ];
  // The folders chambers have actually run in: the picker, already answered.
  for (const row of claudeRecentMenuItems(5)) items.push(row);
  // The manual version of the idle sweep: the tab in front is never touched.
  items.push({ label: 'Sleep other tabs', run: sleepOtherTabs, disabled: !tabs.some(canSleepTab) });
  items.push({ label: 'Reopen closed tab', run: reopenClosedTab, disabled: !hasClosedTabs() });
  return items;
}

/**
 * index.html owns #tabmenu, but an older one would lose right-click entirely,
 * so the pane is built here when it is missing. Attributes are set either way.
 */
function resolveTabMenu() {
  tabMenuEl = document.getElementById('tabmenu');
  if (!tabMenuEl) {
    tabMenuEl = document.createElement('div');
    tabMenuEl.id = 'tabmenu';
    document.body.appendChild(tabMenuEl);
  }
  tabMenuEl.setAttribute('role', 'menu');
  tabMenuEl.setAttribute('tabindex', '-1'); // focusable, never in the tab order
  tabMenuEl.hidden = true;
}

function wireTabMenu() {
  if (!tabMenuEl) return;

  tabMenuEl.addEventListener('keydown', (event) => {
    const key = event.key;
    if (key === 'Escape' || key === 'Tab') {
      event.preventDefault();
      event.stopPropagation(); // the window handler must not also see it
      closeTabMenu();
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      moveTabMenuHighlight(key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (key === 'Home' || key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      highlightTabMenu(key === 'Home' ? 0 : tabMenuRows.length - 1);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (tabMenuIndex >= 0) runTabMenuRow(tabMenuIndex);
    }
  });

  // Anything that moves the ground under the menu dismisses it. Capture phase:
  // the press that opens a second menu closes the first one first.
  window.addEventListener('mousedown', (event) => {
    if (!tabMenuIsOpen()) return;
    if (event.target && tabMenuEl.contains(event.target)) return;
    closeTabMenu();
  }, true);
  window.addEventListener('blur', closeTabMenu);
  window.addEventListener('resize', closeTabMenu);
  window.addEventListener('scroll', closeTabMenu, true); // the strip scrolls too
}

/* ------------------------------------------------------------------ */
/* Session persistence and reopened tabs                               */
/* ------------------------------------------------------------------ */

/*
 * Both kinds of tab are persisted, in one list that keeps the strip's order:
 *   a page tab   — { url, pinned?, muted? }, the flags written only when true.
 *   a Claude tab — { claude: true, cwd }. The PTY itself cannot be saved, so
 *                  what is stored is the folder; the chamber is respawned there
 *                  on boot, resuming that folder's last conversation when
 *                  settings say so.
 * `active` is an index into that single list, so it follows either kind.
 *
 * The snapshot is written twice: to localStorage (synchronous, authoritative in
 * practice) and to a file in userData through api.session (durable across a
 * cleared profile). Boot reads both and takes whichever has the newer savedAt.
 *
 * Every localStorage call below is wrapped — storage can be blocked or full, and
 * losing the session must never take the browser down with it.
 */
const SESSION_STORAGE_KEY = 'session';
const SESSION_SAVE_DELAY = 500;
// How long boot waits for the file copy before going with localStorage alone.
const SESSION_READ_TIMEOUT = 300;
const SESSION_MAX_TABS = 40;
// 'main' plus however many the user made; a bound so a corrupt file cannot
// grow the switcher without limit.
const SESSION_MAX_WORKSPACES = 24;
// Stand-in for the bundled new-tab page. Storing its file:// URL would freeze a
// stale ?theme= into the session, so the marker is resolved on restore instead.
const SESSION_NEWTAB = 'newtab';

// True only while restoreSession() is building the strip. Saves are suppressed
// throughout, so a half-built session never overwrites the stored one.
let restoring = false;
let sessionSaveTimer = null;

/** Urls of page tabs closed this run, newest last. Ctrl+Shift+T pops from it. */
const closedStack = [];
const CLOSED_STACK_MAX = 20;

/** The url a tab should be stored as, or null when it is not persistable. */
function sessionUrlFor(tab) {
  if (!tab || tab.kind !== 'page') return null;
  const url = readCurrentUrl(tab) || tab.url;
  if (isNewTabUrl(url)) return SESSION_NEWTAB;
  // The article itself is what comes back after a restart: the reader wrapper
  // has no article to show until someone opens it from a loaded page.
  const parsed = parseUrlOrNull(readerSourceOf(url) || url);
  // Web pages only: a file:// or data: tab is not worth reopening cold.
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
  return parsed.href;
}

/**
 * One stored tab is { url } plus the flags that are worth carrying across a
 * restart (written only when true, so an old session reads the same), or
 * { claude: true, cwd } for a chamber. Order is strip order across both kinds.
 *
 * Workspaces ride along the same way: an entry gets `ws` only when it is not
 * 'main', the list itself goes in under `workspaces` (each one's `lastActive`
 * being an INDEX into the stored entries, exactly like the top-level `active`,
 * because tab ids are minted fresh on every boot), and `currentWorkspace` says
 * which one the strip was showing. A session written before any of this reads
 * back as one 'main' workspace holding everything.
 */
function sessionSnapshot() {
  const entries = [];
  const seatById = new Map(); // tab id -> its index in `entries`
  let active = -1;
  for (const tab of tabs) {
    let entry = null;
    if (isClaudeTab(tab)) {
      const cwd = (typeof tab.cwd === 'string' && tab.cwd) ? tab.cwd : '';
      if (!cwd) continue; // nothing to respawn into: it would be dropped on read
      entry = { claude: true, cwd: cwd };
    } else {
      const url = sessionUrlFor(tab);
      if (!url) continue; // an unpersistable page shifts nothing
      entry = { url: url };
      if (tab.pinned) entry.pinned = true;
      if (tab.muted) entry.muted = true;
    }
    const ws = tabWorkspace(tab);
    if (ws !== DEFAULT_WORKSPACE_ID) entry.ws = ws;
    if (tab.id === activeTabId) active = entries.length;
    seatById.set(tab.id, entries.length);
    entries.push(entry);
  }
  const capped = entries.slice(0, SESSION_MAX_TABS);
  const seatOf = (id) => {
    const at = seatById.has(id) ? seatById.get(id) : -1;
    return at < capped.length ? at : -1;
  };
  return {
    tabs: capped,
    active: active < capped.length ? active : -1,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      colour: w.colour,
      lastActive: seatOf(w.lastActiveTabId)
    })),
    currentWorkspace: currentWorkspaceId,
    savedAt: Date.now() // boot compares the two copies on this
  };
}

function writeSession() {
  // Clear as well as forget: writing early (a restart, a close) must not leave
  // an armed timer behind to write the same snapshot a second time.
  if (sessionSaveTimer !== null) window.clearTimeout(sessionSaveTimer);
  sessionSaveTimer = null;
  if (restoring) return;
  const snapshot = sessionSnapshot();
  try {
    // Zero tabs is a legitimate state and is stored as such.
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (err) { /* storage blocked or full — this run just loses its session */ }

  // The durable copy. preload may predate api.session, and the write is fire
  // and forget either way: nothing in the chrome waits on it.
  const store = (window.api && window.api.session) ? window.api.session : null;
  if (!store || typeof store.write !== 'function') return;
  try {
    const pending = store.write(snapshot);
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (err) { /* the file copy is best-effort */ }
}

/**
 * Debounced on one shared timer, so a burst of navigations or a run of closes
 * writes once. Never fires while restoring.
 */
function saveSession() {
  if (restoring) return;
  if (sessionSaveTimer !== null) window.clearTimeout(sessionSaveTimer);
  sessionSaveTimer = window.setTimeout(writeSession, SESSION_SAVE_DELAY);
}

/**
 * The debounce's one weak spot: a window closed inside SESSION_SAVE_DELAY of
 * the last change loses it. 'beforeunload' is synchronous and runs before the
 * document goes, so the pending write lands there. restartBrowser() already
 * flushes the same way for the same reason; this covers the ordinary close.
 */
function flushSession() {
  if (sessionSaveTimer === null) return; // nothing outstanding
  try { writeSession(); } catch (err) { /* a lost snapshot must not block the close */ }
}

/**
 * Sanitise one parsed snapshot, whichever copy it came from. Returns null when
 * there is nothing usable — malformed, or every entry dropped. `urls` is kept
 * beside the entries because it is what this has always returned; Claude
 * entries are not urls and are left out of it.
 * @returns {{entries:Array<{claude:boolean,cwd:string,url:string,
 *            pinned:boolean,muted:boolean,ws:string}>,
 *            urls:string[], active:number,
 *            workspaces:Array<{id:string,name:string,colour:string|null,
 *                              lastActive:number}>,
 *            currentWorkspace:string, savedAt:number}|null}
 */
function sanitiseSession(parsed) {
  if (!parsed || !Array.isArray(parsed.tabs)) return null;

  // Workspaces first: an entry's `ws` is only kept when it names one of these,
  // and 'main' is always the head of the list whatever the file said.
  const wsList = [{ id: DEFAULT_WORKSPACE_ID, name: 'Home', colour: null, lastActive: -1 }];
  const wsSeen = new Set([DEFAULT_WORKSPACE_ID]);
  const wsRaw = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
  for (const row of wsRaw) {
    const id = (row && typeof row.id === 'string') ? row.id.trim() : '';
    if (!id || id.length > 64) continue;
    const at = Number(row && row.lastActive);
    const lastActive = (isFinite(at) && at >= 0) ? Math.floor(at) : -1;
    const colour = cleanWorkspaceColour(row && row.colour);
    if (id === DEFAULT_WORKSPACE_ID) {
      wsList[0].name = cleanWorkspaceName(row && row.name, 'Home');
      wsList[0].colour = colour;
      wsList[0].lastActive = lastActive;
      continue;
    }
    if (wsSeen.has(id)) continue;
    wsSeen.add(id);
    wsList.push({ id: id, name: cleanWorkspaceName(row && row.name), colour: colour, lastActive: lastActive });
    if (wsList.length >= SESSION_MAX_WORKSPACES) break;
  }

  const entries = [];
  for (const entry of parsed.tabs) {
    // An unknown workspace is not a reason to drop a tab: it comes home.
    const ws = (entry && typeof entry.ws === 'string' && wsSeen.has(entry.ws))
      ? entry.ws : DEFAULT_WORKSPACE_ID;
    if (entry && entry.claude) {
      const cwd = (typeof entry.cwd === 'string') ? entry.cwd.trim() : '';
      if (!cwd) continue; // a chamber with no folder cannot be rebuilt
      entries.push({ claude: true, cwd: cwd, url: '', pinned: false, muted: false, ws: ws });
      if (entries.length >= SESSION_MAX_TABS) break;
      continue;
    }
    const url = (entry && typeof entry.url === 'string') ? entry.url : '';
    if (!url) continue;
    let href = '';
    if (url === SESSION_NEWTAB) {
      href = SESSION_NEWTAB;
    } else {
      const target = parseUrlOrNull(url);
      // Anything that is not plain web goes on the floor, whoever wrote it.
      if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) continue;
      href = target.href;
    }
    entries.push({
      claude: false, cwd: '', url: href,
      pinned: !!(entry && entry.pinned), muted: !!(entry && entry.muted), ws: ws
    });
    if (entries.length >= SESSION_MAX_TABS) break;
  }
  if (!entries.length) return null;

  // Entries can be dropped above, so every stored index is clamped to what is
  // actually left — the same latitude the top-level `active` has always had.
  for (const ws of wsList) {
    if (ws.lastActive >= entries.length) ws.lastActive = -1;
  }
  const current = (typeof parsed.currentWorkspace === 'string' && wsSeen.has(parsed.currentWorkspace))
    ? parsed.currentWorkspace : DEFAULT_WORKSPACE_ID;

  const active = Number(parsed.active);
  const inRange = isFinite(active) && active >= 0 && active < entries.length;
  const savedAt = Number(parsed.savedAt);
  return {
    entries: entries,
    urls: entries.filter((e) => !e.claude).map((e) => e.url),
    active: inRange ? active : entries.length - 1,
    workspaces: wsList,
    currentWorkspace: current,
    // A snapshot written before savedAt existed loses every tie-break.
    savedAt: (isFinite(savedAt) && savedAt > 0) ? savedAt : 0
  };
}

/** The localStorage copy, read synchronously. Null when missing or unusable. */
function readSession() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
  } catch (err) {
    return null; // storage blocked
  }
  if (!raw) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return null; // malformed
  }
  return sanitiseSession(parsed);
}

/**
 * Both copies, newest wins. localStorage is there immediately; the file copy
 * comes over IPC, so boot waits a beat for it rather than racing — but never
 * longer than SESSION_READ_TIMEOUT, because a hung main process must not hold
 * the window at zero tabs.
 * @returns {Promise<object|null>}
 */
function loadSession() {
  const local = readSession();
  const store = (window.api && window.api.session) ? window.api.session : null;
  if (!store || typeof store.read !== 'function') return Promise.resolve(local);

  let pending = null;
  try { pending = store.read(); } catch (err) { return Promise.resolve(local); }
  if (!pending || typeof pending.then !== 'function') return Promise.resolve(local);

  const raced = new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    window.setTimeout(() => finish(null), SESSION_READ_TIMEOUT);
    pending.then((raw) => {
      let clean = null;
      try { clean = sanitiseSession(raw); } catch (err) { clean = null; }
      finish(clean);
    }, () => finish(null));
  });

  return raced.then((fromFile) => {
    if (!fromFile) return local;
    if (!local) return fromFile;
    return fromFile.savedAt > local.savedAt ? fromFile : local;
  });
}

/**
 * Rebuild last run's strip — page tabs and Claude chambers alike. Returns true
 * when it took over the boot; init() falls back to its single HOME_URL tab when
 * this says no.
 * @param {object} [snapshot] a session already read (loadSession's winner).
 *        Omitted, it reads localStorage, which is what this has always done.
 */
function restoreSession(snapshot) {
  const session = (snapshot === undefined) ? readSession() : snapshot;
  if (!session || !Array.isArray(session.entries)) return false;

  // Pinned tabs live at the left of the strip, so they are rebuilt first. The
  // partition is stable, so each group keeps the order it was stored in, and
  // the stored active index is followed through the shuffle by identity.
  // A Claude chamber is never pinned, so it always lands in the second group.
  const rows = session.entries.map((entry, index) => ({ entry: entry, index: index }));
  const ordered = rows.filter((r) => r.entry.pinned).concat(rows.filter((r) => !r.entry.pinned));

  // The workspace list is rebuilt BEFORE the first tab, so every chip is born
  // with the right workspace and the right hidden state — no reshuffle after.
  const storedWorkspaces = Array.isArray(session.workspaces) ? session.workspaces : null;
  if (storedWorkspaces && storedWorkspaces.length) {
    workspaces.length = 0;
    for (const row of storedWorkspaces) {
      workspaces.push({
        id: row.id, name: row.name, colour: row.colour, lastActiveTabId: null
      });
      // Never mint an id a restored workspace already holds.
      const n = /^ws(\d+)$/.exec(row.id);
      if (n) nextWorkspaceSeq = Math.max(nextWorkspaceSeq, Number(n[1]) + 1);
    }
    if (!findWorkspace(DEFAULT_WORKSPACE_ID)) {
      workspaces.unshift({ id: DEFAULT_WORKSPACE_ID, name: 'Home', colour: null, lastActiveTabId: null });
    }
  }
  const wantCurrent = validWorkspaceId(session.currentWorkspace);
  currentWorkspaceId = wantCurrent;

  restoring = true;
  const created = [];
  const bySeat = new Map(); // stored entry index -> the tab rebuilt from it
  let wanted = null;
  try {
    // All background: the strip is built in order, then the saved tab is raised.
    const resume = settingGet('claudeResume') !== false; // unset means yes
    for (const row of ordered) {
      const entry = row.entry;
      const tab = entry.claude
        ? createClaudeTab({ cwd: entry.cwd, resume: resume, background: true, workspace: entry.ws })
        : createTab(entry.url === SESSION_NEWTAB ? HOME_URL : entry.url, {
          background: true,
          pinned: entry.pinned,
          muted: entry.muted,
          workspace: entry.ws
        });
      if (!tab) continue;
      created.push(tab);
      bySeat.set(row.index, tab);
      if (row.index === session.active) wanted = tab;
    }
  } finally {
    // A throw mid-build must not strand the flag and mute every later save.
    restoring = false;
  }

  if (!created.length) return false;

  // Each workspace's remembered tab, by the index it was stored under. The
  // build above raised the first tab it made (the window is never empty), so
  // whatever that wrote is cleared before the stored answers go in.
  if (storedWorkspaces) {
    for (const ws of workspaces) ws.lastActiveTabId = null;
    for (const row of storedWorkspaces) {
      const ws = findWorkspace(row.id);
      const tab = bySeat.get(row.lastActive);
      if (ws && tab) ws.lastActiveTabId = tab.id;
    }
  }

  // Come back up in the workspace that was on screen — unless nothing in it
  // survived the read, in which case the tab we do have decides.
  let pool = created.filter((t) => tabWorkspace(t) === wantCurrent);
  if (!pool.length) pool = created;
  const target = (wanted && pool.indexOf(wanted) !== -1) ? wanted : pool[pool.length - 1];
  currentWorkspaceId = tabWorkspace(target);
  syncChipWorkspaces();
  activateTab(target.id);
  emitWorkspaceChange(); // one event for the whole rebuild
  saveSession(); // one write, now that the strip is settled
  return true;
}

/** Remember a closed page tab so Ctrl+Shift+T can bring it back. */
function pushClosedTab(tab) {
  if (!tab || tab.kind !== 'page') return; // a closed Claude session cannot reopen
  const url = readCurrentUrl(tab) || tab.url;
  // A blank new tab is not worth a slot on the stack.
  if (!url || isNewTabUrl(url)) return;
  closedStack.push(readerSourceOf(url) || url); // reopen the article, not the wrapper
  while (closedStack.length > CLOSED_STACK_MAX) closedStack.shift();
}

/** Ctrl+Shift+T. Pops the newest closed url; a no-op once the stack is empty. */
function reopenClosedTab() {
  const url = closedStack.pop();
  if (!url) return;
  createTab(url); // foreground, like any tab the user opens deliberately
}

/* ------------------------------------------------------------------ */
/* webview events                                                      */
/* ------------------------------------------------------------------ */

/**
 * sitestyles.js is optional and loads after this file, so the hook is
 * feature-detected on every call. It may hand back a promise
 * (executeJavaScript), which must never surface as an unhandled rejection.
 */
function applySiteStyles(tab) {
  const mod = window.SiteStyles;
  if (!mod || typeof mod.applyTo !== 'function') return;
  try {
    const pending = mod.applyTo(tab);
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (err) { /* per-site CSS is decoration: it never breaks a load */ }
}

/**
 * Tell the chrome modules a page tab reached a milestone. Same shape as
 * 'tabchange': the id plus the url, so nothing has to reach into the tab model.
 */
function emitTabEvent(name, tab) {
  document.dispatchEvent(new CustomEvent(name, {
    detail: { id: tab.id, url: readCurrentUrl(tab) || tab.url }
  }));
}

function wireViewEvents(tab) {
  const viewEl = tab.viewEl;
  // A view that has been slept (or replaced by wakeTab) is detached but can
  // still fire one last event. Its tab has moved on to another element by then,
  // so those land here and are dropped.
  const stale = () => tab.viewEl !== viewEl;

  // Everything navCache remembers about a guest — its url, whether it can go
  // back or forward, and its zoom level — is only allowed to change across a
  // navigation, and these are the events a navigation fires. Dropping the
  // record here is what makes the cached reads exact rather than merely fast.
  // load-commit is in the list on purpose: it is the one event that fires for
  // EVERY commit, main frame or not, so nothing can slip past the others.
  const freshGuest = () => {
    if (stale()) return;
    dropNavCache(tab);
  };
  viewEl.addEventListener('load-commit', freshGuest);

  viewEl.addEventListener('dom-ready', () => {
    if (stale()) return;
    dropNavCache(tab);  // a new document: everything remembered about the old one is gone
    dropPushMemo(tab);  // ...and it has none of the state the chrome pushed it
    tab.ready = true;
    // The guest only exists from here: a restored mute is re-applied to it, and
    // the new-tab page gets the recent list it cannot read for itself.
    syncTabMutedFromView(tab);
    // dom-ready fires for every document, so a reload lands here too — and a
    // reloaded new-tab page has re-read the params newTabUrl() froze when the
    // tab was made (a dark chrome came back light). The live state is pushed
    // back over them, theme first: the accent is derived per theme.
    pushThemeToTab(tab, getTheme());
    pushSettingsToTab(tab);
    pushRecentToTab(tab);
    pushBackgroundToTab(tab);
    pushAppsToTab(tab);   // the app dock: pins, the installed list, running state
    pushProcIconCacheToTab(tab);  // process icons we already have, in one go
    pushHistoryToTab(tab);
    pushReadoutToTab(tab);
    // A new document has not opted out of anything yet; ask it once, and take
    // the subscription now rather than waiting for that answer to come back.
    tab.statsWanted = true;
    queryStatsWanted(tab);
    syncStatsSubscription();
    // did-navigate can land before the guest exists, so the site's remembered
    // zoom is applied here too. It paints the badge when this tab is in front.
    applyStoredZoom(tab);
    if (tab.id === activeTabId) {
      syncOmniboxFromActive(false);
      updateNavState();
      // The very first tab is activated before its guest exists; hand the
      // new-tab page focus now so its autofocused search field gets the keys.
      if (isNewTabUrl(readCurrentUrl(tab))) focusViewSoon(tab);
    }
    // Per-document, once the guest exists: this is the only point where the
    // page is there to take CSS and is not yet on screen.
    applySiteStyles(tab);
    emitTabEvent('tabready', tab);
  });

  // The page started or stopped making a sound. Chromium fires these per media
  // element, so they are a level, not an event: the chip just follows.
  viewEl.addEventListener('media-started-playing', () => {
    if (stale()) return;
    setTabAudible(tab, true);
  });
  viewEl.addEventListener('media-paused', () => {
    if (stale()) return;
    setTabAudible(tab, false);
  });

  viewEl.addEventListener('destroyed', () => {
    if (stale()) return;
    tab.ready = false;
  });

  // Clicking into the OTHER half of a split moves the chrome to that tab. The
  // guest eats the press itself, so the element taking focus is the only signal
  // that it happened. Guarded twice over: this only ever fires for a view that
  // is on screen beside the active one, so it can never steal the active tab.
  viewEl.addEventListener('focus', () => {
    if (stale()) return;
    if (tab.id === activeTabId) return;
    const other = splitPartner(tab);
    if (!other || other.id !== activeTabId) return;
    activateTab(tab.id);
  });

  viewEl.addEventListener('page-title-updated', (event) => {
    if (stale()) return;
    setTabTitle(tab, event && event.title);
    historyCall('updateTitle', tab.url, event && event.title);
  });

  const onNavigate = (event) => {
    if (stale()) return;
    dropNavCache(tab); // the url and the history stack both just moved
    if (event && event.url) tab.url = event.url;
    // did-fail-load can land either side of the error page's own did-navigate,
    // so a navigation only clears the card when THIS load did not fail.
    if (!tab.failedThisLoad) clearTabCard(tab);
    setTabTitle(tab, tab.title);
    // Zoom is remembered per site, so it is re-applied per navigation — a host
    // with nothing stored is explicitly put back to 100%.
    applyStoredZoom(tab);
    if (tab.id === activeTabId) {
      setOmniboxValue(tab.url, false); // guarded: never clobber live typing
      updateNavState();
    }
    saveSession(); // background tabs move too, and the debounce absorbs bursts
    historyCall('record', tab.url, tab.title);
  };

  viewEl.addEventListener('did-navigate', onNavigate);
  viewEl.addEventListener('did-navigate-in-page', (event) => {
    if (event && event.isMainFrame === false) return;
    onNavigate(event);
  });

  viewEl.addEventListener('did-start-loading', () => {
    if (stale()) return;
    dropNavCache(tab); // a navigation has begun
    setTabLoading(tab, true);
    clearTabIcon(tab); // the incoming page reports its own, or stays blank
    tab.failedThisLoad = false;
    clearTabCard(tab); // a fresh attempt: last time's failure leaves the screen
  });

  viewEl.addEventListener('did-stop-loading', () => {
    if (stale()) return;
    dropNavCache(tab); // the settled url and history stack are the authority now
    setTabLoading(tab, false);
    if (tab.id === activeTabId) updateNavState();
    emitTabEvent('tabloaded', tab);
  });

  viewEl.addEventListener('did-fail-load', (event) => {
    if (stale()) return;
    dropNavCache(tab); // an error page is a document like any other
    // Aborted and failed loads both end here; the spinner must not stick.
    setTabLoading(tab, false);
    if (!event) return;
    if (event.isMainFrame === false) return;       // a dead image is not a dead page
    const code = Number(event.errorCode);
    if (code === -3 || code === 0) return;         // ERR_ABORTED, and "failed" successes
    const url = event.validatedURL || tab.url;
    // newtab.html is a local file:// page: it fails on nothing a card explains.
    if (isNewTabUrl(url)) return;

    tab.failedThisLoad = true;
    const detail = hostLabel(url) + ' — ' + failureMessage(event.errorDescription, code);
    showTabCard(tab, 'network', detail);
  });

  // The guest's renderer died. 'crashed' is the pre-Electron-22 spelling and is
  // kept so the card still appears on an older runtime.
  const onGone = (reason) => {
    if (stale()) return; // we took the guest away ourselves: not a crash
    if (reason === 'clean-exit') return; // an ordinary teardown, not a crash
    tab.ready = false;
    setTabLoading(tab, false);
    showTabCard(tab, 'crash', hostLabel(tab.url));
  };
  viewEl.addEventListener('render-process-gone', (event) => {
    onGone(event && event.details && event.details.reason);
  });
  viewEl.addEventListener('crashed', () => onGone(null));

  // A video going fullscreen inside the page: the chrome steps aside.
  viewEl.addEventListener('enter-html-full-screen', () => {
    if (tab.id === activeTabId) setPageFullscreen(true);
  });
  viewEl.addEventListener('leave-html-full-screen', () => {
    setPageFullscreen(false);
  });

  // The history page (a preload-less guest) asks for removals/opens via
  // console lines; history.js parses them and reports whether it acted.
  viewEl.addEventListener('console-message', (event) => {
    if (tab.viewEl !== viewEl || !isHistoryTab(tab)) return;
    const store = window.History;
    if (!store || typeof store.handleGuestMessage !== 'function') return;
    let acted = false;
    try { acted = !!store.handleGuestMessage(event && event.message); } catch (err) { acted = false; }
    if (acted) pushHistoryToAll();
  });

  // The new tab page asks to end a process the same preload-less way: one
  // console line per press, answered on window.__applyEndTask.
  viewEl.addEventListener('console-message', (event) => {
    handleEndTaskLine(tab, viewEl, event && event.message);
  });

  // ...and to launch, focus, pin, unpin or re-index a native app, on
  // `newtab:app {json}`, answered on window.__applyAppResult.
  viewEl.addEventListener('console-message', (event) => {
    handleAppLine(tab, viewEl, event && event.message);
  });

  viewEl.addEventListener('page-favicon-updated', (event) => {
    if (stale()) return;
    try {
      const icons = event && event.favicons;
      if (Array.isArray(icons) && icons.length) setTabIcon(tab, icons[0]);
    } catch (err) { /* malformed event payload */ }
  });

  // target="_blank", window.open() and Ctrl+click are NOT handled here. The
  // <webview> 'new-window' DOM event this used to listen for was removed from
  // Electron in v22, so a listener on it is dead code on 44. Main owns it now:
  // setWindowOpenHandler() on the guest webContents denies the window and
  // sends 'open-url', which onOpenUrl() below turns into a tab.
}

/* ------------------------------------------------------------------ */
/* Crash and load-failure cards                                        */
/* ------------------------------------------------------------------ */

/*
 * A crashed guest paints nothing and Chromium's own error page is a grey
 * sheet, so the chrome covers the well instead: tab.cardEl is a sibling of the
 * <webview> inside #views and activateTab() shows or hides it with the view.
 * The tab keeps tab.url throughout, which is what "Try again" goes back to.
 */

// Chromium's error strings, said the way a person would. Anything not listed
// falls through to the code itself rather than to a guess.
const FAILURE_TEXT = {
  ERR_NAME_NOT_RESOLVED: 'The address couldn\'t be found',
  ERR_INTERNET_DISCONNECTED: 'You\'re offline',
  ERR_CONNECTION_REFUSED: 'The site refused the connection',
  ERR_CONNECTION_TIMED_OUT: 'It took too long to respond'
};

const CARD_GLYPH = { crash: '\uE7BA', network: '\uE774' };
const CARD_HEAD = { crash: 'This page crashed', network: 'Can\'t reach this site' };

function failureMessage(description, code) {
  const key = String(description == null ? '' : description).trim().toUpperCase();
  if (FAILURE_TEXT[key]) return FAILURE_TEXT[key];
  // Every certificate failure means the same thing to the person reading it.
  if (key.indexOf('ERR_CERT') === 0) return 'Its security certificate isn\'t trusted';
  const n = Number(code);
  const shown = key || (code == null || !isFinite(n) ? 'ERR_FAILED' : String(n));
  return 'Something went wrong (' + shown + ')';
}

/** The host on its own: the full url is already in the omnibox. */
function hostLabel(url) {
  const parsed = parseUrlOrNull(url);
  if (parsed && parsed.host) return parsed.host;
  return shortLabelFor(url);
}

/** The chip trades its favicon for a warning glyph while the tab is broken. */
function setTabBroken(tab, on) {
  if (!tab) return;
  tab.broken = !!on;
  if (!tab.chipEl) return;
  tab.chipEl.classList.toggle('broken', !!on);
  if (!on || (tab.warnEl && tab.warnEl.isConnected)) return;

  const warn = document.createElement('span');
  // --fg-3, never amber: amber in this chrome means a live Claude session.
  warn.className = 'glyph tab-warn';
  warn.textContent = '\uE7BA';
  warn.setAttribute('aria-hidden', 'true');
  try {
    tab.chipEl.insertBefore(warn, tab.titleEl || tab.chipEl.firstChild);
    tab.warnEl = warn;
  } catch (err) { /* chip went away mid-failure */ }
}

function clearTabCard(tab) {
  if (!tab) return;
  if (tab.cardEl) {
    try { tab.cardEl.remove(); } catch (err) { /* already detached */ }
    tab.cardEl = null;
  }
  setTabBroken(tab, false);
}

/**
 * @param {Object} tab
 * @param {'crash'|'network'} kind
 * @param {string} detail one line under the heading
 */
function showTabCard(tab, kind, detail) {
  if (!tab || tab.kind !== 'page' || !viewsEl) return;
  clearTabCard(tab); // one card per tab, always the newest failure

  const card = document.createElement('div');
  card.className = 'tab-card';
  // Born hidden unless this tab is on screen — which includes the second half
  // of a split; activateTab() takes it from here.
  card.style.display = isTabOnScreen(tab) ? 'flex' : 'none';

  const glyph = document.createElement('span');
  glyph.className = 'glyph card-glyph';
  glyph.textContent = CARD_GLYPH[kind] || CARD_GLYPH.crash;
  glyph.setAttribute('aria-hidden', 'true');

  const head = document.createElement('div');
  head.className = 'card-head';
  head.textContent = CARD_HEAD[kind] || CARD_HEAD.crash;

  const line = document.createElement('div');
  line.className = 'card-line';
  line.textContent = detail || '';

  const again = document.createElement('button');
  again.className = 'glass card-btn';
  again.type = 'button';
  again.textContent = 'Try again';
  again.addEventListener('click', () => retryTab(tab));

  // Reaching for the other half of a split with the mouse is the same as asking
  // for that tab. A live guest reports its own focus through main, but a card
  // covers its guest, so a press on the card is the only signal there is.
  // Capture, so the Try again button inside it counts as a reach too.
  card.addEventListener('mousedown', () => {
    if (tab.id === activeTabId) return;
    const other = splitPartner(tab);
    if (other && other.id === activeTabId) activateTab(tab.id);
  }, true);

  card.appendChild(glyph);
  card.appendChild(head);
  card.appendChild(line);
  card.appendChild(again);
  // The card is absolutely positioned against #views, which is the whole well.
  // While this tab is half of a split, syncSplitOverlays() insets it to its own
  // half — the card never moves in the DOM either.
  viewsEl.appendChild(card);

  tab.cardEl = card;
  setTabBroken(tab, true);
  syncSplitOverlays();
}

/** Try again: back to the url the tab was on when it broke. */
function retryTab(tab) {
  if (!tab) return;
  const url = tab.url || HOME_URL;
  clearTabCard(tab); // did-fail-load puts it straight back if this fails too
  // A sleeping tab (a card can outlive one) has no guest: waking it IS the retry.
  if (tab.asleep) { wakeTab(tab); return; }
  if (!tab.viewEl || !tab.viewEl.isConnected) return;

  if (isViewUsable(tab)) {
    try {
      const pending = tab.viewEl.loadURL(url);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      return;
    } catch (err) { /* the guest is gone: the element-level paths below */ }
  }
  // A crashed guest has no working methods; reload() is what rebuilds it, and
  // setting src is the last resort for a view that never reached dom-ready.
  try {
    tab.viewEl.reload();
    return;
  } catch (err) { /* not ready */ }
  try { tab.viewEl.setAttribute('src', url); } catch (err) { /* tab closed */ }
}

/* ------------------------------------------------------------------ */
/* Navigation actions                                                  */
/* ------------------------------------------------------------------ */

function navigateActiveTab(input) {
  const tab = getActiveTab();
  if (!tab) return;

  const url = toNavigationUrl(input);
  if (!url) return;

  // A Claude tab has nowhere to navigate: typing a URL opens a page tab instead.
  if (isClaudeTab(tab)) {
    createTab(url);
    return;
  }

  tab.url = url;

  if (isViewUsable(tab)) {
    try {
      const pending = tab.viewEl.loadURL(url);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      return;
    } catch (err) {
      /* fall through to the attribute path below */
    }
  }

  // Not dom-ready yet: setting src is the only safe way to navigate.
  tab.viewEl.setAttribute('src', url);
}

function goBack() {
  const tab = getActiveTab();
  if (!isViewUsable(tab)) return;
  const history = historyTarget(tab.viewEl);
  try {
    if (history.canGoBack()) history.goBack();
  } catch (err) { /* view went away mid-call */ }
  updateNavState();
}

function goForward() {
  const tab = getActiveTab();
  if (!isViewUsable(tab)) return;
  const history = historyTarget(tab.viewEl);
  try {
    if (history.canGoForward()) history.goForward();
  } catch (err) { /* view went away mid-call */ }
  updateNavState();
}

function reloadActiveTab() {
  const tab = getActiveTab();
  if (isClaudeTab(tab)) return; // reloading a session would kill it
  if (!isViewUsable(tab)) return;
  try {
    // The button reads "Stop" mid-load, so honour that rather than restarting it.
    if (tab.loading) tab.viewEl.stop();
    else tab.viewEl.reload();
  } catch (err) { /* view went away mid-call */ }
}

function focusOmnibox() {
  if (!omniboxEl) return;
  omniboxEl.focus();
  omniboxEl.select();
}

/* ------------------------------------------------------------------ */
/* Tab cycling, selection and zoom                                     */
/* ------------------------------------------------------------------ */

/**
 * Step through the strip in order, wrapping at both ends. The strip is the
 * current workspace's chips, so cycling never lands on a hidden tab.
 */
function cycleTab(step) {
  const list = visibleTabs();
  if (list.length < 2) return;
  const index = list.findIndex((t) => t.id === activeTabId);
  const from = index === -1 ? 0 : index;
  const next = (from + step + list.length) % list.length;
  activateTab(list[next].id);
}

/** Ctrl+1..8 pick that position in the strip; Ctrl+9 is always the last tab. */
function selectTabByIndex(index) {
  const n = Number(index);
  if (!isFinite(n) || n < 1 || n > 9) return;
  const list = visibleTabs();
  const tab = n === 9 ? list[list.length - 1] : list[n - 1];
  if (tab) activateTab(tab.id);
}

const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 5;

function clampZoom(level) {
  const n = (typeof level === 'number' && isFinite(level)) ? level : 0;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, n));
}

// Zoom is remembered per hostname, the way every browser does it: { host: level }.
const ZOOM_STORAGE_KEY = 'zoom';

function readZoomMap() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(ZOOM_STORAGE_KEY);
  } catch (err) {
    return {}; // storage blocked: zoom is just not remembered this run
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (err) {
    return {}; // malformed
  }
}

function writeZoomMap(map) {
  try {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, JSON.stringify(map));
  } catch (err) { /* storage blocked or full */ }
}

/** The key one url is remembered under, or '' for anything not worth keeping. */
function zoomHostFor(url) {
  const parsed = parseUrlOrNull(url);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return '';
  return parsed.hostname || '';
}

/** 100% is the absence of a preference, so it deletes the entry, never stores 0. */
function rememberZoom(host, level) {
  if (!host) return;
  const map = readZoomMap();
  if (!level) {
    if (!Object.prototype.hasOwnProperty.call(map, host)) return;
    delete map[host];
  } else {
    if (map[host] === level) return;
    map[host] = level;
  }
  writeZoomMap(map);
}

/**
 * getZoomLevel() is synchronous on current Electron and a promise on older
 * builds, so every read goes through here and hands the level to a callback.
 */
function withZoomLevel(tab, fn) {
  if (!isViewUsable(tab)) return;
  // The fourth cached synchronous call (see navCache). We are the only writer
  // of a guest's zoom — setZoomLevel() below records what it set — so between
  // navigations the remembered level IS the level.
  const entry = navCacheFor(tab);
  if (entry && typeof entry.zoom === 'number') {
    fn(entry.zoom);
    return;
  }
  try {
    const current = tab.viewEl.getZoomLevel();
    if (current && typeof current.then === 'function') {
      current.then((level) => {
        const n = (typeof level === 'number') ? level : 0;
        if (entry) entry.zoom = n;
        fn(n);
      }).catch(() => {});
      return;
    }
    const n = (typeof current === 'number') ? current : 0;
    if (entry) entry.zoom = n;
    fn(n);
  } catch (err) { /* view went away mid-call */ }
}

/** The one place zoom is set: the view, the memory and the badge in step. */
function applyZoomLevel(tab, level) {
  if (!isViewUsable(tab)) return;
  const next = clampZoom(level);
  try {
    tab.viewEl.setZoomLevel(next);
  } catch (err) {
    return; // view went away mid-call: nothing to remember
  }
  const zoomEntry = navCacheFor(tab);
  if (zoomEntry) zoomEntry.zoom = next; // we just set it: no need to ask back
  rememberZoom(zoomHostFor(readCurrentUrl(tab)), next);
  if (tab.id === activeTabId) renderZoomBadge(next);
}

/**
 * Page tabs only — a Claude chamber scales with its own font size, not the
 * webview zoom.
 */
function zoomActiveTab(delta) {
  const tab = getActiveTab();
  if (!isViewUsable(tab)) return;
  withZoomLevel(tab, (level) => applyZoomLevel(tab, level + delta));
}

function resetZoom() {
  const tab = getActiveTab();
  if (!isViewUsable(tab)) return;
  applyZoomLevel(tab, 0); // 0 also drops this host from the zoom memory
}

/**
 * Re-apply this host's remembered zoom after a navigation. A host with nothing
 * stored is put back to 100%: the zoom belongs to the site, not to the tab.
 */
function applyStoredZoom(tab) {
  if (!isViewUsable(tab)) return;
  const host = zoomHostFor(readCurrentUrl(tab) || tab.url);
  const map = readZoomMap();
  const stored = host && Object.prototype.hasOwnProperty.call(map, host) ? Number(map[host]) : 0;
  const level = clampZoom(isFinite(stored) ? stored : 0);
  try { tab.viewEl.setZoomLevel(level); } catch (err) { /* view went away mid-call */ }
  const zoomEntry = navCacheFor(tab);
  if (zoomEntry) zoomEntry.zoom = level; // we just set it: no need to ask back
  if (tab.id === activeTabId) renderZoomBadge(level);
}

/**
 * The badge over the omnibox. Chromium's zoom factor is 1.2^level, and 100% is
 * no badge at all — the chrome only shows the setting while it is unusual.
 */
function renderZoomBadge(level) {
  if (!zoomBadgeEl) return;
  const n = (typeof level === 'number' && isFinite(level)) ? level : 0;
  if (!n) {
    zoomBadgeEl.hidden = true;
    return;
  }
  const percent = Math.round(100 * Math.pow(1.2, n));
  zoomBadgeEl.textContent = percent + '%';
  zoomBadgeEl.title = 'Zoom ' + percent + '% — click to reset';
  zoomBadgeEl.setAttribute('aria-label', 'Reset zoom, currently ' + percent + '%');
  zoomBadgeEl.hidden = false;
}

/** Read the active tab's zoom and paint the badge from it. */
function updateZoomBadge() {
  const tab = getActiveTab();
  if (!isViewUsable(tab)) {
    renderZoomBadge(0); // a Claude chamber or a tab with no guest yet
    return;
  }
  withZoomLevel(tab, (level) => {
    // The read can land a tab switch late; the badge belongs to the active tab.
    if (tab.id !== activeTabId) return;
    renderZoomBadge(level);
  });
}

/* ------------------------------------------------------------------ */
/* Claude toggle                                                       */
/* ------------------------------------------------------------------ */

/** The most recently raised tab of a kind IN THE WORKSPACE ON SCREEN. */
function mostRecentTabOfKind(kind) {
  let best = null;
  for (const tab of visibleTabs()) {
    if (tab.kind !== kind) continue;
    if (!best || (tab.lastActive || 0) > (best.lastActive || 0)) best = tab;
  }
  return best;
}

/**
 * Ctrl+` bounces between the last page you were on and the last Claude session,
 * spawning whichever side does not exist yet. It never closes anything.
 */
function toggleClaude() {
  const active = getActiveTab();

  if (isClaudeTab(active)) {
    const page = mostRecentTabOfKind('page');
    if (page) activateTab(page.id);
    else createTab(HOME_URL);
    return;
  }

  const claude = mostRecentTabOfKind('claude');
  if (claude) activateTab(claude.id);
  else createClaudeTab();
}

/* ------------------------------------------------------------------ */
/* Ask Claude                                                          */
/* ------------------------------------------------------------------ */

/*
 * The gesture the whole browser is built around: one move takes what is on
 * screen and puts it in front of a Claude Code session standing beside it.
 *
 * Three ways in -- the guest's context menu (main.js -> api.onAskClaude), the
 * page chip's menu, and Ctrl+Shift+K -- all land in askClaude().
 *
 * The prompt goes into the chamber's INPUT and stops there. No Enter is sent
 * from anywhere in this path: the text is an opening, and the user writes the
 * question and decides when it goes.
 */

/** A quote, not an attachment: a long selection is cut with a note saying so. */
const ASK_SELECTION_MAX = 4000;

function askSelectionText(selection) {
  const body = String(selection == null ? '' : selection).trim();
  if (body.length <= ASK_SELECTION_MAX) return body;
  return body.slice(0, ASK_SELECTION_MAX) + '\n… (selection truncated at ' + ASK_SELECTION_MAX + ' characters)';
}

/**
 * The text that gets pasted. Both shapes deliberately END where the user's own
 * typing starts -- with a selection the quote block is the whole message and
 * the cursor lands under it; without one the sentence is left mid-air after
 * "and ", so finishing it is the only thing left to do.
 */
function askPromptText(url, title, selection) {
  const quote = askSelectionText(selection);
  const page = String(url || '').trim();
  if (quote) return 'From ' + page + '\n\n"""\n' + quote + '\n"""\n\n';
  const name = String(title == null ? '' : title).trim();
  return name ? 'Look at ' + page + ' (' + name + ') and ' : 'Look at ' + page + ' and ';
}

/**
 * The page the request came from. The context menu fires on a guest that is on
 * screen but not necessarily the ACTIVE half of a split, so the url decides it
 * when there is one; the keyboard path passes none and the tab in front wins.
 */
function askSourceTab(url) {
  const want = String(url || '');
  if (want) {
    const pages = tabs.filter((t) => t.kind === 'page');
    const shown = pages.find((t) => isTabOnScreen(t) && readCurrentUrl(t) === want);
    if (shown) return shown;
    const anywhere = pages.find((t) => readCurrentUrl(t) === want);
    if (anywhere) return anywhere;
  }
  const active = getActiveTab();
  if (active && active.kind === 'page') return active;
  // Asked from inside a chamber: the page it is standing next to is the subject.
  const partner = splitPartner(active);
  if (partner && partner.kind === 'page') return partner;
  return mostRecentTabOfKind('page');
}

/**
 * The chamber this page should be talking to. In order: the one it is already
 * split with, a free chamber stood beside it, a new one beside it, and — if
 * the page cannot be split at all — whatever chamber exists, else a new one.
 */
function claudeChamberFor(page) {
  const partner = page ? splitPartner(page) : null;
  if (isClaudeTab(partner)) return partner;

  if (page && page.kind === 'page') {
    const recent = mostRecentTabOfKind('claude');
    if (recent && !splitPartner(recent) && splitTabs(page, recent)) return recent;
    if (openClaudeBesideTab(page)) {
      const made = splitPartner(page);
      if (isClaudeTab(made)) return made;
    }
  }
  return mostRecentTabOfKind('claude') || createClaudeTab({ background: true });
}

/** terminal.js queues this until the PTY is live, so a brand-new chamber works. */
function pasteIntoChamber(tab, text) {
  const term = tab && tab.term;
  if (!term || typeof term.paste !== 'function') return false;
  try {
    term.paste(text);
  } catch (err) {
    return false;
  }
  return true;
}

/**
 * @param {{url?:string, title?:string, selection?:string}} payload
 * @returns {boolean} true once the prompt is in (or queued for) a chamber.
 */
function askClaude(payload) {
  const info = payload || {};
  const url = String(info.url == null ? '' : info.url);
  const page = askSourceTab(url);
  const title = String(info.title == null ? '' : info.title) || (page ? page.title : '');
  const prompt = askPromptText(url || (page ? readCurrentUrl(page) : ''), title, info.selection);

  const claude = claudeChamberFor(page);
  if (!claude) return false;
  // The chamber takes the front so the keystrokes that follow land in the
  // terminal, not in the page; activateTab() focuses xterm on the next frame.
  activateTab(claude.id);
  return pasteIntoChamber(claude, prompt);
}

/** The guest's live selection, which — unlike the menu's — is never truncated. */
function readGuestSelection(tab) {
  if (!isViewUsable(tab)) return Promise.resolve('');
  let pending = null;
  try {
    pending = tab.viewEl.executeJavaScript('String(getSelection())');
  } catch (err) {
    return Promise.resolve('');
  }
  if (!pending || typeof pending.then !== 'function') return Promise.resolve('');
  return pending.then((text) => String(text == null ? '' : text), () => '');
}

/** Chip menu and Ctrl+Shift+K: ask about this page, quoting any selection. */
function askClaudeAboutTab(tab) {
  if (!tab || tab.kind !== 'page') return false;
  const url = readCurrentUrl(tab) || tab.url || '';
  const title = tab.title || '';
  readGuestSelection(tab).then((selection) => {
    askClaude({ url: url, title: title, selection: selection });
  });
  return true;
}

function askClaudeAboutActiveTab() {
  return askClaudeAboutTab(askSourceTab(''));
}

/* ------------------------------------------------------------------ */
/* Show Claude this page                                               */
/* ------------------------------------------------------------------ */

/*
 * The same gesture as Ask, one sense further along: Claude Code opens an image
 * file when it is handed the path, so a screenshot plus a line of text is a
 * real multimodal hand-off — the layout, the chart, the error dialog, the bit
 * that has no text to quote.
 *
 * Everything else is Ask's machinery unchanged: the same chamber beside the
 * same page, the same INPUT, the same sentence left mid-air after "and ". No
 * Enter is sent from here either.
 */

/** settings.js owns the toast and loads after this file, so this is checked. */
function claudeToast(message) {
  const t = window.Toast;
  if (!t || typeof t.show !== 'function') return;
  try { t.show(message); } catch (err) { /* a missing toast is not a failure */ }
}

const MSG_SHOW_FAILED = "Couldn't capture this page";

/**
 * Backslashes survive fine on the way in, but a forward-slash path meets no
 * escaping rule anywhere between the terminal and the tool that opens it —
 * and Claude Code on Windows takes either.
 */
function screenshotPathText(target) {
  return String(target == null ? '' : target).replace(/\\/g, '/');
}

/**
 * The image first, because the file is the point; then where it came from, so
 * the session can go and read the real page. Ends after "and " exactly like
 * askPromptText() does: the question is the only thing left to write.
 */
function showPromptText(target, url, title) {
  const page = String(url || '').trim();
  const name = String(title == null ? '' : title).trim();
  const subject = name ? page + ' (' + name + ')' : page;
  return 'Look at the screenshot ' + screenshotPathText(target) + ' of ' + subject + ' and ';
}

/**
 * Capture.captureActive() shoots the tab in FRONT, and a chip row or a guest's
 * context menu can fire on a tab that is merely on screen — or on none at all.
 * Activating is a no-op when it is already there; two frames is enough for the
 * swap to land before capturePage() reads the guest.
 */
function bringToFrontForCapture(tab) {
  if (!tab || tab.kind !== 'page' || getActiveTab() === tab) return Promise.resolve();
  activateTab(tab.id);
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
  });
}

/** capture.js is a sibling instrument, not a dependency: feature-detected. */
function captureForClaude() {
  const cap = window.Capture;
  if (!cap || typeof cap.captureActive !== 'function') return Promise.resolve(null);
  let pending = null;
  try { pending = cap.captureActive(); } catch (err) { return Promise.resolve(null); }
  return Promise.resolve(pending).then((shot) => shot || null, () => null);
}

/**
 * @param {{url?:string, title?:string}} [payload] the page the request names;
 *   omitted (a shortcut, the palette) means whichever page is in front.
 * @returns {Promise<boolean>} true once the prompt is in (or queued for) a
 *   chamber. A capture that refuses or fails says so in a toast and stops —
 *   pasting a path to a PNG that is not there would be worse than nothing.
 */
function showClaudeThisPage(payload) {
  const info = payload || {};
  const want = String(info.url == null ? '' : info.url);
  const page = askSourceTab(want);

  return bringToFrontForCapture(page).then(captureForClaude).then((shot) => {
    if (!shot || !shot.path) {
      claudeToast(MSG_SHOW_FAILED);
      return false;
    }
    const url = want || (page ? readCurrentUrl(page) : '');
    const title = String(info.title == null ? '' : info.title) || (page ? page.title : '');

    const claude = claudeChamberFor(page);
    if (!claude) return false;
    // Same as askClaude(): the chamber takes the front so what is typed next
    // lands in the terminal rather than in the page.
    activateTab(claude.id);
    return pasteIntoChamber(claude, showPromptText(shot.path, url, title));
  });
}

/* ------------------------------------------------------------------ */
/* Ask Claude about this article                                       */
/* ------------------------------------------------------------------ */

/*
 * Ask hands over a link, Show hands over a picture; this hands over the WORDS.
 * reader.js already knows how to lift an article out of a page, so the text it
 * would have laid out in the reading page is quoted straight into the chamber
 * instead — a session that cannot browse can still summarise or answer from it.
 *
 * Everything else is Ask's machinery unchanged: the same chamber beside the
 * same page, the same INPUT, and no Enter sent from here either.
 */

/** Long enough for a feature-length piece, short enough not to fill a context. */
const ASK_ARTICLE_MAX = 12000;

const MSG_NO_ARTICLE = 'No article here, sending the link';

/**
 * Readability's textContent, made safe to read in a terminal: every run of
 * spaces, tabs and non-breaking spaces becomes one space, and a run of line
 * breaks becomes one blank line — so the paragraphs the article had survive
 * and the ragged indentation of the source HTML does not.
 */
function articleBodyText(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')   // inline whitespace, however much of it
    .replace(/ ?\n ?/g, '\n')    // nothing hugging a break
    .replace(/\n{2,}/g, '\n\n')  // a gap of any height is one paragraph break
    .trim();
}

/** A quote, not an attachment: a long article is cut with a note saying so. */
function askArticleBody(text) {
  const body = articleBodyText(text);
  if (body.length <= ASK_ARTICLE_MAX) return body;
  return body.slice(0, ASK_ARTICLE_MAX) +
    '\n… (article truncated at ' + ASK_ARTICLE_MAX.toLocaleString('en-US') + ' characters)';
}

/**
 * Where it came from, what it is called, who wrote it, then the article
 * between triple quotes. Ends on a blank line like askPromptText() does: the
 * question is the only thing left to write.
 */
function askArticlePromptText(article) {
  const info = article || {};
  const url = String(info.url == null ? '' : info.url).trim();
  const title = String(info.title == null ? '' : info.title).trim();
  const byline = String(info.byline == null ? '' : info.byline).trim();
  return 'From ' + url + ' — "' + title + '"' + (byline ? ' by ' + byline : '') +
    '\n\n"""\n' + askArticleBody(info.textContent) + '\n"""\n\n';
}

/** reader.js is a sibling instrument, not a dependency: feature-detected. */
function readArticleOf(tab) {
  const reader = window.Reader;
  if (!reader || typeof reader.extract !== 'function') return Promise.resolve(null);
  let pending = null;
  try { pending = reader.extract(tab); } catch (err) { return Promise.resolve(null); }
  return Promise.resolve(pending).then((article) => article || null, () => null);
}

/**
 * The reader probe's cached verdict for a tab: true, false, or null when it
 * has not been asked. Only a hard false hides the menu row — an unprobed tab
 * still offers it, because the fallback below is a perfectly good outcome.
 */
function readerSaysArticle(tab) {
  const reader = window.Reader;
  if (!reader || typeof reader.readableNow !== 'function') return null;
  try { return reader.readableNow(tab); } catch (err) { return null; }
}

/**
 * @param {{url?:string, title?:string}} [payload] the page the request names;
 *   omitted (a shortcut, the palette) means whichever page is in front.
 * @returns {Promise<string>} the text pasted, '' when nothing was — a page
 *   with no article in it says so in a toast and falls back to Ask, which
 *   sends the link instead.
 */
function askClaudeAboutArticle(payload) {
  const info = payload || {};
  const want = String(info.url == null ? '' : info.url);
  const page = askSourceTab(want);

  return readArticleOf(page).then((article) => {
    if (!article) {
      claudeToast(MSG_NO_ARTICLE);
      // askClaudeAboutActiveTab()'s own path, with the page already resolved.
      if (page) askClaudeAboutTab(page);
      else askClaudeAboutActiveTab();
      return '';
    }

    const prompt = askArticlePromptText({
      url: article.url || want || (page ? readCurrentUrl(page) : ''),
      title: article.title || String(info.title == null ? '' : info.title) ||
        (page ? page.title : ''),
      byline: article.byline,
      textContent: article.textContent
    });

    const claude = claudeChamberFor(page);
    if (!claude) return '';
    // Same as askClaude(): the chamber takes the front so what is typed next
    // lands in the terminal rather than in the page.
    activateTab(claude.id);
    return pasteIntoChamber(claude, prompt) ? prompt : '';
  });
}

/* ------------------------------------------------------------------ */
/* Ask Claude about a file on disk                                     */
/* ------------------------------------------------------------------ */

/*
 * Ask hands over a link, Show a picture, Article the words — this hands over a
 * FILE. Claude Code opens files and images by path, so the path is the whole
 * attachment: a finished download can be read, summarised or described without
 * anything being uploaded anywhere.
 */

const MSG_FILE_MISSING = "That file has no path yet";

/** Same forward-slash rule as screenshotPathText(); Claude Code takes either. */
function filePromptText(target) {
  return 'Look at the file ' + screenshotPathText(target) + ' and ';
}

/**
 * @param {string} path the file on disk, in either slash.
 * @param {{name?:string}} [options] display name, used only to name the file
 *   in the toast when there is no path to hand over.
 * @returns {boolean} true once the prompt is in (or queued for) a chamber.
 */
function askClaudeAboutFile(path, options) {
  const target = String(path == null ? '' : path).trim();
  const opts = options || {};
  const name = String(opts.name == null ? '' : opts.name).trim();
  if (!target) {
    claudeToast(name ? "No path for " + name : MSG_FILE_MISSING);
    return false;
  }

  // The request comes from a popover over the chrome, so there is no subject
  // page to infer: the tab in front is the one to stand the chamber beside,
  // and anything else (a chamber, the new tab) falls through to claudeChamberFor.
  const active = getActiveTab();
  const page = active && active.kind === 'page' ? active : null;

  const claude = claudeChamberFor(page);
  if (!claude) return false;
  // Same as askClaude(): the chamber takes the front so what is typed next
  // lands in the terminal rather than in the page.
  activateTab(claude.id);
  return pasteIntoChamber(claude, filePromptText(target));
}

/* ------------------------------------------------------------------ */
/* Window controls (frameless titlebar)                                */
/* ------------------------------------------------------------------ */

// preload.js may predate api.win; every consumer feature-detects.
function winApi() {
  return (window.api && window.api.win) ? window.api.win : null;
}

// Segoe Fluent Icons: E922 = maximize, E923 = restore. Only swapped when the
// button actually carries a <span class="glyph">.
function setMaximizedGlyph(isMax) {
  if (!winMaxBtn) return;
  const glyph = winMaxBtn.querySelector('span.glyph');
  if (!glyph) return;
  glyph.textContent = isMax ? '\uE923' : '\uE922';
  winMaxBtn.setAttribute('aria-label', isMax ? 'Restore' : 'Maximize');
}

function applyMaximized(isMax) {
  const on = !!isMax;
  document.body.classList.toggle('maximized', on);
  setMaximizedGlyph(on);
}

/**
 * "Restart browser": close and reopen with the tabs restored. Every update to
 * this app needs a close-and-reopen, so this is the one click that does it.
 *
 * The session snapshot is flushed SYNCHRONOUSLY first — the debounced save can
 * still be pending, and a restart that dropped the last tab you opened would
 * be worse than no button at all. writeSession() hands it to main over the
 * same ordered channel the restart message uses, so session.json is on disk
 * before main reads 'app:restart'.
 *
 * @returns {boolean} false when preload predates api.app.restart (nothing
 *          happened, and the caller can say so).
 */
function restartBrowser() {
  try { writeSession(); } catch (err) { /* a lost snapshot must not block the restart */ }
  const appApi = (window.api && window.api.app) ? window.api.app : null;
  if (!appApi || typeof appApi.restart !== 'function') return false;
  try { appApi.restart(); } catch (err) { return false; }
  return true;
}

function wireWindowControls() {
  if (winMinBtn) {
    winMinBtn.addEventListener('click', () => {
      const w = winApi();
      if (w && typeof w.minimize === 'function') w.minimize();
    });
  }
  if (winMaxBtn) {
    winMaxBtn.addEventListener('click', () => {
      const w = winApi();
      if (w && typeof w.maximize === 'function') w.maximize();
    });
  }
  if (winCloseBtn) {
    winCloseBtn.addEventListener('click', () => {
      const w = winApi();
      if (w && typeof w.close === 'function') w.close();
    });
  }

  const win = winApi();

  if (win && typeof win.onMaximized === 'function') {
    win.onMaximized((payload) => {
      applyMaximized(payload && payload.maximized);
    });
  }

  if (win && typeof win.onFullscreen === 'function') {
    win.onFullscreen((payload) => {
      windowFullscreen = !!(payload && payload.fullscreen);
      document.body.classList.toggle('fullscreen', windowFullscreen);
      // Leaving via the OS (Esc, F11) ends a page's fullscreen too.
      if (!windowFullscreen) document.body.classList.remove('page-fullscreen');
    });
  }

  // The context menu's "Open link in new tab" and "Search Google for" land here.
  if (window.api && typeof window.api.onOpenUrl === 'function') {
    window.api.onOpenUrl((payload) => {
      const url = payload && payload.url;
      if (!url) return;
      createTab(url, { background: !!(payload && payload.background) });
    });
  }

  // "Ask Claude about …" in a page's context menu: main hands over the url,
  // the title and the selection, and askClaude() does the rest.
  if (window.api && typeof window.api.onAskClaude === 'function') {
    window.api.onAskClaude((payload) => {
      // "Show Claude this page" comes down the same channel, marked.
      if (payload && payload.mode === 'screenshot') showClaudeThisPage(payload);
      // "Ask Claude about this article" comes down it marked too.
      else if (payload && payload.mode === 'article') askClaudeAboutArticle(payload);
      else askClaude(payload);
    });
  }

  // A click inside the other half of a split lands in the guest and never
  // reaches this document, so main forwards which webContents took focus and
  // the chrome follows it onto that tab.
  if (window.api && typeof window.api.onGuestFocus === 'function') {
    window.api.onGuestFocus(onGuestFocused);
  }

  if (win && typeof win.info === 'function') {
    // Wrapped in Promise.resolve so a synchronous throw is caught too.
    Promise.resolve()
      .then(() => win.info())
      .then((info) => {
        if (!info) return;
        document.body.classList.toggle('acrylic', !!info.acrylic);
        applyMaximized(!!info.maximized);
      })
      .catch(() => { /* no window backing this renderer yet */ });
  }
}

/* ------------------------------------------------------------------ */
/* Chrome wiring                                                       */
/* ------------------------------------------------------------------ */

function wireChrome() {
  if (newTabBtn) {
    newTabBtn.addEventListener('click', () => createTab(HOME_URL));
  }
  if (newClaudeBtn) {
    // Plain click opens the default folder; Shift+click asks which one;
    // Ctrl+click opens the default folder on its past conversations;
    // Alt+click is the button's spelling of Ctrl+Shift+\ — Claude beside
    // whatever is in front (and a second Alt+click puts it away again).
    // The tooltip is set here rather than left to index.html so the three
    // modifiers are documented wherever this handler goes.
    newClaudeBtn.title =
      'New Claude tab (Shift+click to pick a folder, '
      + 'Ctrl+click to resume a conversation, Alt+click to open it beside this page)';
    newClaudeBtn.addEventListener('click', (event) => {
      if (event && event.altKey) toggleClaudeSplit();
      else if (event && event.shiftKey) newClaudeTabInFolder();
      else if (event && (event.ctrlKey || event.metaKey)) resumeClaudeConversation();
      else createClaudeTab();
    });
  }

  // Coming back to the window answers whatever chamber is already in front of
  // him. Anything still in the background keeps its mark until he switches to
  // it — that is the whole point of the mark.
  window.addEventListener('focus', clearClaudeNeedsYouOnScreen);
  // Right-click in the tab row. Delegated from the titlebar so bare strip space
  // is covered too; main.js only pops a native menu over editable fields, so
  // nothing competes with this one.
  //
  // Windows caveat: the empty titlebar is `-webkit-app-region: drag`, which the
  // OS hit-tests as HTCAPTION, so a real right-click there is answered by the
  // window system menu and never reaches the DOM. Chips and the other no-drag
  // areas do get this menu; bare caption space does not. Fixing it means
  // hooking WM_NCRBUTTONUP in main.js and cancelling the system menu
  // (WM_INITMENU + a setEnabled toggle) -- a window-message hack for a rare
  // gesture, so it is left alone deliberately.
  const onStripMenu = (event) => {
    if (!event || !event.target || !event.target.closest) return;
    if (event.target.closest('button')) return; // +, window controls: not ours
    event.preventDefault();
    const chip = event.target.closest('.tab');
    const tab = chip ? tabs.find((t) => String(t.id) === chip.dataset.tabId) : null;
    openTabMenu(event.clientX, event.clientY,
      tab ? tabMenuItemsForTab(tab) : tabMenuItemsForStrip());
  };
  if (titlebarEl) titlebarEl.addEventListener('contextmenu', onStripMenu);
  else if (tabstripEl) tabstripEl.addEventListener('contextmenu', onStripMenu);

  if (backBtn) backBtn.addEventListener('click', goBack);
  if (forwardBtn) forwardBtn.addEventListener('click', goForward);
  // The zoom badge is a button that only ever does one thing.
  if (zoomBadgeEl) zoomBadgeEl.addEventListener('click', resetZoom);
  // Same handler for both modes: reloadActiveTab() stops a load in progress.
  if (reloadBtn) reloadBtn.addEventListener('click', reloadActiveTab);
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  if (omniboxEl) {
    omniboxEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const wasClaude = isClaudeTab(getActiveTab());
      navigateActiveTab(omniboxEl.value); // opens a new page tab when on Claude
      // Hand focus back to the page so later did-navigate events can refresh the bar.
      omniboxEl.blur();
      const tab = getActiveTab();
      if (!tab) return;
      if (isClaudeTab(tab)) {
        // Only reachable when the input was empty, so the session keeps focus.
        if (tab.term && typeof tab.term.focus === 'function') {
          try { tab.term.focus(); } catch (err) { /* not open yet */ }
        }
        return;
      }
      if (wasClaude) syncOmniboxFromActive(true);
      try { tab.viewEl.focus(); } catch (err) { /* not ready yet */ }
    });

    // Select-all on focus, including click-focus (mouseup would otherwise
    // collapse the selection to a caret).
    let selectOnMouseUp = false;
    omniboxEl.addEventListener('focus', () => {
      selectOnMouseUp = true;
      omniboxEl.select();
    });
    omniboxEl.addEventListener('mouseup', (event) => {
      if (!selectOnMouseUp) return;
      selectOnMouseUp = false;
      event.preventDefault();
    });
    omniboxEl.addEventListener('blur', () => {
      selectOnMouseUp = false;
    });
  }
}

/* ------------------------------------------------------------------ */
/* Chrome modules: find bar, downloads, history                        */
/* ------------------------------------------------------------------ */

// history.js, find.js and downloads.js are optional: the chrome must boot and
// behave the same with any of them missing, so every call goes through here.
function historyCall(method, url, title) {
  const store = window.History;
  if (!store || typeof store[method] !== 'function') return;
  try { store[method](url, title); } catch (err) { /* storage is best-effort */ }
  // Every visit shows up on an open history page without a reload.
  if (method === 'record') scheduleHistoryPush();
}

let historyPushTimer = null;
function scheduleHistoryPush() {
  if (historyPushTimer) return;
  historyPushTimer = setTimeout(() => {
    historyPushTimer = null;
    pushHistoryToAll();
  }, 800);
}

// Actions the modules own. Each exposes handleShortcut(action) -> true when it
// consumed the action; 'escape' is offered to all of them until one takes it.
function moduleShortcut(action) {
  const modules = [
    window.FindBar, window.Downloads, window.History,
    window.Settings, window.Shield, window.Reader, window.TabSearch, window.SiteInfo,
    window.Capture, window.Bookmarks, window.Pip, window.Workspaces, window.UserStyle
  ];
  for (const mod of modules) {
    if (!mod || typeof mod.handleShortcut !== 'function') continue;
    let took = false;
    try { took = !!mod.handleShortcut(action); } catch (err) { took = false; }
    if (took) return true;
  }
  return false;
}

let windowFullscreen = false;

function toggleFullscreen() {
  const w = winApi();
  if (w && typeof w.toggleFullscreen === 'function') w.toggleFullscreen();
}

// A page's own fullscreen (a video) should fill the window like it does in
// any browser: the chrome hides and the OS window follows the page's state.
function setPageFullscreen(on) {
  document.body.classList.toggle('page-fullscreen', !!on);
  if (!!on !== windowFullscreen) toggleFullscreen();
}

/**
 * Every action a key can be bound to, by id.
 *
 * Two callers share it. main.js replays a key pressed inside a guest page over
 * 'shortcut' (payload.action), and the chrome's own keydown resolves an event
 * to an id through window.Shortcuts. A binding naming an id that is missing
 * here simply does nothing, so this map is the single list of what exists.
 *
 * 'select-tab', 'next-tab', 'prev-tab' and 'escape' are NOT rebindable -- the
 * digits, Tab and Escape stay hardcoded below -- but main.js still replays them
 * from inside a page, so they are listed for that path.
 */
const ACTIONS = {
  'toggle-terminal': toggleClaude,
  'claude-folder': newClaudeTabInFolder,
  'new-tab': () => createTab(HOME_URL),
  'close-tab': closeActiveTab,
  'reopen-tab': reopenClosedTab,
  'focus-omnibox': focusOmnibox,
  'next-tab': () => cycleTab(1),
  'prev-tab': () => cycleTab(-1),
  // The only action carrying data: payload.index is 1-9.
  'select-tab': (payload) => selectTabByIndex(payload && payload.index),
  'move-tab-left': () => moveActiveTab(-1),
  'move-tab-right': () => moveActiveTab(1),
  // Workspaces. Ctrl+Alt+Right / Left by default; shortcuts.js owns the binding
  // binding table, so these two ids are what it has to name to rebind them.
  'workspace-next': () => cycleWorkspace(1),
  'workspace-prev': () => cycleWorkspace(-1),
  // The switcher panel itself belongs to workspaces.js, which answers through
  // moduleShortcut() exactly as find / downloads / tabsearch do.
  'workspaces': () => moduleShortcut('workspaces'),
  'userstyle-reset': () => moduleShortcut('userstyle-reset'),
  'zoom-in': () => zoomActiveTab(ZOOM_STEP),
  'zoom-out': () => zoomActiveTab(-ZOOM_STEP),
  'zoom-reset': resetZoom,
  'toggle-theme': toggleTheme,
  'reload': reloadActiveTab,
  'print': printActiveTab,
  'back': goBack,
  'forward': goForward,
  'fullscreen': toggleFullscreen,
  // No default binding: it is reached from Settings > About and from the
  // command palette, never from a key nobody meant to press.
  'restart-browser': restartBrowser,
  'split': toggleSplit,
  'claude-split': toggleClaudeSplit,
  // Carries no payload: the selection is read back off the guest here.
  'ask-claude': askClaudeAboutActiveTab,
  // The same hand-off with a screenshot attached. shortcuts.js does not name
  // this id yet; the moment it does, every chrome-side path is already wired.
  'show-claude': () => showClaudeThisPage(),
  // ...and the same hand-off with the article's TEXT, read by reader.js.
  'ask-article': () => askClaudeAboutArticle(),
  // Module actions. Each module decides for itself whether the action is its
  // own; moduleShortcut() returns false when none of them took it.
  'find': () => moduleShortcut('find'),
  'downloads': () => moduleShortcut('downloads'),
  'history': () => moduleShortcut('history'),
  'settings': () => moduleShortcut('settings'),
  'bookmark': () => moduleShortcut('bookmark'),
  'bookmarks-bar': () => moduleShortcut('bookmarks-bar'),
  'reader': () => moduleShortcut('reader'),
  'tabsearch': () => moduleShortcut('tabsearch'),
  'command-palette': () => moduleShortcut('command-palette'),
  'capture': () => moduleShortcut('capture'),
  'pip': () => moduleShortcut('pip'),
  'shield': () => moduleShortcut('shield'),
  'siteinfo': () => moduleShortcut('siteinfo'),
  'escape': () => moduleShortcut('escape'),
};

/**
 * main.js matches keys pressed inside a guest page itself, so it needs the same
 * binding map the chrome uses. Sent once at boot and again after every change.
 * main keeps its own built-in defaults if this never arrives.
 */
function pushShortcutBindings() {
  const bridge = (window.api && window.api.shortcuts) ? window.api.shortcuts : null;
  if (!bridge || typeof bridge.set !== 'function') return;
  if (!window.Shortcuts || typeof window.Shortcuts.bindings !== 'function') return;
  let bindings = null;
  try { bindings = window.Shortcuts.bindings(); } catch (err) { return; }
  if (!bindings || typeof bindings !== 'object') return;
  try { bridge.set(bindings); } catch (err) { /* main keeps its defaults */ }
}

/**
 * Whether a key landed in something the user is typing into — the omnibox, a
 * module's input, a contenteditable pane. Chords that mean something inside
 * text (Ctrl+Shift+Arrow) are left alone there.
 */
function isEditableTarget(node) {
  const el = (node && node.nodeType === 1) ? node : null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function wireKeyboard() {
  // Keys pressed while focus is inside a <webview> go to the guest page, not
  // here. main.js intercepts those and replays them over 'shortcut', so the
  // same actions work whether the chrome or a page currently has focus.
  if (window.api && typeof window.api.onShortcut === 'function') {
    window.api.onShortcut((payload) => {
      const run = payload && ACTIONS[payload.action];
      if (run) run(payload);
    });
  }

  // Hand main the binding map, and hand it over again after every change.
  pushShortcutBindings();
  if (window.Shortcuts && typeof window.Shortcuts.on === 'function') {
    try { window.Shortcuts.on(pushShortcutBindings); } catch (err) { /* no watcher */ }
  }

  window.addEventListener('keydown', (event) => {
    if (event.metaKey) return;
    const key = typeof event.key === 'string' ? event.key : '';

    /* Fixed keys first. These are not rebindable, so they are settled before
       the resolver ever sees the event. */

    // F12 is the GUEST's devtools and main.js owns it: the chrome must neither
    // act on it nor swallow it.
    if (key === 'F12') return;

    // Escape: the tab menu first, then whichever module wants it. The menu
    // handles its own keys while it holds focus; this is the fallback for an
    // Escape that arrives once focus has moved on.
    if (key === 'Escape' && !event.ctrlKey && !event.altKey) {
      if (tabMenuIsOpen()) { event.preventDefault(); closeTabMenu(); return; }
      if (moduleShortcut('escape')) event.preventDefault();
      return;
    }

    if (event.ctrlKey && !event.altKey) {
      // Ctrl+Tab / Ctrl+Shift+Tab cycle the strip.
      if (key === 'Tab') {
        event.preventDefault();
        cycleTab(event.shiftKey ? -1 : 1);
        return;
      }
      // Ctrl+1..8 jump to that position, Ctrl+9 to the last tab.
      if (key.length === 1 && key >= '1' && key <= '9') {
        event.preventDefault();
        selectTabByIndex(Number(key));
        return;
      }
      // Ctrl+Shift+Arrow stays the text field's select-by-word chord: it never
      // reaches the rebindable resolver from an editable target. Workspace
      // cycling is bound through shortcuts.js (Ctrl+Alt+Arrow by default).
      if (event.shiftKey && (key === 'ArrowRight' || key === 'ArrowLeft')
          && isEditableTarget(event.target)) return;
    }

    /* Everything else is rebindable. Only Ctrl, Alt and function keys reach the
       resolver, so a plain letter typed into the omnibox or the find box is
       never swallowed. */
    if (!event.ctrlKey && !event.altKey && !/^F\d+$/.test(key)) return;

    if (window.Shortcuts && typeof window.Shortcuts.actionFor === 'function') {
      let action = null;
      try { action = window.Shortcuts.actionFor(event); } catch (err) { action = null; }
      const run = action ? ACTIONS[action] : null;
      if (run) {
        event.preventDefault();
        run();
      }
      return;
    }

    // shortcuts.js did not load: the original hardcoded chain still works.
    legacyKeydown(event);
  });
}

/**
 * The pre-rebinding key chain, kept whole as the fallback for a boot where
 * shortcuts.js is missing. Nothing else calls it, and nothing new goes in here
 * -- new bindings belong in shortcuts.js and ACTIONS above.
 */
function legacyKeydown(event) {
  if (event.metaKey) return;

  // Keys that mean the same thing without Ctrl.
  if (!event.ctrlKey && !event.altKey) {
    // The menu handles its own keys while it holds focus; this is the fallback
    // for an Escape that arrives once focus has moved on.
    if (event.key === 'Escape' && tabMenuIsOpen()) {
      event.preventDefault();
      closeTabMenu();
      return;
    }
    if (event.key === 'F5') { event.preventDefault(); reloadActiveTab(); return; }
    if (event.key === 'F11') { event.preventDefault(); toggleFullscreen(); return; }
    if (event.key === 'Escape' && moduleShortcut('escape')) { event.preventDefault(); }
    return;
  }
  if (event.altKey && !event.ctrlKey) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); goBack(); }
    if (event.key === 'ArrowRight') { event.preventDefault(); goForward(); }
    // Alt+P: picture in picture for the page's video.
    if (typeof event.key === 'string' && event.key.toLowerCase() === 'p') { event.preventDefault(); moduleShortcut('pip'); }
    return;
  }
  if (!event.ctrlKey || event.altKey) return;

  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';

  // Ctrl+\ pairs the tab in front with the next one, or breaks the pair it is
  // already in. The backslash has no case, so it is read off event.key raw.
  // Ctrl+Shift+\ is "Claude beside" instead. Shift over a US layout turns the
  // key into '|', but not every layout does, so both characters are read.
  if (event.key === '\\' || event.key === '|') {
    event.preventDefault();
    if (event.shiftKey) toggleClaudeSplit();
    else toggleSplit();
    return;
  }

  // Module bars: find, downloads, history. Each decides whether it applies.
  if (key === 'f' || key === 'j' || key === 'h' || key === ',' || key === 'd') {
    const action = { f: 'find', j: 'downloads', h: 'history', ',': 'settings', d: 'bookmark' }[key];
    if (moduleShortcut(action)) event.preventDefault();
    return;
  }

  // Ctrl+Shift+PageUp / PageDown move the ACTIVE tab along the strip. main.js
  // does not replay these, so they only fire while the chrome has focus — a
  // page with focus swallows them.
  if (event.shiftKey && (key === 'pageup' || key === 'pagedown')) {
    event.preventDefault();
    moveActiveTab(key === 'pageup' ? -1 : 1);
    return;
  }

  // Ctrl+Tab / Ctrl+Shift+Tab cycle the strip. Handled first because it is the
  // one binding here that wants Shift.
  if (key === 'tab') {
    event.preventDefault();
    cycleTab(event.shiftKey ? -1 : 1);
    return;
  }

  // Zoom. Ctrl+0 resets, so it is checked before the 1-9 tab selectors.
  if (key === '0') {
    event.preventDefault();
    resetZoom();
    return;
  }
  if (key === '=' || key === '+' || key === 'add') {
    event.preventDefault();
    zoomActiveTab(ZOOM_STEP);
    return;
  }
  if (key === '-' || key === 'subtract') {
    event.preventDefault();
    zoomActiveTab(-ZOOM_STEP);
    return;
  }

  // Ctrl+1..8 jump to that position, Ctrl+9 to the last tab.
  if (key.length === 1 && key >= '1' && key <= '9') {
    event.preventDefault();
    selectTabByIndex(Number(key));
    return;
  }

  // Ctrl+Shift+T reopens the last closed tab. It has to be tested BEFORE the
  // plain Ctrl+T branch below, which would otherwise swallow it.
  if (key === 't' && event.shiftKey) {
    event.preventDefault();
    reopenClosedTab();
    return;
  }
  if (key === 't') {
    event.preventDefault();
    createTab(HOME_URL);
    return;
  }
  if (key === 'w') {
    event.preventDefault();
    closeActiveTab(); // either kind
    return;
  }
  if (key === 'l') {
    event.preventDefault();
    focusOmnibox();
    return;
  }
  // Ctrl+Shift+R hands the page to the reader. Tested BEFORE plain Ctrl+R,
  // which does not look at Shift and would otherwise swallow it. main.js does
  // not replay this one yet, so it only fires while the chrome has focus.
  if (key === 'r' && event.shiftKey) {
    event.preventDefault();
    moduleShortcut('reader');
    return;
  }
  // Ctrl+Shift+A: tab search. Plain Ctrl+A is select-all wherever focus is.
  if (key === 'a' && event.shiftKey) {
    event.preventDefault();
    moduleShortcut('tabsearch');
    return;
  }
  // Ctrl+Shift+S saves a screenshot of the page; Ctrl+Shift+B shows the bookmarks bar.
  if (key === 's' && event.shiftKey) { event.preventDefault(); moduleShortcut('capture'); return; }
  // Ctrl+Shift+K hands the page — and anything selected on it — to a Claude
  // chamber. Tested BEFORE plain Ctrl+K, which would otherwise swallow it.
  if (key === 'k' && event.shiftKey) { event.preventDefault(); askClaudeAboutActiveTab(); return; }
  // Ctrl+K: the command palette (tab search in command mode).
  if (key === 'k') { event.preventDefault(); moduleShortcut('command-palette'); return; }
  if (key === 'b' && event.shiftKey) { event.preventDefault(); moduleShortcut('bookmarks-bar'); return; }
  if (key === 'r') {
    event.preventDefault(); // never let Ctrl+R reload the shell window
    reloadActiveTab(); // no-op on a Claude tab
    return;
  }
  // Plain Ctrl+P only: Ctrl+Shift+P is left free, as it is in every browser.
  if (key === 'p' && !event.shiftKey) {
    event.preventDefault(); // never let Ctrl+P print the chrome window itself
    printActiveTab(); // no-op on a Claude tab
    return;
  }
  // Shift turns event.key into '~', so the physical key is what is tested.
  // Ctrl+Shift+` opens a chamber in a folder you pick; main.js does not
  // replay it, so it only fires while the chrome has focus.
  if (key === '`' || event.code === 'Backquote') {
    event.preventDefault();
    if (event.shiftKey) newClaudeTabInFolder();
    else toggleClaude(); // same path as the shortcut action and the Claude button
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function init() {
  titlebarEl = document.getElementById('titlebar');
  tabstripEl = document.getElementById('tabstrip');
  newTabBtn = document.getElementById('newtab');
  newClaudeBtn = document.getElementById('newclaude');
  backBtn = document.getElementById('back');
  forwardBtn = document.getElementById('forward');
  reloadBtn = document.getElementById('reload');
  omniboxEl = document.getElementById('omnibox');
  zoomBadgeEl = document.getElementById('zoom-badge');
  viewsEl = document.getElementById('views');
  winMinBtn = document.getElementById('win-min');
  winMaxBtn = document.getElementById('win-max');
  winCloseBtn = document.getElementById('win-close');
  themeBtn = document.getElementById('theme');
  resolveTabMenu();
  // The switcher UI's slot in the titlebar, left of the strip. Empty until
  // workspaces.js fills it; the browser boots fine when it never does.
  ensureWorkspaceSlot();

  wireChrome();
  wireTabMenu();
  wireWindowControls();
  wireKeyboard();
  wireSettings();
  wireOverlayWatch();
  wireAutopauseReadout();
  wireStats();

  // The chrome follows its own tabchange event, exactly like find.js and the
  // other modules do: the badge belongs to the tab you are looking at, and a
  // new-tab page gets a fresh recent list every time you come back to it.
  document.addEventListener('tabchange', () => {
    updateZoomBadge();
    pushRecentToTab(getActiveTab());
    // Cheap: the counts are already in hand and the autopause word is cached,
    // so coming back to a new tab never costs a round trip to main.
    pushReadoutToAll();
    // activateTab() already did this for its own dispatch; the call is
    // idempotent, and this is what covers a module dispatching 'tabchange'.
    syncStatsSubscription();
  });

  // The split focus mark and a split crash card are parked over measured rects,
  // so they are re-measured whenever the well changes size.
  window.addEventListener('resize', refreshSplit);

  // A pending debounced session write must not be lost to the window closing.
  window.addEventListener('beforeunload', flushSession);

  // Tab sleeping: one sweep a minute for the life of the window. Deliberately
  // never cleared — the chrome outlives every tab in it, and the setting is
  // re-read on each sweep, so a change takes effect without a restart.
  window.setInterval(sleepIdleTabs, TAB_SLEEP_SWEEP_MS);

  // Re-apply the theme theme-boot.js already stamped on <html>: this is what
  // paints the toggle glyph and hands the theme to terminal.js. Runs before the
  // first tab so that tab is born with the right ?theme= on its URL.
  setTheme(getTheme());

  updateNavState();
  syncReloadButton();

  // Last run's strip wins the boot; a missing, malformed or empty session falls
  // through to the single home tab this has always opened. The file copy of the
  // session arrives over IPC, so the strip is built a turn (at most
  // SESSION_READ_TIMEOUT) later — everything above is wired by then, and the
  // window is already on screen.
  const openStrip = (session) => {
    if (!restoreSession(session)) createTab(HOME_URL);
    // One frame later so the launch entrance animation has a state to start from.
    window.requestAnimationFrame(() => {
      document.body.classList.add('booted');
    });
  };

  let pending = null;
  try { pending = loadSession(); } catch (err) { pending = null; }
  if (pending && typeof pending.then === 'function') {
    pending.then(openStrip, () => openStrip(readSession()));
  } else {
    openStrip(readSession());
  }
}

// Top-level declarations in a classic script are already window properties;
// these are said out loud because the sleep harness and settings.js address
// them through window, and a future bundling pass must not quietly drop them.
window.sleepTab = sleepTab;
window.wakeTab = wakeTab;
window.sleepIdleTabs = sleepIdleTabs;
window.canSleepTab = canSleepTab;
window.splitWithNext = splitWithNext;
window.splitWithTab = splitWithTab;
window.splitTabs = splitTabs;
window.unsplit = unsplit;
window.toggleSplit = toggleSplit;
window.toggleClaudeSplit = toggleClaudeSplit;
window.openClaudeBesideTab = openClaudeBesideTab;
window.splitPartner = splitPartner;
window.setSplitRatio = setSplitRatio;
window.markClaudeNeedsYou = markClaudeNeedsYou;
window.askClaude = askClaude;
window.askClaudeAboutTab = askClaudeAboutTab;
window.askClaudeAboutActiveTab = askClaudeAboutActiveTab;
window.askPromptText = askPromptText;
window.showClaudeThisPage = showClaudeThisPage;
window.showPromptText = showPromptText;
window.askClaudeAboutArticle = askClaudeAboutArticle;
window.askArticlePromptText = askArticlePromptText;
window.askClaudeAboutFile = askClaudeAboutFile;
window.filePromptText = filePromptText;
window.clearClaudeNeedsYou = clearClaudeNeedsYou;

// The stats sampler's one entry point, said out loud for the harness: calling
// it is always safe and always a no-op when nothing about the active tab, the
// guest's wishes or the window's focus has moved.
window.syncStatsSubscription = syncStatsSubscription;

// Close and reopen with the tabs restored. settings.js (About) and the command
// palette both go through this rather than api.app.restart(), so the session
// snapshot is flushed the same way whoever asks.
window.restartBrowser = restartBrowser;

// Workspaces. This is the whole contract workspaces.js (the switcher UI) and
// tabsearch.js drive; neither reaches into `workspaces` or `tabs` to change
// anything. Every one of these that changes the model fires 'workspacechange'
// on `document` with { detail: { id } }.
window.workspaceList = workspaceList;
window.currentWorkspace = currentWorkspace;
window.switchWorkspace = switchWorkspace;
window.cycleWorkspace = cycleWorkspace;
window.createWorkspace = createWorkspace;
window.renameWorkspace = renameWorkspace;
window.setWorkspaceColour = setWorkspaceColour;
window.deleteWorkspace = deleteWorkspace;
window.moveTabToWorkspace = moveTabToWorkspace;
window.moveActiveTabToWorkspace = moveActiveTabToWorkspace;
// The current workspace's tabs, in strip order. tabsearch.js can keep reading
// the whole `tabs` array — every item carries .workspace now, so it can group.
window.visibleTabs = visibleTabs;
window.WORKSPACE_COLOURS = WORKSPACE_COLOURS.slice();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
