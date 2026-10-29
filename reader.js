'use strict';

/*
 * reader.js — Reader view: the instrument that lifts an article out of a page
 * and re-lays it in the browser's own quiet reading page (reader.html).
 *
 * The renderer runs with contextIsolation ON and nodeIntegration OFF, so this
 * is plain browser script: no require(), no import, no bundler. Loaded after
 * app.js (which owns .navrow, #downloads and #theme) and after shield.js.
 * node_modules/@mozilla/readability/Readability.js is NOT in index.html: it is
 * ~100KB that only extract() ever touches, so loadReadability() injects it on
 * the first open() and it leaves the same global `Readability` behind.
 *
 * This file only ever ADDS to the nav row: #reader goes immediately before
 * #shield when that instrument is present, else before #downloads, else before
 * #theme, else at the end.
 *
 * Contract with app.js (every call site feature-detects, nothing blocks):
 *   getActiveTab() -> { id, kind:'page'|'claude', viewEl, url, ready } | null
 *   createTab(url, { background, afterId }) -> tab
 *   readCurrentUrl(tab), isViewUsable(tab), isNewTabUrl(url), getTheme()
 *   document events: 'tabchange' {id,kind}, 'tabready' {id,url},
 *                    'tabloaded' {id,url}
 * The two tab* events are newer than this file's first draft, so every guest
 * view is ALSO watched directly ('dom-ready' / 'did-stop-loading' on the
 * <webview>). Both paths are idempotent; whichever arrives first wins.
 *
 * Owned ids/classes (nothing else in the app may touch them): #reader and its
 * .glyph. The reading page itself owns everything inside reader.html.
 *
 * TRUST. Everything that comes back out of a guest page is hostile text. The
 * article body is parsed into an inert document here, stripped of scripts,
 * frames, plugin objects, event-handler attributes and script: URLs, and only
 * then handed to the reading page as a JSON string argument.
 */

