'use strict';
/*
 * sports-main.js -- the MAIN-process half of Lumen's sports pages: the game page, favourite
 * teams ("My teams"), team pages with their schedules, and standings.
 *
 *   watch/sports.js         ESPN's public JSON read into the pages' shapes; "Watch this game" (pure)
 *   sports-main.js          this file: the reads, a small in-memory cache, the saved favourites
 *   watch/sportspage.js     the pages, drawn inside Lumen (watch.html), plus the My teams row
 *
 * THE PAGE speaks in console lines, like watch.js and watch/pinbutton.js; only OUR watch.html is
 * heard, and every line is checked here:
 *   in   quartz-sports:hello     {}                         favourites + My teams, please
 *        quartz-sports:myteams   {}                         refresh My teams (the page asks every 2 min while one is live)
 *        quartz-sports:game      {"league":"nhl","id":"401"}  one game's summary (the OPEN game page polls this)
 *        quartz-sports:team      {"league":"nhl","id":"25"}   a team's schedule
 *        quartz-sports:teams     {"league":"nhl"}           the favourite picker's list
 *        quartz-sports:standings {"league":"nhl"}
 *        quartz-sports:fav       {"league","team":{id,abbr,name,logo},"on":true}   the user's click, saved locally
 *   out  window.__applySports({ kind: 'favs'|'myteams'|'game'|'team'|'teams'|'standings'|'open', ... })
 *
 * WHEN IT READS. Only when the page asks: nothing here has a timer. A game page that is open
 * re-asks on watch/sports.js nextPollMs (live 20 s, an intermission 60 s, pre-game 1-5 min,
 * Final never), and stops when it closes or the tab is hidden. Every read is a plain fetch()
 * from main: no cookies (credentials 'omit'), no account, nothing written but the favourites
 * (<userData>/lumen-sports.json). Bodies are parsed in memory and dropped.
 *
 * NO SILENT FAILURES. A failed read answers { error: words } and the page says it, with Retry.
 *
 * A SCORE PIN's click (score-pins-main.js openGame) comes here as its gamecast URL: the game
 * page opens in the Lumen tab (opened if none is), and Quartz comes forward.
 *
 * TESTS: create({ test }) gets { rebase } ONLY from a --test-profile run (QUARTZ_SPORTS_REBASE,
 * main.js), so a live Quartz always reads ESPN itself. tests/sports-test.js drives create() with
 * a fake fetch and a temp userData.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const Sports = require('./watch/sports');

const PREFS_FILE = 'lumen-sports.json';
const LINE_PREFIX = 'quartz-sports:';
const FETCH_BUDGET_MS = 10000;
const MAX_BODY = 6 * 1024 * 1024;
const MAX_FAVS = 12;
const TTL = { teams: 24 * 3600e3, standings: 5 * 60e3, schedule: 10 * 60e3, scheduleHot: 90e3, stars: 3600e3 };
const OPEN_FRESH_MS = 30000;
const LUMEN_PAGE = pathToFileURL(path.join(__dirname, 'watch.html')).href;

function reasonOf(err) {
  const t = String((err && (err.name + ' ' + (err.cause && err.cause.code) + ' ' + err.message)) || err || '');
  if (/TimeoutError|aborted due to timeout|timed out/i.test(t)) return 'ESPN timed out after ' + Math.round(FETCH_BUDGET_MS / 1000) + ' s';
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ERR_INTERNET_DISCONNECTED/i.test(t)) return "couldn't reach ESPN; you may be offline";
  if (/ECONNREFUSED|ECONNRESET|socket|other side closed/i.test(t)) return 'the connection to ESPN dropped';
  return 'the request to ESPN failed';
}
function cleanTeam(raw, league) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const id = Sports.cleanId(r.id);
  const abbr = typeof r.abbr === 'string' && /^[A-Za-z0-9&]{1,6}$/.test(r.abbr) ? r.abbr.toUpperCase() : '';
  const name = typeof r.name === 'string' ? r.name.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60) : '';
  const logo = typeof r.logo === 'string' && /^https:\/\/[a-z0-9.-]+\.(espncdn\.com|espn\.com)\//i.test(r.logo) ? r.logo.slice(0, 300) : '';
  if (!id || !abbr || !name || !Sports.leagueOf(league)) return null;
  return { league, id, abbr, name, logo };
}

function create(deps) {
  const d = deps || {};
  const test = d.test && typeof d.test === 'object' ? d.test : {};
  const log = typeof d.log === 'function' ? d.log : (line) => console.log('[sports] ' + line);
  const now = typeof test.now === 'function' ? test.now : () => Date.now();
  const doFetch = typeof test.fetch === 'function' ? test.fetch : (typeof fetch === 'function' ? fetch : null);
  const rebase = Array.isArray(test.rebase) ? test.rebase.filter((p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string') : [];
  const userData = (() => { try { return test.userData || (d.app && d.app.getPath('userData')) || ''; } catch { return ''; } })();
  const prefsPath = userData ? path.join(userData, PREFS_FILE) : '';

  const cache = new Map();          // url -> { at, value }
  const inflight = new Map();       // url -> Promise
  const pages = new Set();          // the Lumen pages that said hello
  // A page's 'destroyed' listener goes on when it first speaks as a Lumen page, not on every
  // webview: each guest already carries one per feature that watches it, and an 11th tripped
  // Node's MaxListeners warning on a new tab (log-e2e). Once per webContents.
  const pagesListened = new WeakSet();
  function trackPage(contents) {
    pages.add(contents);
    if (pagesListened.has(contents)) return;
    pagesListened.add(contents);
    try { contents.once('destroyed', () => pages.delete(contents)); } catch { /* destroyed already */ }
  }
  let pendingOpen = null;           // { league, id, at }: a score pin's click, waiting for a Lumen page
  let favs = loadFavs();
  const counts = { fetches: 0 };

  function loadFavs() {
    if (!prefsPath) return [];
    try {
      const j = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      return (Array.isArray(j.favs) ? j.favs : []).map((f) => cleanTeam(f, f && f.league)).filter(Boolean).slice(0, MAX_FAVS);
    } catch { return []; }
  }
  function saveFavs() {
    if (!prefsPath) return;
    try {
      const tmp = prefsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, favs }, null, 1));
      fs.renameSync(tmp, prefsPath);
    } catch (err) { log('Lumen sports could not save favourites: ' + ((err && err.message) || 'error')); }
  }

  function rebased(url) {
    for (const [from, to] of rebase) if (url.indexOf(from) === 0) return to + url.slice(from.length);
    return url;
  }
  /** One public JSON read -> { json } or { error }. Never throws. */
  async function getJson(url, ttl) {
    if (!url) return { error: 'no address for that' };
    const hit = cache.get(url);
    if (hit && ttl && now() - hit.at < ttl) return hit.value;
    if (inflight.has(url)) return inflight.get(url);
    const p = (async () => {
      if (!doFetch) return { error: 'this Quartz has no fetch()' };
      counts.fetches++;
      try {
        const res = await doFetch(rebased(url), {
          credentials: 'omit', redirect: 'follow', cache: 'no-store',
          headers: { accept: 'application/json' },
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(FETCH_BUDGET_MS) : undefined,
        });
        if (!res.ok) return { error: res.status === 404 ? 'ESPN has no page for that (HTTP 404)' : 'ESPN answered HTTP ' + res.status };
        const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
        if (len > MAX_BODY) return { error: 'ESPN sent more than ' + Math.round(MAX_BODY / 1048576) + ' MB' };
        const text = await res.text();
        if (text.length > MAX_BODY) return { error: 'ESPN sent more than ' + Math.round(MAX_BODY / 1048576) + ' MB' };
        try { return { json: JSON.parse(text) }; } catch { return { error: "ESPN's answer wasn't JSON" }; }
      } catch (err) { return { error: reasonOf(err) }; }
    })();
    inflight.set(url, p);
    try {
      const v = await p;
      if (!v.error) cache.set(url, { at: now(), value: v });
      if (cache.size > 120) cache.delete(cache.keys().next().value);
      return v;
    } finally { inflight.delete(url); }
  }

  /* --- the reads ----------------------------------------------------------------------------- */

  async function readGame(league, id, hint) {
    const url = Sports.summaryUrl(league, id);
    if (!url) return { error: 'that is not a game Lumen can read' };
    const r = await getJson(url, 4000);
    if (r.error) return { error: r.error };
    const g = Sports.parseSummary(r.json, league);
    if (g.error) return g;
    const game = g.game;
    // live scores the open page also shows on its cards: the Lumen row's own reading (watch-main)
    // wins for the WatchESPN player link, which the summary never carries
    try {
      const cached = (typeof d.getGames === 'function' ? d.getGames() || [] : []).find((e) => e && e.league === league && String(e.id).replace(/^espn:/, '') === game.id);
      if (cached && typeof cached.url === 'string') game.watchUrl = cached.url;
      if (cached && Array.isArray(cached.broadcasts)) cached.broadcasts.forEach((b) => { if (typeof b === 'string' && game.broadcasts.indexOf(b) === -1 && game.broadcasts.length < 6) game.broadcasts.push(b); });
    } catch { /* the snapshot is optional */ }
    // the page's own card: its WatchESPN player link and broadcasts (checked: an ESPN player URL, short names)
    const h = hint && typeof hint === 'object' ? hint : {};
    if (!game.watchUrl && typeof h.watchUrl === 'string' && /^https:\/\/www\.espn\.com\/watch\/player[A-Za-z0-9_?=&\/.-]{1,160}$/.test(h.watchUrl)) game.watchUrl = h.watchUrl;
    if (Array.isArray(h.broadcasts)) h.broadcasts.slice(0, 4).forEach((b) => { if (typeof b === 'string' && /^[\w .+&'-]{1,30}$/.test(b) && game.broadcasts.indexOf(b) === -1 && game.broadcasts.length < 6) game.broadcasts.push(b); });
    game.watch = Sports.watchOptions({ league, broadcasts: game.broadcasts, url: game.watchUrl || '', state: game.state });
    if (league === 'nhl' && game.state === 'post' && game.status === 'final') {
      const s = await readStars(game);
      game.stars = s.stars;
      if (s.error) game.starsError = s.error;
    }
    return { game };
  }
  async function readStars(game) {
    const day = Sports.nhlDay(game.startsAt || now());
    const sc = await getJson(Sports.nhlScoreUrl(day), TTL.stars);
    if (sc.error) return { stars: null, error: "the NHL's own feed didn't answer (" + sc.error.replace(/ESPN/g, 'the NHL') + ')' };
    const nhlId = Sports.matchNhlGame(sc.json, { away: { abbr: game.away.abbr }, home: { abbr: game.home.abbr } });
    if (!nhlId) return { stars: null };
    const ld = await getJson(Sports.nhlLandingUrl(nhlId), TTL.stars);
    if (ld.error) return { stars: null, error: "the NHL's own feed didn't answer (" + ld.error.replace(/ESPN/g, 'the NHL') + ')' };
    return { stars: Sports.parseNhlStars(ld.json) };
  }
  async function readSchedule(league, id, hot) {
    const r = await getJson(Sports.scheduleUrl(league, id), hot ? TTL.scheduleHot : TTL.schedule);
    if (r.error) return { error: r.error };
    return Sports.parseSchedule(r.json, league, id);
  }
  async function readTeams(league) {
    const r = await getJson(Sports.teamsUrl(league), TTL.teams);
    if (r.error) return { error: r.error };
    return Sports.parseTeams(r.json, league);
  }
  async function readStandings(league) {
    const r = await getJson(Sports.standingsUrl(league), TTL.standings);
    if (r.error) return { error: r.error };
    return Sports.parseStandings(r.json, league);
  }
  function liveGames() {
    try { return (typeof d.getGames === 'function' ? d.getGames() || [] : []).filter((e) => e && typeof e === 'object'); } catch { return []; }
  }
  async function myTeams() {
    const live = liveGames();
    const out = await Promise.all(favs.map(async (f) => {
      const hot = live.some((e) => e.league === f.league && e.state === 'in' && ((e.home && e.home.abbr === f.abbr) || (e.away && e.away.abbr === f.abbr)));
      const s = await readSchedule(f.league, f.id, hot);
      const card = Sports.teamCard(f, s.error ? null : s, live, now());
      if (s.error) { card.error = s.error; card.offseason = false; }
      card.watch = card.live ? Sports.watchOptions({ league: f.league, broadcasts: card.live.broadcasts, url: card.live.watchUrl || '', state: 'in' }) : null;
      return card;
    }));
    return out;
  }

  /* --- the page ------------------------------------------------------------------------------ */

  function isLumenPage(url) {
    const u = String(url || '');
    return u === LUMEN_PAGE || u.indexOf(LUMEN_PAGE + '?') === 0 || u.indexOf(LUMEN_PAGE + '#') === 0;
  }
  function push(contents, msg) {
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) { pages.delete(contents); return; }
    try {
      const p = contents.executeJavaScript('window.__applySports && window.__applySports(' + JSON.stringify(msg) + ')');
      if (p && typeof p.catch === 'function') p.catch(() => pages.delete(contents));
    } catch { pages.delete(contents); }
  }
  function pushAll(msg) { for (const c of Array.from(pages)) push(c, msg); }
  function favsMsg() { return { kind: 'favs', favs: favs.slice() }; }
  async function sendMyTeams(target) {
    const teams = await myTeams();
    const msg = { kind: 'myteams', teams, at: now() };
    if (target) push(target, msg); else pushAll(msg);
  }

  async function handle(contents, verb, msg) {
    const league = typeof msg.league === 'string' ? msg.league : '';
    if (verb === 'hello') {
      trackPage(contents);
      push(contents, favsMsg());
      if (pendingOpen && now() - pendingOpen.at < OPEN_FRESH_MS) { push(contents, { kind: 'open', league: pendingOpen.league, id: pendingOpen.id }); pendingOpen = null; }
      if (favs.length) await sendMyTeams(contents);
      return;
    }
    trackPage(contents);
    if (verb === 'myteams') { await sendMyTeams(contents); return; }
    if (verb === 'game') {
      const id = Sports.cleanId(msg.id);
      const r = await readGame(league, id, msg);
      push(contents, Object.assign({ kind: 'game', league, id, at: now() }, r));
      return;
    }
    if (verb === 'team') {
      const id = Sports.cleanId(msg.id);
      const r = Sports.leagueOf(league) && id ? await readSchedule(league, id, true) : { error: 'that is not a team Lumen can read' };
      const fav = favs.find((f) => f.league === league && f.id === id);
      if (!r.error) {
        const card = Sports.teamCard(fav || { league, id, abbr: r.team.abbr, name: r.team.name, logo: r.team.logo }, r, liveGames(), now());
        r.card = card;
        if (card.live) card.watch = Sports.watchOptions({ league, broadcasts: card.live.broadcasts, url: card.live.watchUrl || '', state: 'in' });
      }
      push(contents, Object.assign({ kind: 'team', league, id, at: now() }, r));
      return;
    }
    if (verb === 'teams') {
      const r = Sports.leagueOf(league) ? await readTeams(league) : { error: 'Lumen does not know that league' };
      push(contents, Object.assign({ kind: 'teams', league }, r));
      return;
    }
    if (verb === 'standings') {
      const r = Sports.leagueOf(league) ? await readStandings(league) : { error: 'Lumen does not know that league' };
      push(contents, Object.assign({ kind: 'standings', league, at: now() }, r));
      return;
    }
    if (verb === 'fav') {
      const t = cleanTeam(msg.team, league);
      if (!t) { push(contents, { kind: 'favs', favs: favs.slice(), error: "Couldn't save that team" }); return; }
      const had = favs.findIndex((f) => f.league === t.league && f.id === t.id);
      if (msg.on === false) { if (had !== -1) favs.splice(had, 1); }
      else if (had === -1) {
        if (favs.length >= MAX_FAVS) { push(contents, { kind: 'favs', favs: favs.slice(), error: 'Lumen keeps up to ' + MAX_FAVS + ' teams; remove one first' }); return; }
        favs.push(t);
      }
      saveFavs();
      pushAll(favsMsg());
      await sendMyTeams(null);
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
    if (!/^(hello|myteams|game|team|teams|standings|fav)$/.test(verb)) return false;
    let msg = {};
    try { msg = sp === -1 ? {} : JSON.parse(rest.slice(sp + 1)); } catch { return false; }
    if (!msg || typeof msg !== 'object') return false;
    handle(contents, verb, msg).catch((err) => log('Lumen sports line failed: ' + ((err && err.message) || 'error')));
    return true;
  }
  function watchGuest(contents) {
    if (!contents || contents.isDestroyed()) return;
    contents.on('console-message', function (details) {
      const m = details && typeof details.message === 'string' ? details.message : (typeof arguments[2] === 'string' ? arguments[2] : '');
      if (m.indexOf(LINE_PREFIX) !== 0) return;
      try { handleLine(contents, m); } catch (err) { log('Lumen sports line failed: ' + ((err && err.message) || 'error')); }
    });
  }

  /**
   * A score pin was clicked: its game page in Lumen. The open Lumen tab gets it now; with none
   * open, the chrome opens one (showLumen) and the page's hello collects it.
   */
  function openGame(url) {
    const g = Sports.gameFromUrl(url);
    if (!g) return { ok: false, reason: 'not a game Lumen has a page for' };
    let live = 0;
    for (const c of Array.from(pages)) {
      try { if (c.isDestroyed() || !isLumenPage(c.getURL())) { pages.delete(c); continue; } } catch { pages.delete(c); continue; }
      push(c, { kind: 'open', league: g.league, id: g.id });
      live++;
    }
    if (!live) pendingOpen = { league: g.league, id: g.id, at: now() };
    try { if (typeof d.showLumen === 'function') d.showLumen(); } catch { /* the chrome is gone */ }
    return { ok: true, how: live ? 'lumen' : 'lumen-new' };
  }

  if (d.app && typeof d.app.on === 'function') {
    d.app.on('web-contents-created', (_e, contents) => {
      try { if (contents.getType() === 'webview') watchGuest(contents); } catch { /* died already */ }
    });
  }

  return {
    handleLine, watchGuest, openGame, isLumenPage,
    favourites: () => favs.slice(),
    // tests: what was read, and the parsed answers without a page
    _counts: () => Object.assign({}, counts), _readGame: readGame, _myTeams: myTeams, _handle: handle,
  };
}

module.exports = { create, PREFS_FILE, LINE_PREFIX, MAX_FAVS, reasonOf, cleanTeam };
