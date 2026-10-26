// adblock-refresh-harness.js -- the ad-block list refresh without Electron: the words, the
// "is it due" decision, the candidate checks (shrink, empty, oversize, corrupt), the atomic write
// (temp + rename, .prev kept, a refused rename leaves the original), the refresher driven by fakes
// (keeps the old engine on every failure, retries in an hour, a day after a success), a real
// Ghostery build through the strict fetch (bad status, web page), the session hooks on a fake
// session (registered once, swap without re-registering, the headers type filter, the counters),
// and the shield's status line. Writes only into a temp folder it deletes.
//
//   node adblock-refresh-harness.js
//
// One summary line: "adblock-refresh-test: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const R = require('./adblock-refresh');
const W = require('./adblock-build-worker');
const H = require('./adblock-hooks');
const { FiltersEngine } = require('@ghostery/adblocker');

let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
}
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-adblock-harness-'));
const HOUR = R.HOUR_MS, DAY = R.DAY_MS;

/** A fetch answering Ghostery's list URLs from a table (path suffix -> body). */
function fakeFetch(table, opts = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (opts.reject) throw opts.reject;
    const status = opts.status || 200;
    const hit = Object.keys(table).find((k) => url.endsWith(k));
    const body = hit ? table[hit] : (url.endsWith('.json') ? '[]' : '! empty list\n');
    return { ok: status >= 200 && status < 300, status, headers: { get: () => opts.type || 'text/plain' }, text: async () => body };
  };
  fn.calls = calls;
  return fn;
}

/** Manual timers for the refresher. */
function fakeTimers() {
  let seq = 0;
  const q = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; q.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => q.delete(id),
    pending: () => [...q.values()].map((t) => t.ms),
    fireAll: () => { const all = [...q.entries()]; q.clear(); for (const [, t] of all) t.fn(); },
  };
}

