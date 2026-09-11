'use strict';

/*
 * pip.js — Picture in picture: the instrument that lifts the video out of the
 * page you are looking at and floats it over everything else.
 *
 * The renderer runs with contextIsolation ON and nodeIntegration OFF, so this
 * is plain browser script: no require(), no import, no bundler. Loaded after
 * app.js (which owns .navrow, #downloads and #theme), and after reader.js —
 * this file only ever ADDS to the nav row, immediately before #reader when
 * that instrument is present, else before #shield, #downloads or #theme.
 *
 * Contract with app.js (every call site feature-detects, nothing blocks):
 *   getActiveTab() -> { id, kind:'page'|'claude', viewEl, url, audible } | null
 *   isViewUsable(tab), isNewTabUrl(url), readCurrentUrl(tab)
 *   document events: 'tabchange' {id,kind}, 'tabloaded' {id,url}, 'tabready'
 *   window.Toast.show(message)
 * Nothing here touches window.api: picture in picture is entirely a guest-page
 * capability, reached through <webview>.executeJavaScript().
 *
 * Owned ids/classes (nothing else in the app may touch them): #pip and its
 * .glyph, plus the .is-on state class on that button.
 *
 * WHEN THE BUTTON IS THERE. A page with no <video> in it has nothing to float,
 * so the instrument stays hidden rather than showing a control that can only
 * fail. Video arrives late on most sites — a player is built by script, an ad
 * runs first — so the probe is repeated on every load and, while the tab is
 * making noise, every three seconds until it passes.
 *
 * MOTION. The nav row sits on a backdrop-filter, so every animated frame
 * re-blurs the page behind it. Nothing here animates continuously: the only
 * transitions are the stepped ones in pip.css, none longer than 150ms.
 */

