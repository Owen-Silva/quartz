'use strict';
/*
 * watch-find-main.js -- Lumen's one search box, the MAIN-process half (watch-main.js wires it).
 *
 * On Enter (quartz-watch:find {"q","seq"}), never on a keystroke, every service's OWN search:
 *   - Disney+, Hulu and Prime Video: their search page in the existing hidden reader
 *     (watch-main.js runStep: an off-screen, never-shown view on Quartz's session, destroyed
 *     the moment the step ends), ONE AT A TIME across every Lumen page, one read per service
 *     per search (watch/search/*.js say what to load and how to read it);
 *   - YouTube: the public results page, cookie-less (watch-main.js searchYouTube, its cache);
 *   - TMDB's where-to-watch, when the user has saved a key (watch-main.js searchTmdb, its cache).
 * Every answer is pushed on its own (window.__applyWatchFind), so the fastest shows at once
 * and the others fill in; nothing waits on the slowest. A service he is signed out of is not
 * read at all: the page says "Sign in to search <service>". A game, or too little memory,
 * pauses the hidden readers (said, with the reason); YouTube and TMDB still answer.
 *
 * Respect: a newer search from the same page cancels the one in flight (its reader is
 * destroyed, its late answers dropped); the same query on the same service within
 * FIND_TTL_MS is answered from memory (never from disk); two reads of one service are never
 * closer than SERVICE_GAP_MS. A row read (watch-main's queue) may run beside a search read:
 * at most two hidden views at once, both under the same memory floor.
 *
 *   out  window.__applyWatchFind({ seq, q, kind: 'start', order, services })
 *        window.__applyWatchFind({ seq, q, kind: 'service', service, answer })
 *        window.__applyWatchFind({ seq, q, kind: 'youtube', answer })
 *        window.__applyWatchFind({ seq, q, kind: 'tmdb', answer })
 *        window.__applyWatchFind({ seq, q, kind: 'done' })
 */
const Shape = require('./watch/shape');
const Find = require('./watch/find');

const FIND_TTL_MS = 5 * 60 * 1000;
const FIND_CACHE_MAX = 30;
const SERVICE_GAP_MS = 1500;

const READERS = {};
for (const id of Find.SEARCH_SERVICES) {
  try { READERS[id] = require('./watch/search/' + id); } catch (err) { READERS[id] = null; }
}
let YtChannels = null;
try { YtChannels = require('./watch/search/youtube'); } catch (err) { YtChannels = null; }

function cleanAnswer(id, raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const state = ['ok', 'empty', 'error', 'signed-out', 'paused', 'off'].indexOf(a.state) !== -1 ? a.state : 'error';
  const items = [];
  for (const it of Array.isArray(a.items) ? a.items : []) {
    const c = Shape.cleanItem(Object.assign({}, it, { kind: 'search' }));
    if (!c || c.service !== id) continue;
    c.offer = Find.OFFERS.indexOf(it.offer) !== -1 ? it.offer : '';
    items.push(c);
    if (items.length >= 40) break;
  }
  return { state: state === 'ok' && !items.length ? 'empty' : state, reason: Shape.cleanText(a.reason || '', 300), items };
}

