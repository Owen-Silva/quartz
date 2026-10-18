'use strict';
/*
 * watch/ytlib-main.js -- runs watch/ytlib.js's reads for the Lumen page: the Subscriptions feed,
 * a channel's Videos tab, the Library and one playlist. Main process; watch-main.js creates one.
 *
 * ONE HIDDEN READER AT A TIME, as everywhere in Lumen: every read goes through watch-main's own
 * runStep (the same off-screen, muted, image-less view on his session, the same watchdog), and
 * watch-main takes this module's lock (acquire / release) around each of its service reads, so a
 * library read only ever runs between two service reads, never beside one. A read the page asks
 * for (a channel, the Library) goes to the front of this small queue; the Subscriptions refresh
 * that follows a YouTube read waits its turn.
 *
 * WHEN THE FEED READS: the page asks once when it loads (cache first: the answer is the last read,
 * then a read if it is over SUBS_FRESH_MS old); a new visit (Lumen back on screen after
 * ytlib.VISIT_GAP_MS away) reads it if it is that old; and every YouTube read that lands fine
 * (Lumen's own schedule, its background refresh included) is followed by one Subscriptions read
 * if the feed is over SUBS_AFTER_YT_MS old -- "one more page load per YouTube read". It never
 * reads while a game runs, under watch-main's free-memory floor, with YouTube off in Settings, or
 * before watch-main's boot grace is over; the page shows why (paused) instead.
 *
 * KEPT: <userData>/watch-ytlib.json holds the feed and the Library (the reduced tiles only) and
 * the "new since you last opened Lumen" marks (ytlib.js: when each video was first seen, the end
 * of the last visit, what he played from Lumen). Channels and playlists stay in memory only.
 * Lumen's Forget deletes the file.
 *
 * TO THE PAGE: window.__applyWatchYt(answer), answer = { what: 'subs' | 'library' | 'channel' |
 * 'playlist', key, seq, state: 'ok' | 'signed-out' | 'error' | 'never', reason, readAt, lastOkAt,
 * refreshing, paused, ...what's own fields }.
 */
const fs = require('fs');
const L = require('./ytlib');

const SUBS_FRESH_MS = 10 * 60e3;
const SUBS_AFTER_YT_MS = 5 * 60e3;
const PAGE_FRESH_MS = 10 * 60e3;
const MEM_CAP = 12;
const SAVE_DELAY_MS = 800;

function blankEntry() { return { state: 'never', reason: '', readAt: 0, lastOkAt: 0 }; }

function cleanTiles(list, cap) {
  return (Array.isArray(list) ? list : []).filter((it) => it && typeof it === 'object' && L.isVideoId(it.vid) && typeof it.url === 'string').slice(0, cap);
}

function cleanEntry(raw, extra) {
  const e = blankEntry();
  const r = raw && typeof raw === 'object' ? raw : {};
  if (['ok', 'signed-out', 'error'].indexOf(r.state) !== -1) e.state = r.state;
  e.reason = typeof r.reason === 'string' ? r.reason.slice(0, 300) : '';
  e.readAt = Number.isFinite(r.readAt) ? r.readAt : 0;
  e.lastOkAt = Number.isFinite(r.lastOkAt) ? r.lastOkAt : 0;
  if (extra) extra(e, r);
  return e;
}

function cleanFile(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    v: 1,
    subs: cleanEntry(r.subs, (e, x) => {
      e.items = cleanTiles(x.items, L.CAPS.subs);
      e.shortsHidden = Number.isInteger(x.shortsHidden) ? x.shortsHidden : 0;
      e.empty = x.empty === true;
    }),
    library: cleanEntry(r.library, (e, x) => {
      for (const k of ['wl', 'll']) {
        const p = x[k] && typeof x[k] === 'object' ? x[k] : null;
        e[k] = p ? { state: p.state === 'ok' ? 'ok' : (p.state === 'error' ? 'error' : 'never'), reason: String(p.reason || '').slice(0, 300), items: cleanTiles(p.items, L.CAPS.shelf), playlist: p.playlist && typeof p.playlist === 'object' ? p.playlist : null } : null;
      }
      const pl = x.playlists && typeof x.playlists === 'object' ? x.playlists : null;
      e.playlists = pl ? { state: pl.state === 'ok' ? 'ok' : (pl.state === 'error' ? 'error' : 'never'), reason: String(pl.reason || '').slice(0, 300),
        items: (Array.isArray(pl.items) ? pl.items : []).filter((p) => p && L.isPlaylistId(p.id)).slice(0, L.CAPS.playlists), empty: pl.empty === true } : null;
    }),
    mark: L.cleanStore(r.mark),
  };
}

