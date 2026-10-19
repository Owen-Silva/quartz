// bravesearch-harness.js — pure-node test for bravesearch.js and the keyword routing in
// keywords.js (run: node bravesearch-harness.js). No Electron, no network: a fake fetch answers
// with the recorded shapes in tests/brave-fixtures.js, a fake clock drives the rate gate, and the
// key file goes to a temp folder that is deleted at the end.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const B = require('./bravesearch');
const F = require('./tests/brave-fixtures');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function ok(name, cond, detail) {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (detail ? '  ' + detail : '')); }
}

/* ---- pure helpers ------------------------------------------------------------------------ */
eq('mask long', B.maskKey('BSAabcdefghijklmnop1234'), '••••1234');
eq('mask short', B.maskKey('abc'), '•••');
eq('mask empty', B.maskKey(''), '');
eq('cleanKey trims', B.cleanKey('  BSAkey123  '), 'BSAkey123');
eq('cleanKey refuses inner space', B.cleanKey('BSA key'), '');
eq('cleanKey refuses control', B.cleanKey('BSA\u0007key'), '');

eq('line ok', B.parseGuestLine('quartz-search:query {"q":" lunar  eclipse ","kind":"news","offset":2,"seq":4}'), { q: 'lunar eclipse', kind: 'news', offset: 2, seq: 4 });
eq('line default kind', B.parseGuestLine('quartz-search:query {"q":"x"}'), { q: 'x', kind: 'web', offset: 0, seq: 0 });
eq('line offset capped at 9', B.parseGuestLine('quartz-search:query {"q":"x","offset":40}').offset, 9);
eq('line bad kind', B.parseGuestLine('quartz-search:query {"q":"x","kind":"images"}'), null);
eq('line empty q', B.parseGuestLine('quartz-search:query {"q":"   "}'), null);
eq('line long q', B.parseGuestLine('quartz-search:query ' + JSON.stringify({ q: 'a'.repeat(401) })), null);
eq('line negative offset', B.parseGuestLine('quartz-search:query {"q":"x","offset":-1}'), null);
eq('line junk', B.parseGuestLine('quartz-search:query {nope'), null);
eq('line other prefix', B.parseGuestLine('newtab:stocks {"q":"x"}'), null);

const webShape = B.shapeAnswer('web', F.web('quartz', 3));
eq('web: javascript: row dropped, hostile row kept', webShape.results.length, 4);
eq('web: more flag', webShape.more, true);
eq('web: strong kept as text for the page', webShape.results[0].title, 'Quartz crystal <strong>result</strong> number 0');
eq('web: host', webShape.results[0].host, 'example0.com');
eq('web: path', webShape.results[0].path, '› articles › quartz-0');
eq('web: age', webShape.results[0].age, '1 days ago');
eq('web: https favicon kept', webShape.results[0].favicon, 'https://imgs.search.brave.com/fav/example0.png');
eq('web: http favicon dropped', webShape.results[3].favicon, '');
ok('web: no javascript: url anywhere', !JSON.stringify(webShape).includes('javascript:'));
eq('web: zero results is not broken', B.shapeAnswer('web', { type: 'search', query: { original: 'x' } }), { results: [], more: false, altered: '' });
eq('web: not Brave shape', B.shapeAnswer('web', { hello: 1 }), null);
eq('web: altered', B.shapeAnswer('web', { query: { original: 'qartz', altered: 'quartz' }, web: { results: [] } }).altered, 'quartz');
const newsShape = B.shapeAnswer('news', F.news('quartz'));
eq('news: count', newsShape.results.length, 6);
eq('news: thumb', newsShape.results[0].thumb, 'https://imgs.search.brave.com/thumb/news0.jpg');
eq('news: source + breaking', [newsShape.results[0].source, newsShape.results[0].breaking], ['News Desk 0', true]);
const vidShape = B.shapeAnswer('videos', F.videos('quartz'));
eq('videos: count', vidShape.results.length, 5);
eq('videos: fields', [vidShape.results[1].duration, vidShape.results[1].creator, vidShape.results[1].views], ['4:01', 'Watch Channel 1', 2469134]);
eq('news: not Brave shape', B.shapeAnswer('news', { type: 'news' }), null);

