'use strict';
/*
 * watch-player-main.js -- main's half of the Watch player layer (watch-player.js).
 *
 * A title clicked in Watch plays INSIDE Watch: the chrome lays a dark layer over
 * the Watch tab and hosts the service's own page in a <webview> there, in
 * Quartz's normal session (so his sign-ins are the same). This file:
 *
 *   - owns the one setting, "Play inside Watch" (default on), in
 *     <userData>/watch-player.json, the way watch-main.js owns Watch's prefs;
 *   - hands a title to the chrome (play()), called by watch-main.js's openTitle
 *     and signIn and by anything else that wants a page in the layer;
 *   - keeps the layer leak-proof once the chrome "adopts" a guest as a player:
 *       a page of the same service (or its sign-in hosts) stays in the layer,
 *         target=_blank and window.open() links included (loaded in place);
 *       a sign-in popup (window.open with features) opens as a SHEET inside the
 *         layer (a WebContentsView over it, window.opener kept), never a window;
 *       a link to another site opens a normal Quartz tab, and says so;
 *       an app link (disneyplus://, intent:, ...) is stopped, and says so;
 *     every way out writes ONE quartz.log line with the reason;
 *   - multiview keys (1-4, F) from inside a tile, the mouse back button and the
 *     media keys (app-command), for the chrome to act on;
 *   - "fresh after watching": when the layer closes, watch-main re-reads the
 *     services that were playing;
 *   - free RAM (the multiview floor), process memory, and whether a player's
 *     webContents still exists (the e2e's "the view was destroyed").
 *
 * Nothing here plays, decodes or touches DRM: the services' own players do, in
 * the licensed castlabs CDM, exactly as in a tab.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Hosts = require('./watch-player-hosts');

const PREFS_FILE = 'watch-player.json';
const FLOOR_GB = 1.5;          // multiview: under this much free RAM a 3rd or 4th tile is refused
const MAX_TILES = 4;

function create(deps) {
  const d = deps || {};
  const ipcMain = d.ipcMain;
  const electronApp = d.app || null;
  const webContentsApi = d.webContents || null;
  const WebContentsView = d.WebContentsView || null;
  const send = typeof d.send === 'function' ? d.send : () => {};
  const getWindow = typeof d.getWindow === 'function' ? d.getWindow : () => null;
  const isChromeSender = typeof d.isChromeSender === 'function' ? d.isChromeSender : () => false;
  const openDecision = typeof d.windowOpenDecision === 'function' ? d.windowOpenDecision : () => ({ action: 'deny' });
  const log = typeof d.log === 'function' ? d.log : (line) => console.log('[watch-player] ' + line);
  const test = d.test && typeof d.test === 'object' ? d.test : {};
  const testAuth = Array.isArray(test.authHosts) ? test.authHosts.map(String) : [];
  const freeGb = typeof d.freeGb === 'function' ? d.freeGb : () => os.freemem() / (1024 ** 3);
  const floorGb = Number.isFinite(test.floorGb) ? test.floorGb : FLOOR_GB;
  let afterWatching = typeof d.afterWatching === 'function' ? d.afterWatching : null;
  let onInside = typeof d.onInsideChanged === 'function' ? d.onInsideChanged : null;

  const players = new Map();   // wcId -> { wcId, contents, service, origins, fullscreen, sheets:Set }
  const sheets = new Map();    // sheet id -> { id, view, contents, opener, rect }
  let sheetSeq = 0;
  let mode = 'single';         // 'single' | 'grid': 1-4 and F are the layer's only in a grid
  let prefs = null;
  let commandWin = null;       // the window whose app-command we listen to

  /* --- the setting ------------------------------------------------------------- */

  function prefsFile() {
    let dir = d.dir || '';
    if (!dir && electronApp && typeof electronApp.getPath === 'function') { try { dir = electronApp.getPath('userData'); } catch { dir = ''; } }
    return dir ? path.join(dir, PREFS_FILE) : '';
  }
  function loadPrefs() {
    if (prefs) return prefs;
    prefs = { inside: true };
    const f = prefsFile();
    if (!f) return prefs;
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (raw && typeof raw.inside === 'boolean') prefs.inside = raw.inside;
    } catch { /* first run, or unreadable: the default */ }
    return prefs;
  }
  function savePrefs() {
    const f = prefsFile();
    if (!f) return;
    try {
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(prefs));
      fs.renameSync(tmp, f);
    } catch (err) { log('Watch player: could not save "Play inside ' + Hosts.HUB_NAME + '": ' + String((err && err.message) || err).slice(0, 120)); }
  }
  function inside() { return loadPrefs().inside; }
  function setInside(on) {
    loadPrefs().inside = !!on;
    savePrefs();
    if (onInside) { try { onInside(prefs.inside); } catch { /* listener gone */ } }
    return prefs.inside;
  }

  /* --- one title into the layer ---------------------------------------------------- */

  function cleanTitle(t) { return typeof t === 'string' ? t.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : ''; }

  /**
   * Ask the chrome to show `url` in the layer. o: { service, title, multi, blocked, mode }.
   * blocked: the DRM reason a multiview tile cannot play (it shows that, never Edge by itself).
   * Returns false when there is no window to show it in.
   */
  function play(o) {
    const x = o || {};
    const url = String(x.url || '');
    if (!/^https?:\/\//i.test(url)) return false;
    const w = getWindow();
    if (!w || w.isDestroyed()) return false;
    send('watch-player:play', {
      url,
      service: Hosts.SERVICES[x.service] ? x.service : (Hosts.serviceFor(url) || ''),
      title: cleanTitle(x.title),
      multi: !!x.multi,
      blocked: typeof x.blocked === 'string' ? x.blocked.slice(0, 200) : '',
    });
    return true;
  }

  /* --- leaving the layer: one log line each ------------------------------------------- */

  function hostOf(url) { try { return new URL(url).host; } catch { return String(url || '').slice(0, 40); } }
  function schemeOf(url) { const m = /^([a-z][a-z0-9+.-]*):/i.exec(String(url || '')); return m ? m[1].toLowerCase() : ''; }
  function exitLine(why, url) { log(Hosts.HUB_NAME + ' player: left the layer (' + why + '): ' + hostOf(url)); }

  function toTab(p, url, why) {
    exitLine(why, url);
    send('open-url', { url, background: false });
    send('watch-player:left', { wcId: p.wcId, url, host: hostOf(url), why });
  }
  function blockApp(p, url) {
    const scheme = schemeOf(url);
    log(Hosts.HUB_NAME + ' player: stopped an app link (' + scheme + ':) from ' + (p.service || 'a player'));
    send('watch-player:blocked', { wcId: p.wcId, scheme, why: 'app link' });
  }

  function extraFor(p) { return { origins: p.origins, auth: testAuth }; }
  function isWeb(url) { return /^https?:/i.test(String(url || '')); }
  function isLocal(url) { return /^(?:about:|blob:|data:|javascript:)/i.test(String(url || '')); }

  /* --- adopting a guest as a player ---------------------------------------------------- */

  function guestOf(wcId) {
    if (!webContentsApi || !Number.isInteger(wcId)) return null;
    let c = null;
    try { c = webContentsApi.fromId(wcId); } catch { c = null; }
    if (!c || c.isDestroyed()) return null;
    const w = getWindow();
    let host = null;
    try { host = c.hostWebContents; } catch { host = null; }
    if (c.getType() !== 'webview' || !w || w.isDestroyed() || host !== w.webContents) return null;
    return c;
  }

  function onNavigate(p, event, url, kind) {
    if (isLocal(url)) return;
    if (!isWeb(url)) { event.preventDefault(); blockApp(p, url); return; }
    if (Hosts.staysIn(p.service, url, extraFor(p))) return;
    event.preventDefault();
    toTab(p, url, kind);
  }

  function openHandler(p) {
    return (details) => {
      const url = String((details && details.url) || '');
      const disp = details && details.disposition;
      const blank = url === '' || /^about:blank/i.test(url);
      if (!blank && !isWeb(url)) { blockApp(p, url); return { action: 'deny' }; }
      const stays = blank || Hosts.staysIn(p.service, url, extraFor(p));
      if (disp === 'new-window' || disp === 'other') {
        // A popup with features: sign-in (Google, MyDisney, Amazon) posts back through
        // window.opener, so it gets a real child -- in a sheet inside the layer.
        if (stays && WebContentsView) return sheetFor(p, url, details);
        if (!stays) { toTab(p, url, 'popup to another site'); return { action: 'deny' }; }
        return openDecision(details);
      }
      if (stays && !blank) {
        // target=_blank / window.open(url) on the same service: this layer, in place.
        setImmediate(() => { try { if (!p.contents.isDestroyed()) p.contents.loadURL(url).catch(() => { /* a stop or a redirect */ }); } catch { /* gone */ } });
        return { action: 'deny' };
      }
      if (blank) return { action: 'deny' };
      toTab(p, url, 'link to another site');
      return { action: 'deny' };
    };
  }

  function wireCommands() {
    const w = getWindow();
    if (!w || w.isDestroyed() || commandWin === w) return;
    commandWin = w;
    // The mouse's back button and the keyboard's media keys reach the window as
    // WM_APPCOMMAND whichever part of it has focus. Only while a player exists.
    w.on('app-command', (_e, cmd) => {
      if (!players.size) return;
      if (cmd === 'browser-backward') send('watch-player:command', { cmd: 'back' });
      else if (/^media-(play-pause|pause|play|stop|nexttrack|previoustrack)$/.test(String(cmd))) send('watch-player:command', { cmd: String(cmd) });
    });
  }

  function adopt(wcId, o) {
    const contents = guestOf(wcId);
    if (!contents) return { ok: false, reason: 'not a player guest of this window' };
    const x = o || {};
    if (players.has(wcId)) {
      const had = players.get(wcId);
      had.service = Hosts.SERVICES[x.service] ? x.service : had.service;
      if (typeof x.origin === 'string' && isWeb(x.origin) && had.origins.indexOf(x.origin) === -1) had.origins.push(x.origin);
      return { ok: true, again: true };
    }
    const p = {
      wcId,
      contents,
      service: Hosts.SERVICES[x.service] ? x.service : '',
      origins: typeof x.origin === 'string' && isWeb(x.origin) ? [x.origin] : [],
      fullscreen: false,
      sheets: new Set(),
    };
    players.set(wcId, p);
    contents.on('will-navigate', (e, url) => onNavigate(p, e, url, 'link to another site'));
    contents.on('will-redirect', (e, url, _inPlace, isMainFrame) => { if (isMainFrame) onNavigate(p, e, url, 'redirect to another site'); });
    contents.setWindowOpenHandler(openHandler(p));
    contents.on('enter-html-full-screen', () => { p.fullscreen = true; });
    contents.on('leave-html-full-screen', () => { p.fullscreen = false; });
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.control || input.alt || input.meta) return;
      const key = String(input.key);
      if (/^Media(PlayPause|Play|Pause|Stop|TrackNext|TrackPrevious)$/.test(key)) {
        event.preventDefault();
        send('watch-player:command', { cmd: 'key-' + key, wcId });
        return;
      }
      if (mode !== 'grid' || input.shift) return;
      if (/^[1-4]$/.test(key) || key === 'f' || key === 'F') {
        event.preventDefault();
        send('watch-player:key', { key: key.toLowerCase(), wcId });
      }
    });
    contents.once('destroyed', () => {
      players.delete(wcId);
      for (const id of Array.from(p.sheets)) closeSheet(id, 'its player closed');
      send('watch-player:gone', { wcId });
    });
    wireCommands();
    return { ok: true };
  }

  /* --- sign-in sheets ------------------------------------------------------------------ */

  function sheetFor(p, url, details) {
    const id = ++sheetSeq;
    return {
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, devTools: false },
      },
      createWindow: (options) => {
        const w = getWindow();
        const view = new WebContentsView({ webPreferences: options.webPreferences, webContents: options.webContents });
        const wc = view.webContents;
        const s = { id, view, contents: wc, opener: p.wcId, rect: null };
        sheets.set(id, s);
        p.sheets.add(id);
        try { view.setBackgroundColor('#ffffff'); } catch { /* older build */ }
        view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        view.setVisible(false);
        if (w && !w.isDestroyed()) w.contentView.addChildView(view);
        // The sheet's own pages: the same rules, and its own popups load in place.
        wc.on('will-navigate', (e, to) => { if (!isLocal(to) && !isWeb(to)) { e.preventDefault(); blockApp(p, to); } });
        wc.setWindowOpenHandler((dd) => {
          const to = String((dd && dd.url) || '');
          if (isWeb(to)) setImmediate(() => { try { if (!wc.isDestroyed()) wc.loadURL(to).catch(() => { /* a stop or a redirect */ }); } catch { /* gone */ } });
          else if (to && !/^about:blank/i.test(to)) blockApp(p, to);
          return { action: 'deny' };
        });
        wc.on('before-input-event', (event, input) => {
          if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); closeSheet(id, 'Esc'); }
        });
        wc.on('page-title-updated', (_e, title) => send('watch-player:sheet', { id, opener: p.wcId, title: cleanTitle(title), host: hostOf(safeUrl(wc)) }));
        wc.on('did-navigate', (_e, to) => send('watch-player:sheet', { id, opener: p.wcId, host: hostOf(to) }));
        wc.once('destroyed', () => {
          sheets.delete(id);
          p.sheets.delete(id);
          const ww = getWindow();
          try { if (ww && !ww.isDestroyed()) ww.contentView.removeChildView(view); } catch { /* window gone */ }
          send('watch-player:sheet-gone', { id, opener: p.wcId });
        });
        log(Hosts.HUB_NAME + ' player: a sign-in popup opened as a sheet in the layer: ' + hostOf(url || (details && details.url)));
        send('watch-player:sheet', { id, opener: p.wcId, url: String(url || ''), host: hostOf(url), fresh: true });
        return wc;
      },
    };
  }
  function safeUrl(wc) { try { return wc.getURL(); } catch { return ''; } }

  function placeSheet(id, rect) {
    const s = sheets.get(id);
    if (!s) return false;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) { s.view.setVisible(false); s.rect = null; return true; }
    const r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    s.view.setBounds(r);
    s.view.setVisible(true);
    s.rect = r;
    return true;
  }
  function closeSheet(id, why) {
    const s = sheets.get(id);
    if (!s) return false;
    // close() without waitForBeforeUnload: a page cannot refuse it.
    try { if (!s.contents.isDestroyed()) s.contents.close(); } catch { /* gone */ }
    if (why) log(Hosts.HUB_NAME + ' player: closed a sign-in sheet (' + why + ')');
    return true;
  }

  /* --- memory -------------------------------------------------------------------------- */

  function memory() {
    let total = 0;
    const byPid = {};
    try {
      for (const m of electronApp.getAppMetrics()) {
        const kb = (m.memory && m.memory.workingSetSize) || 0;
        total += kb;
        byPid[m.pid] = { type: m.type, mb: Math.round(kb / 1024) };
      }
    } catch { /* no metrics */ }
    const playersOut = [];
    for (const p of players.values()) {
      let pid = 0;
      try { pid = p.contents.getOSProcessId(); } catch { pid = 0; }
      playersOut.push({ wcId: p.wcId, pid, mb: byPid[pid] ? byPid[pid].mb : 0 });
    }
    return { totalMb: Math.round(total / 1024), processes: Object.keys(byPid).length, players: playersOut, freeGb: Math.round(freeGb() * 100) / 100 };
  }

  /* --- IPC ----------------------------------------------------------------------------- */

  function registerIpc() {
    if (!ipcMain) return;
    const on = (ch, fn) => ipcMain.handle(ch, (event, payload) => {
      if (!isChromeSender(event)) throw new Error('not the chrome');
      return fn(payload && typeof payload === 'object' ? payload : {});
    });
    on('watch-player:get', () => ({ inside: inside(), name: Hosts.HUB_NAME, floorGb, maxTiles: MAX_TILES }));
    on('watch-player:set-inside', (p) => ({ inside: setInside(p.on === true) }));
    on('watch-player:adopt', (p) => adopt(Number(p.wcId), p));
    on('watch-player:mode', (p) => { mode = p.mode === 'grid' ? 'grid' : 'single'; return { mode }; });
    on('watch-player:free', () => ({ freeGb: Math.round(freeGb() * 100) / 100, floorGb }));
    on('watch-player:alive', (p) => ({ alive: !!(webContentsApi && Number.isInteger(p.wcId) && (() => { try { const c = webContentsApi.fromId(p.wcId); return !!c && !c.isDestroyed(); } catch { return false; } })()) }));
    on('watch-player:memory', () => memory());
    on('watch-player:escape', (p) => {
      // The chrome's own ways out (its "Open in a tab" and "Open in Edge" buttons): logged here.
      exitLine(String(p.why || 'button').slice(0, 60), String(p.url || ''));
      return { ok: true };
    });
    on('watch-player:closed', (p) => {
      // Fresh after watching: re-read the services that were in the layer.
      const ids = Array.isArray(p.services) ? p.services.filter((id) => typeof id === 'string').slice(0, MAX_TILES) : [];
      const asked = [];
      for (const id of new Set(ids)) {
        if (!afterWatching) break;
        try { if (afterWatching(id) !== false) asked.push(id); } catch (err) { log(Hosts.HUB_NAME + ' player: re-read of ' + id + ' failed to start: ' + String((err && err.message) || err).slice(0, 120)); }
      }
      return { asked };
    });
    on('watch-player:sheet-rect', (p) => ({ ok: placeSheet(Number(p.id), p.rect) }));
    on('watch-player:sheet-close', (p) => ({ ok: closeSheet(Number(p.id), String(p.why || 'Close').slice(0, 40)) }));
  }

  return {
    registerIpc,
    play,
    inside,
    setInside,
    setAfterWatching: (fn) => { afterWatching = typeof fn === 'function' ? fn : null; },
    setOnInside: (fn) => { onInside = typeof fn === 'function' ? fn : null; },
    isPlayer: (wcId) => players.has(wcId),
    state: () => ({ players: players.size, sheets: sheets.size, mode, inside: inside() }),
  };
}

module.exports = { create, PREFS_FILE, FLOOR_GB, MAX_TILES };
