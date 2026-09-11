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
 *     accentHue:    null | 0..360,
 *     chips:        null | [{ label, url }, ...],
 *     homepage:     'newtab',
 *     claudeDir:    null | absolute path,   // null means the home folder
 *     claudeResume: true | false }          // --continue on a restored tab
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

  var STORAGE_KEY = 'settings';

  var DEFAULTS = {
    searchEngine: 'google',
    siteTheme: 'system',
    accentHue: null,
    chips: null,
    homepage: 'newtab',
    claudeDir: null,
    claudeResume: true
  };

  var ENGINES = [
    { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
    { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
    { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
    { id: 'brave', name: 'Brave', url: 'https://search.brave.com/search?q=' },
    { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/do/search?q=' }
  ];

  var SITE_THEMES = [
    { id: 'system', name: 'Follow Windows' },
    { id: 'light', name: 'Always light' },
    { id: 'dark', name: 'Always dark' }
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
    ['Ctrl+P', 'Print page'],
    ['Ctrl+J', 'Downloads'],
    ['Ctrl+H', 'History'],
    ['Ctrl+D', 'Add this page to your new tab'],
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
    if (keys.indexOf('accentHue') >= 0) applyAccent(get('accentHue'));
    if (keys.indexOf('siteTheme') >= 0) pushSiteTheme(get('siteTheme'));
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

    var accent = el('div', 'set-field set-accent');
    accent.setAttribute('data-field', 'accent');
    s.appendChild(accent);
    return s;
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

    var def = textButton('Default', 'set-text', function () { set({ accentHue: null }); });
    def.disabled = hue === null || hue === undefined;
    row.appendChild(def);

    accentField.appendChild(row);
    accentField.appendChild(el('p', 'set-hint', 'One colour marks what is active, everywhere.'));
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

  function buildChips() {
    var s = section('New tab shortcuts');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'chips');
    s.appendChild(field);
    return s;
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
    bodyEl.appendChild(buildSearch());
    bodyEl.appendChild(buildSites());
    bodyEl.appendChild(buildChips());
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
    renderSearch();
    renderSites();
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
      if (keys.indexOf('accentHue') >= 0) renderLook();
      if (keys.indexOf('claudeDir') >= 0) renderClaudeDir();
      if (keys.indexOf('claudeResume') >= 0) renderClaudeResume();
      if (keys.indexOf('searchEngine') >= 0) renderSearch();
      if (keys.indexOf('siteTheme') >= 0) renderSites();
      if (keys.indexOf('chips') >= 0) renderChips();
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
    addChip: addChip,
    removeChip: removeChip,
    updateChip: updateChip,
    moveChip: moveChip,

    engines: engines,
    searchUrl: searchUrl,
    isSearchUrl: isSearchUrl,

    applyAccent: applyAccent,
    open: openPanel,
    close: closePanel,
    toggle: toggle,
    isOpen: isOpen,
    handleShortcut: handleShortcut,

    // test seams
    _defaults: DEFAULTS,
    _normalizeUrl: normalizeUrl,
    _hostnameOf: hostnameOf
  };
})();
