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
 *                   this file, so it is only ever touched from handlers).
 * Exactly one child of #views is visible at a time; switching is a display swap,
 * never a teardown, so page state and live sessions both survive.
 *
 * New page tabs open the bundled newtab.html (resolved next to index.html). It
 * reads as "blank" in the omnibox and takes focus itself, so typing lands in its
 * own search field.
 *
 * Owned ids (agent D writes index.html):
 *   #tabstrip #newtab #newclaude #back #forward #reload #omnibox #views
 *   #win-min #win-max #win-close #theme
 * Body classes owned here: booted, maximized, acrylic, claude-live.
 * Chip classes owned here: active, claude, live, loading.
 * <html data-theme> is set before first paint by theme-boot.js and from here on.
 */

// The custom new-tab page ships next to index.html; resolving it against the
// chrome document keeps the absolute file:// path out of the source.
const NEWTAB_URL = new URL('newtab.html', window.location.href).href;
const HOME_URL = NEWTAB_URL;
const SEARCH_URL = 'https://www.google.com/search?q=';

// Placeholder URL shown in the omnibox for Claude tabs. Never navigable.
const CLAUDE_URL = 'claude://session';
const CLAUDE_DEFAULT_TITLE = 'Claude';

/**
 * @type {Array<{
 *   id:number, kind:'page'|'claude', viewEl:Element, chipEl:Element,
 *   titleEl:Element, title:string, url:string, ready:boolean,
 *   lastActive:number, loading?:boolean, iconEl?:Element|null,
 *   term?:Object|null, live?:boolean, termOff?:Function[]
 * }>}
 */
const tabs = [];
let activeTabId = null;
let nextTabId = 1;

// DOM refs, resolved in init() so this file can load from <head> or <body>.
let tabstripEl = null;
let newTabBtn = null;
let newClaudeBtn = null;
let backBtn = null;
let forwardBtn = null;
let reloadBtn = null;
let omniboxEl = null;
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
  return SEARCH_URL + encodeURIComponent(text);
}

/** True for the bundled new-tab page, query string and hash included. */
function isNewTabUrl(url) {
  return typeof url === 'string' && url.indexOf(NEWTAB_URL) === 0;
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
  try {
    const pending = tab.viewEl.executeJavaScript(
      "document.documentElement.setAttribute('data-theme','" + theme + "')"
    );
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (err) { /* guest went away mid-call */ }
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
 * Claude tabs have no webview at all, so they never pass.
 */
function isViewUsable(tab) {
  return !!(tab && tab.kind === 'page' && tab.ready && tab.viewEl && tab.viewEl.isConnected);
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

function readCurrentUrl(tab) {
  if (!isViewUsable(tab)) return tab ? tab.url : '';
  try {
    return tab.viewEl.getURL() || tab.url;
  } catch (err) {
    return tab.url;
  }
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
  const blank = !url || url === 'about:blank' || isNewTabUrl(url);
  omniboxEl.value = blank ? '' : url;
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
    const history = historyTarget(tab.viewEl);
    try {
      canBack = !!history.canGoBack();
      canForward = !!history.canGoForward();
    } catch (err) {
      canBack = false;
      canForward = false;
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

  const title = document.createElement('span');
  title.className = 'tab-title';
  title.textContent = tab.title;
  // Truncation is chrome.css's job; the full string stays here for the tooltip.
  chip.title = tab.title;

  const close = document.createElement('button');
  close.className = 'tab-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close tab');
  close.textContent = '×';

  chip.appendChild(title);
  chip.appendChild(close);

  chip.addEventListener('click', () => activateTab(tab.id));
  // Middle-click closes the tab, the same as every other browser.
  chip.addEventListener('auxclick', (event) => {
    if (!event || event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    closeTab(tab.id);
  });
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    closeTab(tab.id);
  });

  tab.titleEl = title;
  return chip;
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
  });

  try {
    tab.chipEl.insertBefore(img, tab.titleEl || tab.chipEl.firstChild);
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
  } catch (err) { /* chip went away mid-load */ }
}

