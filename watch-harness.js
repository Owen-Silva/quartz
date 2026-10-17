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
  check(Shape.serviceForUrl('https://youtu.be/x') === 'youtube' && Shape.serviceForUrl('https://www.hulu.com/x') === 'disney'
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
  const host = { youtube: 'https://www.youtube.com/watch?v=', disney: 'https://www.disneyplus.com/browse/entity-', prime: 'https://www.primevideo.com/detail/', espn: 'https://www.espn.com/nhl/game/_/gameId/' }[service];
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
  check(links.length === 4 && links[0].url === 'https://www.youtube.com/results?search_query=the%20bear', 'merge: per-service search links', links.map((l) => l.url));
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
    game: '', free: 8, showing: true,
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
    prime: adapter('prime', 'view'),
    espn: adapter('espn', 'fetch'),
  };
  world.wm = WM.create({
    dir,
    adapters,
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms, ms, unref() {} }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i !== -1) timers.splice(i, 1); },
    freeGb: () => world.free,
    send: (ch, p) => sent.push([ch, p]),
    openInEdge: (url) => { edge.push(url); return Promise.resolve(world.edgeFail ? { ok: false, how: 'msedge', reason: 'Edge did not start' } : { ok: true, how: 'msedge', reason: '' }); },
    isBundledPage: (url) => typeof url === 'string' && url.indexOf('file:///app/') === 0,
    log: (l) => logs.push(l),
    test: Object.assign({ gameRunning: () => world.game, windowShowing: () => world.showing }, o.test || {}),
    runStep: async (step, rebase) => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      const svc = step.name === 'search' ? 'search' : (Shape.SERVICE_IDS.find((id) => (step.url || '').indexOf(new URL(Shape.serviceById(id).home).hostname) !== -1) || '?');
      calls.push(svc + ':' + step.name + ':' + rebase(step.url));
      await new Promise((r) => setImmediate(r));
      concurrent--;
      const b = world.behaviour[svc];
      const extra = b ? b(step) : {};
      if (extra === 'HANG') return new Promise(() => { /* a reader that never answers */ });
      return Object.assign(okStep(step), extra);
    },
  });
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
    check(first && first.fn === '__applyWatch' && first.payload.services.length === 4 && first.payload.services.every((s) => s.state === 'never'), 'main: hello answers at once from the (empty) cache', first && first.payload.services.map((s) => s.state));
    await w.settle();
    const snap = g.last('__applyWatch');
    check(snap.services.every((s) => s.state === 'ok'), 'main: every service read after hello', snap.services.map((s) => s.state + ':' + s.reason));
    check(w.maxConcurrent === 1, 'main: one read at a time', w.maxConcurrent);
    check(w.calls.length === 4, 'main: one step per service', w.calls);
    check(snap.rows.find((r) => r.id === 'continue').items.length === 9, 'main: rows built from every service', snap.rows.map((r) => r.id + ':' + r.items.length));
    check(w.svc(snap, 'disney').profile === 'the user', 'main: the profile name travels');
    check(g.pushed.some((p) => p.fn === '__applyWatch' && p.payload.services.some((s) => s.reading)), 'main: the page is told what is reading');
    check(w.timers.length >= 1, 'main: a timer is armed while the page is open');
    w.wm.flush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(w.dir, 'watch-cache.json'), 'utf8'));
    check(onDisk.services.youtube.items.length === 3 && !JSON.stringify(onDisk).includes('captures'), 'main: the cache file holds items only, never raw captures');

    // cadence: nothing is due a minute later; YouTube at 16 min; Disney+ not until 60
    w.calls.length = 0;
    w.advance(60e3);
    g.say('quartz-watch:hello {}');
    await w.settle();
    check(w.calls.length === 0, 'main: a second hello inside the floor reads nothing', w.calls);
    w.advance(15 * 60e3);
    await w.fire();
    check(w.calls.some((c) => c.indexOf('youtube') === 0) && w.calls.some((c) => c.indexOf('espn') === 0) && !w.calls.some((c) => c.indexOf('disney') === 0), 'main: at 16 min YouTube and ESPN are due, Disney+ is not', w.calls);

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
    const s = g.last('__applyWatch');
    const d = w.svc(s, 'disney');
    check(d.state === 'error' && d.reason === 'timed out after 20 s' && d.counts.resume === 3 && d.lastOkAt > 0, 'main: an error keeps the last good rows and says why', d);
    check(w.svc(s, 'prime').state === 'signed-out' && w.svc(s, 'prime').counts.resume === 0, 'main: signed out drops that account\'s rows');
    const y = w.svc(s, 'youtube');
    check(y.state === 'error' && /reader failed \(boom\)/.test(y.reason), 'main: an adapter that throws is an error, not a crash', y.reason);
    check(w.svc(s, 'espn').state === 'ok' && s.rows.length > 0, 'main: the others still draw');
    check(w.logs.filter((l) => /Watch could not read/.test(l)).length === 3, 'main: one log line per failed service', w.logs);
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
    check(w.calls.length === 3 && !w.calls.some((c) => c.indexOf('espn') === 0),
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
    check(a.links.length === 4, 'main: the per-service links come along');
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
    check(a.youtube.ok === false && a.youtube.reason === "you're offline" && a.links.length === 4, 'main: a failed search says why and keeps the links', a.youtube);
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

/* ------------------------------------------------------------------ 4. adapters + tmdb */
async function moduleTests() {
  const dir = path.join(__dirname, 'tests');
  const files = fs.readdirSync(dir).filter((f) => /^watch-adapter-.*\.js$/.test(f) || f === 'watch-tmdb-test.js').sort();
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

(async () => {
  try {
    shapeTests();
    mergeTests();
    await mainTests();
    await moduleTests();
  } catch (e) {
    check(false, 'HARNESS ERROR ' + (e && e.stack || e));
  }
  console.log('watch: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
