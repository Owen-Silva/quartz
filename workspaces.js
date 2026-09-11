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
 *   workspaceList()      -> [{ id, name, colour, tabCount, current }]
 *                           colour in null|'ion'|'ember'|'forest'|'ocean'|'midnight'
 *   currentWorkspace()   -> the current workspace (object or id; both accepted)
 *   switchWorkspace(id)
 *   createWorkspace(name, colour) -> id
 *   renameWorkspace(id, name)
 *   setWorkspaceColour(id, colour)
 *   deleteWorkspace(id)           // 'main' can never be deleted
 *   moveTabToWorkspace(tabId, wsId)
 *   moveActiveTabToWorkspace(wsId)
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
  function fnDelete() { return (typeof deleteWorkspace === 'function') ? deleteWorkspace : null; }
  function fnMoveTab() { return (typeof moveTabToWorkspace === 'function') ? moveTabToWorkspace : null; }
  function fnMoveActive() { return (typeof moveActiveTabToWorkspace === 'function') ? moveActiveTabToWorkspace : null; }

  /** The one global the feature cannot do without. */
  function present() { return !!fnList(); }

  function isColour(c) {
    for (var i = 0; i < COLOURS.length; i++) if (COLOURS[i] === c) return true;
    return false;
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
        tabCount: Number(w.tabCount) || 0,
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
      count.title = w.tabCount === 1 ? '1 tab' : (w.tabCount + ' tabs');
      main.appendChild(count);
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
        confirmId = null;
        render();
      });
      acts.appendChild(colourBtn);

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
