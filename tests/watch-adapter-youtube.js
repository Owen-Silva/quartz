'use strict';
/*
 * tests/watch-adapter-youtube.js -- fixture tests for watch/adapters/youtube.js.
 * Pure node; required by tests/watch-harness.js:
 *   module.exports = async function (check) { ... }   check(cond, label, detail)
 */
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var yt = require('../watch/adapters/youtube');
var shape = require('../watch/shape');

var FX = path.join(__dirname, 'watch-fixtures');
function fx(name) { return JSON.parse(fs.readFileSync(path.join(FX, name), 'utf8')); }

var URLS = {
  home: 'https://www.youtube.com/',
  history: 'https://www.youtube.com/feed/history',
  watchlater: 'https://www.youtube.com/playlist?list=WL'
};
var CTX = { now: Date.parse('2026-10-17T01:30:00Z'), tz: 'America/Los_Angeles', leagues: ['nhl'] };

function viewStep(f, name, over) {
  var s = { ok: true, url: URLS[name], finalUrl: URLS[name], title: 'YouTube', status: 200,
    extracted: { data: f.ytInitialData, loggedIn: f.loggedIn, url: URLS[name] }, json: null, text: null, captures: [], error: null };
  for (var k in (over || {})) s[k] = over[k];
  return s;
}
function errStep(name, code, detail, status) {
  return { ok: false, url: URLS[name], finalUrl: '', title: '', status: status || 0, extracted: null, json: null, text: null, captures: [],
    error: { code: code, detail: detail || '' } };
}
function fullRead() {
  return { now: CTX.now, steps: {
    home: viewStep(fx('youtube-home.json'), 'home'),
    history: viewStep(fx('youtube-history.json'), 'history'),
    watchlater: viewStep(fx('youtube-watchlater.json'), 'watchlater')
  } };
}
function of(r, kind) { return r.items.filter(function (i) { return i.kind === kind; }); }
function vids(list) { return list.map(function (i) { return i.id.replace(/^youtube:/, ''); }); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function byId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === 'youtube:' + id) return list[i]; return null; }

