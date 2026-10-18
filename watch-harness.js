// watch-harness.js -- Watch's pure-node tests: no Electron, no network, never an account.
//
//   node watch-harness.js
//
// 1. watch/shape.js: item/event cleaning, the Edge rule (kept in step with drm-sites.js).
// 2. watch/merge.js: the rows (round-robin, de-dupe, the services' own rows), the sports strip,
//    local search, the per-service search links.
// 3. watch-main.js, driven by fakes (a fake clock and timers, fake adapters, a fake runStep in
//    place of the hidden reader, fake guests): cache-first hello, one read at a time, the
//    cadence floors, every pause shown with its reason (game, memory, hidden window), one
//    service failing never blanking the rest, signed-out vs error, forget, the cache file,
//    opening titles (Quartz tab vs Edge), search (YouTube + the TMDB slot), the guest gate.
// 4. Every adapter's own fixture tests (tests/watch-adapter-*.js) and TMDB's (tests/watch-tmdb-test.js).
// One summary line: "watch: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Shape = require('./watch/shape');
const Merge = require('./watch/merge');
const WM = require('./watch-main');
const DrmSites = require('./drm-sites');

let pass = 0;
let fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  if (!cond || process.env.WATCH_VERBOSE) {
    console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined ? '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
  }
}

/* ------------------------------------------------------------------ 1. shape */
function shapeTests() {
  const ok = Shape.cleanItem({ service: 'youtube', kind: 'resume', title: '  A\u0000 video  ', url: 'https://www.youtube.com/watch?v=abc', progress: 47, image: '//i.ytimg.com/vi/abc/hq.jpg', id: 'abc' });
  check(ok && ok.id === 'youtube:abc', 'shape: id is prefixed with the service', ok && ok.id);
  check(ok && ok.title === 'A video', 'shape: title control chars and spaces cleaned', ok && ok.title);
  check(ok && Math.abs(ok.progress - 0.47) < 1e-9, 'shape: a percent progress becomes 0..1', ok && ok.progress);
  check(ok && ok.image === 'https://i.ytimg.com/vi/abc/hq.jpg', 'shape: protocol-relative image becomes https', ok && ok.image);
  check(ok && ok.edge === false, 'shape: YouTube plays in Quartz');
  check(Shape.cleanItem({ service: 'youtube', kind: 'rec', title: 'x', url: 'http://www.youtube.com/watch?v=1' }) === null, 'shape: http link refused');
  check(Shape.cleanItem({ service: 'youtube', kind: 'rec', title: 'x', url: 'javascript:alert(1)' }) === null, 'shape: javascript: refused');
  check(Shape.cleanItem({ service: 'netflix', kind: 'rec', title: 'x', url: 'https://www.netflix.com/title/1' }) === null, 'shape: unknown service refused');
  check(Shape.cleanItem({ service: 'disney', kind: 'nope', title: 'x', url: 'https://www.disneyplus.com/browse/entity-1' }) === null, 'shape: unknown kind refused');
  check(Shape.cleanItem({ service: 'disney', kind: 'rec', title: '', url: 'https://www.disneyplus.com/browse/entity-1' }) === null, 'shape: empty title refused');
  check(Shape.cleanItem(null) === null && Shape.cleanItem('x') === null && Shape.cleanItem([]) === null, 'shape: junk refused');
  const d = Shape.cleanItem({ service: 'disney', kind: 'rec', title: 'Bluey', url: 'https://www.disneyplus.com/browse/entity-1', badge: 'A very long badge that goes on and on' });
  check(d && d.edge === true, 'shape: Disney+ opens in Edge');
  check(d && d.badge.length <= 24, 'shape: badge capped', d && d.badge);
  const long = Shape.cleanText('word '.repeat(100), 50);
  check(long.length <= 50 && /\u2026$/.test(long), 'shape: long text capped with an ellipsis', long.length);
  const items = Shape.cleanItems([
    { service: 'prime', kind: 'rec', title: 'A', url: 'https://www.primevideo.com/detail/A/', id: 'A' },
    { service: 'prime', kind: 'rec', title: 'A again', url: 'https://www.primevideo.com/detail/A/', id: 'A' },
    { service: 'prime', kind: 'watchlist', title: 'A', url: 'https://www.primevideo.com/detail/A/', id: 'A' },
  ]);
  check(items.length === 2, 'shape: de-dupe by kind+id', items.length);
  check(Shape.opensInEdge('https://www.espn.com/watch/player?id=1') === true, 'shape: the ESPN player goes to Edge');
  check(Shape.opensInEdge('https://www.espn.com/nhl/game/_/gameId/401') === false, 'shape: an ESPN gamecast stays in Quartz');
  check(Shape.opensInEdge('https://www.primevideo.com/detail/X/') && Shape.opensInEdge('https://www.hulu.com/watch/1'), 'shape: Prime and Hulu go to Edge');
  check(Shape.opensInEdge('https://notprimevideo.com/x') === false, 'shape: a look-alike host is not a streaming site');
  // Every video service drm-sites.js sends to Edge, Watch sends to Edge too.
  const drift = [];
  for (const s of DrmSites.SITES) {
    if (s.id === 'spotify' || s.id === 'applemusic' || s.id === 'crunchyroll') continue;
    for (const h of (s.hosts || []).concat(s.exact || [])) if (!Shape.opensInEdge('https://' + h + '/x')) drift.push(h);
  }
  check(drift.length === 0, 'shape: in step with drm-sites.js', drift);
  check(Shape.serviceForUrl('https://youtu.be/x') === 'youtube' && Shape.serviceForUrl('https://www.hulu.com/x') === 'hulu' && Shape.serviceForUrl('https://www.disneyplus.com/x') === 'disney'
    && Shape.serviceForUrl('https://tv.youtube.com/') === '' && Shape.serviceForUrl('https://example.com/') === '', 'shape: serviceForUrl');
  const ev = Shape.cleanEvent({ id: '401', league: 'nhl', state: 'in', startsAt: 1, home: { name: 'Leafs', score: 2 }, away: { abbr: 'MTL', score: '1' }, broadcasts: ['ESPN+', 'ESPN+', 'TNT'], watchUrl: 'https://www.espn.com/watch/player?id=9' });
  check(ev && ev.id === 'espn:401' && ev.home.score === '2' && ev.broadcasts.length === 2 && ev.edge === true, 'shape: event cleaned', ev);
  check(Shape.cleanEvent({ id: '1', league: 'xfl', state: 'in', startsAt: 1, home: { name: 'a' }, away: { name: 'b' } }) === null, 'shape: unknown league refused');
  const r = Shape.cleanResult({ state: 'weird' });
  check(r.state === 'error' && r.reason, 'shape: an unknown result state is an error with a reason', r);
  check(Shape.agoText(Date.now() - 3 * 60e3) === '3 min ago' && Shape.agoText(0) === 'never', 'shape: agoText');
  check(Shape.clockToSec('1:02:03') === 3723 && Shape.clockToSec('12:31') === 751 && Shape.clockToSec('x') === null, 'shape: clockToSec');
  let walked = 0;
  const deep = {}; let cur = deep; for (let i = 0; i < 500; i++) { cur.a = {}; cur = cur.a; }
  Shape.walk(deep, () => { walked++; });
  check(walked > 0 && walked < 100, 'shape: walk is depth-bounded', walked);
}

/* ------------------------------------------------------------------ 2. merge */
function mk(service, kind, n, extra) {
  const host = { youtube: 'https://www.youtube.com/watch?v=', disney: 'https://www.disneyplus.com/browse/entity-', hulu: 'https://www.hulu.com/series/', prime: 'https://www.primevideo.com/detail/', espn: 'https://www.espn.com/nhl/game/_/gameId/' }[service];
  const out = [];
  for (let i = 0; i < n; i++) out.push(Shape.cleanItem(Object.assign({ service, kind, title: service + ' ' + kind + ' ' + i, url: host + service + kind + i, id: kind + i }, extra ? extra(i) : {})));
  return out;
}
function mergeTests() {
  const services = {
    youtube: { enabled: true, items: mk('youtube', 'resume', 5).concat(mk('youtube', 'rec', 30)) },
    disney: { enabled: true, items: mk('disney', 'resume', 2).concat(mk('disney', 'rec', 8, (i) => ({ group: i < 4 ? 'Because you watched Bluey' : (i < 6 ? 'Tiny' : '') })), mk('disney', 'watchlist', 3)) },
    prime: { enabled: false, items: mk('prime', 'resume', 3) },
  };
  const rows = Merge.buildRows(services);
  const cont = rows.find((r) => r.id === 'continue');
  check(cont && cont.items.length === 7, 'merge: continue watching takes every enabled service', cont && cont.items.length);
  check(cont && cont.items[0].service === 'youtube' && cont.items[1].service === 'disney' && cont.items[2].service === 'youtube', 'merge: round-robin across services', cont && cont.items.slice(0, 3).map((i) => i.service));
  check(!rows.some((r) => r.items.some((i) => i.service === 'prime')), 'merge: a turned-off service contributes nothing');
  const fy = rows.find((r) => r.id === 'foryou');
  check(fy && fy.items[1].service === 'disney', 'merge: For you mixes services, YouTube does not drown the rest', fy && fy.items.slice(0, 4).map((i) => i.service));
  check(fy && fy.items.length <= Merge.ROW_CAP, 'merge: rows capped');
  check(rows.some((r) => r.title === 'Because you watched Bluey' && r.service === 'disney' && r.items.length === 4), 'merge: a service\'s own named row', rows.map((r) => r.title));
  check(!rows.some((r) => r.title === 'Tiny'), 'merge: a 2-item named row folds into "More from"');
  check(rows.some((r) => r.title === 'More from Disney+' && r.items.length === 4), 'merge: the loose ones become "More from Disney+"', rows.map((r) => r.title + ':' + r.items.length));
  check(rows.some((r) => r.title === 'From YouTube'), 'merge: YouTube recs get one "From YouTube" row');
  const wl = rows.find((r) => r.id === 'watchlist');
  check(wl && wl.items.length === 3, 'merge: watchlist row');
  const dup = Merge.buildRows({ youtube: { items: [Shape.cleanItem({ service: 'youtube', kind: 'rec', title: 'Same Show', url: 'https://www.youtube.com/watch?v=1' })] }, disney: { items: [Shape.cleanItem({ service: 'disney', kind: 'rec', title: 'Same  show!', url: 'https://www.disneyplus.com/browse/entity-2' })] } });
  check(dup.find((r) => r.id === 'foryou').items.length === 1, 'merge: the same title recommended twice shows once');
  const contDup = Merge.buildRows({ disney: { items: [Shape.cleanItem({ service: 'disney', kind: 'resume', title: 'Andor', url: 'https://www.disneyplus.com/browse/entity-3' }), Shape.cleanItem({ service: 'disney', kind: 'rec', title: 'Andor', url: 'https://www.disneyplus.com/browse/entity-3' })] } });
  check(!contDup.find((r) => r.id === 'foryou'), 'merge: something in Continue watching is not also "for you"');
  check(Merge.buildRows(null).length === 0 && Merge.buildRows({ youtube: { items: 'x' } }).length === 0, 'merge: junk -> no rows');

  const now = Date.parse('2026-10-16T23:00:00Z');
  const evs = [
    { id: 'a', league: 'nba', state: 'in', startsAt: now - 3600e3 },
    { id: 'b', league: 'nhl', state: 'in', startsAt: now - 1800e3 },
    { id: 'c', league: 'nhl', state: 'pre', startsAt: now + 7200e3 },
    { id: 'd', league: 'nfl', state: 'pre', startsAt: now + 3600e3 },
    { id: 'e', league: 'nhl', state: 'pre', startsAt: now + 72 * 3600e3 },
    { id: 'f', league: 'mlb', state: 'post', startsAt: now - 5 * 3600e3 },
    { id: 'g', league: 'mlb', state: 'post', startsAt: now - 30 * 3600e3 },
  ];
  const sp = Merge.buildSports(evs, now, ['nhl', 'nfl', 'nba', 'mlb']);
  check(sp.live.map((e) => e.id).join() === 'b,a', 'merge: live first, NHL first', sp.live.map((e) => e.id));
  check(sp.soon.map((e) => e.id).join() === 'd,c', 'merge: upcoming by start, next 36 h only', sp.soon.map((e) => e.id));
  check(sp.done.map((e) => e.id).join() === 'f', 'merge: recent finals only', sp.done.map((e) => e.id));
  check(Merge.sportsHot(evs, now) === true && Merge.sportsHot([evs[2]], now) === false && Merge.sportsHot([{ state: 'pre', startsAt: now + 5 * 60e3 }], now) === true, 'merge: sportsHot');

  const pool = [
    Shape.cleanItem({ service: 'disney', kind: 'rec', title: 'The Bear', url: 'https://www.disneyplus.com/browse/entity-b' }),
    Shape.cleanItem({ service: 'disney', kind: 'resume', title: 'The Bear', url: 'https://www.disneyplus.com/browse/entity-b' }),
    Shape.cleanItem({ service: 'youtube', kind: 'rec', title: 'Bear attack documentary', url: 'https://www.youtube.com/watch?v=x' }),
    Shape.cleanItem({ service: 'prime', kind: 'rec', title: 'Teddy bears', subtitle: 'Comédie', url: 'https://www.primevideo.com/detail/T/' }),
  ];
  const found = Merge.searchLocal(pool, 'the bear');
  check(found.length === 1 && found[0].kind === 'resume', 'merge: searchLocal ranks and de-dupes (resume beats rec)', found.map((i) => i.kind + ':' + i.title));
  check(Merge.searchLocal(pool, 'bear').length === 3, 'merge: searchLocal finds every title with the word');
  check(Merge.searchLocal(pool, 'comedie').length === 1, 'merge: accents folded');
  check(Merge.searchLocal(pool, '   ').length === 0 && Merge.searchLocal(null, 'x').length === 0, 'merge: empty query or pool');
  const links = Merge.searchLinks('the bear');
  check(links.length === Shape.SERVICES.length && links[0].url === 'https://www.youtube.com/results?search_query=the%20bear', 'merge: per-service search links', links.map((l) => l.url));
  check(links.find((l) => l.service === 'espn').url.indexOf('the-bear') !== -1 && links.find((l) => l.service === 'disney').edge === true, 'merge: ESPN slug and Disney+ to Edge');
}