/* ---- the rich web answer (same single request: infobox, faq, discussions, videos, news) ---- */
ok('plain web answer carries no rich block', !('rich' in webShape));
const rich = B.shapeAnswer('web', F.richWeb('claude ai'));
eq('rich: results', rich.results.length, 10);
eq('rich: modules present', Object.keys(rich.rich).sort(), ['discussions', 'faq', 'infobox', 'layout', 'news', 'videos']);
eq('rich: layout follows Brave\'s mixed.main', rich.rich.layout.main.map((x) => x.t === 'web' ? x.i : x.t),
  [0, 1, 'news', 2, 3, 'faq', 4, 'videos', 5, 6, 'discussions', 7, 8, 9]);
eq('rich: infobox in the side, as mixed.side says', rich.rich.layout.side, [{ t: 'infobox' }]);
eq('rich: sitelinks, javascript: button dropped', rich.results[0].sitelinks.map((s) => s.title), ['Log in', 'Pricing', 'Download apps', 'Claude Code', 'Help center']);
eq('rich: cluster, javascript: row dropped', rich.results[1].cluster.length, 2);
eq('rich: result thumbnail (https)', rich.results[1].thumb, 'https://imgs.search.brave.com/thumb/anthropic.jpg');
eq('rich: site name from profile', [rich.results[0].site, rich.results[2].site], ['Claude', 'Wikipedia']);
eq('rich: infobox fields', [rich.rich.infobox.title, rich.rich.infobox.category, rich.rich.infobox.website, rich.rich.infobox.provider.name],
  ['Claude', 'Large language model', 'https://claude.ai/', 'Wikipedia']);
eq('rich: infobox attributes (null value dropped, markup kept as TEXT)', rich.rich.infobox.attributes.map((a) => a[0]), ['Developer', 'Initial release', 'Type', 'License', 'Markup']);
eq('rich: infobox profiles, javascript: dropped', rich.rich.infobox.profiles.map((p) => p.host), ['x.com', 'youtube.com']);
eq('rich: faq', [rich.rich.faq.length, rich.rich.faq[0].host], [4, 'zdnet.com']);
eq('rich: discussions keep forum data', [rich.rich.discussions[0].forum, rich.rich.discussions[0].answers, rich.rich.discussions[0].score], ['r/ClaudeAI', 214, '1.2k']);
eq('rich: videos + news', [rich.rich.videos.length, rich.rich.news.length, rich.rich.videos[0].duration], [5, 4, '3:00']);
ok('rich: no javascript: url anywhere', !JSON.stringify(rich).includes('javascript:'));
const insecure = F.richWeb('x');
insecure.infobox.results[0].thumbnail = { src: 'http://insecure.example/i.png' };
eq('rich: http infobox image dropped', B.shapeAnswer('web', insecure).rich.infobox.thumb, '');
const noTitle = F.richWeb('x');
noTitle.infobox.results[0].title = '';
ok('rich: an infobox with no title is not drawn', !('infobox' in B.shapeAnswer('web', noTitle).rich));
// Indices: Brave's index counts the raw list; a dropped row must not shift the others.
const raw = new Map([[0, 0], [2, 1], [3, 2]]);   // raw row 1 was dropped
eq('layout: raw -> shaped index, dropped row skipped', B.shapeLayout({ main: [{ type: 'web', index: 0 }, { type: 'web', index: 1 }, { type: 'videos', all: true }, { type: 'web', index: 3 }, { type: 'web', index: 2 }, { type: 'weather' }] }, raw, 3, { videos: true }).main,
  [{ t: 'web', i: 0 }, { t: 'videos' }, { t: 'web', i: 2 }, { t: 'web', i: 1 }]);
eq('layout: no mixed -> results in order, modules after the third, infobox to the side', B.shapeLayout(null, new Map([[0, 0], [1, 1], [2, 2], [3, 3]]), 4, { news: true, faq: true, infobox: true }),
  { top: [], main: [{ t: 'web', i: 0 }, { t: 'web', i: 1 }, { t: 'web', i: 2 }, { t: 'faq' }, { t: 'news' }, { t: 'web', i: 3 }], side: [{ t: 'infobox' }] });
eq('layout: a module is placed once', B.shapeLayout({ main: [{ type: 'news', all: true }, { type: 'news', index: 1 }] }, new Map(), 0, { news: true }).main, [{ t: 'news' }]);

eq('usage from headers', B.monthUsage(F.rateHeaders(1987)), { limit: 2000, remaining: 1987, resetSec: 1419704 });
eq('usage absent', B.monthUsage({}), null);