function clearTabIcon(tab) {
  try {
    if (tab && tab.iconEl) tab.iconEl.removeAttribute('src');
  } catch (err) { /* chip went away mid-load */ }
}

function setTabTitle(tab, title) {
  const fallback = isClaudeTab(tab) ? CLAUDE_DEFAULT_TITLE : shortLabelFor(tab.url);
  const text = (title && String(title).trim()) || fallback;
  tab.title = text;
  if (tab.titleEl) tab.titleEl.textContent = text;
  if (tab.chipEl) tab.chipEl.title = text;
}

/* ------------------------------------------------------------------ */
/* Tab lifecycle                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {string} [url]
 * @param {{background?:boolean}} [options] background:true opens the tab behind
 *        the current one (Ctrl+click, target="_blank" with a background hint).
 */
function createTab(url, options) {
  if (!viewsEl || !tabstripEl) return null;

  const opts = options || {};
  let target = toNavigationUrl(url) || HOME_URL;
  // The new-tab page paints its own chrome, so it gets the theme in its URL and
  // is correct from the first frame instead of flashing dark then correcting.
  // isNewTabUrl() is a prefix test, so the query changes nothing downstream.
  if (target === HOME_URL || target === NEWTAB_URL) {
    target = NEWTAB_URL + '?theme=' + getTheme();
  }

  const viewEl = document.createElement('webview');
  // Popups stay off: the `allowpopups` attribute is deliberately never set.
  viewEl.removeAttribute('allowpopups');
  viewEl.setAttribute('src', target);
  viewEl.style.width = '100%';
  viewEl.style.height = '100%';
  viewEl.style.display = 'none'; // activateTab() reveals the active one

  const tab = {
    id: nextTabId++,
    kind: 'page',
    viewEl: viewEl,
    chipEl: null,
    titleEl: null,
    title: shortLabelFor(target),
    url: target,
    ready: false,
    loading: false,
    iconEl: null,
    lastActive: 0
  };

  tab.chipEl = buildChip(tab);
  wireViewEvents(tab);

  tabs.push(tab);
  viewsEl.appendChild(viewEl);
  tabstripEl.appendChild(tab.chipEl);
  saveSession(); // debounced: activateTab() below folds into the same write

  // Never leave the window with nothing on screen: the very first tab is opened
  // in front even when the caller asked for a background one.
  if (opts.background && activeTabId !== null) return tab;

  activateTab(tab.id);
  return tab;
}

/* ------------------------------------------------------------------ */
/* Claude tabs                                                         */
/* ------------------------------------------------------------------ */

/** body.claude-live is true while ANY Claude tab still has a live session. */
function recomputeClaudeLive() {
  const any = tabs.some((t) => isClaudeTab(t) && t.live);
  document.body.classList.toggle('claude-live', any);
}

/**
 * ConPTY hands us the shell's executable path as the initial window title.
 * Anything that looks like a Windows path or an .exe is noise, not a title.
 */
function isNoiseTitle(text) {
  const t = String(text == null ? '' : text);
  return /\.exe$/i.test(t) || /^[A-Za-z]:\\/.test(t);
}

/**
 * Order matters: the view is appended and activated BEFORE the session starts,
 * so the host element already has a size when ClaudeTerminal.create() measures
 * it. terminal.js is loaded after this file, hence the typeof guard.
 */
