'use strict';
/*
 * watch-shows-main.js -- Lumen's show pages, the MAIN-process half (watch-main.js wires it).
 *
 *   watch/shows/model.js        the SHOW shape, the big button, what an episode plays (pure, shared)
 *   watch/shows/<service>.js    one tolerant reader per service: what to load, how to read it (pure)
 *   watch/shows/tmdb.js         TMDB's seasons and episodes, the fallback (pure)
 *   watch-shows-main.js         this file: runs those reads for the page, keeps a small memory cache
 *   watch/showpage.js           the page, drawn inside Lumen (watch.html)
 *
 * A tile's click asks (quartz-watch:show) for one title. Its service's own title page loads in
 * watch-main's hidden reader (runStep: an off-screen, muted, never-shown view on Quartz's session,
 * destroyed the moment the step ends), read-only, as the service's page would; TMDB's season and
 * episode data is fetched beside it (cookie-less, only with the user's saved key) and fills what the
 * service did not say. A reader that fails, a service they are signed out of or turned off, or a game
 * or low memory (the same gates as every Lumen read) answers with TMDB's data and the reason, so
 * the page is never blank and never silent. A title on none of his services (service '') is
 * TMDB-only: where it streams, from JustWatch via TMDB.
 *
 * Respect: one show read at a time per page (a newer ask cancels the older one's reader); the
 * same title within SHOW_TTL_MS is answered from memory (never written to disk); nothing polls.
 *
 *   in   quartz-watch:show {"what":"show","seq","service","type","id","url","title","year","tmdbId","tmdbType","force"}
 *        quartz-watch:show {"what":"season","seq","key","service","id","n","tmdbId","url"}
 *   out  window.__applyWatchShow({ what, seq, key, state, reason, show, providers, watchLink, attribution,
 *                                  tmdbState, tmdbReason, tmdbId, tmdbType, partial })
 *        state: 'ok' | 'fallback' | 'signed-out' | 'off' | 'paused' | 'error' | 'elsewhere'
 */
const Shape = require('./watch/shape');
const Model = require('./watch/shows/model');
const TmdbShows = require('./watch/shows/tmdb');

const SHOW_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 20;
const READERS = {};
for (const id of Model.SERVICES) {
  try { READERS[id] = require('./watch/shows/' + id); } catch (err) { READERS[id] = null; }
}

function int(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi ? v : null; }
function txt(v, max) { return typeof v === 'string' ? Shape.cleanText(v, max) : ''; }

/** One page line -> a clean request, or null. */
function cleanLine(msg) {
  const m = msg && typeof msg === 'object' && !Array.isArray(msg) ? msg : null;
  if (!m) return null;
  const seq = int(m.seq, 0, 1e9) || 0;
  const service = Model.SERVICES.indexOf(m.service) !== -1 ? m.service : '';
  const id = typeof m.id === 'string' && /^[A-Za-z0-9_:.-]{1,120}$/.test(m.id) ? m.id : '';
  const tmdbId = int(m.tmdbId, 1, 1e9) || 0;
  const tmdbType = m.tmdbType === 'tv' || m.tmdbType === 'movie' ? m.tmdbType : '';
  if (m.what === 'season') {
    const n = int(m.n, 0, 200);
    if (n === null || (!service && !tmdbId)) return null;
    const url = Shape.cleanHttps(m.url);
    return { what: 'season', seq, key: txt(m.key, 200), service, id, n, tmdbId, url: url && Model.svcOfUrl(url) === service ? url : '' };
  }
  if (m.what !== 'show') return null;
  const title = txt(m.title, 200);
  if (service && !id) return null;
  if (!service && !tmdbId && !title) return null;
  const url = Shape.cleanHttps(m.url);
  return {
    what: 'show', seq, service, id, title, tmdbId, tmdbType, force: m.force === true,
    type: m.type === 'movie' ? 'movie' : m.type === 'show' ? 'show' : '',
    url: url && Model.svcOfUrl(url) === service ? url : '',
    year: int(m.year, 1880, 2100),
  };
}

function keyOf(req) {
  if (req.service) return req.service + ':' + req.id;
  if (req.tmdbId) return 'tmdb:' + (req.tmdbType || '') + req.tmdbId;
  return 'tmdb:' + req.title.toLowerCase() + (req.year ? '|' + req.year : '');
}

