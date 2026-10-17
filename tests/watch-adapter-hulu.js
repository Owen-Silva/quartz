'use strict';
/*
 * tests/watch-adapter-hulu.js -- the hulu.com adapter against hand-written fixtures
 * (tests/watch-fixtures/hulu-*.json). Pure node: builds the read the reader views would hand
 * over (the home hub, then My Stuff) and asserts the parse result AFTER shape.cleanResult.
 * module.exports = async function (check) { ... }.
 */
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var shape = require('../watch/shape');
var hulu = require('../watch/adapters/hulu');
var disney = require('../watch/adapters/disney');

var FIX = path.join(__dirname, 'watch-fixtures');
var API_HOST = 'https://discover.hulu.com';
var SITE = 'https://www.hulu.com';
var NOW = Date.parse('2026-10-17T20:00:00Z');
var CTX = { now: NOW, tz: 'America/New_York' };

function fixture(name) { return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8')); }

/* One step as the reader view would produce it for a fixture. */
function stepFrom(fx, url, over) {
  var finalUrl = SITE + fx.finalPath;
  var step = {
    ok: true, url: url, finalUrl: finalUrl, title: fx.title, status: 200,
    extracted: { url: finalUrl, title: fx.title, login: false },
    captures: (fx.captures || []).map(function (c) { return { url: (/^\/v\d+\/users\//.test(c.path) ? 'https://home.hulu.com' : API_HOST) + c.path, status: c.status || 200, json: c.json }; }),
    error: null
  };
  for (var k in (over || {})) step[k] = over[k];
  return step;
}
function readFrom(homeFx, stuffFx, overHome, overStuff) {
  var steps = { home: stepFrom(homeFx, SITE + '/hub/home', overHome) };
  if (stuffFx) steps.mystuff = stepFrom(stuffFx, SITE + '/my-stuff', overStuff);
  return { now: NOW, steps: steps };
}

function run(read) { return shape.cleanResult(hulu.parse(read, CTX)); }
function byTitle(res, title, kind) { return res.items.filter(function (i) { return i.title === title && (!kind || i.kind === kind); })[0] || null; }
function titles(res) { return res.items.map(function (i) { return i.title; }); }
function near(a, b) { return typeof a === 'number' && Math.abs(a - b) < 0.001; }
function js(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }

module.exports = async function (check) {
  var home = fixture('hulu-home.json');
  var stuff = fixture('hulu-mystuff.json');
  var signedOut = fixture('hulu-signedout.json');
  var changed = fixture('hulu-changed.json');

  /* ---------- fixtures are labelled honestly ---------- */
  [['hulu-home.json', home], ['hulu-mystuff.json', stuff], ['hulu-signedout.json', signedOut], ['hulu-changed.json', changed]].forEach(function (p) {
    var f = p[1]._fixture || '';
    check(/^shape from /.test(f) && f.indexOf('unverified against a live account') !== -1, 'fixture ' + p[0] + ' has an honest _fixture label', f.slice(0, 80));
  });

  /* ---------- the service is registered ---------- */
  var svc = shape.serviceById('hulu') || {};
  check(shape.SERVICE_IDS.indexOf('hulu') === shape.SERVICE_IDS.indexOf('disney') + 1, 'shape: hulu is a service, right after Disney+', js(shape.SERVICE_IDS));
  check(svc.everyMin === shape.serviceById('disney').everyMin && svc.needsSignIn === true && svc.edge === true, 'shape: Hulu reads on Disney+\'s floor, needs sign-in, plays in Edge', js(svc));
  check(svc.home === SITE + '/hub/home' && svc.signIn === SITE + '/login' && svc.searchUrl === SITE + '/search?q=', 'shape: Hulu home, sign-in and search are hulu.com pages', js([svc.home, svc.signIn, svc.searchUrl]));
  check(shape.serviceForUrl(SITE + '/series/x') === 'hulu' && shape.serviceForUrl('https://www.disneyplus.com/browse/entity-x') === 'disney', 'shape: a hulu.com URL is Hulu\'s, a Disney+ one Disney+\'s', '');

  /* ---------- the signed-in home hub + My Stuff ---------- */
  var res = run(readFrom(home, stuff));
  check(res.state === 'ok' && res.reason === '' && res.warnings.length === 0, 'home: state ok, no reason, no warning', res.state + ' ' + res.reason + ' ' + js(res.warnings));
  check(res.profile === 'the user', 'home: the current profile from the profiles capture', res.profile);
  var expect = ['The Bear', 'X', 'Abbott Elementary', 'Only Murders in the Building', 'Shōgun', 'Reservation Dogs', 'Paradise', 'Anora'];
  check(js(titles(res)) === js(expect), 'home: rows and order (hub order, lazy collection in place, My Stuff last)', js(titles(res)));
  check(js(res.items.map(function (i) { return i.kind; })) === js(['resume', 'resume', 'resume', 'rec', 'rec', 'rec', 'watchlist', 'watchlist']), 'home: kinds per row', js(res.items.map(function (i) { return i.kind; })));
  check(res.items.every(function (i) { return i.service === 'hulu' && i.edge === true && i.badge === '' && i.url.indexOf(SITE + '/') === 0; }), 'every item: service hulu, opens hulu.com in Edge, no badge', '');

  var bear = byTitle(res, 'The Bear') || {};
  check(bear.id === 'hulu:05eb6a8e-90ed-4947-8c0b-e6536cbddd5f' && bear.url === SITE + '/series/05eb6a8e-90ed-4947-8c0b-e6536cbddd5f',
    'The Bear: the SHOW\'s page (/series/<uuid>, a 200 on the public site), not the episode', bear.id + ' ' + bear.url);
  check(bear.subtitle === 'S4 E3 · Bears' && near(bear.progress, 0.5) && bear.durationSec === 1800, 'The Bear: S4 E3 + episode name; progress = bookmark / bundle.duration', bear.subtitle + ' ' + bear.progress);
  check(bear.image === 'https://img3.hulu.com/user/v3/artwork/60da223c-d2a0-411a-95c9-665a839371f9?base_image_bucket_name=image_manager&base_image=679d3d97-b5e0-438f-9fd3-7c213bee0ad2&size=640x360&format=jpeg',
    'The Bear: the horizontal tile (not the title treatment), with the size Hulu\'s image server needs', bear.image);
  check(bear.year === 2022 && bear.type === 'show' && bear.group === 'Keep Watching', 'The Bear: the show\'s first year, a show, in Keep Watching', bear.year + ' ' + bear.type + ' ' + bear.group);

  var x = byTitle(res, 'X') || {};
  check(x.url === SITE + '/movie/3fbf22c6-aa72-4f9d-a34e-618687012de4' && x.type === 'movie' && x.year === 2022, 'X: a movie page, a movie, 2022', js(x));
  check(near(x.progress, 0.35) && x.subtitle === 'Horror, Thriller · 2022' && x.durationSec === 6300, 'X: progress from progress_percentage; genres (two) + year', x.progress + ' ' + x.subtitle);
  check(/&size=1280x720&format=jpeg$/.test(x.image) && x.image.split('size=').length === 2, 'X: an image that already has a size keeps it (no second size)', x.image);

  var abbott = byTitle(res, 'Abbott Elementary') || {};
  check(abbott.url === SITE + '/series/7c33eeb2-5d16-4a10-ad9e-ee31f9fff15c' && abbott.subtitle === 'S5 E2 · Juror #2',
    'Abbott (camelCase page model): the show from href, S5 E2 + name', abbott.url + ' ' + abbott.subtitle);
  check(near(abbott.progress, 0.25) && abbott.year === null && abbott.type === 'show', 'Abbott: progress 330/1320; an episode\'s own air date is not the show\'s year (null)', abbott.progress + ' ' + abbott.year);
  check(!byTitle(res, 'Orphan Episode') && !byTitle(res, 'FX') && !byTitle(res, 'ABC'), 'Keep Watching: an episode with no show to open and network tiles are skipped', '');

  var omitb = byTitle(res, 'Only Murders in the Building') || {};
  check(omitb.subtitle === 'Comedy, Mystery · 2021' && omitb.progress === null && omitb.group === 'Picked For You' && omitb.year === 2021 && omitb.type === 'show', 'Only Murders: a pick, genres + year, no progress', js(omitb));
  check(/aa000007-0000-4000-8000-000000000007&size=640x360/.test(omitb.image), 'Only Murders: the program tile, never the vertical poster', omitb.image);
  check((byTitle(res, 'Shōgun') || {}).image === '', 'Shōgun: no art -> empty image, still shown', '');
  check(!byTitle(res, 'Locked Add-on Show'), 'picks: an upsell (add-on) title is skipped', '');
  check((byTitle(res, 'Reservation Dogs') || {}).group === 'Because You Watched The Bear', 'picks: the lazy view_hubs collection fills its row (id from the URL)', '');
  check(!byTitle(res, 'A Genre Row Show') && !byTitle(res, 'Paradise', 'rec'), 'a genre row and the hero strip are not picks', '');

  var paradise = byTitle(res, 'Paradise', 'watchlist') || {};
  check(paradise.group === 'My Stuff' && paradise.year === 2025 && paradise.type === 'show', 'My Stuff: Paradise, grouped as My Stuff', js(paradise));
  check((byTitle(res, 'Anora') || {}).type === 'movie' && (byTitle(res, 'Anora') || {}).url === SITE + '/movie/5c6d7e8f-9012-4b3c-8d4e-5f6a7b8c9d11', 'My Stuff: Anora is a movie page', '');
  check(!byTitle(res, 'Not In My Stuff'), 'My Stuff: its "You May Also Like" row is not his list', '');

  /* The same title from hulu.com and from Disney+: what the duplicate merge needs. */
  var dRes = shape.cleanResult(disney.parse({ now: NOW, steps: { home: {
    finalUrl: 'https://www.disneyplus.com/home', extracted: { url: 'https://www.disneyplus.com/home', login: false },
    captures: fixture('disney-home.json').captures.map(function (c) { return { url: 'https://disney.api.edge.bamgrid.com' + c.path, status: 200, json: c.json }; }) } } }, CTX));
  var dShogun = byTitle(dRes, 'Shōgun') || {};
  var hShogun = byTitle(res, 'Shōgun') || {};
  check(hShogun.title === dShogun.title && hShogun.year === 2024 && dShogun.year === 2024 && hShogun.type === 'show',
    'duplicates: Shōgun on hulu.com and in Disney+ share title and year (and hulu.com says show)', js([hShogun.year, dShogun.year, hShogun.type, dShogun.type]));

  /* ---------- My Stuff missing or failing ---------- */
  var only = run(readFrom(home, null));
  check(only.state === 'ok' && only.warnings.length === 0 && !only.items.some(function (i) { return i.kind === 'watchlist'; }), 'home only (no My Stuff step): ok, no list, no warning', js(only.warnings));
  var stuffSlow = run(readFrom(home, stuff, null, { ok: false, captures: [], error: { code: 'timeout', detail: 'timed out' } }));
  check(stuffSlow.state === 'ok' && js(stuffSlow.warnings) === js(["My Stuff didn't load (timed out after 12 s)"]) && stuffSlow.items.length === 6,
    'My Stuff timing out is a warning with the reason; the home rows stay', js(stuffSlow.warnings));
  var stuffOut = run(readFrom(home, stuff, null, { finalUrl: 'https://auth.hulu.com/web/login?next=x', captures: [] }));
  check(/sign in again/.test(stuffOut.warnings[0] || ''), 'My Stuff bouncing to the log-in page is a warning', js(stuffOut.warnings));
  var stuffOdd = run(readFrom(home, stuff, null, { captures: [] }));
  check(/My Stuff loaded but sent no rows/.test(stuffOdd.warnings[0] || ''), 'My Stuff with no data at all is a warning', js(stuffOdd.warnings));
  var stuffEmpty = JSON.parse(JSON.stringify(stuff));
  stuffEmpty.captures[0].json.components.forEach(function (c) { c.items = []; });
  check(run(readFrom(home, stuffEmpty)).warnings.length === 0, 'an empty My Stuff is just empty: no warning', '');

  /* ---------- signed out, and every way a read can fail ---------- */
  var so = run(readFrom(signedOut));
  check(so.state === 'signed-out' && so.reason === hulu._internal.SIGNED_OUT_REASON && so.items.length === 0, 'signed out: /hub/home -> /welcome is signed-out with the reason', so.state + ' ' + so.reason);
  check(/sign in to hulu\.com in Quartz/.test(so.reason) && /turn Hulu off in Settings > Watch/.test(so.reason), 'signed out: the reason says what to do either way', so.reason);
  check(run(readFrom(home, null, { finalUrl: 'https://auth.hulu.com/web/login?next=https%3A%2F%2Fwww.hulu.com%2Fhub%2Fhome' })).state === 'signed-out', 'signed out: landing on auth.hulu.com', '');
  check(run(readFrom(home, null, { finalUrl: SITE + '/', extracted: { url: SITE + '/' } })).state === 'signed-out', 'signed out: the bare landing page', '');
  var unauth = readFrom(home);
  unauth.steps.home.captures.forEach(function (c) { if (/\/content\//.test(c.url)) c.status = 401; });
  check(run(unauth).state === 'signed-out', 'signed out: every content call answered 401', '');
  check(run(readFrom({ finalPath: '/hub/home', title: 'Hulu', captures: [] }, null, { extracted: { url: SITE + '/hub/home', title: 'Hulu', login: true } })).state === 'signed-out',
    'signed out: no data and a log-in link on the page', '');
  var picker = run(readFrom(home, null, { finalUrl: 'https://secure.hulu.com/profiles/select' }));
  check(picker.state === 'error' && /who's watching/.test(picker.reason), 'profile picker: an error that says to pick a profile', picker.reason);
  var moved = run(readFrom(home, null, { finalUrl: 'https://www.disneyplus.com/browse/hulu' }));
  check(moved.state === 'error' && moved.reason === hulu._internal.MOVED_REASON, 'hulu.com sending Quartz to Disney+ says Hulu now lives there and what to do', moved.reason);
  var ch = run(readFrom(changed));
  check(ch.state === 'error' && /no Keep Watching data matched \(Hulu changed its layout\?\) \(1 response read\)/.test(ch.reason), 'changed layout: a reason, never an empty ok', ch.reason);
  var empty = JSON.parse(JSON.stringify(home));
  empty.captures = empty.captures.slice(0, 1);
  empty.captures[0].json.components.forEach(function (c) { c.items = []; });
  var em = run(readFrom(empty));
  check(em.state === 'ok' && em.items.length === 0, 'a new profile (Keep Watching and picks present, empty) is ok and empty, not a failure', em.state + ' ' + em.reason);
  var reasons = [
    [{ code: 'offline' }, /you're offline, so Quartz couldn't reach hulu\.com/],
    [{ code: 'load-failed', detail: 'ERR_NAME_NOT_RESOLVED' }, /the hulu\.com page didn't load \(ERR_NAME_NOT_RESOLVED\)/],
    [{ code: 'http' }, /hulu\.com answered HTTP 503/],
    [{ code: 'crashed' }, /hidden reader page crashed/],
    [{ code: 'weird' }, /the reader failed \(weird\)/]
  ];
  reasons.forEach(function (p) {
    var r = run(readFrom(home, null, { ok: false, status: 503, error: p[0], captures: [] }));
    check(r.state === 'error' && p[1].test(r.reason), 'error ' + p[0].code + ': ' + r.reason, r.reason);
  });
  var slow = run(readFrom(home, null, { ok: false, error: { code: 'timeout', detail: 'timed out' } }));
  check(slow.state === 'ok' && slow.items.length === 6, 'a timeout that still captured the rows reads them', slow.state + ' ' + slow.items.length);
  var slowEmpty = run(readFrom(home, null, { ok: false, error: { code: 'timeout' }, captures: [] }));
  check(slowEmpty.state === 'error' && /timed out after 20 s/.test(slowEmpty.reason), 'a timeout with nothing captured is "timed out after 20 s"', slowEmpty.reason);
  check(run({ steps: {} }).state === 'error' && run(null).state === 'error', 'no home step / no read at all: an error with a reason', '');
  var throwing = readFrom(home);
  Object.defineProperty(throwing.steps.home, 'captures', { get: function () { throw new Error('boom'); } });
  var t = run(throwing);
  check(t.state === 'error' && /internal error \(boom\)/.test(t.reason), 'a throwing read becomes an error with the cause', t.reason);

  /* ---------- steps() ---------- */
  var steps = hulu.steps(CTX);
  var s0 = steps[0] || {};
  var s1 = steps[1] || {};
  check(hulu.id === 'hulu' && steps.length === 2 && s0.name === 'home' && s0.type === 'view' && !s0.optional && s1.name === 'mystuff' && s1.optional === true,
    'steps: the home hub (required), then My Stuff (optional)', js(steps.map(function (s) { return s.name; })));
  check(s0.url === SITE + '/hub/home' && s0.budgetMs === 20000 && s0.scroll === 3 && s1.url === SITE + '/my-stuff' && s1.budgetMs === 12000, 'steps: urls and budgets', js([s0.url, s1.url]));
  var compiled = null;
  try { compiled = new Function('return (' + s0.extract + ')'); } catch (e) { compiled = e; }
  check(typeof compiled === 'function', 'steps: extract is a JS expression that compiles', String(compiled));
  function evalExtract(doc, loc) {
    var sandbox = {};
    if (doc !== undefined) sandbox.document = doc;
    if (loc !== undefined) sandbox.location = loc;
    return vm.runInNewContext(s0.extract, sandbox, { timeout: 1000 });
  }
  var e1 = evalExtract({ title: 'Home | Hulu', querySelector: function () { return null; } }, { href: SITE + '/hub/home' });
  check(e1 && e1.url === SITE + '/hub/home' && e1.login === false, 'extract: url, title, no log-in link', js(e1));
  var e2 = evalExtract({ title: 'Hulu', querySelector: function (s) { return /auth\.hulu\.com/.test(s) ? {} : null; } }, { href: SITE + '/welcome' });
  check(e2 && e2.login === true, 'extract: an auth.hulu.com log-in link is seen', js(e2));
  var e3 = evalExtract(undefined, undefined);
  check(e3 && e3.url === '' && typeof e3.error === 'string', 'extract: no document returns an object, never throws', js(e3));
  check(s0.ready(e1) === true && s0.ready(null) === false, 'ready: true once the page answered', '');

  function matches(step, u) { return (step.capture || []).some(function (re) { re.lastIndex = 0; return re.test(u); }); }
  ['https://discover.hulu.com/content/v5/hubs/home?schema=1', 'http://127.0.0.1:1234/content/v5/hubs/home',
    'https://discover.hulu.com/content/v5/view_hubs/home/collections/204?offset=0', 'https://discover.hulu.com/content/v3/entity?eab_ids=x',
    'https://discover.hulu.com/content/v4/hubs/series/x/season/1', 'https://home.hulu.com/v2/users/self/profiles'].forEach(function (u) {
    check(matches(s0, u), 'capture matches ' + u.replace(/^https?:\/\//, ''), '');
  });
  ['https://www.hulu.com/hub/home', 'https://img.hulu.com/user/v3/artwork/x?size=1x1', 'https://play.hulu.com/v6/playlist', 'https://discover.hulu.com/content/v5/deeplink/playback'].forEach(function (u) {
    check(!matches(s0, u), 'capture ignores ' + u.replace(/^https?:\/\//, ''), '');
  });
  check(!matches(s1, 'https://home.hulu.com/v2/users/self/profiles') && matches(s1, 'https://discover.hulu.com/content/v5/hubs/my-stuff'), 'capture (My Stuff): content only', '');

  var caps = stepFrom(home, SITE + '/hub/home').captures;
  check(s0.enough(caps) === true && s0.enough(caps.slice(2)) === false && s0.enough(null) === false && s0.enough([null, 1]) === false, 'enough (home): Keep Watching + picks; never throws', '');
  var stuffCaps = stepFrom(stuff, SITE + '/my-stuff').captures;
  check(s1.enough(stuffCaps) === true && s1.enough([]) === false, 'enough (My Stuff): once a list row has items', '');

  var I = hulu._internal;
  check(I.signedOutByUrl(SITE + '/welcome') && I.signedOutByUrl('https://signup.hulu.com/plans') && !I.signedOutByUrl(SITE + '/hub/home') && !I.signedOutByUrl('nope'),
    'signedOutByUrl: /welcome and signup.hulu.com yes; the hub and junk no', '');
  check(I.profilePickerByUrl(SITE + '/profiles') && !I.profilePickerByUrl(SITE + '/hub/home') && I.movedToDisney('https://www.disneyplus.com/home') && !I.movedToDisney(SITE + '/'),
    'profilePickerByUrl / movedToDisney', '');
};
