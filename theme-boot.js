'use strict';

/*
 * theme-boot.js — runs FIRST in <head>, before any stylesheet has painted.
 * It decides light vs dark and which colour palette, and stamps them on
 * <html>; app.js owns every later change. Kept synchronous and tiny on
 * purpose: anything async here would let the wrong theme paint for a frame.
 */
(function () {
  var stored = null;
  try { stored = window.localStorage.getItem('theme'); } catch (err) { stored = null; }
  // Dark is the default until the user picks; the design was born dark and the
  // Windows app-mode setting is not a choice they made about this browser.
  var theme = (stored === 'light' || stored === 'dark') ? stored : 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  // The palette is the second half of the same decision, and just as unable to
  // wait a frame: an unstamped root paints the blue-violet aurora first and
  // then swaps. "aurora" IS the unstamped look, so it is deliberately not an
  // attribute value — absent and "aurora" have to mean the same thing, and one
  // spelling of it is cheaper to reason about than two. Anything unrecognised
  // (a stale name, a hand-edited key) falls back the same way.
  var PALETTES = ['ember', 'forest', 'ocean', 'midnight', 'mono'];
  var palette = null;
  try { palette = window.localStorage.getItem('palette'); } catch (err) { palette = null; }
  if (PALETTES.indexOf(palette) !== -1) {
    document.documentElement.setAttribute('data-palette', palette);
  }
})();
