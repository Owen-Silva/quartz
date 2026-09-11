'use strict';

/*
 * tabsearch.js — the tab palette: Ctrl+Shift+A, or the list glyph in the
 * titlebar. One glass pane over the page listing every open tab and the
 * handful you just closed, filtered as you type.
 *
 * Type `>` into it — or open it with Ctrl+K — and the same pane becomes a
 * COMMAND palette: the list swaps to the browser's own verbs (new tab, split,
 * reader, palettes, clear history…), each with its keycaps on the right, run
 * with Enter. Deleting the `>` puts the tabs back. Both modes share one input,
 * one row recipe and one set of arrow keys; only the model underneath changes.
 *
 * The renderer runs with contextIsolation ON and nodeIntegration OFF, so this
 * is plain browser script: no require(), no import, no bundler. Loaded after
 * app.js, which owns the strip; this file only ever ADDS — one button in
 * #titlebar, immediately after #newtab, and one panel under <body>.
 *
 * Contract with app.js. Classic scripts share one global scope, so app.js's
 * top-level bindings are reachable here by bare name (they are `const`/
 * `function`, never window properties). Every one of them is read through a
 * guarded accessor below, so this file loads and the palette still opens even
 * if app.js changed underneath it:
 *
 *   tabs, activeTabId, closedStack        state
 *   activateTab, closeTab, createTab      actions
 *   readCurrentUrl, shortLabelFor,        url helpers
 *   readerSourceOf, isNewTabUrl
 *
 * Owned ids/classes (nothing else in the app may touch them):
 *   #tabsearch-btn (the titlebar instrument), #tabsearch (the panel, a direct
 *   child of <body> so it stacks over #views), #tabsearch-input, and every
 *   .ts-* class inside the panel.
 *
 * MOTION. The chrome sits on a backdrop-filter, so every animated frame
 * re-blurs the pane behind it. Nothing here animates continuously: the row
 * highlight and the hover on a close button are stepped transitions.
 */

