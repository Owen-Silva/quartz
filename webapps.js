'use strict';
/*
 * webapps.js — the catalogue of sites the browser treats as APPS.
 *
 * A web app is a plain site the dock, the palette and the tab strip may
 * present the way they present an installed program: one row, one icon, one
 * click that opens it. Nothing here launches anything and nothing here talks
 * to Electron — it is a lookup table plus the small joins the chrome needs:
 *
 *   id     'web:<slug>', stable forever: it is what Settings pins store.
 *   name   what a row shows.
 *   url    the page to open, a full https URL (the app's own entry point,
 *          so Gmail lands in the mailbox and Slack in the client).
 *   host   the bare host (no 'www.'), which is how a LIVE TAB is joined back
 *          to its catalogue row — see webAppForHost().
 *   exe    the desktop program this site is the web form OF, as a
 *          lower-case exe basename WITHOUT the extension ('spotify'), or
 *          null when there is no desktop twin worth joining. apps.js keeps
 *          its own entries' `exe` WITH the extension (exeBaseName() returns
 *          'spotify.exe'), so webAppForExe() accepts either spelling and the
 *          chrome can hand it an apps.js entry's field unchanged.
 *   drm    true when playback needs Widevine, which this build does not
 *          have. The tab still opens; the chrome shows DRM_NOTE and points
 *          at the desktop app.
 *
 * Loads two ways, and must keep doing both:
 *   - `require('./webapps.js')` in the chrome / in node (module.exports)
 *   - `<script src="webapps.js">` in newtab.html, which then reads
 *     `window.WEBAPPS` (the array) or `window.WebApps` (the whole API).
 *
 * Treat the array as read-only: copy before sorting or filtering in place.
 */