function createClaudeTab() {
  if (!viewsEl || !tabstripEl) return null;

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
    title: CLAUDE_DEFAULT_TITLE,
    url: CLAUDE_URL,
    term: null,
    live: false,
    ready: true,
    lastActive: 0,
    termOff: []
  };

  tab.chipEl = buildChip(tab);

  tabs.push(tab);
  viewsEl.appendChild(viewEl);
  tabstripEl.appendChild(tab.chipEl);

  activateTab(tab.id);

  const factory = (typeof window.ClaudeTerminal === 'object' && window.ClaudeTerminal)
    ? window.ClaudeTerminal
    : null;
  if (!factory || typeof factory.create !== 'function') {
    setTabTitle(tab, 'Claude (unavailable)');
    return tab;
  }

  const home = (window.api && typeof window.api.homeDir === 'string') ? window.api.homeDir : undefined;

  try {
    tab.term = factory.create(viewEl, { cwd: home });
  } catch (err) {
    tab.term = null;
    setTabTitle(tab, 'Claude (unavailable)');
    return tab;
  }

  wireTermEvents(tab);
  return tab;
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
    if (!live && tab.title === CLAUDE_DEFAULT_TITLE) {
      setTabTitle(tab, 'Claude (ended)');
    }
  });

  listen('title', (text) => {
    if (isNoiseTitle(text)) return;
    let clean = String(text == null ? '' : text).trim();
    // The CLI reports a bare lowercase "claude" as its title; show the product name.
    if (/^claude$/i.test(clean)) clean = CLAUDE_DEFAULT_TITLE;
    setTabTitle(tab, clean ? clean.slice(0, 60) : CLAUDE_DEFAULT_TITLE);
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

  activeTabId = target.id;
  target.lastActive = Date.now();

  for (const tab of tabs) {
    const isActive = tab.id === activeTabId;
    // Nothing is destroyed on switch — hiding preserves page state and live PTYs.
    tab.viewEl.style.display = isActive ? 'flex' : 'none';
    if (tab.chipEl) {
      tab.chipEl.classList.toggle('active', isActive);
      tab.chipEl.setAttribute('aria-selected', String(isActive));
    }
  }

  if (isClaudeTab(target)) {
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

  syncOmniboxFromActive(true);
  updateNavState();
  syncReloadButton(); // the incoming tab may be mid-load, the outgoing one not
  saveSession(); // the active index is part of the session

  // Chrome modules (find bar, downloads, history) follow the active tab
  // through this event instead of reaching into the tab model.
  document.dispatchEvent(new CustomEvent('tabchange', {
    detail: { id: target.id, kind: target.kind }
  }));
}

function closeTab(id) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return;

  const tab = tabs[index];
  const wasActive = tab.id === activeTabId;

  pushClosedTab(tab); // read the url while the view is still attached

  tab.ready = false;
  disposeClaudeTab(tab); // no-op for page tabs
  try { tab.viewEl.remove(); } catch (err) { /* already detached */ }
  try { if (tab.chipEl) tab.chipEl.remove(); } catch (err) { /* already detached */ }
  tabs.splice(index, 1);
  recomputeClaudeLive();
  saveSession();

  if (tabs.length === 0) {
    activeTabId = null;
    createTab(HOME_URL); // never sit at zero tabs
    return;
  }

  if (wasActive) {
    const neighbour = tabs[Math.min(index, tabs.length - 1)];
    activateTab(neighbour.id);
  } else {
    updateNavState();
  }
}

function closeActiveTab() {
  if (activeTabId !== null) closeTab(activeTabId);
}

/* ------------------------------------------------------------------ */
/* Session persistence and reopened tabs                               */
/* ------------------------------------------------------------------ */

/*
 * Only page tabs are persisted. A Claude tab is a live PTY: there is nothing on
 * disk to rebuild it from, so those are skipped on save and the stored `active`
 * index counts page tabs alone.
 *
 * Every localStorage call below is wrapped — storage can be blocked or full, and
 * losing the session must never take the browser down with it.
 */
const SESSION_STORAGE_KEY = 'session';
const SESSION_SAVE_DELAY = 500;
const SESSION_MAX_TABS = 40;
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
  const parsed = parseUrlOrNull(url);
  // Web pages only: a file:// or data: tab is not worth reopening cold.
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
  return parsed.href;
}

