'use strict';

/*
 * workspaces.js — the workspace instrument: a compact glass pill in the
 * titlebar carrying the current workspace's colour and name, and a popover
 * that switches, renames, recolours, deletes and creates workspaces (and,
 * in "move" mode, sends one tab to another workspace).
 *
 * The renderer runs with contextIsolation ON and nodeIntegration OFF, so this
 * is plain browser script: no require(), no import, no bundler. Loaded after
 * app.js, which owns the model and inserts the empty <div id="workspace-slot">
 * into #titlebar for this file to fill.
 *
 * Contract with app.js — every one of these is OPTIONAL at runtime. When
 * workspaceList is missing the whole feature renders nothing at all:
 *
 *   workspaceList()      -> [{ id, name, colour, folder, pane, preset,
 *                              tabCount, asleepCount, current }]
 *                           asleepCount: how many of those tabs have given
 *                                   their renderer back (0 on a build that
 *                                   predates workspace sleep)
 *                           colour in null|'ion'|'ember'|'forest'|'ocean'|'midnight'
 *                           folder: the Claude folder for the workspace, or null
 *                           pane:   null | 'school' (the side pane it wants)
 *                           preset: null | 'school' | 'project' | 'club' | 'trading' | 'phone'
 *                                   (a key this panel only ever passes through)
 *   currentWorkspace()   -> the current workspace (object or id; both accepted)
 *   switchWorkspace(id)
 *   createWorkspace(name, colour) -> id
 *   renameWorkspace(id, name)
 *   setWorkspaceColour(id, colour)
 *   setWorkspaceFolder(id, folder)  // null clears it
 *   setWorkspacePane(id, kind)      // null | 'school'
 *   deleteWorkspace(id)           // 'main' can never be deleted
 *   moveTabToWorkspace(tabId, wsId)
 *   moveActiveTabToWorkspace(wsId)
 *
 * The folder picker is window.api.app.pickFolder(defaultPath) and the check
 * that a folder still exists is window.api.app.dirExists(path). Both are
 * optional too: without the picker the row says so instead of offering a
 * button that does nothing.
 *
 * app.js fires `workspacechange` (detail: { id }) on the document for any
 * change to the model; `tabchange` covers the tab counts.
 *
 * Owned ids/classes (nothing else in the app may touch them):
 *   #workspace-pill (inside app.js's #workspace-slot), #workspaces-panel (a
 *   direct child of <body> so it stacks over #views) and every .ws-* class.
 *
 * MOTION. The chrome sits on a backdrop-filter, so every animated frame
 * re-blurs the pane behind it. Nothing here animates continuously: every
 * transition is stepped and none runs longer than 150ms.
 */