(function () {
  /** Every id in here starts with this, and no installed-app id ever does. */
  var WEB_ID_PREFIX = 'web:';
  /** A terminal tab's id: 'term:powershell'. Not a web app; see below. */
  var TERM_ID_PREFIX = 'term:';

  /** Shown on a tab whose site needs Widevine. */
  var DRM_NOTE = 'Protected playback needs the Widevine build; playing through the desktop app';

  var WEBAPPS = [
    { id: 'web:discord', name: 'Discord', url: 'https://discord.com/app', host: 'discord.com', exe: 'discord', drm: false },
    { id: 'web:whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com', host: 'web.whatsapp.com', exe: 'whatsapp', drm: false },
    { id: 'web:telegram', name: 'Telegram', url: 'https://web.telegram.org/a/', host: 'web.telegram.org', exe: 'telegram', drm: false },
    { id: 'web:slack', name: 'Slack', url: 'https://app.slack.com/client', host: 'app.slack.com', exe: 'slack', drm: false },
    { id: 'web:notion', name: 'Notion', url: 'https://www.notion.so', host: 'notion.so', exe: 'notion', drm: false },
    { id: 'web:gmail', name: 'Gmail', url: 'https://mail.google.com/mail/u/0/', host: 'mail.google.com', exe: null, drm: false },
    { id: 'web:google-calendar', name: 'Google Calendar', url: 'https://calendar.google.com', host: 'calendar.google.com', exe: null, drm: false },
    { id: 'web:google-drive', name: 'Google Drive', url: 'https://drive.google.com', host: 'drive.google.com', exe: null, drm: false },
    { id: 'web:google-docs', name: 'Google Docs', url: 'https://docs.google.com', host: 'docs.google.com', exe: null, drm: false },
    { id: 'web:youtube', name: 'YouTube', url: 'https://www.youtube.com', host: 'youtube.com', exe: null, drm: false },
    { id: 'web:youtube-music', name: 'YouTube Music', url: 'https://music.youtube.com', host: 'music.youtube.com', exe: null, drm: false },
    { id: 'web:twitch', name: 'Twitch', url: 'https://www.twitch.tv', host: 'twitch.tv', exe: null, drm: false },
    { id: 'web:reddit', name: 'Reddit', url: 'https://www.reddit.com', host: 'reddit.com', exe: null, drm: false },
    { id: 'web:x', name: 'X', url: 'https://x.com', host: 'x.com', exe: null, drm: false },
    { id: 'web:github', name: 'GitHub', url: 'https://github.com', host: 'github.com', exe: null, drm: false },
    { id: 'web:chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com', host: 'chatgpt.com', exe: null, drm: false },
    { id: 'web:claude', name: 'Claude', url: 'https://claude.ai', host: 'claude.ai', exe: null, drm: false },
    { id: 'web:vscode', name: 'VS Code', url: 'https://vscode.dev', host: 'vscode.dev', exe: 'code', drm: false },
    { id: 'web:figma', name: 'Figma', url: 'https://www.figma.com', host: 'figma.com', exe: null, drm: false },
    { id: 'web:canva', name: 'Canva', url: 'https://www.canva.com', host: 'canva.com', exe: null, drm: false },
    { id: 'web:microsoft-365', name: 'Microsoft 365', url: 'https://m365.cloud.microsoft', host: 'm365.cloud.microsoft', exe: null, drm: false },
    { id: 'web:outlook', name: 'Outlook', url: 'https://outlook.live.com/mail/0/', host: 'outlook.live.com', exe: null, drm: false },
    { id: 'web:teams', name: 'Teams', url: 'https://teams.live.com/v2/', host: 'teams.live.com', exe: null, drm: false },
    { id: 'web:steam', name: 'Steam', url: 'https://store.steampowered.com', host: 'store.steampowered.com', exe: 'steam', drm: false },
    { id: 'web:roblox', name: 'Roblox', url: 'https://www.roblox.com', host: 'roblox.com', exe: null, drm: false },
    /* The five below need Widevine. Kept in the catalogue on purpose: the row
       is how the chrome offers the desktop app instead. */
    { id: 'web:spotify', name: 'Spotify', url: 'https://open.spotify.com', host: 'open.spotify.com', exe: 'spotify', drm: true },
    { id: 'web:netflix', name: 'Netflix', url: 'https://www.netflix.com', host: 'netflix.com', exe: null, drm: true },
    { id: 'web:disney-plus', name: 'Disney+', url: 'https://www.disneyplus.com', host: 'disneyplus.com', exe: null, drm: true },
    { id: 'web:apple-music', name: 'Apple Music', url: 'https://music.apple.com', host: 'music.apple.com', exe: null, drm: true },
    { id: 'web:prime-video', name: 'Prime Video', url: 'https://www.primevideo.com', host: 'primevideo.com', exe: null, drm: true }
  ];

  /** A catalogue row by its id, or null. Ids are matched exactly. */
  function findWebApp(id) {
    var key = typeof id === 'string' ? id.trim() : '';
    if (!key) return null;
    for (var i = 0; i < WEBAPPS.length; i++) {
      if (WEBAPPS[i].id === key) return WEBAPPS[i];
    }
    return null;
  }

  /**
   * A host, as the catalogue spells one: lower-cased, no port, no path, no
   * trailing dot, no leading 'www.'. '' when there is nothing usable.
   */
  function bareHost(host) {
    var h = typeof host === 'string' ? host.trim().toLowerCase() : '';
    if (!h) return '';
    var scheme = h.indexOf('://');
    if (scheme >= 0) h = h.slice(scheme + 3);
    var slash = h.indexOf('/');
    if (slash >= 0) h = h.slice(0, slash);
    var at = h.indexOf('@');
    if (at >= 0) h = h.slice(at + 1);
    var colon = h.indexOf(':');
    if (colon >= 0) h = h.slice(0, colon);
    while (h.length && h.charAt(h.length - 1) === '.') h = h.slice(0, -1);
    if (h.indexOf('www.') === 0) h = h.slice(4);
    return h;
  }

  /**
   * The catalogue row a live host belongs to, or null.
   *
   * An exact host wins; failing that, a SUBDOMAIN of a catalogue host does
   * ('cdn.discord.com' is Discord), and the longest matching host wins so
   * 'foo.music.youtube.com' is YouTube Music rather than YouTube.
   */
  function webAppForHost(host) {
    var h = bareHost(host);
    if (!h) return null;
    var best = null;
    for (var i = 0; i < WEBAPPS.length; i++) {
      var app = WEBAPPS[i];
      var want = app.host;
      if (h === want) return app;
      var tail = '.' + want;
      if (h.length > tail.length && h.slice(-tail.length) === tail) {
        if (!best || want.length > best.host.length) best = app;
      }
    }
    return best;
  }

  /**
   * The catalogue row that is the web form of an installed program, or null.
   * Takes either spelling of an exe basename, so an apps.js entry's `exe`
   * ('Spotify.exe') can be handed straight in.
   */
  function webAppForExe(exe) {
    var raw = typeof exe === 'string' ? exe.trim().toLowerCase() : '';
    if (!raw) return null;
    var slash = Math.max(raw.lastIndexOf('\\'), raw.lastIndexOf('/'));
    if (slash >= 0) raw = raw.slice(slash + 1);
    if (raw.length > 4 && raw.slice(-4) === '.exe') raw = raw.slice(0, -4);
    if (!raw) return null;
    for (var i = 0; i < WEBAPPS.length; i++) {
      if (WEBAPPS[i].exe && WEBAPPS[i].exe === raw) return WEBAPPS[i];
    }
    return null;
  }

  /** True for a 'web:<slug>' id, whether or not the slug is in the catalogue. */
  function isWebAppId(id) {
    var key = typeof id === 'string' ? id.trim() : '';
    return key.length > WEB_ID_PREFIX.length && key.indexOf(WEB_ID_PREFIX) === 0;
  }

  /** True for a 'term:<program>' id — the prefix alone is not one. */
  function isTerminalId(id) {
    return terminalProgram(id) !== null;
  }

  /** The program a terminal id names ('term:pwsh' -> 'pwsh'), or null. */
  function terminalProgram(id) {
    var key = typeof id === 'string' ? id.trim() : '';
    if (key.indexOf(TERM_ID_PREFIX) !== 0) return null;
    var program = key.slice(TERM_ID_PREFIX.length).trim();
    return program ? program : null;
  }

  var API = {
    WEBAPPS: WEBAPPS,
    DRM_NOTE: DRM_NOTE,
    WEB_ID_PREFIX: WEB_ID_PREFIX,
    TERM_ID_PREFIX: TERM_ID_PREFIX,
    findWebApp: findWebApp,
    webAppForHost: webAppForHost,
    webAppForExe: webAppForExe,
    isWebAppId: isWebAppId,
    isTerminalId: isTerminalId,
    terminalProgram: terminalProgram,
    // test seam
    _bareHost: bareHost
  };

  if (typeof module === 'object' && module && module.exports) module.exports = API;
  if (typeof window !== 'undefined' && window) {
    window.WEBAPPS = WEBAPPS;
    window.WebApps = API;
  }
})();
