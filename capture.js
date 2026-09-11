'use strict';

/*
 * capture.js — page screenshots. Ctrl+Shift+S writes a PNG of whatever page
 * is on screen into the Downloads folder, flashes the window white for one
 * frame, and says so in a toast.
 *
 * The renderer runs with contextIsolation ON and nodeIntegration OFF, so this
 * is plain browser script: no require(), no import, no bundler. Loaded after
 * app.js (which owns the tab list and the keydown handler) and after the other
 * instruments; it adds no button, no panel and no stylesheet — the one element
 * it ever creates is styled inline.
 *
 * Contract with the main process (optional at runtime — every call site checks
 * before it reaches, and nothing here blocks on a promise that can reject):
 *
 *   api.capture = {
 *     tab(wcId, full): Promise<{ path, width, height } | { error }>,
 *     show(path)                      // reveal in Explorer; unused here so far
 *   }
 *
 * Borrowed from app.js, all feature-detected:
 *   getActiveTab() -> { id, kind:'page'|'claude', viewEl, url, title } | null
 *   window.Toast.show(text)
 *   window.Downloads.refresh?()       // the PNG is not a download item, so this
 *                                     // usually has nothing to redraw
 *
 * Owned class (nothing else in the app may touch it): .capture-flash.
 *
 * MOTION. The chrome sits on a backdrop-filter, so every animated frame
 * re-blurs the pane behind it. The flash is therefore ONE stepped frame at a
 * fixed opacity that then removes itself — no transition, no fade, nothing
 * that repaints the window more than twice.
 */

(function () {
  /** One frame, then gone. Long enough to read as a shutter, short enough to
   * cost two repaints. */
  var FLASH_MS = 120;

  var MSG_NOTHING = 'Nothing to capture here';
  var MSG_SAVED = 'Screenshot saved to Downloads';
  var MSG_FAILED = "Couldn't capture this page";

  function toast(message) {
    var t = window.Toast;
    if (t && typeof t.show === 'function') {
      try { t.show(message); } catch (err) { /* a missing toast is not a failure */ }
    }
  }

  /**
   * The tab we can actually screenshot: a page tab, awake, with a live guest
   * behind it. A Claude tab has no <webview> at all and a sleeping one has a
   * placeholder <div>, so neither passes. The new tab page is a real guest and
   * captures like any other page.
   */
  function activePageTab() {
    if (typeof window.getActiveTab !== 'function') return null;
    var tab = null;
    try { tab = window.getActiveTab(); } catch (err) { return null; }
    if (!tab || tab.kind !== 'page' || tab.asleep) return null;
    var view = tab.viewEl;
    if (!view || view.isConnected === false) return null;
    // <webview> methods do not exist before 'dom-ready' and throw once the
    // element is detached: the placeholder <div> of a sleeping tab has none.
    if (typeof view.getWebContentsId !== 'function') return null;
    return tab;
  }

  /** The guest's webContents id, or null while it is not answering. */
  function wcIdOf(tab) {
    if (!tab || !tab.viewEl || typeof tab.viewEl.getWebContentsId !== 'function') return null;
    var id = null;
    try { id = tab.viewEl.getWebContentsId(); } catch (err) { return null; }
    return typeof id === 'number' && isFinite(id) && Math.floor(id) === id ? id : null;
  }

  /** The preload bridge, or null when this build has no capture channel. */
  function captureApi() {
    var api = window.api;
    var cap = api && api.capture;
    return cap && typeof cap.tab === 'function' ? cap : null;
  }

  /**
   * A white sheet over everything for one stepped frame. Styled inline so this
   * module needs no stylesheet: chrome.css is not ours to touch.
   */
  function flash() {
    var doc = window.document;
    if (!doc || !doc.body || typeof doc.createElement !== 'function') return null;

    var el = doc.createElement('div');
    el.className = 'capture-flash';
    var s = el.style;
    s.position = 'fixed';
    s.inset = '0';
    s.background = '#fff';
    s.opacity = '.6';
    s.pointerEvents = 'none';
    s.zIndex = '60';
    doc.body.appendChild(el);

    window.setTimeout(function () {
      if (el.parentNode && typeof el.parentNode.removeChild === 'function') {
        el.parentNode.removeChild(el);
      }
    }, FLASH_MS);
    return el;
  }

  /**
   * The screenshot is written straight to disk, not through a DownloadItem, so
   * the downloads panel has nothing new to show. Nudge it anyway IF it grows a
   * way to redraw itself — feature-detected, so today this is a no-op.
   */
  function refreshDownloads() {
    var d = window.Downloads;
    if (d && typeof d.refresh === 'function') {
      try { d.refresh(); } catch (err) { /* best-effort */ }
    }
  }

  /**
   * Screenshot the page on screen.
   * @returns {Promise<{ path, width, height } | null>} null for every refusal
   *   and every failure — the toast is the real output.
   */
  function takeActive() {
    var tab = activePageTab();
    var cap = tab ? captureApi() : null;
    var wcId = cap ? wcIdOf(tab) : null;
    if (wcId === null) {
      toast(MSG_NOTHING);
      return Promise.resolve(null);
    }

    flash();
    var pending;
    // `full` stays false: main reserves it for a future full-page capture.
    try { pending = cap.tab(wcId, false); } catch (err) { pending = null; }

    return Promise.resolve(pending).then(function (result) {
      if (!result || result.error || !result.path) {
        toast(MSG_FAILED);
        return null;
      }
      toast(MSG_SAVED);
      refreshDownloads();
      return result;
    }, function () {
      // An IPC that rejected outright: same story as { error } to the user.
      toast(MSG_FAILED);
      return null;
    });
  }

  /**
   * The same shot as takeActive(), with none of the theatre: no flash, no
   * toast, no downloads nudge, and no message of its own for a refusal.
   *
   * For callers that DO something with the file rather than just saving it —
   * "Show Claude this page" pastes the path into a chamber, so the prompt is
   * the receipt and a second toast would only say the same thing twice.
   *
   * @returns {Promise<{ path, width, height } | null>} null for every refusal
   *   and every failure; the caller decides what to say about it.
   */
  function captureActive() {
    var tab = activePageTab();
    var cap = tab ? captureApi() : null;
    var wcId = cap ? wcIdOf(tab) : null;
    if (wcId === null) return Promise.resolve(null);

    var pending;
    // `full` stays false for the same reason as above: main reserves it.
    try { pending = cap.tab(wcId, false); } catch (err) { pending = null; }

    return Promise.resolve(pending).then(function (result) {
      if (!result || result.error || !result.path) return null;
      return result;
    }, function () {
      return null;
    });
  }

  /**
   * Forwarded from app.js, and from main.js when the key was pressed inside a
   * <webview> and never reached this document. Returns true when the action
   * was consumed.
   */
  function handleShortcut(action) {
    if (action === 'capture') { takeActive(); return true; }
    return false;
  }

  window.Capture = {
    takeActive: takeActive,
    captureActive: captureActive,
    handleShortcut: handleShortcut,
    // Reachable so they can be exercised without a real window.
    _helpers: {
      FLASH_MS: FLASH_MS,
      MSG_NOTHING: MSG_NOTHING,
      MSG_SAVED: MSG_SAVED,
      MSG_FAILED: MSG_FAILED,
      activePageTab: activePageTab,
      wcIdOf: wcIdOf,
      captureApi: captureApi,
      flash: flash,
      refreshDownloads: refreshDownloads
    }
  };
})();