(function () {
  /* --- Segoe Fluent Icons ------------------------------------- */
  // EE49 is "PicturePicture" (picture-in-picture) in Segoe Fluent Icons. It is
  // NOT in the older Segoe MDL2 Assets, so on a machine that falls back to MDL2
  // it renders as a box; E8B9 ("Slideshow") is the MDL2-safe substitute if that
  // ever happens. This has not been seen rendered — see the report note.
  var GLYPH_PIP = '\uEE49';

  /** How often to re-probe a noisy tab that has not shown a video yet. */
  var POLL_MS = 3000;

  /* --- state ---------------------------------------------------- */

  /** tabId -> { url, ok }: the last probe result, so a tab switch paints now. */
  var probes = new Map();

  /** tabId -> boolean: whether that tab's page is currently in picture in picture. */
  var pipOn = new Map();

  var buttonEl = null;
  var pollTimer = null;

  /* ============================================================
     The three snippets that run inside the guest page
     ============================================================ */

  /**
   * The probe. True when the page holds a <video> at all — a player that has
   * not started yet is still worth offering, and requestPictureInPicture()
   * does not need the video to be playing. A video that is playing or has
   * played short-circuits the scan, so the common case costs one element.
   *
   * Same-origin iframes are scanned too (embedded players are usually frames),
   * capped so a page of a hundred frames cannot turn a probe into a stall.
   * A cross-origin frame throws on contentDocument and is skipped: its video
   * is not reachable from here, and that is the platform's rule, not ours.
   */
  var PROBE_SOURCE = [
    '(function () {',
    '  try {',
    '    var seen = false;',
    '    function scan(doc) {',
    '      if (!doc) return false;',
    '      var list;',
    '      try { list = doc.querySelectorAll("video"); } catch (err) { return false; }',
    '      for (var i = 0; i < list.length; i++) {',
    '        seen = true;',
    '        var v = list[i];',
    '        if (!v.paused || v.currentTime > 0) return true;',
    '      }',
    '      return false;',
    '    }',
    '    if (scan(document)) return true;',
    '    var frames = document.querySelectorAll("iframe");',
    '    for (var j = 0; j < frames.length && j < 8; j++) {',
    '      var d = null;',
    '      try { d = frames[j].contentDocument; } catch (err) { d = null; }',
    '      if (scan(d)) return true;',
    '    }',
    '    return seen;',
    '  } catch (err) { return false; }',
    '})()'
  ].join('\n');

  /**
   * The toggle. Already floating: put it back and answer 'exited'. Otherwise
   * pick the best video — one that is playing or has played beats one that
   * has not, and between equals the largest box on screen wins — and answer
   * 'entered'. Anything else, including a browser that refuses the request,
   * answers 'none' so the chrome can say so out loud.
   */
  var TOGGLE_SOURCE = [
    '(function () {',
    '  try {',
    '    if (document.pictureInPictureElement) {',
    '      return Promise.resolve(document.exitPictureInPicture()).then(',
    '        function () { return "exited"; },',
    '        function () { return "none"; });',
    '    }',
    '    var vids = [];',
    '    function collect(doc) {',
    '      if (!doc) return;',
    '      var list;',
    '      try { list = doc.querySelectorAll("video"); } catch (err) { return; }',
    '      for (var i = 0; i < list.length; i++) vids.push(list[i]);',
    '    }',
    '    collect(document);',
    '    var frames = document.querySelectorAll("iframe");',
    '    for (var j = 0; j < frames.length && j < 8; j++) {',
    '      var d = null;',
    '      try { d = frames[j].contentDocument; } catch (err) { d = null; }',
    '      collect(d);',
    '    }',
    '    var best = null, bestScore = -1;',
    '    for (var k = 0; k < vids.length; k++) {',
    '      var v = vids[k];',
    '      if (v.disablePictureInPicture) continue;',
    '      if (typeof v.requestPictureInPicture !== "function") continue;',
    '      var rect = null;',
    '      try { rect = v.getBoundingClientRect(); } catch (err) { rect = null; }',
    '      var w = rect && rect.width > 0 ? rect.width : 0;',
    '      var h = rect && rect.height > 0 ? rect.height : 0;',
    '      var live = (!v.paused || v.currentTime > 0) ? 1 : 0;',
    '      var score = live * 1e9 + w * h;',
    '      if (score > bestScore) { bestScore = score; best = v; }',
    '    }',
    '    if (!best) return "none";',
    '    return Promise.resolve(best.requestPictureInPicture()).then(',
    '      function () { return "entered"; },',
    '      function () { return "none"; });',
    '  } catch (err) { return "none"; }',
    '})()'
  ].join('\n');

  /** Is this page floating a video right now? The top document is the authority. */
  var STATE_SOURCE = '!!document.pictureInPictureElement';

  /* ============================================================
     Pure helpers (exported on window.Pip._helpers for tests)
     ============================================================ */

  /** Only real web pages are worth probing: no new tab, no local files. */
  function isProbeableUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    if (typeof window.isNewTabUrl === 'function') {
      try { if (window.isNewTabUrl(url)) return false; } catch (err) { /* probe on */ }
    }
    var parsed = null;
    try { parsed = new URL(url); } catch (err) { return false; }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  }

  /** Fold whatever the guest answered into the three words this file knows. */
  function normalizeResult(value) {
    return value === 'entered' || value === 'exited' ? value : 'none';
  }

  /* ============================================================
     app.js, reached defensively
     ============================================================ */

  function activeTab() {
    if (typeof window.getActiveTab !== 'function') return null;
    try { return window.getActiveTab(); } catch (err) { return null; }
  }

  function usable(tab) {
    if (typeof window.isViewUsable === 'function') {
      try { return !!window.isViewUsable(tab); } catch (err) { return false; }
    }
    return !!(tab && tab.kind === 'page' && tab.viewEl && tab.viewEl.isConnected);
  }

  function urlOf(tab) {
    if (!tab) return '';
    if (typeof window.readCurrentUrl === 'function') {
      try { return window.readCurrentUrl(tab) || ''; } catch (err) { /* fall through */ }
    }
    return tab.url || '';
  }

  function toast(message) {
    var t = window.Toast;
    if (t && typeof t.show === 'function') {
      try { t.show(message); } catch (err) { /* a missing toast is not a failure */ }
    }
  }

  /**
   * executeJavaScript() as a promise that never rejects into the console.
   * `gesture` asks the guest to treat the call as a user activation, which
   * requestPictureInPicture() insists on.
   */
  function runInGuest(tab, source, gesture) {
    if (!usable(tab)) return Promise.resolve(null);
    try {
      var out = tab.viewEl.executeJavaScript(source, !!gesture);
      if (!out || typeof out.then !== 'function') return Promise.resolve(out);
      return out.then(function (v) { return v; }, function () { return null; });
    } catch (err) {
      return Promise.resolve(null);
    }
  }

  /**
   * app.js's tab list. It is a top-level `const` there, which lives in the
   * global lexical environment every classic script on this page shares — so
   * it is reachable by name but never as window.tabs.
   */
  function allTabs() {
    try {
      /* global tabs */
      if (typeof tabs !== 'undefined' && tabs && typeof tabs.length === 'number') return tabs;
    } catch (err) { /* not in scope: fall through */ }
    var w = window.tabs;
    return w && typeof w.length === 'number' ? w : null;
  }

  /* ============================================================
     Probing
     ============================================================ */

  /** Forget everything held for tabs that no longer exist. */
  function prune() {
    var all = allTabs();
    if (!all) return;
    var live = new Set();
    for (var i = 0; i < all.length; i++) if (all[i]) live.add(all[i].id);
    probes.forEach(function (_entry, id) { if (!live.has(id)) probes.delete(id); });
    pipOn.forEach(function (_on, id) { if (!live.has(id)) pipOn.delete(id); });
  }

  /** The cached answer for a tab, or null when there is none for THIS url. */
  function cached(tab) {
    if (!tab) return null;
    var entry = probes.get(tab.id);
    if (!entry) return null;
    return entry.url === urlOf(tab) ? entry : null;
  }

  /** Drop a tab's cached answer, so the next paint asks the page again. */
  function invalidate(id) {
    if (id === null || id === undefined) return;
    probes.delete(id);
  }

  /**
   * Can this tab be floated? Cached per tab id + url; `force` asks the page
   * again even when there is an answer on file. Always resolves, never throws.
   */
  function canPip(tab, force) {
    if (!usable(tab)) return Promise.resolve(false);
    var url = urlOf(tab);
    if (!isProbeableUrl(url)) return Promise.resolve(false);

    var hit = force ? null : cached(tab);
    if (hit) return Promise.resolve(hit.ok);

    var id = tab.id;
    return runInGuest(tab, PROBE_SOURCE).then(function (value) {
      var ok = value === true;
      probes.set(id, { url: url, ok: ok });
      return ok;
    });
  }

  /* ============================================================
     DOM
     ============================================================ */

  function paint(show, on) {
    if (!buttonEl) return;
    buttonEl.hidden = !show;
    if (on) buttonEl.classList.add('is-on');
    else buttonEl.classList.remove('is-on');
    buttonEl.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /** Repaint for the active tab: whatever is cached now, the truth after. */
  function refresh(force) {
    prune();
    var tab = activeTab();
    var id = tab ? tab.id : null;

    var hit = cached(tab);
    paint(!!(hit && hit.ok), !!(id !== null && pipOn.get(id)));

    canPip(tab, force).then(function (ok) {
      var now = activeTab();
      if (!now || now.id !== id) return;   // the user moved on mid-probe
      paint(ok, !!pipOn.get(id));
    });
  }

  /** Ask the page whether it is floating a video, and repaint if it is news. */
  function syncState(tab) {
    if (!usable(tab)) return Promise.resolve(false);
    var id = tab.id;
    return runInGuest(tab, STATE_SOURCE).then(function (value) {
      var on = value === true;
      pipOn.set(id, on);
      var now = activeTab();
      if (now && now.id === id && buttonEl && !buttonEl.hidden) paint(true, on);
      return on;
    });
  }

  /** The nav-row instrument: same recipe as #reader, one slot to its left. */
  function injectButton() {
    if (document.getElementById('pip')) {
      buttonEl = document.getElementById('pip');
      return;
    }
    var navrow = document.querySelector('.navrow');
    if (!navrow) return;

    buttonEl = document.createElement('button');
    buttonEl.id = 'pip';
    buttonEl.className = 'glass iconbtn no-drag';
    buttonEl.type = 'button';
    buttonEl.title = 'Picture in picture';
    buttonEl.setAttribute('aria-label', 'Picture in picture');
    buttonEl.setAttribute('aria-pressed', 'false');
    buttonEl.hidden = true;              // shown only once a probe passes

    var glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = GLYPH_PIP;
    buttonEl.appendChild(glyph);

    buttonEl.addEventListener('click', function () { toggle(); });

    var reader = document.getElementById('reader');
    var shield = document.getElementById('shield');
    var downloads = document.getElementById('downloads');
    var theme = document.getElementById('theme');
    if (reader && reader.parentNode === navrow) navrow.insertBefore(buttonEl, reader);
    else if (shield && shield.parentNode === navrow) navrow.insertBefore(buttonEl, shield);
    else if (downloads && downloads.parentNode === navrow) navrow.insertBefore(buttonEl, downloads);
    else if (theme && theme.parentNode === navrow) navrow.insertBefore(buttonEl, theme);
    else navrow.appendChild(buttonEl);
  }

  /* ============================================================
     Toggling
     ============================================================ */

  /**
   * Float the active tab's video, or put it back if it is already floating.
   * Resolves 'entered' | 'exited' | 'none'; 'none' is the only one the user
   * hears about, because it is the only one they cannot see for themselves.
   */
  function toggle() {
    var tab = activeTab();
    if (!usable(tab)) {
      toast('No video on this page');
      return Promise.resolve('none');
    }
    var id = tab.id;
    return runInGuest(tab, TOGGLE_SOURCE, true).then(function (value) {
      var result = normalizeResult(value);
      if (result === 'none') toast('No video on this page');
      pipOn.set(id, result === 'entered');

      var now = activeTab();
      if (now && now.id === id) {
        var hit = cached(now);
        paint(result === 'entered' || !!(hit && hit.ok), result === 'entered');
      }
      // The page is the authority on whether it is floating: confirm.
      syncState(tab);
      return result;
    });
  }

  /* ============================================================
     Wiring
     ============================================================ */

  function handleShortcut(action) {
    if (action === 'pip') {
      toggle();
      return true;
    }
    return false;
  }

  /**
   * One tick of the slow poll. A tab that is making noise but has not shown a
   * video yet is re-asked: players are built late, and an ad often runs first.
   * A tab that already passed is left alone — there is nothing left to learn.
   */
  function tick() {
    var tab = activeTab();
    if (!usable(tab) || !tab.audible) return;
    var hit = cached(tab);
    if (hit && hit.ok) return;
    refresh(true);
  }

  function startPoll() {
    if (pollTimer !== null) return;
    if (typeof setInterval !== 'function') return;
    pollTimer = setInterval(tick, POLL_MS);
    // Node's timers keep a process alive; the test harness would never exit.
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function stopPoll() {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function wire() {
    document.addEventListener('tabchange', function () {
      refresh();
      var tab = activeTab();
      if (tab) syncState(tab);
    });

    // A load is a new page, whatever the url says: the old answer is stale.
    document.addEventListener('tabloaded', function (event) {
      var id = event && event.detail ? event.detail.id : null;
      if (id === null || id === undefined) return;
      invalidate(id);
      var act = activeTab();
      if (act && act.id === id) refresh();
    });

    document.addEventListener('tabready', function (event) {
      var id = event && event.detail ? event.detail.id : null;
      if (id === null || id === undefined) return;
      invalidate(id);
      var act = activeTab();
      if (act && act.id === id) refresh();
    });
  }

  function boot() {
    injectButton();
    wire();
    startPoll();
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.Pip = {
    toggle: toggle,
    canPip: canPip,
    handleShortcut: handleShortcut,
    refresh: refresh,
    // Pure helpers and the seams the tests drive, reachable without a window.
    _helpers: {
      isProbeableUrl: isProbeableUrl,
      normalizeResult: normalizeResult,
      invalidate: invalidate,
      syncState: syncState,
      tick: tick,
      startPoll: startPoll,
      stopPoll: stopPoll,
      probes: probes,
      pipOn: pipOn,
      POLL_MS: POLL_MS,
      GLYPH_PIP: GLYPH_PIP,
      PROBE_SOURCE: PROBE_SOURCE,
      TOGGLE_SOURCE: TOGGLE_SOURCE,
      STATE_SOURCE: STATE_SOURCE
    }
  };
})();
