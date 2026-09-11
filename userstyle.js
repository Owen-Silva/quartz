/* ============================================================
   userstyle.js — the user's own stylesheet for the browser itself.

   Not site styles. sitestyles.js paints web pages, inside guest
   <webview>s, across an async boundary. This module paints the
   chrome: the titlebar, the tabs, the omnibox, the panels — the
   document this script is already running in. One localStorage
   string, one <style> element, no IPC and nothing to wait for.

   THE STORE. localStorage['userstyle'], a plain string. Not JSON:
   there is exactly one value and wrapping it in an envelope would
   only invent a way for it to be corrupt. A missing key, a storage
   that throws (private mode, a wiped profile) and an empty sheet
   all read back the same way — "" — because to the user they are
   the same thing: no custom style.

   THE CAP. 64 Ki characters. localStorage counts UTF-16 code units,
   so that is the unit measured here too; a cap in bytes would be a
   number that does not match the thing it is protecting. Over the
   cap the write is REJECTED — the old sheet stays, nothing is
   truncated (half a stylesheet is a broken stylesheet) — and the
   user is told through window.Toast when this build has one.

   THE CASCADE. apply() puts the CSS in a single <style
   id="user-chrome"> and re-appends it to the END of <head> every
   time. Position is the whole point: chrome.css and the ten module
   stylesheets are all in <head> at equal specificity, so last one
   in wins, and a rule the user wrote should beat the rule it was
   written to replace without a wall of !important. Re-appending
   (rather than creating it once and trusting it stays put) means a
   stylesheet some module adds later cannot quietly get above it.

   The element is created lazily: a profile with no custom style
   gets no empty <style> tag in its head. Once it exists, clear()
   empties it rather than removing it — the sheet is gone either
   way, and keeping the node keeps the anchor.

   THE ESCAPE HATCH. A user stylesheet can hide the settings panel
   that would let you edit it — `#settings-panel { display: none }`
   is one typo away, and a browser you cannot un-break is a browser
   you stop customising. So the reset is a keystroke: app.js binds
   'userstyle-reset' (Ctrl+Alt+Shift+R by default) and main.js
   replays it even when the keypress landed inside a page, so it
   works with focus anywhere. It clears the store, repaints, and
   says so.

   Style: classic script, no modules, ES5-flavoured, no bundler.
   ============================================================ */

(function () {
  'use strict';

  /* --- constants ---------------------------------------------- */

  var STORAGE_KEY = 'userstyle';
  var STYLE_ID = 'user-chrome';

  /* 64 Ki UTF-16 code units — see THE CAP above. */
  var MAX_LENGTH = 64 * 1024;

  var MSG_RESET = 'Browser style reset';
  var MSG_TOO_BIG = 'That stylesheet is too big. The limit is 64 KB.';
  var MSG_NO_ROOM = "Couldn't save your stylesheet: no room left in storage.";

  /* --- small helpers ------------------------------------------- */

  /** Tell the user, when this build has something to tell them with. */
  function toast(text) {
    var t = window.Toast;
    if (!t || typeof t.show !== 'function') return;
    try { t.show(text); } catch (err) { /* a toast is never worth a throw */ }
  }

  /** localStorage, or null where it is missing or walled off. */
  function store() {
    try { return window.localStorage || null; } catch (err) { return null; }
  }

  /* ============================================================
     The store
     ============================================================ */

  /**
   * The saved sheet, always a string. Storage that is absent, empty,
   * or throwing all mean the same thing to a caller: no custom style.
   */
  function get() {
    var s = store();
    if (!s) return '';
    var value = null;
    try { value = s.getItem(STORAGE_KEY); } catch (err) { return ''; }
    return typeof value === 'string' ? value : '';
  }

  /**
   * Save a sheet and paint it. Returns true when it was stored.
   *
   * Over the cap is a rejection, not a truncation: the previous sheet
   * is left exactly as it was, so an accidental paste of something
   * enormous costs the user nothing.
   */
  function set(css) {
    var text = css == null ? '' : String(css);
    if (text.length > MAX_LENGTH) {
      toast(MSG_TOO_BIG);
      return false;
    }
    var s = store();
    if (s) {
      try {
        if (text) s.setItem(STORAGE_KEY, text);
        else s.removeItem(STORAGE_KEY);
      } catch (err) {
        // A full or read-only storage. The sheet still goes on screen —
        // it just will not survive a restart, and the user is told why.
        toast(MSG_NO_ROOM);
        apply(text);
        return false;
      }
    }
    apply(text);
    return true;
  }

  /** Forget the sheet and unpaint it. The reset shortcut's whole job. */
  function clear() {
    var s = store();
    if (s) {
      try { s.removeItem(STORAGE_KEY); } catch (err) { /* nothing to forget */ }
    }
    apply('');
    return true;
  }

  /* ============================================================
     The element
     ============================================================ */

  /** <head>, or <html>, or nothing yet. */
  function headEl() {
    try {
      return document.head || document.getElementsByTagName('head')[0] ||
        document.documentElement || null;
    } catch (err) { return null; }
  }

  /** The one element this module owns, or null when it has none yet. */
  function styleEl() {
    try { return document.getElementById(STYLE_ID) || null; } catch (err) { return null; }
  }

  /**
   * Paint. With no argument it paints whatever is stored, which is what
   * the load-time call and every external caller wants.
   *
   * Nothing stored and nothing painted is the common case on a fresh
   * profile, and it deliberately leaves no empty <style> behind.
   */
  function apply(css) {
    var text = css === undefined ? get() : (css == null ? '' : String(css));
    var node = styleEl();
    if (!node && !text) return null;          // nothing to say, nothing to build

    var head = headEl();
    if (!head) return null;                    // too early; wire() calls back

    if (!node) {
      node = document.createElement('style');
      node.id = STYLE_ID;
      node.setAttribute('type', 'text/css');
    }
    node.textContent = text;
    // Last in <head> every time: see THE CASCADE. appendChild on a node
    // that is already a child moves it, so this is also the re-seat.
    head.appendChild(node);
    return node;
  }

  /* ============================================================
     Shortcut
     ============================================================ */

  /**
   * Forwarded from app.js, and from main.js when the key was pressed
   * inside a <webview> and never reached this document. Returns true
   * when the action was consumed.
   */
  function handleShortcut(action) {
    if (action === 'userstyle-reset') {
      clear();
      toast(MSG_RESET);
      return true;
    }
    return false;
  }

  /* ============================================================
     Wiring
     ============================================================ */

  // Paint at load. The script tag sits in the document, so <head> is
  // already parsed by the time this runs; the listener is the belt to
  // that braces, for a build that ever moves the tag earlier.
  if (!apply()) {
    try {
      document.addEventListener('DOMContentLoaded', function () { apply(); });
    } catch (err) { /* not a document: tests, mostly */ }
  }

  window.UserStyle = {
    get: get,
    set: set,
    clear: clear,
    apply: apply,
    handleShortcut: handleShortcut,

    // Reachable so they can be exercised, and so the settings panel can
    // name the same number this module enforces.
    MAX_LENGTH: MAX_LENGTH,
    STYLE_ID: STYLE_ID,
    STORAGE_KEY: STORAGE_KEY
  };
})();