function create(deps) {
  const d = deps || {};
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const log = typeof d.log === 'function' ? d.log : () => {};
  const push = typeof d.push === 'function' ? d.push : () => {};
  const runStep = d.runStep;
  const readers = d.readers || READERS;
  const enabled = typeof d.enabled === 'function' ? d.enabled : () => true;
  const serviceState = typeof d.serviceState === 'function' ? d.serviceState : () => '';
  const blocker = typeof d.blocker === 'function' ? d.blocker : () => '';
  const epoch = typeof d.epoch === 'function' ? d.epoch : () => 0;
  const sleep = typeof d.sleep === 'function' ? d.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const gapMs = Number.isFinite(d.gapMs) ? d.gapMs : SERVICE_GAP_MS;
  const ttlMs = Number.isFinite(d.ttlMs) ? d.ttlMs : FIND_TTL_MS;

  const cache = new Map();      // 'disney|bluey' -> { at, answer }; memory only
  const live = new Map();       // guest -> its one find in flight
  const lastRead = {};          // service -> when its last search read started
  let chain = Promise.resolve();
  let reading = '';
  let reads = 0;
  let stopped = false;

  function keyOf(id, q) { return id + '|' + Find.fold(q); }

  function cancel(contents) {
    const job = live.get(contents);
    if (!job) return;
    job.stale = true;
    try { if (job.ctrl) job.ctrl.abort(); } catch { /* gone */ }
    live.delete(contents);
  }

  function dead(job) { return stopped || job.stale || !!(job.parent && job.parent.stale); }

  function say(job, msg) {
    if (dead(job)) return;
    try { push(job.owner, Object.assign({ seq: job.seq, q: job.q }, msg)); } catch { /* the page is gone */ }
  }

  function svcName(id) { const s = Shape.serviceById(id); return s ? s.name : id; }

  /** What a service says before (or instead of) its read. null = it must be read. */
  function before(id, q, force) {
    if (!enabled(id)) return { state: 'off', reason: svcName(id) + ' is off in Settings > Lumen', items: [] };
    if (!readers[id] || typeof readers[id].steps !== 'function') return { state: 'error', reason: 'this build has no ' + svcName(id) + ' search', items: [] };
    if (serviceState(id) === 'signed-out') return { state: 'signed-out', reason: 'sign in to ' + svcName(id) + ' in Quartz to search it', items: [] };
    if (!force) {
      const hit = cache.get(keyOf(id, q));
      if (hit && now() - hit.at < ttlMs) return Object.assign({}, hit.answer, { cached: true, age: now() - hit.at });
    }
    return null;
  }

  async function readOne(job, id) {
    const reader = readers[id];
    const why = blocker();
    if (why) return { state: 'paused', reason: why, items: [] };
    const wait = (lastRead[id] || 0) + gapMs - now();
    if (wait > 0) await sleep(wait);
    if (dead(job)) return null;
    lastRead[id] = now();
    reads++;
    const gen = epoch();
    let steps = [];
    try { steps = (reader.steps(job.q) || []).filter((s) => s && typeof s.name === 'string'); } catch { steps = []; }
    const read = { now: now(), steps: {} };
    for (const step of steps) {
      if (dead(job)) return null;
      let r;
      try { r = await runStep(Object.assign({}, step, { signal: job.ctrl ? job.ctrl.signal : undefined })); } catch (err) {
        r = { ok: false, url: step.url, finalUrl: '', captures: [], error: { code: 'load-failed', detail: String((err && err.message) || err).slice(0, 120) } };
      }
      if (r && r.error && r.error.code === 'cancelled') return null;
      read.steps[step.name] = r;
    }
    if (dead(job)) return null;
    let answer;
    try { answer = cleanAnswer(id, reader.parse(read)); } catch (err) {
      answer = { state: 'error', reason: 'its search reader failed (' + String((err && err.message) || err).slice(0, 100) + ')', items: [] };
    }
    if ((answer.state === 'ok' || answer.state === 'empty') && gen === epoch()) {
      cache.set(keyOf(id, job.q), { at: now(), answer });
      while (cache.size > FIND_CACHE_MAX) cache.delete(cache.keys().next().value);
    } else if (answer.state !== 'ok' && answer.state !== 'empty') {
      // The state and reason only: never what he searched for.
      log('Lumen search on ' + svcName(id) + ' failed: ' + (answer.state === 'signed-out' ? 'signed out' : answer.reason));
    }
    return answer;
  }

  /** The hidden-reader part of one find: its services, one at a time, after any other find's. */
  function readAll(job, ids) {
    const mine = chain.then(async () => {
      for (const id of ids) {
        if (dead(job)) return;
        reading = id;
        say(job, { kind: 'service', service: id, answer: { state: 'loading', reason: '', items: [] } });
        let a = null;
        try { a = await readOne(job, id); } catch (err) { a = { state: 'error', reason: String((err && err.message) || err).slice(0, 160), items: [] }; }
        reading = '';
        if (a) say(job, { kind: 'service', service: id, answer: a });
      }
    }).catch((err) => { log('Lumen search reader error: ' + ((err && err.message) || err)); }).then(() => { reading = ''; });
    chain = mine;
    return mine;
  }

  /**
   * One find. opts.only: one service again (its Retry), skipping YouTube, TMDB and the rest;
   * opts.force: past the cache. -> a promise that settles when every part has answered.
   */
  function run(q, seq, contents, opts) {
    const o = opts || {};
    const owner = contents || null;
    const cur = owner ? live.get(owner) : null;
    // A Retry of one service rides beside the find it belongs to (and is cancelled with it);
    // anything else replaces the find in flight.
    const parent = o.only && cur && cur.q === q ? cur : null;
    const job = { q, seq, owner, stale: false, parent, gen: epoch(), ctrl: parent ? parent.ctrl : (typeof AbortController === 'function' ? new AbortController() : null) };
    if (stopped) return Promise.resolve();
    if (owner && !parent) { cancel(owner); live.set(owner, job); }
    const only = o.only && Find.SEARCH_SERVICES.indexOf(o.only) !== -1 ? o.only : '';
    const ids = only ? [only] : Find.SEARCH_SERVICES.slice();
    // The services he is signed into read first: their chip leads, so their answer should too.
    const rank = (id) => (serviceState(id) === 'ok' ? 0 : 1);
    ids.sort((a, b) => rank(a) - rank(b) || Find.SEARCH_SERVICES.indexOf(a) - Find.SEARCH_SERVICES.indexOf(b));
    const services = {};
    const toRead = [];
    for (const id of ids) {
      const pre = before(id, q, !!o.force);
      if (pre) services[id] = pre;
      else { services[id] = { state: 'queued', reason: '', items: [] }; toRead.push(id); }
    }
    say(job, { kind: 'start', order: ids, only, services });
    const parts = [];
    if (!only) {
      if (typeof d.youtube === 'function') {
        parts.push(Promise.resolve().then(() => d.youtube(q, job)).then((a) => {
          const ans = a && typeof a === 'object' ? a : { ok: false, state: 'error', reason: 'YouTube search returned nothing', items: [] };
          if (ans.state === 'cancelled') return;
          say(job, { kind: 'youtube', answer: ans });
        }, (err) => say(job, { kind: 'youtube', answer: { ok: false, state: 'error', reason: String((err && err.message) || err).slice(0, 160), items: [] } })));
      }
      if (typeof d.tmdb === 'function') {
        parts.push(Promise.resolve().then(() => d.tmdb(q, job)).then((a) => {
          if (a && a.reason === 'cancelled') return;
          say(job, { kind: 'tmdb', answer: a || { state: 'error', reason: 'TMDB search returned nothing', results: [] } });
        }, (err) => say(job, { kind: 'tmdb', answer: { state: 'error', reason: String((err && err.message) || err).slice(0, 160), results: [] } })));
      }
    }
    if (toRead.length) parts.push(readAll(job, toRead));
    return Promise.all(parts).then(() => {
      say(job, { kind: 'done', only });
      if (owner && live.get(owner) === job) live.delete(owner);
    });
  }

  function forget() { cache.clear(); }
  function stop() {
    stopped = true;
    for (const c of Array.from(live.keys())) cancel(c);
    cache.clear();
  }
  function state() { return { cache: cache.size, live: live.size, reading, reads }; }

  return { run, cancel, forget, stop, state };
}

/** The channels on YouTube's results page (the same HTML the videos come from). */
function channelsFrom(html) {
  if (!YtChannels) return [];
  try { return YtChannels.parseChannels(html); } catch { return []; }
}

module.exports = { create, channelsFrom, cleanAnswer, FIND_TTL_MS, SERVICE_GAP_MS };