(async () => { try {
  /* ---- 1. words ------------------------------------------------------------------------------- */
  check(R.ageWords(5 * 60 * 1000) === 'just now', 'ageWords: minutes = just now');
  check(R.ageWords(5 * HOUR) === '5 hours ago' && R.ageWords(HOUR) === '1 hour ago', 'ageWords: hours');
  check(R.ageWords(DAY + HOUR) === 'yesterday' && R.ageWords(45 * DAY) === '45 days ago', 'ageWords: days');
  const offline = new TypeError('fetch failed'); offline.cause = Object.assign(new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com'), { code: 'ENOTFOUND' });
  check(R.failureWords(offline) === 'offline', 'failureWords: fetch failed + ENOTFOUND cause = offline', R.failureWords(offline));
  const refused = new TypeError('fetch failed'); refused.cause = { code: 'ECONNREFUSED' };
  check(R.failureWords(refused) === 'the list server refused the connection', 'failureWords: ECONNREFUSED');
  check(R.failureWords(Object.assign(new Error('x'), { name: 'TimeoutError' })) === 'the download timed out', 'failureWords: timeout');
  check(R.failureWords(Object.assign(new Error('x'), { code: 'ENOSPC' })) === 'couldn\'t save them: the disk is full', 'failureWords: disk full');
  check(R.failureWords(R.wordsError('the list server answered 503')) === 'the list server answered 503', 'failureWords: our own words pass through');
  check(R.failureWords(null) === 'unknown error' && R.failureWords(new Error('')) === 'unknown error', 'failureWords: never empty');
  check(R.looksLikeHtml('<!DOCTYPE html><html>', '') && R.looksLikeHtml('x', 'text/html; charset=utf-8'), 'looksLikeHtml: doctype or content-type');
  check(!R.looksLikeHtml('[Adblock Plus 2.0]\n! Title: EasyList', 'text/plain'), 'looksLikeHtml: a real list is not a page');

  /* ---- 2. due / next delay -------------------------------------------------------------------- */
  const now = Date.UTC(2026, 9, 26, 12);
  check(R.isDue(0, now, DAY), 'isDue: no cache is due');
  check(R.isDue(now - 45 * DAY, now, DAY), 'isDue: 45 days old is due');
  check(!R.isDue(now - 2 * HOUR, now, DAY), 'isDue: 2 hours old is not');
  check(R.isDue(now + 3 * DAY, now, DAY), 'isDue: a cache dated in the future (clock moved) is due');
  check(R.nextDelay({ updatedAt: now - 2 * HOUR, now, intervalMs: DAY }) === 22 * HOUR, 'nextDelay: the rest of the day');
  check(R.nextDelay({ updatedAt: now, now, lastFailed: true, retryMs: HOUR }) === HOUR, 'nextDelay: an hour after a failure');

  /* ---- 3. candidate checks -------------------------------------------------------------------- */
  const big = new Uint8Array(4096);
  check(R.validateCandidate({ bytes: big, filters: 90000, prevFilters: 100000 }) === '', 'validate: a normal update passes');
  check(/only 40000 filters \(the current ones have 100000\)/.test(R.validateCandidate({ bytes: big, filters: 40000, prevFilters: 100000 })), 'validate: a shrink below half is refused, with both counts');
  check(R.validateCandidate({ bytes: big, filters: 40000, prevFilters: 0 }) === '', 'validate: unknown previous count skips the shrink check');
  check(/empty/.test(R.validateCandidate({ bytes: new Uint8Array(10), filters: 5 })), 'validate: tiny bytes refused');
  check(/too large/.test(R.validateCandidate({ bytes: { length: 65 * 1048576 }, filters: 5 })), 'validate: oversize refused');
  check(/no filters/.test(R.validateCandidate({ bytes: big, filters: 0 })), 'validate: zero filters refused');

  /* ---- 4. atomic write ------------------------------------------------------------------------ */
  {
    const target = path.join(DIR, 'adblock-engine.bin');
    fs.writeFileSync(target, 'OLD');
    await R.writeAtomic(fs.promises, target, Buffer.from('NEW'));
    check(fs.readFileSync(target, 'utf8') === 'NEW', 'writeAtomic: the new bytes are in place');
    check(fs.readFileSync(target + '.prev', 'utf8') === 'OLD', 'writeAtomic: the old file is kept as .prev');
    check(!fs.existsSync(target + '.tmp'), 'writeAtomic: no temp file left');

    let renames = 0;
    const refusing = Object.assign({}, fs.promises, {
      rename: async () => { renames++; throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); },
    });
    let threw = null;
    try { await R.writeAtomic(refusing, target, Buffer.from('BROKEN')); } catch (e) { threw = e; }
    check(threw && threw.code === 'EPERM' && renames === 3, 'writeAtomic: a refused rename is retried, then fails', { renames, code: threw && threw.code });
    check(fs.readFileSync(target, 'utf8') === 'NEW', 'writeAtomic: after a failed rename the original is untouched');
    check(!fs.existsSync(target + '.tmp'), 'writeAtomic: the temp file is removed on failure');

    const first = path.join(DIR, 'fresh.bin');
    await R.writeAtomic(fs.promises, first, Buffer.from('FIRST'));
    check(fs.readFileSync(first, 'utf8') === 'FIRST' && !fs.existsSync(first + '.prev'), 'writeAtomic: a first save needs no old file');
  }

  /* ---- 5. the refresher, on fakes ------------------------------------------------------------- */
  function rig(over = {}) {
    const t = fakeTimers();
    const rec = { installs: [], saves: [], metas: [], logs: [], states: [] };
    let clock = now;
    const d = Object.assign({
      now: () => clock,
      cacheMtime: async () => now - 3 * DAY,
      readMeta: async () => ({ filters: 100000 }),
      writeMeta: async (m) => { rec.metas.push(m); },
      build: async () => ({ bytes: big, filters: 101000 }),
      deserialize: (bytes) => ({ engine: true, bytes }),
      save: async (bytes) => { rec.saves.push(bytes); },
      install: (engine) => { rec.installs.push(engine); },
      onState: (s) => rec.states.push(s),
      log: (l) => rec.logs.push(l),
      setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
      firstDelayMs: 30000,
    }, over);
    const r = R.createRefresher(d);
    return { r, t, rec, tick: (ms) => { clock += ms; } };
  }
  {
    const { r, t, rec } = rig();
    const s0 = await r.start();
    check(s0.updatedAt === now - 3 * DAY && s0.filters === 100000, 'refresher: start reads the cache age and the saved count', s0);
    check(t.pending().length === 1 && t.pending()[0] === 30000, 'refresher: a 3-day-old cache is refreshed 30 s after start, not on the startup path', t.pending());
    check(rec.installs.length === 0, 'refresher: nothing is built at start');
    const s1 = await r.runOnce();
    check(rec.installs.length === 1 && rec.saves.length === 1, 'refresher: success saves then installs', rec);
    check(s1.error === '' && s1.updatedAt === now && s1.filters === 101000 && !s1.refreshing, 'refresher: state after success', s1);
    check(rec.metas.length === 1 && rec.metas[0].filters === 101000, 'refresher: the new count is saved for next time');
    check(rec.states.some((s) => s.refreshing === true), 'refresher: the UI is told while it runs');
    check(t.pending().includes(DAY), 'refresher: the next check is a day later', t.pending());
    check(rec.logs.some((l) => /were updated \(101000 filters, was 100000; the old lists were from 3 days ago\)/.test(l)), 'refresher: the update is logged', rec.logs);
    r.stop();
  }
  {
    const { r, t } = rig({ cacheMtime: async () => now - 2 * HOUR });
    await r.start();
    check(t.pending()[0] === 22 * HOUR, 'refresher: a fresh cache waits out the rest of its day', t.pending());
    r.stop();
    const forced = rig({ cacheMtime: async () => now - 2 * HOUR, force: true, firstDelayMs: 1000 });
    await forced.r.start();
    check(forced.t.pending()[0] === 1000, 'refresher: test mode can force a refresh of a fresh cache', forced.t.pending());
    forced.r.stop();
  }
  async function failing(name, over, expectWords, expectSaved) {
    const { r, t, rec } = rig(over);
    await r.start();
    const s = await r.runOnce();
    check(rec.installs.length === 0, name + ': the old engine stays (nothing installed)');
    check(expectWords.test(s.error), name + ': the reason is in plain words', s.error);
    check(s.updatedAt === now - 3 * DAY, name + ': the lists in use keep their date', s.updatedAt);
    check(rec.saves.length === (expectSaved ? 1 : 0), name + ': the cache file is ' + (expectSaved ? 'written' : 'not touched'), rec.saves.length);
    check(t.pending().includes(HOUR), name + ': tried again in an hour', t.pending());
    check(rec.logs.some((l) => /could not update its filter lists/.test(l) && /still using lists from 3 days ago/.test(l)), name + ': logged with the age of the lists in use', rec.logs);
    r.stop();
    return s;
  }
  await failing('offline', { build: async () => { throw offline; } }, /^offline$/, false);
  await failing('shrink', { build: async () => ({ bytes: big, filters: 30 }) }, /only 30 filters/, false);
  await failing('worker count used when no saved count', { readMeta: async () => null, build: async () => ({ bytes: big, filters: 30, prevFilters: 100000 }) }, /only 30 filters \(the current ones have 100000\)/, false);
  await failing('corrupt', { deserialize: () => { throw new Error('serialized engine checksum mismatch'); } }, /could not be read back \(serialized engine checksum mismatch\)/, false);
  await failing('save fails', { save: async () => { throw Object.assign(new Error('nope'), { code: 'ENOSPC' }); } }, /couldn't save them: the disk is full/, false);
  await failing('install throws', { install: () => { throw new Error('boom'); } }, /could not be switched on \(boom\)/, true);
  {
    // A later success clears the error.
    let n = 0;
    const { r, rec } = rig({ build: async () => { if (n++ === 0) throw offline; return { bytes: big, filters: 100500 }; } });
    await r.start();
    const a = await r.runOnce();
    const b = await r.runOnce();
    check(a.error === 'offline' && b.error === '' && rec.installs.length === 1, 'refresher: a success after a failure clears the reason', { a: a.error, b: b.error });
    r.stop();
  }
  {
    // Two triggers at once share one build.
    let builds = 0;
    const { r } = rig({ build: async () => { builds++; await new Promise((res) => setTimeout(res, 20)); return { bytes: big, filters: 100000 }; } });
    await r.start();
    await Promise.all([r.runOnce(), r.runOnce()]);
    check(builds === 1, 'refresher: concurrent triggers share one build', builds);
    r.stop();
  }

  /* ---- 6. a real Ghostery build through the strict fetch -------------------------------------- */
  {
    const lists = { 'easylist/easylist.txt': '||ads.example^\n##.ad-banner\n', 'easylist/easyprivacy.txt': '||track.example^\n' };
    const ok = await W.buildEngine({ fetchImpl: fakeFetch(lists) });
    check(ok.filters === 3 && ok.bytes.length > 0, 'build: a real engine from fake lists', { filters: ok.filters, bytes: ok.bytes.length });
    const eng = FiltersEngine.deserialize(ok.bytes);
    check(eng.getFilters().networkFilters.length === 2, 'build: the bytes deserialize to the same filters');
    const bad = Uint8Array.from(ok.bytes); bad[bad.length - 9] ^= 0xff;
    let corrupt = '';
    try { FiltersEngine.deserialize(bad); } catch (e) { corrupt = e.message; }
    check(/checksum/.test(corrupt), 'build: a flipped byte fails deserialize (integrity check)', corrupt);

    const f = fakeFetch(lists);
    await W.buildEngine({ fetchImpl: f, listBase: 'http://127.0.0.1:9/lists' });
    check(f.calls.length > 0 && f.calls.every((u) => u.startsWith('http://127.0.0.1:9/lists/')), 'build: test mode maps every list URL to the local base', f.calls.slice(0, 2));
    check(f.calls.some((u) => u.endsWith('/ublock-origin/resources.json')), 'build: resources come from the same base');

    let e503 = null;
    try { await W.buildEngine({ fetchImpl: fakeFetch(lists, { status: 503 }) }); } catch (e) { e503 = e; }
    check(e503 && R.failureWords(e503) === 'the list server answered 503', 'build: an error status is a failure, not a list', e503 && e503.message);
    let page = null;
    try { await W.buildEngine({ fetchImpl: fakeFetch(lists, { type: 'text/html' }) }); } catch (e) { page = e; }
    check(page && /web page instead of a filter list/.test(R.failureWords(page)), 'build: a sign-in page is a failure', page && page.message);
    let off = null;
    try { await W.buildEngine({ fetchImpl: fakeFetch(lists, { reject: offline }) }); } catch (e) { off = e; }
    check(off && R.failureWords(off) === 'offline', 'build: offline survives Ghostery\'s retries as "offline"', off && off.message);

    const cache = path.join(DIR, 'prev.bin');
    fs.writeFileSync(cache, Buffer.from(ok.bytes));
    const counted = await W.buildEngine({ fetchImpl: fakeFetch(lists), cachePath: cache, countPrev: true });
    check(counted.prevFilters === 3, 'build: counts the filters of the cache in use when asked', counted.prevFilters);
    fs.writeFileSync(cache, 'garbage');
    const noCount = await W.buildEngine({ fetchImpl: fakeFetch(lists), cachePath: cache, countPrev: true });
    check(noCount.prevFilters === 0 && noCount.filters === 3, 'build: an unreadable old cache only skips the count');
  }

  /* ---- 7. the session hooks ------------------------------------------------------------------- */
  {
    const reg = { headers: [], request: [], sendHeaders: 0, preload: [], unpreload: [] };
    const session = {
      webRequest: {
        onHeadersReceived: (filter, fn) => reg.headers.push(filter === null ? null : { filter, fn }),
        onBeforeRequest: (filter, fn) => reg.request.push(filter === null ? null : { filter, fn }),
        onBeforeSendHeaders: () => { reg.sendHeaders++; },
      },
      registerPreloadScript: (o) => { reg.preload.push(o); return 'pre-1'; },
      unregisterPreloadScript: (id) => reg.unpreload.push(id),
    };
    const handlers = new Map();
    const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
    const mk = (name) => ({
      name,
      onBeforeRequest: (d, cb) => cb(d.url.includes('ads') ? { cancel: true, by: name } : { by: name }),
      onHeadersReceived: (d, cb) => cb({ by: name }),
      onInjectCosmeticFilters: (e, url) => 'css-from-' + name,
      onIsMutationObserverEnabled: () => true,
    });
    let current = mk('old');
    const hooks = H.createAdblockHooks({ ipcMain, preloadPath: '/p.cjs', getBlocker: () => current });
    hooks.enable(session);
    hooks.enable(session);
    check(reg.headers.length === 1 && reg.request.length === 1 && reg.preload.length === 1, 'hooks: registered once, a second enable is a no-op', reg);
    check(JSON.stringify(reg.headers[0].filter.types) === '["mainFrame","subFrame"]', 'hooks: the headers hook is limited to pages and frames', reg.headers[0].filter);
    check(!reg.request[0].filter.types, 'hooks: the request hook keeps every type (so "other" is still blocked)');
    check(handlers.has(H.INJECT_CHANNEL) && handlers.has(H.MUTATION_CHANNEL), 'hooks: both cosmetic channels are handled');

    const call = (fn, d) => { let got = []; fn(d, (r) => got.push(r)); return got; };
    const req = reg.request[0].fn;
    check(call(req, { url: 'https://ads.example/a.js', resourceType: 'script' })[0].by === 'old', 'hooks: the engine in use answers');
    current = mk('new'); // the swap: one assignment, nothing re-registered
    check(call(req, { url: 'https://ads.example/a.js', resourceType: 'script' })[0].by === 'new', 'hooks: after a swap the new engine answers, same listener');
    check(reg.headers.length === 1 && reg.request.length === 1, 'hooks: a swap registers nothing');
    check(handlers.get(H.INJECT_CHANNEL)({}, 'https://x.example/') === 'css-from-new', 'hooks: cosmetic filters come from the new engine');
    check(handlers.get(H.INJECT_CHANNEL)({}, 'file:///C:/app/index.html') === undefined, 'hooks: the chrome (file://) gets no cosmetic CSS');

    current = { onBeforeRequest: () => { throw new Error('engine bug'); } };
    const got = call(req, { url: 'https://x.example/', resourceType: 'image' });
    check(got.length === 1 && JSON.stringify(got[0]) === '{}', 'hooks: an engine that throws lets the request through, answered once', got);
    current = { onBeforeRequest: (d, cb) => { cb({ cancel: true }); throw new Error('after'); } };
    const got2 = call(req, { url: 'https://x.example/', resourceType: 'image' });
    check(got2.length === 1 && got2[0].cancel === true, 'hooks: a throw after answering is not a second answer', got2);
    current = null;
    check(JSON.stringify(call(req, { url: 'https://x.example/', resourceType: 'xhr' })[0]) === '{}', 'hooks: no engine = pass through');
    call(reg.headers[0].fn, { url: 'https://x.example/', resourceType: 'mainFrame' });

    const st = hooks.stats();
    check(st.requestTotal === 5 && st.request.script === 2 && st.request.image === 2 && st.headersTotal === 1 && st.headers.mainFrame === 1, 'hooks: calls are counted per type', st);
    check(/5 requests checked .*the response hook ran 1 time \(pages and frames only, about 4 calls saved\)/.test(hooks.summaryWords()), 'hooks: the summary line', hooks.summaryWords());

    hooks.disable();
    check(reg.headers[1] === null && reg.request[1] === null, 'hooks: disable clears exactly the two events');
    check(reg.sendHeaders === 0, 'hooks: onBeforeSendHeaders (the client-hints fix) is never touched');
    check(reg.unpreload[0] === 'pre-1' && !handlers.has(H.INJECT_CHANNEL) && !handlers.has(H.MUTATION_CHANNEL), 'hooks: disable removes the preload and both channels');
    hooks.enable(session);
    check(reg.headers.length === 3 && reg.preload.length === 2, 'hooks: enable after disable registers again');
  }

  /* ---- 8. the shield's status line ------------------------------------------------------------ */
  {
    const src = fs.readFileSync(path.join(__dirname, 'shield.js'), 'utf8');
    const ctx = { window: {}, document: { readyState: 'loading', addEventListener() {} }, URL, Date, Math, Number, String, Map };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    const S = ctx.window.Shield._helpers;
    const T = now;
    const st = (lists, extra) => S.stateFrom(Object.assign({ enabled: true, ready: true, allow: [], lists }, extra || {}));
    check(S.statusText(st({ updatedAt: T - 3 * DAY }), T) === 'Filter lists updated 3 days ago', 'shield: fresh lists say when', S.statusText(st({ updatedAt: T - 3 * DAY }), T));
    check(S.statusText(st({ updatedAt: T - 60000 }), T) === 'Filter lists updated just now', 'shield: just updated');
    check(S.statusText(st({ updatedAt: T - 3 * DAY, refreshing: true }), T) === 'Updating filter lists…', 'shield: an update in flight says so');
    check(S.statusText(st({ updatedAt: T - 3 * DAY, error: 'offline' }), T) === 'Couldn\u2019t update filter lists: offline. Using lists from 3 days ago.', 'shield: a failure gives the reason and the age', S.statusText(st({ updatedAt: T - 3 * DAY, error: 'offline' }), T));
    check(S.statusText(st({ updatedAt: T - 2 * HOUR, error: 'offline' }), T) === 'Couldn\u2019t update filter lists: offline. Using lists from today.', 'shield: same-day lists say today');
    check(S.statusText(st({ loadError: 'offline' }, { ready: false }), T) === 'Blocking unavailable: offline. Will try again soon', 'shield: a failed load is not "loading" forever', S.statusText(st({ loadError: 'offline' }, { ready: false }), T));
    check(S.statusText(st({}, { ready: false }), T) === 'Filter lists loading…', 'shield: still loading');
    check(S.statusText(st({ updatedAt: T }, { enabled: false }), T) === 'Blocking is off', 'shield: off is off');
    check(S.statusText(S.stateFrom({ enabled: true, ready: true }), T) === 'Filter lists ready', 'shield: an old backend without lists still reads');
  }
} catch (err) {
  check(false, 'harness crashed', (err && err.stack) || err);
} finally {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) { /* temp */ }
  console.log(`adblock-refresh-test: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
})();