(function () {
  /* --- Segoe Fluent Icons ------------------------------------- */
  var GLYPH = {
    search:  '\uE721',
    globe:   '\uE774',
    close:   '\uE711',
    pin:     '\uE718',
    muted:   '\uE74F',
    audible: '\uE767',
    asleep:  '\uE708',
    history: '\uE81C',
    list:    '\uE8FD',

    /* command mode: the field's own mark, then one per verb */
    chevron: '\uE76C',
    add:     '\uE710',
    claude:  '\uE756',
    folder:  '\uE838',
    beside:  '\uE7C4',
    split:   '\uE89F',
    reader:  '\uE736',
    camera:  '\uE722',
    print:   '\uE749',
    unpin:   '\uE77A',
    reload:  '\uE72C',
    undo:    '\uE7A7',
    next:    '\uE72A',
    prev:    '\uE72B',
    zoomIn:  '\uE8A3',
    zoomOut: '\uE71F',
    zoom:    '\uE71E',
    star:    '\uE734',
    sun:     '\uE706',
    moon:    '\uE708',
    color:   '\uE790',
    gear:    '\uE713',
    down:    '\uE896',
    info:    '\uE946',
    shield:  '\uE83D',
    screen:  '\uE740',
    trash:   '\uE74D',
    check:   '\uE73E'
  };

  /** The pane is a shortlist, not a tab manager: what does not fit is a count. */
  var MAX_OPEN = 12;
  var MAX_CLOSED = 8;

  /** The one character that turns the pane into a command palette. */
  var CMD_PREFIX = '>';

  /* --- state ---------------------------------------------------- */
  var open_ = false;
  var wired = false;

  var btnEl = null;
  var rootEl = null;
  var inputEl = null;
  var listEl = null;
  var fieldIcoEl = null;

  /**
   * Reader.canRead() is a promise, and a row cannot wait: it is resolved once
   * per open and the answer parked here, so "Reader view" is simply absent
   * until the page is known to be readable.
   */
  var readerOk = false;

  /** The id of a two-step command waiting for its second Enter. */
  var pendingId = null;

  /**
   * The rendered model, index-aligned with the selectable row elements: what
   * ArrowUp/Down walks and Enter acts on. Captions, "+N more" and the empty
   * note are in the list but never in here.
   */
  var rows = [];
  var hi = -1;

  /* ============================================================
     app.js bridge — every global read behind a guard
     ============================================================ */

  function tabList() {
    try {
      return (typeof tabs !== 'undefined' && Array.isArray(tabs)) ? tabs : [];
    } catch (err) { return []; }
  }

  function closedList() {
    try {
      return (typeof closedStack !== 'undefined' && Array.isArray(closedStack)) ? closedStack : [];
    } catch (err) { return []; }
  }

  function activeId() {
    try {
      return (typeof activeTabId !== 'undefined') ? activeTabId : null;
    } catch (err) { return null; }
  }

  function doActivate(id) {
    try { if (typeof activateTab === 'function') activateTab(id); } catch (err) { /* strip moved on */ }
  }

  function doClose(id) {
    try { if (typeof closeTab === 'function') closeTab(id); } catch (err) { /* already gone */ }
  }

  function doCreate(url) {
    try { if (typeof createTab === 'function') createTab(url); } catch (err) { /* nothing to open into */ }
  }

  /** The url the guest is actually showing, falling back to the stored one. */
  function currentUrl(tab) {
    try {
      if (typeof readCurrentUrl === 'function') return readCurrentUrl(tab) || (tab && tab.url) || '';
    } catch (err) { /* view not ready */ }
    return (tab && typeof tab.url === 'string') ? tab.url : '';
  }

  /** reader.html?src=… is our wrapper: the article's address is the real one. */
  function readerSource(url) {
    try {
      if (typeof readerSourceOf === 'function') return readerSourceOf(url) || null;
    } catch (err) { /* not a reader url */ }
    return null;
  }

  function isNewTab(url) {
    try {
      if (typeof isNewTabUrl === 'function') return !!isNewTabUrl(url);
    } catch (err) { /* fall through */ }
    return false;
  }

  /** The host, minus www — app.js's own label, with a hostname fallback. */
  function shortLabel(url) {
    try {
      if (typeof shortLabelFor === 'function') return shortLabelFor(url);
    } catch (err) { /* fall through */ }
    if (typeof url !== 'string' || !url) return 'New tab';
    var m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
    return m ? m[1].replace(/^www\./, '') : 'New tab';
  }

  /* ============================================================
     Command bridge — the rest of the app, every call feature-detected
     ============================================================ */

  /**
   * app.js's top-level bindings are `const`/`function`: reachable here by bare
   * name, but not as window properties, and a bare name that no longer exists
   * is a ReferenceError rather than undefined. So every one is read through a
   * thunk inside a try, and a global the app dropped simply reads undefined.
   */
  function globalRef(thunk) {
    try { return thunk(); } catch (err) { return undefined; }
  }

  /** Call a bare global if it is still a function. Never throws. */
  function callGlobal(thunk, a, b) {
    var fn = globalRef(thunk);
    if (typeof fn !== 'function') return false;
    try { fn(a, b); return true; } catch (err) { return false; }
  }

  /** The sibling modules ARE window properties: Reader, Settings, Shield… */
  function moduleRef(name) {
    try {
      var mod = window[name];
      return (mod && typeof mod === 'object') ? mod : null;
    } catch (err) { return null; }
  }

  function callModule(name, method, a) {
    var mod = moduleRef(name);
    if (!mod || typeof mod[method] !== 'function') return false;
    try { mod[method](a); return true; } catch (err) { return false; }
  }

  /**
   * The keycaps a row wears. A command that names an `action` reads the
   * shortcuts store, so the palette always shows the binding the user has NOW
   * rather than the one the table was written with. `keys` is the fallback for
   * a build with no shortcuts module; an action the user unbound wears none.
   */
  function keysFor(cmd) {
    if (!cmd) return null;
    var fallback = (cmd.keys && cmd.keys.length) ? cmd.keys : null;
    if (!cmd.action) return fallback;
    var mod = moduleRef('Shortcuts');
    if (!mod || typeof mod.get !== 'function' || typeof mod.label !== 'function') return fallback;
    try {
      var combo = mod.get(cmd.action);
      if (!combo) return null;                 // deliberately unbound
      var parts = mod.label(combo);
      return (parts && parts.length) ? parts : fallback;
    } catch (err) {
      return fallback;
    }
  }

  /** The tab a command acts on: app.js's own accessor, then the strip. */
  function activeTab() {
    var fn = globalRef(function () { return getActiveTab; });
    if (typeof fn === 'function') {
      try { return fn() || null; } catch (err) { /* strip moved on */ }
    }
    var id = activeId();
    var all = tabList();
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === id) return all[i];
    return null;
  }

  function rootAttr(name) {
    try {
      var root = document.documentElement;
      return (root && typeof root.getAttribute === 'function') ? root.getAttribute(name) : null;
    } catch (err) { return null; }
  }

  /** 'dark' unless the chrome says otherwise — app.js's own default. */
  function currentTheme() {
    var fn = globalRef(function () { return getTheme; });
    if (typeof fn === 'function') {
      try { return fn() === 'light' ? 'light' : 'dark'; } catch (err) { /* fall through */ }
    }
    return rootAttr('data-theme') === 'light' ? 'light' : 'dark';
  }

  /** Aurora is the palette that wears no attribute, so it is the fallback. */
  function currentPalette() {
    var settings = moduleRef('Settings');
    if (settings && typeof settings.get === 'function') {
      try {
        var name = settings.get('palette');
        if (typeof name === 'string' && name) return name;
      } catch (err) { /* fall through */ }
    }
    return rootAttr('data-palette') || 'aurora';
  }

  /* ============================================================
     Pure model (exported on window.TabSearch._helpers for tests)
     ============================================================ */

  /** What a tab shows in the pane: never reads the DOM, only the record. */
  function describeTab(tab) {
    if (!tab || typeof tab !== 'object') return null;
    var claude = tab.kind === 'claude';
    var raw = claude ? '' : currentUrl(tab);
    var url = claude ? '' : (readerSource(raw) || raw);
    var folder = (claude && typeof tab.cwd === 'string') ? tab.cwd : '';
    var title = (typeof tab.title === 'string' && tab.title)
      ? tab.title
      : (claude ? 'Claude' : shortLabel(url));

    var second;
    if (claude) second = folder || 'Claude session';
    else if (isNewTab(url) || !url) second = 'New tab';
    else second = shortLabel(url);

    return {
      kind: 'tab',
      id: tab.id,
      tab: tab,
      claude: claude,
      title: title,
      url: url,
      folder: folder,
      second: second,
      pinned: !!tab.pinned,
      muted: !!tab.muted,
      audible: !!tab.audible && !tab.muted,
      asleep: !!tab.asleep,
      current: tab.id === activeId()
    };
  }

  /** The query, lowercased and split: every word has to land somewhere. */
  function tokenize(query) {
    var q = String(query == null ? '' : query).trim().toLowerCase();
    return q ? q.split(/\s+/) : [];
  }

  function matches(entry, words) {
    if (!words || !words.length) return true;
    var title = String(entry.title || '').toLowerCase();
    var url = String(entry.url || '').toLowerCase();
    var folder = String(entry.folder || '').toLowerCase();
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (title.indexOf(w) < 0 && url.indexOf(w) < 0 && folder.indexOf(w) < 0) return false;
    }
    return true;
  }

  /** 0 title starts with the query, 1 title contains, 2 url contains, 3 folder only. */
  function rankOf(entry, query) {
    var q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return 0;
    var title = String(entry.title || '').toLowerCase();
    if (title.indexOf(q) === 0) return 0;
    if (title.indexOf(q) >= 0) return 1;
    if (String(entry.url || '').toLowerCase().indexOf(q) >= 0) return 2;
    return 3;
  }

  /**
   * The whole pane in one object: the open tabs that matched (ranked, capped),
   * how many more there were, and the recently-closed urls under them.
   */
  function collect(query) {
    var words = tokenize(query);
    var all = tabList();
    var open = [];
    var i;

    for (i = 0; i < all.length; i++) {
      var entry = describeTab(all[i]);
      if (!entry) continue;
      if (!matches(entry, words)) continue;
      entry.order = i;                 // strip order is the tiebreak
      entry.rank = rankOf(entry, query);
      open.push(entry);
    }
    open.sort(function (a, b) { return (a.rank - b.rank) || (a.order - b.order); });

    var extra = Math.max(0, open.length - MAX_OPEN);
    if (extra > 0) open = open.slice(0, MAX_OPEN);

    // closedStack is oldest-first and holds plain urls (reader wrappers were
    // already mapped to the article when they were pushed).
    var stack = closedList();
    var seen = Object.create(null);
    var closed = [];
    for (i = stack.length - 1; i >= 0 && closed.length < MAX_CLOSED; i--) {
      var url = stack[i];
      if (typeof url !== 'string' || !url) continue;
      if (seen[url]) continue;
      seen[url] = true;                // an older duplicate never comes back
      var row = { kind: 'closed', url: url, index: i, title: shortLabel(url), folder: '' };
      if (!matches(row, words)) continue;
      closed.push(row);
    }

    return { open: open, closed: closed, extra: extra };
  }

  /* ============================================================
     The command table
     ============================================================ */

  var PALETTES = [
    { id: 'aurora', label: 'Aurora' },
    { id: 'ember', label: 'Ember' },
    { id: 'forest', label: 'Forest' },
    { id: 'ocean', label: 'Ocean' },
    { id: 'midnight', label: 'Midnight' },
    { id: 'mono', label: 'Mono' }
  ];

  /** True only once another lane has actually shipped the workspace globals. */
  function hasWorkspaces() {
    return typeof globalRef(function () { return cycleWorkspace; }) === 'function';
  }

  /**
   * History's own panel. app.js routes shortcut actions to whichever module
   * claims them, so ask it first and fall back to the module directly for a
   * build where app.js does not export the router.
   */
  function openHistory() {
    var routed = false;
    var fn = globalRef(function () { return moduleShortcut; });
    if (typeof fn === 'function') {
      try { routed = !!fn('history'); } catch (err) { routed = false; }
    }
    if (!routed) callModule('History', 'handleShortcut', 'history');
  }

  /** The Downloads folder in Explorer — main's job, over the downloads api. */
  function openDownloadsFolder() {
    try {
      var api = window.api && window.api.downloads;
      if (api && typeof api.openFolder === 'function') api.openFolder();
    } catch (err) { /* no bridge in this build; nothing to open */ }
  }

  /**
   * Every verb the palette offers, in the order it offers them. Rebuilt on each
   * render rather than kept, because half of these read the world: the label is
   * "Unsplit" or "Split with next tab" depending on the tab under the cursor,
   * and the palette rows wear a check on whichever one is being worn.
   */
  function buildCommands() {
    var tab = activeTab();
    var split = !!(tab && tab.splitWith !== null && tab.splitWith !== undefined);
    var pinned = !!(tab && tab.pinned);
    var muted = !!(tab && tab.muted);
    var theme = currentTheme();
    var palette = currentPalette();
    var list = [];

    list.push({
      id: 'new-tab', glyph: GLYPH.add, label: 'New tab', keys: ['Ctrl', 'T'],
      action: 'new-tab',
      run: function () { doCreate(globalRef(function () { return HOME_URL; })); }
    });
    list.push({
      id: 'new-claude-tab', glyph: GLYPH.claude, label: 'New Claude tab', keys: ['Ctrl', '`'],
      action: 'toggle-terminal',
      run: function () { callGlobal(function () { return createClaudeTab; }); }
    });
    list.push({
      id: 'claude-folder', glyph: GLYPH.folder, label: 'Claude tab in a folder…',
      hint: 'Pick the working directory first', keys: ['Ctrl', 'Shift', '`'],
      action: 'claude-folder',
      run: function () { callGlobal(function () { return newClaudeTabInFolder; }); }
    });
    list.push({
      id: 'claude-beside', glyph: GLYPH.beside, label: 'Claude beside this page',
      hint: 'A session in the other half', keys: ['Ctrl', 'Shift', '\\'],
      action: 'claude-split',
      run: function () { callGlobal(function () { return toggleClaudeSplit; }); }
    });
    list.push({
      id: 'ask-claude', glyph: GLYPH.claude, label: 'Ask Claude about this page',
      hint: 'Hands the page to a Claude session', action: 'ask-claude',
      keys: ['Ctrl', 'Shift', 'K'],
      run: function () { callGlobal(function () { return askClaudeAboutActiveTab; }); }
    });
    list.push({
      id: 'split', glyph: GLYPH.split,
      label: split ? 'Unsplit' : 'Split with next tab',
      hint: split ? 'Back to one page' : 'Two pages side by side',
      keys: ['Ctrl', '\\'], action: 'split',
      run: function () {
        if (split) callGlobal(function () { return unsplit; }, activeTab());
        else callGlobal(function () { return toggleSplit; });
      }
    });
    list.push({
      id: 'reader', glyph: GLYPH.reader, label: 'Reader view',
      hint: 'Read this page without the furniture', keys: ['Ctrl', 'Shift', 'R'],
      action: 'reader',
      when: function () { return readerOk; },
      run: function () { callModule('Reader', 'open'); }
    });
    list.push({
      id: 'find', glyph: GLYPH.search, label: 'Find in page', keys: ['Ctrl', 'F'],
      action: 'find',
      run: function () { callModule('FindBar', 'open'); }
    });
    list.push({
      id: 'tabsearch', glyph: GLYPH.list, label: 'Search tabs',
      hint: 'Back to the tab list', action: 'tabsearch',
      keys: ['Ctrl', 'Shift', 'A'],
      // open() is the tab mode: it clears the `>` out of the field and
      // re-renders. runCommand has already closed the pane, so this reopens it.
      run: function () { open(); }
    });
    list.push({
      id: 'capture', glyph: GLYPH.camera, label: 'Take a screenshot',
      hint: 'Saves the page as a PNG', keys: ['Ctrl', 'Shift', 'S'],
      action: 'capture',
      run: function () { callModule('Capture', 'takeActive'); }
    });
    list.push({
      id: 'print', glyph: GLYPH.print, label: 'Print', keys: ['Ctrl', 'P'],
      action: 'print',
      run: function () { callGlobal(function () { return printActiveTab; }); }
    });
    list.push({
      id: 'pin', glyph: pinned ? GLYPH.unpin : GLYPH.pin,
      label: pinned ? 'Unpin tab' : 'Pin tab',
      run: function () {
        var t = activeTab();
        if (t) callGlobal(function () { return setTabPinned; }, t, !t.pinned);
      }
    });
    list.push({
      id: 'mute', glyph: muted ? GLYPH.audible : GLYPH.muted,
      label: muted ? 'Unmute tab' : 'Mute tab',
      run: function () {
        var t = activeTab();
        if (t) callGlobal(function () { return setTabMuted; }, t, !t.muted);
      }
    });
    list.push({
      id: 'sleep-others', glyph: GLYPH.asleep, label: 'Sleep other tabs',
      hint: 'Frees the memory idle tabs are holding',
      run: function () { callGlobal(function () { return sleepIdleTabs; }); }
    });
    list.push({
      id: 'reload', glyph: GLYPH.reload, label: 'Reload', keys: ['F5'],
      action: 'reload',
      run: function () { callGlobal(function () { return reloadActiveTab; }); }
    });
    list.push({
      id: 'close-tab', glyph: GLYPH.close, label: 'Close tab', keys: ['Ctrl', 'W'],
      action: 'close-tab',
      run: function () { callGlobal(function () { return closeActiveTab; }); }
    });
    list.push({
      id: 'reopen-tab', glyph: GLYPH.undo, label: 'Reopen closed tab', keys: ['Ctrl', 'Shift', 'T'],
      action: 'reopen-tab',
      run: function () { callGlobal(function () { return reopenClosedTab; }); }
    });
    /* Workspaces are another lane's work: both rows stay out of the table
       entirely until the global they call actually exists. */
    list.push({
      id: 'workspace-next', glyph: GLYPH.next, label: 'Next workspace',
      action: 'workspace-next', keys: ['Ctrl', 'Alt', '→'],
      when: hasWorkspaces,
      run: function () { callGlobal(function () { return cycleWorkspace; }, 1); }
    });
    list.push({
      id: 'workspace-prev', glyph: GLYPH.prev, label: 'Previous workspace',
      action: 'workspace-prev', keys: ['Ctrl', 'Alt', '←'],
      when: hasWorkspaces,
      run: function () { callGlobal(function () { return cycleWorkspace; }, -1); }
    });
    list.push({
      id: 'zoom-in', glyph: GLYPH.zoomIn, label: 'Zoom in', action: 'zoom-in',
      run: function () { callGlobal(function () { return zoomActiveTab; }, 0.5); }
    });
    list.push({
      id: 'zoom-out', glyph: GLYPH.zoomOut, label: 'Zoom out', action: 'zoom-out',
      run: function () { callGlobal(function () { return zoomActiveTab; }, -0.5); }
    });
    list.push({
      id: 'zoom-reset', glyph: GLYPH.zoom, label: 'Reset zoom', action: 'zoom-reset',
      run: function () { callGlobal(function () { return resetZoom; }); }
    });
    list.push({
      id: 'bookmarks-bar', glyph: GLYPH.star, label: 'Toggle bookmarks bar',
      hint: 'Show or hide the bar', keys: ['Ctrl', 'Shift', 'B'],
      action: 'bookmarks-bar',
      run: function () { callModule('Bookmarks', 'toggle'); }
    });
    list.push({
      id: 'theme-light', glyph: GLYPH.sun, label: 'Switch to light theme',
      when: function () { return theme === 'dark'; },
      run: function () { callGlobal(function () { return setTheme; }, 'light'); }
    });
    list.push({
      id: 'theme-dark', glyph: GLYPH.moon, label: 'Switch to dark theme',
      when: function () { return theme === 'light'; },
      run: function () { callGlobal(function () { return setTheme; }, 'dark'); }
    });

    for (var i = 0; i < PALETTES.length; i++) {
      list.push(paletteCommand(PALETTES[i], palette));
    }

    list.push({
      id: 'settings', glyph: GLYPH.gear, label: 'Settings', keys: ['Ctrl', ','],
      action: 'settings',
      run: function () { callModule('Settings', 'open'); }
    });
    list.push({
      id: 'downloads', glyph: GLYPH.down, label: 'Downloads', keys: ['Ctrl', 'J'],
      action: 'downloads',
      run: function () { callModule('Downloads', 'open'); }
    });
    list.push({
      id: 'downloads-folder', glyph: GLYPH.folder, label: 'Open downloads folder',
      hint: 'The folder itself, in Explorer',
      run: function () { openDownloadsFolder(); }
    });
    list.push({
      id: 'site-info', glyph: GLYPH.info, label: 'Site info',
      hint: 'Connection, permissions, stored data',
      run: function () { callModule('SiteInfo', 'open'); }
    });
    list.push({
      id: 'shield', glyph: GLYPH.shield, label: 'Ad blocking',
      hint: 'What the shield stopped on this page',
      run: function () { callModule('Shield', 'open'); }
    });
    list.push({
      id: 'fullscreen', glyph: GLYPH.screen, label: 'Fullscreen', keys: ['F11'],
      action: 'fullscreen',
      run: function () { callGlobal(function () { return toggleFullscreen; }); }
    });
    list.push({
      id: 'history', glyph: GLYPH.history, label: 'History',
      hint: 'Everywhere this browser has been', action: 'history',
      keys: ['Ctrl', 'H'],
      run: function () { openHistory(); }
    });
    list.push({
      id: 'clear-history', glyph: GLYPH.trash,
      // Half-confirmed, the two lines swap: the warning takes the label, and
      // the verb drops to the hint so the row still answers the query that
      // found it ("history" must not make its own row disappear).
      label: pendingId === 'clear-history' ? 'Press Enter again to clear' : 'Clear browsing history',
      hint: pendingId === 'clear-history' ? 'Clear browsing history' : 'Every visit this browser remembers',
      confirm: true,
      run: function () { callModule('History', 'clear'); }
    });

    // Last: every row that names an action wears the binding it has RIGHT NOW,
    // so rebinding a shortcut re-labels the palette with no other work.
    for (var k = 0; k < list.length; k++) {
      if (list[k].action) list[k].keys = keysFor(list[k]);
    }

    return list;
  }

  /** One palette row. Split out so the loop does not capture the loop variable. */
  function paletteCommand(entry, current) {
    return {
      id: 'palette-' + entry.id,
      glyph: GLYPH.color,
      label: 'Palette: ' + entry.label,
      check: entry.id === current,
      run: function () {
        callModule('Settings', 'applyPalette', entry.id);
        var settings = moduleRef('Settings');
        if (settings && typeof settings.set === 'function') {
          try { settings.set({ palette: entry.id }); } catch (err) { /* storage blocked */ }
        }
      }
    };
  }

  /** The commands a `when()` lets through, in table order. */
  function visibleCommands() {
    var all = buildCommands();
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var cmd = all[i];
      var on = true;
      if (typeof cmd.when === 'function') {
        try { on = !!cmd.when(); } catch (err) { on = false; }
      }
      if (on) out.push(cmd);
    }
    return out;
  }

  /* --- command mode: the query, the filter, the ranking ----------- */

  /**
   * The command query, or null when this is still a tab search. Leading spaces
   * are ignored so a stray one before the `>` does not drop out of the mode.
   */
  function commandQueryOf(value) {
    var s = String(value == null ? '' : value).replace(/^\s+/, '');
    if (s.charAt(0) !== CMD_PREFIX) return null;
    return s.slice(1).trim();
  }

  function isCommandMode() {
    return commandQueryOf(inputEl ? inputEl.value : '') !== null;
  }

  /** Same rule as a tab: every word has to land on the label or the hint. */
  function commandMatches(cmd, words) {
    if (!words || !words.length) return true;
    var label = String(cmd.label || '').toLowerCase();
    var hint = String(cmd.hint || '').toLowerCase();
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (label.indexOf(w) < 0 && hint.indexOf(w) < 0) return false;
    }
    return true;
  }

  /** 0 label starts with the query, 1 label contains it, 2 the hint carried it. */
  function commandRank(cmd, query) {
    var q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return 0;
    var label = String(cmd.label || '').toLowerCase();
    if (label.indexOf(q) === 0) return 0;
    if (label.indexOf(q) >= 0) return 1;
    return 2;
  }

  /** The command list for a query: filtered, ranked, table order as tiebreak. */
  function collectCommands(query) {
    var words = tokenize(query);
    var all = visibleCommands();
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var cmd = all[i];
      if (!commandMatches(cmd, words)) continue;
      cmd.kind = 'command';
      cmd.order = i;
      cmd.rank = commandRank(cmd, query);
      out.push(cmd);
    }
    out.sort(function (a, b) { return (a.rank - b.rank) || (a.order - b.order); });
    return out;
  }

  /* ============================================================
     DOM
     ============================================================ */

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function glyphEl(ch, cls) {
    var node = el('span', cls ? ('glyph ' + cls) : 'glyph');
    node.textContent = ch;
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  /** The titlebar instrument: #newtab's shape, one slot to its right. */
  function injectButton() {
    if (document.getElementById('tabsearch-btn')) {
      btnEl = document.getElementById('tabsearch-btn');
      return;
    }
    var titlebar = document.getElementById('titlebar');
    if (!titlebar) return;

    btnEl = el('button', 'no-drag');
    btnEl.id = 'tabsearch-btn';
    btnEl.type = 'button';
    btnEl.title = 'Search tabs';
    btnEl.setAttribute('aria-label', 'Search tabs');
    btnEl.setAttribute('aria-haspopup', 'dialog');
    btnEl.setAttribute('aria-expanded', 'false');
    btnEl.appendChild(glyphEl(GLYPH.list));
    btnEl.addEventListener('click', function () { toggle(); });

    var newtab = document.getElementById('newtab');
    if (newtab && newtab.parentNode === titlebar) {
      titlebar.insertBefore(btnEl, newtab.nextSibling || null);
    } else {
      titlebar.appendChild(btnEl);
    }
  }

  function buildPanel() {
    if (document.getElementById('tabsearch')) {
      rootEl = document.getElementById('tabsearch');
      inputEl = document.getElementById('tabsearch-input');
      listEl = document.getElementById('ts-list');
      return;
    }
    if (!document.body) return;

    rootEl = el('div', 'glass');
    rootEl.id = 'tabsearch';
    rootEl.hidden = true;
    rootEl.setAttribute('role', 'dialog');
    rootEl.setAttribute('aria-label', 'Search tabs');

    var field = el('div', 'ts-field');
    fieldIcoEl = glyphEl(GLYPH.search, 'ts-field-ico');
    field.appendChild(fieldIcoEl);

    inputEl = document.createElement('input');
    inputEl.id = 'tabsearch-input';
    inputEl.type = 'text';
    inputEl.placeholder = 'Search tabs';
    inputEl.setAttribute('aria-label', 'Search tabs');
    inputEl.setAttribute('autocomplete', 'off');
    inputEl.setAttribute('spellcheck', 'false');
    inputEl.setAttribute('role', 'combobox');
    inputEl.setAttribute('aria-expanded', 'true');
    inputEl.setAttribute('aria-controls', 'ts-list');
    field.appendChild(inputEl);

    listEl = el('div', 'ts-list');
    listEl.id = 'ts-list';
    listEl.setAttribute('role', 'listbox');

    rootEl.appendChild(field);
    rootEl.appendChild(listEl);
    document.body.appendChild(rootEl);

    // Wired here rather than in wire(): these two are the pane's own, so they
    // are attached the moment the pane exists, whatever order boot ran in.
    rootEl.addEventListener('keydown', onKeyDown);
    // Any edit of the query abandons a half-confirmed command: the row the
    // second Enter was meant for is not necessarily under the cursor any more.
    inputEl.addEventListener('input', function () { pendingId = null; render(0); });
  }

  function captionEl(text) {
    var cap = el('div', 'ts-cap');
    cap.textContent = text;
    return cap;
  }

  function tagEl(ch, text) {
    var tag = el('span', 'ts-tag');
    if (ch) tag.appendChild(glyphEl(ch, 'ts-tag-ico'));
    var label = el('span', 'ts-tag-text');
    label.textContent = text;
    tag.appendChild(label);
    return tag;
  }

  /** The icon column: the page's own favicon, the Claude light, or a globe. */
  function iconFor(entry) {
    var box = el('span', 'ts-ico');
    if (entry.claude) {
      box.appendChild(el('span', 'ts-dot'));
      return box;
    }
    var src = null;
    var img = entry.tab && entry.tab.iconEl;
    try { src = (img && typeof img.getAttribute === 'function') ? img.getAttribute('src') : null; } catch (err) { src = null; }
    if (src) {
      var clone = null;
      try { clone = img.cloneNode(false); } catch (err) { clone = null; }
      if (clone) {
        clone.className = 'ts-favicon';
        try { clone.removeAttribute('id'); } catch (err) { /* never had one */ }
        box.appendChild(clone);
        return box;
      }
    }
    box.appendChild(glyphEl(GLYPH.globe));
    return box;
  }

  function rowShell(index) {
    var row = el('div', 'ts-row');
    row.id = 'ts-row-' + index;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    return row;
  }

  function bodyEl(primary, secondNode) {
    var body = el('span', 'ts-body');
    var line1 = el('span', 'ts-primary');
    line1.textContent = primary;
    body.appendChild(line1);
    // A command with no hint is one line: an empty second line would only pad
    // the row, so it is left out rather than rendered blank.
    if (secondNode) body.appendChild(secondNode);
    return body;
  }

  function buildTabRow(entry, index) {
    var row = rowShell(index);
    row.appendChild(iconFor(entry));

    var second = el('span', 'ts-secondary');
    var host = el('span', 'ts-host');
    host.textContent = entry.second;
    second.appendChild(host);
    if (entry.current) second.appendChild(tagEl('', 'current'));
    if (entry.pinned) second.appendChild(tagEl(GLYPH.pin, 'pinned'));
    if (entry.muted) second.appendChild(tagEl(GLYPH.muted, 'muted'));
    if (entry.audible) second.appendChild(tagEl(GLYPH.audible, 'playing'));
    if (entry.asleep) second.appendChild(tagEl(GLYPH.asleep, 'sleeping'));

    row.appendChild(bodyEl(entry.title, second));

    var close = el('button', 'ts-close');
    close.type = 'button';
    close.title = 'Close tab';
    close.setAttribute('aria-label', 'Close tab');
    close.appendChild(glyphEl(GLYPH.close));
    close.addEventListener('click', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      closeRow(entry);
    });
    row.appendChild(close);

    row.addEventListener('click', function () { activateIndex(indexOfRow(row)); });
    return row;
  }

  function buildClosedRow(entry, index) {
    var row = rowShell(index);
    row.classList.add('ts-row--closed');

    var box = el('span', 'ts-ico');
    box.appendChild(glyphEl(GLYPH.history));
    row.appendChild(box);

    var second = el('span', 'ts-secondary');
    var urlText = el('span', 'ts-host');
    urlText.textContent = entry.url;
    second.appendChild(urlText);

    row.appendChild(bodyEl(entry.title, second));
    row.addEventListener('click', function () { activateIndex(indexOfRow(row)); });
    return row;
  }

  /** The keycaps on the right of a command row: one cap per key, in order. */
  function keysEl(keys) {
    var box = el('span', 'ts-keys');
    for (var i = 0; i < keys.length; i++) {
      var cap = el('span', 'ts-key');
      cap.textContent = keys[i];
      box.appendChild(cap);
    }
    return box;
  }

  function buildCommandRow(cmd, index) {
    var row = rowShell(index);
    row.classList.add('ts-row--cmd');

    var box = el('span', 'ts-ico ts-ico--cmd');
    box.appendChild(glyphEl(cmd.glyph || GLYPH.chevron));
    row.appendChild(box);

    var hint = null;
    if (cmd.hint) {
      hint = el('span', 'ts-secondary ts-cmd-hint');
      hint.textContent = cmd.hint;
    }
    row.appendChild(bodyEl(cmd.label, hint));

    // The right-hand slot is one or the other: a palette that is being worn
    // wears a check there, everything else shows the keys that also run it.
    if (cmd.check) {
      var mark = el('span', 'ts-keys');
      mark.appendChild(glyphEl(GLYPH.check, 'ts-check'));
      row.appendChild(mark);
    } else if (cmd.keys && cmd.keys.length) {
      row.appendChild(keysEl(cmd.keys));
    }

    row.addEventListener('click', function () { activateIndex(indexOfRow(row)); });
    return row;
  }

  function indexOfRow(row) {
    for (var i = 0; i < rows.length; i++) if (rows[i].el === row) return i;
    return -1;
  }

  /* ============================================================
     Render
     ============================================================ */

  function render(keepIndex) {
    if (!listEl) return;
    var value = inputEl ? inputEl.value : '';
    var query = commandQueryOf(value);
    syncMode(query !== null);

    rows = [];
    listEl.textContent = '';               // clears the children, no reset needed

    if (query !== null) renderCommands(query);
    else renderTabs(value);

    if (!rows.length) {
      var empty = el('div', 'ts-empty');
      empty.textContent = (query !== null) ? 'No matching commands' : 'No matching tabs';
      listEl.appendChild(empty);
    }

    var want = (typeof keepIndex === 'number') ? keepIndex : 0;
    setHighlight(rows.length ? Math.max(0, Math.min(want, rows.length - 1)) : -1);
  }

  /**
   * The field belongs to whichever mode the query is in: its mark, its
   * placeholder and the pane's label all change, and .is-commands lets the
   * stylesheet dress the rows differently without a second panel.
   */
  function syncMode(on) {
    if (rootEl) {
      if (rootEl.classList) rootEl.classList.toggle('is-commands', !!on);
      rootEl.setAttribute('aria-label', on ? 'Run a command' : 'Search tabs');
    }
    if (fieldIcoEl) fieldIcoEl.textContent = on ? GLYPH.chevron : GLYPH.search;
    if (inputEl) {
      inputEl.placeholder = on ? 'Type a command' : 'Search tabs';
      inputEl.setAttribute('aria-label', on ? 'Type a command' : 'Search tabs');
    }
  }

  function renderCommands(query) {
    var list = collectCommands(query);
    for (var i = 0; i < list.length; i++) {
      var row = buildCommandRow(list[i], rows.length);
      list[i].el = row;
      rows.push(list[i]);
      listEl.appendChild(row);
    }
  }

  function renderTabs(value) {
    var data = collect(value);
    var i, row;
    for (i = 0; i < data.open.length; i++) {
      row = buildTabRow(data.open[i], rows.length);
      data.open[i].el = row;
      rows.push(data.open[i]);
      listEl.appendChild(row);
    }

    if (data.extra > 0) {
      var more = el('div', 'ts-more');
      more.textContent = '+' + data.extra + ' more';
      listEl.appendChild(more);
    }

    if (data.closed.length) {
      listEl.appendChild(captionEl('Recently closed'));
      for (i = 0; i < data.closed.length; i++) {
        row = buildClosedRow(data.closed[i], rows.length);
        data.closed[i].el = row;
        rows.push(data.closed[i]);
        listEl.appendChild(row);
      }
    }
  }

  function setHighlight(index) {
    hi = index;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i].el;
      if (!row) continue;
      var on = (i === index);
      row.classList.toggle('is-hi', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (inputEl) {
      if (index >= 0 && rows[index] && rows[index].el) {
        inputEl.setAttribute('aria-activedescendant', rows[index].el.id);
      } else {
        inputEl.removeAttribute('aria-activedescendant');
      }
    }
    var el_ = (index >= 0 && rows[index]) ? rows[index].el : null;
    if (el_ && typeof el_.scrollIntoView === 'function') {
      try { el_.scrollIntoView({ block: 'nearest' }); } catch (err) { /* not laid out */ }
    }
  }

  function move(delta) {
    if (!rows.length) return;
    var next = hi + delta;
    if (next < 0) next = rows.length - 1;
    if (next >= rows.length) next = 0;
    setHighlight(next);
  }

  /* ============================================================
     Actions
     ============================================================ */

  function activateIndex(index) {
    if (index < 0 || index >= rows.length) return;
    var entry = rows[index];
    if (entry.kind === 'command') { runCommand(entry); return; }
    if (entry.kind === 'closed') { reopen(entry); return; }
    doActivate(entry.id);
    close();
  }

  /**
   * Run a command. The pane goes first — a verb that opens a panel or a dialog
   * must not have to reach around the palette that launched it — and the action
   * itself is guarded, so an app.js that dropped the global just does nothing.
   *
   * A `confirm` command takes two Enters: the first only relabels its own row,
   * which is the whole warning. Anything else (a keystroke, a close) drops it.
   */
  function runCommand(cmd) {
    if (!cmd || typeof cmd.run !== 'function') return;
    if (cmd.confirm && pendingId !== cmd.id) {
      pendingId = cmd.id;
      render(hi);
      return;
    }
    pendingId = null;
    close();
    try { cmd.run(); } catch (err) { /* the action is gone; the pane still closed */ }
  }

  /** Reopen a closed url and take it off the stack, so it is offered once. */
  function reopen(entry) {
    var stack = closedList();
    var index = entry.index;
    if (stack[index] !== entry.url) index = stack.lastIndexOf(entry.url);
    if (index >= 0) stack.splice(index, 1);
    doCreate(entry.url);
    close();
  }

  /** The per-row close: the pane stays open, so a cleanup pass is one visit. */
  function closeRow(entry) {
    var at = indexOfRow(entry.el);
    doClose(entry.id);
    render(at < 0 ? 0 : at);
  }

  /* ============================================================
     Open / close
     ============================================================ */

  function isOpen() { return open_; }

  function open() {
    // The pane is built at boot; this only matters if boot ran before the
    // document had a <body> or a #titlebar to build into.
    if (!btnEl) injectButton();
    if (!rootEl) buildPanel();
    wire();
    if (!rootEl) return;
    open_ = true;
    rootEl.hidden = false;
    if (btnEl) {
      btnEl.classList.add('is-on');
      btnEl.setAttribute('aria-expanded', 'true');
    }
    if (inputEl) inputEl.value = '';
    pendingId = null;
    probeReader();
    render(0);
    if (inputEl && typeof inputEl.focus === 'function') {
      try { inputEl.focus(); } catch (err) { /* not attached yet */ }
    }
  }

  /** Straight into command mode: the `>` is typed for you, caret behind it. */
  function openCommands() {
    open();
    if (!inputEl) return;
    inputEl.value = CMD_PREFIX;
    render(0);
    if (typeof inputEl.setSelectionRange === 'function') {
      try { inputEl.setSelectionRange(1, 1); } catch (err) { /* not a text field yet */ }
    }
    if (typeof inputEl.focus === 'function') {
      try { inputEl.focus(); } catch (err) { /* not attached yet */ }
    }
  }

  /**
   * Reader.canRead() answers on a promise, so the row cannot be built from it
   * directly: the answer is resolved once per open and parked, and the list
   * re-renders if it lands while the commands are the thing on screen.
   */
  function probeReader() {
    readerOk = false;
    var reader = moduleRef('Reader');
    if (!reader || typeof reader.canRead !== 'function') return;
    var answer;
    try { answer = reader.canRead(activeTab()); } catch (err) { return; }
    if (answer && typeof answer.then === 'function') {
      try {
        answer.then(function (ok) { setReaderOk(ok); }, function () { /* unreadable */ });
      } catch (err) { /* not a real promise */ }
      return;
    }
    setReaderOk(answer);
  }

  function setReaderOk(ok) {
    if (readerOk === !!ok) return;
    readerOk = !!ok;
    if (open_ && isCommandMode()) render(hi < 0 ? 0 : hi);
  }

  function close() {
    if (!open_) return;
    open_ = false;
    if (rootEl) rootEl.hidden = true;
    if (btnEl) {
      btnEl.classList.remove('is-on');
      btnEl.setAttribute('aria-expanded', 'false');
    }
    rows = [];
    hi = -1;
    pendingId = null;
  }

  function toggle() { if (open_) close(); else open(); }

  function handleShortcut(action) {
    if (action === 'tabsearch') { toggle(); return true; }
    if (action === 'command-palette') { openCommands(); return true; }
    if (action === 'escape') {
      if (!open_) return false;
      close();
      return true;
    }
    return false;
  }

  /* ============================================================
     Wiring
     ============================================================ */

  function onKeyDown(event) {
    if (!open_ || !event) return;
    var key = event.key;
    if (key === 'ArrowDown') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      move(1);
    } else if (key === 'ArrowUp') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      move(-1);
    } else if (key === 'Enter') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      activateIndex(hi);
    } else if (key === 'Escape') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      close();
    } else if (key === 'Tab') {
      // Nothing behind the pane is reachable by Tab, so Tab means "leave".
      if (typeof event.preventDefault === 'function') event.preventDefault();
      close();
    }
  }

  function wire() {
    if (wired) return;
    wired = true;

    // A press that starts anywhere else dismisses the pane, the same as the
    // shield popover. Capture, so a page-level handler cannot swallow it.
    document.addEventListener('mousedown', function (event) {
      if (!open_) return;
      var target = event && event.target;
      if (rootEl && rootEl.contains && target && rootEl.contains(target)) return;
      if (btnEl && btnEl.contains && target && btnEl.contains(target)) return;
      close();
    }, true);
  }

  function boot() {
    injectButton();
    buildPanel();
    wire();
  }

  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else if (typeof document !== 'undefined') {
    boot();
  }

  window.TabSearch = {
    open: open,
    openCommands: openCommands,
    close: close,
    toggle: toggle,
    isOpen: isOpen,
    handleShortcut: handleShortcut,
    // Pure model, reachable so it can be exercised without a window.
    _helpers: {
      describeTab: describeTab,
      tokenize: tokenize,
      matches: matches,
      rankOf: rankOf,
      collect: collect,
      // command mode
      buildCommands: buildCommands,
      visibleCommands: visibleCommands,
      keysFor: keysFor,
      collectCommands: collectCommands,
      commandQueryOf: commandQueryOf,
      commandMatches: commandMatches,
      commandRank: commandRank,
      isCommandMode: isCommandMode,
      pending: function () { return pendingId; },
      CMD_PREFIX: CMD_PREFIX,
      render: render,
      rowsOf: function () { return rows; },
      highlight: function () { return hi; },
      setHighlight: setHighlight,
      move: move,
      activateIndex: activateIndex,
      onKeyDown: onKeyDown,
      MAX_OPEN: MAX_OPEN,
      MAX_CLOSED: MAX_CLOSED
    }
  };
})();