function sessionSnapshot() {
  const entries = [];
  let active = -1;
  for (const tab of tabs) {
    const url = sessionUrlFor(tab);
    if (!url) continue; // Claude tabs and unpersistable pages shift nothing
    if (tab.id === activeTabId) active = entries.length;
    entries.push({ url: url });
  }
  const capped = entries.slice(0, SESSION_MAX_TABS);
  return { tabs: capped, active: active < capped.length ? active : -1 };
}

function writeSession() {
  sessionSaveTimer = null;
  if (restoring) return;
  try {
    // Zero page tabs is a legitimate state and is stored as such.
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessionSnapshot()));
  } catch (err) { /* storage blocked or full — this run just loses its session */ }
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
 * Read and sanitise the stored session. Returns null when there is nothing
 * usable — missing, malformed, or every entry dropped.
 * @returns {{urls:string[], active:number}|null}
 */
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
  if (!parsed || !Array.isArray(parsed.tabs)) return null;

  const urls = [];
  for (const entry of parsed.tabs) {
    const url = (entry && typeof entry.url === 'string') ? entry.url : '';
    if (!url) continue;
    if (url === SESSION_NEWTAB) {
      urls.push(SESSION_NEWTAB);
    } else {
      const target = parseUrlOrNull(url);
      // Anything that is not plain web goes on the floor, whoever wrote it.
      if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) continue;
      urls.push(target.href);
    }
    if (urls.length >= SESSION_MAX_TABS) break;
  }
  if (!urls.length) return null;

  const active = Number(parsed.active);
  const inRange = isFinite(active) && active >= 0 && active < urls.length;
  return { urls: urls, active: inRange ? active : urls.length - 1 };
}

/**
 * Rebuild last run's page tabs. Returns true when it took over the boot; init()
 * falls back to its single HOME_URL tab when this says no.
 */
function restoreSession() {
  const session = readSession();
  if (!session) return false;

  restoring = true;
  const created = [];
  try {
    // All background: the strip is built in order, then the saved tab is raised.
    for (const url of session.urls) {
      const tab = createTab(url === SESSION_NEWTAB ? HOME_URL : url, { background: true });
      if (tab) created.push(tab);
    }
  } finally {
    // A throw mid-build must not strand the flag and mute every later save.
    restoring = false;
  }

  if (!created.length) return false;

  const target = created[Math.min(session.active, created.length - 1)]
    || created[created.length - 1];
  activateTab(target.id);
  saveSession(); // one write, now that the strip is settled
  return true;
}