let v = B.classifyStatus(422, F.ERRORS.badKey(), {}, '••••abcd');
eq('422 token -> bad-key', [v.state, v.settings, v.retry], ['bad-key', true, true]);
ok('bad-key quotes Brave, one full stop', /422 SUBSCRIPTION_TOKEN_INVALID: The provided subscription token is invalid\. The key/.test(v.detail) && v.detail.includes('••••abcd'), v.detail);
eq('401 -> bad-key', B.classifyStatus(401, null, {}).state, 'bad-key');
eq('403 -> bad-key', B.classifyStatus(403, null, {}).state, 'bad-key');
v = B.classifyStatus(429, F.ERRORS.rate(), F.rateHeaders(1985));
eq('429 rate -> rate-limited, retry', [v.state, v.retry], ['rate-limited', true]);
ok('rate says the plan limit', /1 search per second/.test(v.detail) && /429 RATE_LIMITED/.test(v.detail), v.detail);
v = B.classifyStatus(429, F.ERRORS.quota(), F.rateHeaders(0));
eq('429 quota -> quota', [v.state, v.retry, v.settings], ['quota', false, true]);
ok('quota says used and reset', /plan\. 2,000 of 2,000 searches used this month\. The allowance resets in 16 days\./.test(v.detail) && !/\.\./.test(v.detail), v.detail);
eq('429 with QUOTA code -> quota', B.classifyStatus(429, F.error(429, 'QUOTA_LIMITED', 'Quota exceeded'), {}).state, 'quota');
eq('402 -> plan', B.classifyStatus(402, null, {}).state, 'plan');
eq('503 -> server, retry', [B.classifyStatus(503, null, {}).state, B.classifyStatus(503, null, {}).retry], ['server', true]);
eq('422 other -> bad-request', B.classifyStatus(422, F.error(422, 'VALIDATION', 'offset too large'), {}).state, 'bad-request');

const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
v = B.classifyNetworkError(refused);
eq('refused -> offline', v.state, 'offline');
ok('refused says why', /connection was refused \(ECONNREFUSED\)/.test(v.detail), v.detail);
ok('dns says offline', /looks offline \(ENOTFOUND\)/.test(B.classifyNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })).detail));
ok('timeout says 10 s', /within 10 seconds/.test(B.classifyNetworkError(Object.assign(new Error('t'), { name: 'TimeoutError' })).detail));
ok('chromium disconnected', /no network connection/.test(B.classifyNetworkError(new Error('net::ERR_INTERNET_DISCONNECTED')).detail));

eq('web search url', B.webSearchUrl('a&b', 'web'), 'https://search.brave.com/search?q=a%26b');
eq('news search url', B.webSearchUrl('x', 'news'), 'https://search.brave.com/news?q=x');

