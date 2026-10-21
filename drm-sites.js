'use strict';
/*
 * drm-sites.js -- which pages need protected video (DRM), and what the bar
 * over such a page says. Pure functions and one table; nothing here talks to
 * Electron, the DOM or the network.
 *
 * Reported 2026-10-14: "i tried to watch an amazon prime movie on quartz the other
 * day and i couldnt but then i went to edge and it worked fine". Stock Electron
 * ships no Widevine CDM, so a streaming service's player waits for a licence
 * that can never come and the page just sits there. Quartz must say so, and
 * offer the one thing that works: the same page in Microsoft Edge.
 *
 * Two ways a tab is found to need DRM (drm.js acts on both):
 *
 *   1. BY ADDRESS. siteForUrl() knows the big streaming services. The bar goes
 *      up as soon as the tab is on one, before anything is clicked: their
 *      players cannot work here, and saying so on arrival saves the hunt for
 *      a sign-in or a play button that leads nowhere.
 *
 *   2. BY BEHAVIOUR, for any other site. drm-preload.js reports what the page
 *      itself did: asked for a protected key system and was refused, and
 *      handed a <video> media that is actually encrypted. emeVerdict() wants
 *      BOTH. A refusal on its own is not evidence -- YouTube, Twitch, ad and
 *      fingerprinting scripts all probe for Widevine and then play plain video
 *      perfectly well, and a bar on those would be a false alarm on half the
 *      web. Encrypted media with no key system that could open it is the
 *      thing that cannot play.
 *
 * Loads two ways, like webapps.js:
 *   - require('./drm-sites.js') in main and in the tests (module.exports)
 *   - <script src="drm-sites.js"> in the chrome (window.DrmSites)
 */
