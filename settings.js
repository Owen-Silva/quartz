'use strict';

/*
 * settings.js — the settings instrument: a nav-row gear beside the theme
 * toggle, and a glass popover holding everything the browser lets you change.
 *
 * The renderer runs with contextIsolation ON and nodeIntegration OFF, so this
 * is plain browser script: no require(), no import, no bundler. Loaded after
 * app.js (whose top-level function declarations — setTheme, getActiveTab,
 * readCurrentUrl — are therefore global by the time anything here runs).
 *
 * WHAT IS PERSISTED. One JSON object in localStorage['settings']:
 *
 *   { searchEngine: 'google'|'duckduckgo'|'bing'|'brave'|'startpage',
 *     siteTheme:    'system'|'light'|'dark',
 *     palette:      'aurora'|'ember'|'forest'|'ocean'|'midnight'|'mono',
 *     accentHue:    null | 0..360,
 *     chips:        null | [{ label, url }, ...],
 *     homepage:     'newtab',
 *     claudeDir:    null | absolute path,   // null means the home folder
 *     claudeResume: true | false,           // --continue on a restored tab
 *     tabSleepMinutes: 0|15|30|60|180,      // 0 = never sleep a background tab
 *     newtabBackground: { kind: 'board'|'aurora'|'image',
 *                         boardOverImage: bool, dim: 0..0.6, rev } }
 *
 * THE NEW TAB'S PICTURE IS NOT IN THERE. kind 'image' needs a photo, and a
 * 2560px JPEG as base64 is about a megabyte of string that localStorage would
 * rewrite on every unrelated write. The blob lives in IndexedDB instead —
 * db 'browser', store 'assets', key 'newtab-bg' — and Settings.background()
 * hands app.js the pair as { kind, boardOverImage, dim, dataUrl? }. `rev` is
 * a stamp, so replacing the picture still counts as a change worth pushing.
 *
 * THE PALETTE IS MIRRORED. `palette` also lives under its own localStorage
 * key ('palette', absent for the default aurora) because theme-boot.js has to
 * stamp <html data-palette> before the first paint, long before this file
 * parses. applyPalette() writes both, so the two never drift.
 *
 * Per-site CSS is NOT stored here: it belongs to window.SiteStyles, which
 * keeps its own localStorage key and pushes changes into open tabs itself.
 * This panel only draws it, and only when that module is present.
 *
 * Missing keys fall back to DEFAULTS, so an older stored object still reads.
 * `chips: null` means "never touched" — the new tab page shows its own list
 * until the first edit, which seeds from window.DEFAULT_CHIPS.
 *
 * Owned ids/classes (nothing else in the app may touch them):
 *   #settings (the nav button), #settings-panel (the popover, a direct child
 *   of <body> so it stacks over #views), #settings-toast, and every .set-*
 *   class inside them.
 *
 * MOTION. The chrome sits on a backdrop-filter, so every animated frame
 * re-blurs the pane behind it. Nothing here animates continuously: the toast
 * steps in and out in four frames and then holds still.
 */

