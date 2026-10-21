'use strict';
/*
 * watch-alerts-main.js -- Lumen Alerts, the MAIN-process half: "New from your subscriptions" (the
 * YouTube bell) and game start / final for the user's favourite teams (the ESPN app's pushes).
 *
 *   watch/alerts.js           the diff, the batch, the game moves, the gates (pure)
 *   watch-alerts-main.js      this file: the hooks into Lumen's own reads, the saved prefs, the IPC
 *   watch-alerts-chrome.js    the chrome: shows an alert, draws Settings > Lumen > Alerts
 *
 * NO READS OF ITS OWN, NO TIMER. Alerts ride on reads Lumen already makes:
 *   - watch/ytlib-main.js's Subscriptions read, which follows every good YouTube read (Lumen's
 *     15-min schedule on screen, its hourly background refresh off screen). With subscription
 *     alerts on, that follow-up read also runs when no Lumen page has the row open (wantSubs), but
 *     only after a BACKGROUND-refresh YouTube read (its hourly cadence; battery saver, a game, 2.5 GB
 *     and the boot delay gate it), one hidden page load each, never at launch. Alerts off: none.
 *   - watch-main.js's ESPN read (public JSON, no page). While a favourite team's game is on or
 *     about to start, the background refresh reads ESPN at its live cadence (espnHot) instead of
 *     hourly; every background gate (minimised, battery saver, 2.5 GB, a game) still applies.
 * So alerts exist only while Quartz runs; Settings says so.
 *
 * GATES. While a game runs (watch-main's tasklist answer, or %TEMP%\claude-heavytest.gaming) or
 * with under 2.5 GB free: no alert, no extra read, and the diff is NOT consumed, so what was held
 * is said once the gate clears (a game start only if it is still under 30 min old).
 *
 * HOW AN ALERT IS SHOWN. Main sends 'lumen-alerts:show' to the chrome, which uses Quartz's own
 * notification path (app.js's window.Notification, the "Claude is waiting" toast that the user's
 * shell redraws) when Quartz is in the background, and an in-Quartz card when they are looking at it.
 * The chrome answers 'lumen-alerts:shown' with where it went, or why it could not.
 *
 * TESTS ARE SILENT. A --test-profile run sets test.silent: the chrome never constructs a real
 * Notification, it only counts the one it would have shown (as score pins count their sounds), and
 * the test IPC ('lumen-alerts:test') can feed fixture reads and read the counts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Alerts = require('./watch/alerts');

const PREFS_FILE = 'lumen-alerts.json';
const KEEP_ALERTS = 12;
const LUMEN_LEAGUES_HINT = 'Settings > Lumen > Leagues';

function create(deps) {
  const d = deps || {};
  const test = d.test && typeof d.test === 'object' ? d.test : {};
  const log = typeof d.log === 'function' ? d.log : (line) => console.log('[alerts] ' + line);
  const now = typeof test.now === 'function' ? test.now : () => Date.now();
  const userData = (() => { try { return test.userData || (d.app && d.app.getPath('userData')) || ''; } catch { return ''; } })();
  const prefsPath = userData ? path.join(userData, PREFS_FILE) : '';
  const flagFile = typeof test.flagFile === 'string' ? test.flagFile : path.join(os.tmpdir(), 'claude-heavytest.gaming');
  const freeGb = typeof test.freeGb === 'function' ? test.freeGb : (typeof d.freeGb === 'function' ? d.freeGb : () => os.freemem() / (1024 ** 3));
  const minFreeGb = Number.isFinite(test.minFreeGb) ? test.minFreeGb : Alerts.MIN_FREE_GB;

  let prefs = load();
  const sent = [];                       // the last alerts sent (newest last), for clicks and Settings
  const status = {
    subs: { state: 'never', reason: '', readAt: 0, found: 0 },
    teams: { state: 'never', reason: '', readAt: 0, found: 0 },
    held: { subs: '', teams: '' },       // why the last check was held back ('' = it was not)
    last: null,                           // { at, title, surface, ok, reason }
  };
  const counts = { sent: 0, os: 0, card: 0, failed: 0, held: 0, wantSubs: 0, hot: 0 };

  function load() {
    if (!prefsPath) return Alerts.cleanPrefs(null);
    try { return Alerts.cleanPrefs(JSON.parse(fs.readFileSync(prefsPath, 'utf8'))); } catch { return Alerts.cleanPrefs(null); }
  }
  function save() {
    if (!prefsPath) return;
    try {
      fs.writeFileSync(prefsPath + '.tmp', JSON.stringify(prefs));
      fs.renameSync(prefsPath + '.tmp', prefsPath);
    } catch (err) { log('Lumen Alerts could not save its settings: ' + ((err && err.code) || (err && err.message) || 'error')); }
  }

  function favs() {
    if (Array.isArray(test.favs)) return test.favs;
    try { return (typeof d.getFavs === 'function' ? d.getFavs() : []) || []; } catch { return []; }
  }
  function view() {
    try { return (typeof d.lumenView === 'function' ? d.lumenView() : null) || {}; } catch { return {}; }
  }
  function gamingNow() {
    if (typeof test.gaming === 'function') return test.gaming() || '';
    try { return (typeof d.gaming === 'function' ? d.gaming() : '') || ''; } catch { return ''; }
  }
  function flagOn() {
    if (typeof test.gamingFlag === 'function') return !!test.gamingFlag();
    try { return fs.existsSync(flagFile); } catch { return false; }
  }
  /** Why nothing may happen now ('' = it may). */
  function gateWhy() {
    let free = NaN;
    try { free = Number((typeof test.freeGbNow === 'function' ? test.freeGbNow : freeGb)()); } catch { free = NaN; }
    return Alerts.gate({ gamingFlag: flagOn(), gaming: gamingNow(), freeGb: free, minFreeGb });
  }
  function teamsOn() { return Alerts.teamsOn(prefs, favs().length); }

  /* --- the hooks Lumen calls ---------------------------------------------------------------- */

  /** ytlib-main: may the Subscriptions read follow a YouTube read with no page open? */
  function wantSubs() {
    if (!prefs.subs) return false;
    if (gateWhy()) return false;
    counts.wantSubs++;
    return true;
  }

  /** watch-main's background refresh: read ESPN at the live cadence now? */
  function espnHot(events) {
    if (!teamsOn() || !favs().length) return false;
    if (gateWhy()) return false;
    const hot = Alerts.espnHot(favs(), events, now());
    if (hot) counts.hot++;
    return hot;
  }

  /** ytlib-main: a Subscriptions read landed (its answer: state, reason, items, readAt). */
  function onSubs(answer) {
    const a = answer && typeof answer === 'object' ? answer : {};
    const st = ['ok', 'signed-out', 'error', 'never'].indexOf(a.state) !== -1 ? a.state : 'error';
    status.subs = { state: st, reason: typeof a.reason === 'string' ? a.reason.slice(0, 200) : '', readAt: Number(a.readAt) || now(), found: 0 };
    if (st !== 'ok' || !prefs.subs) { status.held.subs = ''; return null; }
    const why = gateWhy();
    if (why) { status.held.subs = why; counts.held++; log('Lumen Alerts held a subscriptions check: ' + why); return null; }
    status.held.subs = '';
    const fresh = Alerts.diffSubs(prefs, a.items);
    save();
    status.subs.found = fresh.length;
    const alert = Alerts.subsAlert(fresh, now());
    if (alert) deliver(alert);
    return alert;
  }

  /** watch-main: a service read ended. ESPN's events -> game moves for the favourites. */
  function onRead(id, s) {
    if (id !== 'espn') return [];
    const svc = s && typeof s === 'object' ? s : {};
    const st = ['ok', 'signed-out', 'error'].indexOf(svc.state) !== -1 ? svc.state : 'error';
    status.teams = { state: st, reason: typeof svc.reason === 'string' ? svc.reason.slice(0, 200) : '', readAt: Number(svc.readAt) || now(), found: 0 };
    if (st !== 'ok' || !teamsOn()) { status.held.teams = ''; return []; }
    const list = favs();
    if (!list.length) return [];
    const why = gateWhy();
    if (why) { status.held.teams = why; counts.held++; return []; }
    status.held.teams = '';
    const moves = Alerts.gameMoves(prefs, svc.events, list, now());
    save();
    status.teams.found = moves.length;
    const out = moves.map((m) => Alerts.gameAlert(m, now()));
    for (const a of out) deliver(a);
    return out;
  }

  /* --- showing ----------------------------------------------------------------------------- */

  function deliver(alert) {
    sent.push(alert);
    while (sent.length > KEEP_ALERTS) sent.shift();
    counts.sent++;
    const payload = Object.assign({}, alert, { silent: !!test.silent });
    delete payload.event;   // the chrome needs words, not ESPN's object; clicks come back by id
    let ok = false;
    try { ok = d.send ? d.send('lumen-alerts:show', payload) !== false : false; } catch { ok = false; }
    const w = typeof d.getWindow === 'function' ? d.getWindow() : null;
    if (!w || (typeof w.isDestroyed === 'function' && w.isDestroyed())) ok = false;
    if (!ok) {
      counts.failed++;
      status.last = { at: now(), title: alert.title, surface: '', ok: false, reason: "Quartz's window was not open" };
      log('Lumen Alerts could not show "' + alert.title + '": Quartz\'s window was not open');
    } else status.last = { at: now(), title: alert.title, surface: 'sent', ok: true, reason: '' };
    log('Lumen alert: ' + alert.title);
  }

  /** The chrome's answer: where the alert went ('os' | 'card'), or why it could not be shown. */
  function shown(msg) {
    const m = msg && typeof msg === 'object' ? msg : {};
    const a = sent.find((x) => x.id === m.id);
    if (!a) return;
    const surface = m.surface === 'os' || m.surface === 'card' ? m.surface : '';
    if (m.ok && surface) counts[surface]++;
    else counts.failed++;
    status.last = { at: now(), title: a.title, surface, ok: !!m.ok, reason: typeof m.reason === 'string' ? m.reason.slice(0, 160) : '' };
    if (!m.ok) log('Lumen Alerts could not show "' + a.title + '": ' + status.last.reason);
  }

  function focusQuartz() {
    const w = typeof d.getWindow === 'function' ? d.getWindow() : null;
    if (!w || w.isDestroyed()) return;
    try { if (w.isMinimized()) w.restore(); if (!test.offscreen) { w.show(); w.focus(); } } catch { /* gone */ }
  }

  /** A click on an alert: play a video in Lumen, open a game page, or pin a game. */
  async function act(msg) {
    const m = msg && typeof msg === 'object' ? msg : {};
    const a = sent.find((x) => x.id === m.id);
    if (!a) return { ok: false, reason: 'that alert is gone (Quartz restarted since)' };
    const action = typeof m.action === 'string' ? m.action : a.action;
    focusQuartz();
    if (a.kind === 'subs' && action === 'play') {
      const i = Math.max(0, Math.min(a.items.length - 1, Number(m.index) || 0));
      const it = a.items[i];
      if (!it || typeof d.openTitle !== 'function') return { ok: false, reason: 'Lumen is not running' };
      try { return await d.openTitle(it.url, { title: it.title }); } catch (err) { return { ok: false, reason: String((err && err.message) || err).slice(0, 120) }; }
    }
    if (a.kind === 'game' && action === 'open') {
      if (typeof d.openGame !== 'function') return { ok: false, reason: 'Lumen sports is not running' };
      try { return d.openGame(a.event.gamecastUrl || '') || { ok: false, reason: 'no answer' }; } catch (err) { return { ok: false, reason: String((err && err.message) || err).slice(0, 120) }; }
    }
    if (a.kind === 'game' && action === 'pin') {
      if (typeof d.pin !== 'function') return { ok: false, reason: 'score pins are not running' };
      try { return d.pin(a.event) || { ok: false, reason: 'no answer' }; } catch (err) { return { ok: false, reason: String((err && err.message) || err).slice(0, 120) }; }
    }
    return { ok: false, reason: 'unknown action' };
  }

  /* --- Settings ----------------------------------------------------------------------------- */

  function leaguesMissing() {
    const v = view();
    const on = Array.isArray(v.leagues) ? v.leagues : null;
    if (!on) return [];
    const out = [];
    for (const f of favs()) if (on.indexOf(f.league) === -1 && out.indexOf(f.league) === -1) out.push(f.league);
    return out;
  }

  function describe() {
    const v = view();
    const why = gateWhy();
    const list = favs();
    return {
      subs: Object.assign({ on: prefs.subs, youtube: v.youtube || '', baselined: prefs.baselined }, status.subs, { held: status.held.subs }),
      teams: Object.assign({
        on: teamsOn(), chosen: prefs.teams, espn: v.espn || '',
        favs: list.map((f) => ({ league: f.league, abbr: f.abbr, name: f.name, logo: f.logo })),
        missingLeagues: leaguesMissing(), leaguesHint: LUMEN_LEAGUES_HINT,
      }, status.teams, { held: status.held.teams }),
      gate: why,
      last: status.last,
      background: v.background !== false,
    };
  }

  function set(kind, on) {
    if (kind === 'subs') prefs.subs = !!on;
    else if (kind === 'teams') prefs.teams = !!on;
    else return describe();
    save();
    log('Lumen Alerts: ' + kind + ' alerts ' + (on ? 'on' : 'off'));
    return describe();
  }

  /* --- IPC ---------------------------------------------------------------------------------- */

  function isChrome(event) { try { return typeof d.isChromeSender === 'function' ? !!d.isChromeSender(event) : false; } catch { return false; } }
  if (d.ipcMain) {
    const ipc = d.ipcMain;
    ipc.handle('lumen-alerts:describe', (event) => (isChrome(event) ? describe() : null));
    ipc.handle('lumen-alerts:set', (event, kind, on) => (isChrome(event) ? set(String(kind || ''), !!on) : null));
    ipc.handle('lumen-alerts:act', (event, msg) => (isChrome(event) ? act(msg) : { ok: false, reason: 'not allowed' }));
    ipc.on('lumen-alerts:shown', (event, msg) => { if (isChrome(event)) shown(msg); });
    if (test.offscreen) {
      // Tests only: feed fixture reads, set the gates, read the counts.
      const over = { gaming: '', flag: false, freeGb: null };
      test.gaming = () => over.gaming;
      test.gamingFlag = () => over.flag;
      test.freeGbNow = () => (over.freeGb === null ? freeGb() : over.freeGb);
      ipc.handle('lumen-alerts:test', (event, op) => {
        if (!isChrome(event)) return null;
        const o = op && typeof op === 'object' ? op : {};
        if (o.op === 'gate') { if ('gaming' in o) over.gaming = String(o.gaming || ''); if ('flag' in o) over.flag = !!o.flag; if ('freeGb' in o) over.freeGb = o.freeGb === null ? null : Number(o.freeGb); return describe(); }
        if (o.op === 'favs') { test.favs = Array.isArray(o.favs) ? o.favs : undefined; return describe(); }
        if (o.op === 'subs') { const a = onSubs(o.answer); return { alert: a ? a.id : '', describe: describe() }; }
        if (o.op === 'espn') { const out = onRead('espn', o.service); return { alerts: out.map((a) => a.id), describe: describe() }; }
        if (o.op === 'hot') return { hot: espnHot(o.events), wantSubs: wantSubs() };
        return { counts: Object.assign({}, counts), sent: sent.map((a) => ({ id: a.id, kind: a.kind, title: a.title, body: a.body })), last: status.last, prefs: { subs: prefs.subs, teams: prefs.teams, baselined: prefs.baselined, seen: prefs.seen.length } };
      });
    }
  }

  return {
    wantSubs, espnHot, onSubs, onRead, describe, set, act, shown,
    _counts: () => Object.assign({}, counts), _sent: () => sent.slice(), _prefs: () => prefs, _gate: gateWhy,
  };
}

module.exports = { create, PREFS_FILE };
