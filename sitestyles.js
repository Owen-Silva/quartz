/* ============================================================
   sitestyles.js — per-site CSS, per-site scripts, and a dark mode
   for sites that refuse to have one.

   THE STORE. One JSON object in localStorage['sitestyles']:

     { v: 1,
       globalDark: false,
       hosts: { "example.com": { css: "", dark: false, js: "" }, ... } }

   `js` joined the entry later and the version did not move: a record
   written before it reads back with js: "" rather than as a corrupt
   store, which is exactly what a missing key should mean.

   Host keys are normalised on the way in and on the way out:
   lowercased, no scheme, no userinfo, no `www.`, no port, no path,
   no trailing dot. "https://WWW.Example.com:8443/x" and "example.com"
   are the same key. A missing or corrupt record reads as "nothing
   configured" rather than an error, and writes are debounced (the
   store flushes itself on pagehide, and flush() is exported for the
   settings UI to call before anything destructive).

   An entry is kept even when it is empty — `{ css: "", dark: false }`
   is a host the user deliberately added and expects to still see in
   the list. Removing is remove()'s job, not a side effect of clearing
   a textarea.

   THE APPLIER. Pages are <webview> guests, so everything crosses an
   async boundary that can vanish mid-flight (the guest navigates, the
   tab closes, the element detaches). Every guest call is wrapped and
   every promise has a .catch: a dead guest is a no-op, never a throw
   into the caller. app.js calls applyTo(tab) on each page webview's
   'dom-ready'; this module calls applyAll() itself whenever the store
   changes, so edits in settings are live without a reload.

   THE SCRIPTS. A host entry's `js` is the user's own code, run in the
   page after that host's CSS goes in, once per document (dom-ready is
   per navigation, which is the same thing). It is wrapped in an IIFE
   with a try/catch that reports a throw to the page's own console as
   `[site script] host: message` — a broken snippet must never take the
   apply chain down with it — and the wrapper returns true so the guest
   never tries to serialise whatever the last expression evaluated to.
   The same guards as the CSS: http(s) only, never the new tab page,
   never a reader page. runScript() is the manual "Run now".

   Each webview's insertCSS() resolves to a key. Keys are tracked per
   tab id so a re-apply can remove exactly what this module inserted
   last time and nothing else. Per-tab work is serialised through a
   promise chain, so two applies racing (dom-ready + a settings edit)
   cannot interleave into orphaned keys.

   DARK. Two ways a page goes dark:
     - the host entry says dark: true — unconditional, and
     - the global toggle — which skips any host whose entry explicitly
       says dark: false (an opt-out), and skips pages that are already
       dark, measured by probing the rendered background luminance in
       the guest. Inverting an already-dark site would turn it white.

   Style: classic script, no modules, ES5-flavoured, no bundler.
   ============================================================ */