/** Remember a closed page tab so Ctrl+Shift+T can bring it back. */
function pushClosedTab(tab) {
  if (!tab || tab.kind !== 'page') return; // a closed Claude session cannot reopen
  const url = readCurrentUrl(tab) || tab.url;
  // A blank new tab is not worth a slot on the stack.
  if (!url || isNewTabUrl(url)) return;
  closedStack.push(url);
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

function wireViewEvents(tab) {
  const viewEl = tab.viewEl;

  viewEl.addEventListener('dom-ready', () => {
    tab.ready = true;
    if (tab.id === activeTabId) {
      syncOmniboxFromActive(false);
      updateNavState();
      // The very first tab is activated before its guest exists; hand the
      // new-tab page focus now so its autofocused search field gets the keys.
      if (isNewTabUrl(readCurrentUrl(tab))) focusViewSoon(tab);
    }
  });

  viewEl.addEventListener('destroyed', () => {
    tab.ready = false;
  });

  viewEl.addEventListener('page-title-updated', (event) => {
    setTabTitle(tab, event && event.title);
    historyCall('updateTitle', tab.url, event && event.title);
  });

  const onNavigate = (event) => {
    if (event && event.url) tab.url = event.url;
    setTabTitle(tab, tab.title);
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
    setTabLoading(tab, true);
    clearTabIcon(tab); // the incoming page reports its own, or stays blank
  });

  viewEl.addEventListener('did-stop-loading', () => {
    setTabLoading(tab, false);
    if (tab.id === activeTabId) updateNavState();
  });

  viewEl.addEventListener('did-fail-load', () => {
    // Aborted and failed loads both end here; the spinner must not stick.
    setTabLoading(tab, false);
  });

  // A video going fullscreen inside the page: the chrome steps aside.
  viewEl.addEventListener('enter-html-full-screen', () => {
    if (tab.id === activeTabId) setPageFullscreen(true);
  });
  viewEl.addEventListener('leave-html-full-screen', () => {
    setPageFullscreen(false);
  });

  viewEl.addEventListener('page-favicon-updated', (event) => {
    try {
      const icons = event && event.favicons;
      if (Array.isArray(icons) && icons.length) setTabIcon(tab, icons[0]);
    } catch (err) { /* malformed event payload */ }
  });

  // target="_blank" and Ctrl+click. `allowpopups` stays off, so the guest never
  // gets a real popup window; we turn the request into a tab ourselves.
  viewEl.addEventListener('new-window', (event) => {
    if (!event || typeof event.url !== 'string') return;
    const parsed = parseUrlOrNull(event.url);
    // Web only: a page must not talk us into opening file:// or a custom scheme.
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return;

    const disposition = event.disposition;
    if (disposition === 'background-tab') {
      createTab(parsed.href, { background: true });
      return;
    }
    // Anything that is not a tab request (save-to-disk, other) is ignored.
    if (disposition && disposition !== 'foreground-tab'
        && disposition !== 'new-window' && disposition !== 'default') {
      return;
    }
    createTab(parsed.href); // createTab() activates it
  });
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

/** Step through the strip in order, wrapping at both ends. */
function cycleTab(step) {
  if (tabs.length < 2) return;
  const index = tabs.findIndex((t) => t.id === activeTabId);
  const from = index === -1 ? 0 : index;
  const next = (from + step + tabs.length) % tabs.length;
  activateTab(tabs[next].id);
}

/** Ctrl+1..8 pick that position; Ctrl+9 is always the last tab. */
function selectTabByIndex(index) {
  const n = Number(index);
  if (!isFinite(n) || n < 1 || n > 9) return;
  const tab = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
  if (tab) activateTab(tab.id);
}

const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 5;

function clampZoom(level) {
  const n = (typeof level === 'number' && isFinite(level)) ? level : 0;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, n));
}

/**
 * Page tabs only — a Claude chamber scales with its own font size, not the
 * webview zoom. getZoomLevel() is synchronous on current Electron and a promise
 * on older builds, so both shapes are handled.
 */
function zoomActiveTab(delta) {
  const tab = getActiveTab();
  if (!isViewUsable(tab)) return;

  const apply = (level) => {
    try {
      tab.viewEl.setZoomLevel(clampZoom(level + delta));
    } catch (err) { /* view went away mid-call */ }
  };

  try {
    const current = tab.viewEl.getZoomLevel();
    if (current && typeof current.then === 'function') {
      current.then((level) => apply(typeof level === 'number' ? level : 0)).catch(() => {});
      return;
    }
    apply(typeof current === 'number' ? current : 0);
  } catch (err) { /* view went away mid-call */ }
}

function resetZoom() {
  const tab = getActiveTab();
  if (!isViewUsable(tab)) return;
  try { tab.viewEl.setZoomLevel(0); } catch (err) { /* view went away mid-call */ }
}

/* ------------------------------------------------------------------ */
/* Claude toggle                                                       */
/* ------------------------------------------------------------------ */

function mostRecentTabOfKind(kind) {
  let best = null;
  for (const tab of tabs) {
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
    newClaudeBtn.addEventListener('click', () => createClaudeTab());
  }
  if (backBtn) backBtn.addEventListener('click', goBack);
  if (forwardBtn) forwardBtn.addEventListener('click', goForward);
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
}

