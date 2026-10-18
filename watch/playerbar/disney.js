/* ============================================================
   watch/playerbar/disney.js -- Lumen's play bar on Disney+.

   Captions and audio: the video's textTracks / audioTracks when the page
   exposes them (Lumen-drawn), else Disney+'s own "Audio & subtitles" menu,
   opened for that moment and said so. Disney+ picks the quality itself.

   Selectors are best guesses at Disney+'s page (not checked against
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
    "id": "disney",
    "name": "Disney+",
    "video": [
      "video#hivePlayer",
      ".btm-media-client-element video",
      "video"
    ],
    "hide": [
      ".controls__footer",
      ".controls__header",
      ".controls__center",
      ".overlay__controls"
    ],
    "keep": [
      "[role=\"dialog\"]",
      "[role=\"alertdialog\"]",
      "[class*=\"skip\"]",
      "[class*=\"rating\"]",
      "[data-testid*=\"error\"]",
      "[class*=\"still-watching\"]"
    ],
    "own": {
      "captions": ".audio-subtitles-control, button[aria-label*=\"subtitles\" i]",
      "audio": ".audio-subtitles-control, button[aria-label*=\"audio\" i]",
      "more": ".audio-subtitles-control"
    },
    "next": "button[data-testid=\"up-next-play-button\"], button[aria-label*=\"next episode\" i]",
    "labels": {
      "quality": "Quality"
    },
    "none": {
      "quality": "Disney+ picks the quality itself; its page has no quality menu."
    }
  };
});