/* ------------------------------------------------------------------ 3. watch-main with fakes */
function fakeWorld(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-harness-'));
  let t = Date.parse('2026-10-16T20:00:00Z');
  const timers = [];
  const sent = [];
  const edge = [];
  const logs = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const calls = [];
  const world = {
    dir, timers, sent, edge, logs, calls,
    game: '', free: 8, showing: true, saver: false,
    behaviour: {},   // service -> (step) => step result fields
    get maxConcurrent() { return maxConcurrent; },
    now: () => t,
    advance(ms) { t += ms; },
  };
  const okStep = (step) => ({ ok: true, url: step.url, finalUrl: step.url, title: '', status: 200, extracted: { ok: true }, json: null, text: null, captures: [], error: null });
  const adapter = (id, type) => ({
    id,
    steps: () => [{ name: 'home', type, url: Shape.serviceById(id).home }],
    parse: (read) => {
      const s = read.steps.home;
      if (s.extracted && s.extracted.throw) throw new Error('boom');
      if (s.error) return { state: 'error', reason: s.error.detail };
      if (s.extracted && s.extracted.signedOut) return { state: 'signed-out', reason: 'sign in' };
      const n = (s.extracted && s.extracted.n) || 3;
      const items = mk(id === 'espn' ? 'espn' : id, id === 'espn' ? 'live' : 'resume', n);
      const out = { state: 'ok', items, profile: id === 'disney' ? 'the user' : '' };
      if (id === 'espn') out.events = (s.extracted && s.extracted.events) || [];
      return out;
    },
  });
  const adapters = {
    youtube: Object.assign(adapter('youtube', 'view'), {
      searchUrl: (q) => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q),
      parseSearch: (html) => (html.indexOf('RESULTS') !== -1 ? [{ service: 'youtube', kind: 'search', title: 'Found it', url: 'https://www.youtube.com/watch?v=f', id: 'f' }] : []),
    }),
    disney: adapter('disney', 'view'),
    hulu: adapter('hulu', 'view'),
    prime: adapter('prime', 'view'),
    espn: adapter('espn', 'fetch'),
  };
  // Every service Shape knows gets a fake reader (a service added later is covered without a list here).
  for (const id of Shape.SERVICE_IDS) if (!adapters[id]) adapters[id] = adapter(id, 'view');
  const deps = {
    dir,
    adapters,
    bootGraceMs: o.bootGraceMs === undefined ? 0 : o.bootGraceMs,
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms, ms, unref() {} }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i !== -1) timers.splice(i, 1); },
    freeGb: () => world.free,
    send: (ch, p) => sent.push([ch, p]),
    openInEdge: (url) => { edge.push(url); return Promise.resolve(world.edgeFail ? { ok: false, how: 'msedge', reason: 'Edge did not start' } : { ok: true, how: 'msedge', reason: '' }); },
    isBundledPage: (url) => typeof url === 'string' && url.indexOf('file:///app/') === 0,
    log: (l) => logs.push(l),
    test: Object.assign({ gameRunning: () => world.game, windowShowing: () => world.showing, saverOn: () => world.saver }, o.test || {}),
    runStep: async (step, rebase) => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      const svc = step.name === 'search' ? 'search' : (Shape.SERVICE_IDS.find((id) => (step.url || '').indexOf(new URL(Shape.serviceById(id).home).hostname) !== -1) || '?');
      calls.push(svc + ':' + step.name + ':' + rebase(step.url));
      world.steps.push(step);
      await new Promise((r) => setImmediate(r));
      concurrent--;
      const b = world.behaviour[svc];
      const extra = b ? b(step) : {};
      if (extra === 'HANG') return new Promise(() => { /* a reader that never answers */ });
      if (extra && extra.delayMs) { const ms = extra.delayMs; await new Promise((r) => deps.setTimeout(r, ms)); delete extra.delayMs; }
      return Object.assign(okStep(step), extra);
    },
  };
  world.steps = [];
  world.fetchImpl = o.fetch || null;
  // realSteps: no fake runStep -- watch-main's own runFetchStep / runViewStep run, against
  // o.fetch / o.BrowserWindow + o.session (fakes below), so their options can be checked.
  if (o.realSteps) delete deps.runStep;
  for (const k of ['fetch', 'BrowserWindow', 'session']) if (o[k]) deps[k] = o[k];
  if (o.adapters) deps.adapters = Object.assign({}, adapters, o.adapters);
  if (o.drmRoute) deps.drmRoute = o.drmRoute;
  // The background refresh is off unless a test turns it on (bgTests): the visible-only tests
  // below keep their exact read counts.
  if (o.cache) fs.writeFileSync(path.join(dir, WM.CACHE_FILE), JSON.stringify(o.cache));
  if (!o.background) fs.writeFileSync(path.join(dir, WM.PREFS_FILE), JSON.stringify(Object.assign({ background: false }, o.prefs || {})));
  else if (o.prefs) fs.writeFileSync(path.join(dir, WM.PREFS_FILE), JSON.stringify(o.prefs));
  world.readers = Shape.SERVICE_IDS.filter((id) => !!deps.adapters[id]);
  world.wm = WM.create(deps);
  world.guest = (url) => {
    const pushed = [];
    const handlers = {};
    const g = {
      url: url || 'file:///app/watch.html?theme=dark',
      pushed,
      destroyed: false,
      getURL() { return g.url; },
      isDestroyed() { return g.destroyed; },
      executeJavaScript(code) {
        const m = /^window\.(__\w+) && window\.\1\(([\s\S]*)\)$/.exec(code);
        if (m) pushed.push({ fn: m[1], payload: JSON.parse(m[2]) });
        return Promise.resolve();
      },
      on(ev, fn) { handlers[ev] = fn; },
      emit(ev, ...a) { if (handlers[ev]) handlers[ev](...a); },
      say(line) { return world.wm.handleGuestLine(g, line); },
      last(fn) { for (let i = pushed.length - 1; i >= 0; i--) if (!fn || pushed[i].fn === fn) return pushed[i].payload; return null; },
    };
    world.wm.watchGuest(g);
    return g;
  };
  world.settle = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)); };
  world.fire = async () => {
    // Run every timer that is due at the current fake time.
    const due = timers.filter((h) => h.at <= t);
    for (const h of due) { const i = timers.indexOf(h); if (i !== -1) timers.splice(i, 1); h.fn(); }
    await world.settle();
  };
  world.svc = (snap, id) => snap.services.find((s) => s.id === id);
  world.cleanup = () => { try { world.wm.stop(); } catch (e) { /* fine */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* fine */ } };
  return world;
}

/**
 * A fake BrowserWindow for watch-main's own runViewStep (realSteps worlds). `ctl.extract(code, win)`
 * answers executeJavaScript (default { ok: true }). Every window made is in `made`, every script
 * it ran in win.webContents.js as [code, userGesture].
 */