(function () {
  /* --- Segoe Fluent Icons ------------------------------------- */
  // E736 is "ReadingMode" in Segoe MDL2 Assets and is carried forward by
  // Segoe Fluent Icons, so it renders on both fonts named in --icon-font.
  var GLYPH_READER = '\uE736';

  /** The reading page, resolved next to index.html (same recipe as NEWTAB_URL). */
  var READER_URL = new URL('reader.html', window.location.href).href;

  /* --- state ---------------------------------------------------- */

  /** tabId -> { url, ok }: the last probe result, so a tab switch paints now. */
  var probes = new Map();

  /** tabId -> article: parsed articles waiting for their reader tab to be ready. */
  var pending = new Map();

  /**
   * tabId -> tab, for every tab this file has held in its hand: the reading
   * tabs it opened, and whichever tab was active last. app.js keeps its tab
   * list in a top-level `const`, which is a global LEXICAL binding and so is
   * not a property of window — readable from here by name, but only while
   * app.js is loaded ahead of this file. This map is what the code falls back
   * to if that ever stops being true.
   */
  var known = new Map();

  var buttonEl = null;

  /* ============================================================
     Pure helpers (exported on window.Reader._helpers for tests)
     ============================================================ */

  /**
   * The readability probe, run inside the guest page. Two ways to pass:
   *   (a) the <p> elements carry more than 1200 characters between them AND at
   *       least three of them carry more than 100 characters each, or
   *   (b) there is an <article> element holding more than 800 characters.
   * Anything that throws is "no": a page that will not answer is not readable.
   */
  var PROBE_SOURCE = [
    '(function () {',
    '  try {',
    '    var ps = document.querySelectorAll("p");',
    '    var total = 0, big = 0, i, t;',
    '    for (i = 0; i < ps.length; i++) {',
    '      t = (ps[i].textContent || "").trim();',
    '      total += t.length;',
    '      if (t.length > 100) big++;',
    '    }',
    '    if (total > 1200 && big >= 3) return true;',
    '    var a = document.querySelector("article");',
    '    if (a && (a.textContent || "").trim().length > 800) return true;',
    '    return false;',
    '  } catch (err) { return false; }',
    '})()'
  ].join('\n');

  /** Read the whole page back out of a guest, as JSON so nothing but text crosses. */
  var CAPTURE_SOURCE =
    'JSON.stringify({ html: document.documentElement.outerHTML, url: location.href })';

  /** Elements that have no business in a reading page, whatever Readability kept. */
  var UNSAFE_TAGS = [
    'script', 'iframe', 'object', 'embed', 'noscript',
    'style', 'link', 'meta', 'base', 'frame', 'frameset'
  ];

  /** True for a url that runs code when a link is followed or a source loads. */
  function isUnsafeUrl(value) {
    var v = String(value === null || value === undefined ? '' : value);
    // Strip the characters a browser ignores before the scheme, then test it.
    v = v.replace(/[\u0000-\u0020]/g, '').toLowerCase();
    return v.indexOf('javascript:') === 0 ||
           v.indexOf('vbscript:') === 0 ||
           v.indexOf('data:text/html') === 0;
  }

  /** Attributes whose value is a url we have to vet. */
  var URL_ATTRS = ['href', 'src', 'srcset', 'action', 'formaction', 'xlink:href', 'poster', 'data'];

  /**
   * Scrub a parsed subtree in place: drop every unsafe element, every on*
   * handler attribute and every url attribute that would run code.
   * Takes any node with querySelectorAll — a Document, an Element, or the
   * hand-written stub the tests drive it with.
   */
  function stripUnsafe(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return root;

    var i, j, el;

    var doomed = root.querySelectorAll(UNSAFE_TAGS.join(','));
    for (i = 0; i < doomed.length; i++) {
      el = doomed[i];
      if (el && typeof el.remove === 'function') el.remove();
      else if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    var all = root.querySelectorAll('*');
    for (i = 0; i < all.length; i++) {
      el = all[i];
      if (!el || !el.attributes) continue;

      // Copy the names first: removing an attribute mutates the live map.
      var names = [];
      for (j = 0; j < el.attributes.length; j++) names.push(el.attributes[j].name);

      for (j = 0; j < names.length; j++) {
        var name = String(names[j]);
        var lower = name.toLowerCase();
        if (lower.indexOf('on') === 0) { el.removeAttribute(name); continue; }
        if (URL_ATTRS.indexOf(lower) >= 0 && isUnsafeUrl(el.getAttribute(name))) {
          el.removeAttribute(name);
        }
      }
    }
    return root;
  }

  /** Parse an article body, scrub it, and hand back the html that survived. */
  function sanitizeHtml(html) {
    var text = String(html === null || html === undefined ? '' : html);
    var doc;
    try {
      doc = new DOMParser().parseFromString('<!doctype html><body>' + text, 'text/html');
    } catch (err) {
      return '';
    }
    if (!doc || !doc.body) return '';
    stripUnsafe(doc.body);
    return doc.body.innerHTML;
  }

  /** True for the bundled reading page, query string and hash included. */
  function isReaderUrl(url) {
    return typeof url === 'string' && url.indexOf(READER_URL) === 0;
  }

  /** The reading page's url for one source page: theme for the first paint, src for "Back". */
  function readerUrlFor(sourceUrl, theme) {
    return READER_URL +
      '?theme=' + (theme === 'light' ? 'light' : 'dark') +
      '&src=' + encodeURIComponent(String(sourceUrl || ''));
  }

  /** Only real web pages are worth probing: no new tab, no local files, no reader tabs. */
  function isProbeableUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    if (isReaderUrl(url)) return false;
    if (typeof window.isNewTabUrl === 'function' && window.isNewTabUrl(url)) return false;
    var parsed = null;
    try { parsed = new URL(url); } catch (err) { return false; }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  }

  /* ============================================================
     app.js, reached defensively
     ============================================================ */

  function activeTab() {
    if (typeof window.getActiveTab !== 'function') return null;
    try { return window.getActiveTab(); } catch (err) { return null; }
  }

  function usable(tab) {
    if (typeof window.isViewUsable === 'function') {
      try { return !!window.isViewUsable(tab); } catch (err) { return false; }
    }
    return !!(tab && tab.kind === 'page' && tab.ready && tab.viewEl && tab.viewEl.isConnected);
  }

  function urlOf(tab) {
    if (!tab) return '';
    if (typeof window.readCurrentUrl === 'function') {
      try { return window.readCurrentUrl(tab) || ''; } catch (err) { /* fall through */ }
    }
    return tab.url || '';
  }

  function themeNow() {
    if (typeof window.getTheme === 'function') {
      try { return window.getTheme(); } catch (err) { /* fall through */ }
    }
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  /**
   * app.js's tab list. It is a top-level `const` there, which lives in the
   * global lexical environment every classic script on this page shares — so
   * it is reachable by name but never as window.tabs. Anything that cannot
   * reach it falls back to the tabs this file is already holding.
   */
  function allTabs() {
    try {
      /* global tabs */
      if (typeof tabs !== 'undefined' && tabs && typeof tabs.length === 'number') return tabs;
    } catch (err) { /* not in scope: fall through */ }
    var w = window.tabs;
    return w && typeof w.length === 'number' ? w : null;
  }

  function tabById(id) {
    var all = allTabs();
    if (all) {
      for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === id) return all[i];
      return null;
    }
    var held = known.get(id);
    return held && held.viewEl && held.viewEl.isConnected ? held : null;
  }

  /** Remember a tab, so nothing here depends on reaching app.js's list later. */
  function remember(tab) {
    if (tab && tab.kind === 'page') known.set(tab.id, tab);
  }

  function toast(message) {
    var t = window.Toast;
    if (t && typeof t.show === 'function') {
      try { t.show(message); } catch (err) { /* a missing toast is not a failure */ }
    }
  }

  /** executeJavaScript() as a promise that never rejects into the console. */
  function runInGuest(tab, source) {
    if (!usable(tab)) return Promise.resolve(null);
    try {
      var out = tab.viewEl.executeJavaScript(source);
      if (!out || typeof out.then !== 'function') return Promise.resolve(out);
      return out.then(function (v) { return v; }, function () { return null; });
    } catch (err) {
      return Promise.resolve(null);
    }
  }

  /* ============================================================
     Probing
     ============================================================ */

  /** Forget every probe for tabs that no longer exist. */
  function prune() {
    var all = allTabs();
    if (!all) return;
    var live = new Set();
    for (var i = 0; i < all.length; i++) if (all[i]) live.add(all[i].id);
    probes.forEach(function (_entry, id) { if (!live.has(id)) probes.delete(id); });
    pending.forEach(function (_article, id) { if (!live.has(id)) pending.delete(id); });
    known.forEach(function (_tab, id) { if (!live.has(id)) known.delete(id); });
  }

  /** The cached answer for a tab, or null when there is none for this url. */
  function cached(tab) {
    if (!tab) return null;
    var entry = probes.get(tab.id);
    if (!entry) return null;
    return entry.url === urlOf(tab) ? entry : null;
  }

  /** Probe a tab (cached per tab id + url). Always resolves; never throws. */
  function canRead(tab) {
    if (!usable(tab)) return Promise.resolve(false);
    var url = urlOf(tab);
    if (!isProbeableUrl(url)) return Promise.resolve(false);

    var hit = cached(tab);
    if (hit) return Promise.resolve(hit.ok);

    return runInGuest(tab, PROBE_SOURCE).then(function (value) {
      var ok = value === true;
      probes.set(tab.id, { url: url, ok: ok });
      return ok;
    });
  }

  /** True when this tab is showing the reading page. */
  function isReaderTab(tab) {
    return !!(tab && tab.kind === 'page' && isReaderUrl(urlOf(tab) || tab.url));
  }

  /* ============================================================
     DOM
     ============================================================ */

  function showButton(on) {
    if (!buttonEl) return;
    buttonEl.hidden = !on;
  }

  /** Repaint the instrument for the active tab: cache now, probe after. */
  function refresh() {
    prune();
    var tab = activeTab();
    var id = tab ? tab.id : null;

    var hit = cached(tab);
    showButton(!!(hit && hit.ok));

    canRead(tab).then(function (ok) {
      var now = activeTab();
      if (!now || now.id !== id) return;   // the user moved on mid-probe
      showButton(ok);
    });
  }

  /** The nav-row instrument: same recipe as #shield, one slot to its left. */
  function injectButton() {
    if (document.getElementById('reader')) {
      buttonEl = document.getElementById('reader');
      return;
    }
    var navrow = document.querySelector('.navrow');
    if (!navrow) return;

    buttonEl = document.createElement('button');
    buttonEl.id = 'reader';
    buttonEl.className = 'glass iconbtn no-drag';
    buttonEl.type = 'button';
    buttonEl.title = 'Reader view';
    buttonEl.setAttribute('aria-label', 'Reader view');
    buttonEl.hidden = true;              // shown only once a probe passes

    var glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = GLYPH_READER;
    buttonEl.appendChild(glyph);

    buttonEl.addEventListener('click', function () { open(); });

    // Left of the Lumen button when there is one, so Lumen stays directly left of the shield.
    var lumen = document.getElementById('lumen');
    var shield = document.getElementById('shield');
    var downloads = document.getElementById('downloads');
    var theme = document.getElementById('theme');
    if (lumen && lumen.parentNode === navrow) navrow.insertBefore(buttonEl, lumen);
    else if (shield && shield.parentNode === navrow) navrow.insertBefore(buttonEl, shield);
    else if (downloads && downloads.parentNode === navrow) navrow.insertBefore(buttonEl, downloads);
    else if (theme && theme.parentNode === navrow) navrow.insertBefore(buttonEl, theme);
    else navrow.appendChild(buttonEl);
  }

  /* ============================================================
     The parser, on demand
     ============================================================ */

  /*
   * Readability is the single biggest file the chrome used to load at boot,
   * and nothing outside extract() can use it — the probe that decides whether
   * the button lights runs in the guest page, not here. So it is fetched the
   * first time a reading page is actually opened, in parallel with the capture
   * that open() is already waiting on, and every later open reuses the same
   * promise. A load that fails resolves false and lands on the same
   * "Reader view is unavailable" path a missing global always took.
   */
  var READABILITY_SRC = 'node_modules/@mozilla/readability/Readability.js';
  var readabilityPending = null;

  function loadReadability() {
    if (typeof Readability === 'function') return Promise.resolve(true);
    if (readabilityPending) return readabilityPending;

    readabilityPending = new Promise(function (resolve) {
      var el = null;
      try {
        el = document.createElement('script');
      } catch (err) {
        resolve(false);
        return;
      }
      el.src = READABILITY_SRC;
      el.async = false;
      el.addEventListener('load', function () {
        resolve(typeof Readability === 'function');
      });
      el.addEventListener('error', function () {
        readabilityPending = null;   // a later try may still find the file
        resolve(false);
      });
      try {
        (document.head || document.documentElement).appendChild(el);
      } catch (err) {
        readabilityPending = null;
        resolve(false);
      }
    });
    return readabilityPending;
  }

  /* ============================================================
     Opening
     ============================================================ */

  /**
   * Run Readability over `html` (a whole page) and hand back its raw article,
   * or null when there is nothing in it. extract() below shapes it into the
   * sanitised HTML the reading page wants.
   */
  function parseArticle(html, url) {
    if (typeof Readability !== 'function') return null;

    var doc;
    try {
      doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    } catch (err) {
      return null;
    }
    if (!doc || !doc.documentElement) return null;

    // Relative urls in the article resolve against the page they came from,
    // not against the chrome's file:// address. Not with a <base>: a document
    // parsed here lives under the chrome's policy, whose base-uri 'none'
    // refuses one, and the images then pointed at file:///, which reader.html
    // refuses in turn (csp-e2e). Readability reads doc.baseURI in one place
    // only (_fixRelativeUris), so the page's address is handed to it there.
    try {
      Object.defineProperty(doc, 'baseURI', { value: new URL(String(url || '')).href });
    } catch (err) { /* not an absolute url: links stay as the page wrote them */ }

    try {
      return new Readability(doc).parse();
    } catch (err) {
      return null;
    }
  }

  /**
   * Lift the article out of `html` (a whole page) and return the payload the
   * reading page takes, or null when there is no article in it.
   */
  function extract(html, url) {
    var article = parseArticle(html, url);
    if (!article || !article.content) return null;

    return {
      title: article.title || '',
      byline: article.byline || '',
      siteName: article.siteName || '',
      content: sanitizeHtml(article.content),
      url: String(url || ''),
      length: typeof article.length === 'number' ? article.length : 0
    };
  }

  /** Hand a parsed article to its reading page. Idempotent: it only fires once. */
  function deliver(tab) {
    if (!tab) return;
    var article = pending.get(tab.id);
    if (!article) return;
    if (!usable(tab)) return;
    pending.delete(tab.id);
    runInGuest(tab, 'window.__applyArticle && window.__applyArticle(' +
      JSON.stringify(article) + ')');
  }

  /** Push the chrome's theme into one open reading page. */
  function pushTheme(tab, theme) {
    if (!isReaderTab(tab) || !usable(tab)) return;
    runInGuest(tab, "document.documentElement.setAttribute('data-theme','" +
      (theme === 'light' ? 'light' : 'dark') + "')");
  }

  /**
   * Watch one guest directly. app.js dispatches 'tabready'/'tabloaded' for the
   * same moments; both routes end in the same idempotent handlers, so a tab
   * watched twice behaves exactly like a tab watched once.
   */
  function watchView(tab) {
    if (!tab || tab.kind !== 'page' || !tab.viewEl) return;
    remember(tab);
    if (tab.viewEl.__readerWatched) return;
    tab.viewEl.__readerWatched = true;

    tab.viewEl.addEventListener('dom-ready', function () { onReady(tab.id); });
    tab.viewEl.addEventListener('did-stop-loading', function () { onLoaded(tab.id); });
  }

  /** Open the active page in the reading page, in a new tab right after it. */
  function open() {
    var tab = activeTab();
    if (!usable(tab) || !isProbeableUrl(urlOf(tab))) {
      toast('Nothing to read here');
      return;
    }
    if (typeof window.createTab !== 'function') {
      toast('Reader view is unavailable');
      return;
    }

    var sourceId = tab.id;

    // The parser and the page capture do not depend on each other, so the
    // first open pays for whichever of the two is slower, not for both.
    Promise.all([loadReadability(), runInGuest(tab, CAPTURE_SOURCE)]).then(function (both) {
      if (!both[0]) { toast('Reader view is unavailable'); return; }
      var json = both[1];
      var payload = null;
      try { payload = JSON.parse(String(json || '')); } catch (err) { payload = null; }
      if (!payload || !payload.html) { toast('Nothing to read here'); return; }

      var article = extract(payload.html, payload.url || urlOf(tab));
      if (!article) { toast('Nothing to read here'); return; }

      var newTab = null;
      try {
        newTab = window.createTab(readerUrlFor(article.url, themeNow()), { afterId: sourceId });
      } catch (err) {
        newTab = null;
      }
      if (!newTab) { toast('Reader view is unavailable'); return; }

      pending.set(newTab.id, article);
      watchView(newTab);
      // A webview that was already dom-ready by the time we got here (it can
      // happen on a warm file:// load) never fires the event we just wired.
      if (usable(newTab)) deliver(newTab);
    });
  }

  /* ============================================================
     Events
     ============================================================ */

  function onReady(id) {
    probes.delete(id);                       // the document underneath changed
    var tab = tabById(id);
    if (!tab) return;
    deliver(tab);
    pushTheme(tab, themeNow());
    var act = activeTab();
    if (act && act.id === id) refresh();
  }

  function onLoaded(id) {
    var act = activeTab();
    if (act && act.id === id) refresh();
  }

  function handleShortcut(action) {
    if (action === 'reader') {
      var tab = activeTab();
      canRead(tab).then(function (ok) {
        if (ok) open();
        else toast('Nothing to read here');
      });
      return true;
    }
    return false;
  }

  function wire() {
    document.addEventListener('tabchange', function () {
      var tab = activeTab();
      if (tab) watchView(tab);
      refresh();
    });

    document.addEventListener('tabready', function (event) {
      var id = event && event.detail ? event.detail.id : null;
      if (id === null || id === undefined) return;
      onReady(id);
    });

    document.addEventListener('tabloaded', function (event) {
      var id = event && event.detail ? event.detail.id : null;
      if (id === null || id === undefined) return;
      onLoaded(id);
    });

    // app.js pushes the theme into new-tab guests only, so the reading pages
    // are this file's to keep in step. The attribute is the source of truth.
    var observer = new MutationObserver(function () {
      var theme = themeNow();
      var all = allTabs();
      if (all) {
        for (var i = 0; i < all.length; i++) pushTheme(all[i], theme);
        return;
      }
      known.forEach(function (tab) { pushTheme(tab, theme); });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  function boot() {
    injectButton();
    wire();
    var tab = activeTab();
    if (tab) watchView(tab);
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.Reader = {
    open: open,
    canRead: canRead,
    isReaderTab: isReaderTab,
    handleShortcut: handleShortcut,
    refresh: refresh,
    // Pure helpers, reachable so they can be exercised without a window.
    _helpers: {
      stripUnsafe: stripUnsafe,
      sanitizeHtml: sanitizeHtml,
      isUnsafeUrl: isUnsafeUrl,
      isReaderUrl: isReaderUrl,
      isProbeableUrl: isProbeableUrl,
      readerUrlFor: readerUrlFor,
      extract: extract,
      PROBE_SOURCE: PROBE_SOURCE,
      UNSAFE_TAGS: UNSAFE_TAGS
    }
  };
})();
