/* ============================================================
   history.js — the browser's memory, and the lens that reads it.

   Two halves, one file:

   1. THE STORE (window.History). Every page the browser lands on is
      upserted by exact URL into localStorage['history'] as
      { v:1, items:[{url,title,visits,last}] }. Writes are debounced,
      the list is capped, and a missing or corrupt record is treated
      as "no history yet" rather than an error. app.js calls record()
      from did-navigate and updateTitle() from page-title-updated.

   2. THE LENS (#omni-suggest). A glass panel that hangs directly
      under the omnibox capsule and mirrors its left/width. It is ONE
      box that searches the user's own things first and then falls through
      to the web. With text typed, in this order and each source capped:

        default row   what Enter already does (a search, an address,
                      or a site keyword such as "gh helm" when
                      keywords.js is loaded and recognises it)
        open tabs     page and Claude tabs whose title / URL / folder
                      the query hits; the row switches to that tab
        saved         the bookmarks, which are Settings.chips()
        notes         sections of the School class notes, from the
                      index school.js already keeps in main
        folders       folders directly under ~ and ~/Downloads
                      (one cached IPC listing), opened in the Files tab
        apps          from tabsearch.js's app index, badged
        history       the best matches from the store above

      Every row carries a glyph and a quiet source label on its right,
      so a tab never reads like a history hit. The total stays at ten
      rows, the default row included; history always keeps two places
      when it has matches. All sources are synchronous in-memory reads
      except the folder listing, which is fetched in the background and
      redraws the panel when it lands. A source that cannot answer says
      so on one faint line at the foot of the panel, in plain words.
      On an empty focus it still shows only what was open recently.

      Most rows never navigate by themselves: they write into #omnibox
      and hand the Enter key to app.js, so tab and Claude handling stay
      in exactly one place. Three kinds act on their own — an app row
      launches the app, a tab row switches to the tab, a folder row
      opens the Files tab — and each then puts the bar back to the page
      that is really on screen.

   3. THE PAGE (historypage.html). Ctrl+H opens the full list in a tab
      of its own. The guest has no preload, so the chrome pushes it a
      snapshot() and reads its intentions back off the console through
      handleGuestMessage(); pageUrl() carries theme and palette.

   Style: classic script, no modules, every colour a chrome.css token.
   ============================================================ */

