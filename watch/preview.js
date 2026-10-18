'use strict';
/*
 * watch/preview.js -- the hover preview's pure half: which video a title can preview, the
 * embed URL, what the embedded player says back, and the Referer main adds for the embed.
 * Nothing here touches the DOM, Electron or the network.
 *
 * The user (10-17): "can we make this preview the video too if you hover over it". Hovering (or
 * keyboard-focusing) the stage, or resting on the stage's tile, plays a MUTED preview over
 * the still after PREVIEW_DELAY_MS; leaving stops it and the iframe is removed (no decode
 * while not hovered). One preview at a time; prefers-reduced-motion = never autoplays.
 *
 * WHERE THE VIDEO COMES FROM (no new paid API, no new sign-in, never a page outside Watch):
 *   - YouTube titles: the video itself (its id is in the item), through YouTube's own
 *     privacy-enhanced embed player (youtube-nocookie.com), muted, no controls. A resume
 *     title starts where the user left off.
 *   - Prime Video / Disney+ (and Hulu) titles: their official trailer on YouTube, found via
 *     TMDB's /videos (watch/tmdb.js trailer()). TMDB is the optional free key the user already
 *     pastes in Settings > Watch for search; without it the stage SAYS so on hover. The
 *     services' own previews are DRM'd and behind their players, so they are not used.
 *   - ESPN games: no preview (a scoreboard, not a still); the hover says so.
 *
 * Loads two ways, like shape.js: require('./watch/preview') in main (watch-main.js, main.js)
 * and the tests, and <script src="watch/preview.js"> in watch.html (window.WatchPreview).
 */