module.exports = async function (check) {
  // ------------------------------------------------------------ fixtures
  ['youtube-home.json', 'youtube-history.json', 'youtube-watchlater.json', 'youtube-signedout.json', 'youtube-empty.json'].forEach(function (n) {
    var j = fx(n);
    check(typeof j._fixture === 'string' && j._fixture.indexOf('shape from ') === 0 && /unverified against a live account/.test(j._fixture) &&
      typeof j.loggedIn === 'boolean' && j.ytInitialData && typeof j.ytInitialData === 'object', 'yt fixture ' + n + ' has _fixture, loggedIn, ytInitialData');
  });
  var html = fs.readFileSync(path.join(FX, 'youtube-search.html'), 'utf8');
  check(/_fixture: shape from .*unverified against a live account/.test(html), 'yt fixture youtube-search.html has a _fixture note');

  // ------------------------------------------------------------ steps + extract
  var st = yt.steps(CTX);
  check(yt.id === 'youtube', 'yt: adapter id');
  check(same(st.map(function (s) { return s.name + ' ' + s.type + ' ' + s.url; }), [
    'home view https://www.youtube.com/', 'history view https://www.youtube.com/feed/history', 'watchlater view https://www.youtube.com/playlist?list=WL'
  ]), 'yt steps: home, history, watchlater views');
  check(!st[0].optional && !st[1].optional && st[2].optional === true, 'yt steps: only watchlater is optional');
  check(st.every(function (s) { return typeof s.extract === 'string' && typeof s.ready === 'function'; }), 'yt steps: extract string + ready fn');

  // Run the extract expression against fake page globals.
  function runExtract(globals) {
    var sandbox = Object.assign({ JSON: JSON, String: String }, globals);
    return vm.runInNewContext(st[0].extract, sandbox);
  }
  var homeFx = fx('youtube-home.json');
  var ex1 = runExtract({ window: { ytInitialData: homeFx.ytInitialData, ytcfg: { get: function (k) { return k === 'LOGGED_IN' ? true : undefined; } } },
    location: { href: 'https://www.youtube.com/' }, document: { title: 'YouTube' } });
  check(ex1.loggedIn === true && ex1.url === 'https://www.youtube.com/' && ex1.data && ex1.data.contents, 'yt extract: reads ytInitialData + ytcfg LOGGED_IN');
  var ex2 = runExtract({ window: { ytcfg: { data_: { LOGGED_IN: false } } }, location: { href: 'https://www.youtube.com/' }, document: {} });
  check(ex2.loggedIn === false && ex2.data === null, 'yt extract: ytcfg.data_ fallback, no data');
  var ex3 = runExtract({ window: { get ytInitialData() { throw new Error('boom'); }, ytcfg: { get: function () { throw new Error('nope'); } } } });
  check(ex3 && ex3.data === null && ex3.loggedIn === null && ex3.url === '', 'yt extract: never throws even when every global does');
  check(st[0].ready(ex1) === true && st[0].ready(ex2) === true, 'yt ready: data present or signed out');
  check(st[0].ready({ data: null, loggedIn: null, url: 'https://www.youtube.com/' }) === false, 'yt ready: keeps waiting for ytInitialData');
  check(st[0].ready({ data: null, loggedIn: null, url: 'https://accounts.google.com/v3/signin' }) === true, 'yt ready: a redirect off YouTube ends the wait');
  check(st[0].ready(null) === false, 'yt ready: null is not ready');

  // ------------------------------------------------------------ full parse
  var r = yt.parse(fullRead(), CTX);
  check(r.state === 'ok' && r.reason === '' && r.profile === '', 'yt full: state ok', r.reason);
  check(same(r.warnings, []), 'yt full: no warnings', r.warnings);

  // home -> rec
  var rec = of(r, 'rec');
  check(same(vids(rec), ['hmOldVid001', 'hmLockup002', 'hmLiveNow03', 'hmShorts004', 'hmShorts005', 'hmTrend0006', 'hmTrend0007',
    'hmPlain0008', 'hmGrid00009', 'hmCompact10']), 'yt home: 10 recs in page order (old + lockup + shorts + grid + compact)', vids(rec));
  check(!byId(rec, 'adVideo0001'), 'yt home: the ad slot is skipped');
  check(!rec.some(function (i) { return /PLbakingMix/.test(i.id); }), 'yt home: playlist lockup skipped');
  check(rec.filter(function (i) { return i.id === 'youtube:hmOldVid001'; }).length === 1, 'yt home: the mix (radioRenderer) adds no duplicate');
  check(r.counts.adsSkipped >= 1, 'yt counts: ads skipped counted', r.counts.adsSkipped);
  var a = byId(rec, 'hmOldVid001');
  check(a.title === 'How Pro Chefs Read a Recipe Card' && a.subtitle === 'Recipe Breakdown · 412K views · 2 weeks ago', 'yt old videoRenderer: title + subtitle', a.subtitle);
  check(a.url === 'https://www.youtube.com/watch?v=hmOldVid001&t=240s' && a.progress === 0.4 && a.durationSec === 600, 'yt old videoRenderer: 40% of 10:00 -> &t=240s', a.url);
  check(a.image === 'https://i.ytimg.com/vi/hmOldVid001/hq720.jpg?sqp=-oaymwEXCNAFEJQDSFryq4qpAwkIARUAAIhCGAE=&rs=AOn4CLC3', 'yt thumb: the 480-wide one wins', a.image);
  check(a.service === 'youtube' && a.edge === false && a.group === '' && a.badge === '', 'yt item: service, plays in Quartz, no group/badge');
  var b = byId(rec, 'hmLockup002');
  check(b.title === 'Total Eclipse Highlights: Iceland, Spain' && b.subtitle === 'ESA · 1.2M views · 3 days ago', 'yt lockup: title + metadata rows', b.subtitle);
  check(b.progress === 0.25 && b.durationSec === 3723 && b.url === 'https://www.youtube.com/watch?v=hmLockup002&t=930s', 'yt lockup: startPercent 25 of 1:02:03 -> &t=930s', b.url);
  check(b.image === 'https://i.ytimg.com/vi/hmLockup002/hqdefault.jpg?sqp=a1', 'yt lockup: 360 beats 720 for ~480 (avatar not used)', b.image);
  var live = byId(rec, 'hmLiveNow03');
  check(live.badge === 'Live' && live.durationSec === null && live.progress === null && live.url === 'https://www.youtube.com/watch?v=hmLiveNow03', 'yt lockup live: Live badge, no length');
  var s4 = byId(rec, 'hmShorts004');
  check(s4.url === 'https://www.youtube.com/shorts/hmShorts004' && s4.title === 'Knife grip basics' && s4.subtitle === '88K views' && s4.group === 'Shorts', 'yt shortsLockupViewModel -> /shorts/ url, shelf group', s4.url);
  var s5 = byId(rec, 'hmShorts005');
  check(s5.url === 'https://www.youtube.com/shorts/hmShorts005' && s5.title === 'Herbs from the plot', 'yt reelItemRenderer -> /shorts/ url');
  var t6 = byId(rec, 'hmTrend0006');
  check(t6.badge === 'Live' && t6.group === 'Trending in Baking' && t6.title === 'Pastry Contest LIVE', 'yt videoRenderer live badge + shelf title as group');
  var t7 = byId(rec, 'hmTrend0007');
  check(t7.progress === 1 && t7.url === 'https://www.youtube.com/watch?v=hmTrend0007' && t7.durationSec === 899, 'yt finished rec: progress 1, no &t');
  var g9 = byId(rec, 'hmGrid00009');
  check(g9.image === 'https://i.ytimg.com/vi/hmGrid00009/hqdefault.jpg' && g9.durationSec === 465 && g9.group === 'From your subscriptions', 'yt gridVideoRenderer: width-less thumb, length from overlay');
  var c10 = byId(rec, 'hmCompact10');
  check(c10.image === 'https://i.ytimg.com/vi/hmCompact10/hqdefault.jpg', 'yt compactVideoRenderer: http thumb refused, //-relative made https', c10.image);
  check(c10.group === 'Recommended for you' && c10.durationSec === 3723, 'yt compactVideoRenderer: group + length');

  // history -> resume
  var res = of(r, 'resume');
  check(same(vids(res), ['hiLockupB02', 'hiVideoC003', 'hiVideoD005', 'hiLockF0007', 'hiLockH0009', 'hiVideoI010']), 'yt history: 6 resume rows, newest first', vids(res));
  check(!byId(res, 'hiNearDone1'), 'yt history: 98% watched is skipped');
  check(!byId(res, 'hiLockE0006'), 'yt history: 100% watched is skipped');
  check(!byId(res, 'hiPlainG008'), 'yt history: no progress overlay -> not a resume row');
  check(!byId(res, 'hiShortS004'), 'yt history: Shorts are not resume rows');
  check(byId(res, 'hiLockupB02').url === 'https://www.youtube.com/watch?v=hiLockupB02&t=185s', 'yt resume: 37% of 8:20 -> &t=185s', byId(res, 'hiLockupB02').url);
  check(byId(res, 'hiVideoC003').url === 'https://www.youtube.com/watch?v=hiVideoC003&t=744s', 'yt resume: 62% of 20:00 -> &t=744s');
  check(byId(res, 'hiVideoD005').url === 'https://www.youtube.com/watch?v=hiVideoD005&t=180s' && byId(res, 'hiVideoD005').progress === 0.05, 'yt resume: 5% of 1:00:00 -> &t=180s');
  check(byId(res, 'hiLockF0007').url === 'https://www.youtube.com/watch?v=hiLockF0007&t=202s', 'yt resume: 80% of 4:13 -> &t=202s (floored)');
  var h = byId(res, 'hiLockH0009');
  check(h.progress === 0.5 && h.url === 'https://www.youtube.com/watch?v=hiLockH0009' && h.durationSec === null, 'yt resume: unknown length -> no &t, resume overlay inside a lockup still read');
  check(byId(res, 'hiVideoI010').progress === 0.94 && byId(res, 'hiVideoI010').url === 'https://www.youtube.com/watch?v=hiVideoI010&t=564s', 'yt resume: 94% kept (< 95%)');
  check(res[0].group === 'Today' && res[2].group === 'Yesterday' && res[5].group === 'Earlier this week', 'yt resume: day headers become groups');

  // watch later -> watchlist
  var wl = of(r, 'watchlist');
  check(same(vids(wl), ['wlVideo0001', 'wlVideo0002', 'wlVideo0004', 'wlLockup005', 'wlLockup006', 'wlVideo0007']), 'yt watch later: 6 rows, deleted skipped, sidebar not counted', vids(wl));
  check(wl[0].url === 'https://www.youtube.com/watch?v=wlVideo0001&t=180s' && wl[0].durationSec === 600, 'yt watch later: lengthSeconds + 30% -> &t=180s', wl[0].url);
  check(wl[0].subtitle === 'ESA · 1.2M views · 3 years ago', 'yt watch later: videoInfo bullet normalised', wl[0].subtitle);
  check(wl[1].durationSec === 225 && wl[1].progress === null, 'yt watch later: lengthText 3:45');
  check(wl[4].url === 'https://www.youtube.com/watch?v=wlLockup006&t=180s', 'yt watch later lockup: 60% of 5:00 -> &t=180s');
  check(r.counts.rec === 10 && r.counts.resume === 6 && r.counts.watchlist === 6, 'yt counts per kind', r.counts);

  // everything is already clean
  var cleaned = shape.cleanResult(r);
  check(cleaned.items.length === r.items.length && same(cleaned.items, r.items), 'yt full: items are already in cleanItem shape');

  // ------------------------------------------------------------ signed out
  var so = fx('youtube-signedout.json');
  var r1 = yt.parse({ now: 1, steps: { home: viewStep(so, 'home'), history: viewStep(so, 'history') } }, CTX);
  check(r1.state === 'signed-out' && r1.reason === 'sign in to YouTube in Quartz to see your rows' && r1.items.length === 0, 'yt signed out: loggedIn false', r1.reason);
  var rd = fullRead();
  rd.steps.history = viewStep(fx('youtube-history.json'), 'history', { finalUrl: 'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fwww.youtube.com%2Ffeed%2Fhistory' });
  rd.steps.history.extracted = { data: null, loggedIn: null, url: rd.steps.history.finalUrl };
  check(yt.parse(rd, CTX).state === 'signed-out', 'yt signed out: history redirected to accounts.google.com');
  var soNoFlag = viewStep(so, 'home');
  soNoFlag.extracted.loggedIn = null;
  check(yt.parse({ steps: { home: soNoFlag } }, CTX).state === 'signed-out', 'yt signed out: no ytcfg flag, but the topbar Sign in button');
  rd = fullRead();
  rd.steps.home = viewStep(so, 'home');
  check(yt.parse(rd, CTX).state === 'signed-out', 'yt signed out: home logged out beats history data (recs are not the user\'s)');
  rd = fullRead();
  rd.steps.history.error = { code: 'timeout', detail: '' };
  rd.steps.history.extracted = { data: null, loggedIn: false, url: URLS.history };
  check(yt.parse(rd, CTX).state === 'signed-out', 'yt signed out: loggedIn false wins over a timeout');

  // ------------------------------------------------------------ layout changed / empty
  var em = fx('youtube-empty.json');
  var r2 = yt.parse({ now: 1, steps: { home: viewStep(em, 'home'), history: viewStep(em, 'history') } }, CTX);
  check(r2.state === 'error' && /changed its layout\?\)$/.test(r2.reason) && r2.reason === 'the page loaded but no videos matched (YouTube changed its layout?)',
    'yt empty: no videos anywhere -> "changed its layout?"', r2.reason);
  rd = fullRead();
  rd.steps.history = viewStep(em, 'history');
  var r3 = yt.parse(rd, CTX);
  check(r3.state === 'ok' && of(r3, 'resume').length === 0 && of(r3, 'rec').length === 10, 'yt: history layout change alone keeps home rows');
  check(r3.warnings.some(function (w) { return w === 'Continue watching: the page loaded but no Continue watching data matched (YouTube changed its layout?)'; }),
    'yt: history layout change is a named warning', r3.warnings);
  var noData = viewStep(em, 'home');
  noData.extracted.data = null;
  var r4 = yt.parse({ steps: { home: noData, history: noData } }, CTX);
  check(r4.state === 'error' && r4.reason === 'the page loaded but had no ytInitialData (YouTube changed its layout?)', 'yt: no ytInitialData -> layout reason', r4.reason);
  var nudge = { loggedIn: true, ytInitialData: { contents: { richGridRenderer: { contents: [{ richSectionRenderer: { content: { feedNudgeRenderer: { title: { simpleText: 'Your watch history is off' } } } } }] } } } };
  var r5 = yt.parse({ steps: { home: viewStep(nudge, 'home'), history: viewStep(nudge, 'history') } }, CTX);
  check(r5.state === 'ok' && r5.items.length === 0 && r5.warnings.length === 1, 'yt: "watch history is off" nudge is ok + a warning, not a layout error', r5);

  // ------------------------------------------------------------ missing steps + error codes
  check(yt.parse({ steps: {} }, CTX).reason === "the reader didn't open any YouTube page", 'yt: no steps at all');
  rd = fullRead();
  delete rd.steps.history;
  var r6 = yt.parse(rd, CTX);
  check(r6.state === 'ok' && of(r6, 'resume').length === 0 && r6.warnings.indexOf('Continue watching: not read') !== -1, 'yt: missing history step -> ok + warning', r6.warnings);
  rd = fullRead();
  delete rd.steps.watchlater;
  var r7 = yt.parse(rd, CTX);
  check(r7.state === 'ok' && of(r7, 'watchlist').length === 0 && same(r7.warnings, []), 'yt: missing optional watchlater is quiet');
  rd = fullRead();
  rd.steps.watchlater = errStep('watchlater', 'timeout');
  check(yt.parse(rd, CTX).warnings[0] === 'Watch Later: timed out after 20 s', 'yt: watchlater timeout -> warning only');
  function both(code, detail, status) {
    return yt.parse({ steps: { home: errStep('home', code, detail, status), history: errStep('history', code, detail, status) } }, CTX);
  }
  check(both('timeout').reason === 'timed out after 20 s' && both('timeout').state === 'error', 'yt: timeout reason');
  check(both('offline').reason === "you're offline", 'yt: offline reason');
  check(both('http', '', 503).reason === 'YouTube answered with an error (HTTP 503)', 'yt: http reason with status', both('http', '', 503).reason);
  check(both('load-failed', 'ERR_NAME_NOT_RESOLVED').reason === "the page didn't load (ERR_NAME_NOT_RESOLVED)", 'yt: load-failed reason');
  check(both('crashed').reason === 'the hidden reader page crashed', 'yt: crashed reason');
  check(both('bad-json').reason === "YouTube sent data the reader couldn't parse", 'yt: bad-json reason');
  var mixed = yt.parse({ steps: { home: errStep('home', 'timeout'), history: errStep('history', 'offline') } }, CTX);
  check(mixed.state === 'error' && mixed.reason === 'timed out after 20 s', 'yt: mixed failures report the home reason', mixed.reason);
  rd = fullRead();
  rd.steps.home = errStep('home', 'timeout');
  var r8 = yt.parse(rd, CTX);
  check(r8.state === 'ok' && of(r8, 'rec').length === 0 && of(r8, 'resume').length === 6 && r8.warnings[0] === 'Recommended: timed out after 20 s', 'yt: home timeout, history ok -> ok with a warning', r8.warnings);
  rd = fullRead();
  rd.steps.home.finalUrl = 'https://www.google.com/sorry/index?continue=https://www.youtube.com/';
  check(yt.parse(rd, CTX).reason === 'blocked by a captcha', 'yt: google.com/sorry -> captcha');
  check(shape.cleanResult(both('timeout')).reason === 'timed out after 20 s', 'yt: error reason survives cleanResult');

  // ------------------------------------------------------------ junk never throws
  var junk = [undefined, null, 0, 'x', [], {}, { steps: null }, { steps: [] }, { steps: 'home' },
    { steps: { home: 1, history: 'x', watchlater: [] } },
    { steps: { home: { ok: true, extracted: 'nope' }, history: { ok: true, extracted: [] } } },
    { steps: { home: { ok: true, extracted: { data: { contents: [null, 1, { videoRenderer: null }, { videoRenderer: { videoId: 5 } }, { lockupViewModel: { contentId: {}, metadata: 7 } },
      { videoRenderer: { videoId: 'abcdefghijk', title: { simpleText: 'Half broken', runs: 'x' }, thumbnail: { thumbnails: [null, { url: 5 }, { url: 'javascript:alert(1)' }] }, thumbnailOverlays: 'x' } }] }, loggedIn: true } } } },
    { steps: { home: { ok: true, extracted: { data: deep(3000), loggedIn: true } } } }];
  var threw = 0;
  var shaped = true;
  junk.forEach(function (j) {
    try {
      var out = yt.parse(j, CTX);
      if (!out || ['ok', 'error', 'signed-out'].indexOf(out.state) === -1 || !Array.isArray(out.items)) shaped = false;
    } catch (err) { threw++; }
  });
  check(threw === 0, 'yt: junk inputs never throw', threw);
  check(shaped, 'yt: junk inputs always give a state and items');
  var weird = yt.parse(junk[11], CTX);
  check(weird.state === 'ok' && weird.items.length === 1 && weird.items[0].image === 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' && weird.items[0].title === 'Half broken',
    'yt: a half-broken renderer keeps what is usable (thumb falls back to hqdefault)', weird.items);
  var cyc = { loggedIn: true, ytInitialData: { contents: [] } };
  cyc.ytInitialData.self = cyc.ytInitialData;
  cyc.ytInitialData.contents.push({ videoRenderer: { videoId: 'cycCycCyc01', title: { simpleText: 'Cyclic' } } });
  var cr;
  try { cr = yt.parse({ steps: { home: viewStep(cyc, 'home') } }, CTX); } catch (err) { cr = null; }
  check(cr && cr.state === 'ok' && cr.items.length >= 1, 'yt: a cyclic tree does not hang or throw');
  var huge = { loggedIn: true, ytInitialData: { contents: [] } };
  for (var i = 0; i < 3000; i++) huge.ytInitialData.contents.push({ richItemRenderer: { content: { videoRenderer: { videoId: ('v' + (1000000000 + i)).slice(0, 11), title: { simpleText: 'Video ' + i } } } } });
  var hr = yt.parse({ steps: { home: viewStep(huge, 'home') } }, CTX);
  check(hr.state === 'ok' && of(hr, 'rec').length === 80, 'yt: a huge feed is capped at 80 recs', of(hr, 'rec').length);

  // ------------------------------------------------------------ search
  check(yt.searchUrl('baking basics') === 'https://www.youtube.com/results?search_query=baking+basics', 'yt searchUrl: spaces as +', yt.searchUrl('baking basics'));
  check(yt.searchUrl('a&b=c/#?') === 'https://www.youtube.com/results?search_query=a%26b%3Dc%2F%23%3F', 'yt searchUrl: query encoded', yt.searchUrl('a&b=c/#?'));
  check(yt.searchUrl(null) === 'https://www.youtube.com/results?search_query=', 'yt searchUrl: null does not throw');
  var sr = yt.parseSearch(html);
  check(same(vids(sr), ['srVideo0001', 'srVideo0002', 'srShelf0006', 'srShelf0007', 'srShort0008', 'srShort0009', 'srVideo0003', 'srLockup010',
    'srNavShrt12', 'srLockup011', 'srVideo0004', 'srVideo0005']), 'yt search: 12 results past the decoy scripts', vids(sr));
  check(sr.every(function (i) { return i.kind === 'search'; }), 'yt search: kind search');
  check(sr[0].title === 'Fixing {braces} in JSON }; a planet stats tutorial', 'yt search: braces and "};" inside a title survive', sr[0].title);
  check(sr[11].title === 'Why </script> tags break "naive" parsers', 'yt search: \\u003c-escaped </script> in a title', sr[11].title);
  check(!sr.some(function (i) { return /srAdVideo99|srPromo0098|decoyPlayer/.test(i.id); }), 'yt search: ads, promoted and player-response decoys skipped');
  check(byId(sr, 'srShort0008').url === 'https://www.youtube.com/shorts/srShort0008' && byId(sr, 'srNavShrt12').url === 'https://www.youtube.com/shorts/srNavShrt12',
    'yt search: Shorts (lockup and /shorts/ navigation) get /shorts/ urls');
  check(byId(sr, 'srVideo0004').badge === 'Live', 'yt search: live badge');
  check(byId(sr, 'srShelf0006').group === 'Latest from Space Science', 'yt search: shelf title kept as group');
  var many = { contents: [] };
  for (var k = 0; k < 30; k++) many.contents.push({ videoRenderer: { videoId: ('s' + (1000000000 + k)).slice(0, 11), title: { simpleText: 'Result ' + k } } });
  var big = yt.parseSearch('<script>var ytInitialData = ' + JSON.stringify(many) + ';</script>');
  check(big.length === 20 && big[0].title === 'Result 0', 'yt search: capped at 20', big.length);
  var hexed = JSON.stringify({ contents: [{ videoRenderer: { videoId: 'hexHexHex01', title: { simpleText: 'Hex form' } } }] })
    .replace(/[{}"]/g, function (c) { return '\\x' + c.charCodeAt(0).toString(16); });
  var hx = yt.parseSearch("<script>var ytInitialData = '" + hexed + "';</script>");
  check(hx.length === 1 && hx[0].title === 'Hex form', 'yt search: hex-escaped string form', hx);
  var winForm = yt.parseSearch('<script>window["ytInitialData"] = ' + JSON.stringify(many) + ';</script>');
  check(winForm.length === 20, 'yt search: window["ytInitialData"] form');
  var sThrew = 0;
  [undefined, null, 5, '', '<html></html>', 'var ytInitialData = {', 'var ytInitialData = {"a":', "var ytInitialData = '\\x7b", 'var ytInitialData = ' + '{'.repeat(5000), { html: 1 }]
    .forEach(function (j) { try { var o = yt.parseSearch(j); if (!Array.isArray(o) || o.length) sThrew++; } catch (err) { sThrew++; } });
  check(sThrew === 0, 'yt parseSearch: junk -> [] and never throws', sThrew);
};

function deep(n) {
  var root = {};
  var cur = root;
  for (var i = 0; i < n; i++) { cur.next = { videoRenderer: i % 2 ? null : undefined }; cur = cur.next; }
  return root;
}