// Actions the modules own. Each exposes handleShortcut(action) -> true when it
// consumed the action; 'escape' is offered to all of them until one takes it.
function moduleShortcut(action) {
  const modules = [window.FindBar, window.Downloads, window.History];
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

function wireKeyboard() {
  // Keys pressed while focus is inside a <webview> go to the guest page, not
  // here. main.js intercepts those and replays them over 'shortcut', so the
  // same actions work whether the chrome or a page currently has focus.
  if (window.api && typeof window.api.onShortcut === 'function') {
    const forwarded = {
      'toggle-terminal': toggleClaude,
      'new-tab': () => createTab(HOME_URL),
      'close-tab': closeActiveTab,
      'reopen-tab': reopenClosedTab,
      'focus-omnibox': focusOmnibox,
      'next-tab': () => cycleTab(1),
      'prev-tab': () => cycleTab(-1),
      // The only action carrying data: payload.index is 1-9.
      'select-tab': (payload) => selectTabByIndex(payload && payload.index),
      'zoom-in': () => zoomActiveTab(ZOOM_STEP),
      'zoom-out': () => zoomActiveTab(-ZOOM_STEP),
      'zoom-reset': resetZoom,
      'toggle-theme': toggleTheme,
      'reload': reloadActiveTab,
      'back': goBack,
      'forward': goForward,
      'fullscreen': toggleFullscreen,
      'find': () => moduleShortcut('find'),
      'downloads': () => moduleShortcut('downloads'),
      'history': () => moduleShortcut('history'),
      'escape': () => moduleShortcut('escape'),
    };
    window.api.onShortcut((payload) => {
      const run = payload && forwarded[payload.action];
      if (run) run(payload);
    });
  }

  window.addEventListener('keydown', (event) => {
    if (event.metaKey) return;

    // Keys that mean the same thing without Ctrl.
    if (!event.ctrlKey && !event.altKey) {
      if (event.key === 'F5') { event.preventDefault(); reloadActiveTab(); return; }
      if (event.key === 'F11') { event.preventDefault(); toggleFullscreen(); return; }
      if (event.key === 'Escape' && moduleShortcut('escape')) { event.preventDefault(); }
      return;
    }
    if (event.altKey && !event.ctrlKey) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); goBack(); }
      if (event.key === 'ArrowRight') { event.preventDefault(); goForward(); }
      return;
    }
    if (!event.ctrlKey || event.altKey) return;

    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';

    // Module bars: find, downloads, history. Each decides whether it applies.
    if (key === 'f' || key === 'j' || key === 'h') {
      const action = key === 'f' ? 'find' : key === 'j' ? 'downloads' : 'history';
      if (moduleShortcut(action)) event.preventDefault();
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
    if (key === 'r') {
      event.preventDefault(); // never let Ctrl+R reload the shell window
      reloadActiveTab(); // no-op on a Claude tab
      return;
    }
    if (key === '`' || event.code === 'Backquote') {
      event.preventDefault();
      toggleClaude(); // same path as the shortcut action and the Claude button
    }
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function init() {
  tabstripEl = document.getElementById('tabstrip');
  newTabBtn = document.getElementById('newtab');
  newClaudeBtn = document.getElementById('newclaude');
  backBtn = document.getElementById('back');
  forwardBtn = document.getElementById('forward');
  reloadBtn = document.getElementById('reload');
  omniboxEl = document.getElementById('omnibox');
  viewsEl = document.getElementById('views');
  winMinBtn = document.getElementById('win-min');
  winMaxBtn = document.getElementById('win-max');
  winCloseBtn = document.getElementById('win-close');
  themeBtn = document.getElementById('theme');

  wireChrome();
  wireWindowControls();
  wireKeyboard();

  // Re-apply the theme theme-boot.js already stamped on <html>: this is what
  // paints the toggle glyph and hands the theme to terminal.js. Runs before the
  // first tab so that tab is born with the right ?theme= on its URL.
  setTheme(getTheme());

  updateNavState();
  syncReloadButton();

  // Last run's page tabs win the boot; a missing, malformed or empty session
  // falls through to the single home tab this has always opened.
  if (!restoreSession()) createTab(HOME_URL);

  // One frame later so the launch entrance animation has a state to start from.
  window.requestAnimationFrame(() => {
    document.body.classList.add('booted');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