function fakeBrowser(ctl) {
  const c = ctl || {};
  const made = [];
  class FakeBW {
    constructor(opts) {
      const win = this;
      this.opts = opts;
      this.destroyed = false;
      this.handlers = {};
      const wcH = {};
      this.webContents = {
        js: [], destroyed: false, url: '',
        on(ev, fn) { (wcH[ev] = wcH[ev] || []).push(fn); },
        once(ev, fn) { (wcH[ev] = wcH[ev] || []).push(fn); },
        emit(ev, ...a) { for (const fn of (wcH[ev] || [])) fn(...a); },
        setAudioMuted() {}, setFrameRate() {}, setWindowOpenHandler() {},
        isDestroyed() { return this.destroyed; },
        loadURL(url) { this.url = url; return Promise.resolve(); },
        executeJavaScript(code, gesture) {
          this.js.push([code, gesture]);
          if (this.destroyed) return Promise.reject(new Error('Object has been destroyed'));
          return Promise.resolve(c.extract ? c.extract(code, win) : { ok: true });
        },
        getURL() { return this.url; },
        getTitle() { return ''; },
        debugger: { attach() {}, on() {}, sendCommand() { return Promise.resolve({}); }, isAttached() { return false; }, detach() {} },
      };
      made.push(this);
    }
    once(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
    isDestroyed() { return this.destroyed; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.webContents.destroyed = true;
      this.webContents.emit('destroyed');
      for (const fn of (this.handlers.closed || [])) fn();
    }
  }
  return { FakeBW, made, session: { defaultSession: {} } };
}

/** A fake fetch: records (url, opts); YouTube results / TMDB / ESPN answer; `hang(url)` never answers. */
function fakeFetch(hang) {
  const calls = [];
  const f = (url, opts) => {
    calls.push({ url, opts: opts || {} });
    if (hang && hang(url)) return new Promise(() => { /* never answers, ignores abort */ });
    let body = '{}';
    if (/youtube\.com\/results/.test(url)) body = '<html>RESULTS</html>';
    if (/themoviedb\.org/.test(url)) body = '{"results":[]}';
    return Promise.resolve({ ok: true, status: 200, url, text: () => Promise.resolve(body) });
  };
  f.calls = calls;
  return f;
}

/** A Disney+ adapter whose one view step extracts and scrolls (to see both scripts' userGesture). */
function scrollingDisney(readyAfter) {
  return {
    disney: {
      id: 'disney',
      steps: () => [{ name: 'home', type: 'view', url: Shape.serviceById('disney').home, extract: 'window.__state', scroll: 2, ready: (v) => !!v && v.n >= readyAfter }],
      parse: (read) => {
        const s = read.steps.home;
        if (s.error) return { state: 'error', reason: s.error.detail };
        return { state: 'ok', items: mk('disney', 'resume', 2), profile: 'the user' };
      },
    },
  };
}

/** The review fixes (REVIEW.md findings 1-9), one block each. */
async function reviewFixTests() {
  const P = WM.parseGuestLine;
  const count = (g, fn) => g.pushed.filter((p) => p.fn === fn).length;

  // --- 5. the visibility protocol: hello carries it, `visible` updates it
  check(P('quartz-watch:hello {"visible":false}').visible === false && P('quartz-watch:hello {"visible":true}').visible === true,
    'fix5: hello carries the page\'s visibility');
  check(P('quartz-watch:hello {}').visible === true && P('quartz-watch:hello').visible === true, 'fix5: hello without the flag (an old page) counts as visible');
  const pv = P('quartz-watch:visible {"visible":false}');
  check(pv && pv.verb === 'visible' && pv.visible === false && P('quartz-watch:visible {"visible":true}').visible === true, 'fix5: the visible verb parses');
  check(P('quartz-watch:visible {}') === null && P('quartz-watch:visible {"visible":"yes"}') === null && P('quartz-watch:visible') === null, 'fix5: visible without a boolean is refused');

  // --- 1. no cookie goes with search, ESPN or TMDB: credentials 'omit' on every fetch
  let w = fakeWorld({ realSteps: true, fetch: fakeFetch(), BrowserWindow: fakeBrowser().FakeBW, session: { defaultSession: {} } });
  try {
    const g = w.guest();
    w.wm.setTmdbKey('abcdefghijklmnop0123');
    g.say('quartz-watch:hello {}');
    await w.settle();
    g.say('quartz-watch:search {"q":"bluey","seq":1}');
    await w.settle();
    w.advance(2000);
    await w.fire();
    const calls = w.fetchImpl.calls;
    const yt = calls.filter((c) => /youtube\.com\/results/.test(c.url));
    const espn = calls.filter((c) => /espn/.test(c.url));
    const tmdb = calls.filter((c) => /themoviedb\.org/.test(c.url));
    check(yt.length === 1 && espn.length >= 1 && tmdb.length >= 1, 'fix1: search, ESPN and TMDB all went through fetch', calls.map((c) => c.url));
    check(calls.length > 0 && calls.every((c) => c.opts.credentials === 'omit'), 'fix1: every fetch is credentials:omit (no cookie of the user\'s, nothing in his YouTube history)', calls.map((c) => c.opts.credentials));
    const a = g.last('__applyWatchSearch');
    check(a && a.seq === 1 && a.youtube.ok, 'fix1: the cookie-less search still answers', a && a.youtube);
  } finally { w.cleanup(); }

  // --- 1. a newer search cancels the one in flight: aborted, never answered, never cached
  w = fakeWorld();
  try {
    const g = w.guest();
    let firstHangs = true;
    w.behaviour.search = () => { if (firstHangs) { firstHangs = false; return 'HANG'; } return { text: '<html>RESULTS</html>' }; };
    g.say('quartz-watch:search {"q":"the","seq":1}');
    await w.settle();
    const s1 = w.steps.find((s) => s.name === 'search');
    check(s1 && s1.signal && s1.signal.aborted === false, 'fix1: a search step carries an abort signal');
    g.say('quartz-watch:search {"q":"the man","seq":2}');
    await w.settle();
    check(s1 && s1.signal.aborted === true, 'fix1: the next search aborts the one in flight');
    w.advance(2000);
    await w.fire();
    let answers = g.pushed.filter((p) => p.fn === '__applyWatchSearch').map((p) => p.payload.seq);
    check(answers.join() === '2' && g.last('__applyWatchSearch').youtube.ok, 'fix1: only the newest search answers the page', answers);
    check(!w.logs.some((l) => /search on YouTube failed/.test(l)), 'fix1: a cancelled search is not logged as a failure', w.logs);
    check(w.wm.state().searchesLive === 0, 'fix1: no search left in flight');
    // one replaced while it waits for the gap never fetches at all
    w.advance(2000);
    w.calls.length = 0;
    g.say('quartz-watch:search {"q":"alpha","seq":3}');
    await w.settle();
    g.say('quartz-watch:search {"q":"alph","seq":4}');
    await w.settle();
    g.say('quartz-watch:search {"q":"alpha beta","seq":5}');
    await w.settle();
    w.advance(2000);
    await w.fire();
    const urls = w.calls.filter((c) => c.indexOf('search:') === 0);
    check(urls.length === 2 && /search_query=alpha$/.test(urls[0]) && /search_query=alpha%20beta$/.test(urls[1]), 'fix1: a search replaced while waiting never fetches (alpha, alpha beta; not alph)', urls);
    answers = g.pushed.filter((p) => p.fn === '__applyWatchSearch').map((p) => p.payload.seq);
    check(answers.join() === '2,3,5', 'fix1: seq 4 never answers; 3 and 5 do', answers);
    // a closed page's search is cancelled too
    w.behaviour.search = () => 'HANG';
    w.advance(2000);
    g.say('quartz-watch:search {"q":"gone","seq":6}');
    await w.settle();
    const s6 = w.steps[w.steps.length - 1];
    g.destroyed = true;
    g.emit('destroyed');
    check(s6.signal.aborted === true && w.wm.state().searchesLive === 0, 'fix1: a page that closes cancels its search');
  } finally { w.cleanup(); }

  // --- 2. a snapshot that throws reaches the page as { v, now, fatal }; pushAll never dies quietly
  w = fakeWorld();
  const origRows = Merge.buildRows;
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  try {
    Merge.buildRows = () => { throw new Error('row bug'); };
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    const f = g.pushed[0] && g.pushed[0].payload;
    check(f && f.v === 1 && typeof f.now === 'number' && typeof f.fatal === 'string' && /row bug/.test(f.fatal) && Object.keys(f).sort().join() === 'fatal,now,v',
      'fix2: hello with a broken snapshot sends { v: 1, now, fatal }', f);
    await w.settle();
    const snaps = g.pushed.filter((p) => p.fn === '__applyWatch');
    check(snaps.length > 1 && snaps.every((p) => typeof p.payload.fatal === 'string'), 'fix2: pushAll sends the fatal too (it does not die in its .then)', snaps.length);
    check(w.logs.filter((l) => /row bug/.test(l)).length === 1, 'fix2: the failure is logged once, not once per push', w.logs.filter((l) => /row bug/.test(l)));
    await new Promise((r) => setImmediate(r));
    check(unhandled === 0, 'fix2: no unhandled rejection', unhandled);
    Merge.buildRows = origRows;
    g.say('quartz-watch:hello {}');   // the page's Retry
    const back = g.last('__applyWatch');
    check(back && !back.fatal && Array.isArray(back.rows) && back.rows.length > 0, 'fix2: Retry (hello again) draws normally once the fault is gone');
  } finally { Merge.buildRows = origRows; process.removeListener('unhandledRejection', onUnhandled); w.cleanup(); }

  // --- 3 + 4. the real runViewStep: userGesture false, reader webContents tracked live
  let br = fakeBrowser({ extract: (code, win) => { win.n = (win.n || 0) + 1; return { n: win.n }; } });
  w = fakeWorld({ realSteps: true, fetch: fakeFetch(), BrowserWindow: br.FakeBW, session: br.session, adapters: scrollingDisney(3) });
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await w.settle();
    const ytWin = br.made[0];
    const dWin = br.made[1];
    check(ytWin && ytWin.destroyed && dWin && !dWin.destroyed, 'fix4: (setup) YouTube\'s reader done, Disney+\'s alive mid-read', br.made.map((x) => x.destroyed));
    check(w.wm.isReaderContents(dWin.webContents) === true, 'fix4: isReaderContents is true for a live reader');
    check(w.wm.isReaderContents(ytWin.webContents) === false, 'fix4: ...false once that reader is destroyed');
    check(w.wm.isReaderContents(g) === false && w.wm.isReaderContents(null) === false && w.wm.isReaderContents({}) === false, 'fix4: ...false for a Watch page, null, anything else');
    for (let i = 0; i < 6 && !dWin.destroyed; i++) { w.advance(600); await w.fire(); }
    const js = dWin.webContents.js;
    check(js.some(([c]) => /scrollBy/.test(c)) && js.some(([c]) => /__state/.test(c)), 'fix3: (setup) the reader both extracted and scrolled', js.map(([c]) => c.slice(0, 30)));
    check(js.length >= 3 && js.every(([, gesture]) => gesture === false), 'fix3: every reader script runs with userGesture false', js.map(([, gst]) => gst));
    await w.settle();
    check(br.made.every((x) => x.destroyed) && w.wm.state().readers === 0, 'fix4: every reader destroyed and forgotten after the reads', br.made.map((x) => x.destroyed));
    check(br.made.every((x) => !w.wm.isReaderContents(x.webContents)), 'fix4: no dead reader still counts as one');
    check(w.svc(g.last('__applyWatch'), 'disney').state === 'ok', 'fix3: the Disney+ read still succeeds');
  } finally { w.cleanup(); }

  // --- 8. a hung search's watchdog never kills the Disney+ reader beside it
  br = fakeBrowser({ extract: () => null });     // Disney+ never ready: it polls to its own 20 s deadline
  const ff = fakeFetch((url) => /youtube\.com\/results/.test(url));   // the search fetch never answers, ignores abort
  w = fakeWorld({ realSteps: true, fetch: ff, BrowserWindow: br.FakeBW, session: br.session, adapters: scrollingDisney(1) });
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await w.settle();
    const dWin = br.made[1];
    g.say('quartz-watch:search {"q":"bluey","seq":1}');
    await w.settle();
    for (let i = 0; i < 16; i++) { w.advance(1000); await w.fire(); }
    check(w.logs.some((l) => /step search hit the watchdog/.test(l)), 'fix8: (setup) the hung search hit its watchdog at 15 s', w.logs);
    check(dWin && dWin.destroyed === false && w.svc(g.last('__applyWatch'), 'disney').reading === true, 'fix8: the Disney+ reader beside it is untouched', dWin && dWin.destroyed);
    const a = g.last('__applyWatchSearch');
    check(a && a.youtube.ok === false && /stopped answering/.test(a.youtube.reason), 'fix8: the search says it timed out', a && a.youtube);
    for (let i = 0; i < 6; i++) { w.advance(1000); await w.fire(); }
    const d = w.svc(g.last('__applyWatch'), 'disney');
    check(dWin.destroyed && d.state === 'error' && d.reason === 'timed out after 20 s', 'fix8: Disney+ ends on its own deadline, not as a crash or a kill', d.reason);
  } finally { w.cleanup(); }

  // --- 8. a view step's watchdog destroys that step's own window
  br = fakeBrowser({ extract: () => null });
  w = fakeWorld({ realSteps: true, fetch: fakeFetch(), BrowserWindow: br.FakeBW, session: br.session, adapters: scrollingDisney(1) });
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await w.settle();
    const dWin = br.made[1];
    w.advance(26e3);
    await w.fire();
    await w.settle();
    check(w.logs.some((l) => /step home hit the watchdog/.test(l)) && dWin.destroyed, 'fix8: the watchdog destroys its own step\'s window', w.logs);
    check(br.made.slice(2).every((x) => x.destroyed) && w.svc(g.last('__applyWatch'), 'prime').state === 'ok', 'fix8: the next service still reads after it');
    check(/stopped answering/.test(w.svc(g.last('__applyWatch'), 'disney').reason), 'fix8: Disney+ says the reader stopped answering', w.svc(g.last('__applyWatch'), 'disney').reason);
  } finally { w.cleanup(); }

  // --- 5. reads start only once a Watch page is visible; a hidden page gets no timed reads
  w = fakeWorld();
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {"visible":false}');
    check(g.pushed[0] && g.pushed[0].fn === '__applyWatch' && g.pushed[0].payload.services.length === Shape.SERVICE_IDS.length, 'fix5: a hidden page still gets the cache snapshot at once');
    await w.settle();
    check(w.calls.length === 0 && w.wm.state().timerAt === 0, 'fix5: a hidden page starts no read and arms no timer', { calls: w.calls, timerAt: w.wm.state().timerAt });
    w.wm.windowShown();
    await w.settle();
    check(w.calls.length === 0, 'fix5: the window coming back reads nothing for a hidden page');
    g.say('quartz-watch:visible {"visible":true}');
    await w.settle();
    check(w.calls.length === Shape.SERVICE_IDS.length && w.wm.state().timerAt > 0, 'fix5: turning visible reads what is due and arms the timer', w.calls);
    g.say('quartz-watch:visible {"visible":false}');
    await w.settle();
    check(w.wm.state().timerAt === 0, 'fix5: turning hidden stops the timer');
    w.calls.length = 0;
    w.advance(16 * 60e3);
    await w.fire();
    check(w.calls.length === 0, 'fix5: no YouTube 15-min re-read while hidden', w.calls);
    g.say('quartz-watch:visible {"visible":true}');
    await w.settle();
    check(w.calls.length === w.readers.length,
      'fix5: back on screen 16 min later, everything over 10 min old reads (fresh on open)', w.calls);
    // two pages: the visible one keeps the timer; when it closes, the hidden one gets none
    const g2 = w.guest();
    g2.say('quartz-watch:hello {"visible":true}');
    g.say('quartz-watch:visible {"visible":false}');
    await w.settle();
    check(w.wm.state().visible === 1 && w.wm.state().timerAt > 0, 'fix5: one visible page of two keeps the timer');
    g2.destroyed = true;
    g2.emit('destroyed');
    await w.settle();
    check(w.wm.state().guests === 1 && w.wm.state().visible === 0 && w.wm.state().timerAt === 0, 'fix5: the visible page closing leaves the set; the hidden one gets no timer', w.wm.state());
    // a Retry click still reads on a page that says it is hidden (the click is the user's)
    w.calls.length = 0;
    w.advance(31e3);
    g.say('quartz-watch:refresh {"service":"prime"}');
    await w.settle();
    check(w.calls.some((c) => c.indexOf('prime') === 0), 'fix5: a Retry is never held back by visibility', w.calls);
  } finally { w.cleanup(); }

  // --- 5. a hidden page's hello reads nothing even while another Watch page is on screen
  w = fakeWorld();
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await w.settle();
    w.advance(16 * 60e3);          // YouTube and ESPN fall due; the timer has not fired yet
    w.calls.length = 0;
    const g2 = w.guest();
    g2.say('quartz-watch:hello {"visible":false}');
    await w.settle();
    check(w.calls.length === 0 && g2.pushed.length >= 1, 'fix5: a hidden hello gets the snapshot but starts no read, even beside a visible page', w.calls);
    g2.say('quartz-watch:visible {"visible":true}');
    await w.settle();
    check(w.calls.some((c) => c.indexOf('youtube') === 0), 'fix5: ...and reads once it turns visible', w.calls);
  } finally { w.cleanup(); }

  // --- 6. boot grace: reads wait QUEUED until create() + bootGraceMs, then one at a time
  w = fakeWorld({ bootGraceMs: 10000 });
  try {
    const t0 = w.now();
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await w.settle();
    let s = g.last('__applyWatch');
    check(w.calls.length === 0 && s.services.every((x) => x.queued === true && x.reading === false), 'fix6: in the boot grace every due read is queued, none reading', s.services.map((x) => x.id + ':' + x.queued + '/' + x.reading));
    check(w.wm.state().bootTimer && w.timers.some((h) => h.at === t0 + 10000), 'fix6: one timer, at create() + bootGraceMs');
    w.advance(9000);
    await w.fire();
    check(w.calls.length === 0, 'fix6: nothing reads before the grace ends', w.calls);
    w.advance(1000);
    await w.fire();
    s = g.last('__applyWatch');
    check(w.calls.length === Shape.SERVICE_IDS.length && w.maxConcurrent === 1 && s.services.every((x) => x.state === 'ok' && !x.queued), 'fix6: the first reader starts at the end of the grace, then the rest, one at a time', w.calls);
  } finally { w.cleanup(); }

  // --- 5b. reads queued while in sight leave the queue when the page goes behind another tab;
  //         a Read now still reads out of sight
  w = fakeWorld({ bootGraceMs: 10000 });
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {"visible":true}');
    await w.settle();
    check(g.last('__applyWatch').services.every((x) => x.queued === true), 'fix5b: in sight during the grace: every due read queued');
    g.say('quartz-watch:visible {"visible":false}');
    await w.settle();
    check(g.last('__applyWatch').services.every((x) => !x.queued), 'fix5b: behind another tab: the queue empties', g.last('__applyWatch').services.map((x) => x.id + ':' + x.queued));
    w.advance(11000);
    await w.fire();
    await w.settle();
    check(w.calls.length === 0, 'fix5b: the grace ends out of sight: nothing reads', w.calls);
    w.wm.refresh('youtube');
    w.advance(1);
    await w.fire();
    await w.settle();
    check(w.calls.length > 0 && w.calls.every((c) => c.indexOf('youtube') === 0), 'fix5b: Read now reads YouTube even out of sight, and only it', w.calls);
    g.say('quartz-watch:visible {"visible":true}');
    await w.settle();
    check(w.calls.some((c) => c.indexOf('disney') === 0) && w.calls.some((c) => c.indexOf('espn') === 0), 'fix5b: back in sight, the rest reads', w.calls);
  } finally { w.cleanup(); }

  // --- 7. Forget clears memory too: search answers, the search gap, pauses, Retry stamps
  w = fakeWorld();
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await w.settle();
    w.behaviour.search = () => ({ text: '<html>RESULTS</html>' });
    g.say('quartz-watch:search {"q":"bluey","seq":1}');
    await w.settle();
    w.advance(31e3);
    g.say('quartz-watch:refresh {"service":"disney"}');
    await w.settle();
    w.game = 'valorant';
    w.advance(31e3);
    g.say('quartz-watch:refresh {"service":null}');
    await w.settle();
    let st = w.wm.state();
    check(st.searchCache === 1 && Object.keys(st.paused).length === Shape.SERVICE_IDS.length && st.lastForced >= 1, '(setup) a cached search, pauses and Retry stamps exist', st);
    w.game = '';
    g.say('quartz-watch:search {"q":"zeta","seq":2}');   // in flight across the Forget
    g.say('quartz-watch:forget {}');
    await w.settle();
    st = w.wm.state();
    check(st.searchCache === 0 && Object.keys(st.paused).length === 0 && Object.keys(st.pausedUntil).length === 0 && st.lastForced === 0,
      'fix7: forget clears the search answers, pauses and Retry stamps', st);
    check(g.last('__applyWatchSearch').seq === 2, 'fix7: a search in flight across Forget still answers the page (it is not cached)');
    check(g.last('__applyWatch').forgottenAt > 0, 'fix7: forgottenAt is in the snapshot');
    const n = w.calls.length;
    g.say('quartz-watch:search {"q":"bluey","seq":3}');
    await w.settle();
    check(w.calls.length === n + 1 && g.last('__applyWatchSearch').seq === 3, 'fix7: after Forget the same search fetches again, at once (gap reset)', w.calls.slice(n));
  } finally { w.cleanup(); }

  // --- 7. turning a service off removes its rows from memory AND watch-cache.json
  w = fakeWorld();
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await w.settle();
    w.wm.flush();
    const file = path.join(w.dir, 'watch-cache.json');
    let disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(disk.services.disney.items.length === 3 && disk.services.disney.profile === 'the user', '(setup) Disney+ rows and profile on disk');
    w.wm.setEnabled('disney', false);
    disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(disk.services.disney.items.length === 0 && disk.services.disney.profile === '' && disk.services.disney.state === 'never', 'fix7: off -> its rows and profile leave watch-cache.json at once', disk.services.disney);
    check(disk.services.youtube.items.length === 3 && disk.services.prime.items.length === 3, 'fix7: the other services keep theirs');
    w.behaviour.espn = () => ({ extracted: { events: [{ id: '9', league: 'nhl', state: 'pre', startsAt: w.now() + 3600e3, home: { name: 'A' }, away: { name: 'B' } }] } });
    w.wm.refresh('espn');
    await w.settle();
    w.wm.flush();
    check(JSON.parse(fs.readFileSync(file, 'utf8')).services.espn.events.length === 1, '(setup) an ESPN game on disk');
    w.wm.setEnabled('espn', false);
    disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(!(disk.services.espn.events && disk.services.espn.events.length) && disk.services.espn.items.length === 0, 'fix7: ESPN off -> its games leave the file too', disk.services.espn);
    w.behaviour.search = () => ({ text: '<html>RESULTS</html>' });
    g.say('quartz-watch:search {"q":"bluey","seq":1}');
    await w.settle();
    check(w.wm.state().searchCache === 1, '(setup) a cached YouTube search');
    w.wm.setEnabled('youtube', false);
    check(w.wm.state().searchCache === 0, 'fix7: YouTube off drops its cached searches');
    w.calls.length = 0;
    w.wm.setEnabled('disney', true);
    await w.settle();
    check(w.calls.some((c) => c.indexOf('disney') === 0) && w.svc(g.last('__applyWatch'), 'disney').counts.resume === 3, 'fix7: turned back on, it reads at once');
  } finally { w.cleanup(); }

  // --- 9. a service waiting on checkGame() cannot be queued a second time
  w = fakeWorld();
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await Promise.resolve();   // hello's checkGame().then has run; pump is now awaiting its own checkGame()
    const st = w.wm.state();
    check(st.starting === 'youtube' && st.reading === null && st.queue.indexOf('youtube') === -1, '(setup) YouTube is between the queue and reading', st);
    check(w.wm.enqueue('youtube', true) === false, 'fix9: enqueue refuses a service that is starting');
    check(w.wm.snapshot().services.find((x) => x.id === 'youtube').queued === true, 'fix9: the page sees it as queued meanwhile');
    await w.settle();
    check(w.calls.filter((c) => c.indexOf('youtube') === 0).length === 1, 'fix9: YouTube read once', w.calls);
  } finally { w.cleanup(); }

  // --- 6 (finding 6). a game pause backs off 5 min: no tasklist / push every 30 s
  let looks = 0;
  let game = 'valorant';
  w = fakeWorld({ test: { gameRunning: () => { looks++; return game; } } });
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await w.settle();
    check(w.svc(g.last('__applyWatch'), 'youtube').paused === 'paused while VALORANT is running', '(setup) paused for the game');
    check(w.wm.state().timerAt - w.now() >= 5 * 60e3 - 1, 'fix6b: the timer looks again in 5 min, not 30 s', w.wm.state().timerAt - w.now());
    const looks0 = looks;
    const pushes0 = count(g, '__applyWatch');
    for (let i = 0; i < 9; i++) { w.advance(30e3); await w.fire(); }
    check(looks === looks0 && count(g, '__applyWatch') === pushes0, 'fix6b: 4.5 min of a game: no game check, no push', { looks: looks - looks0, pushes: count(g, '__applyWatch') - pushes0 });
    w.advance(31e3);
    await w.fire();
    check(looks > looks0 && w.calls.length === 0, 'fix6b: at 5 min it looks once more (still paused)', looks - looks0);
    game = '';
    w.advance(5 * 60e3 + 1000);
    await w.fire();
    check(w.calls.length === Shape.SERVICE_IDS.length, 'fix6b: the game over, the next look reads everything', w.calls);
    // a page coming back on screen does not wait out the backoff (that look is the user's)
    game = 'valorant';
    w.advance(61 * 60e3);
    await w.fire();
    game = '';
    w.calls.length = 0;
    g.say('quartz-watch:visible {"visible":false}');
    g.say('quartz-watch:visible {"visible":true}');
    await w.settle();
    check(w.calls.length === Shape.SERVICE_IDS.length, 'fix6b: a page turning visible looks at once, backoff or not', w.calls);
  } finally { w.cleanup(); }
}

