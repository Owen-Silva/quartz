/*
 * pagefavicons.js — site logos for the preload-less guest pages (the new tab
 * page and the history page). Needs tabicons.js (TabIcons.tile/paintTile)
 * loaded first.
 *
 * These pages used to point an <img> at Google's favicon service, which told
 * Google every site on the page, drew nothing offline, and drew a grey globe
 * for any site Google did not know. Now a logo comes from the same per-origin
 * store the tab strip uses (faviconstore.js in main, on disk), through the
 * chrome, the way every other ask from these pages travels:
 *
 *   out  console line   quartz:favicons {"origins":["https://x.com", ...]}
 *   in   window.__applyFavicons({ "https://x.com": "data:image/png;base64,..." | null })
 *
 * app.js answers only a new-tab or history guest, only with origins it can
 * parse, and only with data:image URLs read from the store (or learned from
 * the site's own /favicon.ico, exactly as the tab strip learns them). The
 * page never makes an icon request of its own: a tile's <img> is only ever
 * given a data: URL.
 *
 * Asked at once for the first EAGER origins, lazily after that: a tile asks
 * when it first comes near the viewport, so a long history list costs the
 * rows on screen, not the whole list. Answers are
 * remembered per origin for the life of the page, so a re-render (every
 * keystroke in the history filter, every settings push on the new tab) is
 * instant and asks nothing. A tile with no answer after ANSWER_WAIT_MS shows
 * its monogram, and still takes a logo if one arrives later: never blank.
 */
(function () {
  'use strict';

  var PREFIX = 'quartz:favicons ';
  var MAX_PER_LINE = 200;
  var ANSWER_WAIT_MS = 900;
  // The first EAGER origins on a page ask at once (the new tab page's whole
  // set, the top of the history list); only past that does a tile wait to
  // come near the viewport. A tile left waiting on the observer (a page that
  // is not rendering, so the observer never runs) shows its monogram after
  // LAZY_LETTER_MS rather than sitting blank, and still takes a logo later.
  var EAGER = 60;
  var LAZY_LETTER_MS = 1500;
  var eager = new Set();

  var known = new Map();     // origin -> data URL | null   (what the chrome said)
  var asked = new Set();     // origins sent and not yet answered
  var tiles = new Map();     // origin -> Set<element>      (tiles waiting or showing)
  var queue = new Set();     // origins to send on the next tick
  var queued = false;
  var stats = { lines: 0, asked: 0, answered: 0 };

  function icons() { return window.TabIcons || null; }

  function remember(origin, el) {
    var set = tiles.get(origin);
    if (!set) { set = new Set(); tiles.set(origin, set); }
    // A re-render drops the old rows: forget tiles no longer in the page.
    if (set.size >= 200) set.forEach(function (old) { if (!old.isConnected) set.delete(old); });
    set.add(el);
  }

  function flush() {
    queued = false;
    var list = Array.from(queue);
    queue.clear();
    for (var i = 0; i < list.length; i += MAX_PER_LINE) {
      var part = list.slice(i, i + MAX_PER_LINE);
      stats.lines++;
      stats.asked += part.length;
      try { console.log(PREFIX + JSON.stringify({ origins: part })); } catch (err) { /* no console */ }
    }
    // Nothing answered in time (no chrome, a slow store): letters, never blank.
    setTimeout(function () {
      for (var j = 0; j < list.length; j++) {
        if (known.has(list[j])) continue;
        var set = tiles.get(list[j]);
        if (set) set.forEach(function (el) { paint(el, null); });
      }
    }, ANSWER_WAIT_MS);
  }

  function ask(origin) {
    if (known.has(origin) || asked.has(origin)) return;
    asked.add(origin);
    queue.add(origin);
    if (!queued) {
      queued = true;
      setTimeout(flush, 0);
    }
  }

  function paint(el, data) {
    var ti = icons();
    if (ti) ti.paintTile(el, data);
  }

  // A tile asks when it first comes within a screen of the viewport.
  var observer = (typeof IntersectionObserver === 'function')
    ? new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        var el = entries[i].target;
        observer.unobserve(el);
        var origin = el.getAttribute('data-origin');
        if (origin) want(origin, el);
      }
    }, { rootMargin: '600px 0px' })
    : null;

  /**
   * A logo tile for a host or URL, `size` CSS px square. `className` keeps
   * the surface's own layout rules. Never blank: logo or monogram.
   */
  function node(urlOrHost, size, className) {
    var ti = icons();
    if (!ti) {
      var bare = document.createElement('span');
      bare.className = className || '';
      return bare;
    }
    var el = ti.tile(urlOrHost, { size: size || 16, className: className || '' });
    var origin = el.getAttribute('data-origin');
    if (!origin) { ti.paintTile(el, null); return el; }
    if (known.has(origin)) {
      ti.paintTile(el, known.get(origin));
      // Still listed, so a letter shown now takes a logo learned later.
      if (known.get(origin) === null) remember(origin, el);
      return el;
    }
    if (!observer || eager.has(origin) || eager.size < EAGER) {
      eager.add(origin);
      want(origin, el);
      return el;
    }
    remember(origin, el);
    observer.observe(el);
    setTimeout(function () {
      if (el.isConnected && el.getAttribute('data-state') === 'pending') paint(el, null);
    }, LAZY_LETTER_MS);
    return el;
  }

  /** A tile is on (or near) screen: paint what is known, or ask. */
  function want(origin, el) {
    remember(origin, el);
    if (known.has(origin)) paint(el, known.get(origin));
    else ask(origin);
  }

  /** The chrome's answer: { origin: dataUrl | null }. A later logo upgrades a letter. */
  function apply(map) {
    if (!map || typeof map !== 'object') return;
    Object.keys(map).forEach(function (origin) {
      var v = map[origin];
      var data = (typeof v === 'string' && /^data:image\//i.test(v)) ? v : null;
      // A logo, once known, is not forgotten by a later "nothing".
      if (!data && typeof known.get(origin) === 'string') return;
      known.set(origin, data);
      asked.delete(origin);
      stats.answered++;
      var set = tiles.get(origin);
      if (!set) return;
      set.forEach(function (el) {
        if (!el.isConnected) { set.delete(el); return; }
        paint(el, data);
      });
    });
  }

  window.__applyFavicons = apply;
  window.PageFavicons = {
    node: node,
    describe: function () {
      return { known: known.size, waiting: asked.size, lines: stats.lines, asked: stats.asked, answered: stats.answered };
    }
  };
})();
