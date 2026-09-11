'use strict';

/*
 * theme-boot.js — runs FIRST in <head>, before any stylesheet has painted.
 * It only decides light vs dark and stamps data-theme on <html>; app.js owns
 * every later change. Kept synchronous and tiny on purpose: anything async here
 * would let the wrong theme paint for a frame.
 */
(function () {
  var stored = null;
  try { stored = window.localStorage.getItem('theme'); } catch (err) { stored = null; }
  // Dark is the default until the user picks; the design was born dark and the
  // Windows app-mode setting is not a choice they made about this browser.
  var theme = (stored === 'light' || stored === 'dark') ? stored : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
})();
