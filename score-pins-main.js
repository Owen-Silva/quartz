'use strict';
/*
 * score-pins-main.js -- the MAIN-process half of Lumen's pinned scores: small always-on-top
 * cards on the user's desktop, one per pinned game, that stay above other windows when Quartz
 * is not focused.
 *
 *   watch/scores.js          the feeds read into one shape, the event diff, the poll cadence (pure)
 *   score-pins-main.js       this file: the card windows, the polling, the saved pins, the IPC
 *   score-pin.html/.js/.css  one card (its own small preload, score-pin-preload.js, is its only bridge)
 *   watch/pinbutton.js       the "Pin score" control on Lumen's game cards (console lines, like watch.js)
 *   scorepins-chrome.js      the palette's pin rows and the theme hand-off, in the chrome
 *
 * HOW A PIN LIVES. Pinning (Lumen's game card, or the palette) opens a frameless card window:
 * focusable: false and shown with showInactive(), so it never takes focus when it appears or
 * updates; alwaysOnTop; no taskbar button. Cards stack in the bottom-right corner of the
 * primary display's work area, newest at the bottom; one the user drags keeps its own place.
 * Pins and places are saved in <userData>/score-pins.json, so they come back after a
 * restart (a pin for a game that started over 16 h ago is dropped then) and do not care
 * whether a Lumen tab is open. When Quartz's main window closes, the cards close with it and
 * stay saved; closing a card is the only way to drop a pin.
 *
 * WHEN IT POLLS. Nothing at all runs with nothing pinned: no timer, no window, no listener.
 * One timer per pin, re-armed after each read from watch/scores.js nextPollMs(): live 15 s,
 * a power play 10 s, an intermission or half 60 s, pre-game at most every 5 min until the
 * start, failures back off 30 / 60 / 120 s, and Final stops it (the card says Final until
 * closed). The PC sleeping clears the timers; waking reads every pin again. Every read is a
 * plain fetch() from main: no cookies (credentials 'omit'), no account, nothing written.
 *
 * NO SILENT FAILURES. A read that fails puts the card in its paused state with the reason
 * and the retry time, e.g. "Scores paused: ESPN didn't answer (timed out after 10 s),
 * retrying in 30 s", plus when it last updated. An NHL feed failure with ESPN still
 * answering says the penalties are paused and the score is ESPN's. Each one is logged.
 *
 * SOUND. The card synthesises its own sounds (Web Audio; no samples). Main decides only the
 * settings: a global on/off (default on) and a per-card mute, both saved. TEST PROFILES ARE
 * SILENT: every card's webContents is created muted (setAudioMuted) and the page is told
 * to run its sound graph at zero gain; the e2e counts the sounds that WOULD have played.
 *
 * TESTS: create({ test }) gets { rebase, offscreen, pollScale, openStub } ONLY from a
 * --test-profile run (QUARTZ_SCORES_* env, main.js). In a test the cards live off every
 * monitor (-20000,-20000), so testwatch.js would fail the run if one ever touched the screen.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const Scores = require('./watch/scores');

const PREFS_FILE = 'score-pins.json';
const LINE_PREFIX = 'quartz-scores:';
const CARD_W = 300;
const CARD_H = 96;               // until the card reports its own height
const MARGIN = 16;               // from the work area's edge
const GAP = 8;                   // between stacked cards
const MAX_PINS = 6;
const FETCH_BUDGET_MS = 10000;
const MAX_BODY = 3 * 1024 * 1024;
const RESTORE_MAX_AGE_MS = 16 * 3600 * 1000;
const OFFSCREEN_AREA = { x: -20000, y: -20000, width: 1920, height: 1040 };
const PAGE = path.join(__dirname, 'score-pin.html');
const LUMEN_PAGE = pathToFileURL(path.join(__dirname, 'watch.html')).href;

/* The card's surface is SOLID on every Windows, never Electron's 'acrylic' material. A system backdrop
 * needs the native non-client frame: on a frame:false window backgroundMaterial renders solid black
 * (measured for Quartz's own window, see the note in main.js createWindow), so a frameless acrylic
 * card would be its tint over black, a muddy grey in the light theme. The card has to be frameless
 * (no caption, no resize border), so it paints its own neutral surface, and what the e2e captures
 * is exactly what the user sees. */
