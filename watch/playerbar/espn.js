/* ============================================================
   watch/playerbar/espn.js -- Lumen's play bar on ESPN+.

   Captions: textTracks where exposed, else ESPN+'s own captions button.
   Live events have no duration: the bar says Live and seeks within what
   ESPN+ has buffered.

   Selectors are best guesses at ESPN+'s page (not checked against
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
    "id": "espn",
    "name": "ESPN+",
    "video": [
      "video"
    ],
    "hide": [
      ".controls__footer",
      ".controls__header",
      ".media-controls",
      ".controls-bar"
    ],
    "keep": [
      "[role=\"dialog\"]",
      "[role=\"alertdialog\"]",
      "[class*=\"skip\"]",
      "[class*=\"error\"]",
      "[class*=\"blackout\"]"
    ],
    "own": {
      "captions": "button[aria-label*=\"caption\" i], button[aria-label*=\"subtitles\" i]",
      "audio": "button[aria-label*=\"audio\" i]",
      "more": "button[aria-label*=\"settings\" i]"
    },
    "next": "",
    "labels": {
      "quality": "Quality"
    },
    "none": {
      "quality": "ESPN+ picks the quality itself; its page has no quality menu."
    }
  };
});
