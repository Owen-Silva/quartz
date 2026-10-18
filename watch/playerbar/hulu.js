/* ============================================================
   watch/playerbar/hulu.js -- Lumen's play bar on Hulu.

   Hulu's page shares no track list: captions, audio and quality open
   Hulu's own settings menu, for that moment, and Lumen's bar says so.

   Selectors are best guesses at Hulu's page (not checked against
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
    "id": "hulu",
    "name": "Hulu",
    "video": [
      "video.video-player",
      "#content-video-player video",
      "video"
    ],
    "hide": [
      ".ControlsContainer",
      ".PlayerControls",
      ".controls__bar"
    ],
    "keep": [
      "[role=\"dialog\"]",
      "[role=\"alertdialog\"]",
      "[class*=\"Skip\"]",
      "[class*=\"skip\"]",
      "[class*=\"AdUnit\"]",
      "[class*=\"ad-countdown\"]",
      "[class*=\"Error\"]",
      "[class*=\"StillWatching\"]"
    ],
    "own": {
      "captions": ".SettingsButton, button[aria-label*=\"settings\" i]",
      "audio": ".SettingsButton, button[aria-label*=\"settings\" i]",
      "quality": ".SettingsButton, button[aria-label*=\"settings\" i]",
      "more": ".SettingsButton"
    },
    "next": ".EndCardButton, button[aria-label*=\"next episode\" i]",
    "labels": {
      "quality": "Quality"
    }
  };
});
