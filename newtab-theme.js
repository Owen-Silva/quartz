/* ============================================================
   newtab-theme.js — the first thing this page runs.

   Loaded in <head> BEFORE newtab.css so the right palette is in
   place for the very first paint: a light window never flashes
   dark. The single source of truth for the whole page — the
   stylesheet and the board script both — is the data-theme
   attribute on <html>.

   Resolution order:
     1. ?theme=light / ?theme=dark, appended by the browser chrome
     2. the OS preference
     3. dark

   No localStorage: this page is loaded from file://, where storage
   is unreliable, and the chrome owns the preference anyway. When
   the chrome changes theme later it simply sets data-theme again;
   CSS does the rest, so there is nothing here to re-run.
   ============================================================ */

(function () {
  'use strict';

  var theme = null;

  try {
    theme = new URLSearchParams(window.location.search).get('theme');
  } catch (err) {
    theme = null;
  }

  // The chrome always passes ?theme=; if it ever does not, match its own
  // default (dark) rather than the Windows app-mode setting.
  if (theme !== 'light' && theme !== 'dark') theme = 'dark';

  document.documentElement.setAttribute('data-theme', theme);
})();