function create(o) {
  const opt = o || {};
  const runStep = opt.runStep;
  const now = typeof opt.now === 'function' ? opt.now : () => Date.now();
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const filePath = typeof opt.file === 'function' ? opt.file : () => '';
  const push = typeof opt.push === 'function' ? opt.push : () => {};
  const canRead = typeof opt.canRead === 'function' ? opt.canRead : () => '';
  const bootLeft = typeof opt.bootLeft === 'function' ? opt.bootLeft : () => 0;
  // Is a Lumen page on screen (watch-main's anyVisible)? The same gate its own service reads use.
  const visible = typeof opt.visible === 'function' ? opt.visible : () => true;
  const setTimer = typeof opt.setTimeout === 'function' ? opt.setTimeout : setTimeout;
  const clearTimer = typeof opt.clearTimeout === 'function' ? opt.clearTimeout : clearTimeout;

  let data = null;
  let stopped = false;
  let busy = false;          // a read of ours is running
  let held = false;          // watch-main is reading a service
  const waiters = [];        // watch-main's next read, waiting for ours to end
  const jobs = [];
  const attached = new Set();   // pages that drew the Subscriptions row (they asked)
  const mem = new Map();        // 'channel:/@x' | 'playlist:PL..' -> entry
  const paused = {};            // key -> why its last read did not start
  let current = '';
  let epoch = 0;
  let bootTimer = null;
  let saveTimer = null;
  let reads = 0;

  /* --- the file ------------------------------------------------------------------- */

  function load() {
    if (data) return data;
    const f = filePath();
    let raw = null;
    if (f) { try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { raw = null; } }
    data = cleanFile(raw);
    return data;
  }
  function saveNow() {
    if (saveTimer) { clearTimer(saveTimer); saveTimer = null; }
    const f = filePath();
    if (!f || !data) return;
    const out = { v: 1, subs: data.subs, library: data.library, mark: { seen: data.mark.seen, played: data.mark.played, baseline: data.mark.baseline, cutoff: data.mark.cutoff, lastOffAt: data.mark.lastOffAt } };
    try {
      fs.writeFileSync(f + '.tmp', JSON.stringify(out));
      fs.renameSync(f + '.tmp', f);
    } catch (err) { log('Lumen could not save its YouTube library cache: ' + ((err && err.message) || err)); }
  }
  function saveSoon() {
    if (saveTimer || stopped) return;
    saveTimer = setTimer(() => { saveTimer = null; saveNow(); }, SAVE_DELAY_MS);
    if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  /* --- answers -------------------------------------------------------------------- */

  function queued(key) { return jobs.some((j) => j.key === key); }
  function flags(key) { return { refreshing: current === key || queued(key), paused: current === key ? '' : (paused[key] || '') }; }

  function subsAnswer() {
    const d = load();
    const s = d.subs;
    const items = s.items || [];
    const fresh = L.newIds(d.mark, items);
    const isNew = new Set(fresh);
    return Object.assign({
      what: 'subs', key: 'subs', seq: 0, state: s.state, reason: s.reason, readAt: s.readAt, lastOkAt: s.lastOkAt,
      items: items.map((it) => Object.assign({}, it, { isNew: isNew.has(it.vid) })),
      newCount: fresh.length, shortsHidden: s.shortsHidden || 0, empty: !!s.empty, cutoff: d.mark.cutoff, at: now(),
    }, flags('subs'));
  }

  function libraryAnswer() {
    const l = load().library;
    return Object.assign({ what: 'library', key: 'library', seq: 0, state: l.state, reason: l.reason, readAt: l.readAt, lastOkAt: l.lastOkAt,
      wl: l.wl || null, ll: l.ll || null, playlists: l.playlists || null, at: now() }, flags('library'));
  }

  function memAnswer(key, seq) {
    const e = mem.get(key) || blankEntry();
    const what = key.slice(0, key.indexOf(':'));
    const out = Object.assign({ what, key, seq: seq || 0, state: e.state, reason: e.reason, readAt: e.readAt, lastOkAt: e.lastOkAt,
      items: e.items || [], at: now() }, flags(key));
    if (what === 'channel') { out.channel = e.channel || null; out.shortsHidden = e.shortsHidden || 0; out.path = key.slice(8); }
    else { out.playlist = e.playlist || null; out.id = key.slice(9); }
    return out;
  }

  function pushSubs() { for (const c of Array.from(attached)) push(c, subsAnswer()); }
  function pushLibrary() { for (const c of Array.from(attached)) push(c, libraryAnswer()); }

  function answerJob(job) {
    if (job.key === 'subs') pushSubs();
    else if (job.key === 'library') pushLibrary();
    else for (const w of job.askers) push(w.contents, memAnswer(job.key, w.seq));
  }

  /* --- the queue ------------------------------------------------------------------ */

  function enqueue(key, front, asker, anyTime) {
    if (stopped) return;
    let job = jobs.find((j) => j.key === key);
    if (!job) {
      job = { key, askers: [], anyTime: !!anyTime };
      if (front) jobs.unshift(job); else jobs.push(job);
    } else if (front && jobs.indexOf(job) > 0) {
      jobs.splice(jobs.indexOf(job), 1);
      jobs.unshift(job);
    }
    if (asker) {
      const had = job.askers.find((a) => a.contents === asker.contents);
      if (had) had.seq = asker.seq; else job.askers.push(asker);
    }
    pump();
  }

  function stepsFor(key) {
    if (key === 'subs') return L.subsSteps();
    if (key === 'library') return L.librarySteps();
    if (key.indexOf('channel:') === 0) return L.channelSteps(key.slice(8));
    if (key.indexOf('playlist:') === 0) return L.playlistSteps(key.slice(9));
    return [];
  }

  async function runJob(job) {
    const gen = epoch;
    const steps = stepsFor(job.key);
    const read = { now: now(), steps: {} };
    for (const step of steps) {
      if (stopped || gen !== epoch) return;
      let r;
      try { r = await runStep(step); } catch (err) {
        r = { ok: false, url: step.url, finalUrl: '', status: 0, extracted: null, error: { code: 'load-failed', detail: String((err && err.message) || err).slice(0, 120) } };
      }
      read.steps[step.name] = r;
      if (r && r.error && r.error.code === 'offline') break;
      // Signed out on the first page: the others would only say so again.
      if (job.key === 'library' && L._internals.stepData(r).status === 'signed-out') break;
    }
    if (stopped || gen !== epoch) return;
    reads++;
    const t = now();
    if (job.key === 'subs') {
      const res = L.parseSubs(read);
      const s = load().subs;
      s.readAt = t;
      s.state = res.state;
      s.reason = res.reason || '';
      if (res.state === 'ok') {
        s.items = res.items;
        s.shortsHidden = res.shortsHidden || 0;
        s.empty = !!res.empty;
        s.lastOkAt = t;
        L.noteSeen(load().mark, res.items, t);
      } else if (res.state === 'signed-out') {
        s.items = []; s.empty = false; s.shortsHidden = 0;
      } else log('Lumen could not read YouTube Subscriptions: ' + s.reason);
      saveSoon();
    } else if (job.key === 'library') {
      const res = L.parseLibrary(read);
      const l = load().library;
      l.readAt = t;
      l.state = res.state;
      l.reason = res.reason || '';
      if (res.state === 'ok') {
        // A shelf that failed this time keeps its last good tiles, with its own reason.
        for (const k of ['wl', 'll']) {
          const part = res[k];
          const was = l[k];
          l[k] = part.state === 'ok' || !was ? { state: part.state, reason: part.reason || '', items: part.items, playlist: part.playlist || null }
            : Object.assign({}, was, { state: 'error', reason: part.reason || '' });
        }
        const pl = res.playlists;
        l.playlists = pl.state === 'ok' || !l.playlists ? { state: pl.state, reason: pl.reason || '', items: pl.items, empty: !!pl.empty }
          : Object.assign({}, l.playlists, { state: 'error', reason: pl.reason || '' });
        l.lastOkAt = t;
      } else if (res.state === 'signed-out') {
        l.wl = null; l.ll = null; l.playlists = null;
      } else log('Lumen could not read the YouTube Library: ' + l.reason);
      saveSoon();
    } else {
      const isChannel = job.key.indexOf('channel:') === 0;
      const res = isChannel ? L.parseChannel(read, job.key.slice(8)) : L.parsePlaylist(read, job.key.slice(9));
      const was = mem.get(job.key);
      const e = Object.assign(blankEntry(), was || {});
      e.readAt = t;
      e.state = res.state;
      e.reason = res.reason || '';
      if (res.state === 'ok') {
        e.items = res.items;
        e.lastOkAt = t;
        if (isChannel) { e.channel = res.channel; e.shortsHidden = res.shortsHidden || 0; } else e.playlist = res.playlist;
      } else if (res.state === 'signed-out') {
        e.items = [];
      } else if (!was && isChannel) e.channel = res.channel || null;
      mem.delete(job.key);
      mem.set(job.key, e);
      while (mem.size > MEM_CAP) mem.delete(mem.keys().next().value);
      if (res.state !== 'ok') log('Lumen could not read a YouTube ' + (isChannel ? 'channel' : 'playlist') + ': ' + (res.state === 'signed-out' ? 'signed out' : e.reason));
    }
  }

  async function pump() {
    if (busy || held || stopped || !jobs.length) return;
    const left = bootLeft();
    if (left > 0) {
      if (!bootTimer) {
        bootTimer = setTimer(() => { bootTimer = null; pump(); }, left);
        if (bootTimer && typeof bootTimer.unref === 'function') bootTimer.unref();
      }
      return;
    }
    // Like watch-main's own reads, nothing reads while no Lumen page is on screen (a background
    // tab, a hidden window): the job waits, and sight(true) starts it. Only the one feed read that
    // follows a YouTube read (afterRead, the road Lumen's background refresh takes) may run then.
    let at = 0;
    if (!visible()) { at = jobs.findIndex((j) => j.anyTime); if (at === -1) return; }
    const job = jobs.splice(at, 1)[0];
    let why = '';
    try { why = canRead() || ''; } catch (err) { why = 'Lumen could not check whether it may read (' + String((err && err.message) || err).slice(0, 80) + ')'; }
    if (why) {
      paused[job.key] = why;
      answerJob(job);
      Promise.resolve().then(pump);
      return;
    }
    delete paused[job.key];
    busy = true;
    current = job.key;
    answerJob(job);    // "Refreshing"
    try {
      await runJob(job);
    } catch (err) {
      log('Lumen YouTube library read failed: ' + ((err && err.message) || err));
    } finally {
      busy = false;
      current = '';
      if (!stopped) answerJob(job);
      if (waiters.length) { held = true; waiters.shift()(); } else Promise.resolve().then(pump);
    }
  }

  /* --- watch-main's side of the lock --------------------------------------------------- */

  /** Before each service read: resolves once no read of ours is running, with the lock held. */
  function acquire() {
    if (!busy && !held) { held = true; return Promise.resolve(); }
    return new Promise((r) => waiters.push(r));
  }
  /** After each service read. */
  function release() {
    if (!held) return;
    held = false;
    if (waiters.length) { held = true; waiters.shift()(); return; }
    pump();
  }

  /* --- what watch-main tells it ----------------------------------------------------------- */

  function fresh(e, ms) { return !!e && e.state !== 'never' && e.readAt && now() - e.readAt < ms; }

  /** A quartz-watch:yt line, already checked by ytlib.cleanLine. */
  function line(contents, req) {
    if (!req || stopped) return;
    const force = !!req.force;
    switch (req.op) {
      case 'subs':
        attached.add(contents);
        if (force || !fresh(load().subs, SUBS_FRESH_MS)) enqueue('subs', force);
        push(contents, subsAnswer());
        break;
      case 'library':
        attached.add(contents);
        if (force || !fresh(load().library, PAGE_FRESH_MS)) enqueue('library', true);
        push(contents, libraryAnswer());
        break;
      case 'channel': case 'playlist': {
        const key = req.op === 'channel' ? 'channel:' + req.path : 'playlist:' + req.id;
        const e = mem.get(key);
        const asker = { contents, seq: req.seq };
        const need = force || !fresh(e, PAGE_FRESH_MS);
        if (need) enqueue(key, true, asker);
        push(contents, memAnswer(key, req.seq));
        break;
      }
      case 'played':
        if (L.notePlayed(load().mark, req.id, now())) { saveSoon(); pushSubs(); }
        break;
      default: break;
    }
  }

  /** Any Lumen page on screen (true) or none (false). A new visit moves "new since". */
  function sight(on) {
    if (stopped) return;
    const visit = L.sight(load().mark, !!on, now());
    if (!on) { saveSoon(); return; }
    if (visit) {
      saveSoon();
      pushSubs();
      if (attached.size && !fresh(load().subs, SUBS_FRESH_MS)) enqueue('subs', false);
    }
    pump();   // what waited while Lumen was off screen
  }

  /** watch-main read a service (state: its new state). After YouTube: the feed follows it. */
  function afterRead(id, state) {
    if (stopped || id !== 'youtube') return;
    if (state === 'signed-out') {
      const d = load();
      let changed = false;
      if (d.subs.state !== 'signed-out') { Object.assign(d.subs, { state: 'signed-out', reason: 'sign in to YouTube to see your subscriptions', items: [], empty: false, shortsHidden: 0, readAt: now() }); changed = true; }
      if (d.library.state !== 'never' && d.library.state !== 'signed-out') { Object.assign(d.library, { state: 'signed-out', reason: 'sign in to YouTube to see your library', wl: null, ll: null, playlists: null, readAt: now() }); changed = true; }
      if (changed) { saveSoon(); pushSubs(); pushLibrary(); }
      return;
    }
    if (state === 'ok' && attached.size && !fresh(load().subs, SUBS_AFTER_YT_MS)) enqueue('subs', false, null, true);
  }

  function dropGuest(contents) { attached.delete(contents); }

  function forget() {
    epoch++;
    jobs.length = 0;
    mem.clear();
    data = cleanFile(null);
    const f = filePath();
    if (f) { try { fs.unlinkSync(f); } catch { /* none */ } }
    if (saveTimer) { clearTimer(saveTimer); saveTimer = null; }
    pushSubs();
  }

  function stop() {
    if (stopped) return;
    if (data && data.mark.on) { data.mark.on = false; data.mark.lastOffAt = now(); }
    stopped = true;
    if (bootTimer) { clearTimer(bootTimer); bootTimer = null; }
    jobs.length = 0;
    while (waiters.length) waiters.shift()();
    saveNow();
  }

  function state() {
    return { busy, held, current, jobs: jobs.map((j) => j.key), waiters: waiters.length, attached: attached.size, reads, paused: Object.assign({}, paused), mem: Array.from(mem.keys()) };
  }

  return { line, sight, afterRead, acquire, release, dropGuest, forget, stop, state, subsAnswer, libraryAnswer, _load: load, _saveNow: saveNow };
}

module.exports = { create, SUBS_FRESH_MS, SUBS_AFTER_YT_MS, PAGE_FRESH_MS };
