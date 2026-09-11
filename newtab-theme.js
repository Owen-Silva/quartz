/* ============================================================
   newtab-theme.js — the first thing this page runs.

   Loaded in <head> BEFORE newtab.css so the right palette is in
   place for the very first paint: a light window never flashes
   dark, and a custom accent hue never flashes ice-cyan. The
   single source of truth for the whole page — the stylesheet and
   the board script both — is the data-theme attribute on <html>.

   Resolution order for the theme:
     1. ?theme=light / ?theme=dark, appended by the browser chrome
     2. dark

   The palette preset comes from ?palette=<name> and lands as
   data-palette on <html>, the same way and for the same reason:
   the stylesheet carries a block per preset per theme, so the
   right aurora and the right accent are in place for the first
   paint. No palette (or "aurora") = no attribute = the default.

   The accent comes from ?hue=<0-360>, painted over the authored
   --ion* tokens as inline custom properties on <html> (inline
   beats both :root blocks, so one pass covers either theme).
   No hue = no inline properties = the stylesheet's own ice-cyan.

   No localStorage: this page is loaded from file://, where storage
   is unreliable, and the chrome owns the preference anyway. When
   the chrome changes theme later it simply sets data-theme again;
   CSS does the rest, and newtab.js re-runs applyAccent through
   window.__applyAccent so the hue tracks the new base colour.
   ============================================================ */

(function () {
  'use strict';

  var root = document.documentElement;

  /* --- theme ------------------------------------------------- */

  var params = null;

  try {
    params = new URLSearchParams(window.location.search);
  } catch (err) {
    params = null;
  }

  var theme = params ? params.get('theme') : null;

  // The chrome always passes ?theme=; if it ever does not, match its own
  // default (dark) rather than the Windows app-mode setting.
  if (theme !== 'light' && theme !== 'dark') theme = 'dark';

  root.setAttribute('data-theme', theme);

  /* --- palette preset ---------------------------------------- */

  /* The five presets chrome.css and newtab.css both carry. Anything
     else — no param, 'aurora', junk — means the authored default,
     which is the absence of the attribute rather than a value. */
  var PALETTES = ['ember', 'forest', 'ocean', 'midnight', 'mono'];

  function applyPalette(name) {
    var value = (name === null || name === undefined) ? '' : String(name);
    if (PALETTES.indexOf(value) < 0) {
      root.removeAttribute('data-palette');
      return;
    }
    root.setAttribute('data-palette', value);
  }

  window.__applyPalette = applyPalette;

  applyPalette(params ? params.get('palette') : null);

  /* --- accent ------------------------------------------------ */

  /* Every --ion* token newtab.css defines, with the alpha it is authored
     at. The chrome derives its own accent with the same formula, so one
     hue lands identically on both surfaces. */
  var ION_TOKENS = [
    ['--ion',      null],
    ['--ion-soft', 0.16],
    ['--ion-glow', 0.45],
    ['--ion-line', 0.75]
  ];

  // Dark wants a bright, saturated light; light wants a darker one that
  // still reads against white glass.
  function baseFor(themeName) {
    return themeName === 'light' ? { s: 90, l: 44 } : { s: 100, l: 75 };
  }

  // Kept so a data-theme flip can re-derive the same hue on the new base.
  var lastHue = null;

  function normalizeHue(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    if (!isFinite(n)) return null;
    return ((n % 360) + 360) % 360;
  }

  /**
   * Paint an accent hue over the authored tokens. null (or anything that
   * is not a number) clears the inline properties and the stylesheet's
   * own accent comes back.
   */
  function applyAccent(hue) {
    var h = normalizeHue(hue);
    var style = root.style;
    var i;

    lastHue = h;

    if (h === null) {
      for (i = 0; i < ION_TOKENS.length; i++) style.removeProperty(ION_TOKENS[i][0]);
      return;
    }

    var base = baseFor(root.getAttribute('data-theme'));
    var head = h + ' ' + base.s + '% ' + base.l + '%';

    for (i = 0; i < ION_TOKENS.length; i++) {
      var alpha = ION_TOKENS[i][1];
      style.setProperty(
        ION_TOKENS[i][0],
        'hsl(' + head + (alpha === null ? '' : ' / ' + alpha) + ')'
      );
    }
  }

  // newtab.js owns the later glue (a data-theme observer, __applySettings),
  // and needs both the setter and the last hue back to re-derive.
  window.__applyAccent = applyAccent;
  window.__accentHue = function () { return lastHue; };

  applyAccent(params ? params.get('hue') : null);
})();
