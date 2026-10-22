/* ============================================================
   watch-player-hosts.js -- what belongs inside the Watch player layer.

   Shared by main (watch-player-main.js: the navigation guard) and the
   chrome (watch-player.js: the top bar, the YouTube embed). Plain
   functions over plain strings; no DOM, no Electron.

   The layer hosts ANY page of the service it opened on: a title, a
   show's seasons, a channel, the profile picker, sign-in. A page that
   walks to another site opens in a normal Quartz tab instead. Sign-in
   domains (Google accounts, MyDisney, Amazon sign-in) stay in the
   layer, because signing in is part of watching.

   HUB_NAME is the one place the hub's visible name lives ("Lumen";
   the code and its ids keep "watch"): every string the player shows,
   and every quartz.log line it writes, takes it from here.
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WatchPlayerHosts = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HUB_NAME = 'Lumen';

  /*
   * domains: the service's own sites (any subdomain).
   * paths:   a shared site where only some paths are the service (amazon.com).
   * auth:    sign-in and account hosts that stay in the layer.
   * mark:    the short service mark the bar and the tiles draw.
   * drm:     its player needs Widevine (the castlabs CDM, a signed build).
   */
  var SERVICES = {
    youtube: {
      id: 'youtube', name: 'YouTube', mark: 'YT', drm: false,
      domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
      auth: ['accounts.google.com', 'accounts.youtube.com', 'myaccount.google.com', 'consent.youtube.com', 'consent.google.com']
    },
    disney: {
      id: 'disney', name: 'Disney+', mark: 'D+', drm: true,
      domains: ['disneyplus.com', 'disney-plus.net', 'bamgrid.com'],
      auth: ['registerdisney.go.com', 'mydisney.com']
    },
    hulu: {
      id: 'hulu', name: 'Hulu', mark: 'hulu', drm: true,
      domains: ['hulu.com', 'hulustream.com'],
      auth: ['registerdisney.go.com', 'mydisney.com', 'disneyplus.com']
    },
    prime: {
      id: 'prime', name: 'Prime Video', mark: 'prime', drm: true,
      domains: ['primevideo.com', 'amazonvideo.com'],
      paths: [{ host: 'amazon.com', prefixes: ['/gp/video', '/ap/', '/Amazon-Video', '/video', '/primevideo'] }],
      auth: ['na.account.amazon.com', 'signin.aws.amazon.com']
    },
    espn: {
      id: 'espn', name: 'ESPN', mark: 'ESPN', drm: true,
      domains: ['espn.com', 'espn.go.com', 'espnplus.com', 'espnqa.com'],
      auth: ['registerdisney.go.com', 'mydisney.com', 'disneyplus.com']
    },
    /*
     * Not a service: TMDB's where-to-watch page (the JustWatch data Watch shows). It opens
     * in the layer too, with JustWatch's click-through redirector; a link from it to one
     * of the five services HANDS OVER (watch-player-main.js), so that title opens as the
     * service's own page, routed like any title (the layer, or Edge with the reason).
     */
    tmdb: {
      id: 'tmdb', name: 'TMDB', mark: 'TMDB', drm: false, guide: true,
      domains: ['themoviedb.org', 'click.justwatch.com'],
      auth: []
    }
  };
  var IDS = Object.keys(SERVICES);

  function parse(url) {
    try { var u = new URL(String(url || '')); return u; } catch (err) { return null; }
  }
  function hostIs(host, domain) {
    return host === domain || host.slice(-(domain.length + 1)) === '.' + domain;
  }
  function onList(host, list) {
    for (var i = 0; i < (list || []).length; i++) if (hostIs(host, list[i])) return true;
    return false;
  }
  function pathRule(u, rules) {
    var host = u.hostname.toLowerCase();
    for (var i = 0; i < (rules || []).length; i++) {
      var r = rules[i];
      if (!hostIs(host, r.host)) continue;
      // A prefix is whole path segments: '/video' is amazon.com/video and /video/..., never /videogames
      // (a shopping link counted as Prime Video and stayed in its layer instead of opening as a page, r62-playview).
      for (var j = 0; j < r.prefixes.length; j++) {
        var px = r.prefixes[j], rest = u.pathname.charAt(px.length);
        if (u.pathname.indexOf(px) === 0 && (px.charAt(px.length - 1) === '/' || rest === '' || rest === '/')) return true;
      }
    }
    return false;
  }

  /** 'youtube' | 'disney' | 'hulu' | 'prime' | 'espn' | 'tmdb' (the guide) | '' by address (not counting sign-in hosts). */
  function serviceFor(url) {
    var u = parse(url);
    if (!u || !/^https?:$/.test(u.protocol)) return '';
    var host = u.hostname.toLowerCase();
    if (host === 'tv.youtube.com') return '';
    for (var i = 0; i < IDS.length; i++) {
      var s = SERVICES[IDS[i]];
      if (onList(host, s.domains) || pathRule(u, s.paths)) return s.id;
    }
    return '';
  }

  /** A where-to-watch guide (TMDB), not a streaming service. */
  function isGuide(id) { return !!(SERVICES[id] && SERVICES[id].guide); }
  /** The streaming service a guide page's link goes to ('' when it is no service, or another guide). */
  function handoffFor(id, url) {
    if (!isGuide(id)) return '';
    var to = serviceFor(url);
    return to && !isGuide(to) ? to : '';
  }
  function isAuth(id, url) {
    var s = SERVICES[id];
    var u = parse(url);
    if (!s || !u) return false;
    var host = u.hostname.toLowerCase();
    if (onList(host, s.auth)) return true;
    // Amazon's own sign-in pages live on amazon.com under /ap/.
    return id === 'prime' && hostIs(host, 'amazon.com') && u.pathname.indexOf('/ap/') === 0;
  }

  /**
   * Does a navigation to `url` stay in a layer showing service `id`?
   * extra: { origins: [...], auth: [...] } -- the origin the layer opened on
   * (so a test mirror on 127.0.0.1 counts as the service) and, for a TEST
   * profile only, more sign-in hosts. about:blank and the service's own
   * blob:/data: frames are not navigations main ever asks about.
   */
  function staysIn(id, url, extra) {
    var u = parse(url);
    if (!u) return false;
    if (u.protocol === 'about:') return true;
    if (!/^https?:$/.test(u.protocol)) return false;
    var x = extra || {};
    var origins = x.origins || [];
    for (var i = 0; i < origins.length; i++) if (origins[i] && u.origin === origins[i]) return true;
    if (onList(u.host.toLowerCase(), x.auth) || onList(u.hostname.toLowerCase(), x.auth)) return true;
    if (u.protocol !== 'https:') return false;
    var s = SERVICES[id];
    if (!s) return false;
    var host = u.hostname.toLowerCase();
    return onList(host, s.domains) || pathRule(u, s.paths) || isAuth(id, url);
  }

  /* --- YouTube ---------------------------------------------------------------- */

  /** "90", "90s", "1m30s", "1h2m3s" -> seconds (0 when it is not a time). */
  function seconds(t) {
    var s = String(t || '').trim();
    if (/^\d+$/.test(s)) return Number(s);
    var m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
    if (!m || !s) return 0;
    return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  }

  /**
   * A YouTube address that is ONE video: { id, start } (start in seconds), or null
   * for anything else (a channel, a playlist page, Shorts, the home page).
   */
  function youtubeVideo(url) {
    var u = parse(url);
    if (!u || serviceFor(url) !== 'youtube') return null;
    var host = u.hostname.toLowerCase();
    var id = '';
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else {
      var m = /^\/(?:live|embed)\/([^/?#]+)/.exec(u.pathname);
      if (m) id = m[1];
    }
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
    var start = seconds(u.searchParams.get('t') || u.searchParams.get('start') || '');
    return { id: id, start: start };
  }

  /** The IFrame Player errors that mean "this video may not be embedded": play the watch page instead. */
  var EMBED_REFUSED = [101, 150, 152, 153];

  return {
    HUB_NAME: HUB_NAME,
    SERVICES: SERVICES,
    IDS: IDS,
    serviceFor: serviceFor,
    isAuth: isAuth,
    isGuide: isGuide,
    handoffFor: handoffFor,
    staysIn: staysIn,
    youtubeVideo: youtubeVideo,
    seconds: seconds,
    EMBED_REFUSED: EMBED_REFUSED
  };
});