async function mainTests() {
  // --- the line parser
  const P = WM.parseGuestLine;
  check(P('quartz-watch:hello {}').verb === 'hello' && P('quartz-watch:hello').verb === 'hello', 'main: hello parses');
  check(P('quartz-watch:refresh {"service":"disney"}').service === 'disney' && P('quartz-watch:refresh {"service":null}').service === null, 'main: refresh parses');
  check(P('quartz-watch:refresh {"service":"netflix"}') === null, 'main: refresh of an unknown service refused');
  check(P('quartz-watch:open {"url":"https://www.youtube.com/watch?v=1"}').url === 'https://www.youtube.com/watch?v=1', 'main: open a service URL');
  check(P('quartz-watch:open {"url":"https://evil.example/"}') === null, 'main: open refuses a foreign site');
  check(P('quartz-watch:open {"url":"javascript:alert(1)"}') === null && P('quartz-watch:open {"url":"file:///C:/x"}') === null, 'main: open refuses javascript: and file:');
  check(P('quartz-watch:open {"url":"https://www.themoviedb.org/movie/1/watch"}') !== null, 'main: open allows a TMDB where-to-watch page');
  check(P('quartz-watch:search {"q":"  bluey\\u0000 ","seq":4}').q === 'bluey' && P('quartz-watch:search {"q":"x","seq":4}').seq === 4, 'main: search trimmed, seq kept');
  check(P('quartz-watch:search {"q":"   "}') === null && P('quartz-watch:search {"q":"' + 'a'.repeat(500) + '"}').q.length === 200, 'main: empty search refused, long capped');
  check(P('quartz-watch:nope {}') === null && P('quartz-watch:hello [1]') === null && P('quartz-watch:hello {bad') === null && P('other:hello {}') === null && P(null) === null, 'main: junk lines refused');
  check(P('quartz-watch:signin {"service":"prime"}').service === 'prime' && P('quartz-watch:signin {}') === null, 'main: signin parses');

  // --- prefs, cache, errors, rebase
  const pr = WM.cleanPrefs({ enabled: { prime: false, bogus: false }, leagues: ['nfl', 'nfl', 'xfl', 'nhl'], tmdbKey: 'has space' });
  check(pr.enabled.prime === false && pr.enabled.youtube === true && pr.leagues.join() === 'nfl,nhl' && pr.tmdbKey === '', 'main: cleanPrefs', pr);
  check(WM.cleanPrefs(null).leagues.join() === Shape.DEFAULT_LEAGUES.join(), 'main: default leagues');
  const cc = WM.cleanCache({ v: 1, services: { youtube: { state: 'ok', readAt: 5, items: [{ service: 'disney', kind: 'rec', title: 'wrong svc', url: 'https://www.disneyplus.com/browse/entity-1' }, { service: 'youtube', kind: 'rec', title: 'ok', url: 'https://www.youtube.com/watch?v=1' }] } } });
  check(cc.services.youtube.items.length === 1 && cc.services.disney.state === 'never', 'main: cleanCache keeps only the service\'s own items', cc.services.youtube.items.length);
  check(WM.cleanCache({ v: 99 }).services.youtube.state === 'never' && WM.cleanCache('junk').services.prime.items.length === 0, 'main: a cache of another version starts empty');
  check(WM.classifyNetError({ code: 'ERR_INTERNET_DISCONNECTED' }).code === 'offline' && WM.classifyNetError({ errno: -102 }, 'x.com').detail.indexOf('x.com') !== -1, 'main: offline errors');
  check(WM.classifyNetError({ code: 'ERR_BLOCKED_BY_CLIENT' }).detail.indexOf('ad blocker') !== -1, 'main: ad-blocked load named');
  check(WM.rebaseUrl('https://www.youtube.com/feed', [['https://www.youtube.com', 'http://127.0.0.1:9/yt']]) === 'http://127.0.0.1:9/yt/feed' && WM.rebaseUrl('https://x/', null) === 'https://x/', 'main: rebaseUrl');
  check(WM.maskKey('abcdefghijkl') === '\u2022\u2022\u2022\u2022ijkl' && WM.cleanKey(' k\u0000 ') === '', 'main: key mask and clean');

  // --- cache-first hello, then every due service read, one at a time
  let w = fakeWorld();
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    const first = g.pushed[0];
    check(first && first.fn === '__applyWatch' && first.payload.services.length === Shape.SERVICE_IDS.length && first.payload.services.every((s) => s.state === 'never'), 'main: hello answers at once from the (empty) cache', first && first.payload.services.map((s) => s.state));
    await w.settle();
    const snap = g.last('__applyWatch');
    check(snap.services.every((s) => s.state === 'ok'), 'main: every service read after hello', snap.services.map((s) => s.state + ':' + s.reason));
    check(w.maxConcurrent === 1, 'main: one read at a time', w.maxConcurrent);
    check(w.calls.length === Shape.SERVICE_IDS.length, 'main: one step per service', w.calls);
    check(snap.rows.find((r) => r.id === 'continue').items.length === 3 * (Shape.SERVICE_IDS.length - 1), 'main: rows built from every service', snap.rows.map((r) => r.id + ':' + r.items.length));
    check(w.svc(snap, 'disney').profile === 'the user', 'main: the profile name travels');
    check(g.pushed.some((p) => p.fn === '__applyWatch' && p.payload.services.some((s) => s.reading)), 'main: the page is told what is reading');
    check(w.timers.length >= 1, 'main: a timer is armed while the page is open');
    w.wm.flush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(w.dir, 'watch-cache.json'), 'utf8'));
    check(onDisk.services.youtube.items.length === 3 && !JSON.stringify(onDisk).includes('captures'), 'main: the cache file holds items only, never raw captures');

    // cadence: nothing is due a minute later; every service at its 15-min floor (Disney+/Prime 15 since 10-17)
    w.calls.length = 0;
    w.advance(60e3);
    g.say('quartz-watch:hello {}');
    await w.settle();
    check(w.calls.length === 0, 'main: a second hello inside the floor reads nothing', w.calls);
    w.advance(15 * 60e3);
    await w.fire();
    check(w.readers.every((id) => w.calls.some((c) => c.indexOf(id + ':') === 0)), 'main: at 16 min every service is due (15-min floors)', w.calls);

    // a cache-first restart: a new instance draws the old rows before reading
    w.wm.flush();
  } finally { /* keep dir for the restart test below */ }
  const dir = w.dir;
  w.wm.stop();
  const w2 = fakeWorld();
  try {
    fs.copyFileSync(path.join(dir, 'watch-cache.json'), path.join(w2.dir, 'watch-cache.json'));
    const g2 = w2.guest();
    g2.say('quartz-watch:hello {}');
    const first2 = g2.pushed[0].payload;
    check(first2.services.find((s) => s.id === 'youtube').state === 'ok' && first2.rows.length > 0, 'main: restart is cache-first (rows on the first push)', first2.rows.length);
  } finally { w2.cleanup(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* fine */ } }

  // --- one service failing never blanks the page; error keeps rows, signed-out drops them
  w = fakeWorld();
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await w.settle();
    w.behaviour.disney = () => ({ ok: false, error: { code: 'timeout', detail: 'timed out after 20 s' } });
    w.behaviour.prime = () => ({ extracted: { signedOut: true } });
    w.behaviour.youtube = () => ({ extracted: { throw: true } });
    w.advance(61 * 60e3);
    await w.fire();
    g.say('quartz-watch:hello {}');
    const s = g.last('__applyWatch');
    const d = w.svc(s, 'disney');
    check(d.state === 'error' && d.reason === 'timed out after 20 s' && d.counts.resume === 3 && d.lastOkAt > 0, 'main: an error keeps the last good rows and says why', d);
    check(w.svc(s, 'prime').state === 'signed-out' && w.svc(s, 'prime').counts.resume === 0, 'main: signed out drops that account\'s rows');
    const y = w.svc(s, 'youtube');
    check(y.state === 'error' && /reader failed \(boom\)/.test(y.reason), 'main: an adapter that throws is an error, not a crash', y.reason);
    check(w.svc(s, 'espn').state === 'ok' && s.rows.length > 0, 'main: the others still draw');
    check(w.logs.filter((l) => /Lumen could not read/.test(l)).length === 3, 'main: one log line per failed service', w.logs);
    check(w.logs.some((l) => /Disney\+: timed out after 20 s \(1 page, 0 responses captured\)/.test(l)), 'main: the log line says what was read', w.logs);
  } finally { w.cleanup(); }

  // --- a reader that never answers hits the watchdog; the queue moves on (watch-e2e found this)
  w = fakeWorld();
  try {
    w.behaviour.disney = () => 'HANG';
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await w.settle();
    let s = g.last('__applyWatch');
    check(w.svc(s, 'disney').reading === true && w.svc(s, 'prime').state === 'never', 'main: a hung Disney+ step holds the queue only until its watchdog', s.services.map((x) => x.id + ':' + x.state + (x.reading ? '*' : '')));
    w.advance(26e3);
    await w.fire();
    s = g.last('__applyWatch');
    check(w.svc(s, 'disney').state === 'error' && /stopped answering/.test(w.svc(s, 'disney').reason), 'main: the hung step ends as an error with its reason', w.svc(s, 'disney').reason);
    check(w.svc(s, 'prime').state === 'ok' && w.svc(s, 'espn').state === 'ok', 'main: the services after it still read', s.services.map((x) => x.id + ':' + x.state));
    check(w.logs.some((l) => /hit the watchdog/.test(l)), 'main: the watchdog writes a log line');
    w.behaviour.disney = null;
    w.advance(31e3);
    g.say('quartz-watch:refresh {"service":"disney"}');
    await w.settle();
    check(w.svc(g.last('__applyWatch'), 'disney').state === 'ok', 'main: Retry works after a hang (the queue is not stuck)');
  } finally { w.cleanup(); }

  // --- pauses: game, memory, hidden window -- each shown with its reason
  w = fakeWorld();
  try {
    w.game = 'valorant';
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await w.settle();
    let s = g.last('__applyWatch');
    check(w.calls.length === 0 && s.services.every((x) => x.paused === 'paused while VALORANT is running'), 'main: nothing reads while a game runs, and every tile says so', s.services.map((x) => x.paused));
    w.game = '';
    w.free = 1.0;
    w.advance(31e3);
    g.say('quartz-watch:refresh {"service":null}');
    await w.settle();
    s = g.last('__applyWatch');
    check(/only 1\.0 GB of memory free/.test(w.svc(s, 'youtube').paused) && w.svc(s, 'espn').state === 'ok', 'main: low memory pauses the hidden-page reads but not ESPN\'s JSON', s.services.map((x) => x.state + '/' + x.paused));
    w.free = 8;
    w.showing = false;
    w.advance(31e3);
    w.calls.length = 0;
    g.say('quartz-watch:hello {}');
    await w.settle();
    s = g.last('__applyWatch');
    check(w.calls.length === Shape.SERVICE_IDS.length - 1 && !w.calls.some((c) => c.indexOf('espn') === 0),
      'main: hidden window: only the never-read (stale) services read; ESPN, read a minute ago, waits', w.calls);
    check(w.svc(s, 'youtube').state === 'ok', 'main: hidden window: a stale service still reads');
    w.advance(16 * 60e3);
    w.calls.length = 0;
    await w.fire();
    check(w.calls.length === 0 || w.timers.every((h) => h.ms >= 10 * 60e3 || h.ms <= 1600), 'main: hidden window waits (no fresh reads, a long timer)', { calls: w.calls, timers: w.timers.map((h) => h.ms) });
    s = g.last('__applyWatch');
    check(w.svc(s, 'youtube').paused === 'waiting until Quartz is back on screen' || w.calls.length === 0, 'main: hidden window says it is waiting', w.svc(s, 'youtube').paused);
    w.showing = true;
    w.wm.windowShown();
    await w.settle();
    check(w.calls.some((c) => c.indexOf('youtube') === 0), 'main: back on screen, the due service reads', w.calls);
    // a forced refresh ignores the hidden window, but not twice in 30 s
    w.showing = false;
    w.calls.length = 0;
    w.advance(40e3);
    g.say('quartz-watch:refresh {"service":"disney"}');
    await w.settle();
    g.say('quartz-watch:refresh {"service":"disney"}');
    await w.settle();
    check(w.calls.filter((c) => c.indexOf('disney') === 0).length === 1, 'main: Retry reads even when hidden, once per 30 s', w.calls);
  } finally { w.cleanup(); }

  // --- ESPN reads every 2 min while a game is live
  w = fakeWorld();
  try {
    w.behaviour.espn = () => ({ extracted: { events: [{ id: '9', league: 'nhl', state: 'in', startsAt: w.now() - 600e3, home: { name: 'A' }, away: { name: 'B' } }] } });
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await w.settle();
    g.say('quartz-watch:hello {}');
    const s = g.last('__applyWatch');
    check(s.sports.live.length === 1 && s.sports.live[0].id === 'espn:9', 'main: the sports strip arrives in the snapshot', s.sports);
    const espn = w.svc(s, 'espn');
    check(espn.next - espn.readAt <= 2 * 60e3 + 5, 'main: ESPN floor drops to 2 min with a live game', espn.next - espn.readAt);
  } finally { w.cleanup(); }

  // --- turning a service off, forget, settings calls
  w = fakeWorld();
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await w.settle();
    let desc = w.wm.setEnabled('prime', false);
    check(desc.services.find((x) => x.id === 'prime').state === 'off', 'main: a turned-off service is "off"');
    await w.settle();
    let s = g.last('__applyWatch');
    check(!s.items.some((i) => i.service === 'prime') && !s.rows.some((r) => r.items.some((i) => i.service === 'prime')), 'main: its rows leave the page');
    check(JSON.parse(fs.readFileSync(path.join(w.dir, 'watch.json'), 'utf8')).enabled.prime === false, 'main: the choice is saved');
    desc = w.wm.setLeagues(['nba', 'bogus', 'nhl']);
    check(desc.leagues.join() === 'nba,nhl', 'main: leagues saved, unknown dropped');
    desc = w.wm.setTmdbKey('secret-key-12345');
    check(desc.tmdb.hasKey && desc.tmdb.keyMask === '\u2022\u2022\u2022\u20222345' && !JSON.stringify(desc).includes('secret-key'), 'main: the TMDB key never comes back out');
    check(w.wm.setTmdbKey('bad key').error, 'main: a key with spaces refused');
    w.wm.flush();
    check(fs.existsSync(path.join(w.dir, 'watch-cache.json')), 'main: cache on disk before forget');
    g.say('quartz-watch:forget {}');
    await w.settle();
    s = g.last('__applyWatch');
    check(!fs.existsSync(path.join(w.dir, 'watch-cache.json')) && s.items.length === 0 && s.services.filter((x) => x.enabled).every((x) => x.state === 'never'), 'main: forget deletes the cache and the page empties', { file: fs.existsSync(path.join(w.dir, 'watch-cache.json')), items: s.items.length, states: s.services.map((x) => x.state) });
    check(g.last('__applyWatchResult').action === 'forget' && g.last('__applyWatchResult').ok === true, 'main: forget answers the page');
  } finally { w.cleanup(); }

  // --- 10-17: protected titles follow drm-main's real answer (CDM + signature + the person's rules)
  {
    const route = { mode: 'none' };
    const drmRoute = (url) => {
      if (route.mode === 'ready') return /disneyplus/.test(url) && route.rule ? { edge: true, rule: 'disney', reason: 'you chose to always watch Disney+ in Edge' } : { edge: false, rule: '', reason: '' };
      if (route.mode === 'throw') throw new Error('boom');
      return { edge: true, rule: '', reason: 'this build of Quartz has no Widevine' };
    };
    w = fakeWorld({ drmRoute });
    try {
      const g = w.guest();
      g.say('quartz-watch:hello {}');
      await w.settle();
      g.say('quartz-watch:open {"url":"https://www.disneyplus.com/browse/entity-1"}');
      await w.settle();
      let r = g.last('__applyWatchResult');
      check(w.edge.length === 1 && r.how === 'edge' && r.why === 'this build of Quartz has no Widevine', 'route: CDM missing -> Disney+ opens in Edge, with the reason', r);
      let s = g.last('__applyWatch');
      check(s.drm && s.drm.playable === false && s.drm.reason === 'this build of Quartz has no Widevine' && s.drm.edgeHosts.indexOf('disneyplus.com') !== -1, 'route: the snapshot says Quartz cannot play here, and why', s.drm);
      route.mode = 'ready';
      w.wm.drmChanged();
      await w.settle();
      s = g.last('__applyWatch');
      check(s.drm && s.drm.playable === true && s.drm.edgeHosts.length === 0, 'route: CDM ready -> the page hears it at once (drmChanged), nothing labelled Edge', s.drm);
      for (const u of ['https://www.disneyplus.com/browse/entity-1', 'https://www.primevideo.com/detail/X/', 'https://www.hulu.com/watch/1', 'https://www.espn.com/watch/player/_/id/1']) {
        const before = w.sent.filter((x) => x[0] === 'open-url').length;
        g.say('quartz-watch:open ' + JSON.stringify({ url: u }));
        await w.settle();
        r = g.last('__applyWatchResult');
        const tabs = w.sent.filter((x) => x[0] === 'open-url');
        check(r.how === 'tab' && tabs.length === before + 1 && tabs[tabs.length - 1][1].url === u && w.edge.length === 1, 'route: CDM ready -> ' + new URL(u).hostname + ' opens in a Quartz tab', r);
      }
      route.rule = true;
      g.say('quartz-watch:open {"url":"https://www.disneyplus.com/browse/entity-1"}');
      await w.settle();
      r = g.last('__applyWatchResult');
      check(r.how === 'edge' && w.edge.length === 2 && /you chose/.test(r.why), 'route: "Always use Edge for Disney+" still wins on a build that can play', r);
      s = (w.wm.drmView());
      check(s.playable === true && s.edgeHosts.join() === 'disneyplus.com', 'route: a rule labels only that service Edge, and Quartz still counts as able to play', s);
      route.mode = 'throw';
      g.say('quartz-watch:open {"url":"https://www.primevideo.com/detail/X/"}');
      await w.settle();
      r = g.last('__applyWatchResult');
      check(r.how === 'edge' && /could not check its Widevine \(boom\)/.test(r.why), 'route: a failing check goes to Edge and says so, never silently', r);
      g.say('quartz-watch:open {"url":"https://www.youtube.com/watch?v=abc"}');
      await w.settle();
      check(g.last('__applyWatchResult').how === 'tab', 'route: YouTube never asks drm-main, always a Quartz tab');
    } finally { w.cleanup(); }
  }

  // --- opening titles, sign-in, the guest gate
  w = fakeWorld({ test: { rebase: [['https://www.youtube.com', 'http://127.0.0.1:9/yt']] } });
  try {
    const g = w.guest();
    g.say('quartz-watch:open {"url":"https://www.disneyplus.com/browse/entity-1"}');
    await w.settle();
    check(w.edge[0] === 'https://www.disneyplus.com/browse/entity-1' && g.last('__applyWatchResult').how === 'edge', 'main: a Disney+ title opens in Edge', w.edge);
    g.say('quartz-watch:open {"url":"https://www.youtube.com/watch?v=abc"}');
    await w.settle();
    const tab = w.sent.find((x) => x[0] === 'open-url');
    check(tab && tab[1].url === 'http://127.0.0.1:9/yt/watch?v=abc' && w.edge.length === 1, 'main: a YouTube title opens a Quartz tab (rebased in tests only)', tab);
    w.edgeFail = true;
    g.say('quartz-watch:open {"url":"https://www.primevideo.com/detail/X/"}');
    await w.settle();
    const r = g.last('__applyWatchResult');
    check(r.ok === false && r.reason === 'Edge did not start', 'main: an Edge failure comes back with its reason', r);
    g.say('quartz-watch:signin {"service":"disney"}');
    await w.settle();
    check(w.sent.some((x) => x[0] === 'open-url' && x[1].url === 'https://www.disneyplus.com/login'), 'main: sign in opens the service\'s page in a tab');
    const intruder = w.guest('https://evil.example/watch.html');
    const before = w.sent.length;
    check(intruder.say('quartz-watch:open {"url":"https://www.youtube.com/watch?v=x"}') === false && w.sent.length === before, 'main: a web page printing the same line is ignored');
    const other = w.guest('file:///app/files.html');
    check(other.say('quartz-watch:hello {}') === false, 'main: another bundled page is not Watch');
  } finally { w.cleanup(); }

  // --- search: YouTube + the TMDB slot
  w = fakeWorld();
  try {
    const g = w.guest();
    w.behaviour.search = () => ({ text: '<html>RESULTS</html>' });
    g.say('quartz-watch:search {"q":"bluey","seq":1}');
    await w.settle();
    w.advance(2000);
    await w.fire();
    let a = g.last('__applyWatchSearch');
    check(a && a.seq === 1 && a.youtube.ok && a.youtube.items[0].title === 'Found it' && a.youtube.items[0].kind === 'search', 'main: YouTube search answers', a && a.youtube);
    check(a.tmdb && a.tmdb.state === 'no-key' && a.tmdb.reason === 'Add a free TMDB key in Settings to search every service', 'main: no key -> the TMDB slot says how to add one', a.tmdb);
    check(a.links.length === Shape.SERVICES.length, 'main: the per-service links come along');
    const n = w.calls.length;
    g.say('quartz-watch:search {"q":"Bluey","seq":2}');
    await w.settle();
    w.advance(2000);
    await w.fire();
    check(w.calls.length === n && g.last('__applyWatchSearch').seq === 2, 'main: a repeated search is answered from memory');
    w.behaviour.search = () => ({ ok: false, error: { code: 'offline', detail: "you're offline" } });
    g.say('quartz-watch:search {"q":"other","seq":3}');
    await w.settle();
    w.advance(2000);
    await w.fire();
    a = g.last('__applyWatchSearch');
    check(a.youtube.ok === false && a.youtube.reason === "you're offline" && a.links.length === Shape.SERVICES.length, 'main: a failed search says why and keeps the links', a.youtube);
    w.behaviour.search = () => ({ text: '<html>nothing</html>' });
    g.say('quartz-watch:search {"q":"empty","seq":4}');
    await w.settle();
    w.advance(2000);
    await w.fire();
    check(/changed its layout/.test(g.last('__applyWatchSearch').youtube.reason), 'main: an unreadable results page is named');
    w.wm.setEnabled('youtube', false);
    g.say('quartz-watch:search {"q":"x2","seq":5}');
    await w.settle();
    w.advance(2000);
    await w.fire();
    check(g.last('__applyWatchSearch').youtube.state === 'off', 'main: YouTube off -> its search says so');
  } finally { w.cleanup(); }

  // --- page closed: the timer goes; stop() leaves nothing
  w = fakeWorld();
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {}');
    await w.settle();
    check(w.timers.some((h) => h.ms >= 30e3), 'main: timer armed with a page open');
    g.destroyed = true;
    g.emit('destroyed');
    await w.settle();
    check(!w.timers.some((h) => h.ms >= 30e3), 'main: no page, no timer', w.timers.map((h) => h.ms));
    check(w.wm.state().guests === 0 && w.wm.state().viewAlive === false, 'main: nothing left alive');
  } finally { w.cleanup(); }
}

