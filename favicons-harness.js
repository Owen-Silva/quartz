// favicons-harness.js — unit tests for the tab-logo cache (faviconstore.js, main) and the
// fallback chain (tabicons.js, renderer core). Pure node: a fake fetch, a temp dir, no Electron.
//
//   node favicons-harness.js
//
// Prints PASS/FAIL lines and one summary line: "favicons-test: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./faviconstore');
const TI = require('./tabicons');

let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || detail === undefined ? '' : '  ' + detail));
}
function eq(name, got, want) { check(JSON.stringify(got) === JSON.stringify(want), name, 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000010000000100806000000', 'hex');
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>');
const HTML = Buffer.from('<!doctype html><html><body>Not found</body></html>');
const dataPng = (n) => 'data:image/png;base64,' + Buffer.alloc(n, 7).toString('base64');

function fakeResponse(status, body, type, delayMs) {
  return new Promise((resolve) => setTimeout(() => resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : k.toLowerCase() === 'content-length' ? String(body.length) : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length)
  }), delayMs || 0));
}

async function testStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favstore-'));

  // --- sniffing --------------------------------------------------------------
  eq('sniff png', store.sniffMime(PNG, 'text/plain'), 'image/png');
  eq('sniff ico served as octet-stream', store.sniffMime(ICO, 'application/octet-stream'), 'image/x-icon');
  eq('sniff svg with xml prolog', store.sniffMime(SVG, 'image/svg+xml'), 'image/svg+xml');
  eq('sniff html soft-404 is not an image', store.sniffMime(HTML, 'image/x-icon'), null);
  eq('originOf drops path and lowercases', store.originOf('HTTPS://Discord.com/channels/1?x'), 'https://discord.com');
  eq('originOf refuses file:', store.originOf('file:///C:/x.html'), null);

  // --- put / get / persist ---------------------------------------------------
  let s = store.create({ dir, saveDelayMs: 10 });
  check(s.put('https://a.com', { src: 'https://a.com/i.png', data: dataPng(10) }).ok, 'put accepts a png data URL');
  check(!s.put('https://a.com', { src: 'x', data: 'javascript:alert(1)' }).ok, 'put refuses a non-image');
  check(!s.put('file:///x', { src: 'x', data: dataPng(4) }).ok, 'put refuses a non-http origin');
  check(!s.put('https://big.com', { src: 'x', data: dataPng(60000) }).ok, 'put refuses an oversized entry');
  const g = s.get(['https://a.com/some/page', 'https://none.com']);
  check(g['https://a.com'] && g['https://a.com'].src === 'https://a.com/i.png', 'get by page url finds the origin');
  check(g['https://none.com'] === null, 'get answers null for an unknown origin');
  check(s.put('https://a.com', { src: 'https://a.com/i.png', data: dataPng(10) }).unchanged, 'the same icon again is only a touch');
  await sleep(40);
  check(fs.existsSync(path.join(dir, store.FILE_NAME)), 'debounced save wrote the file');
  check(!fs.existsSync(path.join(dir, store.FILE_NAME + '.tmp')), 'no temp file left behind');
  s = store.create({ dir });
  check(s.get(['https://a.com'])['https://a.com'] !== null, 'a new instance (a restart) reads it back');

  // corrupt file -> empty store with a reason, not a throw
  fs.writeFileSync(path.join(dir, store.FILE_NAME), '{not json');
  const bad = store.create({ dir });
  check(bad.describe().entries === 0 && /not valid JSON/.test(bad.describe().loadError), 'a corrupt cache starts empty and says why');

  // --- LRU and caps ----------------------------------------------------------
  const lru = store.create({ dir: null, maxEntries: 3, maxBytes: 1e9 });
  for (const o of ['https://1.com', 'https://2.com', 'https://3.com']) lru.put(o, { src: o + '/f', data: dataPng(8) });
  lru.get(['https://1.com']);                       // 1 is now the youngest
  lru.put('https://4.com', { src: 'x', data: dataPng(8) });
  const after = lru.get(['https://1.com', 'https://2.com', 'https://3.com', 'https://4.com']);
  check(after['https://1.com'] && after['https://2.com'] === null && after['https://3.com'] && after['https://4.com'],
    'LRU evicts the least recently USED origin', JSON.stringify(Object.keys(after).filter((k) => after[k])));
  const capped = store.create({ dir: null, maxEntries: 1000, maxBytes: 4000 });
  for (let i = 0; i < 50; i++) capped.put('https://s' + i + '.com', { src: 'x', data: dataPng(600) });
  check(capped.describe().bytes <= 4000 && capped.describe().entries > 0, 'byte cap holds', JSON.stringify(capped.describe()));

  // --- fetchIcon -------------------------------------------------------------
  let calls = 0;
  let maxActive = 0, active = 0;
  const routes = {
    'https://ok.com/f.ico': () => fakeResponse(200, ICO, 'application/octet-stream'),
    'https://html.com/favicon.ico': () => fakeResponse(200, HTML, 'text/html'),
    'https://gone.com/favicon.ico': () => fakeResponse(404, HTML, 'text/html'),
    'https://slow.com/f.png': () => fakeResponse(200, PNG, 'image/png', 400)
  };
  const fetcher = store.create({
    dir: null, fetchTimeoutMs: 150, maxConcurrent: 2,
    fetch: async (url, init) => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      try {
        const route = routes[url] || (() => fakeResponse(200, PNG, 'image/png', 30));
        const p = route();
        return await new Promise((resolve, reject) => {
          if (init && init.signal) init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
          p.then(resolve, reject);
        });
      } finally { active--; }
    }
  });
  const okr = await fetcher.fetchIcon('https://ok.com/f.ico');
  check(okr.ok && okr.mime === 'image/x-icon' && /^data:image\/x-icon;base64,/.test(okr.dataUrl), 'fetchIcon returns sniffed bytes');
  const html = await fetcher.fetchIcon('https://html.com/favicon.ico');
  check(!html.ok && /not an image/.test(html.reason), 'fetchIcon: HTML soft 404 fails with a reason', html.reason);
  const gone = await fetcher.fetchIcon('https://gone.com/favicon.ico');
  check(!gone.ok && /404/.test(gone.reason), 'fetchIcon: 404 fails with the status', gone.reason);
  const slow = await fetcher.fetchIcon('https://slow.com/f.png');
  check(!slow.ok && /timed out/.test(slow.reason), 'fetchIcon: a slow icon times out with a reason', slow.reason);
  const fileUrl = await fetcher.fetchIcon('file:///C:/Windows/win.ini');
  check(!fileUrl.ok && calls === 4, 'fetchIcon never fetches a non-http(s) URL');
  await Promise.all([1, 2, 3, 4, 5, 6].map((i) => fetcher.fetchIcon('https://many' + i + '.com/f.png')));
  check(maxActive <= 2, 'fetches are capped at maxConcurrent', 'max active ' + maxActive);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testChain() {
  eq('monogram x.com', TI.monogramFor('https://x.com/home'), 'X');
  eq('monogram drops www.', TI.monogramFor('https://www.discord.com/channels'), 'D');
  eq('monogram for an app name', TI.monogramFor('paint'), 'P');
  eq('originOf drops the default port', TI.originOf('https://a.com:443/x'), 'https://a.com');
  eq('default /favicon.ico candidate goes last',
    TI.orderCandidates('https://a.com', ['https://a.com/favicon.ico', 'https://a.com/i.svg', 'javascript:x', 'https://a.com/i.svg']),
    ['https://a.com/i.svg', 'https://a.com/favicon.ico']);

  function rig(opts) {
    const disk = Object.assign({}, opts.disk || {});
    const log = { gets: 0, fetched: [], puts: [] };
    const r = TI.createResolver({
      get: async (origins) => { log.gets++; const out = {}; origins.forEach((o) => { out[o] = disk[o] || null; }); return out; },
      put: (origin, e) => { log.puts.push(origin); disk[origin] = Object.assign({ at: Date.now() }, e); },
      fetch: async (url) => {
        log.fetched.push(url);
        await sleep(opts.delay || 1);
        const ok = (opts.ok || []).indexOf(url) !== -1;
        return ok ? { ok: true, mime: 'image/png', dataUrl: 'data:image/png;base64,' + Buffer.from(url).toString('base64') } : { ok: false, reason: 'HTTP 404' };
      },
      normalise: async (d) => (d.indexOf('bad') !== -1 ? null : d.replace('base64,', 'base64,N'))
    });
    return { r, log, disk };
  }

  // 1. declared icon wins and is cached
  let t = rig({ ok: ['https://a.com/i.png'] });
  let res = await t.r.declared('https://a.com/page', ['https://a.com/i.png']);
  check(res.from === 'declared' && res.entry && t.log.puts[0] === 'https://a.com', 'declared icon is used and cached');
  res = await t.r.declared('https://a.com/other', ['https://a.com/i.png']);
  check(res.from === 'cache' && t.log.fetched.length === 1, 'the same declared icon again costs no fetch');

  // 2. declared fails -> cached icon for the origin
  t = rig({ disk: { 'https://b.com': { src: 'https://b.com/old.png', data: 'data:image/png;base64,OLD', at: Date.now() } } });
  res = await t.r.declared('https://b.com/', ['https://b.com/new.png']);
  check(res.from === 'cache' && res.entry.data.indexOf('OLD') !== -1 && /declared icon failed/.test(res.reason), 'declared fails -> cached origin icon', JSON.stringify(res));

  // 3. declared fails, nothing cached -> the site's own well-known icons
  t = rig({ ok: ['https://c.com/apple-touch-icon.png'] });
  res = await t.r.declared('https://c.com/x', ['https://c.com/broken.png']);
  check(res.from === 'site' && t.log.fetched.indexOf('https://c.com/favicon.ico') !== -1, 'declared fails, no cache -> /favicon.ico then apple-touch-icon', JSON.stringify(t.log.fetched));
  check(t.log.fetched.every((u) => /^https:\/\/c\.com\//.test(u)), 'no third-party favicon service is ever asked');

  // 4. nothing anywhere -> none, with a reason; probing happens once per origin
  t = rig({});
  res = await t.r.declared('https://d.com/', []);
  check(res.from === 'none' && !res.entry && /no icon/.test(res.reason), 'no icon anywhere -> monogram, with the reason', res.reason);
  const before = t.log.fetched.length;
  await t.r.fallback('https://d.com/again');
  await t.r.declared('https://d.com/again', ['https://d.com/favicon.ico']);
  check(t.log.fetched.length === before, 'failures are remembered: no repeated fetches', before + ' -> ' + t.log.fetched.length);

  // 5. concurrent asks share one fetch and one IPC get
  t = rig({ ok: ['https://e.com/i.png'], delay: 30 });
  const many = await Promise.all([1, 2, 3, 4, 5].map(() => t.r.declared('https://e.com/', ['https://e.com/i.png'])));
  check(many.every((x) => x.entry) && t.log.fetched.length === 1, 'concurrent tabs on one site: one fetch', String(t.log.fetched.length));
  check(t.log.gets === 1, 'cache lookups in one tick are batched into one IPC', String(t.log.gets));

  // 6. cache link for a restored / sleeping tab: peek after cached()
  t = rig({ disk: { 'https://f.com': { src: 's', data: 'data:image/png;base64,F', at: 1 } } });
  check(t.r.peek('https://f.com') === undefined, 'peek before asking = undefined (chip holds the box)');
  const c = await t.r.cached('https://f.com');
  check(c && c.data === 'data:image/png;base64,F' && t.r.peek('https://f.com').data === c.data, 'cached() then peek is synchronous');
  res = await t.r.fallback('https://f.com/x');
  check(res.from === 'cache' && t.log.fetched.length === 0, 'fallback for a page that reported nothing uses the cache first');

  // 7. data: icons (Gmail-style) need no fetch; an undecodable one falls through
  t = rig({});
  res = await t.r.declared('https://g.com/', ['data:image/png;base64,AAAA']);
  check(res.from === 'declared' && t.log.fetched.length === 0, 'data: icon is used without any fetch');
  t = rig({ ok: ['https://h.com/favicon.ico'] });
  res = await t.r.declared('https://h.com/', ['data:image/png;base64,bad']);
  check(res.from === 'site', 'an undecodable icon falls through the chain', JSON.stringify(res));

  // 8. a bundled page with no origin: none, no probe
  t = rig({});
  res = await t.r.declared('file:///C:/browser/newtab.html', []);
  check(res.from === 'none' && t.log.fetched.length === 0, 'a bundled page never probes the network');

  // 9. memo stays bounded
  t = rig({});
  for (let i = 0; i < 400; i++) await t.r.cached('https://m' + i + '.com');
  check(t.r.describe().memo <= 300, 'renderer memo is bounded', String(t.r.describe().memo));
}

(async () => {
  await testStore();
  await testChain();
  console.log('favicons-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.log('FAIL harness crashed: ' + (err && err.stack)); console.log('favicons-test: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
