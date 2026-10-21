'use strict';
/*
 * tests/watch-adapter-prime.js -- the Prime Video adapter against its fixtures.
 * Pure node: no Electron, no browser, no network. Every assertion is on the
 * result AFTER shape.cleanResult, the way watch-main.js hands it on.
 *
 *   module.exports = async function (check) { ... }   check(cond, label, detail)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const shape = require('../watch/shape');
const adapter = require('../watch/adapters/prime');

const FIX = path.join(__dirname, 'watch-fixtures');
const ORIGIN = 'https://www.primevideo.com';
const CTX = { now: Date.UTC(2026, 9, 16, 12, 0, 0), tz: 'America/Los_Angeles' };

const REASON_SIGNED_OUT = 'sign in to Prime Video in Quartz to see your rows';
const REASON_ROBOT = 'Amazon showed a robot check; open Prime Video once in Quartz to clear it';

function fixture(name) { return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8')); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }

/* The read the reader would hand over for a fixture page. `over` patches the step; `xOver` the extracted value. */
function readFrom(fx, over, xOver) {
  const finalUrl = ORIGIN + (fx.finalPath || '/');
  const extracted = Object.assign({
    hydration: fx.hydration == null ? null : JSON.stringify(fx.hydration),
    store: fx.store == null ? null : JSON.stringify(fx.store),
    url: finalUrl,
    title: fx.title || '',
    robot: fx.robot === true,
    signedIn: null
  }, xOver || {});
  const step = Object.assign({
    ok: true, url: ORIGIN + '/', finalUrl, title: fx.title || '', status: 200,
    extracted, captures: [], error: null
  }, over || {});
  return { now: CTX.now, steps: { home: step } };
}

function run(read) { return shape.cleanResult(adapter.parse(read, CTX)); }
function byId(items, kind, id) { return items.find((it) => it.kind === kind && it.id === id) || null; }
function ids(items, kind) { return items.filter((it) => it.kind === kind).map((it) => it.id); }
function short(v) { try { return JSON.stringify(v).slice(0, 300); } catch (err) { return String(v); } }

/* A tiny fake page for the extract IIFE. */
function fakePage(opts) {
  const o = opts || {};
  const els = {};
  if (o.hydration != null) els['dv-web-page-hydration-data'] = { textContent: o.hydration };
  if (o.store != null) els['dv-web-global-store-data'] = { textContent: o.store };
  const selectors = o.selectors || {};
  const document = {
    title: o.title == null ? 'Prime Video' : o.title,
    readyState: o.readyState || 'complete',
    getElementById: o.throws ? () => { throw new Error('boom'); } : (id) => els[id] || null,
    querySelector: (sel) => (selectors[sel] ? {} : null),
    body: { textContent: o.bodyText || '' }
  };
  const location = { href: ORIGIN + (o.path || '/'), pathname: o.path || '/' };
  return { document, location };
}

function runExtract(page) {
  const ctx = vm.createContext({ document: page.document, location: page.location });
  return vm.runInContext(adapter.steps(CTX)[0].extract, ctx, { timeout: 10000 });
}

