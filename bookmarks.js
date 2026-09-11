'use strict';

/*
 * bookmarks.js — the bookmarks bar: the new-tab shortcuts, one click away on
 * every page.
 *
 * There is no second list of bookmarks in this browser. The chips on the new
 * tab page ARE the bookmarks, stored once in Settings.chips(); this file is a
 * second way to look at the same list, so Ctrl+D still adds in one place and
 * the settings panel is still the one place to edit.
 *
 * The renderer runs with contextIsolation ON and nodeIntegration OFF, so this
 * is plain browser script: no require(), no import, no bundler. Loaded after
 * app.js (for navigateActiveTab/createTab) and after settings.js (for the
 * store), and it only ever ADDS to the document.
 *
 * WHERE IT LIVES. The bar is a block child of .chrome-layer, inserted right
 * after .navrow. The layer is `flex: 0 0 auto` inside a column-flex body, so a
 * new child simply makes the chrome taller and #views starts lower — the bar
 * pushes the page down like a real bookmarks bar rather than floating over it.
 * Fullscreen needs no handling here: chrome.css already display:none's the
 * whole layer under body.fullscreen / body.page-fullscreen.
 *
 * Owned ids/classes (nothing else in the app may touch them):
 *   #bookmarks-bar and every .bm-* class inside it, plus #bm-overflow (the
 *   popover for what did not fit, a direct child of <body> so it stacks over
 *   #views).
 *
 * MOTION. The bar sits on a backdrop-filter, so every animated frame re-blurs
 * what is behind it. Nothing here animates continuously: every transition is
 * stepped and none runs longer than 150ms.
 */