(function () {
  var EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
  var PREVIEW_DELAY_MS = 600;
  /*
   * YouTube's embed refuses to play (error 153, "Video player configuration error") without a
   * Referer that names the app embedding it, and Chromium never sends a file:// page's
   * referrer. YouTube's API client-identity guidance asks WebView-style apps to send their
   * own https identity instead; main.js adds this one, ONLY to embed-frame requests made by
   * Watch's own page (embedReferer below). The user's call if he wants a different identity.
   */
  var EMBED_REFERER = 'https://github.com/Owen-Silva/quartz';
  var YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  /** The YouTube video id of a Watch item, or ''. */
  function youtubeIdOf(item) {
    if (!item || typeof item !== 'object') return '';
    var id = typeof item.id === 'string' ? item.id : '';
    if (id.indexOf('youtube:') === 0 && YT_ID_RE.test(id.slice(8))) return id.slice(8);
    var url = typeof item.url === 'string' ? item.url : '';
    var m = /^https:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{11})(?:[&#]|$)/.exec(url) ||
      /^https:\/\/youtu\.be\/([A-Za-z0-9_-]{11})(?:[?#]|$)/.exec(url);
    return m ? m[1] : '';
  }

  /** Where a resume title left off, in whole seconds, or 0. */
  function resumeAt(item) {
    if (!item || item.kind !== 'resume') return 0;
    var p = typeof item.progress === 'number' && isFinite(item.progress) ? item.progress : 0;
    var d = typeof item.durationSec === 'number' && isFinite(item.durationSec) ? item.durationSec : 0;
    if (p <= 0 || p >= 0.97 || d <= 0) return 0;
    return Math.max(0, Math.floor(p * d) - 2);
  }

  /*
   * What a title can preview:
   *   { type: 'youtube', videoId, start }     play it now
   *   { type: 'trailer', title, tv }          ask main for the TMDB trailer (quartz-watch:preview)
   *   { type: 'none', reason }                nothing to play, and why (the stage shows the reason)
   * opts.hasTmdbKey: Settings > Watch has a TMDB key; opts.event: an ESPN game is on the stage.
   */
  function sourceFor(item, opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    if (o.event) return { type: 'none', reason: 'No preview for games: ESPN streams play only in ESPN’s player' };
    if (!item || typeof item !== 'object') return { type: 'none', reason: 'Nothing to preview' };
    var vid = youtubeIdOf(item);
    if (!vid && Array.isArray(item.also)) {
      for (var i = 0; i < item.also.length && !vid; i++) vid = youtubeIdOf(item.also[i]);
    }
    if (vid) return { type: 'youtube', videoId: vid, start: item.service === 'youtube' ? resumeAt(item) : 0, what: 'video' };
    if (item.kind === 'live' || item.kind === 'upcoming') return { type: 'none', reason: 'No preview for live and upcoming events' };
    var title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!title) return { type: 'none', reason: 'No preview: this title has no name to look a trailer up by' };
    if (!o.hasTmdbKey) return { type: 'none', reason: 'No trailer preview: trailers are looked up on TMDB. Add the free TMDB key in Settings > Watch' };
    var sub = typeof item.subtitle === 'string' ? item.subtitle : '';
    var tv = /\bS\d+\s*:?\s*E\d+\b|\bSeason\b|\bEpisode\b/i.test(sub) || item.mediaType === 'tv';
    return { type: 'trailer', title: title.slice(0, 200), tv: tv };
  }

  /** The muted, chrome-less embed for one video. '' when the id is not a YouTube id. */
  function embedUrl(videoId, start) {
    if (!YT_ID_RE.test(String(videoId || ''))) return '';
    var s = Number.isInteger(start) && start > 0 ? start : 0;
    // loop needs playlist=<same id>; enablejsapi lets the player tell the page "playing" / an error.
    return EMBED_ORIGIN + '/embed/' + videoId + '?autoplay=1&mute=1&controls=0&disablekb=1&fs=0&playsinline=1' +
      '&rel=0&iv_load_policy=3&modestbranding=1&loop=1&playlist=' + videoId + '&enablejsapi=1' + (s ? '&start=' + s : '');
  }

  /*
   * One postMessage from the embedded player -> { playing: true } | { playing: false } |
   * { error: code } | null. The player speaks JSON strings: {"event":"onStateChange","info":1},
   * {"event":"infoDelivery","info":{"playerState":1}}, {"event":"onError","info":150}.
   */
  function readPlayerMessage(data) {
    var d = data;
    if (typeof d === 'string') {
      if (d.length > 20000 || d.charAt(0) !== '{') return null;
      try { d = JSON.parse(d); } catch (e) { return null; }
    }
    if (!d || typeof d !== 'object') return null;
    var ev = d.event;
    if (ev === 'onError') return { error: Number(d.info) || 0 };
    var st = null;
    if (ev === 'onStateChange') st = d.info;
    else if ((ev === 'infoDelivery' || ev === 'initialDelivery') && d.info && typeof d.info === 'object' && 'playerState' in d.info) st = d.info.playerState;
    if (typeof st !== 'number') return null;
    if (st === 1) return { playing: true };
    if (st === 0 || st === 2 || st === -1 || st === 3 || st === 5) return { playing: false, state: st };
    return null;
  }

  /** A player error code in plain words (what the stage says instead of a broken video box). */
  function errorWords(code) {
    switch (Number(code)) {
      case 2: return 'No preview: YouTube refused the video id';
      case 5: return 'No preview: this video can’t play in an embedded player';
      case 100: return 'No preview: the video is private or was removed';
      case 101: case 150: return 'No preview: the owner doesn’t allow this video to play outside YouTube';
      case 152: case 153: return 'No preview: YouTube’s player rejected the embed (error ' + Number(code) + ')';
      default: return 'No preview: YouTube’s player stopped with error ' + (Number(code) || 'unknown');
    }
  }

  /*
   * For main.js's onBeforeSendHeaders: the Referer to add to this request, or ''. Only a
   * youtube-nocookie /embed/ sub-frame, asked for by a file:// page named watch.html (Watch),
   * and only when the request carries no Referer of its own.
   */
  function embedReferer(details) {
    try {
      if (!details || typeof details !== 'object') return '';
      if (details.resourceType && details.resourceType !== 'subFrame') return '';
      var url = String(details.url || '');
      if (url.indexOf(EMBED_ORIGIN + '/embed/') !== 0) return '';
      var h = details.requestHeaders || {};
      for (var k in h) { if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === 'referer' && h[k]) return ''; }
      var page = '';
      var wc = details.webContents;
      if (wc && typeof wc.getURL === 'function') page = String(wc.getURL() || '');
      if (!page && typeof details.frame === 'object' && details.frame && details.frame.top && typeof details.frame.top.url === 'string') page = details.frame.top.url;
      if (!/^file:\/\/\/.*\/watch\.html(?:[?#]|$)/i.test(page)) return '';
      return EMBED_REFERER;
    } catch (e) { return ''; }
  }

  var API = {
    EMBED_ORIGIN: EMBED_ORIGIN,
    EMBED_REFERER: EMBED_REFERER,
    PREVIEW_DELAY_MS: PREVIEW_DELAY_MS,
    youtubeIdOf: youtubeIdOf,
    resumeAt: resumeAt,
    sourceFor: sourceFor,
    embedUrl: embedUrl,
    readPlayerMessage: readPlayerMessage,
    errorWords: errorWords,
    embedReferer: embedReferer
  };

  if (typeof module === 'object' && module && module.exports) module.exports = API;
  if (typeof window !== 'undefined' && window) window.WatchPreview = API;
})();
