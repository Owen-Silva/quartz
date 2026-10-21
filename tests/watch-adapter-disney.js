'use strict';
/*
 * tests/watch-adapter-disney.js -- the Disney+ adapter against hand-written
 * fixtures (tests/watch-fixtures/disney-*.json). Pure node: builds the read the
 * reader view would hand over and asserts the parse result AFTER
 * shape.cleanResult. module.exports = async function (check) { ... }.
 */
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var shape = require('../watch/shape');
var disney = require('../watch/adapters/disney');

var FIX = path.join(__dirname, 'watch-fixtures');
var API_HOST = 'https://disney.api.edge.bamgrid.com';
var SITE = 'https://www.disneyplus.com';
var NOW = Date.parse('2026-10-16T20:00:00Z');
var CTX = { now: NOW, tz: 'America/New_York' };
var RIPCUT = 'https://disney.images.edge.bamgrid.com/ripcut-delivery/v2/variant/disney/';

function fixture(name) { return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8')); }

/* The read the reader view would produce for one fixture. */
function readFrom(fx, over) {
  var finalUrl = SITE + fx.finalPath;
  var step = {
    ok: true, url: SITE + '/home', finalUrl: finalUrl, title: fx.title, status: 200,
    extracted: { url: finalUrl, title: fx.title, login: false },
    captures: (fx.captures || []).map(function (c) { return { url: API_HOST + c.path, status: c.status || 200, json: c.json }; }),
    error: null
  };
  var k;
  for (k in (over || {})) step[k] = over[k];
  return { now: NOW, steps: { home: step } };
}

function run(read) { return shape.cleanResult(disney.parse(read, CTX)); }
function byTitle(res, title) { return res.items.filter(function (i) { return i.title === title; })[0] || null; }
function titles(res) { return res.items.map(function (i) { return i.title; }); }
function near(a, b) { return typeof a === 'number' && Math.abs(a - b) < 0.001; }
function js(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }

module.exports = async function (check) {
  var home = fixture('disney-home.json');
  var signedOut = fixture('disney-signedout.json');
  var changed = fixture('disney-changed.json');

  /* ---------- fixtures are labelled honestly ---------- */
  [['disney-home.json', home], ['disney-signedout.json', signedOut], ['disney-changed.json', changed]].forEach(function (p) {
    var f = p[1]._fixture || '';
    check(/^shape from /.test(f) && f.indexOf('unverified against a live account') !== -1, 'fixture ' + p[0] + ' has an honest _fixture label', f.slice(0, 80));
  });

  /* ---------- the signed-in home ---------- */
  var res = run(readFrom(home));
  check(res.state === 'ok' && res.reason === '', 'home: state ok, no reason', res.state + ' ' + res.reason);
  check(res.profile === 'Alex', 'home: active profile name from the graph capture (id -> profiles list)', res.profile);
  var expectTitles = ['Bluey', 'The Bear', 'Moana 2', 'Percy Jackson and the Olympians',
    'Inside Out 2', 'Only Murders in the Building', 'Mickey Mouse Clubhouse',
    'Bruins at Maple Leafs', 'SportsCenter', 'Shōgun', 'Andor', 'The Simpsons'];
  check(js(titles(res)) === js(expectTitles), 'home: rows and order (page order, lazy sets merged in place)', js(titles(res)));
  var expectKinds = ['resume', 'resume', 'resume', 'resume', 'rec', 'rec', 'rec', 'rec', 'rec', 'rec', 'watchlist', 'watchlist'];
  check(js(res.items.map(function (i) { return i.kind; })) === js(expectKinds), 'home: kinds per row', js(res.items.map(function (i) { return i.kind; })));

  var bluey = byTitle(res, 'Bluey') || {};
  check(bluey.id === 'disney:1d8f3a52-7c4e-4b8a-9f3e-0b5c6a7d8e01', 'Bluey: id is the series entity from the browse action', bluey.id);
  check(bluey.url === SITE + '/browse/entity-1d8f3a52-7c4e-4b8a-9f3e-0b5c6a7d8e01', 'Bluey: url is the verified /browse/entity- page (no /play/)', bluey.url);
  check(bluey.subtitle === 'S2 E26 · Sleepytime', 'Bluey: subtitle season/episode + episode title', bluey.subtitle);
  check(bluey.image === RIPCUT + 'BLUEYS2E26THUMB178/scale?width=640&aspectRatio=1.78', 'Bluey: episode still (thumbnail 1.78) preferred over tile, ripcut URL', bluey.image);
  check(near(bluey.progress, 0.42), 'Bluey: progress 0.42 from userState progressPercentage via personalization.pid', bluey.progress);
  check(bluey.durationSec === 420, 'Bluey: durationSec from durationMs', bluey.durationSec);
  check(bluey.group === 'Continue Watching' && bluey.badge === '', 'Bluey: group is the row name, no badge', bluey.group + '|' + bluey.badge);
  check(bluey.service === 'disney' && bluey.edge === true, 'Bluey: service disney, click opens Edge', bluey.service + ' ' + bluey.edge);

  var bear = byTitle(res, 'The Bear') || {};
  check(bear.badge === 'Hulu', 'The Bear: Hulu badge from networkAttribution', bear.badge);
  check(near(bear.progress, 1 - 600 / 1800), 'The Bear: progress from secondsRemaining / durationMs', bear.progress);
  check(bear.subtitle === 'S3 E1 · Tomorrow', 'The Bear: string season/episode numbers read', bear.subtitle);
  check(bear.image === RIPCUT + 'BEARS3E1THUMB178/scale?width=640&aspectRatio=1.78', 'The Bear: thumbnail art', bear.image);

  var moana = byTitle(res, 'Moana 2') || {};
  check(moana.id === 'disney:3b8f0d21-5c4e-4f70-9b2c-3d4e5f6a7b03' && moana.url === SITE + '/browse/entity-3b8f0d21-5c4e-4f70-9b2c-3d4e5f6a7b03',
    'Moana 2: no browse action -> the item id is the entity', moana.id + ' ' + moana.url);
  check(near(moana.progress, 0.8), 'Moana 2: progress from an item-level bookmark (playheadMs / runtimeMs)', moana.progress);
  check(moana.subtitle === 'Animation, Family · 2024', 'Moana 2: subtitle genres (two) + year', moana.subtitle);
  check(moana.image === RIPCUT + 'MOANA2TILE178/scale?width=640&aspectRatio=1.78' && moana.durationSec === 6000, 'Moana 2: 16:9 tile art, runtime', moana.image + ' ' + moana.durationSec);

  var percy = byTitle(res, 'Percy Jackson and the Olympians') || {};
  check(percy.progress === null, 'Percy Jackson: no progress anywhere -> null (unknown), not 0', percy.progress);
  check(percy.image === RIPCUT + 'PERCYPOSTER071/scale?width=640&aspectRatio=1.78', 'Percy Jackson: falls back to the only art there is (0.71 poster)', percy.image);

  var io = res.items.filter(function (i) { return i.title === 'Inside Out 2'; });
  check(io.length === 1 && io[0].group === 'For You', 'Inside Out 2: once, in its first row (For You); the Because You Watched copy de-duplicated', js(io.map(function (i) { return i.group; })));
  check(io[0] && io[0].progress === null && io[0].subtitle === 'Animation, Comedy · 2024', 'Inside Out 2: rec has no progress, subtitle genres + numeric year', io[0] && io[0].subtitle);
  var omitb = byTitle(res, 'Only Murders in the Building') || {};
  check(omitb.badge === 'Hulu' && omitb.group === 'For You', 'Only Murders: Hulu badge inside For You', omitb.badge + '|' + omitb.group);
  check(!byTitle(res, 'Tron: Ares'), 'For You: an upsell (not in his plan) title is skipped', '');
  check(!byTitle(res, 'Halloween Collection') && res.items.every(function (i) { return i.title; }), 'For You: a collection (page-) tile and a no-title tile are skipped', '');

  var mickey = byTitle(res, 'Mickey Mouse Clubhouse') || {};
  check(mickey.group === 'Because You Watched Bluey' && mickey.kind === 'rec', 'lazy set /set/<id> fills the Because You Watched row', mickey.group);
  var bruins = byTitle(res, 'Bruins at Maple Leafs') || {};
  check(bruins.badge === 'ESPN' && bruins.subtitle === 'NHL', 'ESPN row: ESPN badge, league as subtitle', bruins.badge + '|' + bruins.subtitle);
  check(bruins.startsAt === Date.parse('2026-10-17T23:00:00Z'), 'ESPN row: startsAt from airingEventState.timeline', bruins.startsAt);
  check(bruins.image === RIPCUT + 'BOSTORTHUMB178/scale?width=640&aspectRatio=1.78', 'ESPN row: thumbnail used when there is no tile', bruins.image);
  check((byTitle(res, 'SportsCenter') || {}).badge === 'ESPN', 'ESPN row: SportsCenter ESPN badge', '');
  var shogun = byTitle(res, 'Shōgun') || {};
  check(shogun.badge === 'Hulu' && shogun.group === 'Hulu Originals' && shogun.kind === 'rec', 'Hulu-branded row -> rec with Hulu badge', shogun.badge + '|' + shogun.group);

  var andor = byTitle(res, 'Andor') || {};
  check(andor.kind === 'watchlist' && andor.group === 'Watchlist', 'Watchlist: lazy set with no name of its own takes the page row name (id from the URL)', andor.kind + '|' + andor.group);
  var simpsons = byTitle(res, 'The Simpsons') || {};
  check(simpsons.image === '' && simpsons.subtitle === '' && simpsons.kind === 'watchlist', 'Watchlist: an item with no art or metadata still shows, empty image', js(simpsons));

  ['Daredevil: Born Again', 'Disney', 'Pixar', 'Marvel', 'Hulu', 'ESPN'].forEach(function (t) {
    check(!byTitle(res, t), 'decoy: hero/brand tile "' + t + '" is not an item', '');
  });
  var heroNamed = readFrom(home);
  heroNamed.steps.home.captures[0] = JSON.parse(JSON.stringify(heroNamed.steps.home.captures[0]));
  heroNamed.steps.home.captures[0].json.data.page.containers[0].visuals.name = 'Top Picks For You';
  check(!byTitle(run(heroNamed), 'Daredevil: Born Again'), 'decoy: a hero-style row stays out even when its name sounds personal', '');
  check(!byTitle(res, 'The Mandalorian'),'editorial row (Disney+ Originals) is not a personal row', '');
  check(res.items.every(function (i) { return /^https:\/\/www\.disneyplus\.com\/browse\/entity-[0-9a-f-]{36}$/.test(i.url); }), 'every url is a /browse/entity-<uuid> page', '');
  check(res.items.every(function (i) { return i.image === '' || i.image.indexOf(RIPCUT) === 0; }), 'every image is ripcut or empty', '');
  check(res.items.every(function (i) { return !/LOGO|HERO/.test(i.image); }), 'no logo or hero art used as a tile', '');
  check(res.items.every(function (i) { return js(shape.cleanItem(i)) === js(i); }), 'items are stable through cleanItem again', '');

  var raw = disney.parse(readFrom(home), CTX);
  check(raw.counts && raw.counts.responses === 6 && raw.counts.items === 13, 'raw counts: 6 responses read, 13 items before de-dup', js(raw.counts));

  /* ---------- variants of the good read ---------- */
  var shuffled = readFrom(home);
  shuffled.steps.home.captures = shuffled.steps.home.captures.slice().reverse();
  check(js(titles(run(shuffled))) === js(expectTitles), 'capture order does not matter (page order wins)', js(titles(run(shuffled))));

  var named = readFrom(home);
  named.steps.home.captures = named.steps.home.captures.map(function (c) {
    if (!/graphql/.test(c.url)) return c;
    return { url: API_HOST + '/v1/public/graphql', status: 200, json: { data: { me: { account: { activeProfile: { id: 'p9', name: 'Alex S' } } } } } };
  });
  check(run(named).profile === 'Alex S', 'profile: activeProfile.name read directly (/v1/public/graphql)', run(named).profile);
  var noGraph = readFrom(home);
  noGraph.steps.home.captures = noGraph.steps.home.captures.filter(function (c) { return !/graphql/.test(c.url); });
  check(run(noGraph).profile === '' && run(noGraph).state === 'ok', 'profile: no graph capture -> empty profile, still ok', run(noGraph).profile);

  var mock = readFrom(home, { finalUrl: 'http://127.0.0.1:1234/home' });
  mock.steps.home.captures = mock.steps.home.captures.map(function (c) { return { url: c.url.replace(API_HOST, 'http://127.0.0.1:1234'), status: 200, json: c.json }; });
  mock.steps.home.extracted = { url: 'http://127.0.0.1:1234/home', title: 'Home | Disney+', login: false };
  check(run(mock).state === 'ok' && run(mock).items.length === 12, 'a local mock host reads the same as bamgrid (path matching)', run(mock).items.length);

  var noStates = readFrom(home);
  noStates.steps.home.captures = noStates.steps.home.captures.filter(function (c) { return !/userState/.test(c.url); });
  check((byTitle(run(noStates), 'Bluey') || {}).progress === null, 'no userState capture -> Bluey progress unknown (null)', '');

  var partial = readFrom(home, { ok: false, error: { code: 'timeout', detail: 'budget' } });
  check(run(partial).state === 'ok' && run(partial).items.length === 12, 'timeout after the rows arrived -> rows still used', run(partial).state);

  /* ---------- step errors ---------- */
  function errRead(code, extra) {
    var o = { ok: false, captures: [], error: { code: code, detail: 'net::ERR_NAME_NOT_RESOLVED' }, extracted: null };
    for (var k in (extra || {})) o[k] = extra[k];
    return readFrom({ finalPath: '/home', title: '', captures: [] }, o);
  }
  var r1 = run(errRead('timeout'));
  check(r1.state === 'error' && r1.reason === 'timed out after 20 s', 'timeout -> "timed out after 20 s"', r1.reason);
  var r2 = run(errRead('offline'));
  check(r2.state === 'error' && /offline/.test(r2.reason), 'offline -> plain offline reason', r2.reason);
  var r3 = run(errRead('crashed'));
  check(r3.state === 'error' && r3.reason === 'the hidden reader page crashed', 'crashed -> reader crashed', r3.reason);
  var r4 = run(errRead('http', { status: 503 }));
  check(r4.state === 'error' && r4.reason === 'Disney+ answered HTTP 503', 'http -> HTTP status in the reason', r4.reason);
  var r5 = run(errRead('load-failed'));
  check(r5.state === 'error' && r5.reason.indexOf("the Disney+ page didn't load (net::ERR_NAME_NOT_RESOLVED)") === 0, 'load-failed -> did not load, with detail', r5.reason);
  var r6 = run(errRead('bad-json'));
  check(r6.state === 'error' && /valid JSON/.test(r6.reason), 'bad-json -> plain reason', r6.reason);
  var r7 = run(errRead('weird'));
  check(r7.state === 'error' && r7.reason === 'the reader failed (weird)', 'unknown error code -> named, still an error', r7.reason);
  var r8 = run(errRead('offline', { finalUrl: SITE + '/login' }));
  check(r8.state === 'signed-out', 'a login redirect beats a later error', r8.state);

  /* ---------- signed out ---------- */
  var so = run(readFrom(signedOut));
  check(so.state === 'signed-out' && so.reason === 'sign in to Disney+ in Quartz to see your rows' && so.items.length === 0, 'signed-out fixture (/login) -> signed-out with the sign-in reason', so.state + ' ' + so.reason);
  ['/', '/en-us', '/en-gb/', '/welcome', '/sign-up', '/identity/login', '/en-us/login'].forEach(function (p) {
    var s = run(readFrom({ finalPath: p, title: 'Disney+', captures: [] }));
    check(s.state === 'signed-out', 'finalUrl ' + p + ' -> signed-out', s.state);
  });
  var exOnly = readFrom(signedOut, { finalUrl: '' });
  check(run(exOnly).state === 'signed-out', 'no finalUrl but the page says /login -> signed-out', run(exOnly).state);
  var cta = readFrom({ finalPath: '/home', title: 'Disney+', captures: [] }, { extracted: { url: SITE + '/home', title: 'Disney+', login: true } });
  check(run(cta).state === 'signed-out', '/home with no explore data and a Log In link -> signed-out', run(cta).state);
  var slowCta = readFrom({ finalPath: '/home', title: 'Disney+', captures: [] }, { ok: false, error: { code: 'timeout' }, extracted: { url: SITE + '/home', title: 'Disney+', login: true } });
  check(run(slowCta).state === 'signed-out', 'timeout on a page with a Log In link and no rows -> signed-out, not "timed out"', run(slowCta).reason);
  var unauth = readFrom({ finalPath: '/home', title: 'Disney+', captures: [{ path: '/explore/v1.7/page/home', status: 401, json: { errors: [{ code: 'unauthorized' }] } }] });
  check(run(unauth).state === 'signed-out', 'explore answered 401 -> signed-out', run(unauth).state);
  var picker = run(readFrom({ finalPath: '/select-profile', title: "Who's Watching? | Disney+", captures: [] }));
  check(picker.state === 'error' && /who's watching/.test(picker.reason), 'profile picker -> error asking to pick a profile', picker.reason);
  check(disney._internal.signedOutByUrl(SITE + '/home') === false && disney._internal.signedOutByUrl(SITE + '/browse/entity-x') === false && disney._internal.signedOutByUrl('') === false,
    'signed-in paths and a missing URL are not signed-out', '');

  /* ---------- layout changed ---------- */
  var ch = run(readFrom(changed));
  check(ch.state === 'error', 'changed fixture -> error', ch.state);
  check(ch.reason === 'the page loaded but no Continue Watching data matched (Disney+ changed its layout?) (3 responses read)', 'changed: reason names the layout change and the response count', ch.reason);
  var one = readFrom(changed);
  one.steps.home.captures = one.steps.home.captures.slice(0, 1);
  check(/\(1 response read\)$/.test(run(one).reason), 'changed: singular count', run(one).reason);
  var none = run(readFrom({ finalPath: '/home', title: 'Home | Disney+', captures: [] }));
  check(none.state === 'error' && /\(0 responses read\)$/.test(none.reason), '/home, no data, no sign-in link -> layout error with 0 responses', none.reason);
  var onlyDecoys = run(readFrom({ finalPath: '/home', title: 'Home | Disney+', captures: [home.captures[0]].map(function (c) {
    var copy = JSON.parse(JSON.stringify(c));
    copy.json.data.page.containers = copy.json.data.page.containers.slice(0, 2);
    return copy;
  }) }));
  check(onlyDecoys.state === 'error' && /changed its layout/.test(onlyDecoys.reason), 'only hero/brand rows -> layout error, decoys never count', onlyDecoys.reason);
  var emptyCw = run(readFrom({ finalPath: '/home', title: 'Home | Disney+', captures: [{ path: '/explore/v1.7/page/home', json: { data: { page: { containers: [
    { id: 'x1', type: 'set', style: { name: 'continue_watching' }, visuals: { name: 'Continue Watching' }, items: [] }] } } } }] }));
  check(emptyCw.state === 'ok' && emptyCw.items.length === 0, 'rows matched but empty (new profile) -> ok with no items, not a layout error', emptyCw.state + ' ' + emptyCw.reason);

  /* ---------- missing steps and junk ---------- */
  var miss = run({ now: NOW, steps: {} });
  check(miss.state === 'error' && miss.reason === 'the reader returned no Disney+ page', 'missing home step -> error', miss.reason);
  var junk = [undefined, null, 0, 42, 'x', [], {}, { steps: null }, { steps: 'x' }, { steps: [] }, { steps: { home: 'x' } },
    { steps: { home: { captures: 'x', extracted: 42, finalUrl: 42 } } },
    { steps: { home: { captures: [null, 1, 'x', { json: 'x' }, { url: 5, json: { data: { set: { items: 'x' } } } }, { url: API_HOST + '/explore/v1.7/set/1', json: { data: { set: { items: [null, 1, { visuals: 7 }, { id: {}, visuals: { title: ['x'] } }] } } } }] } } },
    { steps: { home: { finalUrl: 'not a url', error: 'boom', extracted: [1, 2] } } },
    { steps: { home: { error: { code: {} , detail: { a: 1 } } } } }];
  var deep = { items: [] };
  var cur = deep;
  for (var d = 0; d < 5000; d++) { cur.items.push({ type: 'set', items: [] }); cur = cur.items[0]; }
  junk.push({ steps: { home: { finalUrl: SITE + '/home', captures: [{ url: API_HOST + '/explore/v1.7/page/home', json: deep }] } } });
  var cyc = { data: { page: { containers: [] } } };
  cyc.data.page.containers.push({ type: 'set', visuals: { name: 'For You' }, items: [cyc] });
  junk.push({ steps: { home: { finalUrl: SITE + '/home', captures: [{ url: API_HOST + '/explore/v1.7/page/home', json: cyc }] } } });
  var throwing = { steps: {} };
  Object.defineProperty(throwing.steps, 'home', { enumerable: true, get: function () { throw new Error('boom'); } });
  junk.push(throwing);
  junk.forEach(function (j, i) {
    var out;
    var threw = '';
    try { out = run(j); } catch (e) { threw = String(e && e.stack || e); }
    check(!threw && out && shape.STATES.indexOf(out.state) !== -1 && Array.isArray(out.items), 'junk read #' + i + ' never throws', threw.slice(0, 200));
  });
  var t = run(throwing);
  check(t.state === 'error' && /internal error \(boom\)/.test(t.reason), 'a throwing read becomes an error with the cause', t.reason);

  /* ---------- steps() ---------- */
  var steps = disney.steps(CTX);
  var s0 = steps && steps[0] || {};
  check(disney.id === 'disney' && Array.isArray(steps) && steps.length === 2 && s0.name === 'home' && s0.type === 'view' && !s0.optional, 'steps: the home view first (required), then the Hulu hub', js(steps && steps.map(function (s) { return s.name; })));
  check(s0.url === 'https://www.disneyplus.com/home' && s0.budgetMs === 20000 && s0.scroll === 3 && typeof s0.settleMs === 'number', 'steps: home url, 20 s budget, scrolls 3 times', s0.url);
  var compiled = null;
  try { compiled = new Function('return (' + s0.extract + ')'); } catch (e) { compiled = e; }
  check(typeof s0.extract === 'string' && typeof compiled === 'function', 'steps: extract is a JS expression that compiles', String(compiled));

  function evalExtract(doc, loc) {
    var sandbox = {};
    if (doc !== undefined) sandbox.document = doc;
    if (loc !== undefined) sandbox.location = loc;
    return vm.runInNewContext(s0.extract, sandbox, { timeout: 1000 });
  }
  var e1 = evalExtract({ title: 'Home | Disney+', querySelector: function () { return null; } }, { href: SITE + '/home' });
  check(e1 && e1.url === SITE + '/home' && e1.title === 'Home | Disney+' && e1.login === false, 'extract: url, title, no sign-in link on the signed-in home', js(e1));
  var e2 = evalExtract({ title: 'Disney+', querySelector: function (s) { return /login/.test(s) ? {} : null; } }, { href: SITE + '/' });
  check(e2 && e2.login === true, 'extract: a Log In link is seen', js(e2));
  var e3 = evalExtract({ title: 'x', querySelector: function () { throw new Error('bad selector'); } }, { href: SITE + '/home' });
  check(e3 && e3.login === false && e3.url === SITE + '/home', 'extract: a throwing querySelector is survived', js(e3));
  var e4 = evalExtract(undefined, undefined);
  check(e4 && e4.url === '' && typeof e4.error === 'string', 'extract: no document at all returns an object, never throws', js(e4));
  check(JSON.stringify(e1) && js(JSON.parse(JSON.stringify(e1))) === js(e1), 'extract: result is JSON-clonable', '');
  check(s0.ready(e1) === true && s0.ready(null) === false, 'ready: true once the page answered, false for null', '');

  function matches(u) { return (s0.capture || []).some(function (re) { re.lastIndex = 0; return re.test(u); }); }
  ['https://disney.api.edge.bamgrid.com/explore/v1.7/page/home', 'http://127.0.0.1:1234/explore/v1.7/page/home',
    'https://disney.api.edge.bamgrid.com/explore/v1.10/set/a0000000-0000-4000-8000-0000000000b1?limit=15',
    'https://disney.content.edge.bamgrid.com/explore/v1.0/page/home', 'https://disney.api.edge.bamgrid.com/explore/v1.7/userState',
    'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql', 'http://127.0.0.1:1234/graph/v1/device/graphql',
    'https://disney.api.edge.bamgrid.com/v1/public/graphql'].forEach(function (u) {
    check(matches(u), 'capture matches ' + u.replace(/^https?:\/\//, ''), '');
  });
  ['https://www.disneyplus.com/home', 'https://disney.api.edge.bamgrid.com/explore/v1.7/settings', 'https://disney.images.edge.bamgrid.com/ripcut-delivery/v2/variant/disney/X/scale'].forEach(function (u) {
    check(!matches(u), 'capture ignores ' + u.replace(/^https?:\/\//, ''), '');
  });

  var caps = readFrom(home).steps.home.captures;
  check(s0.enough(caps) === true, 'enough: true once Continue Watching and the Watchlist both have items', '');
  check(s0.enough(caps.slice(0, 1)) === false, 'enough: false while the Watchlist is still a lazy empty set', '');
  check(s0.enough([]) === false && s0.enough(null) === false && s0.enough('x') === false && s0.enough([null, 1, { url: 3 }]) === false, 'enough: false (never throws) on junk', '');

  /* ---------- year + type (what tells two services' copies of a title apart) ---------- */
  var moanaY = byTitle(res, 'Moana 2') || {};
  check(moanaY.year === 2024 && moanaY.type === 'movie', 'year/type: a film with a runtime -> movie, its release year', moanaY.year + ' ' + moanaY.type);
  check((byTitle(res, 'Bluey') || {}).type === 'show' && (byTitle(res, 'Mickey Mouse Clubhouse') || {}).year === 2006, 'year/type: an episode -> show; a series row keeps its start year', '');
  var omitbY = byTitle(res, 'Only Murders in the Building') || {};
  check(omitbY.year === null && omitbY.type === '', 'year/type: nothing in Disney+\'s fields -> null and "" (no guess)', omitbY.year + ' ' + js(omitbY.type));

  /* ---------- Hulu inside Disney+: the Hulu hub ---------- */
  var hubFx = fixture('disney-hulu-hub.json');
  check(/^shape from /.test(hubFx._fixture) && hubFx._fixture.indexOf('unverified against a live account') !== -1, 'fixture disney-hulu-hub.json has an honest _fixture label', '');
  function hubStep(fx, over) {
    var finalUrl = SITE + fx.finalPath;
    var st = {
      ok: true, url: SITE + '/browse/hulu', finalUrl: finalUrl, title: fx.title, status: 200,
      extracted: { url: finalUrl, title: fx.title, login: false, linkPrompt: false },
      captures: (fx.captures || []).map(function (c) { return { url: API_HOST + c.path, status: c.status || 200, json: c.json }; }),
      error: null
    };
    for (var k in (over || {})) st[k] = over[k];
    return st;
  }
  function withHub(st) { var rd = readFrom(home); rd.steps.hulu = st; return rd; }
  var h = run(withHub(hubStep(hubFx)));
  check(h.state === 'ok' && h.warnings.length === 0, 'hub: ok, no warning when Hulu reads', h.state + ' ' + js(h.warnings));
  check(js(titles(h).slice(0, expectTitles.length)) === js(expectTitles), 'hub: the home rows come first, unchanged', js(titles(h)));
  var hubTitles = titles(h).slice(expectTitles.length);
  check(js(hubTitles) === js(['Paradise', 'The Simpsons', 'Abbott Elementary', 'King of the Hill', 'Prey']),
    'hub: its rows in page order (promo strip, locked title and duplicates out; 4 rows max)', js(hubTitles));
  var huluItems = h.items.slice(expectTitles.length);
  check(huluItems.every(function (i) { return i.badge === 'Hulu' && i.service === 'disney' && i.kind === 'rec'; }), 'hub: every hub item is a Disney+ pick badged Hulu', js(huluItems.map(function (i) { return i.badge + '/' + i.kind; })));
  var paradise = byTitle(h, 'Paradise') || {};
  check(paradise.group === 'Hulu Originals' && paradise.year === 2025 && paradise.type === 'show' && paradise.subtitle === 'Drama, Thriller · 2025',
    'hub: Paradise keeps its row name (already says Hulu), year, show', js(paradise));
  check(paradise.url === SITE + '/browse/entity-9a1b2c3d-4e5f-4061-8a7b-8c9d0e1f2a31' && paradise.image === RIPCUT + 'PARADISETILE178/scale?width=640&aspectRatio=1.78', 'hub: Paradise opens its Disney+ page, ripcut art', paradise.url);
  check((byTitle(h, 'King of the Hill') || {}).group === 'Hulu: Comedies' && (byTitle(h, 'Prey') || {}).group === 'Hulu: Movies', 'hub: a row whose name does not say Hulu is named "Hulu: <row>"', '');
  var prey = byTitle(h, 'Prey') || {};
  check(prey.type === 'movie' && prey.year === 2022, 'hub: Prey is a 2022 movie', prey.type + ' ' + prey.year);
  check(!byTitle(h, 'Locked Hulu Title') && !byTitle(h, 'Fifth Row Show'), 'hub: an upsell title and a fifth row are left out', '');
  check(h.items.filter(function (i) { return i.title === 'Shōgun' && i.kind === 'rec'; }).length === 1, 'hub: Shōgun (on home and the hub) shows once', '');
  var simpsonsWl = h.items.filter(function (i) { return i.title === 'The Simpsons' && i.kind === 'watchlist'; })[0] || {};
  check(simpsonsWl.badge === 'Hulu', 'hub: a Watchlist title the Hulu hub lists is badged Hulu (Disney+\'s own grouping)', simpsonsWl.badge);
  check((byTitle(h, 'Bluey') || {}).badge === '' && (byTitle(h, 'Bruins at Maple Leafs') || {}).badge === 'ESPN', 'hub: titles the hub does not list keep their own badge', '');

  var hl = run(withHub(hubStep(hubFx, { extracted: { url: SITE + hubFx.finalPath, title: hubFx.title, login: false, linkPrompt: true } })));
  check(hl.state === 'ok' && js(hl.warnings) === js([disney._internal.HULU_NOT_LINKED]) && titles(hl).indexOf('Paradise') !== -1,
    'hub: Disney+ offering "Link your Hulu profile" -> the hub still reads, and a note says Hulu is not linked and how', js(hl.warnings));
  check(/Disney\+ → Profile → Link Hulu/.test(disney._internal.HULU_NOT_LINKED) && disney._internal.HULU_NOT_LINKED.length <= 160, 'hub: the not-linked note names the fix and fits a warning', '');

  var lockedFx = JSON.parse(JSON.stringify(hubFx));
  shape.walk(lockedFx.captures, function (node) {
    if (node && Array.isArray(node.actions)) node.actions = [{ type: 'upsell' }].concat(node.actions.filter(function (a) { return a.type !== 'upsell'; }));
  });
  var hk = run(withHub(hubStep(lockedFx)));
  check(hk.state === 'ok' && js(hk.warnings) === js([disney._internal.HULU_LOCKED]) && titles(hk).length === expectTitles.length,
    'hub: every hub title locked -> no Hulu picks, and a note says Hulu is not in the plan', js(hk.warnings));

  var hn = run(withHub(hubStep(hubFx, { finalUrl: SITE + '/home', extracted: { url: SITE + '/home', title: 'Home | Disney+', login: false }, captures: [] })));
  check(js(hn.warnings) === js([disney._internal.HULU_NO_HUB]) && hn.items.length === res.items.length, 'hub: /browse/hulu landing back on /home -> "no Hulu hub" note, home rows kept', js(hn.warnings));
  var ht = run(withHub(hubStep(hubFx, { ok: false, captures: [], error: { code: 'timeout', detail: 'timed out' } })));
  check(ht.state === 'ok' && ht.warnings.length === 1 && /Hulu hub in Disney\+ didn.t load \(timed out after 15 s\)/.test(ht.warnings[0]), 'hub: a timed-out hub is a note with the reason, never silence', js(ht.warnings));
  var hc = run(withHub(hubStep(hubFx, { captures: [] })));
  check(js(hc.warnings) === js([disney._internal.HULU_NO_HUB]), 'hub: a hub page that fetched no rows at all -> "no Hulu hub" note', js(hc.warnings));
  var unnamed = JSON.parse(JSON.stringify(hubFx));
  unnamed.captures = unnamed.captures.slice(0, 1);
  unnamed.captures[0].json.data.page.containers.forEach(function (c) { c.visuals = {}; c.style = { name: 'standard_compact' }; });
  var hu = run(withHub(hubStep(unnamed)));
  check(js(hu.warnings) === js([disney._internal.HULU_HUB_EMPTY]), 'hub: rows with no names -> "none of its rows matched" note', js(hu.warnings));
  var hs = run(withHub(hubStep(hubFx, { finalUrl: SITE + '/login', captures: [] })));
  check(hs.state === 'ok' && /sign in again/.test(hs.warnings[0] || ''), 'hub: a hub that bounced to /login is a note; the home rows still count', js(hs.warnings));
  var so = readFrom(signedOut);
  so.steps.hulu = hubStep(hubFx);
  check(run(so).state === 'signed-out', 'hub: a signed-out home is signed out, whatever the hub step holds', '');

  var s1 = steps[1] || {};
  check(s1.name === 'hulu' && s1.type === 'view' && s1.optional === true && s1.url === SITE + '/browse/hulu' && s1.budgetMs === 15000,
    'steps: the Hulu hub view (optional, /browse/hulu, 15 s)', js({ name: s1.name, url: s1.url, optional: s1.optional, budget: s1.budgetMs }));
  var hubCaps = hubStep(hubFx).captures;
  check(s1.enough(hubCaps) === true && s1.enough([]) === false && s1.enough(null) === false, 'enough (hub): true once two named rows have items; false on nothing', '');
  var hx = vm.runInNewContext(s1.extract, { document: { title: 'Hulu Movies and Shows | Disney+', body: { innerText: 'Hulu\nLink your Hulu profile to see your shows' }, querySelector: function () { return null; } }, location: { href: SITE + '/browse/page-x' } }, { timeout: 1000 });
  var hy = vm.runInNewContext(s1.extract, { document: { title: 'Hulu', body: { innerText: 'Hulu Originals\nTrending on Hulu' }, querySelector: function () { return null; } }, location: { href: SITE + '/browse/page-x' } }, { timeout: 1000 });
  check(hx && hx.linkPrompt === true && hy && hy.linkPrompt === false && hy.login === false, 'extract (hub): sees a "Link your Hulu profile" prompt, and only that', js([hx, hy]));
};
