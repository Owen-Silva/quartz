'use strict';

/*
 * tabsearch.js — the tab palette: Ctrl+Shift+A, or the list glyph in the
 * titlebar. One glass pane over the page listing every open tab and the
 * handful you just closed, filtered as you type.
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
    list:    '\uE8FD'
  };

  /** The pane is a shortlist, not a tab manager: what does not fit is a count. */
  var MAX_OPEN = 12;
  var MAX_CLOSED = 8;

  /* --- state ---------------------------------------------------- */
  var open_ = false;
  var wired = false;

  var btnEl = null;
  var rootEl = null;
  var inputEl = null;
  var listEl = null;

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
    field.appendChild(glyphEl(GLYPH.search, 'ts-field-ico'));

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
    inputEl.addEventListener('input', function () { render(0); });
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
    body.appendChild(secondNode);
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

  function indexOfRow(row) {
    for (var i = 0; i < rows.length; i++) if (rows[i].el === row) return i;
    return -1;
  }

  /* ============================================================
     Render
     ============================================================ */

  function render(keepIndex) {
    if (!listEl) return;
    var data = collect(inputEl ? inputEl.value : '');
    rows = [];
    listEl.textContent = '';               // clears the children, no reset needed

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

    if (!rows.length) {
      var empty = el('div', 'ts-empty');
      empty.textContent = 'No matching tabs';
      listEl.appendChild(empty);
    }

    var want = (typeof keepIndex === 'number') ? keepIndex : 0;
    setHighlight(rows.length ? Math.max(0, Math.min(want, rows.length - 1)) : -1);
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
    if (entry.kind === 'closed') { reopen(entry); return; }
    doActivate(entry.id);
    close();
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
    render(0);
    if (inputEl && typeof inputEl.focus === 'function') {
      try { inputEl.focus(); } catch (err) { /* not attached yet */ }
    }
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
  }

  function toggle() { if (open_) close(); else open(); }

  function handleShortcut(action) {
    if (action === 'tabsearch') { toggle(); return true; }
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