(function () {
  /* --- Segoe Fluent Icons ------------------------------------- */
  // Both are carried forward from Segoe MDL2 Assets, so they render on either
  // font named in --icon-font.
  var GLYPH_GLOBE = '\uE774';   // "Globe": the favicon that did not load
  var GLYPH_MORE = '\uE712';    // "More": the overflow button

  /* One shared favicon service, the same one the new tab page uses. */
  var FAVICON_URL = 'https://www.google.com/s2/favicons?domain=';

  var BAR_ID = 'bookmarks-bar';
  var MENU_ID = 'bm-overflow';

  /** No chips yet: the bar says how to get one rather than sitting empty. */
  var EMPTY_TEXT = 'Add pages with Ctrl+D';

  /** A drag-resize fires resize per frame; the bar re-measures once it stops. */
  var RESIZE_MS = 120;

  var barEl = null;
  var itemsEl = null;
  var moreEl = null;
  var menuEl = null;

  /** Every .bm in the bar, in chip order: [{ chip, el }]. */
  var rendered = [];

  /** The chips the last render drew, so a resize does not refetch favicons. */
  var renderedKey = null;

  /** What did not fit, newest measurement: [{ chip, el }] from `rendered`. */
  var overflowed = [];

  var resizeTimer = 0;

  /* ============================================================
     The store

     Every read goes through Settings, and every read is guarded: this file
     must not be the reason the chrome fails to boot if it is ever loaded
     before settings.js.
     ============================================================ */

  function settings() {
    var s = window.Settings;
    return s && typeof s.get === 'function' ? s : null;
  }

  /** The setting, which is also the bar's visibility. */
  function isOn() {
    var s = settings();
    return s ? !!s.get('bookmarksBar') : false;
  }

  function chips() {
    var s = settings();
    if (!s || typeof s.chips !== 'function') return [];
    var list = s.chips();
    return Array.isArray(list) ? list : [];
  }

  /** "https://www.github.com/x" -> "github.com"; anything unparseable -> ''. */
  function hostOf(url) {
    try {
      return new URL(String(url)).hostname.replace(/^www\./, '');
    } catch (err) {
      return '';
    }
  }

  /* ============================================================
     DOM
     ============================================================ */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function rect(node) {
    if (!node || typeof node.getBoundingClientRect !== 'function') return null;
    try {
      return node.getBoundingClientRect();
    } catch (err) {
      return null;
    }
  }

  /**
   * Build the bar and the popover once. Returns the bar, or null when the
   * chrome this file hangs off is not there (which is never, in the app).
   */
  function build() {
    if (barEl) return barEl;

    var existing = document.getElementById(BAR_ID);
    if (existing) { barEl = existing; return barEl; }

    var layer = document.querySelector('.chrome-layer');
    var navrow = (layer || document).querySelector('.navrow');
    if (!navrow) return null;

    var parent = navrow.parentNode || layer;
    if (!parent) return null;

    barEl = el('div', 'glass');
    barEl.id = BAR_ID;
    barEl.setAttribute('role', 'toolbar');
    barEl.setAttribute('aria-label', 'Bookmarks');
    barEl.hidden = true;

    itemsEl = el('div', 'bm-items');
    barEl.appendChild(itemsEl);

    moreEl = document.createElement('button');
    moreEl.type = 'button';
    moreEl.className = 'bm-more';
    moreEl.title = 'More bookmarks';
    moreEl.setAttribute('aria-label', 'More bookmarks');
    moreEl.setAttribute('aria-expanded', 'false');
    moreEl.hidden = true;
    moreEl.appendChild(el('span', 'glyph', GLYPH_MORE));
    moreEl.addEventListener('click', function () { toggleMenu(); });
    barEl.appendChild(moreEl);

    // insertBefore(node, null) appends, so a .navrow that is the last child of
    // the layer still lands the bar directly under it.
    parent.insertBefore(barEl, navrow.nextSibling);

    menuEl = el('div', 'glass');
    menuEl.id = MENU_ID;
    menuEl.setAttribute('role', 'menu');
    menuEl.setAttribute('aria-label', 'More bookmarks');
    menuEl.hidden = true;
    document.body.appendChild(menuEl);

    return barEl;
  }

  /**
   * One bookmark. The favicon may be blocked or missing, so the <img> hides
   * itself and hands the row to a globe glyph rather than leaving a hole.
   */
  function makeItem(chip) {
    var url = String((chip && chip.url) || '');
    var host = hostOf(url);
    var label = String((chip && chip.label) || '') || host || url;

    var a = document.createElement('a');
    a.className = 'bm';
    a.href = url;
    a.title = label === url ? url : label + '\n' + url;
    a.setAttribute('data-url', url);
    a.setAttribute('data-host', host);
    a.setAttribute('role', 'menuitem');
    a.draggable = false;

    var icon = document.createElement('img');
    icon.className = 'bm-icon';
    icon.width = 16;
    icon.height = 16;
    icon.alt = '';
    icon.loading = 'lazy';
    icon.setAttribute('aria-hidden', 'true');

    var fallback = el('span', 'glyph bm-fallback', GLYPH_GLOBE);
    fallback.setAttribute('aria-hidden', 'true');
    fallback.hidden = true;

    if (host) {
      icon.onerror = function () { icon.hidden = true; fallback.hidden = false; };
      icon.src = FAVICON_URL + encodeURIComponent(host) + '&sz=32';
    } else {
      // Nothing to ask the service about: go straight to the glyph.
      icon.hidden = true;
      fallback.hidden = false;
    }

    a.appendChild(icon);
    a.appendChild(fallback);
    a.appendChild(el('span', 'bm-label', label));

    a.addEventListener('click', function (event) { activate(event, url); });
    a.addEventListener('auxclick', function (event) { activate(event, url); });
    // Middle-click otherwise drops Chromium's autoscroll cursor on the chrome.
    a.addEventListener('mousedown', function (event) {
      if (event && event.button === 1 && typeof event.preventDefault === 'function') event.preventDefault();
    });

    return a;
  }

  /**
   * A bookmark was picked. Plain click navigates the tab you are looking at —
   * which opens a new tab when that tab is a Claude session, because that is
   * what navigateActiveTab() does. Middle-click and Ctrl+click open a
   * background tab instead, like every other link in the browser.
   */
  function activate(event, url) {
    if (event && event.button === 2) return;                    // right-click: nothing here
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (!url) return;
    closeMenu();

    var background = !!(event && (event.button === 1 || event.ctrlKey || event.metaKey));
    if (background) {
      if (typeof window.createTab === 'function') window.createTab(url, { background: true });
      return;
    }
    if (typeof window.navigateActiveTab === 'function') window.navigateActiveTab(url);
  }

  /* ============================================================
     Render
     ============================================================ */

  /**
   * Draw the chips. The list is rebuilt only when it actually changed: a
   * resize calls refresh() too, and rebuilding there would refetch every
   * favicon on every frame of a window drag.
   */
  function render(force) {
    if (!itemsEl) return;
    // Off screen: draw nothing (an <img> built here would still fetch), and
    // forget what was drawn so turning the bar back on rebuilds it.
    if (barEl && barEl.hidden) { renderedKey = null; return; }

    var list = chips();
    var key = JSON.stringify(list);
    if (!force && key === renderedKey) { layout(); return; }
    renderedKey = key;

    itemsEl.textContent = '';
    rendered = [];
    overflowed = [];
    closeMenu();

    if (!list.length) {
      itemsEl.appendChild(el('span', 'bm-empty', EMPTY_TEXT));
      if (moreEl) moreEl.hidden = true;
      return;
    }

    list.forEach(function (chip) {
      var node = makeItem(chip);
      itemsEl.appendChild(node);
      rendered.push({ chip: chip, el: node });
    });

    layout();
  }

  /**
   * Which items run past the right edge of the strip. Every item is visible
   * when this is called, so the rects are the ones the row would have if it
   * were allowed to be as wide as it wants.
   */
  function overflowing() {
    var box = rect(itemsEl);
    if (!box) return [];
    for (var i = 0; i < rendered.length; i++) {
      var r = rect(rendered[i].el);
      if (!r) continue;
      if (r.right > box.right + 0.5) return rendered.slice(i);
    }
    return [];
  }

  /**
   * Decide what fits. Two passes, because unhiding the "…" button narrows the
   * strip: measure once with it away, and if anything spills, put it back and
   * measure again against the smaller strip.
   */
  function layout() {
    if (!barEl || !itemsEl || !moreEl) return [];
    if (barEl.hidden) return [];                 // nothing to measure while it is off

    rendered.forEach(function (r) { r.el.hidden = false; });
    moreEl.hidden = true;

    var over = overflowing();
    if (over.length) {
      moreEl.hidden = false;
      over = overflowing();
      over.forEach(function (r) { r.el.hidden = true; });
    }

    overflowed = over;
    fillMenu(over);
    return over;
  }

  /* ============================================================
     The overflow popover
     ============================================================ */

  function fillMenu(list) {
    if (!menuEl) return;
    menuEl.textContent = '';
    if (!list.length) { closeMenu(); return; }
    list.forEach(function (r) { menuEl.appendChild(makeItem(r.chip)); });
    if (!menuEl.hidden) positionMenu();
  }

  function positionMenu() {
    if (!menuEl || !moreEl) return;
    var anchor = rect(moreEl);
    if (!anchor) return;
    menuEl.style.top = Math.round(anchor.bottom + 6) + 'px';
    var box = rect(menuEl);
    var width = box ? box.width : 0;
    var left = Math.round(anchor.right - width);
    if (left < 8) left = 8;
    menuEl.style.left = left + 'px';
  }

  function openMenu() {
    if (!menuEl || !overflowed.length) return;
    menuEl.hidden = false;
    positionMenu();
    if (moreEl) moreEl.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    if (!menuEl || menuEl.hidden) return;
    menuEl.hidden = true;
    if (moreEl) moreEl.setAttribute('aria-expanded', 'false');
  }

  function toggleMenu() {
    if (menuEl && menuEl.hidden) openMenu();
    else closeMenu();
  }

  function isMenuOpen() {
    return !!menuEl && !menuEl.hidden;
  }

  /* ============================================================
     Visibility
     ============================================================ */

  /** The setting is the single source of truth; this makes the DOM agree. */
  function apply() {
    if (!barEl && !build()) return;
    var on = isOn();
    barEl.hidden = !on;
    if (on) render();
    else closeMenu();
  }

  /**
   * Write the setting and let the change come back through Settings.on, so a
   * settings-panel switch and this path land in exactly the same place. With
   * no store at all (a stray load order), fall back to the DOM alone.
   */
  function setOn(on) {
    var s = settings();
    if (s && typeof s.set === 'function') {
      s.set({ bookmarksBar: !!on });
      // set() is a no-op when the value already matches, so make sure the DOM
      // is in step even then.
      apply();
    } else if (barEl || build()) {
      barEl.hidden = !on;
      if (on) render();
      else closeMenu();
    }
    return !!on;
  }

  function show() { return setOn(true); }
  function hide() { return setOn(false); }
  function toggle() { return setOn(!isVisible()); }

  function isVisible() {
    return !!barEl && !barEl.hidden;
  }

  /** Chips changed, the window resized, or a caller wants the bar re-read. */
  function refresh() {
    if (!barEl && !build()) return;
    if (barEl.hidden) return;
    render();
  }

  /**
   * Forwarded from main.js (keys pressed inside a <webview> never reach this
   * document). Returns true when the action was consumed.
   */
  function handleShortcut(action) {
    if (action !== 'bookmarks-bar') return false;
    toggle();
    return true;
  }

  /* ============================================================
     Wiring
     ============================================================ */

  function wire() {
    var s = settings();
    if (s && typeof s.on === 'function') {
      s.on(function (_snapshot, keys) {
        var k = keys || [];
        if (k.indexOf('bookmarksBar') >= 0) { apply(); return; }
        if (k.indexOf('chips') >= 0) render(true);
      });
    }

    window.addEventListener('resize', function () {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        resizeTimer = 0;
        closeMenu();
        refresh();
      }, RESIZE_MS);
    });

    // Click-outside. mousedown, so it settles before the button's own click.
    document.addEventListener('mousedown', function (event) {
      if (!isMenuOpen()) return;
      var t = event.target;
      if (menuEl.contains(t)) return;
      if (moreEl && moreEl.contains(t)) return;
      closeMenu();
    }, true);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isMenuOpen()) closeMenu();
    });
  }

  function boot() {
    if (!build()) return;
    wire();
    apply();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.Bookmarks = {
    show: show,
    hide: hide,
    toggle: toggle,
    isVisible: isVisible,
    refresh: refresh,
    handleShortcut: handleShortcut,

    // test seams
    _bar: function () { return barEl; },
    _menu: function () { return menuEl; },
    _more: function () { return moreEl; },
    _items: function () { return rendered.slice(); },
    _layout: layout,
    _boot: boot
  };
})();