/* ------------------------------------------------------------------ 3b. the hover preview's trailers */
async function previewMainTests() {
  const P = WM.parseGuestLine;
  const pl = P('quartz-watch:preview {"title":"Terminator 2","tv":false,"seq":4}');
  check(pl && pl.verb === 'preview' && pl.title === 'Terminator 2' && pl.tv === false && pl.seq === 4, 'preview: the verb parses', pl);
  check(P('quartz-watch:preview {"title":"","seq":1}') === null && P('quartz-watch:preview {"seq":1}') === null, 'preview: no title is refused');
  const odd = P('quartz-watch:preview {"title":"a\\u0000b","tv":"yes","seq":-3}');
  check(odd && odd.title === 'a b' && odd.tv === false && odd.seq === 0, 'preview: control characters, a non-boolean tv and a bad seq are cleaned', odd);

  // A fake fetch that answers TMDB's /search/multi and /movie/280/videos, and counts.
  const tm = (url, opts) => {
    tm.calls.push({ url, opts: opts || {} });
    let body = '{}';
    if (/\/search\/multi/.test(url)) body = JSON.stringify({ results: [{ id: 280, media_type: 'movie', title: 'Terminator 2' }] });
    if (/\/movie\/280\/videos/.test(url)) body = JSON.stringify({ results: [{ site: 'YouTube', key: 'CRRlbK5w8AE', type: 'Trailer', official: true }] });
    return Promise.resolve({ ok: true, status: 200, url, text: () => Promise.resolve(body) });
  };
  tm.calls = [];
  const w = fakeWorld({ realSteps: true, fetch: tm, BrowserWindow: fakeBrowser().FakeBW, session: { defaultSession: {} } });
  try {
    const g = w.guest();
    g.say('quartz-watch:preview {"title":"Terminator 2","tv":false,"seq":1}');
    await w.settle();
    let a = g.last('__applyWatchPreview');
    check(a && a.seq === 1 && a.state === 'no-key' && /TMDB key in Settings > Watch/.test(a.reason) && tm.calls.length === 0, 'preview: no key -> says how, fetches nothing', a);
    w.wm.setTmdbKey('abcdefghijklmnop0123');
    g.say('quartz-watch:preview {"title":"Terminator 2","tv":false,"seq":2}');
    await w.settle();
    a = g.last('__applyWatchPreview');
    check(a && a.seq === 2 && a.state === 'ok' && a.videoId === 'CRRlbK5w8AE', 'preview: the TMDB trailer comes back', a);
    check(tm.calls.length === 2 && tm.calls.every((c) => c.opts.credentials === 'omit'), 'preview: two cookie-less reads', tm.calls.map((c) => c.url));
    g.say('quartz-watch:preview {"title":"terminator 2","tv":false,"seq":3}');
    await w.settle();
    check(g.last('__applyWatchPreview').seq === 3 && g.last('__applyWatchPreview').videoId === 'CRRlbK5w8AE' && tm.calls.length === 2, 'preview: a second hover is answered from memory');
    check(w.wm.state().trailerCache === 1, 'preview: one trailer remembered');
    w.wm.forget();
    check(w.wm.state().trailerCache === 0, 'preview: Forget clears the trailers too');
    const intruder = w.guest('https://evil.example/watch.html');
    check(intruder.say('quartz-watch:preview {"title":"x","seq":1}') === false, 'preview: a web page printing the line is ignored');
    g.say('quartz-watch:hello {}');
    const live = g.last('__applyWatch');
    check(live && live.preview && live.preview.on === true && live.preview.mock === false, 'preview: a live Quartz tells the page previews are on (not the mock)', live && live.preview);
  } finally { w.cleanup(); }

  // a --test-profile instance (main.js passes test.preview): off -> the page is told so and no trailer is
  // ever looked up, even with a key; mock -> only through a TMDB rebased to a local mock
  tm.calls = [];
  const off = fakeWorld({ realSteps: true, fetch: tm, BrowserWindow: fakeBrowser().FakeBW, session: { defaultSession: {} }, test: { preview: 'off' } });
  try {
    const g = off.guest();
    off.wm.setTmdbKey('abcdefghijklmnop0123');
    g.say('quartz-watch:preview {"title":"Terminator 2","tv":false,"seq":1}');
    await off.settle();
    const a = g.last('__applyWatchPreview');
    check(a && a.state === 'off' && tm.calls.length === 0, 'preview (test profile): off -> no TMDB request, even with a key', { a, calls: tm.calls.length });
    g.say('quartz-watch:hello {}');
    const s = g.last('__applyWatch');
    check(s && s.preview && s.preview.on === false, 'preview (test profile): the page is told previews are off', s && s.preview);
  } finally { off.cleanup(); }
  const bare = fakeWorld({ realSteps: true, fetch: tm, BrowserWindow: fakeBrowser().FakeBW, session: { defaultSession: {} }, test: { preview: 'mock' } });
  try {
    const g = bare.guest();
    bare.wm.setTmdbKey('abcdefghijklmnop0123');
    g.say('quartz-watch:preview {"title":"Terminator 2","tv":false,"seq":1}');
    await bare.settle();
    const a = g.last('__applyWatchPreview');
    check(a && a.state === 'off' && /no TMDB mock/.test(a.reason) && tm.calls.length === 0, 'preview (test mock): TMDB not rebased -> the real TMDB is never asked', { a, calls: tm.calls.length });
    g.say('quartz-watch:hello {}');
    const s = g.last('__applyWatch');
    check(s && s.preview && s.preview.on === true && s.preview.mock === true, 'preview (test mock): the page is told to use the mock origin', s && s.preview);
  } finally { bare.cleanup(); }
  const mocked = fakeWorld({ realSteps: true, fetch: tm, BrowserWindow: fakeBrowser().FakeBW, session: { defaultSession: {} }, test: { preview: 'mock', rebase: [['https://api.themoviedb.org', 'http://127.0.0.1:9/tmdb']] } });
  try {
    const g = mocked.guest();
    mocked.wm.setTmdbKey('abcdefghijklmnop0123');
    g.say('quartz-watch:preview {"title":"Terminator 2","tv":false,"seq":1}');
    await mocked.settle();
    const a = g.last('__applyWatchPreview');
    check(a && a.state === 'ok' && tm.calls.length === 2 && tm.calls.every((c) => c.url.indexOf('http://127.0.0.1:9/tmdb/3/') === 0), 'preview (test mock): trailers come only from the rebased mock', tm.calls.map((c) => c.url.slice(0, 40)));
  } finally { mocked.cleanup(); }
}

