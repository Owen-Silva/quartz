/* ============================================================
   shortcuts.js — the one place that knows what every key does.

   Until now the bindings lived twice: a keydown ladder in app.js
   (wireKeyboard) for when the chrome has focus, and a lookup table in
   main.js (SHORTCUTS / shortcutFor) for when a <webview> swallowed the
   press instead. This module is the single table both of them read, and
   the one the settings page rewrites.

   THE SHAPE

   1. ACTIONS — every rebindable thing the browser can do, in the order
      settings should list it, grouped Tabs / Navigate / Claude / Tools /
      View. A few are `fixed: true`: Ctrl+Tab, Ctrl+Shift+Tab and
      Ctrl+1..9 are structural, and rebinding them would strand the user.

   2. COMBOS — a canonical string per press: modifiers in the order
      Ctrl, Alt, Shift, then one normalised key. `Ctrl+Shift+K`,
      `Alt+Left`, `F5`, `Ctrl+=`, `Ctrl+\`. combo() reads a DOM
      KeyboardEvent, fromMainInput() reads Electron's before-input-event
      `input` object, and both land on the same string so the chrome and
      the main process can never disagree about what was pressed.

   3. STORAGE — localStorage['shortcuts'] = { v:1, overrides: { id:
      combo|null } }. Only what the user changed is stored; null means
      "deliberately unbound". A missing or corrupt record reads as "no
      overrides" rather than an error, like history.js does.

   Style: classic script, no modules, no DOM, no CSS. Load it BEFORE
   app.js — it has no dependencies and app.js wants it at init.
   ============================================================ */