(function () {
  /* --- Segoe Fluent Icons -------------------------------------- */
  // All four are Segoe MDL2 Assets code points carried forward by Segoe
  // Fluent Icons, so they render on both fonts named in --icon-font.
  var GLYPH_ADD = '\uE710';      // Add
  var GLYPH_RENAME = '\uE70F';   // Edit
  var GLYPH_DELETE = '\uE74D';   // Delete
  var GLYPH_CHECK = '\uE73E';    // CheckMark
  var GLYPH_CHEVRON = '\uE70D';  // ChevronDown
  var GLYPH_FOLDER = '\uE8B7';   // Folder: the folder-and-pane expander
  var GLYPH_CLEAR = '\uE711';    // Cancel: clears a folder back to none

  /* There is no glyph in either icon font that reads as "workspace", so the
     pill carries a coloured dot instead — the same dot the rows use, which
     makes the pill a legend for the list rather than a second vocabulary. */
  var COLOURS = [null, 'ion', 'ember', 'forest', 'ocean', 'midnight'];
  var COLOUR_LABEL = {
    'ion': 'Ion',
    'ember': 'Ember',
    'forest': 'Forest',
    'ocean': 'Ocean',
    'midnight': 'Midnight'
  };

  /* The side panes a workspace can ask for, in the order the toggle offers
     them. null is "no pane", which is what every workspace starts on. */
  var PANES = [null, 'school'];
  var PANE_LABEL = {
    'school': 'School notes'
  };

  /* ============================================================
     The model, reached defensively
     Each global is looked up through `typeof` so an app.js that never
     defined it — or defined it with const rather than function — is a
     missing feature rather than a ReferenceError.
     ============================================================ */

  function fnList() { return (typeof workspaceList === 'function') ? workspaceList : null; }
  function fnCurrent() { return (typeof currentWorkspace === 'function') ? currentWorkspace : null; }
  function fnSwitch() { return (typeof switchWorkspace === 'function') ? switchWorkspace : null; }
  function fnCreate() { return (typeof createWorkspace === 'function') ? createWorkspace : null; }
  function fnRename() { return (typeof renameWorkspace === 'function') ? renameWorkspace : null; }
  function fnColour() { return (typeof setWorkspaceColour === 'function') ? setWorkspaceColour : null; }
  function fnFolder() { return (typeof setWorkspaceFolder === 'function') ? setWorkspaceFolder : null; }
  function fnPane() { return (typeof setWorkspacePane === 'function') ? setWorkspacePane : null; }
  function fnDelete() { return (typeof deleteWorkspace === 'function') ? deleteWorkspace : null; }

  /** window.api.app, or null in a build whose preload predates it. */
  function appApi() {
    var api = window.api;
    return (api && api.app) ? api.app : null;
  }
  function fnMoveTab() { return (typeof moveTabToWorkspace === 'function') ? moveTabToWorkspace : null; }
  function fnMoveActive() { return (typeof moveActiveTabToWorkspace === 'function') ? moveActiveTabToWorkspace : null; }

  /** The one global the feature cannot do without. */
  function present() { return !!fnList(); }

  function isColour(c) {
    for (var i = 0; i < COLOURS.length; i++) if (COLOURS[i] === c) return true;
    return false;
  }

  function isPane(kind) {
    for (var i = 0; i < PANES.length; i++) if (PANES[i] === kind) return true;
    return false;
  }

  /** The last segment of a path — what the folder button shows when it fits. */
  function baseName(path) {
    var text = String(path == null ? '' : path).replace(/[\\/]+$/, '');
    if (!text) return '';
    var at = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
    return at === -1 ? text : text.slice(at + 1);
  }

  /** workspaceList(), normalised, and never throwing into a render. */
  function readList() {
    var f = fnList();
    if (!f) return [];
    var raw;
    try { raw = f(); } catch (err) { return []; }
    if (!raw || typeof raw.length !== 'number') return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var w = raw[i];
      if (!w || typeof w !== 'object') continue;
      if (w.id === null || typeof w.id === 'undefined') continue;
      out.push({
        id: String(w.id),
        name: (typeof w.name === 'string' && w.name) ? w.name : 'Workspace',
        colour: isColour(w.colour) ? (w.colour || null) : null,
        // Anything this build does not recognise as a pane reads as no pane,
        // the same tolerance the colour gets.
        folder: (typeof w.folder === 'string' && w.folder) ? w.folder : null,
        pane: isPane(w.pane) ? w.pane : null,
        preset: (typeof w.preset === 'string' && w.preset) ? w.preset : null,
        tabCount: Number(w.tabCount) || 0,
        // Never more than the tab count, whatever app.js hands over: the row
        // reads "3 of 3 asleep" and that has to stay true on its face.
        asleepCount: Math.max(0, Math.min(Number(w.asleepCount) || 0, Number(w.tabCount) || 0)),
        current: !!w.current
      });
    }
    return out;
  }

  /**
   * The current workspace as a normalised row. currentWorkspace() may hand
   * back the object or just its id; either is accepted, and the `current`
   * flag on the list is the fallback when it hands back nothing useful.
   */
  function currentRow() {
    var rows = readList();
    var id = null;
    var f = fnCurrent();
    if (f) {
      var cur = null;
      try { cur = f(); } catch (err) { cur = null; }
      if (typeof cur === 'string' || typeof cur === 'number') id = String(cur);
      else if (cur && typeof cur === 'object' && typeof cur.id !== 'undefined') id = String(cur.id);
    }
    var i;
    if (id !== null) {
      for (i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
    }
    for (i = 0; i < rows.length; i++) if (rows[i].current) return rows[i];
    return rows.length ? rows[0] : null;
  }

  /** Every model write goes through here: a throwing app.js never breaks the UI. */
  function call(f, a, b) {
    if (typeof f !== 'function') return undefined;
    try { return f(a, b); } catch (err) { return undefined; }
  }

  /* ============================================================
     State
     ============================================================ */

  var pillEl = null;
  var pillDot = null;
  var pillName = null;

  var panelEl = null;
  var headEl = null;
  var listEl = null;
  var newWrap = null;
  var hintEl = null;

  var open_ = false;
  var mode = 'switch';        // 'switch' | 'move'
  var moveTabId = null;       // the tab openMove() was given; null = the active one

  // Transient row state. All of it is cleared when the popover closes.
  var editId = null;          // the row being renamed
  var editValue = '';         // its live input value, kept across re-renders
  var colourId = null;        // the row showing its colour strip
  var setupId = null;         // the row showing its folder + pane block
  var confirmId = null;       // the row showing "Delete?"

  var newOpen = false;        // the "New workspace" form is expanded
  var newName = '';
  var newColour = null;

  /** True while renderPanel() is tearing the list down: blur must not commit. */
  var rendering = false;
  /** Everything arrow keys walk, in visual order, rebuilt on every render. */
  var focusables = [];

  /* ============================================================
     Small DOM helpers
     ============================================================ */

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function glyph(ch, cls) {
    var g = el('span', cls ? ('glyph ' + cls) : 'glyph');
    g.textContent = ch;
    return g;
  }

  /** A 10px dot in a workspace's colour; --fg-3 when the colour is null. */
  function dot(colour, cls) {
    var d = el('span', cls ? ('ws-dot ' + cls) : 'ws-dot');
    setDot(d, colour);
    return d;
  }

  function setDot(node, colour) {
    if (!node) return;
    if (colour && isColour(colour)) node.setAttribute('data-colour', colour);
    else node.removeAttribute('data-colour');
  }

  function iconButton(ch, label, cls, onClick) {
    var b = el('button', 'ws-act ' + cls);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(glyph(ch));
    b.addEventListener('click', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      onClick();
    });
    return b;
  }

  /** The six colour dots, as buttons. `chosen` gets the lit ring. */
  function colourStrip(chosen, onPick) {
    var strip = el('div', 'ws-colours');
    for (var i = 0; i < COLOURS.length; i++) {
      strip.appendChild(colourSwatch(COLOURS[i], chosen, onPick));
    }
    return strip;
  }

  /* --- the folder + pane block, under one row -------------------- *
   * Both settings belong to the workspace rather than to a tab, and both are
   * rare enough that they live behind the folder button instead of taking a
   * line in every row: what a workspace's folder IS matters on the day it is
   * set and never again.
   */
  function setupBlock(w) {
    var wrap = el('div', 'ws-setup');

    /* --- Folder ------------------------------------------------- */
    var fRow = el('div', 'ws-setup-row');
    fRow.appendChild(el('span', 'ws-setup-label'));
    fRow.firstChild.textContent = 'Folder';

    var pick = el('button', 'ws-folder');
    pick.type = 'button';
    var api = appApi();
    var canPick = !!(api && typeof api.pickFolder === 'function');
    if (w.folder) {
      pick.textContent = baseName(w.folder) || w.folder;
      pick.title = w.folder + (canPick ? ' — click to choose another' : '');
      pick.setAttribute('data-path', w.folder);
    } else {
      pick.classList.add('is-unset');
      pick.textContent = canPick ? 'Choose…' : 'Not set';
      pick.title = canPick
        ? 'Choose the folder a Claude tab opens in here'
        : 'This build cannot open a folder picker';
    }
    pick.disabled = !canPick || !fnFolder();
    pick.addEventListener('click', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      chooseFolder(w);
    });
    fRow.appendChild(pick);

    if (w.folder && fnFolder()) {
      fRow.appendChild(iconButton(GLYPH_CLEAR, 'Clear the folder', 'ws-folder-clear', function () {
        call(fnFolder(), w.id, null);
        render();
      }));
    }
    wrap.appendChild(fRow);

    // Nothing here fails quietly: a missing folder says so on the button
    // itself, and a build with no picker says that instead of offering one.
    var note = el('div', 'ws-setup-note');
    note.hidden = true;
    wrap.appendChild(note);
    if (!canPick) {
      note.textContent = 'No folder picker in this build: window.api.app.pickFolder is missing.';
      note.hidden = false;
    } else if (w.folder) {
      checkFolder(w.folder, pick, note);
    }

    /* --- Pane --------------------------------------------------- */
    var pRow = el('div', 'ws-setup-row');
    pRow.appendChild(el('span', 'ws-setup-label'));
    pRow.firstChild.textContent = 'Pane';

    var group = el('div', 'ws-panes');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Side pane');
    for (var i = 0; i < PANES.length; i++) {
      group.appendChild(paneOption(w, PANES[i]));
    }
    pRow.appendChild(group);
    wrap.appendChild(pRow);

    return wrap;
  }

  function paneOption(w, kind) {
    var b = el('button', 'ws-pane-opt');
    b.type = 'button';
    b.textContent = kind ? (PANE_LABEL[kind] || kind) : 'None';
    b.title = kind
      ? 'Open the ' + (PANE_LABEL[kind] || kind) + ' pane beside the tabs here'
      : 'No side pane in this workspace';
    if ((w.pane || null) === kind) {
      b.classList.add('is-on');
      b.setAttribute('aria-pressed', 'true');
    } else {
      b.setAttribute('aria-pressed', 'false');
    }
    b.disabled = !fnPane();
    b.addEventListener('click', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      call(fnPane(), w.id, kind);
      render();
    });
    return b;
  }

  /**
   * The native folder dialog, then the model. The popover stays open behind
   * the dialog (it is modal to the window, so no click-outside fires), and a
   * cancelled pick leaves the folder exactly as it was.
   */
  function chooseFolder(w) {
    var api = appApi();
    var set = fnFolder();
    if (!api || typeof api.pickFolder !== 'function' || !set) return;
    var pending = null;
    try { pending = api.pickFolder(w.folder || ''); } catch (err) { pending = null; }
    if (!pending || typeof pending.then !== 'function') return;
    pending.then(function (picked) {
      if (typeof picked !== 'string' || !picked) return; // cancelled
      call(set, w.id, picked);
      render();
    }, function () { /* the dialog failed: the folder is unchanged */ });
  }

  /**
   * Ask main whether a folder is still there and mark the button when it is
   * not. Asynchronous, so the answer is dropped unless the button is still on
   * screen showing the same path: a render may have replaced it by then.
   */
  function checkFolder(path, button, note) {
    var api = appApi();
    if (!api || typeof api.dirExists !== 'function' || !button) return;
    var pending = null;
    try { pending = api.dirExists(path); } catch (err) { pending = null; }
    if (!pending || typeof pending.then !== 'function') return;
    pending.then(function (exists) {
      if (exists !== false) return;
      if (!button.isConnected || button.getAttribute('data-path') !== path) return;
      button.classList.add('is-missing');
      if (note) {
        note.textContent = 'That folder is not there any more: ' + path;
        note.hidden = false;
      }
    }, function () { /* main could not answer: the button says nothing new */ });
  }

  function colourSwatch(colour, chosen, onPick) {
    var label = colour ? COLOUR_LABEL[colour] : 'No colour';
    var b = el('button', 'ws-swatch');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    if (colour === chosen) b.classList.add('is-on');
    b.appendChild(dot(colour));
    b.addEventListener('click', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      onPick(colour);
    });
    return b;
  }

  /* ============================================================
     The titlebar pill
     ============================================================ */

  function injectPill() {
    if (!present()) return;
    var existing = document.getElementById('workspace-pill');
    if (existing) {
      pillEl = existing;
      return;
    }
    var slot = document.getElementById('workspace-slot');
    if (!slot) return;

    pillEl = el('button', 'glass no-drag');
    pillEl.id = 'workspace-pill';
    pillEl.type = 'button';
    pillEl.title = 'Workspaces';
    pillEl.setAttribute('aria-label', 'Workspaces');
    pillEl.setAttribute('aria-haspopup', 'dialog');
    pillEl.setAttribute('aria-expanded', 'false');

    pillDot = dot(null, 'ws-pill-dot');
    pillName = el('span', 'ws-pill-name');
    pillName.textContent = 'Home';

    pillEl.appendChild(pillDot);
    pillEl.appendChild(pillName);
    pillEl.appendChild(glyph(GLYPH_CHEVRON, 'ws-chev'));
    pillEl.addEventListener('click', function () { toggle(); });

    slot.appendChild(pillEl);
  }

  function renderPill() {
    if (!pillEl) return;
    var cur = currentRow();
    setDot(pillDot, cur ? cur.colour : null);
    if (pillName) pillName.textContent = cur ? cur.name : 'Home';
    var label = cur ? ('Workspace: ' + cur.name) : 'Workspaces';
    pillEl.title = label;
    pillEl.setAttribute('aria-label', label);
  }

  /* ============================================================
     The popover
     It lives on <body>, not inside .chrome-layer: the chrome layer carries
     a blur filter before boot, and a fixed element there would be clipped
     to it rather than floating over the tab well.
     ============================================================ */

  function buildPanel() {
    if (!present()) return;
    var existing = document.getElementById('workspaces-panel');
    if (existing) { panelEl = existing; return; }
    if (!document.body) return;

    panelEl = el('div', 'glass');
    panelEl.id = 'workspaces-panel';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', 'Workspaces');
    panelEl.tabIndex = -1;
    panelEl.hidden = true;

    headEl = el('div', 'ws-head');
    headEl.textContent = 'Move tab to…';
    headEl.hidden = true;

    listEl = el('div', 'ws-list');
    listEl.setAttribute('role', 'listbox');

    newWrap = el('div', 'ws-new');

    hintEl = el('div', 'ws-hint');
    // The hint follows the user's own binding when the shortcuts store exists.
    var hint = 'Ctrl+Alt+← / → switches';
    try {
      var sc = window.Shortcuts;
      var next = sc && typeof sc.get === 'function' ? sc.get('workspace-next') : null;
      var prev = sc && typeof sc.get === 'function' ? sc.get('workspace-prev') : null;
      if (next || prev) {
        var fmt = function (c) { return typeof sc.text === 'function' ? sc.text(c) : c; };
        hint = (prev ? fmt(prev) : 'unbound') + ' / ' + (next ? fmt(next) : 'unbound') + ' switches';
      }
    } catch (err) { /* static hint */ }
    hintEl.textContent = hint;

    panelEl.appendChild(headEl);
    panelEl.appendChild(listEl);
    panelEl.appendChild(newWrap);
    panelEl.appendChild(hintEl);
    panelEl.addEventListener('keydown', onPanelKey);

    document.body.appendChild(panelEl);
  }

  /* --- one workspace row ---------------------------------------- */

  function buildRow(w) {
    var row = el('div', 'ws-row');
    row.setAttribute('role', 'option');
    row.setAttribute('data-id', w.id);
    row.setAttribute('aria-selected', w.current ? 'true' : 'false');
    row.tabIndex = -1;
    if (w.current) row.classList.add('is-current');

    var main = el('div', 'ws-row-main');
    main.appendChild(dot(w.colour, 'ws-row-dot'));

    if (editId === w.id) {
      // Rename, in place. Enter and blur commit, Escape puts the old name back.
      var input = el('input', 'ws-rename');
      input.type = 'text';
      input.value = editValue;
      input.setAttribute('aria-label', 'Rename workspace');
      input.addEventListener('input', function () { editValue = input.value || ''; });
      input.addEventListener('keydown', function (event) {
        if (!event) return;
        if (event.key === 'Enter') {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          commitRename(w.id);
        } else if (event.key === 'Escape') {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
          editId = null;
          editValue = '';
          render();
        }
      });
      input.addEventListener('blur', function () {
        if (rendering || editId !== w.id) return;
        commitRename(w.id);
      });
      main.appendChild(input);
    } else {
      var name = el('span', 'ws-row-name');
      name.textContent = w.name;
      main.appendChild(name);

      var count = el('span', 'ws-count');
      count.textContent = String(w.tabCount);
      var countTitle = w.tabCount === 1 ? '1 tab' : (w.tabCount + ' tabs');
      // Sleeping tabs are said on the row, not only in the count's hover: a
      // workspace you are not looking at is meant to cost nothing, and that
      // is only reassuring if you can see it. The count itself stays the
      // number of TABS — they are all still there.
      if (w.asleepCount) {
        countTitle += ' — ' + (w.asleepCount === w.tabCount
          ? (w.tabCount === 1 ? 'asleep' : 'all asleep')
          : (w.asleepCount + ' asleep'));
      }
      count.title = countTitle;
      main.appendChild(count);

      if (w.asleepCount) {
        var doze = el('span', 'ws-asleep');
        doze.textContent = w.asleepCount === w.tabCount
          ? 'asleep' : (w.asleepCount + ' asleep');
        doze.title = 'These tabs gave their memory back. '
          + 'Switching here wakes the one you were last on.';
        main.appendChild(doze);
      }
    }

    if (w.current) main.appendChild(glyph(GLYPH_CHECK, 'ws-check'));
    row.appendChild(main);

    // Switching is the row's own job; the per-row buttons stop propagation.
    row.addEventListener('click', function () { activateRow(w); });

    if (mode !== 'move' && editId !== w.id) {
      var acts = el('div', 'ws-row-acts');

      var colourBtn = el('button', 'ws-act ws-act-colour');
      colourBtn.type = 'button';
      colourBtn.title = 'Colour';
      colourBtn.setAttribute('aria-label', 'Colour');
      colourBtn.appendChild(dot(w.colour));
      colourBtn.addEventListener('click', function (event) {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        colourId = (colourId === w.id) ? null : w.id;
        setupId = null;
        confirmId = null;
        render();
      });
      acts.appendChild(colourBtn);

      // The folder and the pane, behind one button: what a workspace IS
      // beyond its name and colour, opened on the day it is set up.
      var setupBtn = iconButton(GLYPH_FOLDER, 'Folder and pane', 'ws-act-setup', function () {
        setupId = (setupId === w.id) ? null : w.id;
        colourId = null;
        confirmId = null;
        render();
      });
      if (setupId === w.id) setupBtn.classList.add('is-on');
      // A workspace with a folder or a pane says so without opening the block.
      if (w.folder || w.pane) setupBtn.classList.add('is-set');
      acts.appendChild(setupBtn);

      acts.appendChild(iconButton(GLYPH_RENAME, 'Rename', 'ws-act-rename', function () {
        editId = w.id;
        editValue = w.name;
        colourId = null;
        confirmId = null;
        render();
      }));

      // 'main' is the one workspace the model refuses to delete, so it never
      // offers the button rather than offering one that fails.
      if (w.id !== 'main') {
        if (confirmId === w.id) {
          var confirm = el('button', 'ws-act ws-confirm');
          confirm.type = 'button';
          confirm.textContent = 'Delete?';
          confirm.title = 'Delete this workspace';
          confirm.addEventListener('click', function (event) {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
            confirmId = null;
            call(fnDelete(), w.id);
            render();
          });
          acts.appendChild(confirm);
        } else {
          acts.appendChild(iconButton(GLYPH_DELETE, 'Delete', 'ws-act-delete', function () {
            confirmId = w.id;
            colourId = null;
            render();
          }));
        }
      }

      row.appendChild(acts);
    }

    if (colourId === w.id && mode !== 'move') {
      row.appendChild(colourStrip(w.colour, function (colour) {
        call(fnColour(), w.id, colour);
        render();
      }));
    }

    if (setupId === w.id && mode !== 'move' && editId !== w.id) {
      row.appendChild(setupBlock(w));
    }

    return row;
  }

  /** A row was chosen: switch to it, or move the tab into it. */
  function activateRow(w) {
    if (mode === 'move') {
      if (moveTabId === null || typeof moveTabId === 'undefined') call(fnMoveActive(), w.id);
      else call(fnMoveTab(), moveTabId, w.id);
    } else {
      call(fnSwitch(), w.id);
    }
    close();
  }

  /* --- the "New workspace" footer -------------------------------- */

  function renderNew() {
    if (!newWrap) return;
    newWrap.textContent = '';

    if (!newOpen) {
      var open = el('button', 'ws-newbtn');
      open.type = 'button';
      open.appendChild(glyph(GLYPH_ADD));
      var label = el('span', 'ws-newbtn-label');
      label.textContent = 'New workspace';
      open.appendChild(label);
      open.addEventListener('click', function () {
        newOpen = true;
        editId = null;
        colourId = null;
        confirmId = null;
        render();
      });
      newWrap.appendChild(open);
      focusables.push(open);
      return;
    }

    var form = el('div', 'ws-newform');

    var field = el('div', 'ws-newfield');
    field.appendChild(dot(newColour, 'ws-new-dot'));

    var input = el('input', 'ws-newinput');
    input.type = 'text';
    input.value = newName;
    input.placeholder = 'Name';
    input.setAttribute('aria-label', 'New workspace name');
    input.addEventListener('input', function () { newName = input.value || ''; });
    input.addEventListener('keydown', function (event) {
      if (!event) return;
      if (event.key === 'Enter') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        commitCreate();
      } else if (event.key === 'Escape') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        newOpen = false;
        newName = '';
        newColour = null;
        render();
      }
    });
    field.appendChild(input);

    var create = el('button', 'ws-create');
    create.type = 'button';
    create.title = 'Create workspace';
    create.appendChild(glyph(GLYPH_CHECK));
    var createLabel = el('span', 'ws-create-label');
    createLabel.textContent = 'Create';
    create.appendChild(createLabel);
    create.addEventListener('click', function () { commitCreate(); });
    field.appendChild(create);

    form.appendChild(field);
    form.appendChild(colourStrip(newColour, function (colour) {
      newColour = colour;
      render();
    }));
    newWrap.appendChild(form);
    focusables.push(create);
  }

  function commitRename(id) {
    var next = String(editValue || '').trim();
    editId = null;
    editValue = '';
    if (next) call(fnRename(), id, next);
    render();
  }

  function commitCreate() {
    var name = String(newName || '').trim();
    if (!name) return;
    var colour = newColour;
    var id = call(fnCreate(), name, colour);
    newOpen = false;
    newName = '';
    newColour = null;
    if (mode === 'move' && id !== null && typeof id !== 'undefined') {
      if (moveTabId === null || typeof moveTabId === 'undefined') call(fnMoveActive(), id);
      else call(fnMoveTab(), moveTabId, id);
      close();
      return;
    }
    render();
  }

  /* ============================================================
     Render
     ============================================================ */

  function render() {
    renderPill();
    if (open_) renderPanel();
  }

  function renderPanel() {
    if (!panelEl || !listEl) return;
    rendering = true;

    if (headEl) headEl.hidden = (mode !== 'move');
    if (hintEl) hintEl.hidden = (mode === 'move');
    panelEl.setAttribute('aria-label', mode === 'move' ? 'Move tab to workspace' : 'Workspaces');

    focusables = [];
    listEl.textContent = '';
    var rows = readList();
    for (var i = 0; i < rows.length; i++) {
      var node = buildRow(rows[i]);
      listEl.appendChild(node);
      focusables.push(node);
    }
    renderNew();

    rendering = false;

    // The rename and create inputs are rebuilt on every pass, so focus has to
    // be put back by hand — otherwise a keystroke would land nowhere.
    var live = null;
    if (editId !== null) live = findIn(listEl, 'ws-rename');
    else if (newOpen) live = findIn(newWrap, 'ws-newinput');
    if (live && typeof live.focus === 'function') {
      live.focus();
      if (typeof live.setSelectionRange === 'function' && typeof live.value === 'string') {
        try { live.setSelectionRange(live.value.length, live.value.length); } catch (err) { /* not a text input */ }
      }
    }
  }

  /** The first descendant carrying a class. Kept local: no querySelector cost. */
  function findIn(root, cls) {
    if (!root || !root.childNodes) return null;
    for (var i = 0; i < root.childNodes.length; i++) {
      var child = root.childNodes[i];
      if (!child || child.nodeType !== 1) continue;
      if (child.classList && child.classList.contains(cls)) return child;
      var deep = findIn(child, cls);
      if (deep) return deep;
    }
    return null;
  }

  /* ============================================================
     Open / close
     ============================================================ */

  function position() {
    if (!panelEl || !pillEl || typeof pillEl.getBoundingClientRect !== 'function') return;
    var r = pillEl.getBoundingClientRect();
    if (!r || !r.width) return;
    var width = 300;
    var left = Math.round(r.left);
    var room = (window.innerWidth || 0) - width - 8;
    if (room > 8 && left > room) left = room;
    if (left < 8) left = 8;
    panelEl.style.top = Math.round(r.bottom + 8) + 'px';
    panelEl.style.left = left + 'px';
  }

  function resetTransient() {
    editId = null;
    editValue = '';
    colourId = null;
    setupId = null;
    confirmId = null;
    newOpen = false;
    newName = '';
    newColour = null;
  }

  function open() {
    if (!present() || !panelEl) return;
    resetTransient();
    open_ = true;
    panelEl.hidden = false;
    render();
    position();
    if (pillEl) {
      pillEl.classList.add('is-open');
      pillEl.setAttribute('aria-expanded', 'true');
    }
    focusCurrent();
  }

  /** Open on the current workspace's row, so Enter alone is a no-op. */
  function focusCurrent() {
    for (var i = 0; i < focusables.length; i++) {
      var node = focusables[i];
      if (node && node.classList && node.classList.contains('is-current') && typeof node.focus === 'function') {
        node.focus();
        return;
      }
    }
    if (focusables.length && typeof focusables[0].focus === 'function') focusables[0].focus();
  }

  function close() {
    if (panelEl) panelEl.hidden = true;
    open_ = false;
    mode = 'switch';
    moveTabId = null;
    resetTransient();
    if (pillEl) {
      pillEl.classList.remove('is-open');
      pillEl.setAttribute('aria-expanded', 'false');
    }
    renderPill();
  }

  function toggle() {
    if (open_) close();
    else open();
  }

  function isOpen() { return open_; }

  /** The same popover, in move mode. tabId absent = whatever tab is active. */
  function openMove(tabId) {
    if (!present() || !panelEl) return;
    if (open_) close();
    mode = 'move';
    moveTabId = (typeof tabId === 'undefined') ? null : tabId;
    resetTransient();
    open_ = true;
    panelEl.hidden = false;
    render();
    position();
    if (pillEl) {
      pillEl.classList.add('is-open');
      pillEl.setAttribute('aria-expanded', 'true');
    }
    focusCurrent();
  }

  /**
   * Forwarded from main.js (keys pressed inside a <webview> never reach this
   * document). Returns true when the action was consumed.
   */
  function handleShortcut(action) {
    if (action === 'workspaces') {
      if (!present() || !panelEl) return false;
      toggle();
      return true;
    }
    if (action === 'escape') {
      if (!open_) return false;
      close();
      return true;
    }
    return false;
  }

  /* ============================================================
     Keyboard
     ============================================================ */

  function indexOfFocus() {
    var active = document.activeElement || null;
    for (var i = 0; i < focusables.length; i++) {
      var node = focusables[i];
      if (!node) continue;
      if (node === active) return i;
      if (node.contains && active && node.contains(active)) return i;
    }
    return -1;
  }

  function moveFocus(step) {
    if (!focusables.length) return;
    var i = indexOfFocus();
    var next = (i < 0) ? (step > 0 ? 0 : focusables.length - 1) : (i + step);
    if (next < 0) next = focusables.length - 1;
    if (next >= focusables.length) next = 0;
    var node = focusables[next];
    if (node && typeof node.focus === 'function') node.focus();
  }

  function onPanelKey(event) {
    if (!event || !open_) return;
    var key = event.key;
    var target = event.target || null;
    var inInput = !!(target && target.classList &&
      (target.classList.contains('ws-rename') || target.classList.contains('ws-newinput')));

    if (key === 'Escape') {
      // Innermost thing first: the inputs cancel themselves and stop the event.
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (confirmId !== null) { confirmId = null; render(); return; }
      if (colourId !== null) { colourId = null; render(); return; }
      close();
      return;
    }
    if (inInput) return;

    if (key === 'ArrowDown') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      moveFocus(1);
      return;
    }
    if (key === 'ArrowUp') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      moveFocus(-1);
      return;
    }
    if (key === 'Home') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (focusables.length && typeof focusables[0].focus === 'function') focusables[0].focus();
      return;
    }
    if (key === 'End') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      var last = focusables[focusables.length - 1];
      if (last && typeof last.focus === 'function') last.focus();
      return;
    }
    if (key === 'Enter' || key === ' ') {
      var i = indexOfFocus();
      if (i < 0) return;
      var node = focusables[i];
      if (!node) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      var id = node.getAttribute ? node.getAttribute('data-id') : null;
      if (id === null) {
        if (typeof node.click === 'function') node.click();
        return;
      }
      var rows = readList();
      for (var r = 0; r < rows.length; r++) {
        if (rows[r].id === id) { activateRow(rows[r]); return; }
      }
    }
  }

  /* ============================================================
     Wiring
     ============================================================ */

  function wire() {
    document.addEventListener('workspacechange', function () { render(); });
    document.addEventListener('tabchange', function () { render(); });

    // Escape only reaches this document when focus is inside the chrome; the
    // forwarded 'escape' action covers the case where a page has focus.
    document.addEventListener('keydown', function (event) {
      if (!open_ || !event) return;
      if (event.key !== 'Escape') return;
      if (panelEl && panelEl.contains && event.target && panelEl.contains(event.target)) return;
      close();
    });

    // Click-outside. mousedown, so it settles before the pill's own click.
    document.addEventListener('mousedown', function (event) {
      if (!open_ || !event) return;
      var t = event.target;
      if (panelEl && panelEl.contains && panelEl.contains(t)) return;
      if (pillEl && pillEl.contains && pillEl.contains(t)) return;
      close();
    }, true);

    window.addEventListener('resize', function () {
      if (open_) position();
    });
  }

  function boot() {
    if (!present()) return;   // no model, no instrument: nothing is rendered
    injectPill();
    if (!pillEl) return;      // app.js never inserted the slot
    buildPanel();
    wire();
    renderPill();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.Workspaces = {
    open: open,
    close: close,
    toggle: toggle,
    isOpen: isOpen,
    openMove: openMove,
    handleShortcut: handleShortcut,
    // Rebuilds the pill (and the list when it is open) from the model.
    refresh: render,
    // Reachable so boot order in a test — or an app.js that inserts the slot
    // late — does not require reloading the file.
    _boot: boot,
    _helpers: {
      readList: readList,
      currentRow: currentRow,
      isColour: isColour,
      COLOURS: COLOURS
    }
  };
})();
