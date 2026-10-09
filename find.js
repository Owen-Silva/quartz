/* ============================================================
   find.js — find in page

   A single crystal instrument that slides out from under the nav
   row, right-aligned, and drives the active tab's <webview>
   through findInPage / stopFindInPage.

   Classic script, like app.js: no imports, one global. It reads
   app.js's globals (getActiveTab, isViewUsable) defensively, so
   load order can change without this throwing.

   Everything that touches a <webview> is wrapped: guest methods
   do not exist until 'dom-ready' and throw once detached.
   ============================================================ */

(function () {
  'use strict';

  /* Segoe Fluent Icons glyphs by codepoint, so this file stays pure ASCII
     and no editor or encoding round-trip can eat a private-use character. */
  var FC = String.fromCharCode;

  /* Typing re-runs the search at most this often. Short enough to feel
     live, long enough that a fast typist does not issue a find per key. */
  var DEBOUNCE_MS = 60;

  var barEl = null;
  var inputEl = null;
  var countEl = null;
  var prevBtn = null;
  var nextBtn = null;
  var closeBtn = null;

  var opened = false;
  var debounceTimer = 0;

  /* The webview the current highlight lives in, and the text that put it
     there. Both are needed to know whether findNext can continue a search
     or has to start a fresh one (a different guest, or different text). */
  var searchedView = null;
  var searchedText = '';

  /* One 'found-in-page' listener per guest, ever. */
  var wired = new WeakSet();

  /* --- app.js bridges ---------------------------------------- */

  function activeTab() {
    try {
      return typeof getActiveTab === 'function' ? getActiveTab() : null;
    } catch (err) {
      return null;
    }
  }

  function isPageTab(tab) {
    return !!(tab && tab.kind === 'page');
  }

  /** The active guest, or null if it is a Claude tab / not attached yet. */
  function viewOf(tab) {
    if (!isPageTab(tab)) return null;
    var el = tab.viewEl;
    if (!el || !el.isConnected) return null;
    if (typeof isViewUsable === 'function') {
      try {
        if (!isViewUsable(tab)) return null;
      } catch (err) { /* fall through to the method check below */ }
    }
    if (typeof el.findInPage !== 'function') return null; // pre-dom-ready
    return el;
  }

  /* --- guest calls, all guarded ------------------------------- */

  function callFind(view, text, findNext, forward) {
    if (!view || !text) return;
    wire(view);
    try {
      view.findInPage(text, {
        // Electron: findNext=true begins a session, false continues the last one.
        findNext: !findNext,
        forward: forward !== false,
        matchCase: false,
      });
      searchedView = view;
      searchedText = text;
    } catch (err) { /* guest went away mid-keystroke */ }
  }

  function callStop(view, action) {
    if (!view) return;
    try {
      view.stopFindInPage(action);
    } catch (err) { /* guest went away */ }
  }

  function focusView(view) {
    if (!view) return;
    try {
      view.focus();
    } catch (err) { /* guest went away */ }
  }

  /* --- the count read-out ------------------------------------- */

  function setCount(text, none) {
    if (!countEl) return;
    countEl.textContent = text;
    countEl.classList.toggle('none', !!none);
  }

  function onFoundInPage(event) {
    var view = event.currentTarget || event.target;
    if (!opened || view !== searchedView) return; // a stale guest still reporting
    var result = event.result;
    if (!result) return;
    if (!inputEl || !inputEl.value) return setCount('', false);
    if (!result.matches) return setCount('No matches', true);
    setCount(result.activeMatchOrdinal + ' of ' + result.matches, false);
  }

  function wire(view) {
    if (!view || wired.has(view)) return;
    try {
      view.addEventListener('found-in-page', onFoundInPage);
      wired.add(view);
    } catch (err) { /* not an element we can listen on */ }
  }

  /* --- DOM ---------------------------------------------------- */

  function glyph(code) {
    var span = document.createElement('span');
    span.className = 'glyph';
    span.textContent = code;
    return span;
  }

  function iconButton(id, code, label) {
    var btn = document.createElement('button');
    btn.id = id;
    btn.className = 'iconbtn';
    btn.type = 'button';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.appendChild(glyph(code));
    return btn;
  }

  /**
   * Hang the bar off the chrome layer, right after the nav row: the layer is
   * position:relative with z-index 3, so an absolutely positioned child
   * overlays #views (z-index 1) and therefore the guest's surface.
   *
   * Fullscreen takes the whole chrome layer out (display:none), and the find
   * bar is the one instrument that outlives it — so when the layer is not
   * rendered it re-hangs itself off <body> as a fixed panel. Checked on every
   * open, and it only ever moves the node when the answer actually changed.
   */
  function place() {
    if (!barEl) return;
    var layer = document.querySelector('.chrome-layer');
    var usable = !!layer;
    if (usable) {
      try {
        usable = window.getComputedStyle(layer).display !== 'none';
      } catch (err) { /* keep the layer */ }
    }
    if (!usable) {
      if (barEl.parentNode !== document.body) document.body.appendChild(barEl);
      barEl.classList.add('find-detached');
      return;
    }
    if (barEl.parentNode !== layer) {
      var nav = layer.querySelector('.navrow');
      if (nav && nav.parentNode === layer) layer.insertBefore(barEl, nav.nextSibling);
      else layer.appendChild(barEl);
    }
    barEl.classList.remove('find-detached');
  }

  function build() {
    if (barEl) return;

    barEl = document.createElement('div');
    barEl.id = 'findbar';
    barEl.className = 'glass';
    barEl.hidden = true;
    barEl.setAttribute('role', 'search');

    var lens = glyph(FC(0xE721)); // search
    lens.classList.add('find-lens');
    lens.setAttribute('aria-hidden', 'true');

    inputEl = document.createElement('input');
    inputEl.id = 'find-input';
    inputEl.type = 'text';
    inputEl.placeholder = 'Find in page';
    inputEl.spellcheck = false;
    // Autocorrect still fixes a finished word here, on the address bar's
    // search-only rule (spell-preload.js); no squiggles, never on Enter.
    inputEl.setAttribute('data-autocorrect', 'search');
    inputEl.autocomplete = 'off';
    inputEl.setAttribute('autocapitalize', 'off');
    inputEl.setAttribute('aria-label', 'Find in page');

    countEl = document.createElement('span');
    countEl.id = 'find-count';
    countEl.setAttribute('aria-live', 'polite');

    var sep = document.createElement('span');
    sep.className = 'find-sep';
    sep.setAttribute('aria-hidden', 'true');

    prevBtn = iconButton('find-prev', FC(0xE70E), 'Previous match'); // chevron up
    nextBtn = iconButton('find-next', FC(0xE70D), 'Next match');     // chevron down
    closeBtn = iconButton('find-close', FC(0xE711), 'Close find');   // close

    barEl.appendChild(lens);
    barEl.appendChild(inputEl);
    barEl.appendChild(countEl);
    barEl.appendChild(sep);
    barEl.appendChild(prevBtn);
    barEl.appendChild(nextBtn);
    barEl.appendChild(closeBtn);

    place();

    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('keydown', onKeydown);
    barEl.addEventListener('keydown', onKeydown); // Escape from a button too
    prevBtn.addEventListener('click', function () { step(false); });
    nextBtn.addEventListener('click', function () { step(true); });
    closeBtn.addEventListener('click', close);

    syncButtons();
  }

  function syncButtons() {
    var empty = !inputEl || !inputEl.value;
    if (prevBtn) prevBtn.disabled = empty;
    if (nextBtn) nextBtn.disabled = empty;
  }

  /* --- searching ---------------------------------------------- */

  /** Cheap poll: every interaction re-reads the active tab, so a tab
      change with no 'tabchange' event still lands on the right guest. */
  function currentView() {
    var tab = activeTab();
    if (!isPageTab(tab)) {
      close();
      return null;
    }
    return viewOf(tab);
  }

  function search(text) {
    var view = currentView();
    if (!text) {
      callStop(view || searchedView, 'clearSelection');
      searchedView = null;
      searchedText = '';
      setCount('', false);
      return;
    }
    if (!view) return setCount('', false);
    if (view !== searchedView) callStop(searchedView, 'clearSelection');
    callFind(view, text, false, true);
  }

  function onInput() {
    syncButtons();
    window.clearTimeout(debounceTimer);
    var text = inputEl.value;
    if (!text) return search('');           // clearing is instant
    debounceTimer = window.setTimeout(function () {
      if (opened) search(text);
    }, DEBOUNCE_MS);
  }

  /** Enter / the chevrons: walk the matches without restarting the search. */
  function step(forward) {
    if (!opened || !inputEl) return;
    var text = inputEl.value;
    if (!text) return;
    window.clearTimeout(debounceTimer);
    var view = currentView();
    if (!view) return setCount('', false);
    // findNext only continues a search this guest already knows about.
    var cont = view === searchedView && text === searchedText;
    callFind(view, text, cont, forward);
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      step(!event.shiftKey); // Shift+Enter walks backwards
    }
  }

  /* --- open / close ------------------------------------------- */

  function focusInput() {
    if (!inputEl) return;
    try {
      inputEl.focus();
      inputEl.select();
    } catch (err) { /* detached */ }
  }

  function open() {
    var tab = activeTab();
    if (!isPageTab(tab)) { // a Claude tab has nothing to find in
      close();
      return;
    }
    build();
    place();      // fullscreen may have taken the chrome layer away since last time
    opened = true;
    barEl.hidden = false; // display:none -> flex replays the stepped entrance
    focusInput();
    syncButtons();
    if (inputEl.value) search(inputEl.value);
    else setCount('', false);
  }

  function close() {
    opened = false;
    window.clearTimeout(debounceTimer);
    if (!barEl) return;
    barEl.hidden = true;
    // Leave the last hit selected on the page, the way Chrome does.
    callStop(searchedView, 'keepSelection');
    searchedView = null;
    searchedText = '';
    setCount('', false);
    focusView(viewOf(activeTab()));
  }

  function isOpen() {
    return opened;
  }

  /** Ctrl+F on an open bar re-selects the query rather than closing it. */
  function toggle() {
    if (opened) focusInput();
    else open();
  }

  /**
   * One-line router for the replayed page shortcuts in app.js.
   * Returns true when the action was consumed.
   */
  function handleShortcut(action) {
    if (action === 'find') {
      toggle();
      return true;
    }
    if (action === 'escape') {
      if (!opened) return false;
      close();
      return true;
    }
    return false;
  }

  /* --- the active tab changed underneath us -------------------- */

  document.addEventListener('tabchange', function (event) {
    if (!opened) return;
    var kind = event && event.detail && event.detail.kind;
    if (kind ? kind !== 'page' : !isPageTab(activeTab())) {
      close();
      return;
    }
    callStop(searchedView, 'clearSelection'); // do not leave a hit lit behind
    searchedView = null;
    searchedText = '';
    setCount('', false);
    if (inputEl && inputEl.value) search(inputEl.value); // focus stays put
  });

  window.FindBar = {
    open: open,
    close: close,
    toggle: toggle,
    isOpen: isOpen,
    next: function () { step(true); },
    prev: function () { step(false); },
    handleShortcut: handleShortcut,
  };
})();