function create(deps) {
  const d = deps || {};
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const log = typeof d.log === 'function' ? d.log : () => {};
  const readers = Object.assign({}, READERS, d.readers || {});
  const push = typeof d.push === 'function' ? d.push : () => {};
  const ttl = Number.isFinite(d.ttlMs) ? d.ttlMs : SHOW_TTL_MS;
  const cache = new Map();          // key -> { at, answer }
  const live = new Map();           // guest -> { ctrl, seq }
  let stopped = false;
  let reads = 0;

  const svcName = (id) => Model.serviceName(id);
  const tmdbKey = () => (typeof d.tmdbKey === 'function' ? d.tmdbKey() : '') || '';
  const fetchJson = (u, h) => (typeof d.fetchJson === 'function' ? d.fetchJson(u, h) : Promise.resolve({ status: 0, json: null, error: { code: 'load-failed', detail: 'no fetch' } }));

  function gate(service) {
    if (typeof d.enabled === 'function' && !d.enabled(service)) return { state: 'off', reason: svcName(service) + ' is off in Settings > Lumen' };
    const st = typeof d.serviceState === 'function' ? d.serviceState(service) : '';
    if (st === 'signed-out') return { state: 'signed-out', reason: 'you’re signed out of ' + svcName(service) + ' in Quartz' };
    const b = typeof d.blocker === 'function' ? d.blocker() : '';
    if (b) return { state: 'paused', reason: 'Lumen’s reader is ' + b };
    return null;
  }

  async function runReader(req, signal) {
    const r = readers[req.service];
    if (!r || typeof r.steps !== 'function' || typeof r.parse !== 'function') return { state: 'error', reason: 'this build has no show reader for ' + svcName(req.service), show: null };
    let steps = [];
    try { steps = (r.steps(req) || []).filter((s) => s && typeof s.name === 'string'); } catch (err) { steps = []; }
    if (!steps.length) return { state: 'error', reason: 'Lumen has no page to read for this title', show: null };
    const read = { now: now(), steps: {} };
    for (const step of steps) {
      if (signal.aborted || stopped) return null;
      let res;
      try { res = await d.runStep(Object.assign({}, step, { signal })); } catch (err) {
        res = { url: step.url, finalUrl: step.url, extracted: null, captures: [], error: { code: 'load-failed', detail: String((err && err.message) || err).slice(0, 120) } };
      }
      if (res && res.error && res.error.code === 'cancelled') return null;
      read.steps[step.name] = res || {};
    }
    reads += 1;
    let out;
    try { out = r.parse(read, req); } catch (err) { out = { state: 'error', reason: 'its reader failed (' + String((err && err.message) || err).slice(0, 100) + ')', show: null }; }
    return out && typeof out === 'object' ? out : { state: 'error', reason: 'its reader returned nothing', show: null };
  }

  async function runTmdb(req) {
    const key = tmdbKey();
    if (!key) return { state: 'no-key', reason: 'add the free TMDB key in Settings > Lumen to see episodes when a service can’t be read' };
    try { return await TmdbShows.lookup(req, key, fetchJson, { region: 'US' }); } catch (err) {
      return { state: 'error', reason: 'the TMDB lookup failed (' + String((err && err.message) || err).slice(0, 100) + ')' };
    }
  }

  function tmdbFields(t) {
    return {
      tmdbState: t ? String(t.state || '') : '', tmdbReason: t && t.state !== 'ok' ? txt(t.reason, 240) : '',
      providers: t && t.state === 'ok' && Array.isArray(t.providers) ? t.providers.slice(0, 16) : [],
      watchLink: t && t.state === 'ok' ? (t.watchLink || '') : '', attribution: t && t.state === 'ok' ? TmdbShows.ATTRIBUTION : '',
      tmdbId: t && t.state === 'ok' ? t.tmdbId : 0, tmdbType: t && t.state === 'ok' ? t.mediaType : '',
    };
  }

  /** TMDB's show dressed as the service's title: its page, its name, no progress (said). */
  function asFallback(req, tshow, why) {
    const s = Object.assign({}, tshow, { service: req.service, id: req.id || tshow.id, url: req.url || tshow.url, source: 'tmdb', progressKnown: false });
    s.notes = [why].concat(tshow.notes || []);
    return Model.cleanShow(s);
  }

  function compose(req, svcRes, gated, t) {
    const base = Object.assign({ what: 'show', key: keyOf(req) }, tmdbFields(t));
    const tShow = t && t.state === 'ok' ? t.show : null;
    if (!req.service) {
      if (!tShow) return Object.assign(base, { state: 'error', reason: t ? txt(t.reason, 240) : 'nothing to look up', show: null });
      return Object.assign(base, { state: 'elsewhere', reason: '', show: Model.cleanShow(tShow) });
    }
    const name = svcName(req.service);
    if (gated) {
      return Object.assign(base, { state: gated.state, reason: gated.reason,
        show: tShow ? asFallback(req, tShow, 'Episodes from TMDB: ' + gated.reason + ', so your progress isn’t shown') : null });
    }
    if (svcRes && svcRes.state === 'ok' && svcRes.show) {
      const merged = tShow ? Model.mergeTmdb(svcRes.show, tShow) : Model.cleanShow(svcRes.show);
      if (merged && tShow && merged.seasons.some((x) => x.fromTmdb)) merged.notes = merged.notes.concat(['Seasons marked TMDB came from TMDB: ' + name + ' didn’t send them, so there’s no progress there']).slice(0, 6);
      if (merged) return Object.assign(base, { state: 'ok', reason: '', show: merged });
    }
    const reason = svcRes ? txt(svcRes.reason, 240) || 'its reader returned nothing' : 'its reader returned nothing';
    const state = svcRes && svcRes.state === 'signed-out' ? 'signed-out' : tShow ? 'fallback' : 'error';
    return Object.assign(base, { state, reason, picker: !!(svcRes && svcRes.picker),
      show: tShow ? asFallback(req, tShow, 'Couldn’t read ' + name + ' (' + reason + '): episodes are from TMDB and your progress isn’t shown') : null });
  }

  async function runShow(contents, req) {
    const key = keyOf(req);
    const hit = cache.get(key);
    if (hit && !req.force && now() - hit.at < ttl) {
      push(contents, Object.assign({}, hit.answer, { seq: req.seq, cached: true }));
      return;
    }
    const prev = live.get(contents);
    if (prev) { try { prev.ctrl.abort(); } catch { /* gone */ } }
    const ctrl = new AbortController();
    const job = { ctrl, seq: req.seq };
    live.set(contents, job);
    try {
      const gated = req.service ? gate(req.service) : null;
      let tDone = null;
      const tP = runTmdb(req).then((t) => { tDone = t; return t; });
      let svcRes = null;
      if (req.service && !gated) {
        // TMDB usually lands first: the page can draw the synopsis and episodes while the reader works
        tP.then((t) => {
          if (svcRes || ctrl.signal.aborted || !t || t.state !== 'ok') return;
          push(contents, Object.assign({ what: 'show', seq: req.seq, key, state: 'loading', reason: '', partial: true, show: asFallback(req, t.show, 'Reading ' + svcName(req.service) + '…') }, tmdbFields(t)));
        });
        svcRes = await runReader(req, ctrl.signal);
        if (svcRes === null) return;   // cancelled by a newer ask: nothing to say
      }
      const t = tDone || await tP;
      if (ctrl.signal.aborted || stopped) return;
      const answer = compose(req, svcRes, gated, t);
      answer.at = now();
      if (answer.state === 'ok' || answer.state === 'elsewhere') {
        cache.set(key, { at: now(), answer });
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      }
      if (answer.state !== 'ok' && answer.state !== 'elsewhere') log('Lumen show page for ' + svcName(req.service) + ': ' + answer.state + (answer.reason ? ' (' + answer.reason.slice(0, 120) + ')' : ''));
      push(contents, Object.assign({ seq: req.seq }, answer));
    } finally {
      if (live.get(contents) === job) live.delete(contents);
    }
  }

  async function runSeason(contents, req) {
    const base = { what: 'season', seq: req.seq, key: req.key, n: req.n };
    // Prime: every season is its own detail page, read like the first one.
    if (req.service === 'prime' && req.url && !gate('prime')) {
      const m = /\/detail\/([A-Za-z0-9]{8,40})/.exec(req.url);
      if (m) {
        const ctrl = new AbortController();
        const r = await runReader({ service: 'prime', type: 'show', id: m[1], title: '', year: null }, ctrl.signal);
        const s = r && r.state === 'ok' && r.show ? Model.cleanShow(r.show) : null;
        const season = s ? s.seasons.filter((x) => x.n === req.n && x.episodes.length)[0] : null;
        if (season) { push(contents, Object.assign(base, { state: 'ok', reason: '', season, source: 'service' })); return; }
        if (!req.tmdbId) { push(contents, Object.assign(base, { state: 'error', reason: r && r.reason ? r.reason : 'Prime Video sent no episodes for that season', season: null })); return; }
      }
    }
    if (!req.tmdbId) { push(contents, Object.assign(base, { state: 'none', reason: svcName(req.service) + ' didn’t send this season to Lumen' + (tmdbKey() ? '' : ', and there’s no TMDB key to fill it in'), season: null })); return; }
    const key = tmdbKey();
    if (!key) { push(contents, Object.assign(base, { state: 'none', reason: 'no TMDB key', season: null })); return; }
    const r = await TmdbShows.season(req.tmdbId, req.n, key, fetchJson);
    push(contents, Object.assign(base, { state: r.state === 'ok' ? 'ok' : 'error', reason: txt(r.reason, 240), season: r.season, source: 'tmdb' }));
  }

  function line(contents, req) {
    if (stopped || !req) return;
    const p = req.what === 'season' ? runSeason(contents, req) : runShow(contents, req);
    p.catch((err) => {
      log('Lumen show page failed: ' + String((err && err.message) || err).slice(0, 160));
      push(contents, { what: req.what, seq: req.seq, key: req.key || keyOf(req), state: 'error', reason: 'Lumen’s show page hit an internal error (' + String((err && err.message) || err).slice(0, 100) + ')', show: null, season: null });
    });
  }

  function dropGuest(contents) {
    const j = live.get(contents);
    if (j) { try { j.ctrl.abort(); } catch { /* gone */ } live.delete(contents); }
  }

  return {
    line, dropGuest,
    forget: () => cache.clear(),
    stop: () => { stopped = true; for (const j of live.values()) { try { j.ctrl.abort(); } catch { /* gone */ } } live.clear(); },
    state: () => ({ cached: cache.size, live: live.size, reads }),
  };
}

module.exports = { create, cleanLine, keyOf, SHOW_TTL_MS };