(function () {
  'use strict';

  /* --- constants ---------------------------------------------- */

  var STORAGE_KEY = 'sitestyles';
  var STORAGE_VERSION = 1;
  var WRITE_DELAY = 200;      // ms of quiet before the store hits localStorage
  var DARK_LUMA = 0.35;       // relative luminance below this reads as "dark"

  /* Two-part public suffixes worth guarding. A parent-domain walk must
     never land on one of these (or on a bare TLD), or one entry for
     "co.uk" would restyle half the internet. Not a full PSL — just the
     handful a person is plausibly browsing. */
  var TWO_PART_SUFFIXES = ['co.uk', 'com.au', 'co.jp', 'com.br', 'co.nz', 'org.uk'];

  /* The classic invert, scoped so the things that are already the right
     way round (photos, video, canvases) get inverted back. `.no-dark` is
     the escape hatch a custom per-site stylesheet can hang on anything
     the blanket rule ruins. */
  var DARK_CSS = [
    'html { filter: invert(1) hue-rotate(180deg) !important; background: #111 !important; }',
    'img, video, canvas, picture, svg image, iframe, [style*="background-image"], .no-dark { filter: invert(1) hue-rotate(180deg) !important; }',
    'html { color-scheme: dark; }'
  ].join('\n');

  /* Runs inside the guest. Returns the relative luminance of the page's
     background as a number, treating a transparent background as white
     (which is what the compositor paints). Never throws: on anything
     unexpected it claims white, and the caller then treats the page as
     "not already dark". */
  var PROBE_JS =
    '(function(){try{' +
      'function lum(c){' +
        'if(!c||typeof c!=="string")return null;' +
        'var m=c.match(/rgba?\\(([^)]+)\\)/);' +
        'if(!m)return null;' +
        'var p=m[1].split(",").map(function(x){return parseFloat(x);});' +
        'if(p.length<3)return null;' +
        'if(p.length>3&&!(p[3]>0))return null;' +
        'if(!isFinite(p[0])||!isFinite(p[1])||!isFinite(p[2]))return null;' +
        'return (0.2126*p[0]+0.7152*p[1]+0.0722*p[2])/255;' +
      '}' +
      'var v=null;' +
      'if(document.body)v=lum(getComputedStyle(document.body).backgroundColor);' +
      'if(v===null&&document.documentElement)v=lum(getComputedStyle(document.documentElement).backgroundColor);' +
      'return v===null?1:v;' +
    '}catch(e){return 1;}})()';

  /* --- state --------------------------------------------------- */

  var state = null;                 // the stored object, lazily loaded
  var listeners = [];
  var writeTimer = 0;
  var insertedKeys = {};            // tab id -> [key, ...] this module inserted
  var chains = {};                  // tab id -> promise, serialising per-tab work
  var scriptErrors = {};            // host -> last executeJavaScript failure (not persisted)

  /* ============================================================
     Store
     ============================================================ */

  function blank() {
    return { v: STORAGE_VERSION, globalDark: false, hosts: {} };
  }

  /** Coerce anything the disk hands back into the shape above. */
  function sanitize(raw) {
    var out = blank();
    if (!raw || typeof raw !== 'object') return out;
    out.globalDark = raw.globalDark === true;
    var hosts = raw.hosts;
    if (!hosts || typeof hosts !== 'object') return out;
    for (var key in hosts) {
      if (!Object.prototype.hasOwnProperty.call(hosts, key)) continue;
      var host = normalizeHost(key);
      if (!host) continue;
      var entry = hosts[key];
      if (!entry || typeof entry !== 'object') entry = {};
      out.hosts[host] = {
        css: typeof entry.css === 'string' ? entry.css : '',
        dark: entry.dark === true,
        js: typeof entry.js === 'string' ? entry.js : ''
      };
    }
    return out;
  }

  function load() {
    if (state) return state;
    state = blank();
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) state = sanitize(JSON.parse(raw));
    } catch (err) {
      state = blank();          // blocked or corrupt: this run starts empty
    }
    return state;
  }

  function writeNow() {
    if (writeTimer) {
      try { window.clearTimeout(writeTimer); } catch (err) { /* fine */ }
      writeTimer = 0;
    }
    if (!state) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) { /* storage blocked — the values still hold for this run */ }
  }

  function scheduleWrite() {
    if (writeTimer) {
      try { window.clearTimeout(writeTimer); } catch (err) { /* fine */ }
    }
    try {
      writeTimer = window.setTimeout(writeNow, WRITE_DELAY);
    } catch (err) {
      writeTimer = 0;
      writeNow();               // no timers available: take the sync write
    }
  }

  function emit(detail) {
    var payload = detail || {};
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](payload); } catch (err) { /* one bad listener */ }
    }
  }

  /* ============================================================
     Hosts
     ============================================================ */

  /**
   * Lowercase, scheme-less, www-less, port-less host. Accepts a bare
   * host, a host:port, or a whole URL, because the settings UI cannot
   * stop anyone pasting one. Returns '' for anything unusable.
   */
  function normalizeHost(input) {
    if (typeof input !== 'string') return '';
    var s = input.trim().toLowerCase();
    if (!s) return '';
    var scheme = s.indexOf('://');
    if (scheme > -1) s = s.slice(scheme + 3);
    else if (s.indexOf('//') === 0) s = s.slice(2);
    var at = s.lastIndexOf('@');
    if (at > -1) s = s.slice(at + 1);
    s = s.split('/')[0].split('?')[0].split('#')[0];
    if (s.charAt(0) === '[') {            // ipv6 literal, brackets kept
      var close = s.indexOf(']');
      if (close > -1) s = s.slice(0, close + 1);
    } else {
      var colon = s.indexOf(':');
      if (colon > -1) s = s.slice(0, colon);
    }
    s = s.replace(/^www\./, '');
    s = s.replace(/\.+$/, '');            // an FQDN's trailing dot
    if (!s || s === '.') return '';
    return s;
  }

  function isIpLiteral(host) {
    return host.charAt(0) === '[' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  }

  function isTwoPartSuffix(host) {
    for (var i = 0; i < TWO_PART_SUFFIXES.length; i++) {
      if (TWO_PART_SUFFIXES[i] === host) return true;
    }
    return false;
  }

  /**
   * The hosts an entry could be filed under, most specific first:
   * the host itself, then each parent domain. A parent must keep at
   * least two labels and must not be a known two-part suffix, so
   * "com" and "co.uk" are never reachable. IP literals have no
   * parents at all.
   */
  function candidatesFor(host) {
    var out = [];
    if (!host) return out;
    out.push(host);
    if (isIpLiteral(host)) return out;
    var parts = host.split('.');
    for (var i = 1; i < parts.length - 1; i++) {
      var parent = parts.slice(i).join('.');
      if (parent.split('.').length < 2) break;
      if (isTwoPartSuffix(parent)) continue;
      out.push(parent);
    }
    return out;
  }

  /** The host of an http(s) URL, normalised. '' for anything else. */
  function hostFromUrl(url) {
    if (typeof url !== 'string' || !url) return '';
    var lower = url.trim().toLowerCase();
    if (lower.indexOf('http://') !== 0 && lower.indexOf('https://') !== 0) return '';
    try {
      return normalizeHost(new window.URL(url).hostname);
    } catch (err) {
      return normalizeHost(url);
    }
  }

  /* ============================================================
     Public store API
     ============================================================ */

  function hosts() {
    var s = load();
    var out = [];
    for (var host in s.hosts) {
      if (Object.prototype.hasOwnProperty.call(s.hosts, host)) out.push(host);
    }
    out.sort();
    return out;
  }

  function get(host) {
    var key = normalizeHost(host);
    if (!key) return null;
    var entry = load().hosts[key];
    if (!entry) return null;
    return { css: entry.css, dark: entry.dark, js: entry.js || '' };
  }

  /**
   * Create or merge. An absent key in the patch leaves the stored value
   * alone; a new entry starts at { css: '', dark: false, js: '' }. The
   * entry survives being emptied — only remove() deletes.
   */
  function set(host, patch) {
    var key = normalizeHost(host);
    if (!key) return null;
    var s = load();
    var entry = s.hosts[key];
    if (!entry) entry = { css: '', dark: false, js: '' };
    if (typeof entry.js !== 'string') entry.js = '';
    if (patch && typeof patch === 'object') {
      if (typeof patch.css === 'string') entry.css = patch.css;
      if (typeof patch.js === 'string') entry.js = patch.js;
      if (patch.dark !== undefined) entry.dark = patch.dark === true;
    }
    s.hosts[key] = entry;
    scheduleWrite();
    emit({ host: key });
    return { css: entry.css, dark: entry.dark, js: entry.js };
  }

  function remove(host) {
    var key = normalizeHost(host);
    if (!key) return false;
    var s = load();
    if (!Object.prototype.hasOwnProperty.call(s.hosts, key)) return false;
    delete s.hosts[key];
    scheduleWrite();
    emit({ host: key });
    return true;
  }

  function globalDark() {
    return load().globalDark === true;
  }

  function setGlobalDark(on) {
    var next = on === true;
    var s = load();
    if (s.globalDark === next) return next;
    s.globalDark = next;
    scheduleWrite();
    emit({ global: true });
    return next;
  }

  function on(cb) {
    if (typeof cb !== 'function') return function () {};
    listeners.push(cb);
    return function off() {
      var i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /** The most specific stored entry for a URL, or null. */
  function matchFor(url) {
    var host = hostFromUrl(url);
    if (!host) return null;
    var s = load();
    var candidates = candidatesFor(host);
    for (var i = 0; i < candidates.length; i++) {
      var entry = s.hosts[candidates[i]];
      if (entry) {
        return {
          host: candidates[i],
          css: entry.css,
          dark: entry.dark,
          js: entry.js || ''
        };
      }
    }
    return null;
  }

  /* ============================================================
     The guests
     ============================================================ */

  /* app.js owns these; read them defensively so this file can be tested
     (and loaded) without it. `tabs` is a top-level const in app.js, so it
     lives in the global lexical scope rather than on window. */

  function allTabs() {
    try {
      if (window && Array.isArray(window.tabs)) return window.tabs;
    } catch (err) { /* fall through */ }
    try {
      if (typeof tabs !== 'undefined' && Array.isArray(tabs)) return tabs;
    } catch (err) { /* fall through */ }
    return [];
  }

  function usable(tab) {
    try {
      if (typeof window.isViewUsable === 'function') return !!window.isViewUsable(tab);
    } catch (err) { /* fall through */ }
    return !!(tab && tab.kind === 'page' && tab.ready && tab.viewEl && tab.viewEl.isConnected);
  }

  function currentUrl(tab) {
    try {
      if (typeof window.readCurrentUrl === 'function') return window.readCurrentUrl(tab) || '';
    } catch (err) { /* fall through */ }
    try {
      return (tab && tab.viewEl && tab.viewEl.getURL && tab.viewEl.getURL()) || (tab ? tab.url : '') || '';
    } catch (err) {
      return (tab && tab.url) || '';
    }
  }

  function isNewTab(url) {
    try {
      if (typeof window.isNewTabUrl === 'function') return !!window.isNewTabUrl(url);
    } catch (err) { /* fall through */ }
    return false;
  }

  /** Serialise everything done to one tab, so applies cannot interleave. */
  function queue(tabId, work) {
    var prev = chains[tabId] || Promise.resolve();
    var next = prev.then(work, work).then(null, function () { /* swallowed */ });
    chains[tabId] = next;
    next.then(function () {
      if (chains[tabId] === next) delete chains[tabId];
    });
    return next;
  }

  /** Drop every stylesheet this module put into a tab. Never throws. */
  function clearFor(tab) {
    var keys = insertedKeys[tab.id] || [];
    delete insertedKeys[tab.id];
    if (!keys.length) return Promise.resolve();
    var pending = [];
    for (var i = 0; i < keys.length; i++) {
      pending.push(removeOne(tab, keys[i]));
    }
    return Promise.all(pending).then(function () {}, function () {});
  }

  function removeOne(tab, key) {
    try {
      if (!tab.viewEl || typeof tab.viewEl.removeInsertedCSS !== 'function') return Promise.resolve();
      var p = tab.viewEl.removeInsertedCSS(key);
      if (p && typeof p.then === 'function') return p.then(null, function () {});
      return Promise.resolve();
    } catch (err) {
      return Promise.resolve();   // the guest is gone; its CSS went with it
    }
  }

  function insertOne(tab, css) {
    try {
      if (!tab.viewEl || typeof tab.viewEl.insertCSS !== 'function') return Promise.resolve(null);
      var p = tab.viewEl.insertCSS(css);
      if (!p || typeof p.then !== 'function') return Promise.resolve(null);
      return p.then(function (key) {
        if (typeof key !== 'string' || !key) return null;
        if (!insertedKeys[tab.id]) insertedKeys[tab.id] = [];
        insertedKeys[tab.id].push(key);
        return key;
      }, function () { return null; });
    } catch (err) {
      return Promise.resolve(null);
    }
  }

  /* ============================================================
     Scripts
     ============================================================ */

  /**
   * The user's snippet, sealed. An IIFE so declarations stay out of the
   * page's globals, a try/catch so a throw is a console line in the page
   * rather than a rejected promise out here, and a literal `true` at the
   * end so the guest never has to serialise the snippet's last value
   * back across the bridge (a DOM node would reject on the way).
   *
   * The host is baked in as a JSON literal: it is normalised, but a
   * stray quote in one must not be able to end the string.
   */
  function wrapScript(host, code) {
    var label = JSON.stringify('[site script] ' + String(host || '') + ': ');
    return '(function(){try{\n' + code + '\n}catch(err){try{console.error(' + label +
      ' + (err && err.message ? err.message : String(err)));}catch(e2){}}return true;})()';
  }

  function noteScriptError(host, err) {
    var message = '';
    try {
      message = (err && err.message) ? String(err.message) : String(err);
    } catch (e) { message = 'failed'; }
    scriptErrors[host] = message;
  }

  /**
   * The entry whose script should run in this tab right now, or null.
   * Same gate as the CSS: a usable page guest, an http(s) URL that is
   * not the new tab page (and not a reader page — those are not http(s)
   * either), and a stored snippet with something in it.
   */
  function scriptFor(tab) {
    if (!usable(tab)) return null;
    var url = currentUrl(tab);
    if (isNewTab(url) || !hostFromUrl(url)) return null;
    var entry = matchFor(url);
    if (!entry || typeof entry.js !== 'string' || !entry.js.trim()) return null;
    return entry;
  }

  /** Run one entry's snippet in one guest. Resolves true when it ran. */
  function execScript(tab, entry) {
    if (!usable(tab) || !entry) return Promise.resolve(false);
    var view = tab.viewEl;
    if (!view || typeof view.executeJavaScript !== 'function') return Promise.resolve(false);
    var p;
    try {
      p = view.executeJavaScript(wrapScript(entry.host, entry.js));
    } catch (err) {
      noteScriptError(entry.host, err);   // the guest went away mid-call
      return Promise.resolve(false);
    }
    if (!p || typeof p.then !== 'function') {
      delete scriptErrors[entry.host];
      return Promise.resolve(true);
    }
    return p.then(function () {
      delete scriptErrors[entry.host];
      return true;
    }, function (err) {
      noteScriptError(entry.host, err);
      return false;
    });
  }

  /** Part of an apply: whatever the matched entry asks for, if anything. */
  function maybeRunScript(tab, entry) {
    if (!entry || typeof entry.js !== 'string' || !entry.js.trim()) return Promise.resolve(false);
    return execScript(tab, entry);
  }

  /**
   * The manual "Run now": re-run this tab's matching snippet on demand,
   * without touching its stylesheets. Queued like everything else, so it
   * cannot land in the middle of an apply. Resolves false when nothing
   * matched (no guest, wrong URL, no snippet).
   */
  function runScript(tab) {
    if (!tab || tab.id === undefined || tab.id === null) return Promise.resolve(false);
    return queue(tab.id, function () {
      var entry = scriptFor(tab);
      if (!entry) return false;
      return execScript(tab, entry);
    }).then(function (ran) { return ran === true; }, function () { return false; });
  }

  /**
   * The last executeJavaScript failure per host, for a UI that wants to
   * say so. With no argument, a copy of the whole map. Errors thrown by
   * the snippet itself are caught inside the page and land in the page's
   * console instead — these are bridge failures: a dead guest, or a
   * snippet that will not even parse.
   */
  function lastError(host) {
    if (host === undefined) {
      var copy = {};
      for (var key in scriptErrors) {
        if (Object.prototype.hasOwnProperty.call(scriptErrors, key)) copy[key] = scriptErrors[key];
      }
      return copy;
    }
    var h = normalizeHost(host);
    return (h && scriptErrors[h]) || '';
  }

  /**
   * Is the page already dark of its own accord? Only the global toggle
   * asks: a host explicitly set to dark is inverted regardless. A guest
   * that will not answer counts as "not dark" — a light page left light
   * is the louder failure of the two.
   */
  function isPageDark(tab) {
    return new Promise(function (resolve) {
      if (!usable(tab) || !tab.viewEl || typeof tab.viewEl.executeJavaScript !== 'function') {
        resolve(false);
        return;
      }
      var p;
      try {
        p = tab.viewEl.executeJavaScript(PROBE_JS);
      } catch (err) {
        resolve(false);
        return;
      }
      if (!p || typeof p.then !== 'function') {
        resolve(typeof p === 'number' && p < DARK_LUMA);
        return;
      }
      p.then(function (value) {
        var n = typeof value === 'number' ? value : parseFloat(value);
        resolve(isFinite(n) ? n < DARK_LUMA : false);
      }, function () {
        resolve(false);
      });
    });
  }

  /**
   * Bring one tab's guest in line with the store: drop what we inserted
   * last time, then insert the forced-dark sheet (if it is wanted) and
   * the host's own CSS, in that order — the custom sheet wins.
   */
  function applyTo(tab) {
    if (!tab || tab.id === undefined || tab.id === null) return Promise.resolve();
    return queue(tab.id, function () {
      // Not ready (asleep, detached, a Claude tab): leave the tracked keys
      // alone. A tab that is merely between loads still owes us a removal
      // on its next apply; only a closed tab is forgotten, in applyAll().
      if (!usable(tab)) return Promise.resolve();
      var url = currentUrl(tab);
      return clearFor(tab).then(function () {
        if (!usable(tab)) return null;
        if (isNewTab(url) || !hostFromUrl(url)) return null;
        var entry = matchFor(url);
        var wantDark = !!(entry && entry.dark === true);
        var optedOut = !!(entry && entry.dark === false);
        if (!wantDark && globalDark() && !optedOut) {
          return isPageDark(tab).then(function (already) {
            return finish(tab, entry, !already);
          });
        }
        return finish(tab, entry, wantDark);
      }).then(null, function () { /* guest went away mid-apply */ });
    });
  }

  function finish(tab, entry, wantDark) {
    if (!usable(tab)) return null;
    var chain = Promise.resolve();
    if (wantDark) {
      chain = chain.then(function () { return insertOne(tab, DARK_CSS); });
    }
    if (entry && typeof entry.css === 'string' && entry.css.trim()) {
      chain = chain.then(function () { return insertOne(tab, entry.css); });
    }
    // The script goes last: it should see the page as the user's CSS
    // leaves it, and a snippet that throws must not cost the sheets.
    chain = chain.then(function () { return maybeRunScript(tab, entry); });
    return chain.then(function () { return null; }, function () { return null; });
  }

  /** Re-apply to every open page tab, and forget tabs that have closed. */
  function applyAll() {
    var open = allTabs();
    var live = {};
    var pending = [];
    for (var i = 0; i < open.length; i++) {
      var tab = open[i];
      if (!tab || tab.kind !== 'page') continue;
      live[tab.id] = true;
      pending.push(applyTo(tab));
    }
    // Prune only when the tab list actually answered; an empty answer may
    // just mean app.js has not finished loading, and forgetting a key we
    // cannot re-derive would strand a stylesheet in a live guest.
    if (open.length) {
      for (var id in insertedKeys) {
        if (!Object.prototype.hasOwnProperty.call(insertedKeys, id)) continue;
        if (!live[id]) delete insertedKeys[id];
      }
    }
    return Promise.all(pending).then(function () {}, function () {});
  }

  /** app.js may call this when it closes a tab; applyAll() also prunes. */
  function forget(tabId) {
    delete insertedKeys[tabId];
    delete chains[tabId];
  }

  /* ============================================================
     Wiring
     ============================================================ */

  // Our own listener: any change to the store re-styles what is open.
  on(function () {
    try { applyAll(); } catch (err) { /* nothing open, or no tabs yet */ }
  });

  try {
    window.addEventListener('pagehide', writeNow);
    window.addEventListener('beforeunload', writeNow);
  } catch (err) { /* not a document: tests, mostly */ }

  window.SiteStyles = {
    DARK_CSS: DARK_CSS,
    hosts: hosts,
    get: get,
    set: set,
    remove: remove,
    globalDark: globalDark,
    setGlobalDark: setGlobalDark,
    on: on,
    matchFor: matchFor,
    applyTo: applyTo,
    applyAll: applyAll,
    runScript: runScript,
    lastError: lastError,
    isPageDark: isPageDark,
    normalizeHost: normalizeHost,
    hostFromUrl: hostFromUrl,
    forget: forget,
    flush: writeNow
  };
})();