(function () {
  'use strict';

  /* --- constants ---------------------------------------------- */

  var STORAGE_KEY = 'history';
  var STORAGE_VERSION = 1;
  var MAX_ITEMS = 2000;      // hard cap; the oldest visit is dropped first
  var WRITE_DELAY = 500;     // ms of quiet before the list hits localStorage
  var INPUT_DELAY = 40;      // ms of quiet before the panel re-renders
  var BLUR_DELAY = 120;      // ms grace so a click outside still lands
  var MAX_ROWS = 6;          // history rows at most (and the empty-focus recent list)
  var MAX_APP_ROWS = 3;      // app rows, between the folders and history
  var MAX_TAB_ROWS = 3;      // "switch to tab" rows, right under the default row
  var MAX_SAVED_ROWS = 2;    // bookmark (chip) rows
  var MAX_NOTE_ROWS = 2;     // School note sections
  var MAX_FOLDER_ROWS = 2;   // project folders under ~ and ~/Downloads
  var MAX_TOTAL_ROWS = 10;   // every row for a typed query, the default row included
  var MIN_HISTORY_ROWS = 2;  // places history keeps when it has matches at all
  var MIN_WIDE_QUERY = 2;    // notes and folders wait for two characters: one
                             // letter would match half of 750 note sections
  var FOLDER_TTL = 180000;   // ms a folder listing is trusted before a refetch
  var PANEL_GAP = 6;         // px between the omnibox capsule and the panel

  // Segoe Fluent Icons, same set the rest of the chrome draws from.
  var GLYPH_SEARCH = '\uE721';   // magnifier: a Google search
  var GLYPH_GLOBE  = '\uE774';   // globe: a plain address
  var GLYPH_CLOCK  = '\uE81C';   // clock: something already visited
  var GLYPH_APP    = '\uECAA';   // tile: an app, when it has no icon of its own
  var GLYPH_TAB    = '\uE8AB';   // Switch: a tab that is already open
  var GLYPH_CLAUDE = '\uE756';   // CommandPrompt: a Claude session tab (tabsearch.js's mark)
  var GLYPH_STAR   = '\uE734';   // FavoriteStar: a saved site, as on the omnibox star
  var GLYPH_NOTES  = '\uE82D';   // Dictionary: a section of the class notes
  var GLYPH_FOLDER = '\uE8B7';   // Folder: a project folder

  // Where the class notes live when school.js hands over a bare file name.
  // school-pane.js carries the same constant; main never sends the folder.
  var NOTES_DIR = 'C:/Users/you/Documents/notes/';

  // files.js boots into this localStorage key. The chrome and its file://
  // guests share one origin, so writing it here opens a NEW Files tab
  // straight on the folder a lens row asked for.
  var FILES_LAST_KEY = 'files.last';

  // Schemes that are never worth remembering. file: matters most: the
  // bundled new-tab page is a file:// URL and would otherwise be the
  // most-visited entry in the list by a wide margin.
  var IGNORED_SCHEMES = [
    'about:', 'data:', 'file:', 'blob:', 'javascript:',
    'chrome:', 'chrome-error:', 'chrome-extension:', 'devtools:', 'claude:'
  ];

  // Score tiers. A query word scores the best tier it can reach, and an
  // item that cannot place every word anywhere scores zero and is out.
  var TIER_HOST_START = 100;
  var TIER_HOST = 70;
  var TIER_PATH = 40;
  var TIER_TITLE = 20;
  var TIER_URL = 10;

  // topSites(): frequency with a two-week half-life, so a site he stopped
  // opening slides down the new-tab chips on its own instead of sticking.
  var TOP_DEFAULT = 8;       // chips asked for when no limit is given
  var TOP_CAP = 50;          // most rows topSites() will ever return
  var HALF_LIFE_DAYS = 14;   // a visit is worth half as much a fortnight on
  var DAY_MS = 86400000;
  var NOTIFY_DELAY = 1500;   // ms of quiet before subscribers hear about a change

  /* --- state --------------------------------------------------- */

  var items = [];            // the whole list, unsorted
  var byUrl = Object.create(null);
  var loaded = false;
  var writeTimer = null;
  var fieldCache = new Map();
  var subscribers = [];      // change listeners, see subscribe()
  var notifyTimer = null;

  /* --- storage ------------------------------------------------- */

  function storage() {
    try {
      return (typeof window !== 'undefined' && window.localStorage) || null;
    } catch (err) {
      return null; // storage disabled by policy
    }
  }

  function reindex() {
    byUrl = Object.create(null);
    for (var i = 0; i < items.length; i++) byUrl[items[i].url] = items[i];
  }

  /** Read the list once. Anything unreadable simply means "start empty". */
  function load() {
    loaded = true;
    items = [];
    byUrl = Object.create(null);
    var store = storage();
    if (!store) return;
    var raw = null;
    try {
      raw = store.getItem(STORAGE_KEY);
    } catch (err) {
      return;
    }
    if (!raw) return;
    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return; // corrupt record: the next write replaces it
    }
    if (!parsed || !Array.isArray(parsed.items)) return;
    for (var i = 0; i < parsed.items.length; i++) {
      var row = parsed.items[i];
      if (!row || typeof row.url !== 'string' || !row.url) continue;
      if (byUrl[row.url]) continue;
      var item = {
        url: row.url,
        title: typeof row.title === 'string' ? row.title : '',
        visits: Number(row.visits) > 0 ? Math.floor(Number(row.visits)) : 1,
        last: Number(row.last) > 0 ? Number(row.last) : 0
      };
      items.push(item);
      byUrl[item.url] = item;
    }
    trim();
  }

  function ready() {
    if (!loaded) load();
  }

  function writeNow() {
    if (writeTimer !== null) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    var store = storage();
    if (!store) return;
    try {
      store.setItem(STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, items: items }));
    } catch (err) {
      /* quota or a locked profile: the in-memory list still works */
    }
  }

  function scheduleWrite() {
    if (writeTimer !== null) clearTimeout(writeTimer);
    writeTimer = setTimeout(function () {
      writeTimer = null;
      writeNow();
    }, WRITE_DELAY);
  }

  /** Drop the oldest visits once the list is over the cap. */
  function trim() {
    if (items.length <= MAX_ITEMS) return;
    items.sort(function (a, b) { return b.last - a.last; });
    items.length = MAX_ITEMS;
    reindex();
  }

  /* --- url helpers --------------------------------------------- */

  function parseUrl(text) {
    try {
      return new URL(text);
    } catch (err) {
      return null;
    }
  }

  function isIgnored(url) {
    if (typeof url !== 'string') return true;
    var text = url.trim();
    if (!text) return true;
    var lower = text.toLowerCase();
    for (var i = 0; i < IGNORED_SCHEMES.length; i++) {
      if (lower.indexOf(IGNORED_SCHEMES[i]) === 0) return true;
    }
    return false;
  }

  /** host (www stripped), path, title and whole url, all lowercased. */
  function fieldsFor(item) {
    var url = String(item && item.url ? item.url : '');
    var hit = fieldCache.get(url);
    if (hit) {
      hit.title = String(item && item.title ? item.title : '').toLowerCase();
      return hit;
    }
    var lower = url.toLowerCase();
    var parsed = parseUrl(url);
    var fields = {
      host: parsed && parsed.hostname ? parsed.hostname.toLowerCase().replace(/^www\./, '') : '',
      path: parsed ? (parsed.pathname + parsed.search + parsed.hash).toLowerCase() : lower,
      title: String(item && item.title ? item.title : '').toLowerCase(),
      url: lower
    };
    if (fieldCache.size > 4000) fieldCache.clear();
    fieldCache.set(url, fields);
    return fields;
  }

  function toWords(query) {
    return String(query == null ? '' : query).toLowerCase().trim().split(/\s+/)
      .filter(function (w) { return !!w; });
  }

  /**
   * Rank one item against the query words. Host beats path beats title,
   * a host prefix beats a host substring, and every word must land
   * somewhere or the item is not a match at all.
   */
  function score(item, words) {
    if (!item || !words || !words.length) return 0;
    var f = fieldsFor(item);
    var total = 0;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      var tier = 0;
      if (f.host && f.host.indexOf(w) === 0) tier = TIER_HOST_START;
      else if (f.host && f.host.indexOf(w) > 0) tier = TIER_HOST;
      else if (f.path && f.path.indexOf(w) !== -1) tier = TIER_PATH;
      else if (f.title && f.title.indexOf(w) !== -1) tier = TIER_TITLE;
      else if (f.url.indexOf(w) !== -1) tier = TIER_URL;
      if (!tier) return 0;
      total += tier;
    }
    return total;
  }

  function copy(item) {
    return { url: item.url, title: item.title, visits: item.visits, last: item.last };
  }

  /* --- the store API -------------------------------------------- */

  /** Upsert by exact URL. An empty incoming title never erases a good one. */
  function record(url, title) {
    ready();
    if (isIgnored(url)) return false;
    var key = String(url).trim();
    var name = typeof title === 'string' ? title.trim() : '';
    var item = byUrl[key];
    if (item) {
      item.visits += 1;
      item.last = Date.now();
      if (name) item.title = name;
    } else {
      item = { url: key, title: name, visits: 1, last: Date.now() };
      items.push(item);
      byUrl[key] = item;
      trim();
    }
    scheduleWrite();
    notify();
    return true;
  }

  /** Name a page already in the list. Never creates an entry. */
  function updateTitle(url, title) {
    ready();
    if (typeof url !== 'string') return false;
    var name = typeof title === 'string' ? title.trim() : '';
    if (!name) return false;
    var item = byUrl[String(url).trim()];
    if (!item || item.title === name) return false;
    item.title = name;
    scheduleWrite();
    notify();
    return true;
  }

  function search(query, limit) {
    ready();
    var cap = typeof limit === 'number' && limit > 0 ? limit : MAX_ROWS;
    var words = toWords(query);
    if (!words.length) return [];
    var hits = [];
    for (var i = 0; i < items.length; i++) {
      var s = score(items[i], words);
      if (s > 0) hits.push({ item: items[i], score: s });
    }
    hits.sort(function (a, b) {
      return (b.score - a.score) ||
        (b.item.visits - a.item.visits) ||
        (b.item.last - a.item.last);
    });
    return hits.slice(0, cap).map(function (h) { return copy(h.item); });
  }

  function recent(limit) {
    ready();
    var cap = typeof limit === 'number' && limit > 0 ? limit : MAX_ROWS;
    return items.slice()
      .sort(function (a, b) { return (b.last - a.last) || (b.visits - a.visits); })
      .slice(0, cap)
      .map(copy);
  }

  function remove(url) {
    ready();
    var key = String(url == null ? '' : url).trim();
    if (!byUrl[key]) return false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].url === key) { items.splice(i, 1); break; }
    }
    delete byUrl[key];
    scheduleWrite();
    notify();
    return true;
  }

  function clear() {
    ready();
    items = [];
    byUrl = Object.create(null);
    fieldCache.clear();
    writeNow();
    notify();
  }

  function all() {
    ready();
    return items.map(copy);
  }

  /* --- most-used hosts ------------------------------------------ */

  /** hostname[:port], lowercased with "www." dropped. '' when there is none. */
  function hostKey(parsed) {
    if (!parsed || !parsed.hostname) return '';
    var host = String(parsed.hostname).toLowerCase().replace(/^www\./, '');
    if (!host) return '';
    return parsed.port ? host + ':' + parsed.port : host;
  }

  /**
   * The hosts he actually uses, hottest first — what the new-tab chips are
   * made of. Every page folds onto its host (a dev server on :7373 is its
   * own row), search results and non-web schemes are out, and each visit is
   * weighted by 0.5^(age / 14 days) so somewhere he stopped going fades.
   *
   * Rows are { host, url, title, visits, score, last }: `url` is the origin
   * of the host's most-visited page, `visits` the plain total. Pure read —
   * it writes nothing, and a corrupt item is skipped rather than thrown on.
   */
  function topSites(limit) {
    ready();
    var cap = TOP_DEFAULT;
    if (typeof limit === 'number' && isFinite(limit) && limit > 0) {
      cap = Math.min(Math.floor(limit), TOP_CAP);
    }
    var now = Date.now();
    var groups = Object.create(null);
    var rows = [];
    for (var i = 0; i < items.length; i++) {
      try {
        var item = items[i];
        if (!item || typeof item.url !== 'string') continue;
        var parsed = parseUrl(item.url);
        if (!parsed) continue;
        var scheme = String(parsed.protocol || '').toLowerCase();
        if (scheme !== 'http:' && scheme !== 'https:') continue;
        var host = hostKey(parsed);
        if (!host) continue;
        if (isSearchUrl(item.url)) continue;
        var visits = Number(item.visits);
        if (!isFinite(visits) || visits <= 0) continue;
        var last = Number(item.last);
        if (!isFinite(last)) continue;
        var age = (now - last) / DAY_MS;
        if (!(age > 0)) age = 0;          // a clock skew never inflates a row
        var row = groups[host];
        if (!row) {
          row = groups[host] = {
            host: host, url: '', title: '', visits: 0, score: 0, last: 0,
            bestVisits: -1, bestLast: -1
          };
          rows.push(row);
        }
        row.visits += visits;
        row.score += visits * Math.pow(0.5, age / HALF_LIFE_DAYS);
        if (last > row.last) row.last = last;
        if (visits > row.bestVisits || (visits === row.bestVisits && last > row.bestLast)) {
          row.bestVisits = visits;
          row.bestLast = last;
          row.url = parsed.origin + '/';
          row.title = typeof item.title === 'string' ? item.title : '';
        }
      } catch (err) {
        /* one unreadable item never costs the whole list */
      }
    }
    rows.sort(function (a, b) {
      return (b.score - a.score) || (b.visits - a.visits) ||
        (b.last - a.last) || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0);
    });
    return rows.slice(0, cap).map(function (r) {
      return {
        host: r.host, url: r.url, title: r.title,
        visits: r.visits, score: r.score, last: r.last
      };
    });
  }

  /* --- change notifications ------------------------------------- */

  /** Coalesce a burst of visits into one call per 1500 ms of quiet. */
  function notify() {
    if (!subscribers.length) return;
    if (notifyTimer !== null) clearTimeout(notifyTimer);
    notifyTimer = setTimeout(function () {
      notifyTimer = null;
      var list = subscribers.slice();
      for (var i = 0; i < list.length; i++) {
        try {
          list[i]();
        } catch (err) {
          /* one bad subscriber never takes out the others or the store */
        }
      }
    }, NOTIFY_DELAY);
  }

  /**
   * Hear about any change to the list — a visit, a rename, a delete, a
   * clear — debounced to one call per 1500 ms of quiet. Never fires on
   * load. Returns the unsubscribe, which is safe to call twice.
   */
  function subscribe(cb) {
    if (typeof cb !== 'function') return function () {};
    subscribers.push(cb);
    var live = true;
    return function () {
      if (!live) return;
      live = false;
      var at = subscribers.indexOf(cb);
      if (at >= 0) subscribers.splice(at, 1);
      if (!subscribers.length && notifyTimer !== null) {
        clearTimeout(notifyTimer);
        notifyTimer = null;
      }
    };
  }

  /* ============================================================
     The page: historypage.html

     A guest page on file://, with no node and no preload. The chrome
     pushes the whole list into it once per load with __applyHistory()
     and listens to its console for '__history:' lines; everything
     below is the chrome's half of that contract.
     ============================================================ */

  var PAGE_FILE = 'historypage.html';
  var GUEST_PREFIX = '__history:';
  var pageBase = null;

  /** file:///…/historypage.html, resolved once. Headless it is the bare name. */
  function pageBaseUrl() {
    if (pageBase !== null) return pageBase;
    pageBase = PAGE_FILE;
    try {
      if (typeof window !== 'undefined' && window.location && window.location.href) {
        pageBase = new URL(PAGE_FILE, window.location.href).href;
      }
    } catch (err) { pageBase = PAGE_FILE; }
    return pageBase;
  }

  /** An attribute off the chrome's own <html>, or null if there is no DOM. */
  function rootAttr(name) {
    try {
      var el = typeof document !== 'undefined' && document.documentElement;
      if (el && typeof el.getAttribute === 'function') return el.getAttribute(name);
    } catch (err) { /* no DOM */ }
    return null;
  }

  /**
   * The page's URL, carrying the chrome's theme and palette so the guest
   * is painted correctly on its very first frame (same trick as the new
   * tab and the reader). No palette attribute = the authored aurora.
   */
  function pageUrl() {
    var url = pageBaseUrl() + '?theme=' + (rootAttr('data-theme') === 'light' ? 'light' : 'dark');
    var palette = rootAttr('data-palette');
    if (palette) url += '&palette=' + encodeURIComponent(palette);
    return url;
  }

  /** True for the bundled history page, query string and hash included. */
  function isHistoryUrl(url) {
    return typeof url === 'string' && url.indexOf(pageBaseUrl()) === 0;
  }

  /** Everything the page draws: newest first, plus the true total. */
  function snapshot() {
    ready();
    var list = items.slice().sort(function (a, b) {
      return (b.last - a.last) || (b.visits - a.visits);
    });
    return { items: list.slice(0, MAX_ITEMS).map(copy), total: list.length };
  }

  /**
   * Forget everything visited inside the last `ms` — "last hour" is
   * clearSince(3.6e6), not the other way round. Returns how many went.
   */
  function clearSince(ms) {
    ready();
    var span = Number(ms);
    if (!isFinite(span) || span <= 0) return 0;
    var cutoff = Date.now() - span;
    var kept = [];
    var dropped = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].last >= cutoff) { dropped++; continue; }
      kept.push(items[i]);
    }
    if (!dropped) return 0;
    items = kept;
    reindex();
    fieldCache.clear();
    writeNow();
    notify();
    return dropped;
  }

  /* --- app.js, reached defensively ------------------------------ */

  /** app.js's top-level function declarations land on window; a const does not. */
  function globalFn(name) {
    try {
      if (typeof window !== 'undefined' && typeof window[name] === 'function') return window[name];
    } catch (err) { /* fall through */ }
    return null;
  }

  /** The tab list is a top-level `const` in app.js: shared scope, never window. */
  function allTabs() {
    try {
      /* global tabs */
      if (typeof tabs !== 'undefined' && tabs && typeof tabs.length === 'number') return tabs;
    } catch (err) { /* not in scope */ }
    var w = typeof window !== 'undefined' ? window.tabs : null;
    return w && typeof w.length === 'number' ? w : null;
  }

  function findPageTab() {
    var all = allTabs();
    if (!all) return null;
    for (var i = 0; i < all.length; i++) {
      if (all[i] && isHistoryUrl(all[i].url)) return all[i];
    }
    return null;
  }

  /** Ctrl+H: one history tab, reused if it is already open. */
  function openPage() {
    var create = globalFn('createTab');
    if (!create) return false;
    var existing = findPageTab();
    if (existing) {
      var activate = globalFn('activateTab');
      if (activate) {
        try { activate(existing.id); return true; } catch (err) { /* fall through to a new tab */ }
      }
    }
    try { create(pageUrl()); } catch (err) { return false; }
    return true;
  }

  /**
   * One console line from the history guest. A preload-less page can only
   * talk this way, so the chrome forwards every console-message here.
   *
   *   __history:{"op":"remove","url":"…"}
   *   __history:{"op":"clear"}
   *   __history:{"op":"clearRange","olderThanMs":3600000}
   *   __history:{"op":"open","url":"…","background":true}
   *
   * Returns true only when an action actually ran: anything else — a
   * normal console line, a broken payload, an unknown op — is false, so
   * the caller can tell "the guest asked for something" from noise.
   */
  function handleGuestMessage(text) {
    if (typeof text !== 'string') return false;
    var line = text.trim();
    if (line.indexOf(GUEST_PREFIX) !== 0) return false;

    var msg = null;
    try { msg = JSON.parse(line.slice(GUEST_PREFIX.length)); } catch (err) { return false; }
    if (!msg || typeof msg !== 'object') return false;

    var url = typeof msg.url === 'string' ? msg.url : '';

    if (msg.op === 'remove') return url ? remove(url) : false;
    if (msg.op === 'clear') { clear(); return true; }
    if (msg.op === 'clearRange' || msg.op === 'clearSince') {
      return clearSince(msg.olderThanMs) > 0;
    }
    if (msg.op === 'open') {
      if (!url) return false;
      if (msg.background) {
        var create = globalFn('createTab');
        if (!create) return false;
        try { create(url, { background: true }); } catch (err) { return false; }
        return true;
      }
      var go = globalFn('navigateActiveTab');
      if (!go) return false;
      try { go(url); } catch (err) { return false; }
      return true;
    }
    return false;
  }

  /* ============================================================
     The lens: #omni-suggest
     ============================================================ */

  var omniboxEl = null;
  var panel = null;
  var listEl = null;
  var capEl = null;
  var rows = [];             // [{ url, kind, app, tabId, path }] parallel to the row elements
  var rowEls = [];
  var stateEl = null;        // the one faint "X unavailable: why" line, or null
  var actionNote = '';       // a row that could not act says so here, once
  var hi = -1;               // -1 = nothing highlighted; Enter does what it always did
  var typedValue = '';       // what the user actually typed, before any highlight
  var openState = false;
  var inputTimer = null;
  var blurTimer = null;
  var appsWaiting = false;   // one whenAppsReady registration per open
  var rendering = false;     // guards render() against a synchronous re-entry

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  /** Paint text into a node, wrapping every matched run in <mark>. */
  function markInto(host, text, words) {
    var s = String(text == null ? '' : text);
    if (!s) return;
    if (!words || !words.length) {
      host.appendChild(document.createTextNode(s));
      return;
    }
    var lower = s.toLowerCase();
    var spans = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      var at = lower.indexOf(w);
      while (at !== -1) {
        spans.push([at, at + w.length]);
        at = lower.indexOf(w, at + 1);
      }
    }
    if (!spans.length) {
      host.appendChild(document.createTextNode(s));
      return;
    }
    spans.sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); });
    var merged = [];
    for (var j = 0; j < spans.length; j++) {
      var last = merged[merged.length - 1];
      if (last && spans[j][0] <= last[1]) {
        if (spans[j][1] > last[1]) last[1] = spans[j][1];
      } else {
        merged.push([spans[j][0], spans[j][1]]);
      }
    }
    var pos = 0;
    for (var k = 0; k < merged.length; k++) {
      if (merged[k][0] > pos) {
        host.appendChild(document.createTextNode(s.slice(pos, merged[k][0])));
      }
      var mark = document.createElement('mark');
      mark.textContent = s.slice(merged[k][0], merged[k][1]);
      host.appendChild(mark);
      pos = merged[k][1];
    }
    if (pos < s.length) host.appendChild(document.createTextNode(s.slice(pos)));
  }

  function buildPanel() {
    panel = el('div', 'glass');
    panel.id = 'omni-suggest';
    panel.setAttribute('role', 'listbox');
    panel.hidden = true;
    capEl = el('div', 'omni-cap');
    capEl.textContent = 'Recent';
    capEl.hidden = true;
    listEl = el('div', 'omni-list');
    stateEl = el('div', 'omni-state');
    stateEl.hidden = true;
    panel.appendChild(capEl);
    panel.appendChild(listEl);
    panel.appendChild(stateEl);
    document.body.appendChild(panel);
  }

  /** The panel hangs off the omnibox capsule and copies its left/width. */
  function place() {
    if (!panel || !omniboxEl) return;
    var box = omniboxEl.getBoundingClientRect();
    panel.style.left = Math.round(box.left) + 'px';
    panel.style.width = Math.round(box.width) + 'px';
    panel.style.top = Math.round(box.bottom + PANEL_GAP) + 'px';
  }

  /** How the omnibox names a search that lands on Quartz's own results page. */
  var OWN_RESULTS_LABEL = 'Brave search, on Quartz’s results page';

  /** True for Quartz's own results page (settings.js knows its address). */
  function isOwnResults(url) {
    var settings = window.Settings;
    if (!settings || typeof settings.isOwnResultsUrl !== 'function') return false;
    try { return !!settings.isOwnResultsUrl(url); } catch (err) { return false; }
  }

  /** A results page rather than a destination: Google, Bing, DDG, Yahoo. */
  function isSearchUrl(url) {
    var parsed = parseUrl(url);
    if (!parsed) return false;
    var host = String(parsed.hostname || '').toLowerCase();
    var path = parsed.pathname || '';
    if (/(^|\.)google\./.test(host) && path.indexOf('/search') === 0) return true;
    if (/(^|\.)bing\.com$/.test(host) && path.indexOf('/search') === 0) return true;
    if (/(^|\.)duckduckgo\.com$/.test(host) && /[?&]q=/.test(parsed.search || '')) return true;
    if (/(^|\.)search\.yahoo\.com$/.test(host)) return true;
    return false;
  }

  function navUrlFor(text) {
    if (typeof toNavigationUrl !== 'function') return null;
    try {
      return toNavigationUrl(text);
    } catch (err) {
      return null;
    }
  }

  function addRow(spec) {
    var index = rows.length;
    var row = el('div', 'omni-row' + (spec.secondary ? '' : ' omni-row--single') +
      (spec.faint ? ' omni-row--faint' : ''));
    row.setAttribute('role', 'option');
    row.dataset.index = String(index);

    // An app that ships its own icon fills the glyph slot with it; every
    // other row keeps the icon-font glyph, so the text column never moves.
    if (spec.iconDataUrl) {
      var icon = el('img', 'omni-appicon');
      icon.src = spec.iconDataUrl;
      icon.alt = '';
      row.appendChild(icon);
    } else {
      var ico = el('span', 'glyph omni-ico');
      ico.textContent = spec.glyph;
      row.appendChild(ico);
    }

    var body = el('span', 'omni-body');
    var primary = el('span', 'omni-primary');
    markInto(primary, spec.primary, spec.words);
    // "App" / "Web app" / "Terminal": a label on the name, so a row that
    // launches something never reads like one that navigates.
    if (spec.badge) {
      var badge = el('span', 'omni-badge');
      badge.textContent = spec.badge;
      primary.appendChild(badge);
    }
    body.appendChild(primary);
    if (spec.secondary) {
      var secondary = el('span', 'omni-secondary');
      markInto(secondary, spec.secondary, spec.faint ? null : spec.words);
      body.appendChild(secondary);
    }
    row.appendChild(body);

    // Where the row came from ("Open tab", "Saved", "Notes", "History"…),
    // pinned to the right edge so a long title can never push it out.
    if (spec.label) {
      var src = el('span', 'omni-src');
      src.textContent = spec.label;
      row.appendChild(src);
    }

    // mousedown is swallowed so the omnibox never blurs; click then still
    // fires on the row and the input keeps its caret and selection.
    row.addEventListener('mousedown', function (event) { event.preventDefault(); });
    row.addEventListener('mouseenter', function () { setHighlight(index, false); });
    row.addEventListener('click', function (event) {
      commit(index, !!(event && event.shiftKey));
    });

    listEl.appendChild(row);
    rowEls.push(row);
    rows.push({
      url: spec.url,
      kind: spec.kind,
      app: spec.app || null,
      tabId: spec.tabId === undefined ? null : spec.tabId,
      path: spec.path || null
    });
  }

  /**
   * The quiet line under the rows for a source that could not answer. It is
   * not a row: it never takes the highlight and Enter never lands on it.
   */
  function setStateLine(text) {
    if (!stateEl) return;
    stateEl.textContent = text || '';
    stateEl.title = text || '';
    stateEl.hidden = !text;
  }

  function clearRows() {
    rows = [];
    rowEls = [];
    hi = -1;
    if (listEl) listEl.textContent = '';
    setStateLine('');
  }

  /* --- apps, borrowed from tabsearch.js -------------------------- */

  /**
   * The app index lives in tabsearch.js. It can be absent entirely (an
   * older build) or simply not landed yet on the first keystroke — either
   * way the lens quietly shows no app rows and behaves exactly as before.
   */
  function tabSearch() {
    return (typeof window !== 'undefined' && window.TabSearch) ? window.TabSearch : null;
  }

  function appMatches(query, limit) {
    var ts = tabSearch();
    if (!ts || typeof ts.appMatches !== 'function') return [];
    try {
      var out = ts.appMatches(query, limit);
      return out && typeof out.length === 'number' ? out : [];
    } catch (err) {
      return [];
    }
  }

  /**
   * Ask once per open — never once per keystroke — to be told when the
   * index lands, so a query typed before it is ready still grows its rows.
   */
  function waitForApps() {
    if (appsWaiting) return;
    var ts = tabSearch();
    if (!ts || typeof ts.whenAppsReady !== 'function') return;
    appsWaiting = true;
    try {
      ts.whenAppsReady(onAppsReady);
    } catch (err) {
      appsWaiting = false;
    }
  }

  /** The index landed late: redraw, keeping the highlight if it still fits. */
  function onAppsReady() {
    redrawIfOpen();
  }

  /**
   * A source that answers asynchronously (the app index, the folder list,
   * the School index) landed: redraw the open panel in place. Skipped while
   * a keyboard highlight is previewing a URL in the bar, because render()
   * reads the bar and would search the preview instead of what was typed.
   */
  function redrawIfOpen() {
    if (rendering) return;   // it landed synchronously; this render already has it
    if (!openState || !panel || panel.hidden) return;
    if (typeof document !== 'undefined' && document.activeElement !== omniboxEl) return;
    if (String(omniboxEl.value || '') !== typedValue) return;
    var prev = hi;
    render();
    if (!rows.length) { close(); return; }
    place();
    hi = (prev >= 0 && prev < rows.length) ? prev : -1;
    paintHighlight();
  }

  /* --- open tabs, read from app.js ------------------------------- */

  /*
   * tabs and activeTabId are top-level const/let in app.js: shared scope for
   * classic scripts, never properties of window. Every read sits behind a
   * typeof guard, exactly as tabsearch.js's bridge does, so a build without
   * them simply has no tab rows.
   */
  function readActiveTabId() {
    try {
      /* global activeTabId */
      return (typeof activeTabId !== 'undefined') ? activeTabId : null;
    } catch (err) { return null; }
  }

  function isNewTabPage(url) {
    var fn = globalFn('isNewTabUrl');
    if (!fn) return false;
    try { return !!fn(url); } catch (err) { return false; }
  }

  /**
   * Page and Claude tabs the query hits, best first. The active tab is left
   * out (switching to it is a no-op), so are blank new tabs (nothing to find)
   * and hosted native apps (the app rows already switch to those).
   */
  function tabMatches(lower, words, limit) {
    var all = allTabs();
    if (!all || !words.length) return [];
    var active = readActiveTabId();
    var hits = [];
    for (var i = 0; i < all.length; i++) {
      var tab = all[i];
      if (!tab || tab.id === active) continue;
      var claude = tab.kind === 'claude';
      if (!claude && tab.kind !== 'page') continue;
      var url = claude ? '' : String(tab.url || '');
      if (!claude && (!url || isNewTabPage(url))) continue;
      var title = String(tab.title || '') || (claude ? 'Claude' : shortLabel(url));
      var extra = claude ? String(tab.cwd || '') : url;
      if (!hitsAll(words, title, extra)) continue;
      var t = title.toLowerCase();
      var rank = t.indexOf(lower) === 0 ? 0 : (t.indexOf(lower) >= 0 ? 1 : 2);
      hits.push({ rank: rank, order: i, tab: tab, claude: claude, title: title, extra: extra });
    }
    hits.sort(function (a, b) { return (a.rank - b.rank) || (a.order - b.order); });
    return hits.slice(0, limit);
  }

  /**
   * True when every query word lands in `name` or `address`. A one-letter
   * query only counts at the start of a word ("h" finds "Helm", not every
   * https:// address); from two letters on, anywhere counts, so "hub"
   * still finds GitHub.
   */
  function hitsAll(words, name, address) {
    if (words.length === 1 && words[0].length < MIN_WIDE_QUERY) {
      var needle = ' ' + words[0];
      var bare = String(address || '').replace(/^[a-z][a-z0-9+.-]*:\/*(www\.)?/i, '');
      return wordHay(name).indexOf(needle) >= 0 || wordHay(bare).indexOf(needle) >= 0;
    }
    var a = String(name || '').toLowerCase();
    var b = String(address || '').toLowerCase();
    for (var w = 0; w < words.length; w++) {
      if (a.indexOf(words[w]) < 0 && b.indexOf(words[w]) < 0) return false;
    }
    return true;
  }

  /** Switch to an open tab. False when app.js has no activateTab to call. */
  function switchToTab(id) {
    var activate = globalFn('activateTab');
    if (!activate) return false;
    var all = allTabs();
    var alive = false;
    for (var i = 0; all && i < all.length; i++) {
      if (all[i] && all[i].id === id) { alive = true; break; }
    }
    if (!alive) return false;   // closed between the keystroke and the press
    try { activate(id); } catch (err) { return false; }
    return true;
  }

  /* --- saved sites: Settings.chips() IS the bookmarks list -------- */

  function savedMatches(lower, words, limit) {
    var settings = (typeof window !== 'undefined') ? window.Settings : null;
    if (!settings || typeof settings.chips !== 'function' || !words.length) return [];
    var list;
    try { list = settings.chips(); } catch (err) { return []; }
    if (!list || typeof list.length !== 'number') return [];
    var hits = [];
    for (var i = 0; i < list.length; i++) {
      var chip = list[i];
      if (!chip || typeof chip.url !== 'string' || !chip.url) continue;
      var label = String(chip.label || '') || shortLabel(chip.url);
      if (!hitsAll(words, label, chip.url)) continue;
      var l = label.toLowerCase();
      var rank = l.indexOf(lower) === 0 ? 0 : (l.indexOf(lower) >= 0 ? 1 : 2);
      hits.push({ rank: rank, order: i, url: chip.url, label: label });
    }
    hits.sort(function (a, b) { return (a.rank - b.rank) || (a.order - b.order); });
    return hits.slice(0, limit);
  }

  /* --- School notes: the section index school.js keeps in main --- */

  /*
   * school.js parses every class file in Documents\notes at startup (and on
   * every change) into state.classes = [{ id, name, file, sections: [{ id,
   * title }] }] and already hands the chrome the whole state through
   * api.school.describe() and its school:update pushes. This keeps a flat,
   * lowercased copy of just the sections, so a keystroke is a plain loop.
   */
  var notesIndex = [];       // [{ cls, title, url, t, c }]
  var notesWatching = false;
  var notesReady = false;    // true once a describe/push said ready
  var notesReason = '';      // why there are no notes, in plain words ('' = fine or still loading)
  var notesSig = '';         // what the last adopted index looked like, to skip no-op pushes

  /** The notes file as a file:// URL, the same rule school-pane.js's fileUrl() follows. */
  function notesFileUrl(cls) {
    var raw = cls && typeof cls.file === 'string' ? cls.file.trim() : '';
    if (/^file:\/\//i.test(raw)) return raw;
    var p = raw || (String(cls && cls.id ? cls.id : '') + '.html');
    p = p.replace(/\\/g, '/');
    if (!/^[a-zA-Z]:\//.test(p) && p.charAt(0) !== '/') p = NOTES_DIR + p;
    return 'file:///' + p.replace(/^\//, '').replace(/[#?%]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function adoptSchool(state) {
    if (!state || typeof state !== 'object') {
      notesIndex = [];
      notesReady = false;
      notesReason = 'the School index did not answer';
      notesSig = '';
      redrawIfOpen();
      return;
    }
    var classes = Array.isArray(state.classes) ? state.classes : [];
    var next = [];
    for (var i = 0; i < classes.length; i++) {
      var cls = classes[i];
      if (!cls || !Array.isArray(cls.sections)) continue;
      var name = String(cls.name || cls.id || 'Notes');
      var base = notesFileUrl(cls);
      for (var j = 0; j < cls.sections.length; j++) {
        var s = cls.sections[j];
        if (!s || typeof s.id !== 'string' || !s.id) continue;
        var title = String(s.title || s.id);
        next.push({
          cls: name,
          title: title,
          url: base + '#' + encodeURIComponent(s.id),
          t: title.toLowerCase(),
          c: name.toLowerCase(),
          tw: wordHay(title),     // ' word word …' for start-of-word tests
          cw: wordHay(name)
        });
      }
    }
    var ready = !!state.ready && next.length > 0;
    var reason = ready ? '' : String(state.reason || 'the School index is empty');
    // school:update fires for everything the workspace does (every LessonPlayer
    // read, every helper step), not just for the notes. Only a change in
    // the sections themselves is worth repainting an open panel for.
    var chars = 0;
    for (var k = 0; k < next.length; k++) chars += next[k].url.length + next[k].t.length;
    var sig = next.length + ':' + chars + ':' + (ready ? 1 : 0) + ':' + reason;
    notesIndex = next;
    notesReady = ready;
    notesReason = reason;
    if (sig === notesSig) return;
    notesSig = sig;
    redrawIfOpen();
  }

  /** Once per window: take the current state, then every push after it. */
  function watchNotes() {
    if (notesWatching) return;
    notesWatching = true;
    var api = (typeof window !== 'undefined' && window.api) ? window.api.school : null;
    if (!api || typeof api.describe !== 'function') {
      notesReason = 'this build has no School index to search';
      return;
    }
    try {
      if (typeof api.onUpdate === 'function') api.onUpdate(adoptSchool);
    } catch (err) { /* describe() below still seeds it once */ }
    try {
      Promise.resolve(api.describe()).then(adoptSchool, function (err) {
        notesReason = 'the School index failed: ' + ((err && err.message) || 'no answer');
        redrawIfOpen();
      });
    } catch (err) {
      notesReason = 'the School index failed: ' + ((err && err.message) || 'no answer');
    }
  }

  /** Lowercased, punctuation folded to spaces, with a leading space: ' ' + w finds a word start. */
  function wordHay(text) {
    return ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /**
   * Sections whose title the query hits. Every word has to START a word in
   * the section title or the class name ("git" must not find "Digital"),
   * and at least one has to land in the title: "chem" alone must not list
   * all 219 course sections by their class.
   */
  function noteMatches(lower, words, limit) {
    if (lower.length < MIN_WIDE_QUERY || !notesIndex.length || !words.length) return [];
    var needles = [];
    for (var k = 0; k < words.length; k++) {
      var folded = wordHay(words[k]);
      if (folded.length > 1) needles.push(folded);   // pure punctuation folds to ' ': skip it
    }
    if (!needles.length) return [];
    var whole = wordHay(lower) + ' ';
    var hits = [];
    for (var i = 0; i < notesIndex.length; i++) {
      var n = notesIndex[i];
      var inTitle = 0;
      var ok = true;
      for (var w = 0; w < needles.length; w++) {
        if (n.tw.indexOf(needles[w]) >= 0) inTitle++;
        else if (n.cw.indexOf(needles[w]) < 0) { ok = false; break; }
      }
      if (!ok || !inTitle) continue;
      // 0 the title starts with it, 1 it is a whole word of the title
      // ("matter" in "Classification of Matter" beats "mattered"), 2 the
      // title contains it, 3 every word in the title, 4 split with the class.
      var rank = n.t.indexOf(lower) === 0 ? 0
        : ((n.tw + ' ').indexOf(whole) >= 0 ? 1
          : (n.t.indexOf(lower) >= 0 ? 2 : (inTitle === needles.length ? 3 : 4)));
      hits.push({ rank: rank, order: i, note: n });
    }
    hits.sort(function (a, b) {
      return (a.rank - b.rank) || (a.note.t.length - b.note.t.length) || (a.order - b.order);
    });
    return hits.slice(0, limit).map(function (h) { return h.note; });
  }

  /* --- project folders: one cached listing from main -------------- */

  /*
   * The renderer cannot read a directory, so main.js answers omni:folders
   * (preload: api.listProjectFolders) with the folders directly under ~ and
   * ~/Downloads. It is asked at most once per FOLDER_TTL — on focus, or on
   * the first query that wants it — and never awaited: the rows that are
   * ready paint now and the folders join them when the answer lands.
   */
  var folders = [];          // [{ name, path, root, n }]
  var foldersAt = 0;         // when the last answer (or failure) landed
  var foldersPending = false;
  var foldersReason = '';    // '' = fine; otherwise why the list is missing or partial
  var folderListerOverride = null;   // test seam only: History._lens.folderLister(fn)

  function refreshFolders(force) {
    if (foldersPending) return;
    if (!force && foldersAt && Date.now() - foldersAt < FOLDER_TTL) return;
    var api = (typeof window !== 'undefined') ? window.api : null;
    if (folderListerOverride) api = { listProjectFolders: folderListerOverride };
    if (!api || typeof api.listProjectFolders !== 'function') {
      foldersAt = Date.now();
      foldersReason = 'this build cannot list folders (no listProjectFolders in preload)';
      return;
    }
    foldersPending = true;
    var settle = function (answer, failure) {
      foldersPending = false;
      foldersAt = Date.now();
      if (!answer || typeof answer !== 'object') {
        // Keep the last good list: stale folders beat none. Say so anyway.
        foldersReason = 'the folder list failed: ' + (failure || 'no answer');
      } else {
        var list = Array.isArray(answer.folders) ? answer.folders : [];
        var next = [];
        for (var i = 0; i < list.length; i++) {
          var f = list[i];
          if (!f || typeof f.name !== 'string' || !f.name || typeof f.path !== 'string' || !f.path) continue;
          next.push({ name: f.name, path: f.path, root: f.root === 'downloads' ? 'downloads' : 'home', n: f.name.toLowerCase() });
        }
        folders = next;
        foldersReason = answer.ok === false ? String(answer.reason || 'the folder list came back incomplete') : '';
      }
      redrawIfOpen();
    };
    try {
      Promise.resolve(api.listProjectFolders()).then(
        function (answer) { settle(answer, ''); },
        function (err) { settle(null, (err && err.message) || 'IPC error'); }
      );
    } catch (err) {
      settle(null, (err && err.message) || 'IPC error');
    }
  }

  /** Folder names the query hits: exact, then prefix, then anywhere; ~ before Downloads. */
  function folderMatches(lower, words, limit) {
    if (lower.length < MIN_WIDE_QUERY || !folders.length || !words.length) return [];
    var hits = [];
    for (var i = 0; i < folders.length; i++) {
      var f = folders[i];
      var ok = true;
      for (var w = 0; w < words.length; w++) {
        if (f.n.indexOf(words[w]) < 0) { ok = false; break; }
      }
      if (!ok) continue;
      var rank = f.n === lower ? 0 : (f.n.indexOf(lower) === 0 ? 1 : 2);
      hits.push({ rank: rank, home: f.root === 'home' ? 0 : 1, folder: f });
    }
    hits.sort(function (a, b) {
      return (a.rank - b.rank) || (a.home - b.home) || (a.folder.n.length - b.folder.n.length);
    });
    return hits.slice(0, limit).map(function (h) { return h.folder; });
  }

  /**
   * Open one folder in Quartz's own Files tab. A new tab boots straight into
   * it through files.js's remembered-folder key; a Files tab that is already
   * up is switched to and handed the listing, the same push app.js answers
   * the page's own requests with. False only when nothing could be opened.
   */
  function openFolder(target) {
    try { window.localStorage.setItem(FILES_LAST_KEY, target); } catch (err) { /* a new tab opens on its last folder instead */ }

    var find = globalFn('findFilesTab');
    var existing = null;
    if (find) { try { existing = find(); } catch (err) { existing = null; } }

    if (existing) {
      if (!switchToTab(existing.id)) return false;
      if (pushFolder(existing, target)) return true;
      // An older app.js with no push: a reload boots the page into the key above.
      try {
        if (existing.viewEl && typeof existing.viewEl.reload === 'function') existing.viewEl.reload();
      } catch (err) { /* asleep: waking it boots it into the key */ }
      return true;
    }

    var url = globalFn('filesUrl');
    var create = globalFn('createTab');
    if (!url || !create) return false;
    var tab = null;
    try { tab = create(url()); } catch (err) { return false; }
    if (!tab) return false;
    // A brand-new Files guest can print its boot request before app.js has
    // marked the view ready, and that first answer is lost (the page then
    // sits on "This PC"). So once the view IS ready, push the folder too:
    // the page is waiting on exactly this path, so it takes it in either
    // order. Bounded: about six seconds of 150 ms looks, then it gives up
    // and the page's own boot is all there is.
    var tries = 0;
    var look = function () {
      tries++;
      if (tab.ready && tab.viewEl) { pushFolder(tab, target); return; }
      if (tries < 40) setTimeout(look, 150);
    };
    setTimeout(look, 150);
    return true;
  }

  /**
   * List one folder through main and hand it to a Files guest with app.js's
   * own push (pushFilesListing), plus the places rail when app.js offers it.
   * False when this build of app.js has neither piece.
   */
  function pushFolder(tab, target) {
    var push = globalFn('pushFilesListing');
    var filesApi = (window.api && window.api.files) ? window.api.files : null;
    var view = tab && tab.viewEl;
    if (!push || !filesApi || typeof filesApi.list !== 'function' || !view) return false;
    var places = globalFn('pushFilePlacesToTab');
    if (places) { try { places(tab); } catch (err) { /* the rail is a nicety */ } }
    Promise.resolve(filesApi.list(target)).then(function (answer) {
      try { push(tab, view, answer); } catch (err) { /* the page shows its own error */ }
    }, function () {
      try { push(tab, view, { path: target, entries: [], error: 'the folder could not be listed' }); } catch (err) { /* gone */ }
    });
    return true;
  }

  /* --- site keywords: keywords.js, when it is loaded -------------- */

  /**
   * "gh helm" -> { key, name, query, url } from keywords.js, or null. Fully
   * guarded: no Keywords, a throw, or a malformed answer all mean "behave
   * exactly as before". app.js does the navigating; this only relabels.
   */
  function keywordFor(text) {
    var kw = (typeof window !== 'undefined') ? window.Keywords : null;
    if (!kw || typeof kw.match !== 'function') return null;
    try {
      var m = kw.match(text);
      if (m && typeof m === 'object' && typeof m.name === 'string' && m.name &&
          typeof m.url === 'string' && m.url) return m;
    } catch (err) { /* a broken keyword table must not break the bar */ }
    return null;
  }

  /**
   * Rebuild the rows for the omnibox's current value. The re-entry guard
   * matters: whenAppsReady may answer synchronously from inside render().
   */
  function render() {
    rendering = true;
    try {
      renderRows();
    } finally {
      rendering = false;
    }
  }

  function renderRows() {
    if (!panel) return;
    clearRows();
    var query = String(omniboxEl.value || '').trim();

    if (!query) {
      var history = recent(MAX_ROWS);
      capEl.hidden = history.length === 0;
      for (var i = 0; i < history.length; i++) {
        addRow({
          kind: 'history',
          url: history[i].url,
          glyph: GLYPH_CLOCK,
          primary: history[i].title || shortLabel(history[i].url),
          secondary: history[i].url,
          words: null
        });
      }
      return;
    }

    capEl.hidden = true;

    // Row one always mirrors what Enter does today, so the panel never
    // changes the meaning of just typing and pressing Enter. A site keyword
    // ("gh helm") only changes how that row reads and which URL it shows;
    // app.js is still the one that resolves the Enter.
    var target = null;
    var kw = keywordFor(query);
    if (kw) {
      target = kw.url;
      var kwQuery = String(kw.query == null ? '' : kw.query);
      addRow({
        kind: 'default',
        url: target,
        glyph: GLYPH_SEARCH,
        primary: kwQuery ? 'Search ' + kw.name + ' for “' + kwQuery + '”' : 'Search ' + kw.name,
        secondary: isOwnResults(target) ? OWN_RESULTS_LABEL : target,
        faint: true,
        words: null
      });
    } else {
      target = navUrlFor(query);
      if (target) {
        if (isOwnResults(target)) {
          // Quartz's own results page: the search, never its file:// address.
          addRow({
            kind: 'default',
            url: target,
            glyph: GLYPH_SEARCH,
            primary: query,
            secondary: OWN_RESULTS_LABEL,
            faint: true,
            words: null
          });
        } else if (isSearchUrl(target)) {
          addRow({
            kind: 'default',
            url: target,
            glyph: GLYPH_SEARCH,
            primary: query,
            secondary: 'Google search',
            faint: true,
            words: null
          });
        } else {
          addRow({
            kind: 'default',
            url: target,
            glyph: GLYPH_GLOBE,
            primary: target,
            secondary: '',
            words: null
          });
        }
      }
    }

    var words = toWords(query);
    var lower = query.toLowerCase();

    // Gather every source first, then share out the ten places: each source
    // up to its own cap, in order, with two places held back for history so
    // a busy query never squeezes out what was actually visited.
    refreshFolders(false);   // a no-op unless the cached list is stale
    var tabHits = tabMatches(lower, words, MAX_TAB_ROWS);
    var savedHits = savedMatches(lower, words, MAX_SAVED_ROWS);
    var noteHits = noteMatches(lower, words, MAX_NOTE_ROWS);
    var folderHits = folderMatches(lower, words, MAX_FOLDER_ROWS);
    var apps = appMatches(query, MAX_APP_ROWS);
    waitForApps();
    var hits = search(query, MAX_ROWS);

    var budget = MAX_TOTAL_ROWS - rows.length - Math.min(hits.length, MIN_HISTORY_ROWS);
    function take(list) {
      var n = Math.max(0, Math.min(list.length, budget));
      budget -= n;
      return n;
    }

    // Addresses already offered above: a history hit for one of them is
    // dropped below so one page never shows twice (an open tab wins, since
    // switching beats loading the page a second time).
    var shown = Object.create(null);
    if (target) shown[target] = true;

    // Open tabs: the press switches to the tab instead of loading it again.
    var nTabs = take(tabHits);
    for (var t = 0; t < nTabs; t++) {
      var th = tabHits[t];
      if (!th.claude && th.extra) shown[th.extra] = true;
      addRow({
        kind: 'tab',
        tabId: th.tab.id,
        url: null,
        glyph: th.claude ? GLYPH_CLAUDE : GLYPH_TAB,
        primary: th.title,
        secondary: th.claude ? (th.extra || 'Claude session') : th.extra,
        label: th.claude ? 'Claude tab' : 'Open tab',
        words: words
      });
    }

    // Saved sites navigate like history does.
    var nSaved = take(savedHits);
    for (var s = 0; s < nSaved; s++) {
      shown[savedHits[s].url] = true;
      addRow({
        kind: 'saved',
        url: savedHits[s].url,
        glyph: GLYPH_STAR,
        primary: savedHits[s].label,
        secondary: savedHits[s].url,
        label: 'Saved',
        words: words
      });
    }

    // Note sections open the class file at that section, in this tab.
    var nNotes = take(noteHits);
    for (var n = 0; n < nNotes; n++) {
      addRow({
        kind: 'notes',
        url: noteHits[n].url,
        glyph: GLYPH_NOTES,
        primary: 'notes: ' + noteHits[n].cls + ' › ' + noteHits[n].title,
        secondary: '',
        label: 'Notes',
        words: words
      });
    }

    // Folders open in the Files tab; the full path is the second line.
    var nFolders = take(folderHits);
    for (var f = 0; f < nFolders; f++) {
      addRow({
        kind: 'folder',
        path: folderHits[f].path,
        url: null,
        glyph: GLYPH_FOLDER,
        primary: folderHits[f].name,
        secondary: folderHits[f].path,
        label: 'Folder',
        words: words
      });
    }

    // Then the apps whose name the query hits. These launch instead of
    // navigating, which is why they carry a badge and never the default
    // row's place: row one still means exactly what Enter means.
    var nApps = take(apps);
    for (var a = 0; a < nApps; a++) {
      var app = apps[a];
      if (!app) continue;
      var hint = String(app.hint == null ? '' : app.hint);
      // Searching for an app IN the browser opens it IN the browser: the
      // plain press hosts it in a tab (adopting its window if it is
      // already up), and the desktop launch moves to the modifier. A row
      // that is hosted already keeps the source's own hint — there is
      // nothing left to advertise.
      if (app.kind === 'app' && typeof app.runInTab === 'function' && !app.open) {
        hint = 'Open in a tab · Shift+Enter opens it on the desktop';
      }
      addRow({
        kind: 'app',
        app: app,
        url: null,
        glyph: app.glyph || GLYPH_APP,
        iconDataUrl: app.iconDataUrl || null,
        primary: app.name,
        badge: app.badge || 'App',
        secondary: hint,
        faint: !!hint,
        words: words
      });
    }

    // History fills whatever is left, never past the total.
    for (var j = 0; j < hits.length && rows.length < MAX_TOTAL_ROWS; j++) {
      if (shown[hits[j].url]) continue;
      addRow({
        kind: 'history',
        url: hits[j].url,
        glyph: GLYPH_CLOCK,
        primary: hits[j].title || shortLabel(hits[j].url),
        secondary: hits[j].url,
        label: 'History',
        words: words
      });
    }

    // A source that could not answer says so here, once, in plain words.
    // Notes and folders are only searched from two characters on, so their
    // trouble is only reported from there too.
    var trouble = [];
    if (actionNote) trouble.push(actionNote);
    if (lower.length >= MIN_WIDE_QUERY) {
      if (!notesReady && notesReason && notesReason !== 'starting up') {
        trouble.push('Notes unavailable: ' + notesReason);
      }
      if (foldersReason) trouble.push('Folders unavailable: ' + foldersReason);
    }
    setStateLine(trouble.join(' · '));
  }

  function shortLabel(url) {
    if (typeof shortLabelFor === 'function') {
      try { return shortLabelFor(url); } catch (err) { /* fall through */ }
    }
    var parsed = parseUrl(url);
    return parsed && parsed.hostname ? parsed.hostname.replace(/^www\./, '') : url;
  }

  function paintHighlight() {
    for (var i = 0; i < rowEls.length; i++) {
      if (i === hi) rowEls[i].classList.add('is-hi');
      else rowEls[i].classList.remove('is-hi');
    }
    if (panel) {
      if (hi >= 0 && rowEls[hi]) panel.setAttribute('aria-activedescendant', String(hi));
      else panel.removeAttribute('aria-activedescendant');
    }
  }

  /**
   * Move the highlight. A keyboard move previews the row in the omnibox
   * the way a browser bar does; a hover only lights the row.
   */
  function setHighlight(index, fromKeyboard) {
    hi = index;
    paintHighlight();
    if (!fromKeyboard) return;
    // The default row IS the typed text, so previewing it would only swap
    // "cats" for a google.com/search URL; app, tab and folder rows act
    // rather than navigate, so they have no URL to preview. Only the rows
    // that navigate (history, saved, notes) preview.
    if (hi >= 0 && rows[hi] && navigates(rows[hi])) omniboxEl.value = rows[hi].url;
    else omniboxEl.value = typedValue;
  }

  /** History, saved and notes rows navigate: Enter loads their URL via app.js. */
  function navigates(row) {
    return !!row && !!row.url &&
      (row.kind === 'history' || row.kind === 'saved' || row.kind === 'notes');
  }

  /** App, tab and folder rows act on their own; app.js must never see their Enter. */
  function acts(row) {
    return !!row && (row.kind === 'app' || row.kind === 'tab' || row.kind === 'folder');
  }

  function step(delta) {
    if (!rows.length) return;
    var next;
    if (hi === -1) next = delta > 0 ? 0 : rows.length - 1;
    else {
      next = hi + delta;
      if (next >= rows.length) next = -1;
      else if (next < -1) next = rows.length - 1;
    }
    setHighlight(next, true);
  }

  function open() {
    if (!panel) return;
    render();
    if (!rows.length) { close(); return; }   // never an empty panel
    panel.hidden = false;
    openState = true;
    place();
    paintHighlight();
  }

  function close() {
    if (!panel) return;
    panel.hidden = true;
    openState = false;
    appsWaiting = false;     // the next open asks for the index again
    clearRows();
    paintHighlight();
  }

  function restoreTyped() {
    if (omniboxEl && omniboxEl.value !== typedValue) omniboxEl.value = typedValue;
  }

  /** After a row that acted on its own: drop focus, show the page really on screen. */
  function restoreBar() {
    if (!omniboxEl) return;
    omniboxEl.blur();
    if (typeof syncOmniboxFromActive === 'function') {
      try { syncOmniboxFromActive(true); return; } catch (err) { /* fall through */ }
    }
    omniboxEl.value = typedValue;
  }

  /**
   * Navigate by handing the work back to app.js: write the URL into the
   * omnibox, then send the same Enter keydown app.js already listens for.
   * Tab creation, Claude tabs and focus handling stay in one place.
   */
  function commit(index, withShift) {
    var row = rows[index];
    if (!row) return;

    // An app row never navigates: it launches, and the bar goes back to
    // showing the page that is actually on screen.
    if (row.kind === 'app' && row.app) {
      close();
      try {
        // The plain press keeps the app inside the browser; Shift is the
        // way out to the desktop. An older tabsearch.js with no runInTab
        // (and every 'web' / 'term' row) just runs.
        var inTab = !withShift && row.app.kind === 'app' &&
          typeof row.app.runInTab === 'function';
        if (inTab) row.app.runInTab();
        else if (typeof row.app.run === 'function') row.app.run();
      } catch (err) { /* a dead launcher must not wedge the bar */ }
      restoreBar();
      return;
    }

    // A tab row switches; a folder row opens the Files tab. If either one
    // cannot act, the lens stays open and says so on its state line rather
    // than closing on nothing.
    if (row.kind === 'tab' || row.kind === 'folder') {
      var done = row.kind === 'tab' ? switchToTab(row.tabId) : openFolder(row.path);
      if (!done) {
        actionNote = row.kind === 'tab'
          ? 'Could not switch: that tab is no longer open'
          : 'Could not open the Files tab for ' + row.path;
        render();
        actionNote = '';
        if (!rows.length) { close(); return; }
        place();
        paintHighlight();
        return;
      }
      close();
      restoreBar();
      return;
    }

    var url = row.url;
    close();
    omniboxEl.value = url;
    typedValue = url;
    omniboxEl.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true
    }));
  }

  function onInput() {
    typedValue = String(omniboxEl.value || '');
    if (inputTimer !== null) clearTimeout(inputTimer);
    inputTimer = setTimeout(function () {
      inputTimer = null;
      open();
    }, INPUT_DELAY);
  }

  /**
   * Capture phase, so a highlighted row can rewrite the omnibox BEFORE
   * app.js's own Enter handler reads the value. The event is left alone
   * from there: app.js does the navigating, exactly as if it were typed.
   */
  function onKeydown(event) {
    if (!panel) return;
    var key = event.key;

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      if (!openState) {
        typedValue = String(omniboxEl.value || '');
        open();
        if (!openState) return;
        if (key === 'ArrowDown') return; // the panel itself is the first step
      }
      step(key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (key === 'Enter') {
      if (!openState) return;
      // App, tab and folder rows are the cases the lens acts on itself.
      // app.js has its own bubble-phase Enter handler on this same element,
      // so the event has to die here or the typed text would navigate too.
      if (hi >= 0 && acts(rows[hi])) {
        event.preventDefault();
        event.stopImmediatePropagation();
        commit(hi, !!event.shiftKey);
        return;
      }
      // A highlighted history / saved / notes row rewrites the bar before
      // app.js reads it. The default row needs nothing: app.js already
      // resolves the typed text (keywords included).
      if (hi >= 0 && navigates(rows[hi])) {
        omniboxEl.value = rows[hi].url;
      }
      close();
      return; // app.js takes it from here
    }

    if (key === 'Escape') {
      if (!openState) return;
      event.preventDefault();
      restoreTyped();
      close();
      return;
    }

    if (key === 'Tab') close();
  }

  function onFocus() {
    if (blurTimer !== null) { clearTimeout(blurTimer); blurTimer = null; }
    typedValue = String(omniboxEl.value || '');
    // Warm the folder list in the background so the first query has it.
    // A no-op while the cached one is younger than FOLDER_TTL.
    refreshFolders(false);
    // A new tab puts the caret here by itself (app.js focusOmniboxForNewTab)
    // and marks that one focus quiet: the recent list would otherwise cover
    // the new-tab page on every Ctrl+T. One-shot, and consumed here even when
    // the event comes late (a focus() in a window that is not in front fires
    // when the window is next activated). Typing or ArrowDown still opens it.
    if (omniboxEl.dataset && omniboxEl.dataset.quietFocus) {
      delete omniboxEl.dataset.quietFocus;
      return;
    }
    open();
  }

  function onBlur() {
    if (blurTimer !== null) clearTimeout(blurTimer);
    blurTimer = setTimeout(function () {
      blurTimer = null;
      close();
    }, BLUR_DELAY);
  }

  function attach() {
    if (panel) return true;
    if (typeof document === 'undefined' || !document.getElementById) return false;
    omniboxEl = document.getElementById('omnibox');
    if (!omniboxEl || !document.body) return false;

    buildPanel();
    watchNotes();   // seed the note-section index once; pushes keep it fresh

    omniboxEl.addEventListener('keydown', onKeydown, true); // capture: before app.js
    omniboxEl.addEventListener('input', onInput);
    omniboxEl.addEventListener('focus', onFocus);
    omniboxEl.addEventListener('blur', onBlur);

    window.addEventListener('resize', function () { if (openState) place(); });
    window.addEventListener('blur', function () { close(); });
    return true;
  }

  /**
   * Ctrl+H and Escape, routed from app.js's keyboard wiring.
   * Returns true when the action was consumed.
   *
   * Ctrl+H opens the full history page now, not the recent dropdown: the
   * dropdown is still exactly what an empty omnibox focus shows, it just
   * is not what the shortcut is for any more.
   */
  function handleShortcut(action) {
    if (action === 'history') return openPage();
    if (action === 'escape') {
      if (!openState) return false;
      restoreTyped();
      close();
      return true;
    }
    return false;
  }

  /* --- boot ----------------------------------------------------- */

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { attach(); }, { once: true });
    } else {
      attach();
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      // The debounce must not outlive the window.
      window.addEventListener('pagehide', function () { writeNow(); });
      window.addEventListener('beforeunload', function () { writeNow(); });
    }
  }

  window.History = {
    record: record,
    updateTitle: updateTitle,
    search: search,
    recent: recent,
    remove: remove,
    clear: clear,
    all: all,
    topSites: topSites,
    subscribe: subscribe,
    handleShortcut: handleShortcut,
    close: close,
    isOpen: function () { return openState; },

    // the history page
    pageUrl: pageUrl,
    isHistoryUrl: isHistoryUrl,
    snapshot: snapshot,
    clearSince: clearSince,
    handleGuestMessage: handleGuestMessage,

    // test seams
    _score: score,
    _words: toWords,
    _ignored: isIgnored,
    _flush: writeNow,
    _load: load,
    _max: MAX_ITEMS,
    // The lens's sources, for probes that force a failure and read the
    // state line back: swap the folder lister (null restores the real
    // one) and refetch, or feed the notes index a School state by hand.
    _lens: {
      folderLister: function (fn) {
        folderListerOverride = typeof fn === 'function' ? fn : null;
        refreshFolders(true);
      },
      adoptSchool: adoptSchool
    }
  };
})();
