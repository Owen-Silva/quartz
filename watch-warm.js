/* ============================================================
   watch-warm.js -- Lumen's first video or Short open, warmed at idle
   (chrome side). lumen-n-perf2, 10-19.

   The first time the Quartz window draws Lumen's player layer (the
   playback view, the Shorts view, the play bar, the comments), Blink
   loads every font face that layer names for the first time: Segoe UI
   Variable Text and Display at 500, 600, 650 and 700, the icon font,
   tabular figures. A trace of the first video view open (lumen-perf,
   video-open) had one forced layout of 40 objects take 77 ms, most of
   it that first-use font work, and text shaping on top.

   So once Lumen is in front, when the window is IDLE
   (requestIdleCallback, no timeout), this lays out one line of text
   in each font the player layer's own stylesheets name, off screen
   and hidden, one at a time while each idle period lasts, then
   removes it. The faces stay in Blink's font cache, so the first open
   finds them loaded. Once per window; nothing at rest afterwards (no
   timer, no listener); nothing on screen; no network (system fonts).

   Hook: app.js updateLumenBtn() calls LumenWarm.soon() when Lumen
   comes to the front.
   ============================================================ */
(function (root) {
  'use strict';
  var SHEETS = /\/watch-(player|player-extras|player-multi|playerbar|playview|comments|shorts|ambient)\.css(\?|$)/;
  var TEXT = 'Lumen 0123456789 1:23:45 / 10 Aa Bb Gg Jj Qq Watch later Subscribe Comments Shorts · — …';
  var ICON = /fluent icons|mdl2/i;
  var W = { asked: false, done: false, read: 0, faces: 0, laidOut: 0, ms: 0, why: '' };

  function specs() {
    var seen = Object.create(null), out = [];
    var take = function (st) {
      if (!st) return;
      var f = {
        font: st.getPropertyValue('font'), family: st.getPropertyValue('font-family'), weight: st.getPropertyValue('font-weight'),
        size: st.getPropertyValue('font-size'), style: st.getPropertyValue('font-style'), num: st.getPropertyValue('font-variant-numeric')
      };
      if (!f.font && !f.family && !f.weight && !f.num) return;
      var k = [f.font, f.family, f.weight, f.size, f.style, f.num].join('|');
      if (seen[k]) return;
      seen[k] = 1;
      out.push(f);
    };
    var walk = function (rules) {
      for (var i = 0; rules && i < rules.length; i++) {
        var r = rules[i];
        if (r.style) take(r.style);
        if (r.cssRules) walk(r.cssRules);
      }
    };
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      if (!SHEETS.test(String(sheets[i].href || ''))) continue;
      try { walk(sheets[i].cssRules); W.read++; } catch (e) { /* not readable (a file:// sheet can be opaque): the list below */ }
    }
    if (!out.length) for (var j = 0; j < FALLBACK.length; j++) out.push({ font: FALLBACK[j], family: '', weight: '', size: '', style: '', num: j < 2 ? 'tabular-nums' : '' });
    return out;
  }
  // The same faces by hand (from the player stylesheets, 10-19), for a window whose sheets can't be read.
  var FALLBACK = ['500 12px var(--font)', '600 13px var(--font)', '13px var(--font)', '500 13px var(--font)', '600 12px var(--font)',
    '600 12.5px var(--font)', '600 15px var(--font)', '600 16px var(--font)', '14px var(--font)', '700 13px var(--font)',
    '600 14px var(--font-display)', '600 15px var(--font-display)', '650 17px var(--font-display)', '650 19px var(--font-display)',
    '650 21px var(--font-display)', '700 10.5px var(--font-display)', '11px "Segoe Fluent Icons", "Segoe MDL2 Assets"', '12px "Segoe Fluent Icons", "Segoe MDL2 Assets"'];

  function line(f) {
    var s = document.createElement('span');
    s.style.display = 'block';
    s.style.whiteSpace = 'nowrap';
    if (f.font) s.style.setProperty('font', f.font);
    if (f.family) s.style.setProperty('font-family', f.family);
    if (f.weight) s.style.setProperty('font-weight', f.weight);
    if (f.size) s.style.setProperty('font-size', f.size);
    if (f.style) s.style.setProperty('font-style', f.style);
    if (f.num) s.style.setProperty('font-variant-numeric', f.num);
    // the icon font only for its own glyphs (a private-use character in a text face starts a system fallback search)
    s.textContent = ICON.test(f.font + ' ' + f.family) ? '' : TEXT;
    return s;
  }

  function run() {
    if (W.done) return;
    W.done = true;
    var list = specs();
    W.faces = list.length;
    if (!list.length) { W.why = 'no player stylesheet found'; return; }
    var host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.className = 'lumen-warm';
    host.style.cssText = 'position:fixed;left:-20000px;top:0;width:4000px;visibility:hidden;pointer-events:none;contain:layout style paint;';
    document.body.appendChild(host);
    var i = 0;
    var step = function (deadline) {
      var t0 = performance.now();
      do {
        host.appendChild(line(list[i++]));
        void host.offsetHeight;     // lay it out now: the face loads, the line shapes
        W.laidOut = i;
      } while (i < list.length && deadline && deadline.timeRemaining() > 10);
      W.ms += performance.now() - t0;
      if (i < list.length) root.requestIdleCallback(step);
      else { host.remove(); W.ms = Math.round(W.ms); }
    };
    root.requestIdleCallback(step);
  }

  /** Lumen is in front: warm the player layer's fonts when the window is next idle (once per window). */
  function soon() {
    if (W.asked || typeof root.requestIdleCallback !== 'function' || !root.document) return;
    W.asked = true;
    root.requestIdleCallback(function () { try { run(); } catch (e) { W.why = String((e && e.message) || e); } });
  }

  root.LumenWarm = { soon: soon, _state: function () { return { asked: W.asked, done: W.done, read: W.read, faces: W.faces, laidOut: W.laidOut, ms: W.ms, why: W.why }; } };
})(typeof window !== 'undefined' ? window : this);