/* ------------------------------------------------------------------ 4. adapters + tmdb */
async function moduleTests() {
  const dir = path.join(__dirname, 'tests');
  const files = fs.readdirSync(dir).filter((f) => /^watch-adapter-.*\.js$/.test(f) || /^watch-lumen-.*-test\.js$/.test(f) || f === 'watch-tmdb-test.js' || f === 'watch-merge-test.js' || f === 'watch-preview-test.js').sort();
  for (const id of Shape.SERVICE_IDS) {
    check(files.indexOf('watch-adapter-' + id + '.js') !== -1, 'adapters: ' + id + ' has fixture tests');
    let a = null;
    try { a = require('./watch/adapters/' + id); } catch (e) { a = null; }
    check(a && typeof a.steps === 'function' && typeof a.parse === 'function', 'adapters: ' + id + ' loads with steps() and parse()');
  }
  for (const f of files) {
    const before = fail;
    let n0 = pass + fail;
    try {
      const fn = require(path.join(dir, f));
      await fn((cond, label, detail) => check(cond, f.replace(/\.js$/, '') + ': ' + label, detail));
    } catch (e) {
      check(false, f + ' threw', String(e && e.stack || e).slice(0, 300));
    }
    console.log('  ' + f + ': ' + (pass + fail - n0) + ' checks, ' + (fail - before) + ' failed');
  }
  // Every fixture says where its shape came from.
  const fx = path.join(dir, 'watch-fixtures');
  if (fs.existsSync(fx)) {
    const bad = [];
    for (const f of fs.readdirSync(fx)) {
      const text = fs.readFileSync(path.join(fx, f), 'utf8');
      if (!/shape from [^"]+unverified|public JSON, shape from/.test(text)) bad.push(f);
    }
    check(bad.length === 0, 'fixtures: every file is marked "shape from <source>, unverified..."', bad);
  }
}

/* ---- watch-auto: fresh on open, fresh after watching, the background refresh, the read limit ---- */

const T0 = Date.parse('2026-10-16T20:00:00Z');   // fakeWorld's clock starts here

/** A cache file where every service read fine `ageMin` ago (state per service overridable). */
function seededCache(ageMin, over) {
  const o = over || {};
  const services = {};
  for (const id of Shape.SERVICE_IDS) {
    const at = T0 - ((o.age && o.age[id] !== undefined ? o.age[id] : ageMin) * 60e3);
    const state = (o.state && o.state[id]) || 'ok';
    services[id] = {
      state, reason: '', readAt: at, attemptAt: at, lastOkAt: state === 'never' ? 0 : at,
      items: state === 'ok' ? mk(id, id === 'espn' ? 'live' : 'resume', 2) : [], profile: '', events: id === 'espn' ? [] : null, captured: 0, warnings: [],
    };
  }
  return { v: 1, services };
}

/** Advance the fake clock in 1-s steps for `ms`, firing every timer that falls due. */
async function runFor(w, ms) {
  const end = w.now() + ms;
  while (w.now() < end) { w.advance(Math.min(1000, end - w.now())); await w.fire(); }
}

const svcOf = (c) => c.split(':')[0];
/** The order a scheduler that reads oldest first must use: by age (minutes, `ages`, else `dflt`) descending, Shape order on a tie. */
function oldestFirst(ids, ages, dflt) {
  const age = (id) => (ages[id] !== undefined ? ages[id] : dflt);
  return ids.slice().sort((a, b) => (age(b) - age(a)) || (Shape.SERVICE_IDS.indexOf(a) - Shape.SERVICE_IDS.indexOf(b)));
}

async function autoTests() {
  // 1. Fresh on open: under 10 min nothing reads; past it everything stale reads, one at a time, oldest first.
  const openAges = { youtube: 30, disney: 12, prime: 4, espn: 20 };   // any other service: 4 min (fresh)
  let w = fakeWorld({ cache: seededCache(4, { age: openAges }) });
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {"visible":true}');
    const first = g.pushed[0] && g.pushed[0].payload;
    check(first && first.rows.length > 0 && w.calls.length === 0, 'auto: the cached rows go out at once, before any read', first && first.rows.length);
    await w.settle();
    check(w.calls.map(svcOf).join(',') === 'youtube,espn,disney', 'auto: on open, every service over 10 min old reads, oldest first (Prime at 4 min waits)', w.calls);
    check(w.maxConcurrent === 1, 'auto: on open, one service at a time', w.maxConcurrent);
    w.calls.length = 0;
    g.say('quartz-watch:visible {"visible":false}');
    w.advance(5 * 60e3);
    g.say('quartz-watch:visible {"visible":true}');
    await w.settle();
    check(w.calls.length === 0, 'auto: back on screen 5 min later: nothing under 10 min old re-reads', w.calls);
    g.say('quartz-watch:visible {"visible":false}');
    w.advance(6 * 60e3);
    g.say('quartz-watch:visible {"visible":true}');
    await w.settle();
    // Those not read on open (under 10 min then) are oldest now; the rest were tried at the same moment: Shape order.
    const read1 = w.readers.filter((id) => (openAges[id] !== undefined ? openAges[id] : 4) >= 10);
    const want1 = w.readers.filter((id) => read1.indexOf(id) === -1).concat(read1);   // the unread are older now; ties in Shape order
    check(w.calls.map(svcOf).join(',') === want1.join(','), 'auto: back on screen 11 min later: every service, staggered oldest first', { got: w.calls.map(svcOf), want: want1 });
    check(w.maxConcurrent === 1, 'auto: still one at a time', w.maxConcurrent);
  } finally { w.cleanup(); }

  // 2. Fresh after watching: the service he opened a title on reads first when he comes back.
  w = fakeWorld({ cache: seededCache(1) });
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {"visible":true}');
    await w.settle();
    check(w.calls.length === 0, 'auto: everything fresh: opening Watch reads nothing', w.calls);
    g.say('quartz-watch:open {"url":"https://www.disneyplus.com/play/abc"}');
    await w.settle();
    check(w.wm.state().watched.disney > 0, 'auto: opening a Disney+ title marks Disney+ to re-read');
    g.say('quartz-watch:visible {"visible":false}');
    w.advance(10e3);
    g.say('quartz-watch:visible {"visible":true}');
    await w.settle();
    check(w.calls.length === 0 && w.wm.state().watched.disney > 0, 'auto: back after 10 s (a mis-click): no read yet, the mark stays', w.calls);
    g.say('quartz-watch:visible {"visible":false}');
    w.advance(5 * 60e3);
    g.say('quartz-watch:visible {"visible":true}');
    await w.settle();
    check(w.calls.map(svcOf).join(',') === 'disney', 'auto: back after 5 min: Disney+ re-reads (its Continue watching moved), nothing else', w.calls);
    check(!w.wm.state().watched.disney, 'auto: the read clears the mark');
    // A title that opened in Edge: Watch never left the screen, Quartz got focus back.
    w.calls.length = 0;
    g.say('quartz-watch:open {"url":"https://www.primevideo.com/detail/xyz"}');
    w.advance(3 * 60e3);
    w.wm.windowFocused();
    await w.settle();
    check(w.calls.map(svcOf).join(',') === 'prime', 'auto: Quartz focused again after Edge: Prime re-reads first', w.calls);
    // Mixed: a watched service jumps the stale ones.
    w.calls.length = 0;
    g.say('quartz-watch:open {"url":"https://www.youtube.com/watch?v=q"}');
    g.say('quartz-watch:visible {"visible":false}');
    w.advance(11 * 60e3);
    g.say('quartz-watch:visible {"visible":true}');
    await w.settle();
    check(w.calls.length === w.readers.length && svcOf(w.calls[0]) === 'youtube', 'auto: the watched service reads first, then the stale rest', w.calls);
    // A title that is not on a service marks nothing.
    g.say('quartz-watch:open {"url":"https://www.themoviedb.org/movie/1"}');
    check(Object.keys(w.wm.state().watched).length === 0, 'auto: a TMDB page marks no service', w.wm.state().watched);
  } finally { w.cleanup(); }

  // 3. The background refresh: no Watch page on screen.
  const bgAges = { youtube: 90, disney: 70, prime: 65, espn: 61 };
  w = fakeWorld({ background: true, cache: seededCache(61, { age: bgAges }) });
  const bgWant = oldestFirst(w.readers, bgAges, 61);
  w.saver = false;
  try {
    check(w.wm.describe().background.on === true, 'bg: on by default');
    await runFor(w, 60e3);
    check(w.calls.length === 0, 'bg: nothing in the first 2 min after start (boot delay)', w.calls);
    await runFor(w, 70e3);
    check(w.calls.map(svcOf).join(',') === bgWant[0], 'bg: after the boot delay, ONE read, the oldest (no Watch page open at all)', w.calls);
    await runFor(w, 60e3);
    check(w.calls.length === 1, 'bg: the next one waits its 2-min gap', w.calls);
    await runFor(w, (bgWant.length - 1) * 2 * 60e3 + 60e3);
    check(w.calls.map(svcOf).join(',') === bgWant.join(','), 'bg: then the rest, oldest first, one at a time, 2 min apart', { got: w.calls.map(svcOf), want: bgWant });
    check(w.maxConcurrent === 1, 'bg: never two readers at once', w.maxConcurrent);
    const since = w.calls.length;
    await runFor(w, 40 * 60e3);
    check(w.calls.length === since, 'bg: nothing again inside 60 min', w.calls.slice(since));
    await runFor(w, 25 * 60e3);
    check(w.calls.length > since && w.calls.length <= since + w.readers.length, 'bg: 60 min later each service reads again, at most once', w.calls.slice(since));
    check(w.wm.describe().background.reads >= w.readers.length + 1 && w.wm.describe().background.waiting === '', 'bg: describe() counts the reads, waiting nothing', w.wm.describe().background);
    const snap = w.wm.snapshot();
    check(snap.services.every((s) => !s.paused), 'bg: background reads set no page pause', snap.services.map((s) => s.paused));
  } finally { w.cleanup(); }

  // 3b. Each gate, both ways: blocked -> no read and the reason; cleared -> it reads.
  const gates = [
    ['free RAM 2.0 GB', (x) => { x.free = 2.0; }, (x) => { x.free = 3.0; }, /GB of memory free/],
    ['a game', (x) => { x.game = 'valorant'; }, (x) => { x.game = ''; }, /VALORANT/],
    ['Quartz minimised', (x) => { x.showing = false; }, (x) => { x.showing = true; }, /minimised/],
    ['battery saver', (x) => { x.saver = true; }, (x) => { x.saver = false; }, /battery saver/],
  ];
  for (const [name, block, clear, re] of gates) {
    w = fakeWorld({ background: true, cache: seededCache(61), test: { saverOn: () => w.saver } });
    w.saver = false;
    try {
      block(w);
      await runFor(w, 3 * 60e3);
      const bgd = w.wm.describe().background;
      check(w.calls.length === 0 && re.test(bgd.waiting), 'bg gate ' + name + ': blocked, no read, reason shown', { calls: w.calls, waiting: bgd.waiting });
      clear(w);
      await runFor(w, 5 * 60e3);
      check(w.calls.length === 0, 'bg gate ' + name + ': cleared, it waits out its 10-min pause (no tight loop)', w.calls);
      await runFor(w, 6 * 60e3);
      check(w.calls.length >= 1 && w.wm.describe().background.waiting === '', 'bg gate ' + name + ': cleared, it reads', { calls: w.calls, waiting: w.wm.describe().background.waiting });
    } finally { w.cleanup(); }
  }
  // 1.5-2.5 GB blocks the background but not an on-screen read.
  w = fakeWorld({ background: true, cache: seededCache(61), test: { saverOn: () => null } });
  try {
    w.free = 2.0;
    await runFor(w, 3 * 60e3);
    check(w.calls.length === 0, 'bg: 2.0 GB free blocks the background read', w.calls);
    const g = w.guest();
    g.say('quartz-watch:hello {"visible":true}');
    await w.settle();
    check(w.calls.length === w.readers.length, 'bg: ...but opening it at 2.0 GB still reads (the on-screen floor is 1.5 GB)', w.calls);
  } finally { w.cleanup(); }
  // A battery-saver answer of null (cannot tell) does not block.
  w = fakeWorld({ background: true, cache: seededCache(61), test: { saverOn: () => null } });
  try {
    await runFor(w, 3 * 60e3);
    check(w.calls.length === 1, 'bg: saver unknown (null) counts as off', w.calls);
  } finally { w.cleanup(); }
  // A throwing saver check does not break anything either.
  w = fakeWorld({ background: true, cache: seededCache(61), test: { saverOn: () => { throw new Error('x'); } } });
  try {
    await runFor(w, 3 * 60e3);
    check(w.calls.length === 1, 'bg: a saver check that throws counts as off', w.calls);
  } finally { w.cleanup(); }

  // 3c. Off in Settings: no timer, no reads; on again: it plans.
  w = fakeWorld({ background: true, cache: seededCache(61), test: { saverOn: () => false } });
  try {
    const d0 = w.wm.setBackground(false);
    check(d0.background.on === false && w.wm.state().bgTimerAt === 0, 'bg off: describe says off, no background timer', d0.background);
    await runFor(w, 10 * 60e3);
    check(w.calls.length === 0, 'bg off: nothing reads in the background', w.calls);
    const saved = JSON.parse(fs.readFileSync(path.join(w.dir, WM.PREFS_FILE), 'utf8'));
    check(saved.background === false, 'bg off: saved to watch.json', saved);
    w.wm.setBackground(true);
    check(w.wm.state().bgTimerAt > 0, 'bg on again: the timer is armed');
    await runFor(w, 3 * 60e3);
    check(w.calls.length >= 1, 'bg on again: it reads', w.calls);
  } finally { w.cleanup(); }
  check(Shape.SERVICES.every((s) => s.everyMin <= 15), 'floors: every service reads at most 15 min apart on screen', Shape.SERVICES.map((s) => s.id + ':' + s.everyMin));
  check(WM.cleanPrefs({}).background === true && WM.cleanPrefs({ background: false }).background === false && WM.cleanPrefs({ background: 'no' }).background === true,
    'bg: the pref defaults ON; only an explicit false turns it off');

  // 3d. Only services that read fine before: never / signed-out are left alone.
  w = fakeWorld({ background: true, cache: seededCache(61, { state: { youtube: 'signed-out', prime: 'never' } }), test: { saverOn: () => false } });
  try {
    const want3d = w.readers.filter((id) => id !== 'youtube' && id !== 'prime');
    await runFor(w, want3d.length * 2 * 60e3 + 4 * 60e3);
    check(w.calls.map(svcOf).sort().join(',') === want3d.slice().sort().join(','), 'bg: a signed-out or never-read service is not read in the background', { got: w.calls, want: want3d });
  } finally { w.cleanup(); }

  // 3e. A Watch page on screen uses the on-screen schedule, not the background one; hidden -> background.
  w = fakeWorld({ background: true, cache: seededCache(1), test: { saverOn: () => false } });
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {"visible":true}');
    await w.settle();
    check(w.wm.state().bgTimerAt === 0 && w.wm.state().timerAt > 0, 'bg: a visible page: the on-screen timer, no background timer', w.wm.state());
    await runFor(w, 15 * 60e3);
    check(w.readers.every((id) => w.calls.some((c) => svcOf(c) === id)), 'on screen: every service at 15 min (Disney+ and Prime too)', w.calls);
    g.say('quartz-watch:visible {"visible":false}');
    await w.settle();
    check(w.wm.state().timerAt === 0 && w.wm.state().bgTimerAt > 0, 'bg: hidden: the background timer takes over', w.wm.state());
    w.calls.length = 0;
    await runFor(w, 30 * 60e3);
    check(w.calls.length === 0, 'bg: hidden 30 min after a read: no background read yet (60-min floor)', w.calls);
    await runFor(w, 40 * 60e3);
    check(w.calls.length >= 1 && w.calls.length <= w.readers.length, 'bg: hidden over 60 min: background reads resume', w.calls);
  } finally { w.cleanup(); }

  // 4. The read's time limit: past it the read is stopped, the service says why, a late answer is dropped.
  w = fakeWorld({ cache: seededCache(1), test: { readLimitMs: 3000 } });
  try {
    w.behaviour.disney = () => ({ delayMs: 8000 });
    const g = w.guest();
    g.say('quartz-watch:hello {"visible":true}');
    await w.settle();
    g.say('quartz-watch:refresh {"service":"disney"}');
    await w.settle();
    const mid = w.svc(g.last('__applyWatch'), 'disney');
    check(mid.reading === true && mid.readingSince > 0 && mid.readLimitMs === 3000, 'limit: while reading, the page gets readingSince and readLimitMs', mid);
    await runFor(w, 4000);
    const after = w.svc(g.last('__applyWatch'), 'disney');
    check(after.reading === false && after.state === 'error' && /longer than 3 s/.test(after.reason), 'limit: past it, Disney+ says it took too long (error + reason, so Retry shows)', after);
    check(after.lastOkAt > 0 && w.wm.snapshot().items.some((it) => it.service === 'disney'), 'limit: the last good rows stay');
    await runFor(w, 6000);
    const late = w.svc(w.wm.snapshot(), 'disney');
    check(late.state === 'error', 'limit: the late answer is dropped, not written', late.state);
    check(w.logs.some((l) => /stopped reading Disney\+ after its 3 s limit/.test(l)), 'limit: logged');
    w.behaviour.disney = null;
    // no 30-s wait: a failed read can be retried at once
    g.say('quartz-watch:refresh {"service":"disney"}');
    await w.settle();
    check(w.svc(w.wm.snapshot(), 'disney').state === 'ok', 'limit: Retry right away (no 30-s gap after a failure) reads again and recovers');
  } finally { w.cleanup(); }
  // The real limit: every step's budget + grace + 10 s.
  w = fakeWorld({ cache: seededCache(1) });
  try {
    const g = w.guest();
    g.say('quartz-watch:hello {"visible":true}');
    await w.settle();
    w.behaviour.youtube = () => ({ delayMs: 2000 });
    g.say('quartz-watch:refresh {"service":"youtube"}');
    await w.settle();
    const yt = w.svc(g.last('__applyWatch'), 'youtube');
    check(yt.readLimitMs === WM.STEP_BUDGET_MS + 5000 + 10000, 'limit: one 20-s step -> a 35-s limit', yt.readLimitMs);
    await runFor(w, 3000);
  } finally { w.cleanup(); }
}

(async () => {
  try {
    shapeTests();
    mergeTests();
    await mainTests();
    await reviewFixTests();
    await autoTests();
    await previewMainTests();
    await moduleTests();
  } catch (e) {
    check(false, 'HARNESS ERROR ' + (e && e.stack || e));
  }
  console.log('watch: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