(function () {
  /*
   * The services. `hosts` match the host itself or any subdomain of it
   * ('netflix.com' covers www.netflix.com, not netflix.com.example.org).
   * `exact` hosts match only themselves, for services that live on one
   * subdomain of a site that otherwise plays plain video (tv.youtube.com is
   * YouTube TV and needs Widevine; www.youtube.com does not). `amazonVideo`
   * is the one path rule: Prime Video also lives at amazon.<tld>/gp/video,
   * and the rest of Amazon is a shop.
   */
  var SITES = [
    { id: 'prime', name: 'Prime Video', hosts: ['primevideo.com'], amazonVideo: true },
    { id: 'netflix', name: 'Netflix', hosts: ['netflix.com'] },
    { id: 'disney', name: 'Disney+', hosts: ['disneyplus.com'] },
    { id: 'max', name: 'HBO Max', hosts: ['max.com', 'hbomax.com'] },
    { id: 'hulu', name: 'Hulu', hosts: ['hulu.com'] },
    { id: 'appletv', name: 'Apple TV', exact: ['tv.apple.com'] },
    { id: 'applemusic', name: 'Apple Music', exact: ['music.apple.com'] },
    { id: 'peacock', name: 'Peacock', hosts: ['peacocktv.com'] },
    { id: 'paramount', name: 'Paramount+', hosts: ['paramountplus.com'] },
    { id: 'spotify', name: 'Spotify', exact: ['open.spotify.com'] },
    { id: 'youtubetv', name: 'YouTube TV', exact: ['tv.youtube.com'] },
    { id: 'crunchyroll', name: 'Crunchyroll', hosts: ['crunchyroll.com'] }
  ];

  /** amazon.com, amazon.co.uk, amazon.de, amazon.com.au ... with or without www. */
  var AMAZON_HOST = /^(?:www\.|smile\.)?amazon\.(?:[a-z]{2,3}|com?\.[a-z]{2})$/;
  /** Prime Video's pages on an Amazon shop host. */
  var AMAZON_VIDEO_PATH = /^\/(?:gp\/video(?:\/|$)|Prime-Video(?:\/|$)|Amazon-Video(?:\/|$))/i;

  /*
   * Key systems that need a licensed CDM. Clear Key (org.w3.clearkey) is not
   * here: Chromium ships it, it works in Quartz, and a page using it plays.
   */
  var PROTECTED_KEY_SYSTEM = /^(?:com\.widevine\.alpha(?:\..*)?|com\.microsoft\.playready(?:\..*)?|com\.youtube\.playready|com\.chromecast\.playready|com\.apple\.fps(?:\..*)?)$/i;

  /** A key system's family, for the words on the bar. */
  function keySystemFamily(ks) {
    var k = String(ks || '').toLowerCase();
    if (k.indexOf('widevine') !== -1) return 'Widevine';
    if (k.indexOf('playready') !== -1) return 'PlayReady';
    if (k.indexOf('apple.fps') !== -1) return 'FairPlay';
    return '';
  }

  /** The parsed URL, or null for anything that is not an http(s) page. */
  function parseWebUrl(url) {
    if (typeof url !== 'string' || !url || url.length > 8192) return null;
    var u;
    try { u = new URL(url); } catch (err) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u;
  }

  /** Lower-case host, no trailing dot, no 'www.'. '' when there is none. */
  function bareHost(host) {
    var h = String(host || '').toLowerCase().replace(/\.$/, '');
    return h.indexOf('www.') === 0 ? h.slice(4) : h;
  }

  function hostMatches(host, suffix) {
    return host === suffix || (host.length > suffix.length
      && host.slice(-(suffix.length + 1)) === '.' + suffix);
  }

  /**
   * The streaming service a URL belongs to: { id, name }, or null.
   * @param {string} url
   * @param {Array} [extra] more rows in the SITES shape (tests only; main
   *   passes one for a test profile so the e2e can use a local server).
   */
  function siteForUrl(url, extra) {
    var u = parseWebUrl(url);
    if (!u) return null;
    var full = String(u.hostname).toLowerCase().replace(/\.$/, '');
    var host = bareHost(full);
    var rows = Array.isArray(extra) && extra.length ? SITES.concat(extra) : SITES;
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i];
      var j;
      for (j = 0; s.hosts && j < s.hosts.length; j++) {
        if (hostMatches(host, s.hosts[j])) return { id: s.id, name: s.name };
      }
      for (j = 0; s.exact && j < s.exact.length; j++) {
        if (host === s.exact[j] || full === s.exact[j]) return { id: s.id, name: s.name };
      }
      if (s.amazonVideo && AMAZON_HOST.test(full) && AMAZON_VIDEO_PATH.test(u.pathname)) {
        return { id: s.id, name: s.name };
      }
    }
    return null;
  }

  function isProtectedKeySystem(ks) {
    return typeof ks === 'string' && ks.length <= 100 && PROTECTED_KEY_SYSTEM.test(ks);
  }

  /*
   * The key the "always use Edge" rule is stored under. A known service is
   * its id ('prime'), so www.primevideo.com and amazon.com/gp/video are one
   * rule; any other site is its host ('host:example.com').
   */
  function ruleKeyFor(url, extra) {
    var site = siteForUrl(url, extra);
    if (site) return site.id;
    var u = parseWebUrl(url);
    if (!u) return '';
    var host = bareHost(u.hostname);
    return host ? 'host:' + host : '';
  }

  /** What a rule key is called on the bar and in Settings. */
  function ruleKeyName(key, extra) {
    if (typeof key !== 'string') return '';
    if (key.indexOf('host:') === 0) return key.slice(5);
    var rows = Array.isArray(extra) && extra.length ? SITES.concat(extra) : SITES;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === key) return rows[i].name;
    return key;
  }

  /** A stored rule key that this version understands. */
  function isRuleKey(key, extra) {
    if (typeof key !== 'string' || !key || key.length > 260) return false;
    if (key.indexOf('host:') === 0) return /^host:[a-z0-9.-]+(?::\d{1,5})?$/.test(key);
    var rows = Array.isArray(extra) && extra.length ? SITES.concat(extra) : SITES;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === key) return true;
    return false;
  }

  /**
   * The behaviour test (see the header). `seen` is what one tab's current
   * page has reported so far:
   *   { denied: string[]   protected key systems the page asked for and was refused,
   *     granted: string[]  protected key systems it was given (a build WITH Widevine),
   *     encrypted: boolean a <video>/<audio> got encrypted media }
   * Returns { need: boolean, why: string, family: string }.
   */
  function emeVerdict(seen) {
    var s = seen || {};
    var denied = (Array.isArray(s.denied) ? s.denied : []).filter(isProtectedKeySystem);
    var granted = (Array.isArray(s.granted) ? s.granted : []).filter(isProtectedKeySystem);
    if (granted.length) return { need: false, why: 'a protected key system was granted', family: '' };
    if (!denied.length) return { need: false, why: 'no protected key system was refused', family: '' };
    if (!s.encrypted) return { need: false, why: 'refused, but the page played no encrypted media (a probe)', family: '' };
    return { need: true, why: 'encrypted media and every protected key system refused', family: keySystemFamily(denied[0]) };
  }

  /*
   * The words. Calm, plain, the way a big browser's info bar reads: one
   * sentence about what is wrong, the fix is the button. "DRM" is named
   * once and nothing else technical is.
   */
  function barText(name, why) {
    var base = (name || 'This page') + ' uses DRM-protected video, which Quartz can’t play yet';
    var w = typeof why === 'string' ? why.replace(/[.\s]+$/, '') : '';
    return w ? base + ': ' + w + '.' : base + '.';
  }

  /*
   * A build WITH Widevine, and the service still would not play: the key system
   * was granted, but no working licence came. outcome is one of LICENCE_OUTCOMES.
   */
  var LICENCE_OUTCOMES = ['refused', 'no-licence', 'key-error'];
  function isLicenceOutcome(o) { return typeof o === 'string' && LICENCE_OUTCOMES.indexOf(o) !== -1; }
  function refusedText(name, outcome, why) {
    var who = name || 'This site';
    var what = outcome === 'key-error'
      ? who + ' sent a licence this copy of Quartz can’t use'
      : outcome === 'no-licence'
        ? who + ' didn’t send a licence for this video'
        : who + ' refused to license this video to Quartz';
    var w = typeof why === 'string' ? why.replace(/[.\s]+$/, '') : '';
    return what + (w ? ': ' + w : '') + '.';
  }

  function sentText(name) {
    return 'Opened in Microsoft Edge. You chose to always watch ' + (name || 'this site') + ' there.';
  }

  /** Only a plain web page is ever handed to Edge. */
  function edgeUrlOk(url) {
    return !!parseWebUrl(url);
  }

  var API = {
    SITES: SITES,
    siteForUrl: siteForUrl,
    isProtectedKeySystem: isProtectedKeySystem,
    keySystemFamily: keySystemFamily,
    ruleKeyFor: ruleKeyFor,
    ruleKeyName: ruleKeyName,
    isRuleKey: isRuleKey,
    emeVerdict: emeVerdict,
    barText: barText,
    refusedText: refusedText,
    isLicenceOutcome: isLicenceOutcome,
    LICENCE_OUTCOMES: LICENCE_OUTCOMES,
    sentText: sentText,
    edgeUrlOk: edgeUrlOk,
    _bareHost: bareHost
  };

  if (typeof module === 'object' && module && module.exports) module.exports = API;
  if (typeof window !== 'undefined' && window) window.DrmSites = API;
})();