const ACRYLIC = false;

/** A fetch failure -> plain words. */
function reasonOf(err) {
  const t = String((err && (err.name + ' ' + (err.cause && err.cause.code) + ' ' + err.message)) || err || '');
  if (/TimeoutError|aborted due to timeout/i.test(t)) return 'timed out after ' + Math.round(FETCH_BUDGET_MS / 1000) + ' s';
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ERR_INTERNET_DISCONNECTED/i.test(t)) return "couldn't reach it; you may be offline";
  if (/ECONNREFUSED|ECONNRESET|socket|other side closed/i.test(t)) return 'the connection dropped';
  return 'the request failed';
}

function cleanLook(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const hue = Number(r.hue);
  return {
    theme: r.theme === 'light' ? 'light' : 'dark',
    hue: Number.isFinite(hue) && hue >= 0 && hue <= 360 ? Math.round(hue) : null,
    palette: typeof r.palette === 'string' && /^[a-z]{1,16}$/.test(r.palette) ? r.palette : '',
  };
}

function create(d) {
  const { app, ipcMain, BrowserWindow, screen } = d;
  const test = d.test || {};
  const log = typeof d.log === 'function' ? d.log : () => {};
  const now = typeof test.now === 'function' ? test.now : () => Date.now();
  const scale = Number.isFinite(test.pollScale) && test.pollScale > 0 ? test.pollScale : 1;
  const acrylic = ACRYLIC && !test.offscreen;

  const pins = new Map();          // key -> pin record (order = pin order)
  const byContents = new Map();    // card webContents id -> key
  const lumenPages = new Set();    // Lumen page webContents that asked for the pinned keys
  let prefs = { v: 1, sound: true, pins: [] };
  let look = cleanLook(null);
  let saveTimer = null;
  let powerHooked = false;
  let mainWinHooked = null;
  let stopped = false;

  /* --- prefs --------------------------------------------------------------------------------- */

  function prefsPath() {
    try { return path.join(app.getPath('userData'), PREFS_FILE); } catch { return ''; }
  }
  function loadPrefs() {
    const f = prefsPath();
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      prefs = { v: 1, sound: j.sound !== false, pins: Array.isArray(j.pins) ? j.pins.slice(0, MAX_PINS) : [] };
    } catch { prefs = { v: 1, sound: true, pins: [] }; }
  }
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(saveNow, 400);
  }
  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const f = prefsPath();
    if (!f) return;
    const out = { v: 1, sound: prefs.sound, pins: Array.from(pins.values()).map((p) => Object.assign({}, p.pin, { muted: p.muted, pos: p.pos })) };
    try {
      fs.writeFileSync(f + '.tmp', JSON.stringify(out, null, 1));
      fs.renameSync(f + '.tmp', f);
    } catch (err) { log('Score pins could not be saved: ' + ((err && err.message) || 'error')); }
  }

  /* --- placing the cards ----------------------------------------------------------------------- */

  function workArea() {
    if (test.offscreen) return OFFSCREEN_AREA;
    try { return screen.getPrimaryDisplay().workArea; } catch { return { x: 0, y: 0, width: 1280, height: 720 }; }
  }
  /** A saved place that is still on some display (or, in a test, in the off-screen area). */
  function placeOk(pos, h) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return false;
    const areas = test.offscreen ? [OFFSCREEN_AREA] : (() => { try { return screen.getAllDisplays().map((x) => x.workArea); } catch { return []; } })();
    return areas.some((a) => pos.x + 40 > a.x && pos.x + CARD_W - 40 < a.x + a.width && pos.y >= a.y - 4 && pos.y + Math.min(h, 40) <= a.y + a.height);
  }
  /** Every card where it belongs: the stacked ones bottom-up from the corner, newest lowest. */
  function layout() {
    const a = workArea();
    let bottom = a.y + a.height - MARGIN;
    const list = Array.from(pins.values()).reverse();
    for (const p of list) {
      if (!p.win || p.win.isDestroyed()) continue;
      let x, y;
      if (p.pos && placeOk(p.pos, p.height)) { x = p.pos.x; y = p.pos.y; } else {
        x = a.x + a.width - MARGIN - CARD_W;
        y = bottom - p.height;
        bottom = y - GAP;
      }
      const b = p.win.getBounds();
      if (b.x !== x || b.y !== y || b.height !== p.height || b.width !== CARD_W) p.win.setBounds({ x: Math.round(x), y: Math.round(y), width: CARD_W, height: p.height });
    }
  }

  /* --- the windows ----------------------------------------------------------------------------- */

  function pageUrl(p) {
    const u = pathToFileURL(PAGE);
    u.searchParams.set('key', p.pin.key);
    u.searchParams.set('theme', look.theme);
    if (look.hue !== null) u.searchParams.set('hue', String(look.hue));
    if (look.palette) u.searchParams.set('palette', look.palette);
    u.searchParams.set('material', acrylic ? 'acrylic' : 'solid');
    if (test.silent) u.searchParams.set('silent', '1');
    return u.href;
  }

  function openWindow(p) {
    const a = workArea();
    const win = new BrowserWindow({
      width: CARD_W, height: p.height,
      x: a.x + a.width - MARGIN - CARD_W, y: a.y + a.height - MARGIN - p.height,
      show: false, frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, focusable: false,
      // thickFrame:false, MEASURED (lane lumen-scores2, 1920x1080 @125%, Electron's frameless window):
      // with the thick frame a 300x120 request gave a 315x128 page and getBounds() 302x121 (the
      // invisible resize border landed INSIDE the page, a band of window colour under the card, and
      // the corner and stack were 2-3 px off); resizable:true and useContentSize made no difference.
      // Without it the page and the bounds are exactly 300x120. The cost is the DWM shadow and
      // rounded corners: the card's own hairline edge outlines it.
      thickFrame: false,
      title: 'Score · ' + p.pin.title,
      backgroundColor: acrylic ? '#00000000' : (look.theme === 'light' ? '#f4f4f5' : '#202123'),
      backgroundMaterial: acrylic ? 'acrylic' : undefined,
      webPreferences: {
        preload: path.join(__dirname, 'score-pin-preload.js'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false,
        partition: 'scorepins',          // in memory: no cookies, nothing on disk
        autoplayPolicy: 'no-user-gesture-required',
        devTools: !!test.offscreen,
      },
    });
    p.win = win;
    p.ready = false;
    const wc = win.webContents;
    // TEST PROFILES ARE SILENT: muted before the page exists, so nothing can ever reach the speakers.
    if (test.silent) wc.setAudioMuted(true);
    byContents.set(wc.id, p.pin.key);
    win.setAlwaysOnTop(true, 'floating');
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      layout();
      win.showInactive();          // never takes focus, on first show or ever
    });
    wc.on('render-process-gone', (_e, det) => {
      log('Score card ' + p.pin.key + ' crashed (' + ((det && det.reason) || 'unknown') + '); reopening');
      if (!pins.has(p.pin.key) || stopped) return;
      setTimeout(() => { if (pins.get(p.pin.key) === p && p.win === win && !win.isDestroyed()) { win.destroy(); } }, 0);
    });
    win.on('closed', () => {
      byContents.delete(wc.id);
      if (p.win === win) p.win = null;
      // A card that died on its own (not closed by the user, not Quartz closing) comes back once.
      if (pins.get(p.pin.key) === p && !stopped && !p.closing && !p.reopened) { p.reopened = true; openWindow(p); }
    });
    win.loadURL(pageUrl(p)).catch((err) => log('Score card ' + p.pin.key + " didn't load: " + ((err && err.message) || 'error')));
    hookMainWindow();
  }

  function push(p, extra) {
    if (!p.win || p.win.isDestroyed() || !p.ready) return;
    const payload = Object.assign({
      key: p.pin.key, pin: p.pin, reading: p.reading, health: p.health, muted: p.muted, sound: prefs.sound,
      lastOkAt: p.lastOkAt, nextAt: p.nextAt, look, events: [],
    }, extra || {});
    try { p.win.webContents.send('scorepin:state', payload); } catch { /* closing */ }
  }

  /* --- polling ----------------------------------------------------------------------------------- */

  function rebase(url) {
    for (const pair of Array.isArray(test.rebase) ? test.rebase : []) {
      if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string' && url.indexOf(pair[0]) === 0) return pair[1] + url.slice(pair[0].length);
    }
    return url;
  }

  async function getJson(url) {
    let res;
    try {
      res = await fetch(rebase(url), { credentials: 'omit', cache: 'no-store', redirect: 'follow', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_BUDGET_MS) });
    } catch (err) { return { ok: false, reason: reasonOf(err) }; }
    if (!res.ok) return { ok: false, reason: 'HTTP ' + res.status };
    let text = '';
    try { text = await res.text(); } catch (err) { return { ok: false, reason: reasonOf(err) }; }
    if (text.length > MAX_BODY) return { ok: false, reason: 'it sent far more than a game' };
    try { return { ok: true, json: JSON.parse(text) }; } catch { return { ok: false, reason: "it sent something that isn't JSON" }; }
  }

  function arm(p, ms) {
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    p.nextAt = 0;
    if (ms === null || stopped || !pins.has(p.pin.key)) return;
    const wait = Math.max(scale < 1 ? 20 : 1000, Math.round(ms * scale));   // a scaled test may poll fast; live never under 1 s
    p.nextAt = now() + wait;
    p.timer = setTimeout(() => { p.timer = null; poll(p); }, wait);
  }

  async function readNhl(p, t0) {
    if (!p.pin.nhlId && t0 - p.nhlTriedAt > 60000) {
      p.nhlTriedAt = t0;
      const s = await getJson(Scores.nhlScoreUrl(Scores.nhlDay(p.pin.startsAt || t0)));
      if (!s.ok) return { reason: s.reason };
      const id = Scores.matchNhlGame(s.json, p.pin);
      if (!id) return { reason: 'its schedule has no ' + p.pin.away.abbr + ' at ' + p.pin.home.abbr + ' that day' };
      p.pin.nhlId = id;
      saveSoon();
    }
    if (!p.pin.nhlId) return { reason: p.nhlReason || 'no NHL game id yet' };
    const res = await getJson(Scores.nhlLandingUrl(p.pin.nhlId));
    if (!res.ok) return { reason: res.reason };
    const r = Scores.parseNhl(res.json, p.pin);
    return r.error ? { reason: r.error } : { reading: r };
  }

  async function poll(p) {
    if (p.busy || stopped || !pins.has(p.pin.key)) return;
    p.busy = true;
    p.polls++;
    const t0 = now();
    let reading = null;
    let health = { ok: true, text: '' };
    let feed = 'ESPN';
    let reason = '';
    try {
      if (p.pin.league === 'nhl') {
        const n = await readNhl(p, t0);
        if (n.reading) reading = n.reading;
        else {
          p.nhlReason = n.reason;
          const e = await getJson(Scores.espnEventUrl(p.pin.league, p.pin.espnId));
          const r = e.ok ? Scores.parseEspn(e.json, p.pin) : { error: e.reason };
          if (!r.error) {
            reading = r;
            health = { ok: true, partial: true, text: "Penalties paused: the NHL's feed didn't answer (" + n.reason + '). Score from ESPN' };
          } else { feed = 'the NHL and ESPN'; reason = n.reason + '; ' + r.error; }
        }
      } else {
        const e = await getJson(Scores.espnEventUrl(p.pin.league, p.pin.espnId));
        const r = e.ok ? Scores.parseEspn(e.json, p.pin) : { error: e.reason };
        if (!r.error) reading = r; else reason = r.error;
      }
    } catch (err) {
      reason = 'the reader hit a bug (' + String((err && err.message) || err).slice(0, 80) + ')';
    }
    p.busy = false;
    if (!pins.has(p.pin.key) || stopped) return;
    if (!reading) {
      p.failures++;
      const retry = Scores.nextPollMs(p.reading, t0, p.failures);
      p.health = { ok: false, text: Scores.pausedLine(feed, reason, Math.round(retry * scale)), retryAt: t0 + Math.round(retry * scale) };
      log('Score pin ' + p.pin.key + ': ' + p.health.text);
      arm(p, retry);
      push(p);
      return;
    }
    const gap = p.lastOkAt ? t0 - p.lastOkAt : 0;
    const events = Scores.diff(p.reading, reading, { quiet: gap > Scores.QUIET_GAP_MS * scale });
    p.failures = 0;
    p.reading = reading;
    p.lastOkAt = t0;
    const next = Scores.nextPollMs(reading, t0, 0);
    if (health.partial) health.text += ', retrying in ' + Math.round((next === null ? 30000 : next) * scale / 1000) + ' s';
    p.health = health;
    if (health.partial && p.lastPartial !== health.text) log('Score pin ' + p.pin.key + ': ' + health.text);
    p.lastPartial = health.partial ? health.text : '';
    p.events += events.length;
    arm(p, next);
    if (next === null) log('Score pin ' + p.pin.key + ' stopped polling: ' + (reading.line || reading.phase));
    push(p, { events });
  }

  /* --- pin / unpin --------------------------------------------------------------------------- */

  function record(pin, saved) {
    const s = saved || {};
    return {
      pin, win: null, ready: false, reading: null, health: { ok: true, text: '' }, lastOkAt: 0, failures: 0,
      timer: null, nextAt: 0, busy: false, polls: 0, events: 0, nhlTriedAt: 0, nhlReason: '', lastPartial: '',
      muted: s.muted === true, pos: s.pos && Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y) ? { x: Math.round(s.pos.x), y: Math.round(s.pos.y) } : null,
      height: CARD_H, closing: false, reopened: false, drag: null, played: [],
    };
  }

  function pin(raw) {
    const clean = Scores.cleanPin(raw);
    if (!clean) return { ok: false, reason: "That game can't be pinned (it is missing its teams or its ESPN id)" };
    const had = pins.get(clean.key);
    if (had) {
      if (had.win && !had.win.isDestroyed()) push(had, { flash: true });
      return { ok: true, already: true, key: clean.key };
    }
    if (pins.size >= MAX_PINS) return { ok: false, reason: MAX_PINS + ' games are pinned already. Close one first' };
    const p = record(clean, null);
    pins.set(clean.key, p);
    hookPower(true);
    openWindow(p);
    saveSoon();
    pushPinned();
    poll(p);
    log('Pinned ' + clean.key + ' (' + clean.title + ')');
    return { ok: true, key: clean.key };
  }

  function unpin(key) {
    const p = pins.get(key);
    if (!p) return { ok: false, reason: 'not pinned' };
    pins.delete(key);
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    p.closing = true;
    if (p.win && !p.win.isDestroyed()) p.win.destroy();
    if (!pins.size) hookPower(false);
    layout();
    saveSoon();
    pushPinned();
    log('Unpinned ' + key);
    return { ok: true, key };
  }

  /** Quartz's own window closed: the cards go, the pins stay saved for the next start. */
  function closeAll() {
    stopped = true;
    saveNow();
    for (const p of pins.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
      p.closing = true;
      if (p.win && !p.win.isDestroyed()) p.win.destroy();
    }
    hookPower(false);
  }

  function restore() {
    loadPrefs();
    const t = now();
    for (const raw of prefs.pins) {
      const clean = Scores.cleanPin(raw);
      if (!clean || pins.has(clean.key)) continue;
      if (clean.startsAt && t - clean.startsAt > RESTORE_MAX_AGE_MS) { log('Score pin ' + clean.key + ' dropped at start: the game began over 16 h ago'); continue; }
      const p = record(clean, raw);
      pins.set(clean.key, p);
    }
    if (pins.size !== prefs.pins.length) saveSoon();
    if (!pins.size) return;
    hookPower(true);
    // The cards close with Quartz's own window, so they open only once it exists.
    let tries = 0;
    const go = () => {
      const w = typeof d.getWindow === 'function' ? d.getWindow() : null;
      if (!w && ++tries < 120 && !stopped) { setTimeout(go, 500); return; }
      for (const p of pins.values()) { if (!p.win) openWindow(p); poll(p); }
    };
    go();
  }

  function hookMainWindow() {
    const w = typeof d.getWindow === 'function' ? d.getWindow() : null;
    if (!w || w === mainWinHooked || (typeof w.isDestroyed === 'function' && w.isDestroyed())) return;
    mainWinHooked = w;
    w.once('closed', closeAll);
  }

  function onSuspend() { for (const p of pins.values()) { if (p.timer) clearTimeout(p.timer); p.timer = null; p.nextAt = 0; } }
  function onResume() { setTimeout(() => { for (const p of pins.values()) if (p.reading === null || Scores.nextPollMs(p.reading, now(), 0) !== null) poll(p); }, 3000); }
  function hookPower(on) {
    const pm = d.powerMonitor;
    if (!pm || on === powerHooked) return;
    powerHooked = on;
    if (on) { pm.on('suspend', onSuspend); pm.on('resume', onResume); } else { pm.removeListener('suspend', onSuspend); pm.removeListener('resume', onResume); }
  }

  /* --- opening a game: ONE function ---------------------------------------------------------- */

  /**
   * A card was clicked: open that game inside Lumen. TODAY that is what Lumen does for an
   * ESPN game -- the gamecast in a Quartz tab, never Edge and never a new browser window --
   * and Quartz's window comes forward (The user clicked a card on his desktop). The in-Lumen
   * player lane's openInLumen(url) replaces this body at merge.
   */
  function openGame(url) {
    const clean = typeof url === 'string' ? url.trim() : '';
    if (!/^https:\/\/(www\.)?espn\.com\//i.test(clean) || /\/watch\/player/i.test(clean)) return { ok: false, reason: 'not a gamecast' };
    if (test.openStub) {
      try { fs.appendFileSync(test.openStub, JSON.stringify({ url: clean }) + '\n'); } catch { /* the e2e sees it missing */ }
      return { ok: true, how: 'stub' };
    }
    if (typeof d.send === 'function') d.send('open-url', { url: clean, background: false });
    const w = typeof d.getWindow === 'function' ? d.getWindow() : null;
    if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
    return { ok: true, how: 'tab' };
  }

  /* --- the Lumen page (console lines, like watch.js) ------------------------------------------- */

  function isLumenPage(url) {
    const u = String(url || '');
    return u === LUMEN_PAGE || u.indexOf(LUMEN_PAGE + '?') === 0 || u.indexOf(LUMEN_PAGE + '#') === 0;
  }
  function pinnedKeys() { return Array.from(pins.keys()); }
  function pushTo(contents) {
    try { contents.executeJavaScript('window.__applyScorePins && window.__applyScorePins(' + JSON.stringify(pinnedKeys()) + ')').catch(() => lumenPages.delete(contents)); } catch { lumenPages.delete(contents); }
  }
  function pushPinned() {
    if (typeof d.send === 'function') { try { d.send('scores:changed', { pinned: pinnedKeys() }); } catch { /* no window yet */ } }
    for (const c of Array.from(lumenPages)) {
      if (c.isDestroyed() || !isLumenPage(c.getURL())) { lumenPages.delete(c); continue; }
      pushTo(c);
    }
  }
  function handleLine(contents, text) {
    if (typeof text !== 'string' || text.indexOf(LINE_PREFIX) !== 0) return false;
    let url = '';
    try { url = contents.getURL(); } catch { return false; }
    if (!isLumenPage(url)) return false;
    const rest = text.slice(LINE_PREFIX.length);
    const sp = rest.indexOf(' ');
    const verb = sp === -1 ? rest : rest.slice(0, sp);
    let msg = {};
    try { msg = sp === -1 ? {} : JSON.parse(rest.slice(sp + 1)); } catch { return false; }
    if (!msg || typeof msg !== 'object') return false;
    lumenPages.add(contents);
    if (verb === 'hello') pushTo(contents);
    else if (verb === 'pin') { const r = pin(msg.game); if (!r.ok) contents.executeJavaScript('window.__scorePinFailed && window.__scorePinFailed(' + JSON.stringify(r.reason) + ')').catch(() => {}); pushTo(contents); }
    else if (verb === 'unpin' && typeof msg.key === 'string') { unpin(msg.key); pushTo(contents); }
    else return false;
    return true;
  }
  function watchGuest(contents) {
    if (!contents || contents.isDestroyed()) return;
    contents.on('console-message', function (details) {
      const m = details && typeof details.message === 'string' ? details.message : (typeof arguments[2] === 'string' ? arguments[2] : '');
      if (m.indexOf(LINE_PREFIX) !== 0) return;
      try { handleLine(contents, m); } catch (err) { log('Score pin line failed: ' + ((err && err.message) || 'error')); }
    });
    contents.on('destroyed', () => lumenPages.delete(contents));
  }

  /* --- IPC ------------------------------------------------------------------------------------- */

  function cardOf(event) {
    const key = event && event.sender ? byContents.get(event.sender.id) : null;
    return key ? pins.get(key) || null : null;
  }
  const isChrome = (event) => (typeof d.isChromeSender === 'function' ? d.isChromeSender(event) : false);

  function games() {
    let list = [];
    try { list = typeof d.getGames === 'function' ? d.getGames() || [] : []; } catch { list = []; }
    return list.filter((e) => e && Scores.leagueOf(e.league)).slice(0, 40).map((e) => ({
      id: e.id, league: e.league, leagueName: e.leagueName, state: e.state, startsAt: e.startsAt, detail: e.detail,
      away: e.away, home: e.home, gamecastUrl: e.gamecastUrl,
      key: e.league + ':' + String(e.id).replace(/^espn:/, ''),
    }));
  }

  if (ipcMain) {
    ipcMain.handle('scores:games', (event) => (isChrome(event) ? { games: games(), pinned: pinnedKeys(), sound: prefs.sound } : null));
    ipcMain.handle('scores:pin', (event, raw) => (isChrome(event) ? pin(raw) : { ok: false, reason: 'not allowed' }));
    ipcMain.handle('scores:unpin', (event, key) => (isChrome(event) && typeof key === 'string' ? unpin(key) : { ok: false, reason: 'not allowed' }));
    ipcMain.handle('scores:set-sound', (event, on) => {
      if (!isChrome(event)) return { ok: false };
      prefs.sound = !!on;
      saveSoon();
      pushPinned();
      for (const p of pins.values()) push(p);
      return { ok: true, sound: prefs.sound };
    });
    ipcMain.on('scores:look', (event, raw) => {
      if (!isChrome(event)) return;
      const next = cleanLook(raw);
      if (JSON.stringify(next) === JSON.stringify(look)) return;
      look = next;
      for (const p of pins.values()) {
        if (!p.win || p.win.isDestroyed()) continue;
        // The window's own colour too, so a reload never flashes the old theme under the page.
        if (!acrylic && typeof p.win.setBackgroundColor === 'function') p.win.setBackgroundColor(look.theme === 'light' ? '#f4f4f5' : '#202123');
        if (p.ready) p.win.webContents.send('scorepin:look', look);
      }
    });
    // From the cards themselves (score-pin-preload.js): each answers only for its own pin.
    ipcMain.on('scorepin:ready', (event) => { const p = cardOf(event); if (p) { p.ready = true; push(p); } });
    ipcMain.on('scorepin:close', (event) => { const p = cardOf(event); if (p) unpin(p.pin.key); });
    ipcMain.on('scorepin:open', (event) => { const p = cardOf(event); if (p) openGame(p.pin.url); });
    ipcMain.on('scorepin:mute', (event, muted) => { const p = cardOf(event); if (p) { p.muted = !!muted; saveSoon(); push(p); } });
    ipcMain.on('scorepin:height', (event, h) => {
      const p = cardOf(event);
      const n = Math.round(Number(h));
      if (!p || !Number.isFinite(n) || n < 60 || n > 240 || n === p.height) return;
      p.height = n;
      layout();
    });
    ipcMain.on('scorepin:drag', (event, m) => {
      const p = cardOf(event);
      if (!p || !p.win || p.win.isDestroyed() || !m || typeof m !== 'object') return;
      const dx = Math.round(Number(m.dx)), dy = Math.round(Number(m.dy));
      if (m.phase === 'start') { const b = p.win.getBounds(); p.drag = { x: b.x, y: b.y }; return; }
      if (!p.drag || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
      p.win.setPosition(p.drag.x + dx, p.drag.y + dy);
      if (m.phase === 'end') {
        const b = p.win.getBounds();
        p.pos = { x: b.x, y: b.y };
        p.drag = null;
        if (!placeOk(p.pos, p.height)) p.pos = null;   // dropped off every screen: back to the stack
        layout();
        saveSoon();
      }
    });
    ipcMain.on('scorepin:played', (event, kind) => { const p = cardOf(event); if (p && typeof kind === 'string') { p.played.push(kind.slice(0, 16)); if (p.played.length > 50) p.played.shift(); } });
    if (test.offscreen) {
      // TEST ONLY: what the e2e asserts instead of looking at the user's screen.
      ipcMain.handle('scores:test', async (event, op) => {
        if (!isChrome(event) || !op || typeof op !== 'object') return null;
        const p = typeof op.key === 'string' ? pins.get(op.key) : null;
        if (op.op === 'poll' && p) { await poll(p); return true; }
        if (op.op === 'capture' && p && p.win) { const img = await p.win.webContents.capturePage(); return img.toPNG().toString('base64'); }
        if (op.op === 'drag' && p && p.win) {
          const b = p.win.getBounds(); p.drag = { x: b.x, y: b.y };
          p.win.setPosition(b.x + op.dx, b.y + op.dy); const nb = p.win.getBounds(); p.pos = { x: nb.x, y: nb.y }; p.drag = null; layout(); saveNow(); return true;
        }
        if (op.op === 'restack' && p) { p.pos = null; layout(); saveNow(); return true; }
        if (op.op === 'metrics') return app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, cpu: m.cpu.percentCPUUsage, wakeups: m.cpu.idleWakeupsPerSecond, mem: m.memory.workingSetSize }));
        return state();
      });
    }
  }

  function state() {
    return {
      sound: prefs.sound, look, area: workArea(), acrylic,
      pins: Array.from(pins.values()).map((p) => {
        const w = p.win && !p.win.isDestroyed() ? p.win : null;
        return {
          key: p.pin.key, nhlId: p.pin.nhlId, pid: w ? w.webContents.getOSProcessId() : null, bounds: w ? w.getBounds() : null, visible: w ? w.isVisible() : false,
          alwaysOnTop: w ? w.isAlwaysOnTop() : false, focusable: w ? w.isFocusable() : null, focused: w ? w.isFocused() : false,
          audioMuted: w ? w.webContents.isAudioMuted() : null, audible: w ? w.webContents.isCurrentlyAudible() : null,
          ready: p.ready, polls: p.polls, events: p.events, failures: p.failures, timer: !!p.timer, nextInMs: p.nextAt ? p.nextAt - now() : null,
          health: p.health, muted: p.muted, pos: p.pos, height: p.height, played: p.played.slice(),
          reading: p.reading ? { phase: p.reading.phase, line: p.reading.line, source: p.reading.source, away: p.reading.away && p.reading.away.score, home: p.reading.home && p.reading.home.score, strength: p.reading.strength } : null,
        };
      }),
    };
  }

  if (app && typeof app.on === 'function') {
    app.on('web-contents-created', (_e, contents) => {
      try { if (contents.getType() === 'webview') watchGuest(contents); } catch { /* died already */ }
    });
    if (typeof app.whenReady === 'function') app.whenReady().then(() => setTimeout(() => { try { restore(); } catch (err) { log('Score pins could not restore: ' + ((err && err.message) || 'error')); } }, test.offscreen ? 0 : 2500));
    app.on('before-quit', () => { if (!stopped) closeAll(); });
  }

  return { pin, unpin, openGame, games, state, restore, closeAll, watchGuest, handleLine, isLumenPage, setLook: (l) => { look = cleanLook(l); } };
}

module.exports = { create, PREFS_FILE, LINE_PREFIX, CARD_W, MAX_PINS, cleanLook, reasonOf };
