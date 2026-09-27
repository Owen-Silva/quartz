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
 *     chipsSource:  'visited' | 'list',      // where the new tab's five come from
 *     homepage:     'newtab',
 *     claudeDir:    null | absolute path,   // null means the home folder
 *     claudeResume: true | false,           // --continue on a restored tab
 *     claudeSkipPermissions: true | false,  // --dangerously-skip-permissions
 *     claudeNotify: true | false,           // toast when a tab goes quiet
 *     tabSleepMinutes: 0|15|30|60|180,      // 0 = never sleep a background tab
 *     workspaceSleep: 'newtab'|'all'|'off', // sleep tabs in the workspaces
 *                                           // you are not looking at
 *     workspaceSleepMinutes: 0|5|10|30|60,  // 'all' only: minutes away first
 *     newtabBackground: { kind: 'board'|'aurora'|'image',
 *                         boardOverImage: bool, dim: 0..0.6, rev },
 *     music:        { enabled, source: 'ambient'|'files',
 *                     where: 'newtab'|'anywhere', volume: 0..1,
 *                     files: [{ path, name }], shuffle } }
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
 * THE STOCKS SECTION IS NOT IN THERE EITHER, and that one is a rule rather
 * than a tidiness: its Finnhub key lives in MAIN (stocks.js, in
 * <userData>/stocks.json, as `stocks.finnhubKey`) and never crosses back.
 * The pane asks window.api.stocks.describe() for { enabled, hasKey, keyMask,
 * symbols, … } and writes with setKey/setEnabled/setSymbols; a key in this
 * file's localStorage object would be a key any devtools console could read.
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
  var GLYPH_SEARCH = '\uE721';

  var STORAGE_KEY = 'settings';
  /* theme-boot.js reads this one, before anything else runs. */
  var PALETTE_KEY = 'palette';

  var DEFAULTS = {
    searchEngine: 'google',
    siteTheme: 'system',
    palette: 'aurora',
    accentHue: null,
    chips: null,
    /* Where the new tab's five shortcuts come from. 'visited' — the default —
       lets the page count your own history and show the sites you actually
       open; 'list' pins the `chips` list above, in that order. A stored file
       without the key is a file from before the choice existed, and those
       shortcuts should start following the history too, so the default is
       the counted one rather than the list. */
    chipsSource: 'visited',
    /* The bookmarks bar under the nav row: the chips below, on every page.
       bookmarks.js owns the bar; this is the only place its visibility lives. */
    bookmarksBar: false,
    homepage: 'newtab',
    claudeDir: null,
    claudeResume: true,
    /* Every Claude tab starts with --dangerously-skip-permissions. On by
       default on purpose: these chambers run on the user's own machine, and a
       session sitting on a confirmation nobody is watching is a stuck tab. */
    claudeSkipPermissions: true,
    /* A quiet Windows notification when a background Claude tab stops working
       and waits on an answer. The chip's amber mark is not optional; this is. */
    claudeNotify: true,
    tabSleepMinutes: 30,
    /* Workspace sleep. Every preset workspace opens on a new tab page, and a
       new tab page paints a moving background: six of them decode 60 fps each
       into the one GPU process whether or not their view is hidden. 'newtab'
       (the default) puts those pages down the moment you leave the workspace
       they are in — they come back identical, so nothing is lost. 'all' also
       sleeps real pages once a workspace has gone unlooked-at for
       workspaceSleepMinutes, which costs them their scroll and their forms.
       app.js reads both through Settings.get(); there is no IPC either way. */
    workspaceSleep: 'newtab',
    workspaceSleepMinutes: 10,
    /* Downloads: off means a file goes straight to the Downloads folder with
       no prompt, which is what every browser does. downloads.js pushes this
       to main, which is the only process that can act on it. */
    downloadsAskWhere: false,
    /* What the new tab paints behind the search field:
         { kind: 'board' }                          the circuit board
         { kind: 'aurora' }                         the aurora alone
         { kind: 'image', boardOverImage, dim }     the user's own picture
         { kind: 'video', fileUrl, fileName, boardOverImage, dim }
                                                    a muted moving loop
       The picture itself is NOT in here — see the asset store below. The clip
       is not either: main copies it into <userData>/backgrounds/ and only its
       file:// URL is stored. */
    newtabBackground: { kind: 'board' },
    /* The apps pinned to the new tab page's dock: apps.js ids, webapps.js
       'web:<slug>' ids and 'term:<program>' ids — names, icons and running
       state are NOT stored, they are looked up against the installed index
       every time. `{ pins: [] }` is the whole of it for now; the object
       leaves room for the rest of the group later. There is no UI for this
       in the pane: the page manages its own dock. */
    apps: { pins: [] },
    /* Quiet lobby music while nothing else is making a sound. The tracks are
       referenced, never copied: only a path and the name a row shows. See the
       Idle music block below for what each key means. */
    music: {
      enabled: false,
      source: 'ambient',
      where: 'newtab',
      volume: 0.35,
      files: [],
      shuffle: true
    }
  };

  /* A dock is a shortlist. Anything past this is dropped on the way in. */
  var APP_PINS_MAX = 32;
  /* An id is a hash from apps.js; anything longer is not one. */
  var APP_ID_MAX = 200;

  /* The backgrounds, as the select offers them. */
  var NEWTAB_BACKGROUNDS = [
    { value: 'board', name: 'Circuit board' },
    { value: 'aurora', name: 'Aurora only' },
    { value: 'image', name: 'Your image' },
    { value: 'video', name: 'Moving picture' }
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

  /* The two ways the new tab can fill its five shortcuts. Ids, not labels:
     app.js reads the id, the segmented control draws the name. */
  var CHIP_SOURCES = [
    { id: 'visited', name: 'Most visited' },
    { id: 'list', name: 'My list' }
  ];

  var CHIP_SOURCE_HINTS = {
    visited: 'The five sites you open most, from your history.',
    list: 'The sites below, in this order.'
  };

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

  /* Workspace sleep: what may go to sleep in a workspace you have left. */
  var WORKSPACE_SLEEP = [
    { id: 'newtab', name: 'New tab pages' },
    { id: 'all', name: 'Every page' },
    { id: 'off', name: 'Off' }
  ];

  /* ...and, for 'Every page', how long a workspace goes unlooked-at first. */
  var WORKSPACE_AWAY_TIMES = [
    { value: 0, name: 'Straight away' },
    { value: 5, name: '5 minutes' },
    { value: 10, name: '10 minutes' },
    { value: 30, name: '30 minutes' },
    { value: 60, name: '1 hour' }
  ];

  /* The keyboard map, as the user would describe it to themselves. */
  var SHORTCUTS = [
    ['Ctrl+T', 'New tab'],
    ['Ctrl+W', 'Close tab'],
    ['Ctrl+Shift+T', 'Reopen the last tab'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next tab, previous tab'],
    ['Ctrl+1-9', 'Jump to a tab'],
    ['Ctrl+Alt+1-9', 'Jump to a workspace'],
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
     dark  -> hsl(H 45% 62%)    light -> hsl(H 90% 44%)
     and the derived tokens are the same hue at the alphas chrome.css
     authors for that theme (the dark ones were calmed in 8229844). */
  var ACCENT_TOKENS = [
    ['--ion', null],
    ['--ion-soft', 0.14, 0.14],
    ['--ion-glow', 0.22, 0.35],
    ['--ion-line', 0.65, 0.75],
    ['--ion-select', 0.30, 0.2],
    ['--seam-color', 0.14, 0.45],
    ['--chamber-seam', 0.16, 0.5]
  ];                            /* [token, dark alpha, light alpha] */

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

  /* Shortcut editing: one row records at a time. recPending is the combo
     already held by another action, waiting for the second press that takes
     it; recUnbound is the action that press displaced, noted for one render. */
  var recId = null;
  var recPending = '';
  var recNote = '';
  var recUnbound = null;

  /* Every section ships folded, so the pane opens as a list of headings and
     the reader picks what to look at (The user: "make it so that all the
     different sections in settings are auto collapsed"). About is the one
     exception and does not fold at all — plain heading, always open. A fold
     is a view state and a short-lived one: nothing is stored and nothing
     subscribes to it, so every open starts folded again. */
  var foldSeq = 0;                 // ids that pair a header with its body
  var foldsForced = false;         // held open by a filter, not by the reader
  var shortcutsSectionEl = null;   // the one fold with a side effect
  var resetAllArmed = false;
  var resetAllTimer = 0;
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
    /* The player is not in this file: it hears about the group either from
       the listener list or from this event, whichever it subscribed to. */
    if (keys.indexOf('music') >= 0) announceMusic();
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
    var out = { kind: kind, boardOverImage: v.boardOverImage === true, dim: dim };
    /* The clip's file:// URL and its original name ride along whatever the
       kind is, so switching to the board and back does not lose the pick. */
    if (typeof v.fileUrl === 'string' && v.fileUrl) out.fileUrl = v.fileUrl;
    if (typeof v.fileName === 'string' && v.fileName) out.fileName = v.fileName;
    return out;
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
      /* null (or '') clears the clip; a string replaces it. */
      if (patch.fileUrl !== undefined) {
        if (typeof patch.fileUrl === 'string' && patch.fileUrl) next.fileUrl = patch.fileUrl;
        else delete next.fileUrl;
      }
      if (patch.fileName !== undefined) {
        if (typeof patch.fileName === 'string' && patch.fileName) next.fileName = patch.fileName;
        else delete next.fileName;
      }
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

  /* --- the moving picture ---------------------------------------
     A clip cannot live in the settings JSON and should not be re-read into a
     data URL either, so main copies the chosen file into
     <userData>/backgrounds/ and hands back a file:// URL. Everything here is
     guarded: an older preload without api.background must not throw. */

  function bgVideoApi() {
    var api = (typeof window !== 'undefined') ? window.api : null;
    return (api && api.background && typeof api.background.chooseVideo === 'function')
      ? api.background : null;
  }

  /** True when the running preload can pick a clip at all. */
  function canChooseVideo() { return !!bgVideoApi(); }

  /**
   * Open the native picker, copy the clip in, and switch the new tab over.
   * Resolves { ok: true, fileName } or { ok: false, reason }; never rejects,
   * and 'cancelled' is not an error the panel should shout about.
   */
  function chooseBackgroundVideo() {
    var api = bgVideoApi();
    if (!api) return Promise.resolve({ ok: false, reason: 'This window cannot pick a file yet' });
    return Promise.resolve()
      .then(function () { return api.chooseVideo(); })
      .then(function (res) {
        if (!res || res.ok !== true || typeof res.fileUrl !== 'string' || !res.fileUrl) {
          return { ok: false, reason: (res && res.reason) || 'cancelled' };
        }
        setBackground({ kind: 'video', fileUrl: res.fileUrl, fileName: res.fileName || '' });
        renderNewtabBg();
        return { ok: true, fileName: res.fileName || '' };
      })
      .catch(function (err) {
        return { ok: false, reason: (err && err.message) || 'That file could not be used' };
      });
  }

  /**
   * Drop the clip. The kind goes back to the board with it, exactly as
   * removing the picture does: 'video' with nothing to play is just a dim.
   */
  function removeBackgroundVideo() {
    var api = bgVideoApi();
    var done = (api && typeof api.clearVideo === 'function')
      ? Promise.resolve().then(function () { return api.clearVideo(); }).catch(function () { })
      : Promise.resolve();
    return done.then(function () {
      setBackground({ kind: 'board', fileUrl: null, fileName: null });
      renderNewtabBg();
    });
  }

  /**
   * What app.js pushes into the new tab guest:
   *   { kind, boardOverImage, dim, dataUrl? }      for kind 'image'
   *   { kind, boardOverImage, dim, fileUrl?, fileName? }  for kind 'video'
   * dataUrl is only present for kind 'image' with a picture actually stored,
   * and is read out of IndexedDB once and then kept in memory.
   */
  function background() {
    var cfg = normalizeBackground(get('newtabBackground'));
    var out = { kind: cfg.kind, boardOverImage: cfg.boardOverImage, dim: cfg.dim };
    if (cfg.kind === 'video') {
      if (cfg.fileUrl) out.fileUrl = cfg.fileUrl;
      if (cfg.fileName) out.fileName = cfg.fileName;
      return Promise.resolve(out);
    }
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

  /**
   * Where the new tab's five shortcuts come from: 'visited' (counted out of
   * the history, the default) or 'list' (the chips above, in order).
   *
   * Only 'list' is ever answered as itself. A missing key, an older file, a
   * typo and anything that is not a string all read as 'visited', so the page
   * never has to guess what a third value would have meant.
   */
  function chipsSource() {
    return get('chipsSource') === 'list' ? 'list' : 'visited';
  }

  /** @returns the value actually stored — 'list', or 'visited' for the rest. */
  function setChipsSource(value) {
    var next = value === 'list' ? 'list' : 'visited';
    set({ chipsSource: next });     // announces under 'chipsSource' for app.js
    return next;
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
     Pinned apps

     Ids. The new tab page's dock is drawn from these joined against the
     installed-app index app.js pushes it, so a pin for an app that has been
     uninstalled costs nothing and comes back if it is reinstalled. app.js
     reads them through appPins() and writes them through setAppPins() when
     the page asks over its console channel.

     Three kinds of id live here now:

       '<hash>'          an installed app, as apps.js hashes it
       'web:<slug>'      a site the browser presents as an app (webapps.js)
       'term:<program>'  a terminal tab

     and a pin may also be an OBJECT carrying options:

       { id, web: true }      the primary click opens the app's web form
       { id, native: true }   ...or opens the app's own window IN a tab

     Those are the only two options a pin carries, which is why the plain
     string stays the stored shape whenever both are off: an old string-only
     file reads back unchanged, and a session that never touches either option
     never grows an object. pinOptions()/setPinOption() are the way in and out
     of it, and setPinOption() takes either key on its own. The two are
     exclusive — a press cannot both open the web form and host the window —
     so turning one ON clears the other, while turning one OFF leaves the
     other exactly where it was.
     ============================================================ */

  /** Anything stored (or handed in) read as a clean list of pins. */
  function normalizeAppPins(value) {
    var out = [];
    var seen = [];
    if (!Array.isArray(value)) return out;
    for (var i = 0; i < value.length; i++) {
      var pin = normalizeAppPin(value[i]);
      if (pin === null) continue;
      var id = pinIdOf(pin);
      if (seen.indexOf(id) >= 0) continue;   // a dock shows an app once
      seen.push(id);
      out.push(pin);
      if (out.length >= APP_PINS_MAX) break;
    }
    return out;
  }

  /* The two helpers the normaliser leans on. Declarations hoist, so they sit
     below it on purpose: the whole pin contract then reads as one block from
     the normaliser down, which is also how the harness slices it. */

  /** The id a stored pin names, '' when it does not name one. */
  function pinIdOf(pin) {
    var raw = null;
    if (typeof pin === 'string' || typeof pin === 'number') raw = pin;
    else if (pin && typeof pin === 'object' && !Array.isArray(pin)) raw = pin.id;
    if (typeof raw !== 'string' && typeof raw !== 'number') return '';
    return String(raw).trim();
  }

  /**
   * One pin, in the shape it is stored in: a bare id string, or
   * `{ id, web: true }` / `{ id, native: true }` when an option is on — both
   * keys when both are. null when it is junk. Only the options that are ON are
   * written, so the stored object never carries a `false` nobody set.
   */
  function normalizeAppPin(pin) {
    var id = pinIdOf(pin);
    if (!id || id.length > APP_ID_MAX) return null;
    var obj = (pin && typeof pin === 'object' && !Array.isArray(pin)) ? pin : null;
    var web = !!(obj && obj.web);
    var native = !!(obj && obj.native);
    if (!web && !native) return id;   // the plain string an old file reads as
    var out = { id: id };
    if (web) out.web = true;
    if (native) out.native = true;
    return out;
  }

  function appPins() {
    var group = get('apps');
    return normalizeAppPins(group && typeof group === 'object' ? group.pins : null);
  }

  /** Just the ids, in dock order — for a caller that only needs the join. */
  function appPinIds() {
    var list = appPins();
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(pinIdOf(list[i]));
    return out;
  }

  /**
   * Replace the whole list. Normalised on the way in, so a caller may hand
   * over the page's raw array; set() emits only when the stored value really
   * moved, which is what keeps app.js from re-pushing an unchanged dock.
   * @returns {string[]} the list as it is now stored.
   */
  function setAppPins(ids) {
    var next = normalizeAppPins(ids);
    var group = get('apps');
    var patch = {};
    if (group && typeof group === 'object' && !Array.isArray(group)) {
      for (var k in group) {
        if (Object.prototype.hasOwnProperty.call(group, k)) patch[k] = group[k];
      }
    }
    patch.pins = next;
    set({ apps: patch });
    return appPins();
  }

  /**
   * The options a pin carries. Answers `{ web: false, native: false }` for a
   * pin that is a plain string, for one whose options are off, and for an id
   * that is not pinned at all — the caller asking about a tile it is about to
   * draw. Both keys are always present, so no caller has to test for one.
   */
  function pinOptions(id) {
    var key = pinIdOf(id);
    var out = { web: false, native: false };
    if (!key) return out;
    var list = appPins();
    for (var i = 0; i < list.length; i++) {
      if (pinIdOf(list[i]) !== key) continue;
      var pin = list[i];
      var obj = (pin && typeof pin === 'object') ? pin : null;
      out.web = !!(obj && obj.web);
      out.native = !!(obj && obj.native);
      return out;
    }
    return out;
  }

  /**
   * Turn one pin's options on or off, leaving its place in the dock alone.
   * `opts` is a PATCH: a key that is not in it is left exactly as it was, so
   * `{ native: true }` cannot quietly clear the web option a previous press set.
   * The two options are exclusive, so a patch that turns ONE ON clears the
   * other; a patch that turns one off leaves the other alone.
   * Idempotent: set() only announces when the stored value really moved, and
   * both options off writes the plain string back, so a session that toggles
   * one off leaves a file indistinguishable from one that never touched it.
   * Does NOT pin anything — an id that is not in the dock is left alone.
   * @returns {{web:boolean, native:boolean}} the options as they now stand.
   */
  function setPinOption(id, opts) {
    var key = pinIdOf(id);
    var none = { web: false, native: false };
    if (!key) return none;
    var patch = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
    var list = appPins();
    var next = [];
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (pinIdOf(list[i]) === key) {
        found = true;
        var was = list[i];
        var obj = (was && typeof was === 'object') ? was : null;
        var setsWeb = Object.prototype.hasOwnProperty.call(patch, 'web');
        var setsNative = Object.prototype.hasOwnProperty.call(patch, 'native');
        var web = setsWeb ? !!patch.web : !!(obj && obj.web);
        var native = setsNative ? !!patch.native : !!(obj && obj.native);
        // The two are EXCLUSIVE: one primary click cannot both open the web
        // form and host the app's window, and the dock draws them as one
        // three-way choice (program / web / tab). So turning one ON turns the
        // other off — without this, "as a web app" on a pin already set to
        // "in a tab" stored both, the badge went on saying `tab` and the press
        // went on opening the tab, and the option could not be changed back at
        // all. Turning one OFF still leaves the other exactly as it was, which
        // is what makes the dock's "the program itself" row work.
        if (setsWeb && web) native = false;
        else if (setsNative && native) web = false;
        // normalizeAppPin() is the one place the stored shape is decided, so
        // this hands it the flags and lets it write the string or the object.
        next.push(normalizeAppPin({ id: key, web: web, native: native }));
      } else {
        next.push(list[i]);
      }
    }
    if (!found) return none;
    setAppPins(next);
    return pinOptions(key);
  }

  /* ============================================================
     Idle music

     Quiet music while nothing else in the browser is making a sound. The
     player lives in the chrome, not in a guest, so it survives tab
     switches; this is only where the choice is kept:

       { enabled, source: 'ambient'|'files', where: 'newtab'|'anywhere',
         volume: 0..1, files: [{ path, name }], shuffle }

     The tracks are referenced, never copied — only the path and the name a
     row shows are stored, so moving a file just makes that one skip.

     Every change is announced twice: once through the ordinary listener
     list with 'music' among the keys (which is how the background and the
     app dock are announced), and once as a 'music-changed' event on
     `document`, so a module that never subscribed to the store still hears
     it. Nothing here restarts anything: it all applies live.
     ============================================================ */

  var MUSIC_SOURCES = [
    { value: 'ambient', name: 'Built-in ambient' },
    { value: 'files', name: 'My tracks' }
  ];

  var MUSIC_WHERE = [
    { value: 'newtab', name: 'New tab page only' },
    { value: 'anywhere', name: 'Anywhere in the browser' }
  ];

  var MUSIC_VOLUME_DEFAULT = 0.35;
  var MUSIC_FILES_MAX = 500;        // a lobby playlist, not a music library
  var MUSIC_PATH_MAX = 1024;        // past Windows' long path, and then some
  var MUSIC_NAME_MAX = 200;

  /** A stored value kept only while the option list still offers it. */
  function pickValue(options, value, fallback) {
    for (var i = 0; i < options.length; i++) {
      if (options[i].value === value) return value;
    }
    return fallback;
  }

  /** The last segment of a path, either slash, as the name a row shows. */
  function musicBaseName(path) {
    var parts = String(path).split(/[\\/]+/);
    var last = parts[parts.length - 1] || '';
    return last || String(path);
  }

  /** The chosen tracks, read as a clean list: a path and a name each. */
  function normalizeMusicFiles(value) {
    var out = [];
    var seen = [];
    if (!Array.isArray(value)) return out;
    for (var i = 0; i < value.length; i++) {
      var raw = value[i];
      var path = '';
      var name = '';
      if (typeof raw === 'string') path = raw;
      else if (raw && typeof raw === 'object') {
        path = typeof raw.path === 'string' ? raw.path : '';
        name = typeof raw.name === 'string' ? raw.name : '';
      }
      path = path.trim();
      if (!path || path.length > MUSIC_PATH_MAX) continue;
      var key = path.toLowerCase();
      if (seen.indexOf(key) >= 0) continue;       // a playlist plays a file once
      seen.push(key);
      name = name.trim() || musicBaseName(path);
      if (name.length > MUSIC_NAME_MAX) name = name.slice(0, MUSIC_NAME_MAX);
      out.push({ path: path, name: name });
      if (out.length >= MUSIC_FILES_MAX) break;
    }
    return out;
  }

  /** Anything stored (or handed in) read as a complete, in-range group. */
  function normalizeMusic(value) {
    var v = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    /* null, undefined and '' are "never set", not zero — a stored group from
       an older build must not come back silent. */
    var volume = (v.volume === null || v.volume === undefined || v.volume === '')
      ? MUSIC_VOLUME_DEFAULT : Number(v.volume);
    if (!isFinite(volume)) volume = MUSIC_VOLUME_DEFAULT;
    return {
      enabled: v.enabled === true,
      source: pickValue(MUSIC_SOURCES, v.source, 'ambient'),
      where: pickValue(MUSIC_WHERE, v.where, 'newtab'),
      volume: Math.min(1, Math.max(0, volume)),
      files: normalizeMusicFiles(v.files),
      shuffle: v.shuffle !== false
    };
  }

  function music() {
    return normalizeMusic(get('music'));
  }

  /**
   * Merge part of the group back. Only the keys handed over move, so a
   * caller may write { enabled: true } without knowing the rest, and a
   * value that makes no sense leaves that key where it was rather than
   * dropping it to the default. set() emits with 'music' among its keys
   * when something really changed, and react() fires 'music-changed'.
   * @returns {Object} the group as it is now stored.
   */
  function setMusic(patch) {
    var next = music();
    if (patch && typeof patch === 'object') {
      if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
      if (patch.source !== undefined) next.source = pickValue(MUSIC_SOURCES, patch.source, next.source);
      if (patch.where !== undefined) next.where = pickValue(MUSIC_WHERE, patch.where, next.where);
      if (patch.volume !== undefined) {
        var vol = (patch.volume === null || patch.volume === '') ? NaN : Number(patch.volume);
        if (isFinite(vol)) next.volume = Math.min(1, Math.max(0, vol));
      }
      if (patch.files !== undefined) next.files = normalizeMusicFiles(patch.files);
      if (patch.shuffle !== undefined) next.shuffle = patch.shuffle === true;
    }
    set({ music: next });
    return music();
  }

  /**
   * The group as a document event, for a module that never subscribed to
   * the store. Guarded end to end: a document without dispatchEvent (or a
   * listener that throws) must not take the write down with it.
   */
  function announceMusic() {
    if (!document || typeof document.dispatchEvent !== 'function') return;
    var detail = music();
    try {
      if (typeof window.CustomEvent === 'function') {
        document.dispatchEvent(new window.CustomEvent('music-changed', { detail: detail }));
        return;
      }
    } catch (err) { /* fall through to the older constructor */ }
    try {
      var ev = document.createEvent('CustomEvent');
      ev.initCustomEvent('music-changed', false, false, detail);
      document.dispatchEvent(ev);
    } catch (err) { /* no event path here: the listener list still fired */ }
  }

  /** The preload's file picker, or null on a window started before it. */
  function musicApi() {
    try {
      var api = window.api && window.api.music;
      if (!api || typeof api.chooseFiles !== 'function') return null;
      return api;
    } catch (err) { return null; }
  }

  /**
   * Ask main for tracks. Nothing is copied: the dialog hands back
   * [{ path, name }] and those are stored as they are, added to whatever is
   * already listed. A cancel answers with nothing and changes nothing.
   * @returns {Promise<{ok:boolean, added?:number, total?:number, reason?:string}>}
   */
  function chooseMusicFiles() {
    var api = musicApi();
    if (!api) return Promise.resolve({ ok: false, reason: 'unavailable' });
    var answer;
    /* autopauseReason() is this file's "a failure as a sentence" helper —
       hoisted, so reaching it from up here is fine. */
    try { answer = api.chooseFiles(); }
    catch (err) { return Promise.resolve({ ok: false, reason: autopauseReason(err) }); }
    return Promise.resolve(answer).then(function (value) {
      var picked = Array.isArray(value)
        ? value
        : ((value && Array.isArray(value.files)) ? value.files : []);
      var list = normalizeMusicFiles(picked);
      if (!list.length) return { ok: false, reason: 'cancelled' };
      var before = music().files;
      var stored = setMusic({ files: before.concat(list) }).files;
      return { ok: true, added: Math.max(0, stored.length - before.length), total: stored.length };
    }, function (err) {
      return { ok: false, reason: autopauseReason(err) };
    });
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
    var s = light ? 90 : 45;
    var l = light ? 44 : 62;
    for (i = 0; i < ACCENT_TOKENS.length; i++) {
      var name = ACCENT_TOKENS[i][0];
      var alpha = ACCENT_TOKENS[i][1] === null ? null : ACCENT_TOKENS[i][light ? 2 : 1];
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

  /* ============================================================
     Folds — a section is a heading and a body that starts closed
     ============================================================ */

  /**
   * A section: a heading that is its own toggle, and a body that ships
   * folded. Everything a caller appends lands in the body — that is what the
   * redirected `appendChild` is for, so none of the builders below had to
   * learn about the fold, and a control added long after the build (a render
   * pass, an IPC answer) still lands inside it rather than beside it.
   */
  function section(title) {
    var s = el('section', 'set-section set-foldable');
    var body = el('div', 'set-collapse');
    body.id = 'set-fold-' + (++foldSeq);
    s.appendChild(foldHead(title, body.id, s));
    s.appendChild(body);
    s.setAttribute('data-fold-was', '0');
    applyFold(s, false);
    /* An own property: it shadows Node.prototype for this element alone. */
    s.appendChild = function (node) { return body.appendChild(node); };
    return s;
  }

  /**
   * A section with no fold at all: a plain <h2> and the content under it,
   * always there. About is the only one (The user) — it is three lines and a
   * button, so a fold would hide less than the control costs. Nothing here
   * carries .set-foldable, so collapseAllFolds() and the filter's
   * unfold-the-hits pass both walk straight past it.
   */
  function plainSection(title) {
    var s = el('section', 'set-section');
    s.appendChild(el('h2', 'set-h', title));
    return s;
  }

  /**
   * The heading as a real <button>, so Tab reaches it and Enter works, and
   * with aria-expanded so a screen reader hears the state rather than the
   * chevron. It has to read exactly like the <h2> it replaced: .set-h paints
   * it, and settings.css only undoes what a button brings of its own.
   */
  function foldHead(title, bodyId, s) {
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'set-h set-h-toggle';
    head.setAttribute('aria-expanded', 'false');
    head.setAttribute('aria-controls', bodyId);
    head.appendChild(el('span', 'set-h-text', title));
    /* Rotated by CSS when the section opens, so the glyph is the state. */
    var chev = el('span', 'set-h-chev', '›');
    chev.setAttribute('aria-hidden', 'true');
    head.appendChild(chev);
    head.addEventListener('click', function () { toggleFold(s); });
    /* A <button> already turns Enter and Space into a click; taking the key
       ourselves keeps the panel's other key handling out of it, and the
       preventDefault is what stops the second, native toggle. */
    head.addEventListener('keydown', function (ev) {
      var key = ev && ev.key;
      if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      toggleFold(s);
    });
    return head;
  }

  /** The header is the record of the state, so nothing can drift from it. */
  function isFoldOpen(s) {
    var head = s && s.querySelector ? s.querySelector('.set-h-toggle') : null;
    return !!head && head.getAttribute('aria-expanded') === 'true';
  }

  /**
   * Paint one fold. The body carries `hidden`, so it is out of the tab order
   * and out of the accessibility tree while folded; `is-open` is only for the
   * chevron. Never re-renders: a folded section still holds a fully rendered
   * list. Folding away the row that is recording cancels the recording,
   * rather than leaving a hidden row eating keystrokes.
   */
  function applyFold(s, open) {
    if (!s) return;
    var head = s.querySelector('.set-h-toggle');
    var body = s.querySelector('.set-collapse');
    if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (body) body.hidden = !open;
    if (s.classList) {
      if (open) s.classList.add('is-open');
      else s.classList.remove('is-open');
    }
    if (!open && s === shortcutsSectionEl && recId !== null) stopRecording();
  }

  /** The reader's own toggle. data-fold-was is what a filter hands back. */
  function toggleFold(s) {
    if (!s) return;
    var open = !isFoldOpen(s);
    if (s.setAttribute) s.setAttribute('data-fold-was', open ? '1' : '0');
    applyFold(s, open);
  }

  /**
   * Every open starts folded. Nothing is stored, so there is nothing to read
   * back: whatever was left open last time is gone. About has no fold, so it
   * is not in this list at all.
   */
  function collapseAllFolds() {
    if (!bodyEl) return;
    foldsForced = false;
    var sections = bodyEl.querySelectorAll('.set-foldable');
    for (var i = 0; i < sections.length; i++) {
      sections[i].setAttribute('data-fold-was', '0');
      applyFold(sections[i], false);
    }
  }

  /**
   * A search must not hide its own hits: while the filter has words every
   * section still showing is held open, and clearing the box puts the
   * reader's own folds back. Runs after applyFilter() has set `hidden`,
   * which is how it knows which sections hold a match.
   */
  function syncFolds(filtering) {
    if (!bodyEl) return;
    var sections = bodyEl.querySelectorAll('.set-foldable');
    var i;
    if (filtering) {
      if (!foldsForced) {
        foldsForced = true;
        for (i = 0; i < sections.length; i++) {
          sections[i].setAttribute('data-fold-was', isFoldOpen(sections[i]) ? '1' : '0');
        }
      }
      for (i = 0; i < sections.length; i++) applyFold(sections[i], !sections[i].hidden);
      return;
    }
    if (!foldsForced) return;
    foldsForced = false;
    for (i = 0; i < sections.length; i++) {
      applyFold(sections[i], sections[i].getAttribute('data-fold-was') === '1');
    }
  }

  /**
   * Open the panel at one section — what a deep link from elsewhere in the
   * browser needs. Matches on the heading text, unfolds that section (About
   * has no fold to undo) and brings it into view; an unknown name leaves the
   * panel exactly as it is.
   */
  function revealSection(title) {
    if (!bodyEl) return false;
    var want = String(title == null ? '' : title).trim().toLowerCase();
    if (!want) return false;
    var sections = bodyEl.querySelectorAll('.set-section');
    for (var i = 0; i < sections.length; i++) {
      /* .set-h-text inside a fold's button, the <h2> itself when there is no
         fold — either way, the heading is the name. */
      var head = sections[i].querySelector('.set-h-text') || sections[i].querySelector('.set-h');
      var name = head ? String(head.textContent || '').trim().toLowerCase() : '';
      if (name !== want) continue;
      if (sections[i].classList && sections[i].classList.contains('set-foldable')) {
        sections[i].setAttribute('data-fold-was', '1');
        applyFold(sections[i], true);
      }
      /* Instant, not smooth: a smooth scroll asked for in the same task that
         un-hides the popover never runs here (measured — the body stays at
         scrollTop 0), and the pane has no motion of its own to match. */
      try {
        sections[i].scrollIntoView({ block: 'start' });
      } catch (err) {
        sections[i].scrollIntoView(true);   // older signature, same landing
      }
      return true;
    }
    return false;
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

    var skip = el('div', 'set-field');
    skip.setAttribute('data-field', 'claudeskip');
    s.appendChild(skip);

    var notify = el('div', 'set-field');
    notify.setAttribute('data-field', 'claudenotify');
    s.appendChild(notify);
    return s;
  }

  function renderClaude() {
    renderClaudeDir();
    renderClaudeResume();
    renderClaudeSkip();
    renderClaudeNotify();
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

  function renderClaudeSkip() {
    var field = bodyEl && bodyEl.querySelector('[data-field="claudeskip"]');
    if (!field) return;
    field.textContent = '';

    field.appendChild(switchRow(
      'Skip permission prompts',
      get('claudeSkipPermissions') !== false,
      function (next) { set({ claudeSkipPermissions: next }); }
    ));

    var hint = el('p', 'set-hint');
    hint.appendChild(document.createTextNode('Every Claude tab starts with '));
    hint.appendChild(el('code', 'set-code', 'claude --dangerously-skip-permissions'));
    hint.appendChild(document.createTextNode(', so nothing waits on a confirmation.'));
    field.appendChild(hint);
  }

  function renderClaudeNotify() {
    var field = bodyEl && bodyEl.querySelector('[data-field="claudenotify"]');
    if (!field) return;
    field.textContent = '';

    field.appendChild(switchRow(
      'Notify me when a Claude tab is waiting',
      get('claudeNotify') !== false,
      function (next) { set({ claudeNotify: next }); }
    ));

    field.appendChild(el(
      'p',
      'set-hint',
      'A quiet Windows notification when a session finishes while you’re elsewhere.'
    ));
  }

  function buildTabs() {
    var s = section('Tabs');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'tabsleep');
    s.appendChild(field);
    // The workspace half of the same idea, in the same section: both answers
    // are "what may stop running while you are not looking at it".
    var ws = el('div', 'set-field');
    ws.setAttribute('data-field', 'wssleep');
    s.appendChild(ws);
    return s;
  }

  /** The stored workspace sleep policy; anything unrecognised is the default. */
  function workspaceSleepMode() {
    var value = get('workspaceSleep');
    for (var i = 0; i < WORKSPACE_SLEEP.length; i++) {
      if (WORKSPACE_SLEEP[i].id === value) return value;
    }
    return DEFAULTS.workspaceSleep;
  }

  function renderWorkspaceSleep() {
    var field = bodyEl && bodyEl.querySelector('[data-field="wssleep"]');
    if (!field) return;
    field.textContent = '';

    var mode = workspaceSleepMode();
    field.appendChild(controlRow(
      'In workspaces you are not in, sleep',
      null,
      segmented(WORKSPACE_SLEEP, mode, function (next) {
        set({ workspaceSleep: next });
      })
    ));

    if (mode === 'all') {
      var minutes = Number(get('workspaceSleepMinutes'));
      if (!isFinite(minutes) || minutes < 0) minutes = DEFAULTS.workspaceSleepMinutes;
      field.appendChild(controlRow(
        'once the workspace has been left for',
        'set-ws-sleep',
        glassSelect('set-ws-sleep', WORKSPACE_AWAY_TIMES, minutes, function (value) {
          set({ workspaceSleepMinutes: Number(value) });
        })
      ));
    }

    // One plain sentence per choice — what it does and what it costs.
    var hint = 'Off: every workspace keeps all of its pages running, '
      + 'whether or not you are looking at it.';
    if (mode === 'newtab') {
      hint = 'Sleep new tab pages in workspaces you are not looking at '
        + '(they come back fresh). Nothing else in them sleeps.';
    } else if (mode === 'all') {
      hint = 'Sleep every page in a workspace you have been away from that long '
        + '(pages reload when you return; new tab pages come back fresh). '
        + 'Claude tabs and app tabs never sleep.';
    }
    field.appendChild(el('p', 'set-hint', hint));
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

  function buildDownloads() {
    var s = section('Downloads');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'downloads');
    s.appendChild(field);
    return s;
  }

  function renderDownloads() {
    var field = bodyEl && bodyEl.querySelector('[data-field="downloads"]');
    if (!field) return;
    field.textContent = '';

    var on = get('downloadsAskWhere') === true;
    field.appendChild(switchRow('Ask where to save each file', on, function (next) {
      set({ downloadsAskWhere: !!next });
    }));
    field.appendChild(el('p', 'set-hint',
      'Off: files go straight to your Downloads folder.'));
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

  /* ============================================================
     Browser style

     Site styles paint web pages; this paints the browser around them.
     window.UserStyle owns the string and the <style> element it goes
     into, exactly as SiteStyles owns its store — the panel is one more
     view of it, and a build without that module simply says so.

     One field, two buttons, and a list of the tokens worth knowing:
     every colour in chrome.css resolves through one, so naming twelve
     of them turns "restyle the browser" from reading a stylesheet into
     writing three lines.
     ============================================================ */

  /** The module, or null when this build shipped without it. */
  function userStyle() {
    var m = window.UserStyle;
    if (!m) return null;
    if (typeof m.get !== 'function' || typeof m.set !== 'function') return null;
    if (typeof m.clear !== 'function') return null;
    return m;
  }

  /* The tokens a person actually reaches for, in the order chrome.css
     declares them: the two inks, the three text weights, the three
     glass steps, the hairline, the two lights, and the panel backing. */
  var CHROME_TOKENS = [
    ['--ink-0', 'The deepest background, behind everything else'],
    ['--ink-1', 'One step up from that: the second ink layer'],
    ['--fg', 'Text, at full strength'],
    ['--fg-2', 'Quieter text: labels and second lines'],
    ['--fg-3', 'The faintest text that is still readable: hints'],
    ['--glass', 'A frosted surface at rest'],
    ['--glass-2', 'The same surface, hovered'],
    ['--glass-3', 'The same surface, held down or selected'],
    ['--edge', 'The hairline around every glass pane'],
    ['--ion', 'The cool blue light that marks what is active'],
    ['--amber', 'The one warm light: a live Claude session'],
    ['--panel-bg', 'The solid backing of a panel floating over a page']
  ];

  function buildUserStyle() {
    var s = section('Browser style');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'userstyle');
    s.appendChild(field);
    return s;
  }

  /** The token crib sheet, closed until someone wants it. */
  function tokenSheet() {
    var d = el('details', 'set-tokens');
    d.appendChild(el('summary', 'set-tokens-sum', 'Common tokens'));
    var list = el('dl', 'set-tokens-list');
    CHROME_TOKENS.forEach(function (t) {
      list.appendChild(el('dt', 'set-token-name', t[0]));
      list.appendChild(el('dd', 'set-token-what', t[1]));
    });
    d.appendChild(list);
    return d;
  }

  function renderUserStyle() {
    var field = bodyEl && bodyEl.querySelector('[data-field="userstyle"]');
    if (!field) return;
    field.textContent = '';

    var api = userStyle();
    if (!api) {
      field.appendChild(el('p', 'set-na', 'Not available'));
      return;
    }

    var current = '';
    try { current = String(api.get() || ''); } catch (err) { current = ''; }

    var ta = document.createElement('textarea');
    ta.className = 'set-css set-userstyle';
    ta.spellcheck = false;
    ta.placeholder = '/* your CSS for the browser itself */\n#omnibox { border-radius: 6px; }';
    ta.setAttribute('aria-label', 'CSS for the browser itself');
    ta.value = current;
    // Escape leaves the field first; a second press then closes the panel.
    ta.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      ta.blur();
    });
    field.appendChild(ta);

    var acts = el('div', 'set-site-acts');
    acts.appendChild(textButton('Apply', 'set-btn', function () {
      /* A module that answers false rejected the sheet and has already
         said why; anything else (including a bare undefined) took it. */
      var stored = true;
      try { stored = api.set(ta.value); } catch (err) { stored = false; }
      if (stored !== false) showToast('Applied');
    }));

    /* Reset is two presses, and neither of them re-renders: the field
       holds whatever the user has typed, and only a real clear empties
       it. The arming press just relabels the button it is on. */
    var armed = false;
    var armTimer = 0;
    var reset = textButton('Reset', 'set-text set-userstyle-reset', function () {
      if (!armed) {
        armed = true;
        reset.textContent = 'Press again to reset';
        reset.classList.add('is-armed');
        window.clearTimeout(armTimer);
        armTimer = window.setTimeout(function () {
          if (!armed) return;
          armed = false;
          reset.textContent = 'Reset';
          reset.classList.remove('is-armed');
        }, 4000);
        return;
      }
      armed = false;
      window.clearTimeout(armTimer);
      try { api.clear(); } catch (err) { /* module's problem */ }
      renderUserStyle();
      showToast('Browser style reset');
    });
    acts.appendChild(reset);
    field.appendChild(acts);

    field.appendChild(el('p', 'set-hint',
      "Styles the browser's own chrome, not web pages. Every colour is a token: " +
      'try --ion, --glass, --panel-bg. Ctrl+Alt+Shift+R resets if you break something.'));
    field.appendChild(tokenSheet());
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

  /** The black behind the picture or the clip — the same control for both. */
  function bgDimRow(cfg) {
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
    return controlRow('Dim', 'set-bg-dim', dim);
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

    if (cfg.kind === 'video') {
      /* No hidden <input type="file"> here: the renderer could read the clip,
         but it must keep playing after the original moves, so main copies it
         in and hands back the file:// URL. */
      var vrow = el('div', 'set-bg-row');
      vrow.appendChild(el('span', 'set-hint set-bg-name',
        cfg.fileUrl ? (cfg.fileName || 'Chosen clip') : 'No file chosen'));
      vrow.appendChild(textButton('Choose file…', 'set-btn set-bg-pick', function () {
        chooseBackgroundVideo().then(function (res) {
          if (res && res.ok) { showToast('New tab background set'); return; }
          var why = res && res.reason;
          if (!why || why === 'cancelled') return;     // he changed his mind
          showToast(why === 'too-large' ? 'That clip is over 512 MB' : why);
        });
      }));
      if (cfg.fileUrl) {
        vrow.appendChild(textButton('Remove', 'set-text set-bg-drop', function () {
          removeBackgroundVideo();
        }));
      }
      field.appendChild(vrow);

      field.appendChild(switchRow('Show circuit board over the video', cfg.boardOverImage,
        function (next) { setBackground({ boardOverImage: next }); }));
      field.appendChild(bgDimRow(cfg));
      field.appendChild(el('p', 'set-hint',
        "A muted loop behind the board's tiles. It pauses whenever the page is not in front."));
      if (!canChooseVideo()) {
        field.appendChild(el('p', 'set-hint',
          'Restart the browser to pick a clip — this window was started before moving pictures existed.'));
      }
      return;
    }

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

    field.appendChild(bgDimRow(cfg));

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

    /* Where the five come from, above the list they may or may not use. On
       'visited' the editor stays live — you can still keep a list ready — but
       it goes quiet, because it is not what the page is reading. */
    var source = chipsSource();
    var seg = segmented(CHIP_SOURCES, source, setChipsSource);
    seg.setAttribute('aria-label', 'Shortcuts');
    field.appendChild(seg);
    field.appendChild(el('p', 'set-hint', CHIP_SOURCE_HINTS[source]));

    var editor = el('div', 'set-chips-editor' + (source === 'list' ? '' : ' set-chips--idle'));

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

    editor.appendChild(rows);

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
    editor.appendChild(add);

    editor.appendChild(textButton('Add current page', 'set-btn', function () {
      bookmarkActivePage();
    }));
    field.appendChild(editor);

    if (focusHint) {
      var target = field.querySelector(focusHint) || bodyEl.querySelector(focusHint);
      focusHint = null;
      if (target && typeof target.focus === 'function') target.focus();
    }
  }

  function buildMusic() {
    var s = section('Idle music');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'music');
    s.appendChild(field);
    return s;
  }

  /** The tracks line: the count, and the one name worth printing. */
  function musicFilesLine(files) {
    var n = files.length;
    if (!n) return 'No tracks chosen';
    if (n === 1) return '1 track: ' + files[0].name;
    return n + ' tracks';
  }

  /** How loud, as a percentage — the dim slider's shape, for a level. */
  function musicVolumeRow(cfg) {
    var wrap = el('span', 'set-bg-dim');
    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.className = 'set-range';
    slider.id = 'set-music-volume';
    slider.value = String(Math.round(cfg.volume * 100));
    slider.setAttribute('aria-label', 'Volume');
    var readout = el('span', 'set-bg-dim-value', Math.round(cfg.volume * 100) + '%');
    // input previews the number without writing; change is the one that stores.
    slider.addEventListener('input', function () { readout.textContent = slider.value + '%'; });
    slider.addEventListener('change', function () { setMusic({ volume: Number(slider.value) / 100 }); });
    wrap.appendChild(slider);
    wrap.appendChild(readout);
    return controlRow('Volume', 'set-music-volume', wrap);
  }

  /**
   * The whole section: the switch, where the sound comes from, where it is
   * allowed to play, and how loud. Every control writes and applies at once
   * — nothing here asks for a restart except the file picker on a window
   * started before the picker existed.
   */
  function renderMusic() {
    var field = bodyEl && bodyEl.querySelector('[data-field="music"]');
    if (!field) return;
    field.textContent = '';

    var cfg = music();
    var redraw = function () { renderMusic(); refreshFilter(); };

    field.appendChild(switchRow('Enabled', cfg.enabled, function (next) {
      setMusic({ enabled: next });
      redraw();
    }));

    field.appendChild(controlRow('Source', 'set-music-source',
      glassSelect('set-music-source', MUSIC_SOURCES, cfg.source, function (value) {
        setMusic({ source: value });
        redraw();
      })));

    if (cfg.source === 'files') {
      /* No hidden <input type="file">: the player keeps these paths for
         later, and a renderer's File objects do not survive a restart. */
      var row = el('div', 'set-bg-row');
      row.appendChild(el('span', 'set-hint set-bg-name', musicFilesLine(cfg.files)));
      var pick = textButton('Choose files…', 'set-btn set-bg-pick', function () {
        chooseMusicFiles().then(function (res) {
          if (res && res.ok) {
            redraw();
            showToast(res.added === 1 ? '1 track added' : res.added + ' tracks added');
            return;
          }
          var why = res && res.reason;
          if (!why || why === 'cancelled' || why === 'unavailable') return;
          showToast(why);
        });
      });
      if (!musicApi()) pick.disabled = true;
      row.appendChild(pick);
      if (cfg.files.length) {
        row.appendChild(textButton('Clear', 'set-text set-bg-drop', function () {
          setMusic({ files: [] });
          redraw();
        }));
      }
      field.appendChild(row);
      if (!musicApi()) {
        field.appendChild(el('p', 'set-hint', 'Restart the browser to pick files'));
      }
    }

    field.appendChild(controlRow('Where', 'set-music-where',
      glassSelect('set-music-where', MUSIC_WHERE, cfg.where, function (value) {
        setMusic({ where: value });
      })));

    field.appendChild(musicVolumeRow(cfg));

    field.appendChild(el('p', 'set-hint',
      'Quiet music while nothing else is playing. ' +
      'It pauses when a tab or Spotify plays sound.'));
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

  /* ------------------------------------------------------------
     Spotify — the auto-pause helper

     A bridge outside the browser pauses the Spotify desktop app
     while something is playing, and this browser's own tabs hold
     it the way the extension in the other browser does. Main owns
     all of it; the section is a readout over window.api.autopause
     and nothing here is stored in localStorage: every value on
     screen came from status(), and every change goes back through
     setEnabled() or setConfig().

     A build whose preload has no autopause — an older main, a
     failed load — renders the "Not installed" state and throws
     nothing: every call goes through autopauseCall(), where a
     missing method, a throw and a rejected promise all land in
     the same handler.
     ------------------------------------------------------------ */

  /* The hosts a fresh install watches. They are here only so the editor has
     something honest to show before the first status() answers — the list in
     force is always the one status() reports. */
  var AUTOPAUSE_SITES = [
    'youtube.com', 'youtube-nocookie.com', 'twitch.tv', 'kick.com', 'vimeo.com',
    'dailymotion.com', 'tiktok.com', 'netflix.com', 'hulu.com', 'disneyplus.com',
    'primevideo.com', 'max.com', 'peacocktv.com', 'crunchyroll.com',
    'lessonplayer.example', 'lessonplayer-academy.example', 'lessons.example'
  ];

  /* 4s: live enough that the readout follows a video starting, slow enough
     that an open pane is not a poll loop. It only runs while the pane is
     open — closePanel() takes the timer and the subscription down again. */
  var AUTOPAUSE_POLL_MS = 4000;

  var apStatus = null;        // the last Status, shaped; null = nothing asked yet
  var apError = null;         // the last failure, in plain English
  var apDrawn = '';           // the signature the section was last drawn from
  var apWatching = false;     // poll + subscription are live (open pane only)
  var apTimer = 0;
  var apOff = null;           // the onStatus unsubscribe, while subscribed
  var apSitesEl = null;       // the host editor, while it is on screen
  var apChecking = false;     // doctor() is in flight
  var apReport = '';          // the last health text
  var apReportOk = false;
  var apReportOpen = false;   // the readout survives a re-render open

  /** The preload bridge, or null when this build has none. */
  function autopauseApi() {
    try {
      var api = window.api && window.api.autopause;
      if (!api || typeof api.status !== 'function') return null;
      return api;
    } catch (err) { return null; }
  }

  /** A failure as a sentence — never an object, never a stack. */
  function autopauseReason(err) {
    var text = '';
    try { text = String((err && err.message) || err || ''); } catch (e) { text = ''; }
    text = text.replace(/^Error:\s*/i, '').trim();
    return text || 'That did not work';
  }

  /**
   * One call to main. A missing api, a missing method, a throw and a
   * rejected promise all end in onDone(value, reason), so nothing in this
   * section can throw out of a click handler. A build with no bridge at all
   * answers (null, null): that is the "Not installed" state, not an error.
   */
  function autopauseCall(name, arg, onDone) {
    var api = autopauseApi();
    if (!api || typeof api[name] !== 'function') { onDone(null, null); return; }
    var answer;
    try { answer = arg === undefined ? api[name]() : api[name](arg); }
    catch (err) { onDone(null, autopauseReason(err)); return; }
    try {
      Promise.resolve(answer).then(
        function (value) { onDone(value, null); },
        function (err) { onDone(null, autopauseReason(err)); }
      );
    } catch (err) { onDone(null, autopauseReason(err)); }
  }

  /** A typed list of hosts, cleaned: no scheme, no path, no repeats. */
  function autopauseHosts(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var host = String(list[i] == null ? '' : list[i]).trim().toLowerCase();
      host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
                 .replace(/[\/?#].*$/, '')
                 .replace(/^\.+/, '');
      if (host && out.indexOf(host) < 0) out.push(host);
    }
    return out;
  }

  /** Whatever main sent, as the Status this section can draw without checks. */
  function autopauseShape(raw) {
    var s = (raw && typeof raw === 'object') ? raw : {};
    var c = (s.config && typeof s.config === 'object') ? s.config : {};
    var sites = autopauseHosts(c.sites);
    var tabs = Number(s.audibleTabs);
    var port = Number(s.port);
    /* Ad quieting: a helper that cannot do it leaves the field out entirely,
       and null is what disables the switch rather than guessing it is off.
       A bare boolean is accepted too, in case the bridge sends it flat. */
    var duck = null;
    if (s.adDuck && typeof s.adDuck === 'object') duck = { enabled: s.adDuck.enabled === true };
    else if (typeof s.adDuck === 'boolean') duck = { enabled: s.adDuck };
    return {
      installed: s.installed === true,
      enabled: s.enabled === true,
      bridge: (s.bridge === 'running' || s.bridge === 'stopped') ? s.bridge : 'unknown',
      port: isFinite(port) && port > 0 ? Math.round(port) : null,
      spotify: s.spotify === true,
      adDuck: duck,
      wePaused: s.wePaused === true,
      browserHold: s.browserHold === true,
      audibleTabs: isFinite(tabs) && tabs > 0 ? Math.round(tabs) : 0,
      config: {
        browserHold: c.browserHold !== false,
        anySite: c.anySite === true,
        sites: sites.length ? sites : AUTOPAUSE_SITES.slice()
      },
      error: (typeof s.error === 'string' && s.error.trim()) ? s.error.trim() : null
    };
  }

  /**
   * What is true right now, in words. Sentence case and no jargon: this line
   * is the section's instrument readout, and it is the only place the state
   * is explained.
   */
  function autopauseSentence() {
    if (!autopauseApi()) return 'Not installed on this computer';
    var s = apStatus;
    /* Asked and never answered — a main that threw, a channel that is gone —
       reads the same as a build with no helper at all. The reason is printed
       underneath; the readout never claims something is running. */
    if (!s) return apError ? 'Not installed on this computer' : 'Checking';
    if (!s.installed) return 'Not installed on this computer';
    if (s.bridge === 'running') {
      if (s.wePaused) return 'Running, holding Spotify paused for a video';
      var where = s.port ? 'Running on port ' + s.port : 'Running';
      return where + (s.spotify ? ', Spotify open' : ', Spotify not open');
    }
    if (s.bridge === 'stopped') return 'Stopped';
    return s.enabled ? 'Turned on, not answering' : 'Stopped';
  }

  /** The pip: ion while it runs, amber while it holds, dim otherwise. */
  function autopauseLight() {
    var s = apStatus;
    if (!autopauseApi() || !s || !s.installed) return '';
    if (s.wePaused) return ' is-hold';
    return s.bridge === 'running' ? ' is-live' : '';
  }

  /** The lit sentence: a pip, then what it means. */
  function autopauseReadout() {
    var p = el('p', 'set-readout');
    var pip = el('span', 'set-pip' + autopauseLight());
    pip.setAttribute('aria-hidden', 'true');    // the sentence carries the meaning
    p.appendChild(pip);
    p.appendChild(el('span', 'set-readout-text', autopauseSentence()));
    return p;
  }

  /** Everything the section draws, in one string: no change, no re-render. */
  function autopauseSignature() {
    var s = apStatus;
    if (!s) return 'none|' + (apError || '') + '|' + (autopauseApi() ? 'api' : 'none');
    return [
      s.installed, s.enabled, s.bridge, s.port, s.spotify, s.wePaused,
      s.adDuck ? (s.adDuck.enabled ? 'duck-on' : 'duck-off') : 'duck-none',
      s.audibleTabs, s.config.browserHold, s.config.anySite,
      s.config.sites.join(' '), s.error || '', apError || ''
    ].join('|');
  }

  /**
   * A Status arrived — from the poll, from a change main pushed, or from a
   * switch that was just thrown. Redraw only when something actually moved,
   * and never out from under a caret sitting in the host editor.
   */
  function autopauseTake(raw, reason) {
    if (raw) apStatus = autopauseShape(raw);
    apError = reason || null;
    var sig = autopauseSignature();
    if (sig === apDrawn) return;
    var active = null;
    try { active = document.activeElement; } catch (err) { active = null; }
    if (apSitesEl && active === apSitesEl) return;   // mid-edit: the blur lands first
    apDrawn = sig;
    renderSpotify();
    refreshFilter();
  }

  function autopausePoll() {
    autopauseCall('status', undefined, autopauseTake);
  }

  /** Open: one subscription and one 4s poll, however often this is called. */
  function autopauseWatch() {
    if (apWatching) return;                    // opened twice is still one of each
    apWatching = true;
    var api = autopauseApi();
    if (api && typeof api.onStatus === 'function') {
      try {
        var off = api.onStatus(function (s) { autopauseTake(s, null); });
        if (typeof off === 'function') apOff = off;
      } catch (err) { apOff = null; }
    }
    autopausePoll();
    if (typeof window.setInterval === 'function') {
      try { apTimer = window.setInterval(autopausePoll, AUTOPAUSE_POLL_MS); }
      catch (err) { apTimer = 0; }
    }
  }

  /** Closed: nothing of this section is left running. */
  function autopauseRelease() {
    apWatching = false;
    if (apTimer && typeof window.clearInterval === 'function') {
      try { window.clearInterval(apTimer); } catch (err) { /* already gone */ }
    }
    apTimer = 0;
    if (apOff) {
      try { apOff(); } catch (err) { /* the channel is already gone */ }
    }
    apOff = null;
  }

  /**
   * Throw a switch. The row moves at once so the pane never feels dead, and
   * whatever main answers with replaces that guess. A build with no bridge
   * does nothing at all: the controls are disabled there anyway.
   */
  function autopauseWrite(method, arg, guess, failed) {
    if (!autopauseApi()) return;
    if (apStatus && typeof guess === 'function') {
      guess(apStatus);
      apDrawn = '';
      renderSpotify();
      refreshFilter();
    }
    autopauseCall(method, arg, function (value, reason) {
      autopauseTake(value, reason);
      if (reason) showToast(failed);
    });
  }

  /**
   * The preload's Spotify controls — the player's own volume, not the
   * auto-pause bridge's switches. A window started before they existed, or
   * a build without them, answers null and the switch is disabled.
   */
  function spotifyApi() {
    try {
      var api = window.api && window.api.spotify;
      if (!api || typeof api.setAdDuck !== 'function') return null;
      return api;
    } catch (err) { return null; }
  }

  /**
   * Throw the ad switch. The row moves at once, the way the auto-pause ones
   * do, and whatever main answers with replaces that guess: a whole Status
   * is taken, anything else leaves the guess standing until the next poll.
   */
  function spotifyWrite(method, arg, guess, failed) {
    var api = spotifyApi();
    if (!api) return;
    if (apStatus && typeof guess === 'function') {
      guess(apStatus);
      apDrawn = '';
      renderSpotify();
      refreshFilter();
    }
    var answer;
    try { answer = api[method](arg); }
    catch (err) { showToast(failed); return; }
    try {
      Promise.resolve(answer).then(function (value) {
        autopauseTake((value && typeof value === 'object') ? value : null, null);
      }, function () { showToast(failed); });
    } catch (err) { showToast(failed); }
  }

  function autopauseSaveSites(text) {
    var list = autopauseHosts(String(text || '').split(/[\s,]+/));
    autopauseWrite('setConfig', { sites: list }, function (s) {
      s.config.sites = list.length ? list : AUTOPAUSE_SITES.slice();
    }, 'Those sites could not be saved');
  }

  function autopauseDoctor() {
    if (apChecking) return;
    apChecking = true;
    renderAutopauseHealth();
    autopauseCall('doctor', undefined, function (value, reason) {
      apChecking = false;
      if (reason) {
        apReportOk = false;
        apReport = reason;
      } else {
        var o = (value && typeof value === 'object') ? value : {};
        var text = typeof o.text === 'string' ? o.text.replace(/\s+$/, '') : '';
        if (!text && o.json) {
          try { text = JSON.stringify(o.json, null, 2); } catch (err) { text = ''; }
        }
        apReportOk = o.ok === true;
        apReport = text || (apReportOk
          ? 'The health check found nothing wrong.'
          : 'The health check answered with nothing.');
      }
      apReportOpen = true;
      renderAutopauseHealth();
      refreshFilter();
    });
  }

  function buildSpotify() {
    var s = section('Spotify');

    var main = el('div', 'set-field');
    main.setAttribute('data-field', 'autopause');
    s.appendChild(main);

    var browser = el('div', 'set-field');
    browser.setAttribute('data-field', 'autopausebrowser');
    s.appendChild(browser);

    var duck = el('div', 'set-field');
    duck.setAttribute('data-field', 'adduck');
    s.appendChild(duck);

    var sites = el('div', 'set-field');
    sites.setAttribute('data-field', 'autopausesites');
    s.appendChild(sites);

    var health = el('div', 'set-field');
    health.setAttribute('data-field', 'autopausehealth');
    s.appendChild(health);
    return s;
  }

  function renderSpotify() {
    renderAutopauseMain();
    renderAutopauseBrowser();
    renderAdDuck();
    renderAutopauseSites();
    renderAutopauseHealth();
  }

  /* ============================================================
     Stocks — the new tab page's live price tile

     THE ONE SECTION WITH NOTHING IN localStorage. Everything here lives in
     MAIN: stocks.js keeps <userData>/stocks.json and is the only process that
     ever holds the Finnhub key. So there is no DEFAULTS entry, no set({…})
     and no `get()` below — the state is whatever describe() last said, and
     every write goes out over window.api.stocks and comes back as the same
     shape. That is the same arrangement the Spotify rows have with the
     bridge, and for a stronger reason: a key in this file's localStorage
     object would be a key any devtools console could read.

     THE KEY ONLY EVER GOES ONE WAY. describe() answers `hasKey` and a
     `keyMask` ('••••4f21'), never the key. So the field is NEVER pre-filled:
     the mask is placeholder text, typing replaces the key, and the eye
     reveals only what has just been typed — a saved key cannot be shown
     because this side does not have it.
     ============================================================ */

  var stkState = null;        // the last describe(), or null before the first
  var stkFocus = '';          // which control to hand focus back to
  var stkShowKey = false;     // the eye: reveal what is being TYPED, only

  /** The preload bridge, or null on a build without one. */
  function stocksApi() {
    var api = window.api && window.api.stocks;
    return api && typeof api.describe === 'function' ? api : null;
  }

  function buildStocks() {
    var s = section('Stocks');

    var sw = el('div', 'set-field');
    sw.setAttribute('data-field', 'stockson');
    s.appendChild(sw);

    var key = el('div', 'set-field');
    key.setAttribute('data-field', 'finnhubkey');
    s.appendChild(key);

    var syms = el('div', 'set-field');
    syms.setAttribute('data-field', 'stocksymbols');
    s.appendChild(syms);

    return s;
  }

  function renderStocks() {
    renderStocksSwitch();
    renderFinnhubKey();
    renderStockSymbols();
  }

  /**
   * Every call into main answers the same describe() shape, so one taker
   * handles all four. A null answer means main refused the call (this is not
   * the chrome) and the section is left exactly as it was.
   */
  function stocksTake(answer) {
    if (!answer || typeof answer !== 'object') return;
    stkState = answer;
    renderStocks();
    refreshFilter();
    if (stkFocus) {
      var back = panelEl && panelEl.querySelector(stkFocus);
      stkFocus = '';
      if (back) { try { back.focus(); } catch (err) { /* re-rendered away */ } }
    }
  }

  /**
   * The write path, shaped like spotifyWrite(): guess the new state so the
   * control moves under the finger, send, and let the real answer correct it.
   * Nothing is stored locally on failure — main is the only side that knows
   * what is saved.
   */
  function stocksWrite(method, arg, guess, failed) {
    var api = stocksApi();
    if (!api || typeof api[method] !== 'function') return;
    if (stkState && typeof guess === 'function') {
      guess(stkState);
      renderStocks();
      refreshFilter();
    }
    var answer;
    try { answer = api[method](arg); }
    catch (err) { showToast(failed); return; }
    try {
      Promise.resolve(answer).then(function (value) {
        if (value) stocksTake(value);
        else showToast(failed);
      }, function () { showToast(failed); });
    } catch (err) { showToast(failed); }
  }

  /** One describe() when the pane opens. Quiet on failure: the rows hold. */
  function stocksRefresh() {
    var api = stocksApi();
    if (!api) { stkState = null; renderStocks(); return; }
    var answer;
    try { answer = api.describe(); } catch (err) { return; }
    try {
      Promise.resolve(answer).then(function (value) {
        if (value) stocksTake(value);
      }, function () { /* leave the last state up */ });
    } catch (err) { /* nothing to take */ }
  }

  function renderStocksSwitch() {
    var field = panelEl && panelEl.querySelector('[data-field="stockson"]');
    if (!field) return;
    field.textContent = '';

    /* No channel at all (an older preload): say so once rather than draw a
       switch that writes nowhere. */
    if (!stocksApi()) {
      field.appendChild(el('p', 'set-hint',
        'This build has no price channel, so the tile stays off.'));
      return;
    }

    var on = !!(stkState && stkState.enabled);
    field.appendChild(switchRow('Live prices on the new tab', on, function (next) {
      stkFocus = '[data-field="stockson"] .set-row';
      stocksWrite('setEnabled', next, function (st) { st.enabled = next; },
        'That switch could not be saved');
    }));
    field.appendChild(el('p', 'set-hint',
      'A tile in the bottom-right corner of the new tab: your symbols, the ' +
      'day’s change and an intraday chart. It holds no connection at all ' +
      'while that tab is not the one on screen.'));
  }

  function renderFinnhubKey() {
    var field = panelEl && panelEl.querySelector('[data-field="finnhubkey"]');
    if (!field) return;
    field.textContent = '';
    if (!stocksApi()) return;

    var has = !!(stkState && stkState.hasKey);
    var mask = (stkState && stkState.keyMask) || '';

    var label = el('label', 'set-label', 'Finnhub API key');
    label.setAttribute('for', 'set-finnhub-key');
    field.appendChild(label);

    var row = el('div', 'set-path-row');

    /* NEVER pre-filled — main does not hand the key back. The mask is the
       placeholder, so an empty field means "leave the saved one alone"
       rather than "clear it", and Remove is the only way to clear it. */
    var input = document.createElement('input');
    input.type = stkShowKey ? 'text' : 'password';
    input.id = 'set-finnhub-key';
    input.className = 'set-path';
    input.value = '';
    input.placeholder = has ? mask : 'Paste your key';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.title = has ? 'A key is saved. Type to replace it.' : 'Paste the key from finnhub.io';
    row.appendChild(input);

    /* The eye reveals what is BEING TYPED and nothing else: a key that is
       already saved is not on this side of the process boundary to show. */
    row.appendChild(textButton(stkShowKey ? 'Hide' : 'Show', 'set-text set-key-eye', function () {
      stkShowKey = !stkShowKey;
      var live = field.querySelector('.set-path');
      var typed = live ? live.value : '';
      renderFinnhubKey();
      var again = field.querySelector('.set-path');
      if (again) {
        again.value = typed;                    // a re-render must not eat it
        try { again.focus(); } catch (err) { /* gone */ }
      }
    }));

    row.appendChild(textButton('Save', 'set-btn set-key-save', function () {
      var live = field.querySelector('.set-path');
      var next = live ? live.value.trim() : '';
      if (!next) return;
      stkShowKey = false;
      stkFocus = '.set-key-save';
      stocksWrite('setKey', next, function (st) {
        st.hasKey = true;
        st.keyState = '';
      }, 'That key could not be saved');
    }));

    if (has) {
      row.appendChild(textButton('Remove', 'set-text set-key-clear', function () {
        stkShowKey = false;
        stkFocus = '.set-path';
        stocksWrite('setKey', '', function (st) {
          st.hasKey = false;
          st.keyMask = '';
          st.keyState = '';
        }, 'That key could not be removed');
      }));
    }

    field.appendChild(row);

    /* Enter saves, the same way the Claude folder field commits on Enter. */
    input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var save = field.querySelector('.set-key-save');
      if (save) save.click();
    });

    if (stkState && stkState.keyState === 'rejected') {
      field.appendChild(el('p', 'set-note', 'Finnhub refused that key'));
    }

    field.appendChild(el('p', 'set-hint', stocksHint(stkState)));
  }

  /**
   * The line under the field. The history sentence is worth saying out loud:
   * a free key's candle endpoint answers 403, so the chart quietly comes from
   * Yahoo instead, and a user who does not know that reads it as broken.
   */
  function stocksHint(st) {
    var where = 'Get a free key at finnhub.io — it streams real-time US ' +
      'stock prices. Stored by the browser itself and never given to a page.';
    if (!st || !st.hasKey) return where;
    if (st.historyPath === 'finnhub') return where + ' The chart’s history comes from Finnhub.';
    if (st.historyPath === 'yahoo') {
      return where + ' Free keys cannot read Finnhub’s candles, so the ' +
        'chart’s history comes from Yahoo instead; the prices are still Finnhub’s.';
    }
    return where;
  }

  /**
   * The watchlist as one comma-separated line, mirroring the tile's own + and
   * x. Committed on blur and on Enter, like the Claude folder row; main
   * normalises, de-duplicates and caps it, and the answer is what gets drawn
   * back, so a typo simply does not survive the round trip.
   */
  function renderStockSymbols() {
    var field = panelEl && panelEl.querySelector('[data-field="stocksymbols"]');
    if (!field) return;
    field.textContent = '';
    if (!stocksApi()) return;

    var list = (stkState && Array.isArray(stkState.symbols)) ? stkState.symbols : [];
    var text = list.join(', ');

    var label = el('label', 'set-label', 'Symbols');
    label.setAttribute('for', 'set-stock-symbols');
    field.appendChild(label);

    var row = el('div', 'set-path-row');
    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'set-stock-symbols';
    input.className = 'set-path';
    input.value = text;
    input.placeholder = 'SPY, QQQ, NVDA';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'characters');
    row.appendChild(input);
    field.appendChild(row);
    field.appendChild(el('p', 'set-hint',
      'The same list the tile’s + and × edit. Eight at most.'));

    var before = text;
    var commit = function () {
      var next = input.value.split(/[\s,]+/).filter(function (s) { return !!s; });
      if (next.join(',').toUpperCase() === before.split(/[\s,]+/).join(',').toUpperCase()) return;
      if (!next.length) { input.value = before; return; }   // an empty list is not a list
      stkFocus = '#set-stock-symbols';
      stocksWrite('setSymbols', next, function (st) { st.symbols = next; },
        'Those symbols could not be saved');
    };
    input.addEventListener('change', commit);               // blur, and Enter
    input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      input.blur();
    });
  }

  /**
   * Quiet the ads instead of pausing them. Spotify will not let anything
   * skip an ad, and muting it outright is what makes the player think it was
   * never heard — so the level goes to the bottom and comes back after.
   * Only a bridge that reports the field can answer, so an older helper (or
   * an older preload) leaves the row disabled with the reason under it.
   */
  function renderAdDuck() {
    var field = bodyEl && bodyEl.querySelector('[data-field="adduck"]');
    if (!field) return;
    field.textContent = '';

    var s = apStatus;
    var api = spotifyApi();
    var live = !!(api && s && s.installed && s.adDuck);

    var row = switchRow('Quiet Spotify ads', !!(live && s.adDuck.enabled), function (next) {
      spotifyWrite('setAdDuck', !!next, function (cur) {
        if (cur.adDuck) cur.adDuck.enabled = !!next;
      }, next ? 'Ad quieting could not be turned on' : 'Ad quieting could not be turned off');
    });
    if (!live) row.disabled = true;
    field.appendChild(row);

    if (!live) {
      field.appendChild(el('p', 'set-note', api
        ? 'The helper on this computer cannot do this yet'
        : 'Restart the browser to use this'));
    }

    field.appendChild(el('p', 'set-hint',
      'Ads still play, at the lowest in-app volume; it goes back to max when the ad ends.'));
  }

  /** The whole-computer switch, and the line that says what is true. */
  function renderAutopauseMain() {
    var field = bodyEl && bodyEl.querySelector('[data-field="autopause"]');
    if (!field) return;
    field.textContent = '';

    var s = apStatus;
    var live = !!(autopauseApi() && s && s.installed);

    var row = switchRow('Pause Spotify while videos play', !!(live && s.enabled), function (next) {
      autopauseWrite('setEnabled', !!next, function (cur) {
        cur.enabled = !!next;
        if (!next) { cur.bridge = 'stopped'; cur.port = null; cur.wePaused = false; }
      }, next ? 'Spotify auto-pause could not be started' : 'Spotify auto-pause could not be stopped');
    });
    if (!live) row.disabled = true;
    field.appendChild(row);

    field.appendChild(autopauseReadout());

    var trouble = apError || (s && s.error) || null;
    if (trouble) field.appendChild(el('p', 'set-note', trouble));

    field.appendChild(el('p', 'set-hint',
      'On means the helper runs for the whole computer, not just this browser: ' +
      'Spotify pauses while a video plays anywhere, and starts again after.'));
  }

  /** This browser's own tabs, and how many of them are playing. */
  function renderAutopauseBrowser() {
    var field = bodyEl && bodyEl.querySelector('[data-field="autopausebrowser"]');
    if (!field) return;
    field.textContent = '';

    var s = apStatus;
    var usable = !!(autopauseApi() && s && s.installed);

    var row = switchRow('Also pause for videos in this browser',
      !!(s && s.config.browserHold), function (next) {
        autopauseWrite('setConfig', { browserHold: !!next }, function (cur) {
          cur.config.browserHold = !!next;
        }, 'That switch could not be saved');
      });
    if (!usable) row.disabled = true;
    field.appendChild(row);

    var n = s ? s.audibleTabs : 0;
    if (n > 0) {
      field.appendChild(el('p', 'set-count',
        n === 1 ? '1 tab is playing right now' : n + ' tabs are playing right now'));
    }

    field.appendChild(el('p', 'set-hint',
      'Tabs in this browser hold Spotify the same way the extension does in your other one. ' +
      'A muted tab does not count, so muting the video hands the music back.'));
  }

  /** Any sound at all, or only the sites named underneath. */
  function renderAutopauseSites() {
    var field = bodyEl && bodyEl.querySelector('[data-field="autopausesites"]');
    if (!field) return;
    field.textContent = '';
    apSitesEl = null;

    var s = apStatus;
    var usable = !!(autopauseApi() && s && s.installed);
    var any = !!(s && s.config.anySite);

    var row = switchRow('Any tab that makes sound', any, function (next) {
      autopauseWrite('setConfig', { anySite: !!next }, function (cur) {
        cur.config.anySite = !!next;
      }, 'That switch could not be saved');
    });
    if (!usable) row.disabled = true;
    field.appendChild(row);

    if (any) {
      field.appendChild(el('p', 'set-hint',
        'Every tab that makes a sound counts. Turn this off to name the sites yourself.'));
      return;
    }

    var label = el('label', 'set-label', 'Sites that count as a video');
    label.setAttribute('for', 'set-autopause-sites');
    field.appendChild(label);

    var ta = document.createElement('textarea');
    ta.id = 'set-autopause-sites';
    ta.className = 'set-hosts';
    ta.spellcheck = false;
    ta.setAttribute('aria-label', 'Sites that count as a video');
    ta.placeholder = 'youtube.com';
    ta.value = (s ? s.config.sites : AUTOPAUSE_SITES).join('\n');
    if (!usable) ta.disabled = true;
    // Escape leaves the field first; a second press then closes the panel.
    ta.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      ta.blur();
    });
    ta.addEventListener('change', function () { autopauseSaveSites(ta.value); });
    apSitesEl = ta;
    field.appendChild(ta);

    field.appendChild(el('p', 'set-hint',
      'One host per line. Subdomains count too, so youtube.com covers m.youtube.com.'));
  }

  /** doctor(), and its answer kept in a readout you can shut again. */
  function renderAutopauseHealth() {
    var field = bodyEl && bodyEl.querySelector('[data-field="autopausehealth"]');
    if (!field) return;
    field.textContent = '';

    var api = autopauseApi();
    var button = textButton(apChecking ? 'Checking…' : 'Check health', 'set-btn', function () {
      autopauseDoctor();
    });
    if (!api || typeof api.doctor !== 'function' || apChecking) button.disabled = true;
    field.appendChild(button);

    if (apReport) {
      var box = el('details', 'set-tokens set-health');
      if (apReportOpen) box.setAttribute('open', '');
      var sum = el('summary', 'set-tokens-sum' + (apReportOk ? '' : ' is-wrong'),
        apReportOk ? 'Health report' : 'Health report, something is wrong');
      box.appendChild(sum);
      box.appendChild(el('pre', 'set-health-text', apReport));
      box.addEventListener('toggle', function () {
        apReportOpen = box.hasAttribute('open');
      });
      field.appendChild(box);
    }

    field.appendChild(el('p', 'set-hint',
      'Reads the helper without changing anything: the task, the bridge, and Spotify itself.'));
  }

  /* ============================================================
     Phone - the user's phone on the screen

     LIKE STOCKS, NOTHING HERE IS IN localStorage. Every value is
     main's: phone.js owns the tools (adb + the scrcpy server), the
     pairing, the connection and the stream, and this section is a
     window onto its describe() plus the commands in its contract.
     So there is no DEFAULTS entry and no get()/set() below - the
     rows are whatever main last said, and every write goes out as
     api.phone.command(name, arg) and comes back as { ok, reason }.

     AND EVERY REASON IS SHOWN. A command that fails answers
     { ok: false, reason } and that reason is printed against the
     button that sent it, verbatim: while phone.js is still a
     scaffold, pressing Connect says so in those words rather than
     doing nothing. The same goes for a missing bridge, a describe()
     that answers null (main refused: not the chrome) and a call
     that throws. Nothing in this section may fail quietly.
     ============================================================ */

  var phnState = null;        // the last describe(), or null before the first
  var phnStateReason = '';    // why there is no state, when there is none
  var phnOff = null;          // the onUpdate unsubscribe, while the panel is open
  var phnWatching = false;
  var phnBusy = '';           // which command is in flight, so its button says so
  var phnResults = {};        // slot -> { ok, reason }: the last answer, shown inline
  var phnDraft = {};          // what is typed in the fields, kept across re-renders
  var phnForgetArmed = false;
  var phnForgetTimer = 0;

  /* Both readouts and every button key off these. 'error' is amber rather
     than unlit on purpose: something IS happening, and it is wrong. */
  var PHONE_LIVE = { ready: 1, paired: 1, connected: 1, running: 1 };
  var PHONE_HOLD = {
    downloading: 1, pairing: 1, connecting: 1, starting: 1,
    stalled: 1, unreachable: 1, error: 1
  };

  /** The preload bridge, or null on a build without one. */
  function phoneApi() {
    var api = window.api && window.api.phone;
    return api && typeof api.describe === 'function' ? api : null;
  }

  function phoneErrText(err) {
    if (!err) return 'no reason given';
    if (err.message) return String(err.message);
    return String(err);
  }

  /* --- the small pieces every field is built out of ------------- */

  function phoneLight(state) {
    if (PHONE_LIVE[state]) return ' is-live';
    if (PHONE_HOLD[state]) return ' is-hold';
    return '';
  }

  /** A pip, the state as a word, and the reason behind it, never dropped. */
  function phoneReadout(label, state, reason) {
    var p = el('p', 'set-readout');
    p.appendChild(el('span', 'set-pip' + phoneLight(state)));
    var text = label + ': ' + (state || 'unknown');
    if (reason) text += ' - ' + reason;
    p.appendChild(el('span', 'set-readout-text', text));
    return p;
  }

  /** A name on the left, a value on the right. Readouts only; nothing typed. */
  function phoneRow(label, value) {
    var row = el('div', 'set-ctl-row');
    row.appendChild(el('span', 'set-ctl-label', label));
    row.appendChild(el('span', 'set-readout-text', value));
    return row;
  }

  /**
   * A typed field. `phnDraft` is what is in it, so an onUpdate push landing
   * mid-word cannot swallow half a pairing code: the draft is seeded from
   * main's settings once and is the user's from then on.
   */
  function phoneInput(key, id, labelText, placeholder) {
    var row = el('div', 'set-ctl-row');
    var label = el('label', 'set-ctl-label', labelText);
    label.setAttribute('for', id);
    row.appendChild(label);

    var input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.className = 'set-path';
    input.value = phnDraft[key] === undefined ? '' : String(phnDraft[key]);
    input.placeholder = placeholder || '';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.addEventListener('input', function () { phnDraft[key] = input.value; });
    row.appendChild(input);
    return row;
  }

  /** The last answer to one command, against the button that sent it. */
  function phoneResultRow(slot) {
    var r = phnResults[slot];
    if (!r) return null;
    var p = el('p', 'set-readout');
    p.appendChild(el('span', 'set-pip' + (r.ok ? ' is-live' : ' is-hold')));
    p.appendChild(el('span', 'set-readout-text',
      (r.ok ? 'Done. ' : 'That did not work. ') + r.reason));
    return p;
  }

  /** A command button: busy while its call is out, and its answer under it. */
  function phoneButton(field, label, slot, run) {
    var row = el('div', 'set-path-row');
    var busy = phnBusy === slot;
    var b = textButton(busy ? 'Working...' : label, 'set-btn', run);
    if (busy) b.disabled = true;
    row.appendChild(b);
    field.appendChild(row);
    var answer = phoneResultRow(slot);
    if (answer) field.appendChild(answer);
    return b;
  }

  /* --- formatting ---------------------------------------------- */

  function phoneMb(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '0';
    return (v / 1048576).toFixed(1);
  }

  function phoneKbps(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '0 Mbps';
    return (v / 1000000).toFixed(1) + ' Mbps';
  }

  function phoneShaShort(sha) {
    if (typeof sha !== 'string' || !sha) return 'none yet';
    return sha.length > 12 ? sha.slice(0, 12) + '...' : sha;
  }

  /** settings.audioOutput, or its old `audio` mirror from a main that predates it. */
  function phoneSoundMode(s) {
    if (!s) return 'computer';
    if (s.audioOutput === 'computer' || s.audioOutput === 'phone' || s.audioOutput === 'both') {
      return s.audioOutput;
    }
    return s.audio === false ? 'phone' : 'computer';
  }

  function phoneSoundPlace(mode) {
    if (mode === 'phone') return 'on the phone';
    if (mode === 'both') return 'on the phone and this computer';
    return 'on this computer';
  }

  /**
   * Where the sound is going right now, in words. stream.audioOutput is the
   * mode the RUNNING stream started with (null while off); stream.audio going
   * false under a computer/both mode means the phone refused to send it, and
   * the Stream reason above says why.
   */
  function phoneSoundReadout(st, settings) {
    var saved = phoneSoundMode(settings);
    var running = st.audioOutput === 'computer' || st.audioOutput === 'phone' || st.audioOutput === 'both';
    if (!running) return 'will play ' + phoneSoundPlace(saved) + ' when mirroring starts';
    var line;
    if (st.audioOutput === 'phone') line = 'plays on the phone (nothing is sent here)';
    else if (!st.audio) line = 'meant to play ' + phoneSoundPlace(st.audioOutput) + ', but the phone is not sending it (see Stream)';
    else {
      line = 'plays ' + phoneSoundPlace(st.audioOutput) + ', ' +
        (st.audioCodec ? String(st.audioCodec) : 'no codec yet');
    }
    if (saved !== st.audioOutput) line += '; saved choice is ' + saved + ', used from the next start';
    return line;
  }

  function phoneAgo(at) {
    var t = Number(at);
    if (!isFinite(t) || t <= 0) return 'never';
    var secs = Math.round((Date.now() - t) / 1000);
    if (secs < 0) secs = 0;
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.round(secs / 60) + 'm ago';
    return Math.round(secs / 3600) + 'h ago';
  }

  /* --- talking to main ----------------------------------------- */

  /** One describe(). A null answer is a reason too: main refused the call. */
  function phoneRefresh() {
    var api = phoneApi();
    if (!api) {
      phnState = null;
      phnStateReason = 'this build has no phone bridge (window.api.phone is missing)';
      renderPhone();
      return;
    }
    var answer;
    try { answer = api.describe(); }
    catch (err) {
      phnStateReason = 'describe() threw: ' + phoneErrText(err);
      renderPhone();
      return;
    }
    try {
      Promise.resolve(answer).then(function (value) {
        if (value && typeof value === 'object') phoneTake(value);
        else {
          phnState = null;
          phnStateReason = 'the browser answered nothing (main refused: not the chrome)';
          renderPhone();
        }
      }, function (err) {
        phnStateReason = 'describe() was refused: ' + phoneErrText(err);
        renderPhone();
      });
    } catch (err) {
      phnStateReason = 'describe() could not be called: ' + phoneErrText(err);
      renderPhone();
    }
  }

  /** Every state that lands - describe() or a push - comes through here. */
  function phoneTake(state) {
    if (!state || typeof state !== 'object') return;
    phnState = state;
    phnStateReason = '';
    phoneSeedDraft(state);
    renderPhone();
    refreshFilter();
  }

  /** The typed fields start at main's saved values, and only once. */
  function phoneSeedDraft(state) {
    var s = state && state.settings ? state.settings : null;
    if (!s) return;
    if (phnDraft.host === undefined) phnDraft.host = s.host ? String(s.host) : '';
    if (phnDraft.pairPort === undefined) {
      phnDraft.pairPort = (Number(s.pairPort) > 0) ? String(s.pairPort) : '';
    }
    if (phnDraft.port === undefined) phnDraft.port = (Number(s.port) > 0) ? String(s.port) : '';
    if (phnDraft.code === undefined) phnDraft.code = '';
  }

  /**
   * Send one command. The answer - ok or not - is recorded against `slot` and
   * drawn under that button. Nothing is guessed optimistically here: pairing
   * and connecting are slow and fallible, and a row that lies about them
   * would be worse than one that waits.
   */
  function phoneRun(name, arg, slot) {
    var key = slot || name;
    var api = phoneApi();
    if (!api || typeof api.command !== 'function') {
      phnResults[key] = { ok: false, reason: 'this build has no phone bridge (window.api.phone)' };
      renderPhone();
      return;
    }
    phnBusy = key;
    phnResults[key] = null;
    renderPhone();

    var settle = function (ok, reason) {
      phnBusy = '';
      phnResults[key] = { ok: ok, reason: reason };
      renderPhone();
    };

    var answer;
    try { answer = api.command(name, arg); }
    catch (err) { settle(false, 'the call threw: ' + phoneErrText(err)); return; }
    try {
      Promise.resolve(answer).then(function (value) {
        if (!value || typeof value !== 'object') {
          settle(false, 'the browser answered nothing at all');
          return;
        }
        settle(value.ok === true,
          value.reason ? String(value.reason) : (value.ok === true ? 'done' : 'no reason given'));
        phoneRefresh();          // whatever it did, the state may have moved
      }, function (err) {
        settle(false, 'the browser refused it: ' + phoneErrText(err));
      });
    } catch (err) {
      settle(false, 'the answer could not be read: ' + phoneErrText(err));
    }
  }

  /** One partial into settings.* over 'set-settings'. */
  function phoneSetSetting(partial, slot) {
    phoneRun('set-settings', partial, slot || 'set-settings');
  }

  /** Open: one describe() and a live subscription. Closed: neither. */
  function phoneWatch() {
    if (phnWatching) return;                   // opened twice is still one of each
    phnWatching = true;
    var api = phoneApi();
    if (api && typeof api.onUpdate === 'function') {
      try {
        var off = api.onUpdate(function (state) { phoneTake(state); });
        if (typeof off === 'function') phnOff = off;
      } catch (err) { phnOff = null; }
    }
    phoneRefresh();
  }

  function phoneRelease() {
    phnWatching = false;
    if (phnOff) {
      try { phnOff(); } catch (err) { /* the channel is already gone */ }
    }
    phnOff = null;
    phnForgetArmed = false;
    if (phnForgetTimer && typeof window.clearTimeout === 'function') {
      try { window.clearTimeout(phnForgetTimer); } catch (err) { /* already gone */ }
    }
    phnForgetTimer = 0;
  }

  /* --- the section --------------------------------------------- */

  function buildPhone() {
    var s = section('Phone');
    ['phonetools', 'phonepair', 'phoneconnect', 'phonedevice',
     'phonestream', 'phonequality', 'phoneforget'].forEach(function (name) {
      var f = el('div', 'set-field');
      f.setAttribute('data-field', name);
      s.appendChild(f);
    });
    return s;
  }

  /**
   * A re-render throws the fields away and builds them again, which would
   * take the caret with it while the user is typing a pairing code. So the
   * focused control's id and selection are put back afterwards.
   */
  function renderPhone() {
    var active = document.activeElement;
    var keepId = (active && active.id && panelEl && panelEl.contains(active)) ? active.id : '';
    var start = null;
    var end = null;
    if (keepId) {
      try { start = active.selectionStart; end = active.selectionEnd; }
      catch (err) { start = null; end = null; }
    }

    renderPhoneTools();
    renderPhonePair();
    renderPhoneConnect();
    renderPhoneDevice();
    renderPhoneStream();
    renderPhoneQuality();
    renderPhoneForget();

    if (!keepId) return;
    var back = document.getElementById(keepId);
    if (!back) return;
    try {
      back.focus();
      if (start !== null && typeof back.setSelectionRange === 'function') {
        back.setSelectionRange(start, end);
      }
    } catch (err) { /* the control is not a text field, or went away */ }
  }

  /** The field element, cleared, or null when the panel is not built yet. */
  function phoneField(name) {
    var field = panelEl && panelEl.querySelector('[data-field="' + name + '"]');
    if (!field) return null;
    field.textContent = '';
    return field;
  }

  /**
   * Said once, at the top: with no state there is nothing honest to draw in
   * any of the fields, so each one says why rather than showing zeroes.
   * @returns {boolean} true when the caller should stop.
   */
  function phoneNoState(field, what) {
    if (phnState) return false;
    field.appendChild(el('p', 'set-hint',
      'No ' + what + ' yet: ' + (phnStateReason || 'the browser has not answered describe() yet.')));
    return true;
  }

  function renderPhoneTools() {
    var field = phoneField('phonetools');
    if (!field) return;

    /* The one sentence that explains the whole section, and the one fact no
       readout can discover: if the phone's Tailscale is off, nothing below
       this line can work and every failure will be a timeout. */
    field.appendChild(el('p', 'set-hint',
      'Your phone on the screen, over Tailscale: adb and the scrcpy server are ' +
      'downloaded here, the phone is paired once, and the Phone workspace mirrors it. ' +
      'The phone\'s Tailscale has to be ON and connected - there is no cable path, ' +
      'and none of this goes over the open internet.'));

    /* The master switch, first, above everything it governs. Off means: the
       stream stops, adb disconnects and its server is killed, and nothing
       below reconnects, downloads or spawns adb again until this is on. The
       pairing is kept, so on is one press away. It is drawn even before the
       first state arrives (defaulting to on) so the way OUT never depends on
       the thing being switched off answering. Contract: settings.enabled in
       phone.js, written through 'set-settings' { enabled }. */
    var linkOn = !(phnState && phnState.settings && phnState.settings.enabled === false);
    field.appendChild(switchRow('Phone link', linkOn, function (next) {
      phoneSetSetting({ enabled: next }, 'set-enabled');
    }));
    field.appendChild(el('p', 'set-hint', linkOn
      ? 'On. Off disconnects the phone, stops adb, and never reconnects until you turn it back on. Pairing is kept.'
      : 'Off. The phone is disconnected and nothing here will reconnect, download or start adb until this is on.'));
    var linkAnswer = phoneResultRow('set-enabled');
    if (linkAnswer) field.appendChild(linkAnswer);

    if (phoneNoState(field, 'tool state')) {
      phoneButton(field, 'Download tools', 'install-tools', function () {
        phoneRun('install-tools', null, 'install-tools');
      });
      return;
    }

    var t = phnState.tools || {};
    field.appendChild(phoneReadout('Tools', t.state, t.reason));

    var prog = t.progress || {};
    if (Number(prog.total) > 0 || Number(prog.received) > 0) {
      field.appendChild(phoneRow('Downloading',
        phoneMb(prog.received) + ' of ' + phoneMb(prog.total) + ' MB, ' +
        (prog.item || 'unnamed')));
    }
    field.appendChild(phoneRow('adb', t.adbVersion ? String(t.adbVersion) : 'not installed'));
    field.appendChild(phoneRow('scrcpy server',
      (t.serverVersion ? 'v' + t.serverVersion : 'unknown') +
      ', sha ' + phoneShaShort(t.sha && t.sha.server)));
    field.appendChild(phoneRow('adb sha', phoneShaShort(t.sha && t.sha.adb)));
    if (t.sha && t.sha.server && t.sha.serverExpected && t.sha.server !== t.sha.serverExpected) {
      field.appendChild(el('p', 'set-hint',
        'That is NOT the published checksum (' + phoneShaShort(t.sha.serverExpected) +
        '). The server will not be used.'));
    }
    field.appendChild(phoneRow('Folder', t.dir ? String(t.dir) : 'not chosen yet'));

    phoneButton(field, t.state === 'ready' ? 'Check tools again' : 'Download tools',
      'install-tools', function () { phoneRun('install-tools', null, 'install-tools'); });
  }

  function renderPhonePair() {
    var field = phoneField('phonepair');
    if (!field) return;

    field.appendChild(el('p', 'set-label', 'Pairing'));
    field.appendChild(el('p', 'set-hint',
      'On the phone: Developer options, then Wireless debugging, then "Pair device ' +
      'with pairing code". It shows an IP address, a PAIRING port and six digits - ' +
      'and that pairing port is not the same number as the connect port below.'));

    field.appendChild(phoneInput('host', 'set-phone-host', 'Phone address', '100.64.0.1'));
    field.appendChild(phoneInput('pairPort', 'set-phone-pairport', 'Pairing port', '37419'));
    field.appendChild(phoneInput('code', 'set-phone-code', 'Pairing code', '123456'));

    phoneButton(field, 'Pair', 'pair', function () {
      phoneRun('pair', {
        host: String(phnDraft.host || '').trim(),
        port: Number(String(phnDraft.pairPort || '').trim()),
        code: String(phnDraft.code || '').trim()
      }, 'pair');
    });

    if (phnState && phnState.device) {
      field.appendChild(phoneRow('Paired', phnState.device.paired ? 'yes' : 'not yet'));
    }
  }

  function renderPhoneConnect() {
    var field = phoneField('phoneconnect');
    if (!field) return;

    field.appendChild(el('p', 'set-label', 'Connection'));
    field.appendChild(phoneInput('port', 'set-phone-port', 'Connect port', '5555'));

    phoneButton(field, 'Connect', 'connect', function () {
      phoneRun('connect', {
        host: String(phnDraft.host || '').trim(),
        port: Number(String(phnDraft.port || '').trim())
      }, 'connect');
    });
    phoneButton(field, 'Disconnect', 'disconnect', function () {
      phoneRun('disconnect', null, 'disconnect');
    });

    var pinned = phnState && phnState.device ? phnState.device.tcpipPinned : null;
    field.appendChild(phoneRow('Port 5555',
      pinned === true ? 'pinned' : (pinned === false ? 'not pinned' : 'unknown')));
    phoneButton(field, 'Pin port 5555', 'pin-tcpip', function () {
      phoneRun('pin-tcpip', null, 'pin-tcpip');
    });
    field.appendChild(el('p', 'set-hint',
      'Wireless debugging picks a new connect port every time it is switched off ' +
      'and on again. Pinning 5555 holds one number until the phone reboots, and it ' +
      'keeps working when the phone is on cellular instead of Wi-Fi.'));
  }

  function renderPhoneDevice() {
    var field = phoneField('phonedevice');
    if (!field) return;

    field.appendChild(el('p', 'set-label', 'Phone'));
    if (phoneNoState(field, 'device state')) return;

    var d = phnState.device || {};
    field.appendChild(phoneReadout('Device', d.state, d.reason));
    field.appendChild(phoneRow('Name', d.name ? String(d.name) : 'not known yet'));
    field.appendChild(phoneRow('Model', d.model ? String(d.model) : 'not known yet'));
    field.appendChild(phoneRow('Android', d.android ? String(d.android) : 'not known yet'));
    field.appendChild(phoneRow('Address',
      (d.host || '?') + ':' + (Number(d.port) > 0 ? d.port : '?')));
    field.appendChild(phoneRow('Round trip',
      (Number(d.latencyMs) > 0) ? Math.round(d.latencyMs) + ' ms' : 'not measured'));
    field.appendChild(phoneRow('Battery', d.battery
      ? (Math.round(Number(d.battery.level) || 0) + '%' + (d.battery.charging ? ', charging' : ''))
      : 'not read'));
    field.appendChild(phoneRow('Last seen', phoneAgo(d.lastSeenAt)));
  }

  function renderPhoneStream() {
    var field = phoneField('phonestream');
    if (!field) return;

    field.appendChild(el('p', 'set-label', 'Mirroring'));
    if (!phoneNoState(field, 'stream state')) {
      var st = phnState.stream || {};
      field.appendChild(phoneReadout('Stream', st.state, st.reason));
      field.appendChild(phoneRow('Video',
        (st.codec ? String(st.codec) : 'no codec yet') + ', ' +
        (Number(st.width) > 0 ? st.width + 'x' + st.height : 'no size yet')));
      field.appendChild(phoneRow('Rate',
        (Number(st.fps) > 0 ? Math.round(st.fps) + ' fps' : '0 fps') + ', ' + phoneKbps(st.kbps * 1000)));
      field.appendChild(phoneRow('Profile in use', st.profile ? String(st.profile) : 'unknown'));
      field.appendChild(phoneRow('Sound', phoneSoundReadout(st, phnState.settings)));
      var ws = phnState.ws || {};
      field.appendChild(phoneRow('Page link',
        (Number(ws.port) > 0 ? 'ws port ' + ws.port : 'no socket yet') +
        ', ' + (Number(ws.clients) || 0) + ' connected'));
    }

    phoneButton(field, 'Start mirroring', 'start', function () {
      phoneRun('start', null, 'start');
    });
    phoneButton(field, 'Stop', 'stop', function () {
      phoneRun('stop', null, 'stop');
    });
  }

  function renderPhoneQuality() {
    var field = phoneField('phonequality');
    if (!field) return;

    field.appendChild(el('p', 'set-label', 'Quality'));
    if (phoneNoState(field, 'settings')) return;

    var s = phnState.settings || {};

    field.appendChild(controlRow('Profile', null, segmented([
      { id: 'lan',  name: 'At home' },
      { id: 'away', name: 'Away' },
      { id: 'auto', name: 'Auto' }
    ], s.profile, function (next) {
      phoneSetSetting({ profile: next }, 'set-profile');
    })));
    field.appendChild(el('p', 'set-hint',
      'At home is the full-rate stream over the local network; Away is the lean one ' +
      'for cellular. Auto picks between them on how the link is behaving.'));
    var profileAnswer = phoneResultRow('set-profile');
    if (profileAnswer) field.appendChild(profileAnswer);

    field.appendChild(controlRow('At-home bitrate', 'set-phone-lanrate', glassSelect(
      'set-phone-lanrate',
      [4, 8, 12, 16, 25].map(function (mb) {
        return { value: mb * 1000000, name: mb + ' Mbps' };
      }), s.lanBitrate, function (next) {
        phoneSetSetting({ lanBitrate: Number(next) }, 'set-lanrate');
      })));
    field.appendChild(controlRow('Away bitrate', 'set-phone-awayrate', glassSelect(
      'set-phone-awayrate',
      [500000, 1000000, 1500000, 2000000, 4000000].map(function (bps) {
        return { value: bps, name: (bps / 1000000).toFixed(1) + ' Mbps' };
      }), s.awayBitrate, function (next) {
        phoneSetSetting({ awayBitrate: Number(next) }, 'set-awayrate');
      })));
    field.appendChild(controlRow('Longest side', 'set-phone-maxsize', glassSelect(
      'set-phone-maxsize',
      [720, 1024, 1280, 1600, 1920].map(function (px) {
        return { value: px, name: px + ' px' };
      }), s.maxSize, function (next) {
        phoneSetSetting({ maxSize: Number(next) }, 'set-maxsize');
      })));
    field.appendChild(controlRow('Frame rate', 'set-phone-maxfps', glassSelect(
      'set-phone-maxfps',
      [24, 30, 48, 60].map(function (fps) {
        return { value: fps, name: fps + ' fps' };
      }), s.maxFps, function (next) {
        phoneSetSetting({ maxFps: Number(next) }, 'set-maxfps');
      })));

    var rateAnswer = phoneResultRow('set-lanrate') || phoneResultRow('set-awayrate')
      || phoneResultRow('set-maxsize') || phoneResultRow('set-maxfps');
    if (rateAnswer) field.appendChild(rateAnswer);

    /* Where the phone's sound plays (phone.js SOUND). Three places, one
       choice, so a segmented row, not a switch. A change restarts a live
       stream, which takes seconds: the row is disabled while the call is out
       and phone.js's answer (where sound now plays, or why the phone refused)
       lands under it. */
    var soundMode = phoneSoundMode(s);
    var soundBusy = phnBusy === 'set-audio';
    var soundSeg = segmented([
      { id: 'computer', name: 'Computer' },
      { id: 'phone',    name: 'Phone' },
      { id: 'both',     name: 'Both' }
    ], soundMode, function (next) {
      if (phnBusy === 'set-audio' || next === phoneSoundMode(phnState && phnState.settings)) return;
      phoneSetSetting({ audioOutput: next }, 'set-audio');
    });
    if (soundBusy) {
      Array.prototype.forEach.call(soundSeg.children, function (b) { b.disabled = true; });
      soundSeg.setAttribute('aria-busy', 'true');
    }
    field.appendChild(controlRow('Phone sound plays on', null, soundSeg));
    field.appendChild(el('p', 'set-hint', soundBusy
      ? 'Moving the sound — a running stream restarts for it...'
      : 'Computer: the phone goes quiet and its sound plays here. Phone: nothing is sent here and ' +
        'the phone plays as usual. Both: it plays on the phone and here (Android 13 and up); apps ' +
        'that block capture play on the phone only.'));
    var audioAnswer = phoneResultRow('set-audio');
    if (audioAnswer) field.appendChild(audioAnswer);

    field.appendChild(switchRow('Turn the phone screen off while mirroring',
      !!s.screenOffWhileMirroring, function (next) {
        phoneSetSetting({ screenOffWhileMirroring: next }, 'set-screenoff');
      }));
    /* The trap, named (The user hit it 2026-09-13): with the panel off, a phone on
       battery still falls asleep at its own screen timeout, and a sleeping
       phone mirrors black until Wake. Only a charging phone stays awake. */
    field.appendChild(el('p', 'set-hint',
      'On this phone (Android 16) the mirror goes black the moment the panel is off — Android draws nothing for a powered-off display — so this only saves the panel, it does not keep a live picture; and on battery the phone then falls asleep at its screen timeout. Wake on the tab brings both back.'));
    var screenAnswer = phoneResultRow('set-screenoff');
    if (screenAnswer) field.appendChild(screenAnswer);

    field.appendChild(switchRow('Connect on its own when the browser starts',
      !!s.autoConnect, function (next) {
        phoneSetSetting({ autoConnect: next }, 'set-autoconnect');
      }));
    var autoAnswer = phoneResultRow('set-autoconnect');
    if (autoAnswer) field.appendChild(autoAnswer);
  }

  function renderPhoneForget() {
    var field = phoneField('phoneforget');
    if (!field) return;

    var row = el('div', 'set-path-row');
    var label = phnForgetArmed ? 'Press again to forget this phone' : 'Forget phone';
    row.appendChild(textButton(label, 'set-text', function () {
      if (!phnForgetArmed) {
        phnForgetArmed = true;
        renderPhone();
        if (typeof window.clearTimeout === 'function') window.clearTimeout(phnForgetTimer);
        if (typeof window.setTimeout === 'function') {
          phnForgetTimer = window.setTimeout(function () {
            if (!phnForgetArmed) return;
            phnForgetArmed = false;
            renderPhone();
          }, 4000);
        }
        return;
      }
      phnForgetArmed = false;
      if (typeof window.clearTimeout === 'function') window.clearTimeout(phnForgetTimer);
      phoneRun('forget', null, 'forget');
    }));
    field.appendChild(row);

    var answer = phoneResultRow('forget');
    if (answer) field.appendChild(answer);

    field.appendChild(el('p', 'set-hint',
      'Drops the stored address, port and pairing state. The adb keys stay, so the ' +
      'phone does not have to be paired from scratch unless it forgets this computer too.'));
  }

  /* ------------------------------------------------------------
     Shortcuts

     When shortcuts.js is loaded the section is an editor over
     window.Shortcuts. Without it, the printed table below — the
     map as it was before anything was rebindable — still stands.
     ------------------------------------------------------------ */

  /** The module, or null when it is absent or too old to drive the editor. */
  function shortcutsApi() {
    var mod = window.Shortcuts;
    if (!mod) return null;
    var needed = ['all', 'label', 'combo', 'set', 'reset', 'resetAll', 'conflict'];
    for (var i = 0; i < needed.length; i++) {
      if (typeof mod[needed[i]] !== 'function') return null;
    }
    return mod;
  }

  /**
   * Shortcuts folds like every other section now; the one thing particular
   * to it is that folding it away cancels a recording, which applyFold()
   * does through `shortcutsSectionEl`.
   */
  function buildShortcuts() {
    var s = section('Shortcuts');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'shortcuts');
    s.appendChild(field);
    shortcutsSectionEl = s;
    return s;
  }

  /** The old read-only map: two columns, keycaps and a description. */
  function staticShortcuts() {
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
    return table;
  }

  /* A group caption reads as a sentence, not a title: only the first
     letter is ours to touch — 'Claude' stays 'Claude'. */
  function sentenceCase(text) {
    var s = String(text == null ? '' : text);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function shortcutLabelFor(api, id) {
    var list = [];
    try { list = api.all() || []; } catch (err) { list = []; }
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return String(list[i].label || id);
    }
    return String(id);
  }

  /**
   * Keycaps for a combo, or the quiet 'Not set' when it is unbound. A structural
   * action with no single canonical combo carries a hint instead ('Ctrl+1 ...
   * Ctrl+9'): it is bound, so printing 'Not set' over it would be a lie.
   */
  function paintCombo(cell, api, combo, hint) {
    if (!combo) {
      cell.appendChild(el('span', 'set-keynone', hint ? String(hint) : 'Not set'));
      return;
    }
    var parts = null;
    try { parts = api.label(combo); } catch (err) { parts = null; }
    if (!parts || !parts.length) parts = String(combo).split('+');
    parts.forEach(function (cap, i) {
      if (i) cell.appendChild(el('span', 'set-keyplus', '+'));
      cell.appendChild(el('span', 'set-key', cap));
    });
  }

  /** The row that is recording, so a click inside it is not 'elsewhere'. */
  function recordingRow() {
    if (recId === null || !bodyEl) return null;
    var rows = bodyEl.querySelectorAll('.set-shortcut');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-id') === recId) return rows[i];
    }
    return null;
  }

  function startRecording(id) {
    recId = id;
    recPending = '';
    recNote = '';
    recUnbound = null;
    renderShortcuts();
  }

  function stopRecording() {
    if (recId === null) return;
    recId = null;
    recPending = '';
    recNote = '';
    renderShortcuts();
  }

  /**
   * Commit a combo (or null, to unbind) to the row being recorded.
   * The module's own listeners repaint first; the displaced row's
   * 'Now unbound' note is ours to add on the render after that.
   */
  function commitCombo(api, id, combo) {
    recId = null;
    recPending = '';
    recNote = '';
    var res = null;
    try { res = api.set(id, combo); } catch (err) { res = null; }
    if (res && res.ok === false) {
      recUnbound = null;
      renderShortcuts();
      showToast(res.reason ? String(res.reason) : 'That shortcut is fixed');
      return;
    }
    recUnbound = (res && res.displaced) ? res.displaced : null;
    renderShortcuts();
  }

  function shortcutRow(api, item, displaced) {
    var row = el('div', 'set-shortcut');
    row.setAttribute('data-id', String(item.id));
    row.appendChild(el('div', 'set-shortcut-label', String(item.label || item.id)));

    var cell = el('div', 'set-keycell');
    if (recId === item.id) {
      var pill = el('span', 'set-rec', recNote || 'Press keys…');
      pill.setAttribute('role', 'status');
      cell.appendChild(pill);
    } else {
      paintCombo(cell, api, item.combo, item.hint);
      if (displaced === item.id) cell.appendChild(el('span', 'set-keynote', 'Now unbound'));
    }
    row.appendChild(cell);

    var acts = el('div', 'set-shortcut-acts');
    if (!item.fixed) {
      var recording = recId === item.id;
      acts.appendChild(textButton(recording ? 'Cancel' : 'Change',
        'set-text set-key-change', function () {
          if (recording) stopRecording();
          else startRecording(item.id);
        }));
      if (item.changed) {
        acts.appendChild(textButton('Reset', 'set-text set-key-reset', function () {
          try { api.reset(item.id); } catch (err) { /* module's problem */ }
          recUnbound = null;
          renderShortcuts();
        }));
      }
    }
    row.appendChild(acts);
    return row;
  }

  function renderShortcuts() {
    var field = bodyEl && bodyEl.querySelector('[data-field="shortcuts"]');
    if (!field) return;
    field.textContent = '';

    var api = shortcutsApi();
    if (!api) {
      recId = null;
      field.appendChild(staticShortcuts());
      return;
    }

    /* the note lives for exactly one render */
    var displaced = recUnbound;
    recUnbound = null;

    var list = [];
    try { list = api.all() || []; } catch (err) { list = []; }
    if (!list.length) {
      field.appendChild(el('p', 'set-empty', 'No shortcuts to show.'));
      return;
    }

    var order = [];
    var byGroup = {};
    list.forEach(function (item) {
      if (!item || !item.id) return;
      var g = item.group ? String(item.group) : 'Other';
      if (!byGroup[g]) { byGroup[g] = []; order.push(g); }
      byGroup[g].push(item);
    });

    order.forEach(function (name) {
      field.appendChild(el('p', 'set-group', sentenceCase(name)));
      var table = el('div', 'set-shortcuts');
      byGroup[name].forEach(function (item) {
        table.appendChild(shortcutRow(api, item, displaced));
      });
      field.appendChild(table);
    });

    var label = resetAllArmed ? 'Press again to reset every shortcut' : 'Reset all shortcuts';
    var cls = 'set-text set-keys-resetall' + (resetAllArmed ? ' is-armed' : '');
    field.appendChild(textButton(label, cls, function () {
      if (!resetAllArmed) {
        resetAllArmed = true;
        renderShortcuts();
        window.clearTimeout(resetAllTimer);
        resetAllTimer = window.setTimeout(function () {
          if (!resetAllArmed) return;
          resetAllArmed = false;
          renderShortcuts();
        }, 4000);
        return;
      }
      resetAllArmed = false;
      window.clearTimeout(resetAllTimer);
      try { api.resetAll(); } catch (err) { /* module's problem */ }
      recUnbound = null;
      renderShortcuts();
      showToast('Shortcuts reset');
    }));
  }

  /**
   * The capture-phase pass while a row is recording: the keystroke is the
   * panel's, not the browser's, so Ctrl+T records instead of opening a tab.
   */
  function recordKey(event) {
    if (recId === null) return;
    var api = shortcutsApi();
    if (!api) { stopRecording(); return; }

    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    event.settingsRecorded = true;          // the panel's Escape stays out of it

    var key = event.key;
    if (key === 'Escape') { stopRecording(); return; }
    if (key === 'Backspace' || key === 'Delete') { commitCombo(api, recId, null); return; }

    var combo = null;
    try { combo = api.combo(event); } catch (err) { combo = null; }
    if (!combo) return;                     // a bare modifier: keep listening

    var holder = null;
    try { holder = api.conflict(combo); } catch (err) { holder = null; }
    if (holder && holder !== recId && recPending !== combo) {
      recPending = combo;
      recNote = 'Used by ' + shortcutLabelFor(api, holder) + '. Press again to take it';
      renderShortcuts();
      return;
    }
    commitCombo(api, recId, combo);
  }

  function buildAbout() {
    /* The one section with no fold: plain heading, always open (The user). */
    var s = plainSection('About');
    var line = 'Quartz';
    var app = window.api && window.api.app;
    if (app && typeof app.versions === 'function') {
      try {
        var v = app.versions() || {};
        if (v.electron) line += ' · Electron ' + v.electron;
        if (v.chrome) line += ' · Chromium ' + v.chrome;
      } catch (err) { /* older preload: the bare name is still true */ }
    }
    s.appendChild(el('p', 'set-about', line));

    /* Updating this browser means closing and reopening it, so here is the
       one click that does it. app.js owns the action (window.restartBrowser)
       because it flushes the session snapshot first; the bare preload call is
       the fallback for a chrome that has not exposed it. */
    var restart = el('div', 'set-field');
    restart.setAttribute('data-field', 'restart');
    restart.appendChild(textButton('Restart browser', 'set-btn', function () {
      if (typeof window.restartBrowser === 'function') {
        window.restartBrowser();
        return;
      }
      var api = window.api && window.api.app;
      if (api && typeof api.restart === 'function') api.restart();
    }));
    restart.appendChild(el(
      'p',
      'set-hint',
      'Closes and reopens the browser with your tabs restored. Use it after an update.'
    ));
    s.appendChild(restart);
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

  /* ============================================================
     Find a setting — the filter under the panel's title

     The panel is one long scroll of twelve sections, so the fastest way
     to a control is to name it. Typing narrows the scroll to the fields
     that carry every word; the rest of the panel folds away, headings
     and all, and the matched words are lit where they are read.
     ============================================================ */

  var filterEl = null;          // the input in the head
  var noneEl = null;            // the "No settings match" line
  var filterTimer = 0;

  /* Only where a setting is NAMED. A hint or a keycap still matches the
     query — it is part of the index — but lighting words inside a
     paragraph turns the panel into a page of highlighter. */
  var MARK_IN = ['.set-label', '.set-row-label', '.set-shortcut-label', '.set-opt'];

  var FOCUSABLE = ['button', 'input', 'select', 'textarea', 'a'];

  function searchText(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /** Every word, in any order, somewhere in the haystack. */
  function hasWords(hay, words) {
    for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) < 0) return false;
    return true;
  }

  /**
   * textContent, but with a space wherever one element ends and the next
   * begins. Two buttons reading "Dark" and "Light" are one string to
   * textContent — "darklight" — and no query would ever spell that.
   */
  function deepText(node) {
    var kids = node.childNodes || [];
    var out = '';
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeType === 1) out += ' ' + deepText(n) + ' ';
    }
    return out;
  }

  /**
   * The index, one lowercased string per .set-field, read off the rendered
   * text: labels, hints, option names, keycaps — plus the section's own
   * heading and any hint that sits outside the fields, so "address bar"
   * finds the search engine list. Rebuilt by renderAll(), because a
   * re-render replaces the very nodes this reads.
   */
  function indexFields() {
    if (!bodyEl) return;
    var sections = bodyEl.querySelectorAll('.set-section');
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i];
      var fields = s.querySelectorAll('.set-field');
      var chrome = '';                     // the section's text outside its fields
      /* The heading is outside the fold, the rest of the chrome inside it:
         reading the body's children rather than the section's is what keeps
         one field's text out of its neighbours' index. */
      var head = s.querySelector('.set-h');
      if (head) chrome += ' ' + deepText(head) + ' ';
      var host = s.querySelector('.set-collapse') || s;
      var kids = host.children;
      for (var k = 0; k < kids.length; k++) {
        var kid = kids[k];
        if (kid.classList && kid.classList.contains('set-field')) continue;
        if (kid.classList && kid.classList.contains('set-h')) continue;
        chrome += ' ' + deepText(kid) + ' ';
      }
      /* About has no fields at all: the section is then its own unit. */
      s.setAttribute('data-search', searchText(deepText(s)));
      for (var j = 0; j < fields.length; j++) {
        fields[j].setAttribute('data-search', searchText(chrome + ' ' + deepText(fields[j])));
      }
    }
  }

  /** Text nodes under `root`, skipping the marks a previous pass left. */
  function textNodes(root, out) {
    out = out || [];
    var kids = root.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) out.push(n);
      else if (n.nodeType === 1 && n.tagName !== 'MARK') textNodes(n, out);
    }
    return out;
  }

  /**
   * Light every hit in one text node. A host name, a chip label and a
   * shortcut name are all user data, so nothing here goes near innerHTML:
   * the only nodes made are text nodes and <mark>.
   */
  function markTextNode(node, words) {
    var text = node.nodeValue || '';
    var low = text.toLowerCase();
    var spans = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      var at = low.indexOf(w);
      while (at >= 0) { spans.push([at, at + w.length]); at = low.indexOf(w, at + w.length); }
    }
    if (!spans.length) return;
    spans.sort(function (a, b) { return a[0] - b[0]; });

    var merged = [];                       // two words can overlap: light one run
    for (var k = 0; k < spans.length; k++) {
      var last = merged[merged.length - 1];
      if (last && spans[k][0] <= last[1]) last[1] = Math.max(last[1], spans[k][1]);
      else merged.push([spans[k][0], spans[k][1]]);
    }

    var parent = node.parentNode;
    if (!parent) return;
    var cut = 0;
    for (var m = 0; m < merged.length; m++) {
      if (merged[m][0] > cut) {
        parent.insertBefore(document.createTextNode(text.slice(cut, merged[m][0])), node);
      }
      var mk = document.createElement('mark');
      mk.textContent = text.slice(merged[m][0], merged[m][1]);
      parent.insertBefore(mk, node);
      cut = merged[m][1];
    }
    if (cut < text.length) parent.insertBefore(document.createTextNode(text.slice(cut)), node);
    parent.removeChild(node);
  }

  function markField(field, words) {
    for (var i = 0; i < MARK_IN.length; i++) {
      var hits = field.querySelectorAll(MARK_IN[i]);
      for (var j = 0; j < hits.length; j++) {
        var texts = textNodes(hits[j]);
        for (var t = 0; t < texts.length; t++) markTextNode(texts[t], words);
      }
    }
  }

  /** normalize(), kept local, so the next split never straddles two nodes. */
  function mergeTextNodes(parent) {
    var kids = [];
    for (var i = 0; i < parent.childNodes.length; i++) kids.push(parent.childNodes[i]);
    var prev = null;
    for (var j = 0; j < kids.length; j++) {
      var n = kids[j];
      if (n.nodeType !== 3) { prev = null; continue; }
      if (prev) { prev.nodeValue = (prev.nodeValue || '') + (n.nodeValue || ''); parent.removeChild(n); }
      else prev = n;
    }
  }

  function unmarkAll() {
    if (!bodyEl) return;
    var marks = bodyEl.querySelectorAll('mark');
    var parents = [];
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      var p = m.parentNode;
      if (!p) continue;
      p.insertBefore(document.createTextNode(m.textContent), m);
      p.removeChild(m);
      if (parents.indexOf(p) < 0) parents.push(p);
    }
    for (var j = 0; j < parents.length; j++) mergeTextNodes(parents[j]);
  }

  /**
   * Hide every field the query misses, then every section left with nothing
   * showing. A field with no index yet — a render that landed between two
   * passes — counts as a match: the filter narrows the panel, it never
   * swallows a control it has not read.
   */
  function applyFilter() {
    filterTimer = 0;
    if (!bodyEl) return;
    var words = searchText(filterEl ? filterEl.value : '');
    words = words ? words.split(' ') : [];
    unmarkAll();

    var sections = bodyEl.querySelectorAll('.set-section');
    var anyShown = false;
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i];
      var fields = s.querySelectorAll('.set-field');
      var shown = 0;
      for (var j = 0; j < fields.length; j++) {
        var idx = fields[j].getAttribute('data-search');
        var hit = !words.length || idx === null || hasWords(idx, words);
        fields[j].hidden = !hit;
        if (!hit) continue;
        shown++;
        if (words.length) markField(fields[j], words);
      }
      var on = fields.length
        ? shown > 0
        : (!words.length || hasWords(s.getAttribute('data-search') || '', words));
      s.hidden = !on;
      if (on) anyShown = true;
    }

    if (noneEl) noneEl.hidden = !words.length || anyShown;
    if (panelEl) panelEl.classList.toggle('is-filtering', words.length > 0);
    syncFolds(words.length > 0);
  }

  /** Index and filter in one breath — what a re-render owes the filter. */
  function refreshFilter() {
    indexFields();
    applyFilter();
  }

  /* 40ms: long enough that a fast typist filters once per word rather than
     once per keystroke, short enough that the panel still feels live. */
  function scheduleFilter() {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(applyFilter, 40);
  }

  function clearFilter() {
    window.clearTimeout(filterTimer);
    filterTimer = 0;
    if (filterEl) filterEl.value = '';
    applyFilter();
  }

  /** The first control still on screen, in reading order. */
  function firstControl(node) {
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.hidden) continue;
      var tag = String(n.tagName || '').toLowerCase();
      if (FOCUSABLE.indexOf(tag) >= 0 && !n.disabled) return n;
      var deeper = firstControl(n);
      if (deeper) return deeper;
    }
    return null;
  }

  function focusFirstResult() {
    var hit = bodyEl ? firstControl(bodyEl) : null;
    if (hit && typeof hit.focus === 'function') hit.focus();
    return hit;
  }

  function filterKeys(event) {
    if (event.key === 'Escape') {
      /* The first Escape empties the field; only a second one, on a field
         already empty, is allowed through to close the panel. */
      if (filterEl && filterEl.value) {
        event.preventDefault();
        event.stopPropagation();
        clearFilter();
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      focusFirstResult();
    }
  }

  function buildFilter() {
    var row = el('div', 'set-filter-row');
    row.appendChild(el('span', 'set-filter-glyph glyph', GLYPH_SEARCH));
    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'set-filter';
    input.className = 'set-filter';
    input.placeholder = 'Find a setting';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Find a setting');
    input.addEventListener('input', scheduleFilter);
    input.addEventListener('keydown', filterKeys);
    row.appendChild(input);
    filterEl = input;
    return row;
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
    var headTop = el('div', 'set-head-top');
    headTop.appendChild(el('span', 'set-title', 'Settings'));
    headTop.appendChild(iconButton(GLYPH_CLOSE, 'Close', 'set-act set-x', function () { closePanel(); }));
    head.appendChild(headTop);
    head.appendChild(buildFilter());
    panelEl.appendChild(head);

    bodyEl = el('div', 'set-body');
    bodyEl.appendChild(buildLook());
    bodyEl.appendChild(buildClaude());
    bodyEl.appendChild(buildTabs());
    bodyEl.appendChild(buildDownloads());
    bodyEl.appendChild(buildSearch());
    bodyEl.appendChild(buildSites());
    bodyEl.appendChild(buildSiteStyles());
    bodyEl.appendChild(buildUserStyle());
    bodyEl.appendChild(buildNewTab());
    bodyEl.appendChild(buildMusic());
    bodyEl.appendChild(buildPrivacy());
    bodyEl.appendChild(buildSpotify());
    bodyEl.appendChild(buildStocks());
    bodyEl.appendChild(buildPhone());
    bodyEl.appendChild(buildShortcuts());
    bodyEl.appendChild(buildAbout());

    noneEl = el('p', 'set-none', 'No settings match');
    noneEl.hidden = true;
    bodyEl.appendChild(noneEl);

    panelEl.appendChild(bodyEl);

    document.body.appendChild(panelEl);
    renderAll();
  }

  function renderAll() {
    renderLook();
    renderClaude();
    renderTabs();
    renderWorkspaceSleep();
    renderDownloads();
    renderSearch();
    renderSites();
    renderSiteStyles();
    renderUserStyle();
    renderNewtabBg();
    renderChips();
    renderMusic();
    renderPrivacy();
    renderSpotify();
    renderStocks();
    renderPhone();
    renderShortcuts();
    refreshFilter();          // the text just changed under the index
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

  /**
   * `at` is a section heading — Settings.open('Spotify') is a deep link from
   * anywhere else in the browser, and it is the one thing that arrives with a
   * section already unfolded and scrolled to. Called with nothing, the panel
   * opens the way it always does: every section folded.
   */
  function openPanel(at) {
    if (!panelEl) return;
    /* Folded first, rendered second: renderAll() ends in the filter, so a
       query still sitting in the box re-opens its own hits on the way in. */
    collapseAllFolds();
    renderAll();
    panelEl.hidden = false;
    open_ = true;
    /* The Spotify readout is live only while the pane is: one subscription
       and one 4s poll, started here and taken down again in closePanel(). */
    autopauseWatch();
    /* And one describe() for the Stocks section: its state lives in main, so
       the rows are drawn from whatever main last said until the answer lands.
       One call per open, never a poll -- nothing in that section moves on its
       own. */
    stocksRefresh();
    /* And the Phone section, which unlike Stocks DOES move on its own: a
       download's progress, a device coming and going, a stream's bitrate.
       So it takes a subscription as well as one describe(), and gives both
       back in closePanel() - nothing of this section is left running. */
    phoneWatch();
    position();
    if (buttonEl) {
      buttonEl.classList.add('is-open');
      buttonEl.setAttribute('aria-expanded', 'true');
    }
    /* Opened from the gear or the shortcut, focus lands on the PANEL, not
       in the filter. A focused text field blinks its caret twice a second,
       and under the acrylic window every one of those repaints re-composes
       the column above it: the user saw the address bar flicker whenever the
       pane was open. Tab or Ctrl+F reaches the filter; Escape still closes.
       Opened with somewhere in the panel already focused — a re-render, a
       control handing focus back — that focus is left alone. */
    var active = document.activeElement;
    if (!active || !panelEl.contains(active)) {
      if (!panelEl.hasAttribute('tabindex')) panelEl.setAttribute('tabindex', '-1');
      try { panelEl.focus({ preventScroll: true }); } catch (err) { /* not focusable yet */ }
    }
    /* Back to the top of the list. It has to happen with the panel on screen:
       a display:none element drops a scrollTop assignment and hands back its
       old offset when it is shown again, and opening the folded list already
       scrolled to wherever the last visit ended reads as a bug. */
    if (bodyEl) bodyEl.scrollTop = 0;
    /* Last, with the panel on screen: scrollIntoView has nothing to measure
       against while the popover is still hidden. */
    if (at) revealSection(at);
  }

  function closePanel() {
    if (panelEl) panelEl.hidden = true;
    open_ = false;
    autopauseRelease();
    phoneRelease();
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
    // A recording row eats the keystroke first, in the capture phase, so
    // Ctrl+T lands in the editor rather than opening a tab.
    document.addEventListener('keydown', recordKey, true);

    document.addEventListener('keydown', function (event) {
      if (!open_) return;
      if (event.settingsRecorded) return;   // that Escape cancelled a recording
      if (event.key === 'Escape') closePanel();
    });

    // Click-outside. mousedown, so it settles before the button's own click.
    document.addEventListener('mousedown', function (event) {
      var t = event.target;
      if (recId !== null) {
        var row = recordingRow();
        if (!row || !row.contains(t)) stopRecording();
      }
      if (!open_) return;
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
      if (keys.indexOf('claudeSkipPermissions') >= 0) renderClaudeSkip();
      if (keys.indexOf('claudeNotify') >= 0) renderClaudeNotify();
      if (keys.indexOf('tabSleepMinutes') >= 0) renderTabs();
      // The mode decides whether the minutes row is there at all, so both keys
      // redraw the whole field.
      if (keys.indexOf('workspaceSleep') >= 0
        || keys.indexOf('workspaceSleepMinutes') >= 0) renderWorkspaceSleep();
      if (keys.indexOf('downloadsAskWhere') >= 0) renderDownloads();
      if (keys.indexOf('searchEngine') >= 0) renderSearch();
      if (keys.indexOf('siteTheme') >= 0) renderSites();
      if (keys.indexOf('chips') >= 0 || keys.indexOf('chipsSource') >= 0) renderChips();
      if (keys.indexOf('bookmarksBar') >= 0) renderBookmarksBar();
      if (keys.indexOf('newtabBackground') >= 0) renderNewtabBg();
      refreshFilter();            // those renders replaced indexed text
    });

    // The shortcut map has its own store; the section mirrors it the same way.
    var keysApi = shortcutsApi();
    if (keysApi && typeof keysApi.on === 'function') {
      try { keysApi.on(function () { renderShortcuts(); refreshFilter(); }); } catch (err) { /* module's problem */ }
    }
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
    /* 'visited' (the default: app.js composes the five out of history) or
       'list' (the chips above, in order). Setting it announces 'chipsSource'
       to every listener, which is how the new tab hears about the switch. */
    chipsSource: chipsSource,
    setChipsSource: setChipsSource,
    toggleBookmarksBar: toggleBookmarksBar,
    addChip: addChip,
    removeChip: removeChip,
    updateChip: updateChip,
    moveChip: moveChip,

    /* The new tab's background. background() resolves to
       { kind, boardOverImage, dim, dataUrl? } for a picture and
       { kind, boardOverImage, dim, fileUrl?, fileName? } for a moving one —
       what app.js pushes into the guest with __applyBackground(). */
    background: background,
    setBackground: setBackground,

    /* The new tab's app dock, in the order the page shows it: an installed
       app's id, a 'web:<slug>' or a 'term:<program>', each either as a bare
       string or as { id, web: true } for an app opened in its web form.
       appPinIds() is the same list flattened to ids for the join. */
    appPins: appPins,
    appPinIds: appPinIds,
    setAppPins: setAppPins,
    pinOptions: pinOptions,
    setPinOption: setPinOption,

    /* Idle music. music() always answers a complete group; setMusic() merges
       and announces — 'music' among the listener's keys, and a
       'music-changed' event on document. */
    music: music,
    setMusic: setMusic,

    engines: engines,
    searchUrl: searchUrl,
    isSearchUrl: isSearchUrl,

    applyAccent: applyAccent,
    applyPalette: applyPalette,
    palettes: palettes,
    /* open('Spotify') deep links: the panel opens folded, then that one
       section unfolds and scrolls into view. */
    open: openPanel,
    close: closePanel,
    toggle: toggle,
    isOpen: isOpen,
    revealSection: revealSection,
    handleShortcut: handleShortcut,

    // test seams
    _defaults: DEFAULTS,
    _normalizeUrl: normalizeUrl,
    _hostnameOf: hostnameOf,
    _normalizeHost: normalizeHost,
    _sleepTimes: SLEEP_TIMES,
    _chipSources: CHIP_SOURCES,
    _assetStore: assetStore,
    _normalizeBackground: normalizeBackground,
    _normalizeAppPins: normalizeAppPins,
    _normalizeAppPin: normalizeAppPin,
    _pinIdOf: pinIdOf,
    _normalizeMusic: normalizeMusic,
    _normalizeMusicFiles: normalizeMusicFiles,
    _musicSources: MUSIC_SOURCES,
    _musicWhere: MUSIC_WHERE,
    _musicFilesMax: MUSIC_FILES_MAX,
    _chooseMusicFiles: chooseMusicFiles,
    _appPinsMax: APP_PINS_MAX,
    _backgrounds: NEWTAB_BACKGROUNDS,
    _chooseBackgroundVideo: chooseBackgroundVideo,
    _removeBackgroundVideo: removeBackgroundVideo,
    _renderShortcuts: renderShortcuts,
    _applyFilter: applyFilter,
    _clearFilter: clearFilter,
    _focusFirstResult: focusFirstResult
  };
})();