module.exports = async function (check) {
  const home = fixture('prime-home.json');
  const signedout = fixture('prime-signedout.json');
  const robot = fixture('prime-robot.json');
  const changed = fixture('prime-changed.json');

  /* ------------------------------------------------------------ fixtures */
  for (const [name, fx] of [['prime-home', home], ['prime-signedout', signedout], ['prime-robot', robot], ['prime-changed', changed]]) {
    check(typeof fx._fixture === 'string' && fx._fixture.indexOf('shape from ') === 0 && /unverified against a live account/.test(fx._fixture),
      name + ': _fixture names its source and says unverified', fx._fixture);
    check(typeof fx.finalPath === 'string' && fx.finalPath[0] === '/' && typeof fx.title === 'string' && 'hydration' in fx && 'store' in fx,
      name + ': wrapper keys finalPath/title/hydration/store', Object.keys(fx).join(','));
  }
  check(robot.robot === true && robot.hydration === null, 'prime-robot: robot:true and no hydration');

  /* --------------------------------------------------------------- steps */
  const steps = adapter.steps(CTX);
  check(adapter.id === 'prime', 'adapter id is prime', adapter.id);
  check(Array.isArray(steps) && steps.length === 1, 'steps(): exactly one step', short(steps));
  const st = steps[0] || {};
  check(st.name === 'home' && st.type === 'view', 'step is the home view', st.name + ' ' + st.type);
  check(st.url === 'https://www.primevideo.com/', 'step url is the Prime Video home', st.url);
  check(typeof st.budgetMs === 'number' && st.budgetMs === 20000, 'step budget 20 s', st.budgetMs);
  let compiles = false;
  try { new Function('return (' + st.extract + ')'); compiles = typeof st.extract === 'string'; } catch (err) { compiles = false; }
  check(compiles, 'extract is a string that compiles as a JS expression');
  check(typeof st.ready === 'function', 'ready is a function');
  check(st.ready({ hydration: '{"init":{}}' }) === true, 'ready: true once hydration is there');
  check(st.ready({ robot: true }) === true, 'ready: true on a robot check');
  check(st.ready({ signInPage: true }) === true, 'ready: true on a sign-in page');
  check(st.ready({ hydration: null, robot: false, signInPage: false, complete: false }) === false, 'ready: false while nothing is there');
  check(st.ready(null) === false && st.ready([]) === false && st.ready('x') === false, 'ready: false for junk');

  /* ------------------------------------------------- extract in a fake page */
  const homeText = JSON.stringify(home.hydration);
  const homeStore = JSON.stringify(home.store);
  let x = null;
  try { x = runExtract(fakePage({ hydration: homeText, store: homeStore })); } catch (err) { x = { threw: String(err) }; }
  check(x && x.hydration === homeText, 'extract: returns the hydration text (nothing to trim in this one)', short(x && x.hydration));
  check(x && x.store === homeStore, 'extract: returns the store text', short(x && x.store));
  check(x && x.robot === false && x.signedIn === true && x.title === 'Prime Video' && x.url === ORIGIN + '/',
    'extract: robot false, signedIn true from store customerID, title and url', short(x));

  const heavy = { init: { preparations: { body: { containers: [{ containerType: 'StandardCarousel', title: 'T',
    modelDebug: { big: 'x'.repeat(5000) }, entities: [{ title: 'A', itemAnalytics: { a: 1 }, station: { schedule: [1, 2, 3] },
      token: 'v0_'.padEnd(5000, 'z'), link: { url: '/detail/B0AAAAAAAA' } }] }] } } } };
  const heavyText = JSON.stringify(heavy);
  let xh = null;
  try { xh = runExtract(fakePage({ hydration: heavyText })); } catch (err) { xh = { threw: String(err) }; }
  let slim = null;
  try { slim = JSON.parse(xh.hydration); } catch (err) { slim = null; }
  const ent0 = slim && slim.init.preparations.body.containers[0].entities[0];
  check(xh && xh.trimmed === true && xh.hydrationBytes === heavyText.length && slim &&
    !('modelDebug' in slim.init.preparations.body.containers[0]) && ent0 && !('itemAnalytics' in ent0) && !('station' in ent0) &&
    !('token' in ent0) && ent0.link.url === '/detail/B0AAAAAAAA' && ent0.title === 'A',
  'extract: trims heavy keys in-page and keeps titles and links', short(xh && { trimmed: xh.trimmed, bytes: xh.hydrationBytes, slim }));

  let xr = null;
  try { xr = runExtract(fakePage({ title: 'Robot Check', path: '/errors/validateCaptcha', selectors: { 'form[action*="validateCaptcha"]': true } })); } catch (err) { xr = { threw: String(err) }; }
  check(xr && xr.robot === true && xr.hydration === null, 'extract: robot true on a captcha page', short(xr));
  let xr2 = null;
  try { xr2 = runExtract(fakePage({ title: 'Amazon', bodyText: 'Enter the characters you see below. Sorry, we just need to make sure you\'re not a robot.' })); } catch (err) { xr2 = { threw: String(err) }; }
  check(xr2 && xr2.robot === true, 'extract: robot true from captcha wording alone', short(xr2));
  let xr3 = null;
  try { xr3 = runExtract(fakePage({ title: 'Amazon.com' })); } catch (err) { xr3 = { threw: String(err) }; }
  check(xr3 && xr3.robot === true, 'extract: a bare "Amazon.com" page with no page data counts as a robot check', short(xr3));
  let xs = null;
  try { xs = runExtract(fakePage({ hydration: JSON.stringify(signedout.hydration), selectors: { '[data-testid="pv-nav-sign-in"]': true } })); } catch (err) { xs = { threw: String(err) }; }
  check(xs && xs.signedIn === false && xs.robot === false, 'extract: the nav Sign In link means signedIn false', short(xs && { signedIn: xs.signedIn, robot: xs.robot }));
  let xs2 = null;
  try { xs2 = runExtract(fakePage({ hydration: JSON.stringify(signedout.hydration), store: JSON.stringify(signedout.store) })); } catch (err) { xs2 = { threw: String(err) }; }
  check(xs2 && xs2.signedIn === false, 'extract: store customerID null means signedIn false', short(xs2 && xs2.signedIn));
  let xp = null;
  try { xp = runExtract(fakePage({ title: 'Amazon Sign-In', path: '/ap/signin' })); } catch (err) { xp = { threw: String(err) }; }
  check(xp && xp.signInPage === true, 'extract: /ap/signin is a sign-in page', short(xp));
  let xj = null;
  try { xj = runExtract(fakePage({ hydration: '<!doctype html>not json' })); } catch (err) { xj = { threw: String(err) }; }
  check(xj && xj.hydration === '<!doctype html>not json' && xj.trimmed === false, 'extract: non-JSON page data is handed over raw for parse to report', short(xj));
  let xt = null;
  try { xt = runExtract(fakePage({ throws: true })); } catch (err) { xt = { threw: String(err) }; }
  check(xt && !xt.threw && typeof xt.error === 'string', 'extract: a throwing page returns an object, never throws', short(xt));
  const many = [];
  for (let i = 0; i < 400000; i++) many.push('abcdefgh');
  let xb = null;
  try { xb = runExtract(fakePage({ hydration: JSON.stringify({ init: { list: many } }) })); } catch (err) { xb = { threw: String(err) }; }
  check(xb && xb.tooBig === true && xb.hydration === null && xb.hydrationBytes > 3000000, 'extract: over 3 MB after trimming is flagged, not sent', short(xb && { tooBig: xb.tooBig, bytes: xb.hydrationBytes }));

  /* ----------------------------------------------------------- home rows */
  const rawHome = adapter.parse(readFrom(home), CTX);
  const r = shape.cleanResult(rawHome);
  check(r.state === 'ok' && r.reason === '' && r.profile === '', 'home: ok, no reason, no profile named', short({ state: r.state, reason: r.reason, profile: r.profile }));
  check(r.items.length === 15, 'home: 15 items after the cleaner', r.items.length);
  const kinds = r.items.map((it) => it.kind).join(',');
  check(kinds === 'resume,resume,resume,resume,resume,watchlist,watchlist,watchlist,rec,rec,rec,rec,rec,rec,rec',
    'home: rows in page order (Continue watching, Watchlist, then recommendations)', kinds);
  check(ids(r.items, 'resume').join(',') === 'prime:B0BOYSFX04,prime:B0REACHFX2,prime:B0ROADHFX1,prime:B0FALLFX01,prime:B0DUNEFX02',
    'home: Continue watching items in page order with prime:<ASIN> ids', ids(r.items, 'resume').join(','));
  check(r.items.every((it) => it.service === 'prime' && it.edge === true), 'home: every item is prime and opens in Edge');

  const boys = byId(r.items, 'resume', 'prime:B0BOYSFX04') || {};
  check(boys.title === 'The Boys' && boys.subtitle === "S4 E3 · We'll Keep the Red Flag Flying Here", 'resume: The Boys title and S/E subtitle', short(boys));
  check(boys.url === 'https://www.primevideo.com/detail/0BOYSFIXTURE0000000000S04X/', 'resume: url is /detail/<link id>/ with the ref stripped', boys.url);
  check(boys.image === 'https://m.media-amazon.com/images/S/pv-target-images/fixture-boys-s4._UR1920,1080_.jpg', 'resume: 16:9 cover image', boys.image);
  check(boys.progress === 0.42, 'resume: progress { percentage: 42 } -> 0.42', boys.progress);
  check(boys.durationSec === 3840 && boys.group === '' && boys.badge === '', 'resume: runtime "1 h 4 min" -> 3840 s, no group, no badge', short(boys));
  const reacher = byId(r.items, 'resume', 'prime:B0REACHFX2') || {};
  check(reacher.progress === 0.25 && reacher.subtitle === 'S2 E5', 'resume: watchProgress 0.25 and nested season/episode', short(reacher));
  check(reacher.image === 'https://m.media-amazon.com/images/S/pv-target-images/fixture-reacher-s2._UR1920,1080_.jpg', 'resume: cover (16:9) wins over poster2x3', reacher.image);
  const road = byId(r.items, 'resume', 'prime:B0ROADHFX1') || {};
  check(road.progress === 0.75 && road.durationSec === 7200 && road.subtitle === '2024', 'resume: timecodeSeconds/runtimeSeconds in the Resume action -> 0.75', short(road));
  const fallout = byId(r.items, 'resume', 'prime:B0FALLFX01') || {};
  check(fallout.progress === null && fallout.title === 'Fallout' && fallout.subtitle === 'Season 1', 'resume: no progress field -> null; "Fallout - Season 1" -> Fallout / Season 1', short(fallout));
  const dune = byId(r.items, 'resume', 'prime:B0DUNEFX02') || {};
  check(dune.progress === 0.9 && dune.badge === 'Rent', 'resume: a rented title stays in your row, percentComplete 90 -> 0.9, badge Rent', short(dune));

  check(ids(r.items, 'watchlist').join(',') === 'prime:B0INVINFX3,prime:B0OPPENFX1,prime:B0YELLOFX1', 'watchlist: "Your Watchlist" row, page order', ids(r.items, 'watchlist').join(','));
  const wlOpp = byId(r.items, 'watchlist', 'prime:B0OPPENFX1') || {};
  const wlYel = byId(r.items, 'watchlist', 'prime:B0YELLOFX1') || {};
  check(wlOpp.badge === 'Rent' && wlYel.badge === 'Channel', 'watchlist: your own rent-only and channel titles stay, labelled Rent / Channel', short([wlOpp.badge, wlYel.badge]));
  check((byId(r.items, 'watchlist', 'prime:B0INVINFX3') || {}).progress === null, 'watchlist: no progress on watchlist items');

  const recIds = ids(r.items, 'rec');
  check(recIds.join(',') === 'prime:B0AIRFX001,prime:B0HOLDOFX1,prime:B0SALTBFX1,prime:B0GENVFX01,prime:B0INVINFX3,prime:B0TERMLFX1,prime:B0RINGSFX2',
    'rec: rows and items in page order', recIds.join(','));
  const air = byId(r.items, 'rec', 'prime:B0AIRFX001') || {};
  check(air.group === 'Recommended movies' && air.subtitle === 'Drama · 2023' && air.durationSec === 6720 && air.badge === '',
    'rec: Air in "Recommended movies", genre/year subtitle, runtime', short(air));
  check(recIds.filter((id) => id === 'prime:B0AIRFX001').length === 1, 'rec: a title repeated in one row appears once');
  check(recIds.indexOf('prime:B0OPPENFX1') === -1, 'rec: an unentitled rent/buy-only title is skipped');
  check(recIds.indexOf('prime:B0TULSAFX1') === -1, 'rec: an unentitled channel add-on is skipped');
  check((byId(r.items, 'rec', 'prime:B0HOLDOFX1') || {}).badge === 'Rent', 'rec: entitlement unknown + "Rent or buy" -> kept, badge Rent');
  check((byId(r.items, 'rec', 'prime:B0SALTBFX1') || {}).badge === 'Channel', 'rec: entitlement unknown + "Subscribe to MGM+" -> kept, badge Channel');
  const genv = byId(r.items, 'rec', 'prime:B0GENVFX01') || {};
  check(genv.group === 'Because you watched The Boys' && genv.title === 'Gen V' && genv.subtitle === 'Season 1',
    'rec: a { string } carousel title becomes the group', short(genv));
  check(byId(r.items, 'rec', 'prime:B0INVINFX3') && byId(r.items, 'watchlist', 'prime:B0INVINFX3'), 'rec: the same title may sit in Watchlist and a rec row');
  check((byId(r.items, 'rec', 'prime:B0TERMLFX1') || {}).subtitle === 'Action · 2022', 'rec: primaryGenre + year subtitle');
  const rings = byId(r.items, 'rec', 'prime:B0RINGSFX2') || {};
  check(rings.group === 'Amazon Originals' && rings.image === 'https://m.media-amazon.com/images/S/pv-target-images/fixture-rings-poster._UR1000,1500_.jpg',
    'rec: SuperCarousel row read; poster used when there is no 16:9 image', short(rings));
  const all = r.items.map((it) => it.id);
  check(all.indexOf('prime:B0HEROFX01') === -1 && all.indexOf('prime:B0HEROFX02') === -1, 'decoys: StandardHero items are not emitted', all.join(','));
  check(all.indexOf('prime:B0PROMOFX1') === -1, 'decoys: promotional banner items are not emitted');
  check(r.items.every((it) => it.title !== 'Local PBS station'), 'decoys: live station cards are not emitted');
  check(rawHome.counts && rawHome.counts.items === 15 && rawHome.counts.resume === 5 && rawHome.counts.watchlist === 3 && rawHome.counts.rec === 7 &&
    rawHome.counts.carousels === 5 && rawHome.counts.skipped.rent === 1 && rawHome.counts.skipped.channel === 1,
  'home: counts tally rows, items and skips', short(rawHome.counts));

  /* ------------------------------------------------ hydration as an object */
  const asObj = run(readFrom(home, null, { hydration: clone(home.hydration), store: clone(home.store) }));
  check(asObj.state === 'ok' && asObj.items.length === 15, 'an already-parsed hydration object is accepted', short({ s: asObj.state, n: asObj.items.length }));
  const asText = run(readFrom(home, { extracted: JSON.stringify(home.hydration) }));
  check(asText.state === 'ok' && asText.items.length === 15, 'extracted handed over as the bare hydration text is accepted', short({ s: asText.state, n: asText.items.length }));
  const withErr = run(readFrom(home, { error: { code: 'timeout', detail: '' } }));
  check(withErr.state === 'ok' && withErr.items.length === 15, 'a step error with good page data still reads the rows', short({ s: withErr.state, r: withErr.reason }));

  /* ------------------------------------------------------------ profile */
  const prof = clone(home.store);
  prof.Profile.name = 'Alex';
  const rp = run(readFrom(home, null, { store: JSON.stringify(prof) }));
  check(rp.state === 'ok' && rp.profile === 'Alex', 'profile: set only when the store names it', rp.profile);

  /* --------------------------------------------------------- signed out */
  const so = run(readFrom(signedout));
  check(so.state === 'signed-out' && so.reason === REASON_SIGNED_OUT && so.items.length === 0,
    'signed out: the real public page (store customerID null) is signed out with no rows', short(so));
  const soUrl = run(readFrom(home, { finalUrl: 'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.primevideo.com%2F' }));
  check(soUrl.state === 'signed-out' && soUrl.reason === REASON_SIGNED_OUT, 'signed out: a /ap/signin final URL', short(soUrl));
  const soAuth = run(readFrom(home, { finalUrl: ORIGIN + '/auth-redirect?signin=1&returnUrl=%2F' }));
  check(soAuth.state === 'signed-out', 'signed out: an /auth-redirect final URL', short(soAuth));
  const icOnly = clone(signedout.store);
  delete icOnly.RequestContext.customerID;
  const soIc = run(readFrom(signedout, null, { store: JSON.stringify(icOnly) }));
  check(soIc.state === 'signed-out', 'signed out: identityContext PVICS_UNAUTHENTICATED alone', short(soIc));
  const soDom = run(readFrom(signedout, null, { store: null, signedIn: false }));
  check(soDom.state === 'signed-out', 'signed out: extracted.signedIn false (nav Sign In link) alone', short(soDom));
  const soCta = run(readFrom(signedout, null, { store: null, signedIn: null }));
  check(soCta.state === 'signed-out', 'signed out: no Continue watching and sign-in buttons in the page data', short(soCta));
  const chOut = clone(changed.store);
  chOut.RequestContext.customerID = null;
  chOut.RequestContext.identityContext = signedout.store.RequestContext.identityContext;
  const soWins = run(readFrom(changed, null, { store: JSON.stringify(chOut) }));
  check(soWins.state === 'signed-out', 'signed out wins over "changed layout"', short(soWins));
  const soBad = run(readFrom(signedout, null, { hydration: 'not json at all', store: JSON.stringify(signedout.store) }));
  check(soBad.state === 'signed-out', 'signed out wins over unreadable page data', short(soBad));
  const personal = run(readFrom(home, null, { store: JSON.stringify(signedout.store) }));
  check(personal.state === 'ok' && personal.items.length === 15, 'a Continue watching row overrules a signed-out-looking store', short({ s: personal.state, n: personal.items.length }));

  /* The real public shapes, with the signed-out signals overridden: does the reader still find rows in them? */
  const pubIn = clone(signedout.store);
  pubIn.RequestContext.customerID = 'A1FIXTURECUSTOMER00';
  const pub = run(readFrom(signedout, null, { store: JSON.stringify(pubIn) }));
  const moon = byId(pub.items, 'rec', 'prime:B0C4XHFFDH') || {};
  check(pub.state === 'ok' && moon.title === 'The Secret of Moonacre' && moon.url === 'https://www.primevideo.com/detail/0JP3YPUKPPI2J2DUBNLKW6Z9KH/' &&
    moon.group === 'Free action and adventure movies' && moon.durationSec === 6120 && /^https:\/\/m\.media-amazon\.com\/images\/S\/pv-target-images\//.test(moon.image),
  'public shapes: a real StandardCarousel TitleCard becomes a rec item (detail link id, 16:9 cover, runtime)', short(moon));
  check(pub.items.length === 3 && pub.items.every((it) => it.group === 'Free action and adventure movies'),
    'public shapes: hero, live station and "free Prime trial, rent, or buy" items are left out', short(pub.items.map((it) => it.title)));

  /* -------------------------------------------------------------- robot */
  const rb = run(readFrom(robot));
  check(rb.state === 'error' && rb.reason === REASON_ROBOT && rb.items.length === 0, 'robot: the captcha fixture is an error that says so', short(rb));
  const rbPath = run(readFrom(robot, null, { robot: false }));
  check(rbPath.state === 'error' && rbPath.reason === REASON_ROBOT, 'robot: the /errors/validateCaptcha path alone', short(rbPath));
  const rbTitle = run(readFrom(Object.assign({}, robot, { finalPath: '/', title: 'Robot Check' }), null, { robot: false }));
  check(rbTitle.state === 'error' && rbTitle.reason === REASON_ROBOT, 'robot: a "Robot Check" title alone', short(rbTitle));
  const rbBare = run(readFrom(Object.assign({}, robot, { finalPath: '/' }), null, { robot: false }));
  check(rbBare.state === 'error' && rbBare.reason === REASON_ROBOT, 'robot: a bare "Amazon.com" page with no page data', short(rbBare));

  /* ----------------------------------------------------- changed layout */
  const ch = run(readFrom(changed));
  check(ch.state === 'error' && ch.reason === 'the page loaded but no Continue Watching data matched (Prime Video changed its layout?)',
    'changed layout: page data parses but nothing matches -> error with the reason', short(ch));
  const empties = { init: { preparations: { body: { containers: [{ containerType: 'StandardCarousel', title: 'Continue watching', isContinueWatching: true,
    entities: [{ widgetType: 'TitleCard' }, { title: 'No link here' }, 42, null] }] } } } };
  const ch2 = run(readFrom(changed, null, { hydration: JSON.stringify(empties) }));
  check(ch2.state === 'error' && /changed its layout/.test(ch2.reason), 'changed layout: carousels whose items have no title or link -> error', short(ch2));

  /* -------------------------------------------------- unreadable page data */
  const nj = run(readFrom(home, null, { hydration: '<!doctype html><html>oops' }));
  check(nj.state === 'error' && nj.reason === 'the page data could not be read (it was not valid JSON)', 'non-JSON page data -> error that says so', short(nj));
  const tr = run(readFrom(home, null, { hydration: homeText.slice(0, 5000) }));
  check(tr.state === 'error' && /could not be read/.test(tr.reason), 'truncated JSON page data -> could not be read', short(tr));
  const big = run(readFrom(home, null, { hydration: null, tooBig: true, hydrationBytes: 5200000 }));
  check(big.state === 'error' && /too big/.test(big.reason) && /5 MB/.test(big.reason), 'page data over the cap -> too big (5 MB)', short(big));
  const none = run(readFrom(home, null, { hydration: null }));
  check(none.state === 'error' && /page data was missing/.test(none.reason) && /changed its layout/.test(none.reason), 'no page data at all -> missing (layout changed?)', short(none));
  const none503 = run(readFrom(home, { status: 503 }, { hydration: null }));
  check(none503.state === 'error' && none503.reason === "Prime Video didn't load (HTTP 503)", 'no page data and HTTP 503 -> didn\'t load (HTTP 503)', short(none503));

  /* ---------------------------------------------------------- step errors */
  const blank = { finalPath: '/', title: '', hydration: null, store: null };
  const errBlank = (code, extra, stepOver) => run(readFrom(blank, Object.assign({ ok: false, error: Object.assign({ code, detail: '' }, extra || {}) }, stepOver || {}),
    { hydration: null, store: null }));
  check(errBlank('timeout').reason === 'timed out after 20 s', 'timeout -> "timed out after 20 s"', errBlank('timeout').reason);
  check(errBlank('timeout', null, { budgetMs: 30000 }).reason === 'timed out after 30 s', 'timeout uses the step budget when the reader reports it');
  check(errBlank('offline').reason === "you're offline" && errBlank('offline').state === 'error', 'offline -> "you\'re offline"', errBlank('offline').reason);
  check(errBlank('crashed').reason === 'the reader page crashed', 'crashed -> "the reader page crashed"', errBlank('crashed').reason);
  check(errBlank('http', null, { status: 503 }).reason === "Prime Video didn't load (HTTP 503)", 'http 503 -> "Prime Video didn\'t load (HTTP 503)"', errBlank('http', null, { status: 503 }).reason);
  check(errBlank('load-failed', { detail: 'ERR_NAME_NOT_RESOLVED' }).reason === "Prime Video didn't load (ERR_NAME_NOT_RESOLVED)", 'load-failed keeps the network detail', errBlank('load-failed', { detail: 'ERR_NAME_NOT_RESOLVED' }).reason);
  check(errBlank('bad-json').state === 'error' && /couldn't read/.test(errBlank('bad-json').reason), 'bad-json -> plain reason', errBlank('bad-json').reason);
  check(errBlank('weird-new-code').state === 'error' && errBlank('weird-new-code').reason.length > 0, 'an unknown error code still gives a reason', errBlank('weird-new-code').reason);
  const errSignin = run(readFrom(home, { ok: false, error: { code: 'timeout' }, finalUrl: 'https://www.amazon.com/ap/signin' }, { hydration: null }));
  check(errSignin.state === 'signed-out', 'a timeout that ended on the sign-in page is signed out, not a timeout', short(errSignin));

  /* ------------------------------------------------------- missing steps */
  const miss1 = run({ now: 1, steps: {} });
  const miss2 = run({ now: 1 });
  const miss3 = run({ now: 1, steps: { other: { ok: true } } });
  check(miss1.state === 'error' && miss1.reason === 'the reader returned nothing' && miss2.reason === 'the reader returned nothing' && miss3.reason === 'the reader returned nothing',
    'missing home step -> "the reader returned nothing"', short([miss1, miss2, miss3]));

  /* ------------------------------------------------------- junk never throws */
  const cyclic = { init: { preparations: { body: { containers: [] } } } };
  cyclic.init.self = cyclic;
  cyclic.init.preparations.body.containers.push({ containerType: 'StandardCarousel', title: 'Loop', entities: [cyclic] });
  let deep = {};
  const deepRoot = deep;
  for (let i = 0; i < 5000; i++) { deep.next = {}; deep = deep.next; }
  const hugeRow = { init: { preparations: { body: { containers: [{ containerType: 'StandardCarousel', title: 'Lots', entities: [] }] } } } };
  for (let i = 0; i < 5000; i++) {
    hugeRow.init.preparations.body.containers[0].entities.push({ titleID: 'B0LOTS' + String(i).padStart(4, '0'), title: 'Lots ' + i, link: { url: '/detail/0LOTS' + String(i).padStart(21, '0') } });
  }
  const junk = [
    ['null', null], ['undefined', undefined], ['42', 42], ['"x"', 'x'], ['[]', []], ['{steps:null}', { steps: null }],
    ['{steps:{home:"x"}}', { steps: { home: 'x' } }], ['{steps:{home:42}}', { steps: { home: 42 } }],
    ['extracted array', { steps: { home: { ok: true, extracted: [1, 2, 3] } } }],
    ['extracted number', { steps: { home: { ok: true, extracted: 42 } } }],
    ['hydration number', { steps: { home: { ok: true, extracted: { hydration: 42, store: 7 } } } }],
    ['hydration array', { steps: { home: { ok: true, extracted: { hydration: [1, [2]] } } } }],
    ['hydration "null"', { steps: { home: { ok: true, extracted: { hydration: 'null' } } } }],
    ['store junk', { steps: { home: { ok: true, extracted: { hydration: homeText, store: '{"RequestContext":' } } } }],
    ['store weird types', { steps: { home: { ok: true, extracted: { hydration: homeText, store: { RequestContext: { customerID: 5, identityContext: 42 } } } } } }],
    ['error junk', { steps: { home: { ok: false, error: 'boom', extracted: null } } }],
    ['finalUrl junk', { steps: { home: { ok: true, finalUrl: 42, title: {}, extracted: { hydration: homeText } } } }],
    ['captures junk', { steps: { home: { ok: true, captures: [null, 42, { json: 'x' }, { json: { containers: 5 } }], extracted: { hydration: homeText } } } }],
    ['cyclic object', { steps: { home: { ok: true, extracted: { hydration: cyclic } } } }],
    ['deep nesting', { steps: { home: { ok: true, extracted: { hydration: deepRoot } } } }],
    ['deep JSON text', { steps: { home: { ok: true, extracted: { hydration: '['.repeat(200000) + ']'.repeat(200000) } } } }],
    ['entities junk', { steps: { home: { ok: true, extracted: { hydration: { containers: [{ containerType: 'StandardCarousel', entities: [null, 1, 'x', [], { title: {}, link: 5, images: 'x', entitlementCues: 3 }] }] } } } } }]
  ];
  let allSafe = true;
  const bad = [];
  for (const [label, input] of junk) {
    let out;
    try {
      out = shape.cleanResult(adapter.parse(input, CTX));
      if (!out || ['ok', 'signed-out', 'error'].indexOf(out.state) === -1 || !Array.isArray(out.items)) { allSafe = false; bad.push(label + ': ' + short(out)); }
      if (out.state === 'error' && !out.reason) { allSafe = false; bad.push(label + ': error with no reason'); }
    } catch (err) {
      allSafe = false;
      bad.push(label + ' threw ' + err.message);
    }
  }
  check(allSafe, 'junk inputs never throw and always give a state (' + junk.length + ' cases)', bad.join(' | '));
  let noCtx = null;
  try { noCtx = shape.cleanResult(adapter.parse(readFrom(home))); } catch (err) { noCtx = { threw: err.message }; }
  check(noCtx && noCtx.state === 'ok', 'parse works without a ctx', short(noCtx && noCtx.state));
  const lots = run({ now: 1, steps: { home: { ok: true, extracted: { hydration: hugeRow, signedIn: true } } } });
  check(lots.state === 'ok' && lots.items.length === 25, 'a 5000-item row is capped at 25 rec items', lots.items.length);

  /* -------------------------------------------------- progress tolerance */
  const p = adapter._internals.progressOf;
  check(p({ progress: '37%' }) === 0.37, 'progress: "37%" string -> 0.37', p({ progress: '37%' }));
  check(p({ remainingTimeInSeconds: 600, runtimeSeconds: 2400 }) === 0.75, 'progress: remaining 600 of 2400 s -> 0.75', p({ remainingTimeInSeconds: 600, runtimeSeconds: 2400 }));
  check(p({ playback: { timecodeMs: 60000, durationMs: 120000 } }) === 0.5, 'progress: nested timecodeMs/durationMs -> 0.5', p({ playback: { timecodeMs: 60000, durationMs: 120000 } }));
  check(p({ offer: { percentage: 30 } }) === null, 'progress: a percentage outside a progress object (an offer discount) is ignored', p({ offer: { percentage: 30 } }));
  check(p({}) === null && p({ runtime: '1 h 42 min' }) === null, 'progress: nothing to go on -> null');
};