(function () {
  /* --- Segoe Fluent Icons ------------------------------------- */
  var GLYPH_GEAR = '\uE713';
  var GLYPH_ADD = '\uE710';
  var GLYPH_DELETE = '\uE74D';
  var GLYPH_UP = '\uE70E';
  var GLYPH_DOWN = '\uE70D';
  var GLYPH_CLOSE = '\uE711';
  var GLYPH_CHECK = '\uE73E';

  var STORAGE_KEY = 'settings';
  /* theme-boot.js reads this one, before anything else runs. */
  var PALETTE_KEY = 'palette';

  var DEFAULTS = {
    searchEngine: 'google',
    siteTheme: 'system',
    palette: 'aurora',
    accentHue: null,
    chips: null,
    /* The bookmarks bar under the nav row: the chips below, on every page.
       bookmarks.js owns the bar; this is the only place its visibility lives. */
    bookmarksBar: false,
    homepage: 'newtab',
    claudeDir: null,
    claudeResume: true,
    tabSleepMinutes: 30,
    /* What the new tab paints behind the search field:
         { kind: 'board' }                          the circuit board
         { kind: 'aurora' }                         the aurora alone
         { kind: 'image', boardOverImage, dim }     the user's own picture
       The picture itself is NOT in here — see the asset store below. */
    newtabBackground: { kind: 'board' }
  };

  /* The three backgrounds, as the select offers them. */
  var NEWTAB_BACKGROUNDS = [
    { value: 'board', name: 'Circuit board' },
    { value: 'aurora', name: 'Aurora only' },
    { value: 'image', name: 'Your image' }
  ];

  /* The picture: never bigger than this on its long edge, always re-encoded
     as a JPEG, and always behind this much black so the capsule stays legible. */
  var BG_MAX_EDGE = 2560;
  var BG_JPEG_QUALITY = 0.86;
  var BG_DIM_DEFAULT = 0.25;
  var BG_DIM_MAX = 0.6;
  var BG_REJECT = 'Pick a JPG, PNG or WebP';

  /* IndexedDB, in this renderer: db 'browser', store 'assets', one key. */
  var ASSET_DB = 'browser';
  var ASSET_STORE = 'assets';
  var BG_ASSET_KEY = 'newtab-bg';

  var ENGINES = [
    { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
    { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
    { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
    { id: 'brave', name: 'Brave', url: 'https://search.brave.com/search?q=' },
    { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/do/search?q=' }
  ];

  /* The palettes chrome.css authors. 'aurora' is the file's own :root, so it
     is the one id that must never reach the attribute — the swatch for it
     carries no data-palette either, and so previews the root's tokens. */
  var PALETTES = [
    { id: 'aurora', name: 'Aurora' },
    { id: 'ember', name: 'Ember' },
    { id: 'forest', name: 'Forest' },
    { id: 'ocean', name: 'Ocean' },
    { id: 'midnight', name: 'Midnight' },
    { id: 'mono', name: 'Mono' }
  ];

  var SITE_THEMES = [
    { id: 'system', name: 'Follow Windows' },
    { id: 'light', name: 'Always light' },
    { id: 'dark', name: 'Always dark' }
  ];

  /* How long a background tab may sit untouched before app.js puts it to
     sleep. Values are minutes; 0 is the off switch, not a zero timer. */
  var SLEEP_TIMES = [
    { value: 0, name: 'Never' },
    { value: 15, name: '15 minutes' },
    { value: 30, name: '30 minutes' },
    { value: 60, name: '1 hour' },
    { value: 180, name: '3 hours' }
  ];

  /* The keyboard map, as the user would describe it to themselves. */
  var SHORTCUTS = [
    ['Ctrl+T', 'New tab'],
    ['Ctrl+W', 'Close tab'],
    ['Ctrl+Shift+T', 'Reopen the last tab'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next tab, previous tab'],
    ['Ctrl+1-9', 'Jump to a tab'],
    ['Ctrl+L', 'Address bar'],
    ['Ctrl+F', 'Find on page'],
    ['Ctrl+Shift+R', 'Reader view'],
    ['Ctrl+Shift+A', 'Search tabs'],
    ['Ctrl+\\', 'Split view with the next tab'],
    ['Ctrl+P', 'Print page'],
    ['Ctrl+J', 'Downloads'],
    ['Ctrl+H', 'History'],
    ['Ctrl+D', 'Add this page to your new tab'],
    ['Ctrl+Shift+B', 'Bookmarks bar'],
    ['Ctrl+,', 'Settings'],
    ['Ctrl+`', 'Claude tab'],
    ['Ctrl+Shift+`', 'Claude tab in a chosen folder'],
    ['Ctrl+= / Ctrl+- / Ctrl+0', 'Zoom in, out, reset'],
    ['F5', 'Reload'],
    ['F11', 'Fullscreen'],
    ['F12', 'Developer tools'],
    ['Alt+Left / Alt+Right', 'Back, forward']
  ];

  /* The accent formula, shared verbatim with the new tab page:
     dark  -> hsl(H 100% 75%)   light -> hsl(H 90% 44%)
     and the derived tokens are the same hue at these alphas. */
  var ACCENT_TOKENS = [
    ['--ion', null],
    ['--ion-soft', 0.16],
    ['--ion-glow', 0.45],
    ['--ion-line', 0.75],
    ['--ion-select', 0.25],      /* .2 in light — patched below */
    ['--seam-color', 0.45],
    ['--chamber-seam', 0.5]
  ];

  /* --- state ---------------------------------------------------- */
  var state = null;            // the stored object, defaults NOT merged
  var listeners = [];
  var panelEl = null;
  var buttonEl = null;
  var bodyEl = null;
  var open_ = false;
  var toastEl = null;
  var toastTimer = 0;
  var toastHideTimer = 0;
  var focusHint = null;        // [selector] to refocus after a chips re-render
  var siteOpen = null;         // the host whose CSS editor is expanded
  var siteFocus = null;        // [selector] to focus after a site-styles render
  var siteBound = false;       // subscribed to SiteStyles.on exactly once

  /* ============================================================
     Store
     ============================================================ */

  function load() {
    if (state) return state;
    state = {};
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') state = parsed;
      }
    } catch (err) { /* blocked or corrupt: this run runs on defaults */ }
    return state;
  }

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) { /* storage blocked — the values still hold for this run */ }
  }

  function all() {
    var s = load();
    var out = {};
    for (var k in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) continue;
      out[k] = Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined
        ? s[k] : DEFAULTS[k];
    }
    return out;
  }

  function get(key) {
    return all()[key];
  }

  function emit(keys) {
    var snapshot = all();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](snapshot, keys); } catch (err) { /* one bad listener */ }
    }
  }

  function set(patch) {
    if (!patch || typeof patch !== 'object') return all();
    var s = load();
    var changed = [];
    for (var k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      var next = patch[k];
      if (JSON.stringify(s[k]) === JSON.stringify(next)) continue;
      s[k] = next;
      changed.push(k);
    }
    if (!changed.length) return all();
    save();
    react(changed);
    emit(changed);
    return all();
  }

  function reset() {
    state = {};
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (err) { /* fine */ }
    var keys = Object.keys(DEFAULTS);
    react(keys);
    emit(keys);
  }

  function on(cb) {
    if (typeof cb !== 'function') return function () {};
    listeners.push(cb);
    return function off() {
      var i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /** Side effects a changed key owes the rest of the app. */
  function react(keys) {
    if (keys.indexOf('palette') >= 0) applyPalette(get('palette'));
    if (keys.indexOf('accentHue') >= 0) applyAccent(get('accentHue'));
    if (keys.indexOf('siteTheme') >= 0) pushSiteTheme(get('siteTheme'));
  }

  /* ============================================================
     New tab background

     The choice lives in the settings JSON; the picture does not. A 2560px
     JPEG as base64 is around a megabyte of string, and localStorage would
     have to rewrite all of it on every unrelated settings write — so the
     blob goes in IndexedDB and only the tiny descriptor is stored here.

     app.js reads the pair back through Settings.background(), which hands
     over { kind, boardOverImage, dim, dataUrl? } for the new tab guest.
     ============================================================ */

  /** Anything stored (or pushed) read as a complete, in-range descriptor. */
  function normalizeBackground(value) {
    var v = value && typeof value === 'object' ? value : {};
    var kind = 'board';
    for (var i = 0; i < NEWTAB_BACKGROUNDS.length; i++) {
      if (NEWTAB_BACKGROUNDS[i].value === v.kind) kind = v.kind;
    }
    var dim = (v.dim === null || v.dim === undefined || v.dim === '')
      ? BG_DIM_DEFAULT : Number(v.dim);
    if (!isFinite(dim)) dim = BG_DIM_DEFAULT;
    dim = Math.min(BG_DIM_MAX, Math.max(0, dim));
    return { kind: kind, boardOverImage: v.boardOverImage === true, dim: dim };
  }

  /**
   * Write part of the descriptor back.
   *
   * Every write carries a fresh `rev`. The picture is not in this object, so
   * replacing or removing it would otherwise leave the JSON byte-identical
   * and set() — which skips unchanged keys — would never tell app.js to push
   * the new one. The stamp makes every change a change.
   */
  function setBackground(patch) {
    var next = normalizeBackground(get('newtabBackground'));
    if (patch && typeof patch === 'object') {
      if (patch.kind !== undefined) next.kind = normalizeBackground({ kind: patch.kind }).kind;
      if (patch.boardOverImage !== undefined) next.boardOverImage = patch.boardOverImage === true;
      if (patch.dim !== undefined) next.dim = normalizeBackground({ dim: patch.dim }).dim;
    }
    var prev = get('newtabBackground');
    var stamp = Date.now();
    if (prev && typeof prev === 'object' && prev.rev >= stamp) stamp = prev.rev + 1;
    next.rev = stamp;
    set({ newtabBackground: next });
    return next;
  }

  /* --- the asset store ------------------------------------------
     Opened without a version first, so a store some later feature added to
     the same db is never clobbered: only a missing 'assets' upgrades, and
     only to version + 1. Every call closes the connection it opened, so a
     later upgrade is never blocked by this one. */

  function assetOpen() {
    return new Promise(function (resolve, reject) {
      var idb = window.indexedDB;
      if (!idb) { reject(new Error('No IndexedDB')); return; }
      var probe;
      try { probe = idb.open(ASSET_DB); } catch (err) { reject(err); return; }
      probe.onerror = function () { reject(probe.error || new Error('open failed')); };
      probe.onsuccess = function () {
        var db = probe.result;
        if (db.objectStoreNames && db.objectStoreNames.contains(ASSET_STORE)) {
          resolve(db);
          return;
        }
        var version = (db.version || 1) + 1;
        db.close();
        var up = idb.open(ASSET_DB, version);
        up.onupgradeneeded = function () {
          var fresh = up.result;
          if (!fresh.objectStoreNames.contains(ASSET_STORE)) fresh.createObjectStore(ASSET_STORE);
        };
        up.onsuccess = function () { resolve(up.result); };
        up.onerror = function () { reject(up.error || new Error('upgrade failed')); };
      };
    });
  }

  function assetRun(mode, run) {
    return assetOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(ASSET_STORE, mode);
        var req = run(tx.objectStore(ASSET_STORE));
        tx.oncomplete = function () { db.close(); resolve(req ? req.result : undefined); };
        tx.onerror = function () { db.close(); reject(tx.error || new Error('transaction failed')); };
        tx.onabort = tx.onerror;
      });
    });
  }

  var assetStore = {
    get: function (key) { return assetRun('readonly', function (s) { return s.get(key); }); },
    put: function (key, blob) { return assetRun('readwrite', function (s) { return s.put(blob, key); }); },
    'delete': function (key) { return assetRun('readwrite', function (s) { return s['delete'](key); }); }
  };

  /* --- the picture ---------------------------------------------- */

  var bgDataUrl = null;        // the data: URL app.js hands the guest
  var bgPreviewBlob = null;    // the blob the panel's thumbnail is made of
  var bgPreviewUrl = null;
  var bgPreviewLoaded = false;

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var FR = window.FileReader;
      if (!FR) { reject(new Error('No FileReader')); return; }
      var reader = new FR();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error || new Error('read failed')); };
      reader.readAsDataURL(blob);
    });
  }

  /**
   * A picked file, down to 2560px on its long edge and re-encoded as a JPEG.
   * GIF and SVG are refused rather than flattened: one would lose its motion
   * and the other is markup, not pixels.
   */
  function downscaleImage(file) {
    var type = String((file && file.type) || '').toLowerCase();
    if (type === 'image/gif' || type === 'image/svg+xml') return Promise.reject(new Error(BG_REJECT));
    if (type.indexOf('image/') !== 0) return Promise.reject(new Error(BG_REJECT));
    if (typeof window.createImageBitmap !== 'function') return Promise.reject(new Error(BG_REJECT));

    return window.createImageBitmap(file).then(function (bitmap) {
      var longest = Math.max(bitmap.width, bitmap.height) || 1;
      var scale = longest > BG_MAX_EDGE ? BG_MAX_EDGE / longest : 1;
      var w = Math.max(1, Math.round(bitmap.width * scale));
      var h = Math.max(1, Math.round(bitmap.height * scale));

      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, w, h);
      if (typeof bitmap.close === 'function') bitmap.close();

      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error(BG_REJECT));
        }, 'image/jpeg', BG_JPEG_QUALITY);
      });
    });
  }

  function revokePreview() {
    if (bgPreviewUrl && window.URL && window.URL.revokeObjectURL) {
      try { window.URL.revokeObjectURL(bgPreviewUrl); } catch (err) { /* fine */ }
    }
    bgPreviewUrl = null;
  }

  function previewUrl() {
    if (!bgPreviewBlob) return null;
    if (bgPreviewUrl) return bgPreviewUrl;
    if (!window.URL || !window.URL.createObjectURL) return null;
    try { bgPreviewUrl = window.URL.createObjectURL(bgPreviewBlob); }
    catch (err) { bgPreviewUrl = null; }
    return bgPreviewUrl;
  }

  /** One read of the stored blob per run, then the thumbnail redraws itself. */
  function loadPreview() {
    if (bgPreviewLoaded) return;
    bgPreviewLoaded = true;
    assetStore.get(BG_ASSET_KEY).then(function (blob) {
      if (!blob) return;
      bgPreviewBlob = blob;
      renderNewtabBg();
    }).catch(function () { /* no db: the panel just offers the picker */ });
  }

  /** Downscale, store, and switch the new tab over to it. */
  function chooseBackgroundImage(file) {
    return downscaleImage(file).then(function (blob) {
      return assetStore.put(BG_ASSET_KEY, blob).then(function () {
        bgDataUrl = null;                 // the memo is a different picture now
        revokePreview();
        bgPreviewBlob = blob;
        bgPreviewLoaded = true;
        setBackground({ kind: 'image' });
        return blob;
      });
    });
  }

  /**
   * Drop the picture. The kind goes back to the board with it: leaving it on
   * 'image' would leave the new tab dimming a background that isn't there.
   */
  function removeBackgroundImage() {
    return assetStore['delete'](BG_ASSET_KEY).catch(function () { /* already gone */ })
      .then(function () {
        bgDataUrl = null;
        revokePreview();
        bgPreviewBlob = null;
        bgPreviewLoaded = true;
        setBackground({ kind: 'board' });
      });
  }

  /**
   * What app.js pushes into the new tab guest:
   *   { kind, boardOverImage, dim, dataUrl? }
   * dataUrl is only present for kind 'image' with a picture actually stored,
   * and is read out of IndexedDB once and then kept in memory.
   */
  function background() {
    var cfg = normalizeBackground(get('newtabBackground'));
    var out = { kind: cfg.kind, boardOverImage: cfg.boardOverImage, dim: cfg.dim };
    if (cfg.kind !== 'image') return Promise.resolve(out);
    if (bgDataUrl) {
      out.dataUrl = bgDataUrl;
      return Promise.resolve(out);
    }
    return assetStore.get(BG_ASSET_KEY).then(function (blob) {
      if (!blob) return out;              // chosen, but nothing stored yet
      return blobToDataUrl(blob).then(function (url) {
        bgDataUrl = url;
        out.dataUrl = url;
        return out;
      });
    }).catch(function () { return out; });  // no db: the dim alone, never a throw
  }

  /* ============================================================
     Search engines
     ============================================================ */

  function engines() {
    return ENGINES.map(function (e) { return { id: e.id, name: e.name, url: e.url }; });
  }

  function engineFor(id) {
    for (var i = 0; i < ENGINES.length; i++) if (ENGINES[i].id === id) return ENGINES[i];
    return ENGINES[0];
  }

  function searchUrl(query) {
    return engineFor(get('searchEngine')).url + encodeURIComponent(String(query == null ? '' : query));
  }

  /** True when `url` is any known engine's results page (same host + path). */
  function isSearchUrl(url) {
    if (!url) return false;
    var u;
    try { u = new URL(String(url)); } catch (err) { return false; }
    for (var i = 0; i < ENGINES.length; i++) {
      var e;
      try { e = new URL(ENGINES[i].url); } catch (err2) { continue; }
      if (u.host === e.host && u.pathname === e.pathname) return true;
    }
    return false;
  }

  /* ============================================================
     Chips (the new tab shortcuts)
     ============================================================ */

  function defaultChips() {
    var seed = window.DEFAULT_CHIPS;
    if (!Array.isArray(seed)) return [];
    return seed
      .filter(function (c) { return c && c.url; })
      .map(function (c) { return { label: String(c.label || hostnameOf(c.url)), url: String(c.url) }; });
  }

  /** Always an array: null (never touched) reads as the seeded defaults. */
  function chips() {
    var c = get('chips');
    if (!Array.isArray(c)) return defaultChips();
    return c.map(function (x) { return { label: String(x.label || ''), url: String(x.url || '') }; });
  }

  function hostnameOf(url) {
    try {
      var h = new URL(String(url)).hostname;
      return h.replace(/^www\./, '') || String(url);
    } catch (err) {
      return String(url || '');
    }
  }

  /** A typed "github.com" is a URL; only the scheme is missing. */
  function normalizeUrl(url) {
    var raw = String(url == null ? '' : url).trim();
    if (!raw) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
    return 'https://' + raw;
  }

  function sameUrl(a, b) {
    function key(u) {
      return String(u || '').trim().toLowerCase().replace(/\/+$/, '');
    }
    return key(a) === key(b);
  }

  /** @returns true when it was added, false when that URL is already there. */
  function addChip(chip) {
    var url = normalizeUrl(chip && chip.url);
    if (!url) return false;
    var list = chips();
    for (var i = 0; i < list.length; i++) if (sameUrl(list[i].url, url)) return false;
    var label = chip && chip.label ? String(chip.label).trim() : '';
    list.push({ label: label || hostnameOf(url), url: url });
    set({ chips: list });
    return true;
  }

  function removeChip(url) {
    var list = chips();
    var next = list.filter(function (c) { return !sameUrl(c.url, url); });
    if (next.length === list.length) return false;
    set({ chips: next });
    return true;
  }

  function updateChip(url, patch) {
    var list = chips();
    for (var i = 0; i < list.length; i++) {
      if (!sameUrl(list[i].url, url)) continue;
      var label = patch && patch.label !== undefined ? String(patch.label).trim() : list[i].label;
      var next = patch && patch.url !== undefined ? normalizeUrl(patch.url) : list[i].url;
      if (!next) return false;
      list[i] = { label: label || hostnameOf(next), url: next };
      set({ chips: list });
      return true;
    }
    return false;
  }

  function moveChip(url, delta) {
    var list = chips();
    var from = -1;
    for (var i = 0; i < list.length; i++) if (sameUrl(list[i].url, url)) { from = i; break; }
    if (from < 0) return false;
    var to = from + delta;
    if (to < 0 || to >= list.length) return false;
    var item = list.splice(from, 1)[0];
    list.splice(to, 0, item);
    set({ chips: list });
    return true;
  }

  /* ============================================================
     Accent
     ============================================================ */

  function isLight() {
    return document.documentElement.getAttribute('data-theme') === 'light';
  }

  /**
   * Paint the accent tokens inline on <html>, or strip them so the authored
   * ones in chrome.css come back. The new tab page runs this same formula.
   */
  function applyAccent(hue) {
    var root = document.documentElement;
    var n = Number(hue);
    var i;
    if (hue === null || hue === undefined || !isFinite(n)) {
      for (i = 0; i < ACCENT_TOKENS.length; i++) root.style.removeProperty(ACCENT_TOKENS[i][0]);
      return;
    }
    var h = ((n % 360) + 360) % 360;
    var light = isLight();
    var s = light ? 90 : 100;
    var l = light ? 44 : 75;
    for (i = 0; i < ACCENT_TOKENS.length; i++) {
      var name = ACCENT_TOKENS[i][0];
      var alpha = ACCENT_TOKENS[i][1];
      if (name === '--ion-select') alpha = light ? 0.2 : 0.25;
      var value = alpha === null
        ? 'hsl(' + h + ' ' + s + '% ' + l + '%)'
        : 'hsl(' + h + ' ' + s + '% ' + l + '% / ' + alpha + ')';
      root.style.setProperty(name, value);
    }
  }

  /** The hue the slider should sit on when nothing is chosen: the authored one. */
  function authoredHue() {
    return isLight() ? 206 : 203;
  }

  /* ============================================================
     Palette
     A named set of chrome tokens, authored in chrome.css and chosen
     by one attribute on <html>. The accent slider still wins over it.
     ============================================================ */

  /** A stored value from another build, or a corrupt one, reads as aurora. */
  function paletteName(name) {
    for (var i = 0; i < PALETTES.length; i++) {
      if (PALETTES[i].id === name) return PALETTES[i].id;
    }
    return 'aurora';
  }

  function palettes() {
    return PALETTES.map(function (p) { return { id: p.id, name: p.name }; });
  }

  /**
   * Wear a palette: the attribute chrome.css keys off, the key theme-boot.js
   * reads on the next cold start, and then the accent — a hue the user picked
   * is theirs and outranks the palette's, so it is painted back on top;
   * otherwise the inline props come off and the palette's own accent shows.
   */
  function applyPalette(name) {
    var id = paletteName(name);
    var root = document.documentElement;
    if (id === 'aurora') {
      root.removeAttribute('data-palette');
      try { window.localStorage.removeItem(PALETTE_KEY); } catch (err) { /* fine */ }
    } else {
      root.setAttribute('data-palette', id);
      try { window.localStorage.setItem(PALETTE_KEY, id); } catch (err) { /* fine */ }
    }
    var hue = get('accentHue');
    applyAccent(hue === null || hue === undefined ? null : hue);
    return id;
  }

  /* ============================================================
     Site theme (the pages, not the chrome)
     ============================================================ */

  function pushSiteTheme(mode) {
    var m = mode === 'light' || mode === 'dark' ? mode : 'system';
    var app = window.api && window.api.app;
    if (app && typeof app.setSiteTheme === 'function') {
      try { app.setSiteTheme(m); } catch (err) { /* older preload */ }
    }
  }

  /* ============================================================
     Toast
     ============================================================ */

  function showToast(text, ms) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'settings-toast';
      toastEl.className = 'glass';
      toastEl.setAttribute('role', 'status');
      toastEl.hidden = true;
      document.body.appendChild(toastEl);
    }
    window.clearTimeout(toastTimer);
    window.clearTimeout(toastHideTimer);
    toastEl.textContent = String(text == null ? '' : text);
    toastEl.hidden = false;
    // One frame hidden-to-shown, so the stepped transition actually runs.
    window.requestAnimationFrame(function () {
      if (toastEl) toastEl.classList.add('is-up');
    });
    toastTimer = window.setTimeout(function () {
      if (!toastEl) return;
      toastEl.classList.remove('is-up');
      toastHideTimer = window.setTimeout(function () {
        if (toastEl) toastEl.hidden = true;
      }, 200);
    }, Math.max(400, Number(ms) || 1800));
  }

  /* ============================================================
     DOM helpers
     ============================================================ */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function iconButton(glyph, label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.title = label;
    b.setAttribute('aria-label', label);
    var g = el('span', 'glyph', glyph);
    b.appendChild(g);
    b.addEventListener('click', onClick);
    return b;
  }

  function textButton(label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function section(title) {
    var s = el('section', 'set-section');
    s.appendChild(el('h2', 'set-h', title));
    return s;
  }

  /** A row of mutually exclusive options, drawn as one segmented instrument. */
  function segmented(options, current, onPick) {
    var wrap = el('div', 'set-seg');
    wrap.setAttribute('role', 'radiogroup');
    options.forEach(function (opt) {
      var b = textButton(opt.name, 'set-seg-opt' + (opt.id === current ? ' is-on' : ''), function () {
        onPick(opt.id);
      });
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', opt.id === current ? 'true' : 'false');
      wrap.appendChild(b);
    });
    return wrap;
  }

  /**
   * The palettes as six painted chips. One radiogroup with a roving tabindex:
   * the arrows carry the selection along the row the way a radio group does,
   * Space and Enter confirm whatever is focused. Each button wears the palette
   * it offers, so the row is its own legend.
   */
  function paletteSwatches(current, onPick) {
    var wrap = el('div', 'set-swatches');
    wrap.setAttribute('role', 'radiogroup');
    wrap.setAttribute('aria-label', 'Palette');
    var buttons = [];

    function moveTo(i) {
      var n = buttons.length;
      var next = buttons[((i % n) + n) % n];
      if (!next) return;
      if (typeof next.focus === 'function') next.focus();
      onPick(next.getAttribute('data-value'));
    }

    PALETTES.forEach(function (p, index) {
      var on = p.id === current;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'set-swatch' + (on ? ' is-on' : '');
      b.setAttribute('data-value', p.id);
      /* aurora is chrome.css's own :root and has no block of its own, so
         leaving the attribute off is exactly what previews the default. */
      if (p.id !== 'aurora') b.setAttribute('data-palette', p.id);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.setAttribute('aria-label', p.name);
      b.title = p.name;
      b.tabIndex = on ? 0 : -1;
      b.appendChild(el('span', 'set-swatch-check', GLYPH_CHECK));
      b.addEventListener('click', function () { onPick(p.id); });
      b.addEventListener('keydown', function (event) {
        var k = event.key;
        if (k === 'ArrowRight' || k === 'ArrowDown') { event.preventDefault(); moveTo(index + 1); }
        else if (k === 'ArrowLeft' || k === 'ArrowUp') { event.preventDefault(); moveTo(index - 1); }
        else if (k === 'Home') { event.preventDefault(); moveTo(0); }
        else if (k === 'End') { event.preventDefault(); moveTo(buttons.length - 1); }
        else if (k === ' ' || k === 'Spacebar' || k === 'Enter') { event.preventDefault(); onPick(p.id); }
      });
      buttons.push(b);
      wrap.appendChild(b);

      var name = el('span', 'set-swatch-name', p.name);
      name.setAttribute('aria-hidden', 'true');
      wrap.appendChild(name);
    });
    return wrap;
  }

  /** A vertical list of options, each with its own lit dot. */
  function optionList(options, current, onPick) {
    var wrap = el('div', 'set-opts');
    wrap.setAttribute('role', 'radiogroup');
    options.forEach(function (opt) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'set-opt' + (opt.id === current ? ' is-on' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', opt.id === current ? 'true' : 'false');
      b.appendChild(el('span', 'set-dot'));
      b.appendChild(el('span', 'set-opt-name', opt.name));
      b.addEventListener('click', function () { onPick(opt.id); });
      wrap.appendChild(b);
    });
    return wrap;
  }

  /**
   * A <select> dressed as one of the panel's fields. The chevron is drawn by
   * the wrapper's ::after — a native dropdown arrow would be the only piece
   * of Windows grey in the whole pane.
   */
  function glassSelect(id, options, current, onPick) {
    var wrap = el('span', 'set-select');
    var sel = document.createElement('select');
    sel.className = 'set-sel';
    if (id) sel.id = id;

    var match = -1;
    options.forEach(function (opt, i) {
      var o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = opt.name;
      if (String(opt.value) === String(current)) match = i;
      sel.appendChild(o);
    });
    /* A stored value from a future build (or a corrupt one) still has to
       show something honest, so fall back to the option list's own first. */
    sel.selectedIndex = match >= 0 ? match : 0;

    sel.addEventListener('change', function () {
      var picked = options[sel.selectedIndex];
      onPick(picked ? picked.value : options[0].value);
    });
    wrap.appendChild(sel);
    return wrap;
  }

  /** A label and one control on the same line, wrapping when it must. */
  function controlRow(labelText, id, control) {
    var row = el('div', 'set-ctl-row');
    var label = el('label', 'set-ctl-label', labelText);
    if (id) label.setAttribute('for', id);
    row.appendChild(label);
    row.appendChild(control);
    return row;
  }

  /**
   * A whole-row switch: the row itself is the control, like .set-opt, so the
   * label is as clickable as the track beside it.
   */
  function switchRow(label, checked, onToggle) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'set-row' + (checked ? ' is-on' : '');
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', checked ? 'true' : 'false');
    b.appendChild(el('span', 'set-row-label', label));
    var track = el('span', 'set-switch');
    track.appendChild(el('span', 'set-switch-knob'));
    b.appendChild(track);
    b.addEventListener('click', function () { onToggle(!checked); });
    return b;
  }

  /* ============================================================
     Sections
     ============================================================ */

  function buildLook() {
    var s = section('Look');
    var seg = el('div', 'set-field');
    seg.setAttribute('data-field', 'theme');
    s.appendChild(seg);

    var palette = el('div', 'set-field');
    palette.setAttribute('data-field', 'palette');
    s.appendChild(palette);

    var accent = el('div', 'set-field set-accent');
    accent.setAttribute('data-field', 'accent');
    s.appendChild(accent);

    var bookmarks = el('div', 'set-field');
    bookmarks.setAttribute('data-field', 'bookmarksbar');
    s.appendChild(bookmarks);
    return s;
  }

  /* Set for the length of one pick, so the re-render it causes knows to take
     the keyboard back to the swatch that was just chosen. */
  var paletteFocus = false;

  /** A swatch was chosen: wear it now, then store it so everyone else hears. */
  function pickPalette(name) {
    if (paletteName(name) !== name) return;   // not one of ours: ignore it
    paletteFocus = true;
    applyPalette(name);
    set({ palette: name });
    paletteFocus = false;
  }

  function renderLook() {
    if (!bodyEl) return;
    var themeField = bodyEl.querySelector('[data-field="theme"]');
    var accentField = bodyEl.querySelector('[data-field="accent"]');
    if (!themeField || !accentField) return;

    var theme = isLight() ? 'light' : 'dark';
    themeField.textContent = '';
    themeField.appendChild(segmented(
      [{ id: 'dark', name: 'Dark' }, { id: 'light', name: 'Light' }],
      theme,
      function (mode) {
        if (typeof window.setTheme === 'function') window.setTheme(mode);
        else document.documentElement.setAttribute('data-theme', mode);
      }
    ));

    var paletteField = bodyEl.querySelector('[data-field="palette"]');
    if (paletteField) {
      paletteField.textContent = '';
      paletteField.appendChild(paletteSwatches(paletteName(get('palette')), pickPalette));
      paletteField.appendChild(el('p', 'set-hint',
        'The aurora and the accent change together. Pick your own accent below to override the palette’s.'));
      /* A pick rebuilt this row out from under the keyboard; put it back. */
      if (paletteFocus) {
        var picked = paletteField.querySelector('.set-swatch.is-on');
        if (picked && typeof picked.focus === 'function') picked.focus();
      }
    }

    var hue = get('accentHue');
    accentField.textContent = '';
    var row = el('div', 'set-accent-row');

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '360';
    slider.step = '1';
    slider.className = 'set-hue';
    slider.value = String(hue === null || hue === undefined ? authoredHue() : hue);
    slider.title = 'Accent colour';
    slider.setAttribute('aria-label', 'Accent colour');
    // input previews without writing; change is the one that persists.
    slider.addEventListener('input', function () { applyAccent(Number(slider.value)); });
    slider.addEventListener('change', function () { set({ accentHue: Number(slider.value) }); });
    row.appendChild(slider);

    /* "Default" now means the palette's accent, not aurora's: drop the custom
       hue, then let the current palette repaint what it authored. */
    var def = textButton('Default', 'set-text', function () {
      set({ accentHue: null });
      applyPalette(get('palette'));
    });
    def.disabled = hue === null || hue === undefined;
    row.appendChild(def);

    accentField.appendChild(row);
    accentField.appendChild(el('p', 'set-hint', 'One colour marks what is active, everywhere.'));

    renderBookmarksBar();
  }

  /**
   * The bookmarks bar switch. The setting is the whole feature's state:
   * bookmarks.js shows or hides the bar from it, and Ctrl+Shift+B writes the
   * same key, so the switch is never out of step with what is on screen.
   */
  function renderBookmarksBar() {
    if (!bodyEl) return;
    var field = bodyEl.querySelector('[data-field="bookmarksbar"]');
    if (!field) return;

    var on = !!get('bookmarksBar');
    field.textContent = '';
    field.appendChild(switchRow('Show the bookmarks bar', on, function (next) {
      set({ bookmarksBar: !!next });
    }));
    field.appendChild(el('p', 'set-hint',
      'Your new-tab shortcuts, under the address bar. Ctrl+Shift+B toggles it.'));
  }

  /** Ctrl+Shift+B, and anything else that wants the bar without the panel. */
  function toggleBookmarksBar() {
    var next = !get('bookmarksBar');
    set({ bookmarksBar: next });
    return next;
  }

  /* ============================================================
     Claude
     The folder a new Claude tab opens in, and whether a restored one
     picks the conversation back up. app.js reads both from the store.
     ============================================================ */

  /* Set to a selector just before a write that re-renders this section, so
     the keyboard lands back on the control that was being used. */
  var claudeFocus = null;

  function buildClaude() {
    var s = section('Claude');
    var dir = el('div', 'set-field');
    dir.setAttribute('data-field', 'claudedir');
    s.appendChild(dir);

    var resume = el('div', 'set-field');
    resume.setAttribute('data-field', 'clauderesume');
    s.appendChild(resume);
    return s;
  }

  function renderClaude() {
    renderClaudeDir();
    renderClaudeResume();
  }

  function renderClaudeDir() {
    var field = bodyEl && bodyEl.querySelector('[data-field="claudedir"]');
    if (!field) return;
    field.textContent = '';

    var current = get('claudeDir');
    var app = (window.api && window.api.app) || null;
    var home = (window.api && window.api.homeDir) || '';

    var label = el('label', 'set-label', 'Start new Claude tabs in');
    label.setAttribute('for', 'set-claude-dir');
    field.appendChild(label);

    var row = el('div', 'set-path-row');

    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'set-claude-dir';
    input.className = 'set-path';
    input.value = current || '';
    input.placeholder = 'Your home folder';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.title = 'Type a folder, or choose one';
    row.appendChild(input);

    var note = el('p', 'set-note', 'That folder doesn’t exist');
    note.hidden = true;

    // An older preload has no native dialog: then the field is the only way in.
    if (app && typeof app.pickFolder === 'function') {
      row.appendChild(textButton('Choose…', 'set-btn set-path-pick', function () {
        var answer;
        try { answer = app.pickFolder(current || home || undefined); } catch (err) { return; }
        Promise.resolve(answer).then(function (path) {
          if (typeof path !== 'string' || !path) return;   // null: cancelled
          claudeFocus = '.set-path-pick';
          set({ claudeDir: path });
        }, function () { /* the dialog is gone; leave the value alone */ });
      }));
    }

    if (current) {
      row.appendChild(textButton('Use home', 'set-text set-path-home', function () {
        claudeFocus = '.set-path';
        set({ claudeDir: null });
      }));
    }

    field.appendChild(row);
    field.appendChild(note);

    /* A typed path is only written once main confirms the folder is real;
       until then the previous value stands and the note says why. */
    var before = input.value;
    input.addEventListener('change', function () {      // fires on blur, and on Enter
      var next = input.value.trim();
      note.hidden = true;
      if (next === before) return;
      if (!next) { set({ claudeDir: null }); return; }   // emptied: back to home
      if (!app || typeof app.dirExists !== 'function') { set({ claudeDir: next }); return; }
      var answer;
      try { answer = app.dirExists(next); } catch (err) { set({ claudeDir: next }); return; }
      Promise.resolve(answer).then(function (ok) {
        if (ok) { set({ claudeDir: next }); return; }
        note.hidden = false;
        input.value = before;
      }, function () { set({ claudeDir: next }); });     // unverifiable: take the user's word
    });

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); return; }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();            // Escape leaves the field, not the panel
        input.value = before;
        note.hidden = true;
        input.blur();
      }
    });

    if (claudeFocus) {
      var target = field.querySelector(claudeFocus);
      claudeFocus = null;
      if (target && typeof target.focus === 'function') target.focus();
    }
  }

  function renderClaudeResume() {
    var field = bodyEl && bodyEl.querySelector('[data-field="clauderesume"]');
    if (!field) return;
    field.textContent = '';

    field.appendChild(switchRow(
      'Resume the last conversation when tabs are restored',
      get('claudeResume') !== false,
      function (next) { set({ claudeResume: next }); }
    ));

    var hint = el('p', 'set-hint');
    hint.appendChild(document.createTextNode('Restored Claude tabs run '));
    hint.appendChild(el('code', 'set-code', 'claude --continue'));
    hint.appendChild(document.createTextNode(' in their folder. Turn off to start fresh every time.'));
    field.appendChild(hint);
  }

  function buildTabs() {
    var s = section('Tabs');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'tabsleep');
    s.appendChild(field);
    return s;
  }

  function renderTabs() {
    var field = bodyEl && bodyEl.querySelector('[data-field="tabsleep"]');
    if (!field) return;
    field.textContent = '';

    var minutes = Number(get('tabSleepMinutes'));
    if (!isFinite(minutes) || minutes < 0) minutes = DEFAULTS.tabSleepMinutes;

    field.appendChild(controlRow(
      'Put background tabs to sleep after',
      'set-tab-sleep',
      glassSelect('set-tab-sleep', SLEEP_TIMES, minutes, function (value) {
        set({ tabSleepMinutes: Number(value) });
      })
    ));

    field.appendChild(el('p', 'set-hint',
      'Sleeping tabs free their memory and reload when you come back. ' +
      'Pinned tabs and tabs playing sound stay awake.'));
  }

  function buildSearch() {
    var s = section('Search');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'engine');
    s.appendChild(field);
    s.appendChild(el('p', 'set-hint', 'Used by the address bar and the new tab page.'));
    return s;
  }

  function renderSearch() {
    var field = bodyEl && bodyEl.querySelector('[data-field="engine"]');
    if (!field) return;
    field.textContent = '';
    field.appendChild(optionList(engines(), get('searchEngine'), function (id) {
      set({ searchEngine: id });
    }));
  }

  function buildSites() {
    var s = section('Websites');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'sitetheme');
    s.appendChild(field);
    s.appendChild(el('p', 'set-hint',
      'Sites that offer a dark mode follow this. Pages with no theme of their own always stay light.'));
    return s;
  }

  function renderSites() {
    var field = bodyEl && bodyEl.querySelector('[data-field="sitetheme"]');
    if (!field) return;
    field.textContent = '';
    field.appendChild(optionList(SITE_THEMES, get('siteTheme'), function (id) {
      set({ siteTheme: id });
    }));
  }

  /* ============================================================
     Site styles

     These do NOT live in the settings object: window.SiteStyles owns its own
     storage and pushes every change into the open tabs itself. The panel is
     one more view of it, and a build without that module simply says so.
     ============================================================ */

  /** The module, or null when this build shipped without it. */
  function siteStyles() {
    var m = window.SiteStyles;
    if (!m) return null;
    if (typeof m.hosts !== 'function' || typeof m.get !== 'function') return null;
    if (typeof m.set !== 'function' || typeof m.remove !== 'function') return null;
    return m;
  }

  /** Re-render whenever the module changes, whoever changed it. Once. */
  function bindSiteStyles(api) {
    if (siteBound || typeof api.on !== 'function') return;
    siteBound = true;
    try {
      api.on(function () { if (bodyEl) renderSiteStyles(); });
    } catch (err) { siteBound = false; }
  }

  /**
   * What someone types vs. what a host actually is: 'https://WWW.Example.com/x'
   * and 'Example.com' are the same site, and the list should say so once.
   */
  function normalizeHost(raw) {
    var s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\//, '');   // scheme
    s = s.split(/[/?#]/)[0];                          // path, query, fragment
    s = s.replace(/^[^@]*@/, '');                     // user:pass@
    s = s.replace(/^www\./, '');
    s = s.replace(/\.+$/, '');                        // the root dot
    if (!s || /\s/.test(s)) return '';
    return s;
  }

  /** A host is safe inside a selector once its two dangerous glyphs are. */
  function attrEscape(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * The open tab, when it is the one this entry would act on. app.js owns
   * both globals; a build without them simply has no "Run now" to offer.
   * Matching goes through the module so a parent-domain entry counts for
   * its subdomains, exactly as it does when the page loads.
   */
  function activeTabFor(api, host) {
    if (typeof window.getActiveTab !== 'function') return null;
    if (typeof window.readCurrentUrl !== 'function') return null;
    var tab = null;
    try { tab = window.getActiveTab(); } catch (err) { return null; }
    if (!tab) return null;
    var url = '';
    try { url = String(window.readCurrentUrl(tab) || ''); } catch (err) { return null; }
    if (!url) return null;
    var matched = null;
    try {
      matched = typeof api.matchFor === 'function' ? api.matchFor(url) : null;
    } catch (err) { matched = null; }
    if (matched) return matched.host === host ? tab : null;
    var open = '';
    try {
      open = typeof api.hostFromUrl === 'function'
        ? String(api.hostFromUrl(url) || '')
        : normalizeHost(url);
    } catch (err) { open = normalizeHost(url); }
    return open === host ? tab : null;
  }

  function buildSiteStyles() {
    var s = section('Site styles and scripts');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'sitestyles');
    s.appendChild(field);
    return s;
  }

  /** One site: its name, its dark switch, and the code drawer under them. */
  function siteRow(api, host) {
    var rec = null;
    try { rec = api.get(host); } catch (err) { rec = null; }
    rec = rec || { css: '', dark: false, js: '' };

    var row = el('div', 'set-site');
    row.setAttribute('data-host', host);

    var head = el('div', 'set-site-head');
    head.appendChild(el('span', 'set-site-host', host));

    var sw = switchRow('Dark', !!rec.dark, function (next) {
      try { api.set(host, { dark: next }); } catch (err) { /* module's problem */ }
      renderSiteStyles();
    });
    sw.classList.add('is-inline');
    sw.title = 'Force dark mode on ' + host;
    head.appendChild(sw);

    var expanded = siteOpen === host;
    var edit = textButton('Edit', 'set-text set-site-edit', function () {
      siteOpen = expanded ? null : host;
      siteFocus = expanded ? null : '.set-site[data-host="' + attrEscape(host) + '"] .set-css';
      renderSiteStyles();
    });
    edit.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    head.appendChild(edit);
    row.appendChild(head);

    if (!expanded) return row;

    // Escape leaves the field first; a second press then closes the panel.
    function escapesOut(node) {
      node.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        node.blur();
      });
    }

    var editor = el('div', 'set-site-editor');
    editor.appendChild(el('p', 'set-hint', 'CSS'));
    var ta = document.createElement('textarea');
    ta.className = 'set-css';
    ta.spellcheck = false;
    ta.setAttribute('aria-label', 'Custom CSS for ' + host);
    ta.value = typeof rec.css === 'string' ? rec.css : '';
    escapesOut(ta);
    editor.appendChild(ta);

    editor.appendChild(el('p', 'set-hint', 'JavaScript'));
    var js = document.createElement('textarea');
    js.className = 'set-js';
    js.spellcheck = false;
    js.placeholder = '// runs after the page loads';
    js.setAttribute('aria-label', 'Custom JavaScript for ' + host);
    js.value = typeof rec.js === 'string' ? rec.js : '';
    escapesOut(js);
    editor.appendChild(js);

    var acts = el('div', 'set-site-acts');
    acts.appendChild(textButton('Save', 'set-btn', function () {
      try { api.set(host, { css: ta.value, js: js.value }); } catch (err) { /* module's problem */ }
      var toast = window.Toast;
      if (toast && typeof toast.show === 'function') toast.show('Saved ' + host);
    }));

    /* Only when this site is the one on screen: re-applying to a tab that
       is somewhere else would be a button that visibly does nothing. */
    if (activeTabFor(api, host) && typeof api.applyTo === 'function') {
      acts.appendChild(textButton('Run now', 'set-text set-site-run', function () {
        var tab = activeTabFor(api, host);
        if (!tab) return;
        try { api.applyTo(tab); } catch (err) { /* module's problem */ }
        var toast = window.Toast;
        if (toast && typeof toast.show === 'function') toast.show('Ran on ' + host);
      }));
    }
    acts.appendChild(textButton('Remove site', 'set-text set-site-remove', function () {
      try { api.remove(host); } catch (err) { /* module's problem */ }
      if (siteOpen === host) siteOpen = null;
      renderSiteStyles();
    }));
    editor.appendChild(acts);
    row.appendChild(editor);
    return row;
  }

  function renderSiteStyles() {
    var field = bodyEl && bodyEl.querySelector('[data-field="sitestyles"]');
    if (!field) return;
    field.textContent = '';

    var api = siteStyles();
    if (!api) {
      field.appendChild(el('p', 'set-na', 'Not available'));
      return;
    }
    bindSiteStyles(api);

    if (typeof api.globalDark === 'function' && typeof api.setGlobalDark === 'function') {
      var on_ = false;
      try { on_ = !!api.globalDark(); } catch (err) { on_ = false; }
      field.appendChild(switchRow('Force dark mode on every site', on_, function (next) {
        try { api.setGlobalDark(next); } catch (err) { /* module's problem */ }
        renderSiteStyles();
      }));
      field.appendChild(el('p', 'set-hint', 'Sites that are already dark are left alone.'));
    }

    var hosts = [];
    try { hosts = api.hosts() || []; } catch (err) { hosts = []; }

    var list = el('div', 'set-sites');
    if (!hosts.length) {
      list.appendChild(el('p', 'set-empty',
        'No site styles or scripts yet. Add a site to give it your own CSS, a script, or force dark mode.'));
    }
    hosts.forEach(function (host) { list.appendChild(siteRow(api, host)); });
    field.appendChild(list);

    /* The add row: a host, however the user happens to have copied it. */
    var add = el('div', 'set-path-row set-site-add');
    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'set-site-host';
    input.className = 'set-path';
    input.placeholder = 'example.com';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Add a site');

    function commitAdd() {
      /* The module's own normaliser wins when it has one: both sides have to
         agree on what counts as the same site, or the list doubles up. */
      var host = '';
      try {
        host = typeof api.normalizeHost === 'function'
          ? String(api.normalizeHost(String(input.value)) || '')
          : normalizeHost(input.value);
      } catch (err) { host = normalizeHost(input.value); }
      if (!host) { input.focus(); return; }
      var known = false;
      try { known = (api.hosts() || []).indexOf(host) >= 0; } catch (err) { known = false; }
      if (!known) {
        try { api.set(host, { css: '', dark: false }); } catch (err) { /* module's problem */ }
      }
      input.value = '';
      siteOpen = host;
      siteFocus = '.set-site[data-host="' + attrEscape(host) + '"] .set-css';
      renderSiteStyles();
    }
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); commitAdd(); }
    });
    add.appendChild(input);
    add.appendChild(textButton('Add', 'set-btn', commitAdd));
    field.appendChild(add);
    field.appendChild(el('p', 'set-hint',
      "Scripts run in the page with the page's own powers. Only paste code you trust."));

    if (siteFocus) {
      var target = field.querySelector(siteFocus);
      siteFocus = null;
      if (target && typeof target.focus === 'function') target.focus();
    }
  }

  function buildNewTab() {
    var s = section('New tab');

    var bg = el('div', 'set-field');
    bg.setAttribute('data-field', 'newtabbg');
    s.appendChild(bg);

    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'chips');
    s.appendChild(field);
    return s;
  }

  /** The background picker: one select, and the picture's controls under it. */
  function renderNewtabBg() {
    var field = bodyEl && bodyEl.querySelector('[data-field="newtabbg"]');
    if (!field) return;
    field.textContent = '';

    var cfg = normalizeBackground(get('newtabBackground'));

    field.appendChild(controlRow('Background', 'set-newtab-bg',
      glassSelect('set-newtab-bg', NEWTAB_BACKGROUNDS, cfg.kind, function (value) {
        setBackground({ kind: value });
      })));

    if (cfg.kind !== 'image') {
      field.appendChild(el('p', 'set-hint', cfg.kind === 'aurora'
        ? 'The aurora on its own. The circuit board stops drawing entirely.'
        : 'The circuit board, drawn around your search field.'));
      return;
    }

    loadPreview();

    /* The file input is the only way in — no main-process dialog, because a
       renderer can read a picked file on its own. Hidden, and driven by the
       button next to it, so the panel keeps its own controls. */
    var picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.className = 'set-bg-file';
    picker.hidden = true;
    picker.addEventListener('change', function () {
      var file = picker.files && picker.files[0];
      picker.value = '';                  // picking the same file again still fires
      if (!file) return;
      chooseBackgroundImage(file).then(function () {
        showToast('New tab background set');
      }).catch(function (err) {
        showToast((err && err.message) || BG_REJECT);
      });
    });

    var row = el('div', 'set-bg-row');
    row.appendChild(picker);

    var url = previewUrl();
    if (url) {
      var img = document.createElement('img');
      img.className = 'set-bg-preview';
      img.src = url;
      img.width = 96;
      img.height = 54;
      img.alt = 'Your new tab background';
      row.appendChild(img);
    } else {
      row.appendChild(el('span', 'set-bg-preview is-empty'));
    }

    row.appendChild(textButton('Choose image…', 'set-btn set-bg-pick', function () {
      picker.click();
    }));
    if (bgPreviewBlob) {
      row.appendChild(textButton('Remove image', 'set-text set-bg-drop', function () {
        removeBackgroundImage();
      }));
    }
    field.appendChild(row);

    field.appendChild(switchRow('Show circuit board over the image', cfg.boardOverImage,
      function (next) { setBackground({ boardOverImage: next }); }));

    var dim = el('span', 'set-bg-dim');
    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '60';
    slider.step = '1';
    slider.className = 'set-range';
    slider.id = 'set-bg-dim';
    slider.value = String(Math.round(cfg.dim * 100));
    slider.setAttribute('aria-label', 'Dim');
    var readout = el('span', 'set-bg-dim-value', Math.round(cfg.dim * 100) + '%');
    // input previews the number without writing; change is the one that stores.
    slider.addEventListener('input', function () { readout.textContent = slider.value + '%'; });
    slider.addEventListener('change', function () { setBackground({ dim: Number(slider.value) / 100 }); });
    dim.appendChild(slider);
    dim.appendChild(readout);
    field.appendChild(controlRow('Dim', 'set-bg-dim', dim));

    if (!bgPreviewBlob) {
      field.appendChild(el('p', 'set-hint', 'No picture chosen yet — the new tab dims the aurora until you pick one.'));
    }
  }

  /** A text cell that only looks like text until you click into it. */
  function chipInput(value, cls, placeholder, commit) {
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'set-chip-text ' + cls;
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    var before = value;
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); return; }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();          // Escape edits the cell, not the panel
        input.value = before;
        input.blur();
      }
    });
    input.addEventListener('blur', function () {
      var next = input.value.trim();
      if (next === before) return;
      if (!commit(next)) input.value = before;
    });
    return input;
  }

  function renderChips() {
    var field = bodyEl && bodyEl.querySelector('[data-field="chips"]');
    if (!field) return;
    field.textContent = '';

    var list = chips();
    var rows = el('div', 'set-chips');

    if (!list.length) {
      rows.appendChild(el('p', 'set-empty', 'No shortcuts yet. Add one below.'));
    }

    list.forEach(function (chip, index) {
      var row = el('div', 'set-chip');
      var url = chip.url;

      var texts = el('div', 'set-chip-texts');
      texts.appendChild(chipInput(chip.label, 'is-label', 'Name', function (next) {
        return updateChip(url, { label: next });
      }));
      texts.appendChild(chipInput(chip.url, 'is-url', 'Address', function (next) {
        return updateChip(url, { url: next });
      }));
      row.appendChild(texts);

      var acts = el('div', 'set-chip-acts');
      var up = iconButton(GLYPH_UP, 'Move up', 'set-act', function () {
        focusHint = '.set-chip:nth-child(' + index + ') .set-act';
        moveChip(url, -1);
      });
      up.disabled = index === 0;
      var down = iconButton(GLYPH_DOWN, 'Move down', 'set-act', function () {
        focusHint = '.set-chip:nth-child(' + (index + 2) + ') .set-act';
        moveChip(url, 1);
      });
      down.disabled = index === list.length - 1;
      acts.appendChild(up);
      acts.appendChild(down);
      acts.appendChild(iconButton(GLYPH_DELETE, 'Remove', 'set-act', function () {
        removeChip(url);
      }));
      row.appendChild(acts);
      rows.appendChild(row);
    });

    field.appendChild(rows);

    /* The add row: name, address, and the button that does Ctrl+D for you. */
    var add = el('div', 'set-chip set-chip-add');
    var addTexts = el('div', 'set-chip-texts');
    var labelIn = document.createElement('input');
    labelIn.type = 'text';
    labelIn.className = 'set-chip-text is-label';
    labelIn.placeholder = 'Name';
    labelIn.spellcheck = false;
    var urlIn = document.createElement('input');
    urlIn.type = 'text';
    urlIn.className = 'set-chip-text is-url';
    urlIn.placeholder = 'Address';
    urlIn.spellcheck = false;
    addTexts.appendChild(labelIn);
    addTexts.appendChild(urlIn);
    add.appendChild(addTexts);

    function commitAdd() {
      var url = urlIn.value.trim();
      if (!url) { urlIn.focus(); return; }
      if (addChip({ label: labelIn.value, url: url })) {
        focusHint = '.set-chip-add .is-url';
        showToast('Added to your new tab');
      } else {
        showToast('Already on your new tab');
      }
    }
    urlIn.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); commitAdd(); }
    });
    labelIn.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); urlIn.focus(); }
    });
    add.appendChild(iconButton(GLYPH_ADD, 'Add shortcut', 'set-act', commitAdd));
    field.appendChild(add);

    field.appendChild(textButton('Add current page', 'set-btn', function () {
      bookmarkActivePage();
    }));

    if (focusHint) {
      var target = field.querySelector(focusHint) || bodyEl.querySelector(focusHint);
      focusHint = null;
      if (target && typeof target.focus === 'function') target.focus();
    }
  }

  function buildPrivacy() {
    var s = section('Privacy');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'privacy');
    s.appendChild(field);
    return s;
  }

  function historyCount() {
    var store = window.History;
    if (!store || typeof store.all !== 'function') return -1;
    try {
      var items = store.all();
      return Array.isArray(items) ? items.length : -1;
    } catch (err) { return -1; }
  }

  function renderPrivacy() {
    var field = bodyEl && bodyEl.querySelector('[data-field="privacy"]');
    if (!field) return;
    field.textContent = '';

    var n = historyCount();
    var label = n > 0 ? 'Clear ' + n + (n === 1 ? ' page' : ' pages') : 'Clear browsing history';
    var clearHistory = textButton(label, 'set-btn', function () {
      var store = window.History;
      if (!store || typeof store.clear !== 'function') return;
      try { store.clear(); } catch (err) { /* storage is best-effort */ }
      renderPrivacy();
      showToast('History cleared');
    });
    clearHistory.disabled = n <= 0;
    field.appendChild(clearHistory);

    field.appendChild(textButton('Clear downloads list', 'set-btn', function () {
      var dl = window.api && window.api.downloads;
      if (dl && typeof dl.clear === 'function') {
        try { dl.clear(); } catch (err) { /* main is gone */ }
      }
      var mod = window.Downloads;
      if (mod) {
        var repaint = mod.refresh || mod.render || mod._refresh;
        if (typeof repaint === 'function') { try { repaint.call(mod); } catch (err) { /* fine */ } }
      }
      showToast('Downloads list cleared');
    }));
  }

  function buildShortcuts() {
    var s = section('Shortcuts');
    var table = el('div', 'set-keys');
    SHORTCUTS.forEach(function (pair) {
      var keys = el('div', 'set-keycell');
      String(pair[0]).split(' / ').forEach(function (combo, i) {
        if (i) keys.appendChild(el('span', 'set-keysep', '/'));
        combo.split('+').forEach(function (cap, j) {
          if (j) keys.appendChild(el('span', 'set-keyplus', '+'));
          keys.appendChild(el('span', 'set-key', cap));
        });
      });
      table.appendChild(keys);
      table.appendChild(el('div', 'set-keydesc', pair[1]));
    });
    s.appendChild(table);
    return s;
  }

  function buildAbout() {
    var s = section('About');
    var line = 'Browser';
    var app = window.api && window.api.app;
    if (app && typeof app.versions === 'function') {
      try {
        var v = app.versions() || {};
        if (v.electron) line += ' · Electron ' + v.electron;
        if (v.chrome) line += ' · Chromium ' + v.chrome;
      } catch (err) { /* older preload: the bare name is still true */ }
    }
    s.appendChild(el('p', 'set-about', line));
    return s;
  }

  /* ============================================================
     Panel
     ============================================================ */

  /** The nav-row instrument: same recipe as #theme, one slot to its right. */
  function injectButton() {
    if (document.getElementById('settings')) {
      buttonEl = document.getElementById('settings');
      return;
    }
    var navrow = document.querySelector('.navrow');
    if (!navrow) return;

    buttonEl = document.createElement('button');
    buttonEl.id = 'settings';
    buttonEl.className = 'glass iconbtn no-drag';
    buttonEl.type = 'button';
    buttonEl.title = 'Settings';
    buttonEl.setAttribute('aria-label', 'Settings');
    buttonEl.setAttribute('aria-haspopup', 'dialog');
    buttonEl.setAttribute('aria-expanded', 'false');
    buttonEl.appendChild(el('span', 'glyph', GLYPH_GEAR));
    buttonEl.addEventListener('click', function () { toggle(); });

    var theme = document.getElementById('theme');
    if (theme && theme.parentNode === navrow) {
      navrow.insertBefore(buttonEl, theme.nextSibling);
    } else {
      navrow.appendChild(buttonEl);
    }
  }

  /**
   * The popover lives on <body>, not inside .chrome-layer: the chrome layer
   * carries a blur filter before boot, and a fixed element there would be
   * clipped to it rather than floating over the tab well.
   */
  function buildPanel() {
    if (document.getElementById('settings-panel')) {
      panelEl = document.getElementById('settings-panel');
      bodyEl = panelEl.querySelector('.set-body');
      return;
    }
    panelEl = document.createElement('div');
    panelEl.id = 'settings-panel';
    panelEl.className = 'glass';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', 'Settings');
    panelEl.tabIndex = -1;
    panelEl.hidden = true;

    var head = el('div', 'set-head');
    head.appendChild(el('span', 'set-title', 'Settings'));
    head.appendChild(iconButton(GLYPH_CLOSE, 'Close', 'set-act set-x', function () { closePanel(); }));
    panelEl.appendChild(head);

    bodyEl = el('div', 'set-body');
    bodyEl.appendChild(buildLook());
    bodyEl.appendChild(buildClaude());
    bodyEl.appendChild(buildTabs());
    bodyEl.appendChild(buildSearch());
    bodyEl.appendChild(buildSites());
    bodyEl.appendChild(buildSiteStyles());
    bodyEl.appendChild(buildNewTab());
    bodyEl.appendChild(buildPrivacy());
    bodyEl.appendChild(buildShortcuts());
    bodyEl.appendChild(buildAbout());
    panelEl.appendChild(bodyEl);

    document.body.appendChild(panelEl);
    renderAll();
  }

  function renderAll() {
    renderLook();
    renderClaude();
    renderTabs();
    renderSearch();
    renderSites();
    renderSiteStyles();
    renderNewtabBg();
    renderChips();
    renderPrivacy();
  }

  /** Anchor under the gear, like the downloads popover does. */
  function position() {
    if (!panelEl || !buttonEl) return;
    var r = buttonEl.getBoundingClientRect();
    if (!r || !r.width) return;
    var right = Math.max(8, Math.round(window.innerWidth - r.right));
    panelEl.style.top = Math.round(r.bottom + 8) + 'px';
    panelEl.style.right = right + 'px';
  }

  function openPanel() {
    if (!panelEl) return;
    renderAll();
    panelEl.hidden = false;
    open_ = true;
    position();
    if (buttonEl) {
      buttonEl.classList.add('is-open');
      buttonEl.setAttribute('aria-expanded', 'true');
    }
  }

  function closePanel() {
    if (panelEl) panelEl.hidden = true;
    open_ = false;
    if (buttonEl) {
      buttonEl.classList.remove('is-open');
      buttonEl.setAttribute('aria-expanded', 'false');
    }
  }

  function toggle() {
    if (open_) closePanel();
    else openPanel();
  }

  function isOpen() {
    return open_;
  }

  /* ============================================================
     Ctrl+D — add the page you are on
     ============================================================ */

  function bookmarkActivePage() {
    var tab = typeof window.getActiveTab === 'function' ? window.getActiveTab() : null;
    if (!tab || tab.kind !== 'page') {
      showToast('There is no page to add');
      return;
    }
    var url = typeof window.readCurrentUrl === 'function' ? window.readCurrentUrl(tab) : tab.url;
    url = String(url || '').trim();
    if (!url || /^(about:blank)?$/i.test(url) || /newtab\.html/i.test(url)) {
      showToast('There is no page to add');
      return;
    }
    var title = String(tab.title || '').trim();
    if (addChip({ label: title, url: url })) showToast('Added to your new tab');
    else showToast('Already on your new tab');
  }

  /**
   * Forwarded from main.js (keys pressed inside a <webview> never reach this
   * document). Returns true when the action was consumed.
   */
  function handleShortcut(action) {
    if (action === 'settings') { toggle(); return true; }
    if (action === 'bookmark') { bookmarkActivePage(); return true; }
    if (action === 'escape') {
      if (!open_) return false;
      closePanel();
      return true;
    }
    return false;
  }

  /* ============================================================
     Wiring
     ============================================================ */

  function wire() {
    // Escape only reaches this document when focus is inside the chrome; the
    // forwarded 'escape' action covers the case where a page has focus.
    document.addEventListener('keydown', function (event) {
      if (!open_) return;
      if (event.key === 'Escape') closePanel();
    });

    // Click-outside. mousedown, so it settles before the button's own click.
    document.addEventListener('mousedown', function (event) {
      if (!open_) return;
      var t = event.target;
      if (panelEl && panelEl.contains(t)) return;
      if (buttonEl && buttonEl.contains(t)) return;
      closePanel();
    }, true);

    window.addEventListener('resize', function () {
      if (open_) position();
    });

    // The panel mirrors the store, whoever wrote to it.
    on(function (_snapshot, keys) {
      if (!bodyEl) return;
      if (keys.indexOf('accentHue') >= 0 || keys.indexOf('palette') >= 0) renderLook();
      if (keys.indexOf('claudeDir') >= 0) renderClaudeDir();
      if (keys.indexOf('claudeResume') >= 0) renderClaudeResume();
      if (keys.indexOf('tabSleepMinutes') >= 0) renderTabs();
      if (keys.indexOf('searchEngine') >= 0) renderSearch();
      if (keys.indexOf('siteTheme') >= 0) renderSites();
      if (keys.indexOf('chips') >= 0) renderChips();
      if (keys.indexOf('bookmarksBar') >= 0) renderBookmarksBar();
      if (keys.indexOf('newtabBackground') >= 0) renderNewtabBg();
    });
  }

  /* The chrome's own theme decides which accent formula applies, and app.js
     changes it by attribute — so watch the attribute rather than the button. */
  function watchTheme() {
    var observer = new MutationObserver(function () {
      applyAccent(get('accentHue'));
      if (bodyEl) renderLook();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  function boot() {
    injectButton();
    buildPanel();
    wire();
  }

  /* Accent and site theme are applied at script load, not at DOMContentLoaded:
     the boot should paint in the chosen colour, not swap into it. */
  applyPalette(get('palette'));   // theme-boot.js usually stamped this already
  applyAccent(get('accentHue'));
  pushSiteTheme(get('siteTheme'));
  watchTheme();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.Toast = { show: showToast };

  window.Settings = {
    get: get,
    all: all,
    set: set,
    on: on,
    reset: reset,

    chips: chips,
    toggleBookmarksBar: toggleBookmarksBar,
    addChip: addChip,
    removeChip: removeChip,
    updateChip: updateChip,
    moveChip: moveChip,

    /* The new tab's background. background() resolves to
       { kind, boardOverImage, dim, dataUrl? } — what app.js pushes into the
       guest with __applyBackground(). */
    background: background,
    setBackground: setBackground,

    engines: engines,
    searchUrl: searchUrl,
    isSearchUrl: isSearchUrl,

    applyAccent: applyAccent,
    applyPalette: applyPalette,
    palettes: palettes,
    open: openPanel,
    close: closePanel,
    toggle: toggle,
    isOpen: isOpen,
    handleShortcut: handleShortcut,

    // test seams
    _defaults: DEFAULTS,
    _normalizeUrl: normalizeUrl,
    _hostnameOf: hostnameOf,
    _normalizeHost: normalizeHost,
    _sleepTimes: SLEEP_TIMES,
    _assetStore: assetStore,
    _normalizeBackground: normalizeBackground,
    _backgrounds: NEWTAB_BACKGROUNDS
  };
})();