/* ---- the module, with a fake fetch and a fake clock -------------------------------------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bravesearch-harness-'));
const keyFile = path.join(dir, 'brave-search.json');
let clock = 1000000;
const sleeps = [];
const calls = [];
const logs = [];
let mode = 'ok';
function fakeFetch(url, opts) {
  calls.push({ url, token: opts && opts.headers && opts.headers['X-Subscription-Token'], t: clock });
  const u = new URL(url);
  const respond = (status, body, headers) => Promise.resolve({
    status, headers: Object.assign({}, headers || {}), text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
  if (mode === 'offline') return Promise.reject(refused);
  if (mode === 'reset' || mode === 'reset-once') {
    if (mode === 'reset-once') mode = 'ok';
    return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'read ECONNRESET' } }));
  }
  if (mode === 'badkey') return respond(422, F.ERRORS.badKey());
  if (mode === 'rate') return respond(429, F.ERRORS.rate(), F.rateHeaders(1985));
  if (mode === 'notjson') return respond(200, '<html>');
  const q = u.searchParams.get('q');
  if (u.pathname.endsWith('/news/search')) return respond(200, F.news(q), F.rateHeaders(1990));
  if (u.pathname.endsWith('/videos/search')) return respond(200, F.videos(q), F.rateHeaders(1990));
  return respond(200, F.web(q, 3), F.rateHeaders(1987));
}
const mod = B.create({
  fetch: fakeFetch,
  apiBase: 'http://mock.local/res/v1/',
  now: () => clock,
  sleep: (ms) => { sleeps.push(ms); clock += ms; return Promise.resolve(); },
  storePath: () => keyFile,
  log: (...a) => logs.push(a.join(' ')),
  isBundledPage: (url) => String(url).startsWith('file:///C:/app/'),
});

(async () => {
  try {
    // no key
    let a = await mod.search({ q: 'quartz', kind: 'web', offset: 0, seq: 1 });
    eq('no key: state, no request', [a.ok, a.state, calls.length], [false, 'no-key', 0]);
    ok('no key: offers plain web search + settings', a.webUrl === 'https://search.brave.com/search?q=quartz' && a.settings === true);
    eq('describe without key', [mod.describe().hasKey, mod.describe().keyMask], [false, '']);

    // key stored, masked, never returned
    let d = mod.setKey('  BSAsecretKey9876  ');
    eq('setKey: describe has mask, not key', [d.hasKey, d.keyMask, JSON.stringify(d).includes('BSAsecretKey9876')], [true, '••••9876', false]);
    eq('key file content', JSON.parse(fs.readFileSync(keyFile, 'utf8')), { key: 'BSAsecretKey9876' });
    eq('bad paste refused with reason', typeof mod.setKey('two words').error, 'string');
    eq('bad paste kept the old key', mod.describe().keyMask, '••••9876');

    // ok search: endpoint, params, header
    a = await mod.search({ q: 'quartz', kind: 'web', offset: 0, seq: 2 });
    eq('ok: answer', [a.ok, a.seq, a.results.length, a.cached, a.more], [true, 2, 4, false, true]);
    const u = new URL(calls[0].url);
    eq('request: endpoint + params', [u.origin + u.pathname, u.searchParams.get('q'), u.searchParams.get('count'), u.searchParams.get('offset')], ['http://mock.local/res/v1/web/search', 'quartz', '20', '0']);
    eq('request: key only in the header', [calls[0].token, calls[0].url.includes('BSAsecretKey9876')], ['BSAsecretKey9876', false]);
    eq('usage remembered', [mod.describe().usage.remaining, mod.describe().last.state], [1987, 'ok']);

    // cache: the same search is free; a new page is not
    a = await mod.search({ q: 'quartz', kind: 'web', offset: 0, seq: 3 });
    eq('cache hit: no request, seq is the new one', [calls.length, a.cached, a.seq], [1, true, 3]);
    a = await mod.search({ q: 'quartz', kind: 'web', offset: 1, seq: 4 });
    eq('new page: a request', calls.length, 2);
    ok('rate gate: second request waited ~1.1 s', sleeps.length === 1 && sleeps[0] === B.MIN_GAP_MS, JSON.stringify(sleeps));
    clock += 5000;
    a = await mod.search({ q: 'quartz', kind: 'news', offset: 0, seq: 5 });
    eq('news after a pause: no wait', [a.ok, a.results.length, sleeps.length], [true, 6, 1]);
    clock += B.CACHE_TTL_MS + 1;
    a = await mod.search({ q: 'quartz', kind: 'web', offset: 0, seq: 6 });
    eq('cache expires after the TTL', [a.cached, calls.length], [false, 4]);
    eq('cache never on disk', fs.readdirSync(dir), ['brave-search.json']);

    // failures
    const cachedBefore = mod.state().cacheEntries;
    clock += 5000; mode = 'badkey';
    a = await mod.search({ q: 'other', kind: 'web', offset: 0, seq: 7 });
    eq('bad key answer', [a.ok, a.state], [false, 'bad-key']);
    eq('describe.last says so', mod.describe().last.state, 'bad-key');
    clock += 5000; mode = 'rate';
    a = await mod.search({ q: 'other2', kind: 'web', offset: 0, seq: 8 });
    eq('rate answer', a.state, 'rate-limited');
    clock += 5000; mode = 'offline';
    a = await mod.search({ q: 'other3', kind: 'web', offset: 0, seq: 9 });
    eq('offline answer', a.state, 'offline');
    let n0 = calls.length;
    clock += 5000; mode = 'offline';
    a = await mod.search({ q: 'other3b', kind: 'web', offset: 0, seq: 9 });
    eq('refused: no second try', calls.length - n0, 1);
    // a kept-alive connection that dropped under the request: one more try on a fresh one
    n0 = calls.length; clock += 5000; mode = 'reset-once';
    a = await mod.search({ q: 'reset1', kind: 'web', offset: 0, seq: 9 });
    eq('reset once: second try answers', [a.ok, calls.length - n0], [true, 2]);
    n0 = calls.length; clock += 5000; mode = 'reset';
    a = await mod.search({ q: 'reset2', kind: 'web', offset: 0, seq: 9 });
    eq('reset twice: offline, says dropped, two tries only', [a.state, /connection dropped \(ECONNRESET\)/.test(a.detail), calls.length - n0], ['offline', true, 2]);
    ok('dropped-connection test', B.isDroppedConnection(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } })) && !B.isDroppedConnection(refused) && !B.isDroppedConnection(Object.assign(new Error('t'), { name: 'TimeoutError' })));
    clock += 5000; mode = 'notjson';
    a = await mod.search({ q: 'other4', kind: 'web', offset: 0, seq: 10 });
    eq('not JSON -> bad-answer', a.state, 'bad-answer');
    mode = 'ok';
    eq('failures are not cached (the one answer is reset1, which answered on its second try)', mod.state().cacheEntries, cachedBefore + 1);

    // check key
    clock += 5000;
    d = await mod.test();
    eq('test: ok check, count=1', [d.check.ok, new URL(calls[calls.length - 1].url).searchParams.get('count')], [true, '1']);

    // key change clears the cache; removal deletes the file
    mod.setKey('BSAanotherKey1111');
    eq('new key clears cache', mod.state().cacheEntries, 0);
    mod.setKey('');
    eq('remove deletes the file', fs.existsSync(keyFile), false);
    a = await mod.search({ q: 'quartz', kind: 'web', offset: 0, seq: 11 });
    eq('after removal: no-key', a.state, 'no-key');

    // the key never reached a log line
    ok('no log line carries a key', !logs.some((l) => /BSA/.test(l)), JSON.stringify(logs));

    // guest gate: only OUR search.html is heard; the answer goes back on __applySearch
    mod.setKey('BSAsecretKey9876');
    const pushed = [];
    const guest = (url) => ({ getURL: () => url, isDestroyed: () => false, executeJavaScript: (js) => { pushed.push(js); return Promise.resolve(); } });
    eq('web page ignored', mod.handleGuestLine(guest('https://evil.example/'), 'quartz-search:query {"q":"x"}'), false);
    eq('other bundled page ignored', mod.handleGuestLine(guest('file:///C:/app/newtab.html'), 'quartz-search:query {"q":"x"}'), false);
    clock += 5000;
    eq('search page heard', mod.handleGuestLine(guest('file:///C:/app/search.html?q=x'), 'quartz-search:query {"q":"x","seq":3}'), true);
    await new Promise((r) => setTimeout(r, 20));
    ok('answer pushed on __applySearch', pushed.length === 1 && /^window\.__applySearch && window\.__applySearch\(\{"seq":3/.test(pushed[0]) && !pushed[0].includes('BSAsecretKey9876'), pushed[0] && pushed[0].slice(0, 80));
  } catch (e) {
    fail++; console.log('FAIL harness error ' + (e && e.stack || e));
  }

  /* ---- keyword routing (keywords.js in a vm, with a fake Settings) ----------------------- */
  const src = fs.readFileSync(path.join(__dirname, 'keywords.js'), 'utf8');
  function loadKw(settings) {
    const win = settings ? { Settings: settings } : {};
    vm.runInContext(src, vm.createContext({ window: win, URL, encodeURIComponent }));
    return win.Keywords;
  }
  const OWN = 'file:///C:/Users/you/quartz/search.html?q=';
  let K = loadKw({ get: () => undefined, ownResultsUrl: (q) => OWN + encodeURIComponent(q) });
  eq('b -> own page when Brave is the engine', K.match('b lunar eclipse').url, OWN + 'lunar%20eclipse');
  eq('g unaffected', K.match('g lunar').url, 'https://www.google.com/search?q=lunar');
  K = loadKw({ get: (k) => (k === 'keywords' ? [{ key: 'br', name: 'Brave', url: 'https://search.brave.com/search?q=%s' }] : undefined), ownResultsUrl: (q) => OWN + q });
  eq('a user row on search.brave.com routes too', K.match('br x').url, OWN + 'x');
  K = loadKw({ get: () => undefined, ownResultsUrl: () => null });
  eq('b -> Brave site for any other engine', K.match('b lunar').url, 'https://search.brave.com/search?q=lunar');
  K = loadKw(null);
  eq('b -> Brave site without settings.js', K.match('b lunar').url, 'https://search.brave.com/search?q=lunar');
  K = loadKw({ get: () => undefined, ownResultsUrl: () => { throw new Error('boom'); } });
  eq('a throwing ownResultsUrl leaves the site', K.match('b lunar').url, 'https://search.brave.com/search?q=lunar');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`bravesearch-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
