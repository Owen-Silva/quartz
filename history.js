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
      under the omnibox capsule and mirrors its left/width. With text
      typed it leads with the row that mirrors what Enter already
      does, then any apps whose name the query hits (badged, borrowed
      from tabsearch.js), then the best history matches; on an empty
      focus it shows what was open recently. It never navigates by
      itself: it writes into #omnibox and hands the Enter key to
      app.js, so tab and Claude handling stay in exactly one place.
      An app row is the single exception — it launches the app and
      then puts the bar back to the page that is really on screen.

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
  var MAX_ROWS = 6;          // history rows; the default row makes 7
  var MAX_APP_ROWS = 3;      // app rows, between the default row and history
  var PANEL_GAP = 6;         // px between the omnibox capsule and the panel

  // Segoe Fluent Icons, same set the rest of the chrome draws from.
  var GLYPH_SEARCH = '\uE721';   // magnifier: a Google search
  var GLYPH_GLOBE  = '\uE774';   // globe: a plain address
  var GLYPH_CLOCK  = '\uE81C';   // clock: something already visited
  var GLYPH_APP    = '\uECAA';   // tile: an app, when it has no icon of its own

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
  var rows = [];             // [{ url, kind, app }] parallel to the row elements
  var rowEls = [];
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
    panel.appendChild(capEl);
    panel.appendChild(listEl);
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

    // mousedown is swallowed so the omnibox never blurs; click then still
    // fires on the row and the input keeps its caret and selection.
    row.addEventListener('mousedown', function (event) { event.preventDefault(); });
    row.addEventListener('mouseenter', function () { setHighlight(index, false); });
    row.addEventListener('click', function (event) {
      commit(index, !!(event && event.shiftKey));
    });

    listEl.appendChild(row);
    rowEls.push(row);
    rows.push({ url: spec.url, kind: spec.kind, app: spec.app || null });
  }

  function clearRows() {
    rows = [];
    rowEls = [];
    hi = -1;
    if (listEl) listEl.textContent = '';
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
    if (rendering) return;   // it landed synchronously; this render already has it
    if (!openState || !panel || panel.hidden) return;
    if (typeof document !== 'undefined' && document.activeElement !== omniboxEl) return;
    var prev = hi;
    render();
    if (!rows.length) { close(); return; }
    place();
    hi = (prev >= 0 && prev < rows.length) ? prev : -1;
    paintHighlight();
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
    // changes the meaning of just typing and pressing Enter.
    var target = navUrlFor(query);
    if (target) {
      if (isSearchUrl(target)) {
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

    var words = toWords(query);

    // Then the apps whose name the query hits. These launch instead of
    // navigating, which is why they carry a badge and never the default
    // row's place: row one still means exactly what Enter means.
    var apps = appMatches(query, MAX_APP_ROWS);
    for (var a = 0; a < apps.length && a < MAX_APP_ROWS; a++) {
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
    waitForApps();

    var hits = search(query, MAX_ROWS);
    for (var j = 0; j < hits.length; j++) {
      if (target && hits[j].url === target && rows.length && rows[0].kind === 'default') continue;
      addRow({
        kind: 'history',
        url: hits[j].url,
        glyph: GLYPH_CLOCK,
        primary: hits[j].title || shortLabel(hits[j].url),
        secondary: hits[j].url,
        words: words
      });
    }
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
    // "cats" for a google.com/search URL; an app row has no URL to preview
    // at all. Only history rows preview.
    if (hi >= 0 && rows[hi] && rows[hi].kind === 'history') omniboxEl.value = rows[hi].url;
    else omniboxEl.value = typedValue;
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
      if (omniboxEl) {
        omniboxEl.blur();
        if (typeof syncOmniboxFromActive === 'function') syncOmniboxFromActive(true);
        else omniboxEl.value = typedValue;
      }
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
      // An app row is the one case the lens acts on itself. app.js has its
      // own bubble-phase Enter handler on this same element, so the event
      // has to die here or the typed text would navigate as well.
      if (hi >= 0 && rows[hi] && rows[hi].kind === 'app') {
        event.preventDefault();
        event.stopImmediatePropagation();
        commit(hi, !!event.shiftKey);
        return;
      }
      // A highlighted history row rewrites the bar before app.js reads it.
      // The default row needs nothing: app.js already resolves the typed text.
      if (hi >= 0 && rows[hi] && rows[hi].kind === 'history') {
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
    _max: MAX_ITEMS
  };
})();