(function () {
  'use strict';

  /* --- constants ---------------------------------------------- */

  var STORAGE_KEY = 'shortcuts';
  var STORAGE_VERSION = 1;

  var GROUPS = ['Tabs', 'Navigate', 'Claude', 'Tools', 'View'];

  /* Every action the keyboard can reach, in display order.
     - default: the factory combo, or null for "ships unbound".
     - fixed:   structural; set() refuses it and refuses its combos.
     - alias:   extra combos a fixed path also answers to.
     - reserved: combos the action owns without one canonical default. */
  var ACTIONS = [
    /* -- Tabs -------------------------------------------------- */
    { id: 'new-tab',        label: 'New tab',                 group: 'Tabs',     default: 'Ctrl+T' },
    { id: 'close-tab',      label: 'Close tab',               group: 'Tabs',     default: 'Ctrl+W' },
    { id: 'reopen-tab',     label: 'Reopen closed tab',       group: 'Tabs',     default: 'Ctrl+Shift+T' },
    { id: 'next-tab',       label: 'Next tab',                group: 'Tabs',     default: 'Ctrl+Tab', fixed: true },
    { id: 'prev-tab',       label: 'Previous tab',            group: 'Tabs',     default: 'Ctrl+Shift+Tab', fixed: true },
    { id: 'select-tab',     label: 'Jump to tab 1-9',         group: 'Tabs',     default: null, fixed: true,
      hint: 'Ctrl+1 ... Ctrl+9',
      reserved: ['Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7', 'Ctrl+8', 'Ctrl+9'] },
    { id: 'move-tab-left',  label: 'Move tab left',           group: 'Tabs',     default: 'Ctrl+Shift+PageUp' },
    { id: 'move-tab-right', label: 'Move tab right',          group: 'Tabs',     default: 'Ctrl+Shift+PageDown' },
    { id: 'tabsearch',      label: 'Search tabs',             group: 'Tabs',     default: 'Ctrl+Shift+A' },
    { id: 'split',          label: 'Split with next tab',     group: 'Tabs',     default: 'Ctrl+\\' },
    /* Ctrl+Shift+W is muscle memory for "close the window" everywhere else,
       so the workspaces panel takes Ctrl+Shift+E instead. */
    { id: 'workspaces',     label: 'Workspaces',              group: 'Tabs',     default: 'Ctrl+Shift+E' },
    { id: 'workspace-next', label: 'Next workspace',          group: 'Tabs',     default: 'Ctrl+Alt+Right' },
    { id: 'workspace-prev', label: 'Previous workspace',      group: 'Tabs',     default: 'Ctrl+Alt+Left' },

    /* -- Navigate ---------------------------------------------- */
    { id: 'focus-omnibox',  label: 'Focus the address bar',   group: 'Navigate', default: 'Ctrl+L' },
    { id: 'back',           label: 'Back',                    group: 'Navigate', default: 'Alt+Left' },
    { id: 'forward',        label: 'Forward',                 group: 'Navigate', default: 'Alt+Right' },
    { id: 'reload',         label: 'Reload page (also Ctrl+R)', group: 'Navigate', default: 'F5', alias: ['Ctrl+R'] },
    { id: 'history',        label: 'History',                 group: 'Navigate', default: 'Ctrl+H' },
    { id: 'bookmark',       label: 'Bookmark this page',      group: 'Navigate', default: 'Ctrl+D' },
    { id: 'bookmarks-bar',  label: 'Show bookmarks bar',      group: 'Navigate', default: 'Ctrl+Shift+B' },

    /* -- Claude ------------------------------------------------ */
    { id: 'toggle-terminal', label: 'Claude chamber',         group: 'Claude',   default: 'Ctrl+`' },
    { id: 'claude-folder',  label: 'Claude in a folder',      group: 'Claude',   default: 'Ctrl+Shift+`' },
    { id: 'claude-split',   label: 'Claude beside the page',  group: 'Claude',   default: 'Ctrl+Shift+\\' },
    { id: 'show-claude',    label: 'Show Claude this page',   group: 'Claude',   default: 'Ctrl+Alt+K' },
    { id: 'ask-claude',     label: 'Ask Claude about this page', group: 'Claude', default: 'Ctrl+Shift+K' },

    /* -- Tools ------------------------------------------------- */
    { id: 'command-palette', label: 'Command palette',        group: 'Tools',    default: 'Ctrl+K' },
    { id: 'find',           label: 'Find on page',            group: 'Tools',    default: 'Ctrl+F' },
    { id: 'downloads',      label: 'Downloads',               group: 'Tools',    default: 'Ctrl+J' },
    { id: 'reader',         label: 'Reader view',             group: 'Tools',    default: 'Ctrl+Shift+R' },
    { id: 'capture',        label: 'Capture page',            group: 'Tools',    default: 'Ctrl+Shift+S' },
    { id: 'print',          label: 'Print',                   group: 'Tools',    default: 'Ctrl+P' },
    { id: 'settings',       label: 'Settings',                group: 'Tools',    default: 'Ctrl+,' },

    /* -- View -------------------------------------------------- */
    { id: 'zoom-in',        label: 'Zoom in',                 group: 'View',     default: 'Ctrl+=' },
    { id: 'zoom-out',       label: 'Zoom out',                group: 'View',     default: 'Ctrl+-' },
    { id: 'zoom-reset',     label: 'Reset zoom',              group: 'View',     default: 'Ctrl+0' },
    { id: 'fullscreen',     label: 'Fullscreen',              group: 'View',     default: 'F11' },
    { id: 'pip',            label: 'Picture in picture',      group: 'View',     default: 'Alt+P' },
    { id: 'toggle-theme',   label: 'Switch light / dark',     group: 'View',     default: null },
    { id: 'userstyle-reset', label: 'Reset browser style',    group: 'View',     default: 'Ctrl+Alt+Shift+R' }
  ];

  /* --- key normalisation -------------------------------------- */

  // A press of a modifier on its own is not a combo.
  var MODIFIER_KEYS = {
    Control: 1, Ctrl: 1, Alt: 1, AltGraph: 1, Shift: 1, Meta: 1,
    OS: 1, CapsLock: 1, NumLock: 1, ScrollLock: 1, Dead: 1, Unidentified: 1
  };

  // event.key / input.key spellings -> the canonical name used in a combo.
  var NAMED_KEYS = {
    ArrowLeft: 'Left', Left: 'Left',
    ArrowRight: 'Right', Right: 'Right',
    ArrowUp: 'Up', Up: 'Up',
    ArrowDown: 'Down', Down: 'Down',
    PageUp: 'PageUp', PageDown: 'PageDown',
    Home: 'Home', End: 'End',
    Tab: 'Tab', Enter: 'Enter', Return: 'Enter',
    ' ': 'Space', Space: 'Space', Spacebar: 'Space',
    Backspace: 'Backspace',
    Delete: 'Delete', Del: 'Delete',
    Insert: 'Insert',
    Escape: 'Escape', Esc: 'Escape'
  };

  // Punctuation that stands for itself in a combo.
  var LITERAL_KEYS = {
    ',': 1, '.': 1, '/': 1, '\\': 1, '=': 1, '-': 1,
    '`': 1, '[': 1, ']': 1, ';': 1, "'": 1
  };

  // What Shift does to a US layout, undone. Electron hands Ctrl+Shift+\
  // over as '|' and Ctrl+Shift+` as '~'; both mean the unshifted key plus
  // Shift, so the shift flag is forced on when one of these arrives.
  var SHIFTED_KEYS = {
    '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
    '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
    '_': '-', '+': '=', '{': '[', '}': ']', ':': ';',
    '"': "'", '<': ',', '>': '.', '?': '/', '|': '\\'
  };

  // Keycap text. Everything not listed prints as itself.
  var DISPLAY_KEYS = {
    Left: '←', Right: '→', Up: '↑', Down: '↓',
    PageUp: 'PgUp', PageDown: 'PgDn',
    Backslash: '\\', Backspace: '⌫', Space: 'Space', Escape: 'Esc'
  };

  var F_KEY = /^F([1-9]|1[0-2])$/;

  function isFKey(key) { return F_KEY.test(key); }

  /* Normalise one raw key into { key, shift }, or null if it can never be
     half of a combo. `shift` comes back true when the raw key was itself a
     shifted character. */
  function normaliseKey(rawKey, shift) {
    if (rawKey === null || rawKey === undefined) return null;
    var key = String(rawKey);
    if (!key) return null;
    if (MODIFIER_KEYS[key]) return null;
    if (NAMED_KEYS[key]) return { key: NAMED_KEYS[key], shift: !!shift };
    if (isFKey(key)) return { key: key, shift: !!shift };
    if (key.length === 1) {
      if (SHIFTED_KEYS[key]) return { key: SHIFTED_KEYS[key], shift: true };
      if (/^[a-z]$/.test(key)) return { key: key.toUpperCase(), shift: !!shift };
      if (/^[A-Z0-9]$/.test(key)) return { key: key, shift: !!shift };
      if (LITERAL_KEYS[key]) return { key: key, shift: !!shift };
      return null;
    }
    // A token typed into settings ('left', 'f5', 'pageup', 'backslash').
    var lower = key.toLowerCase();
    var named = NAMED_LOWER[lower];
    if (named) return { key: named, shift: !!shift };
    if (lower === 'backslash') return { key: '\\', shift: !!shift };
    if (/^f([1-9]|1[0-2])$/.test(lower)) return { key: 'F' + lower.slice(1), shift: !!shift };
    return null;
  }

  var NAMED_LOWER = (function () {
    var out = {};
    for (var raw in NAMED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, raw)) {
        out[raw.toLowerCase()] = NAMED_KEYS[raw];
      }
    }
    return out;
  })();

  /* Build the canonical string. Meta is never part of a binding — the
     chrome ignores metaKey entirely — and a printable key with no Ctrl or
     Alt is just typing, so both come back null. F-keys are the exception:
     F5 and F11 are bindings all by themselves. */
  function comboFrom(rawKey, ctrl, alt, shift, meta) {
    if (meta) return null;
    var norm = normaliseKey(rawKey, shift);
    if (!norm) return null;
    if (!ctrl && !alt && !isFKey(norm.key)) return null;
    var parts = [];
    if (ctrl) parts.push('Ctrl');
    if (alt) parts.push('Alt');
    if (norm.shift) parts.push('Shift');
    parts.push(norm.key);
    return parts.join('+');
  }

  /** A DOM KeyboardEvent -> combo string, or null. */
  function combo(event) {
    if (!event || typeof event !== 'object') return null;
    return comboFrom(event.key, event.ctrlKey, event.altKey, event.shiftKey, event.metaKey);
  }

  /** Electron's before-input-event `input` -> the same combo string. */
  function fromMainInput(input) {
    if (!input || typeof input !== 'object') return null;
    if (input.type && input.type !== 'keyDown') return null;
    var ctrl = input.control || input.ctrl || input.ctrlKey;
    var alt = input.alt || input.altKey;
    var shift = input.shift || input.shiftKey;
    var meta = input.meta || input.metaKey || input.command;
    return comboFrom(input.key, ctrl, alt, shift, meta);
  }

  /** A combo string -> { ctrl, alt, shift, key, combo }, or null. */
  function parse(str) {
    if (typeof str !== 'string') return null;
    var raw = str.trim();
    if (!raw) return null;
    var parts = raw.split('+');
    var keyToken = parts.pop();
    // "Ctrl++" — the key itself is a plus.
    if (keyToken === '' && parts.length && parts[parts.length - 1] === '') {
      parts.pop();
      keyToken = '+';
    }
    var ctrl = false, alt = false, shift = false;
    for (var i = 0; i < parts.length; i++) {
      var mod = parts[i].trim().toLowerCase();
      if (mod === 'ctrl' || mod === 'control') ctrl = true;
      else if (mod === 'alt' || mod === 'option') alt = true;
      else if (mod === 'shift') shift = true;
      else return null; // meta/cmd/win and anything else are not bindings
    }
    var norm = normaliseKey(keyToken.trim(), shift);
    if (!norm) return null;
    if (!ctrl && !alt && !isFKey(norm.key)) return null;
    var out = [];
    if (ctrl) out.push('Ctrl');
    if (alt) out.push('Alt');
    if (norm.shift) out.push('Shift');
    out.push(norm.key);
    return { ctrl: ctrl, alt: alt, shift: norm.shift, key: norm.key, combo: out.join('+') };
  }

  /** The canonical spelling of a combo string, or null if it is not one. */
  function canonical(value) {
    var parsed = parse(value);
    return parsed ? parsed.combo : null;
  }

  /** Display parts for keycaps: 'Ctrl+Shift+K' -> ['Ctrl','Shift','K']. */
  function label(value) {
    var parsed = parse(value);
    if (!parsed) return [];
    var parts = [];
    if (parsed.ctrl) parts.push('Ctrl');
    if (parsed.alt) parts.push('Alt');
    if (parsed.shift) parts.push('Shift');
    parts.push(DISPLAY_KEYS[parsed.key] || parsed.key);
    return parts;
  }

  /** The same thing as one string, for a title attribute or a menu. */
  function text(value) {
    var parts = label(value);
    return parts.length ? parts.join('+') : '';
  }

  /* --- the table ---------------------------------------------- */

  var INDEX = (function () {
    var out = {};
    for (var i = 0; i < ACTIONS.length; i++) out[ACTIONS[i].id] = ACTIONS[i];
    return out;
  })();

  function byId(id) {
    return (typeof id === 'string' && Object.prototype.hasOwnProperty.call(INDEX, id)) ? INDEX[id] : null;
  }

  /* Every combo a fixed action owns: its default, its aliases, and any
     combos it reserves without a single canonical one (Ctrl+1..9). */
  var RESERVED = (function () {
    var out = {};
    function claim(cmb, id) {
      var key = canonical(cmb);
      if (key && !out[key]) out[key] = id;
    }
    for (var i = 0; i < ACTIONS.length; i++) {
      var action = ACTIONS[i];
      var list = [];
      if (action.fixed && action.default) list.push(action.default);
      if (action.reserved) list = list.concat(action.reserved);
      if (action.alias) list = list.concat(action.alias);
      for (var j = 0; j < list.length; j++) claim(list[j], action.id);
    }
    return out;
  })();

  /* --- storage ------------------------------------------------ */

  var overrides = null;   // { id: combo|null }, lazily read
  var listeners = [];

  function storage() {
    try {
      return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
    } catch (err) {
      return null;
    }
  }

  function load() {
    if (overrides) return overrides;
    overrides = {};
    try {
      var store = storage();
      var raw = store ? store.getItem(STORAGE_KEY) : null;
      if (!raw) return overrides;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return overrides;
      var src = data.overrides;
      if (!src || typeof src !== 'object') return overrides;
      for (var id in src) {
        if (!Object.prototype.hasOwnProperty.call(src, id)) continue;
        var action = byId(id);
        if (!action || action.fixed) continue;     // stale or structural: drop it
        var value = src[id];
        if (value === null) { overrides[id] = null; continue; }
        var cmb = canonical(value);
        if (cmb) overrides[id] = cmb;
      }
    } catch (err) {
      overrides = overrides || {};
    }
    return overrides;
  }

  function save() {
    try {
      var store = storage();
      if (!store) return false;
      store.setItem(STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, overrides: load() }));
      return true;
    } catch (err) {
      return false;
    }
  }

  /* --- reading the bindings ----------------------------------- */

  /** The combo an action currently answers to, or null if unbound. */
  function get(id) {
    var action = byId(id);
    if (!action) return null;
    if (action.fixed) return action.default || null;
    var map = load();
    if (Object.prototype.hasOwnProperty.call(map, id)) return map[id];
    return action.default || null;
  }

  /** Every action, resolved, in display order — what settings renders. */
  function all() {
    var out = [];
    for (var i = 0; i < ACTIONS.length; i++) {
      var action = ACTIONS[i];
      var cmb = get(action.id);
      out.push({
        id: action.id,
        label: action.label,
        group: action.group,
        hint: action.hint || '',
        combo: cmb,
        default: action.default || null,
        fixed: !!action.fixed,
        changed: !action.fixed && cmb !== (action.default || null)
      });
    }
    return out;
  }

  /** { combo: actionId } for every bound rebindable action — main.js's copy. */
  function bindings() {
    var out = {};
    for (var i = 0; i < ACTIONS.length; i++) {
      var action = ACTIONS[i];
      if (action.fixed) continue;
      var cmb = get(action.id);
      if (cmb && !out[cmb]) out[cmb] = action.id;   // first wins if storage is odd
    }
    /* Aliases resolve as well as reserve: Ctrl+R has to actually reload, not
       merely be refused to everything else. They ride with the action, so one
       the user has unbound answers to neither combo, and a real binding on the
       same combo still wins. */
    for (var k = 0; k < ACTIONS.length; k++) {
      var extra = ACTIONS[k];
      if (extra.fixed || !extra.alias || !get(extra.id)) continue;
      for (var j = 0; j < extra.alias.length; j++) {
        var cmbAlias = canonical(extra.alias[j]);
        if (cmbAlias && !out[cmbAlias]) out[cmbAlias] = extra.id;
      }
    }
    return out;
  }

  /** Who holds this combo right now — a fixed action included — or null. */
  function conflict(value) {
    var cmb = canonical(value);
    if (!cmb) return null;
    if (RESERVED[cmb]) return RESERVED[cmb];
    var map = bindings();
    return map[cmb] || null;
  }

  /* Resolve a press to an action id. Digits, Tab, Escape and F12 belong to
     the callers (they carry an index, or the page needs them), so they are
     never claimed here: fixed actions are not in bindings().

     The one tolerance: a shifted punctuation combo that nothing holds falls
     back to its unshifted twin, so Ctrl+Shift+= (which Electron reports as
     Ctrl+'+') still zooms in. An exact match always wins first, which is
     what keeps Ctrl+Shift+\ apart from Ctrl+\. */
  function actionFor(value) {
    var cmb = (typeof value === 'string') ? canonical(value) : combo(value);
    if (!cmb) return null;
    var map = bindings();
    if (map[cmb]) return map[cmb];
    var parsed = parse(cmb);
    if (parsed && parsed.shift && !NAMED_LOWER[parsed.key.toLowerCase()] &&
        !isFKey(parsed.key) && !/^[A-Z0-9]$/.test(parsed.key)) {
      var bare = (parsed.ctrl ? 'Ctrl+' : '') + (parsed.alt ? 'Alt+' : '') + parsed.key;
      if (map[bare]) return map[bare];
    }
    return null;
  }

  /* --- writing the bindings ----------------------------------- */

  function notify() {
    var snapshot = bindings();
    var copy = listeners.slice();
    for (var i = 0; i < copy.length; i++) {
      try { copy[i](snapshot); } catch (err) { /* a bad listener is not our problem */ }
    }
  }

  /** Subscribe to rebinds. Returns the unsubscribe. */
  function on(cb) {
    if (typeof cb !== 'function') return function () {};
    listeners.push(cb);
    return function off() {
      var i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /* Bind an action, or pass null to unbind it. A combo already held by
     another rebindable action takes it away from that action (which is left
     unbound and named in `displaced`); a combo held by a fixed one is
     refused outright. */
  function set(id, value) {
    var action = byId(id);
    if (!action) return { ok: false, reason: 'unknown' };
    if (action.fixed) return { ok: false, reason: 'fixed' };

    var map = load();

    if (value === null || value === undefined || value === '') {
      if (get(id) === null) return { ok: true };
      map[id] = null;
      save();
      notify();
      return { ok: true };
    }

    var cmb = canonical(value);
    if (!cmb) return { ok: false, reason: 'invalid' };
    if (RESERVED[cmb]) return { ok: false, reason: 'reserved', holder: RESERVED[cmb] };
    if (get(id) === cmb) return { ok: true };

    var holder = bindings()[cmb];
    var displaced = null;
    if (holder && holder !== id) {
      map[holder] = null;
      displaced = holder;
    }
    map[id] = cmb;
    save();
    notify();
    return displaced ? { ok: true, displaced: displaced } : { ok: true };
  }

  /** Put one action back to its factory combo. */
  function reset(id) {
    var action = byId(id);
    if (!action) return { ok: false, reason: 'unknown' };
    if (action.fixed) return { ok: false, reason: 'fixed' };
    var map = load();
    if (!Object.prototype.hasOwnProperty.call(map, id)) return { ok: true };
    delete map[id];
    save();
    notify();
    return { ok: true };
  }

  /** Put everything back. */
  function resetAll() {
    overrides = {};
    save();
    notify();
    return { ok: true };
  }

  /* --- export ------------------------------------------------- */

  var Shortcuts = {
    VERSION: STORAGE_VERSION,
    STORAGE_KEY: STORAGE_KEY,
    GROUPS: GROUPS,
    ACTIONS: ACTIONS,
    combo: combo,
    fromMainInput: fromMainInput,
    parse: parse,
    canonical: canonical,
    label: label,
    text: text,
    all: all,
    get: get,
    set: set,
    reset: reset,
    resetAll: resetAll,
    actionFor: actionFor,
    bindings: bindings,
    conflict: conflict,
    on: on
  };

  if (typeof window !== 'undefined') window.Shortcuts = Shortcuts;
  // main.js has no window; it can require() this same file.
  if (typeof module !== 'undefined' && module.exports) module.exports = Shortcuts;
})();
