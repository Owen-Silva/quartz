/* ============================================================
   watch/playerbar/prime.js -- Lumen's play bar on Prime Video.

   Captions and audio: textTracks where the page exposes them, else Prime
   Video's own "Subtitles and audio" menu; quality opens its Settings menu.
   Prime's Skip Intro, Next up and ad timer stay visible.

   Selectors are best guesses at Prime Video's page (not checked against
   the live site); every one that misses only means the service's own
   part stays, never that a control is lost.
   ============================================================ */
(function (root, factory) {
  var a = factory();
  if (typeof module === 'object' && module.exports) module.exports = a;
  else { root.LumenPlayerBarAdapters = root.LumenPlayerBarAdapters || {}; root.LumenPlayerBarAdapters[a.id] = a; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
    "id": "prime",
    "name": "Prime Video",
    "video": [
      ".webPlayerSDKContainer video",
      "#dv-web-player video",
      "video"
    ],
    "hide": [
      ".atvwebplayersdk-bottompanel-container",
      ".atvwebplayersdk-toppanel-container"
    ],
    "keep": [
      "[role=\"dialog\"]",
      "[role=\"alertdialog\"]",
      "[class*=\"skipelement\"]",
      "[class*=\"nextupcard\"]",
      "[class*=\"adtimeindicator\"]",
      "[class*=\"error\"]"
    ],
    "own": {
      "captions": ".atvwebplayersdk-subtitleaudiomenu-button",
      "audio": ".atvwebplayersdk-subtitleaudiomenu-button",
      "quality": ".atvwebplayersdk-options-wrapper button, button[aria-label*=\"settings\" i]",
      "more": ".atvwebplayersdk-options-wrapper button"
    },
    "next": ".atvwebplayersdk-nexttitle-button",
    "labels": {
      "quality": "Quality"
    }
  };
});
