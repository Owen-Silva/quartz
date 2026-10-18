'use strict';
/*
 * tests/watch-adapter-youtube-library.js -- fixture tests for YouTube past the home row:
 * watch/ytlib.js (Subscriptions, a channel's Videos tab, the Library, a playlist, the "new since
 * you last opened Lumen" marks, the page's request lines), watch/ytlib-main.js (its queue, cache,
 * file and lock) and its hooks in watch-main.js (one hidden reader at a time, the feed after a
 * YouTube read, Forget). Pure node with fakes; never a real YouTube page.
 * Required by watch-harness.js: module.exports = async function (check) { ... }
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var L = require('../watch/ytlib');
var YM = require('../watch/ytlib-main');
var Shape = require('../watch/shape');

var FX = path.join(__dirname, 'watch-fixtures');
function fx(name) { return JSON.parse(fs.readFileSync(path.join(FX, name), 'utf8')); }
function step(f, url, over) {
  var s = { ok: true, url: url, finalUrl: url, title: 'YouTube', status: 200,
    extracted: { data: f.ytInitialData, loggedIn: f.loggedIn, url: url }, json: null, text: null, captures: [], error: null };
  for (var k in (over || {})) s[k] = over[k];
  return s;
}
function errStep(url, code, detail) {
  return { ok: false, url: url, finalUrl: '', title: '', status: 0, extracted: null, json: null, text: null, captures: [], error: { code: code, detail: detail || code } };
}
var tick = function () { return new Promise(function (r) { setImmediate(r); }); };
async function settle(n) { for (var i = 0; i < (n || 30); i++) await tick(); }

module.exports = async function (check) {
  /* ---------------------------------------------------------------- Subscriptions */
  var subs = L.parseSubs({ steps: { subs: step(fx('youtube-subs.json'), L.SUBS_URL) } });
  check(subs.state === 'ok' && subs.items.length === 10, 'subs: the fixture gives 10 videos (both renderer generations)', { state: subs.state, n: subs.items.length, reason: subs.reason });
  check(subs.shortsHidden === 2 && !subs.items.some(function (it) { return /\/shorts\//.test(it.url) || it.vid === 'sbShort0001'; }), 'subs: the Shorts shelf is left out and counted (2)', subs.shortsHidden);
  check(!subs.items.some(function (it) { return it.vid === 'adVideo0001'; }), 'subs: the ad slot is skipped');
  check(subs.items[0].vid === 'sbLiveNow01' && subs.items[0].live && subs.items[0].age === 'Live now', 'subs: newest first, the live stream on top', subs.items[0] && { vid: subs.items[0].vid, age: subs.items[0].age });
  check(subs.items[subs.items.length - 1].vid === 'sbPremier08' && subs.items[subs.items.length - 1].upcoming, 'subs: the upcoming premiere goes last (it cannot play yet)', subs.items.map(function (i) { return i.vid; }));
  var order = subs.items.filter(function (i) { return !i.live && !i.upcoming; }).map(function (i) { return i.ageSec; });
  check(order.every(function (a, i) { return i === 0 || a >= order[i - 1]; }), 'subs: ages ascend (2 hours ago ... 2 weeks ago)', order);
  var b = subs.items.find(function (i) { return i.vid === 'sbVideo0002'; });
  check(b && b.title === 'Knife Skills Demo, Frame by Frame' && b.subtitle === 'Recipe Breakdown · 2 hours ago' && b.durationSec === 872, 'subs: a videoRenderer tile: title, "Channel · age", duration', b && { t: b.title, s: b.subtitle, d: b.durationSec });
  check(b && b.channel.path === '/@recipebreakdown' && /^https:\/\/yt3\.ggpht\.com\/.*=s88-/.test(b.channel.avatar) && b.channel.name === 'Recipe Breakdown', 'subs: its channel: link, the 88 px avatar, name', b && b.channel);
  var lk = subs.items.find(function (i) { return i.vid === 'sbVideo0003'; });
  check(lk && lk.subtitle === 'Pro Shop Joinery · 5 hours ago' && lk.channel.path === '/@proshopjoinery' && /pshAvatar03=s88/.test(lk.channel.avatar) && lk.durationSec === 1085, 'subs: a lockupViewModel tile: channel row, age, avatar, link, length', lk && { s: lk.subtitle, ch: lk.channel, d: lk.durationSec });
  check(lk && /&t=325s$/.test(lk.url) && Math.abs(lk.progress - 0.3) < 1e-9, 'subs: a part-watched lockup resumes at &t= (30 % of 18:05)', lk && lk.url);
  var gr = subs.items.find(function (i) { return i.vid === 'sbVideo0004'; });
  check(gr && /&t=424s$/.test(gr.url), 'subs: a part-watched videoRenderer resumes at &t= (60 % of 11:47)', gr && gr.url);
  check(subs.items.every(function (it) { return it.service === 'youtube' && it.yt === true && /^https:\/\/www\.youtube\.com\/watch\?v=/.test(it.url) && Array.isArray(it.also) && Shape.cleanItem(it); }), 'subs: every tile is a clean YouTube item that plays on youtube.com/watch');
  check(subs.items.every(function (it) { return /^https:\/\/i\.ytimg\.com\//.test(it.image); }), 'subs: every still is on i.ytimg.com');

  var so = L.parseSubs({ steps: { subs: step(fx('youtube-subs-signedout.json'), L.SUBS_URL) } });
  check(so.state === 'signed-out' && so.items.length === 0, 'subs: signed out (the sign-in promo, LOGGED_IN false)', so);
  var acct = L.parseSubs({ steps: { subs: step(fx('youtube-subs.json'), L.SUBS_URL, { finalUrl: 'https://accounts.google.com/ServiceLogin?continue=x' }) } });
  check(acct.state === 'signed-out', 'subs: landing on accounts.google.com is signed out', acct.state);
  var em = L.parseSubs({ steps: { subs: step(fx('youtube-subs-empty.json'), L.SUBS_URL) } });
  check(em.state === 'ok' && em.items.length === 0 && em.empty === true, 'subs: subscribed to nothing is an empty feed, not an error', em);
  var ch1 = L.parseSubs({ steps: { subs: step({ loggedIn: true, ytInitialData: { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: { somethingNewRenderer: {} } } }] } } } }, L.SUBS_URL) } });
  check(ch1.state === 'error' && /changed its layout/.test(ch1.reason), 'subs: a page with none of the known renderers says the layout changed', ch1.reason);
  var to = L.parseSubs({ steps: { subs: errStep(L.SUBS_URL, 'timeout') } });
  check(to.state === 'error' && /timed out after 20 s/.test(to.reason), 'subs: a timed-out read says so', to.reason);
  var off = L.parseSubs({ steps: { subs: errStep(L.SUBS_URL, 'offline') } });
  check(off.state === 'error' && /offline/.test(off.reason), "subs: offline says you're offline", off.reason);
  var cap = L.parseSubs({ steps: { subs: step(fx('youtube-subs.json'), L.SUBS_URL, { finalUrl: 'https://www.google.com/sorry/index?continue=x' }) } });
  check(cap.state === 'error' && /captcha/.test(cap.reason), 'subs: the /sorry captcha is an error with the reason', cap.reason);
  var nod = L.parseSubs({ steps: { subs: step({ loggedIn: true, ytInitialData: null }, L.SUBS_URL) } });
  check(nod.state === 'error' && /ytInitialData/.test(nod.reason), 'subs: no ytInitialData says so', nod.reason);
  var miss = L.parseSubs({ steps: {} });
  check(miss.state === 'error' && /didn't open/.test(miss.reason), 'subs: no step at all says the page was not opened', miss.reason);
  var junk = [null, 5, 'x', { steps: null }, { steps: { subs: { extracted: { data: { a: [1, { videoRenderer: { videoId: 7 } }] } } } } }];
  check(junk.every(function (j) { var r = L.parseSubs(j); return r && typeof r.state === 'string' && Array.isArray(r.items); }), 'subs: garbage input never throws');
  var next = L.parseSubs({ steps: { subs: step(fx('youtube-subs-next.json'), L.SUBS_URL) } });
  check(next.state === 'ok' && next.items[0].vid === 'sbNewVid011' && next.items[1].vid === 'sbNewVid012', 'subs: the later read has the two new uploads on top', next.items.slice(0, 3).map(function (i) { return i.vid; }));

  /* ---------------------------------------------------------------- a channel */
  var chUrl = L.channelVideosUrl('/@guitarcoachryan');
  check(chUrl === 'https://www.youtube.com/@guitarcoachryan/videos', 'channel: reads the Videos tab', chUrl);
  var ch = L.parseChannel({ steps: { channel: step(fx('youtube-channel.json'), chUrl) } }, '/@guitarcoachryan');
  check(ch.state === 'ok' && ch.items.length === 6 && ch.tab === 'Videos', 'channel: 6 videos from the selected Videos tab', { state: ch.state, n: ch.items.length, tab: ch.tab, reason: ch.reason });
  check(ch.channel && ch.channel.name === 'Guitar Coach Ryan' && ch.channel.handle === '@guitarcoachryan' && ch.channel.subscribers === '84.2K subscribers' && ch.channel.videos === '312 videos', 'channel: the header: name, handle, subscribers, videos', ch.channel);
  check(ch.channel && /gcrAvatar04=s88/.test(ch.channel.avatar) && /^https:\/\/yt3\.googleusercontent\.com\//.test(ch.channel.banner) && ch.channel.id === 'UCguitarCoachRyanChan004' && ch.channel.path === '/@guitarcoachryan', 'channel: avatar (the header\'s sizes, not the 900 px one), banner, id, link', ch.channel);
  check(ch.items.every(function (it) { return it.channel.name === 'Guitar Coach Ryan' && it.channel.path === '/@guitarcoachryan'; }), 'channel: every tile is the channel\'s (its tab has no byline)');
  check(ch.items[0].subtitle === '9 hours ago · 6K views' && ch.items[1].subtitle === '4 days ago · 15K views', 'channel: a tile says its age and views (the channel is in the header)', ch.items.slice(0, 2).map(function (i) { return i.subtitle; }));
  var c4 = L.parseChannel({ steps: { channel: step({ loggedIn: false, ytInitialData: {
    header: { c4TabbedHeaderRenderer: { channelId: 'UCa1b2c3d4e5f6g7h8i9j0kl', title: 'Recipe Breakdown', avatar: { thumbnails: [{ url: 'https://yt3.ggpht.com/hb=s88', width: 88, height: 88 }] }, subscriberCountText: { simpleText: '201K subscribers' }, channelHandleText: { runs: [{ text: '@recipebreakdown' }] } } },
    contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { title: 'Videos', selected: true, content: { richGridRenderer: { contents: [{ richItemRenderer: { content: { videoRenderer: { videoId: 'c4Video0001', title: { runs: [{ text: 'Old header, still read' }] }, publishedTimeText: { simpleText: '1 day ago' }, lengthText: { simpleText: '5:00' } } } } }] } } } }] } }
  } }, chUrl) } }, '/@recipebreakdown');
  check(c4.state === 'ok' && c4.channel.name === 'Recipe Breakdown' && c4.channel.subscribers === '201K subscribers' && c4.items.length === 1 && c4.items[0].age === '1 day ago' && c4.signedIn === false, 'channel: the older c4TabbedHeaderRenderer reads too, signed out (a channel is public)', { st: c4.state, ch: c4.channel, n: c4.items.length });
  var chErr = L.parseChannel({ steps: { channel: errStep(chUrl, 'http', 'HTTP 404') } }, '/@nobody');
  check(chErr.state === 'error' && /YouTube answered with an error/.test(chErr.reason), 'channel: a 404 is an error with the reason', chErr.reason);
  var chGone = L.parseChannel({ steps: { channel: step({ loggedIn: true, ytInitialData: { alerts: [{ alertRenderer: { type: 'ERROR', text: { simpleText: 'This channel does not exist.' } } }] } }, chUrl) } }, '/@nobody');
  check(chGone.state === 'error' && /This channel does not exist/.test(chGone.reason), "channel: YouTube's own alert is the reason", chGone.reason);

  /* ---------------------------------------------------------------- Library + a playlist */
  var lib = L.parseLibrary({ steps: {
    wl: step(fx('youtube-watchlater.json'), L.playlistUrl('WL')), ll: step(fx('youtube-liked.json'), L.playlistUrl('LL')), playlists: step(fx('youtube-playlists.json'), L.PLAYLISTS_URL)
  } });
  check(lib.state === 'ok' && lib.wl.state === 'ok' && lib.wl.items.length > 0 && lib.ll.state === 'ok' && lib.ll.items.length === 4, 'library: Watch later and Liked videos read', { st: lib.state, wl: lib.wl && lib.wl.items.length, ll: lib.ll && lib.ll.items.length });
  check(lib.ll.items[1] && /&t=\d+s$/.test(lib.ll.items[1].url) && lib.ll.items[1].channel.name === 'Pro Shop Joinery', 'library: a liked video resumes, with its channel', lib.ll.items[1] && { u: lib.ll.items[1].url, ch: lib.ll.items[1].channel });
  var pls = lib.playlists.items;
  check(lib.playlists.state === 'ok' && pls.length === 3 && pls.every(function (p) { return p.id !== 'WL' && p.id !== 'LL'; }), 'library: 3 playlists (the Watch later and Liked tiles are their own shelves)', pls.map(function (p) { return p.id; }));
  check(pls[0].title === 'Recipes to try out' && pls[0].count === '3 videos' && /^https:\/\/i\.ytimg\.com\//.test(pls[0].image) && pls[0].url === 'https://www.youtube.com/playlist?list=PLbakingSourdough0000000001', 'library: a lockup playlist: title, count, still, link', pls[0]);
  check(pls[2].title === 'Bread recipes' && pls[2].count === '8 videos', 'library: the older gridPlaylistRenderer reads too', pls[2]);
  var libSo = L.parseLibrary({ steps: { wl: step(fx('youtube-subs-signedout.json'), L.playlistUrl('WL')) } });
  check(libSo.state === 'signed-out', 'library: signed out on Watch later is signed out', libSo.state);
  var libPart = L.parseLibrary({ steps: { wl: step(fx('youtube-watchlater.json'), 'x'), ll: errStep('y', 'timeout'), playlists: errStep('z', 'timeout') } });
  check(libPart.state === 'ok' && libPart.wl.state === 'ok' && libPart.ll.state === 'error' && /timed out/.test(libPart.ll.reason) && libPart.playlists.state === 'error', 'library: one shelf failing keeps the others, each with its reason', { ll: libPart.ll.reason, pl: libPart.playlists.reason });
  var libAll = L.parseLibrary({ steps: { wl: errStep('x', 'offline'), ll: errStep('y', 'offline'), playlists: errStep('z', 'offline') } });
  check(libAll.state === 'error' && /offline/.test(libAll.reason), 'library: everything failing is an error with the reason', libAll.reason);
  var pl = L.parsePlaylist({ steps: { playlist: step(fx('youtube-playlist.json'), L.playlistUrl('PLbakingSourdough0000000001')) } }, 'PLbakingSourdough0000000001');
  check(pl.state === 'ok' && pl.items.length === 3 && pl.playlist.title === 'Recipes to try out' && pl.playlist.owner === 'the user' && pl.playlist.count === '3 videos', 'playlist: its videos in order, title, owner, count', { st: pl.state, h: pl.playlist });
  check(pl.items.map(function (i) { return i.vid; }).join(',') === 'plVideo0001,plVideo0002,plVideo0003' && /&t=421s$/.test(pl.items[1].url), 'playlist: the playlist order kept, part 2 resumes at &t=', pl.items.map(function (i) { return i.url.slice(24); }));
  var plGone = L.parsePlaylist({ steps: { playlist: step({ loggedIn: true, ytInitialData: { alerts: [{ alertWithButtonRenderer: { type: 'INFO', text: { simpleText: 'The playlist does not exist.' } } }] } }, 'x') } }, 'PLnope000000');
  check(plGone.state === 'error' && /does not exist/.test(plGone.reason), "playlist: YouTube's alert is the reason", plGone.reason);

  /* ---------------------------------------------------------------- links and lines */
  var paths = [
    ['https://www.youtube.com/@ESA', '/@ESA'], ['https://www.youtube.com/@ESA/videos', '/@ESA'], ['/@recipebreakdown', '/@recipebreakdown'],
    ['https://m.youtube.com/channel/UCa1b2c3d4e5f6g7h8i9j0kl/featured', '/channel/UCa1b2c3d4e5f6g7h8i9j0kl'], ['/c/SomeName', '/c/SomeName'], ['/user/old_name', '/user/old_name'],
    ['https://evil.example/@ESA', ''], ['javascript:alert(1)', ''], ['/@a/../../etc', ''], ['/watch?v=sbVideo0002', ''], ['/channel/UCshort', ''], ['', ''], [null, ''],
    ['https://www.youtube.com/@caf%C3%A9', '/@caf%C3%A9'], ['//www.youtube.com/@ESA?x=1', '/@ESA'],
  ];
  var bad = paths.filter(function (p) { return L.channelPath(p[0]) !== p[1]; });
  check(bad.length === 0, 'links: channelPath keeps youtube.com channel paths only', bad.map(function (p) { return [p[0], L.channelPath(p[0])]; }));
  check(L.playlistUrl('WL') === 'https://www.youtube.com/playlist?list=WL' && L.playlistUrl('RDmix0000') === '' && L.playlistUrl('a b') === '', 'links: playlist ids (no mixes, nothing odd)');
  var lines = [
    [{ op: 'subs' }, { op: 'subs', seq: 0, force: false }], [{ op: 'subs', force: true, seq: 3 }, { op: 'subs', seq: 3, force: true }],
    [{ op: 'channel', url: 'https://www.youtube.com/@ESA' }, { op: 'channel', seq: 0, force: false, path: '/@ESA' }],
    [{ op: 'channel', url: 'https://evil.example/@ESA' }, null], [{ op: 'playlist', id: 'LL', seq: 2 }, { op: 'playlist', seq: 2, force: false, id: 'LL' }],
    [{ op: 'playlist', id: '../x' }, null], [{ op: 'played', id: 'sbVideo0002' }, { op: 'played', id: 'sbVideo0002' }], [{ op: 'played', id: 'nope' }, null],
    [{ op: 'post', url: 'x' }, null], [null, null], [[1], null], [{ op: 'library', seq: -1 }, { op: 'library', seq: 0, force: false }],
  ];
  var badLines = lines.filter(function (x) { return JSON.stringify(L.cleanLine(x[0])) !== JSON.stringify(x[1]); });
  check(badLines.length === 0, 'lines: quartz-watch:yt is checked (ops, channel host, ids)', badLines.map(function (x) { return [x[0], L.cleanLine(x[0])]; }));

  /* ---------------------------------------------------------------- new since you last opened Lumen */
  var T = Date.parse('2026-10-17T08:00:00Z');
  var st = L.blankStore();
  L.sight(st, true, T);
  L.noteSeen(st, subs.items, T + 1000);
  check(L.newIds(st, subs.items).length === 0 && st.baseline, 'new: the very first read only sets the baseline (nothing is new)', L.newIds(st, subs.items));
  L.sight(st, false, T + 60e3);
  check(L.sight(st, true, T + 3 * 60e3) === false, 'new: back after 3 min is the same visit');
  L.noteSeen(st, next.items, T + 4 * 60e3);
  var during = L.newIds(st, next.items);
  check(during.join(',') === 'sbNewVid011,sbNewVid012', 'new: uploads that land during a visit are new in it', during);
  L.sight(st, false, T + 5 * 60e3);
  check(L.sight(st, true, T + 3 * 3600e3) === true && st.cutoff === T + 5 * 60e3, 'new: back after 3 h is a new visit; the cutoff is when he left', st.cutoff - T);
  check(L.newIds(st, next.items).length === 0, 'new: what he had on screen last visit is not new any more');
  var later = [{ vid: 'sbLater0013' }, { vid: 'sbNewVid011' }];
  L.sight(st, false, T + 4 * 3600e3);
  L.noteSeen(st, later, T + 5 * 3600e3);   // a background read while he is away
  L.sight(st, true, T + 6 * 3600e3);
  check(L.newIds(st, later).join(',') === 'sbLater0013', 'new: a video read while he was away is new when he comes back', L.newIds(st, later));
  L.notePlayed(st, 'sbLater0013', T + 6 * 3600e3 + 1);
  check(L.newIds(st, later).length === 0, 'new: playing it from Lumen clears its mark');
  var round = L.cleanStore(JSON.parse(JSON.stringify(st)));
  check(round.baseline && round.cutoff === st.cutoff && round.seen.sbNewVid011 === st.seen.sbNewVid011 && round.played.sbLater0013 && round.on === false, 'new: the marks survive the file (on-screen state does not)', { cutoff: round.cutoff, on: round.on });
  var big = L.blankStore(); big.baseline = true;
  var many = []; for (var i = 0; i < 3100; i++) many.push({ vid: ('v' + String(i).padStart(10, '0')).slice(0, 11) });
  L.noteSeen(big, many, T);
  check(Object.keys(big.seen).length === L.CAPS.seen, 'new: the seen marks are capped (' + L.CAPS.seen + ')', Object.keys(big.seen).length);

  /* ---------------------------------------------------------------- ytlib-main: queue, cache, lock */
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytlib-test-'));
  try {
    var t = T;
    var timers = [];
    var pushed = [];
    var stepsRun = [];
    var behaviour = {};
    var gate = { why: '', boot: 0 };
    var hold = null;
    var mkMain = function () {
      return YM.create({
        now: function () { return t; }, file: function () { return path.join(dir, 'watch-ytlib.json'); },
        setTimeout: function (fn, ms) { var h = { fn: fn, at: t + ms }; timers.push(h); return h; }, clearTimeout: function (h) { var k = timers.indexOf(h); if (k !== -1) timers.splice(k, 1); },
        push: function (c, a) { pushed.push({ c: c, a: a }); },
        canRead: function () { return gate.why; }, bootLeft: function () { return gate.boot; },
        runStep: async function (s) {
          stepsRun.push(s.name + ' ' + s.url);
          if (hold) await hold;
          await tick();
          var f = behaviour[s.name];
          return f ? f(s) : errStep(s.url, 'http', 'no fixture');
        }
      });
    };
    behaviour.subs = function (s) { return step(fx('youtube-subs.json'), s.url); };
    behaviour.channel = function (s) { return step(fx('youtube-channel.json'), s.url); };
    behaviour.wl = function (s) { return step(fx('youtube-watchlater.json'), s.url); };
    behaviour.ll = function (s) { return step(fx('youtube-liked.json'), s.url); };
    behaviour.playlists = function (s) { return step(fx('youtube-playlists.json'), s.url); };
    var ym = mkMain();
    var pageA = { id: 'A' };
    var pageB = { id: 'B' };
    var last = function (c, what) { for (var k = pushed.length - 1; k >= 0; k--) if ((!c || pushed[k].c === c) && pushed[k].a.what === what) return pushed[k].a; return null; };

    ym.sight(true);
    ym.line(pageA, { op: 'subs', seq: 0, force: false });
    check(pushed[0] && pushed[0].a.what === 'subs' && pushed[0].a.state === 'never' && pushed[0].a.refreshing === true, 'main: cache first: the page hears "never read, refreshing" at once', pushed[0] && pushed[0].a);
    await settle();
    var a1 = last(pageA, 'subs');
    check(a1 && a1.state === 'ok' && a1.items.length === 10 && a1.refreshing === false && a1.newCount === 0 && stepsRun.length === 1, 'main: the read lands: 10 tiles, none new (baseline), one page load', a1 && { st: a1.state, n: a1.items.length, nc: a1.newCount, steps: stepsRun });
    ym.line(pageA, { op: 'subs', seq: 0, force: false });
    await settle();
    check(stepsRun.length === 1, 'main: asked again within 10 min: the cache answers, no read');
    ym._saveNow();
    var file = JSON.parse(fs.readFileSync(path.join(dir, 'watch-ytlib.json'), 'utf8'));
    check(file.subs.items.length === 10 && file.mark.baseline === true && !('on' in file.mark), 'main: the feed and the marks are saved (the tiles only)', Object.keys(file));

    // The lock: a service read holds it; our read waits for it, and theirs waits for ours.
    await ym.acquire();
    ym.line(pageA, { op: 'channel', path: '/@guitarcoachryan', seq: 4, force: false });
    await settle();
    check(stepsRun.length === 1 && ym.state().jobs.indexOf('channel:/@guitarcoachryan') === 0, 'lock: while a service reads, the channel read waits in the queue', ym.state());
    var queuedAns = last(pageA, 'channel');
    check(queuedAns && queuedAns.seq === 4 && queuedAns.state === 'never' && queuedAns.refreshing === true, 'lock: the page hears "loading" for its channel at once', queuedAns);
    var released;
    hold = new Promise(function (r) { released = r; });
    ym.release();
    await settle(5);
    check(ym.state().busy && ym.state().current === 'channel:/@guitarcoachryan', 'lock: released: the channel read starts');
    var mainGot = false;
    ym.acquire().then(function () { mainGot = true; });
    await settle(5);
    check(!mainGot && ym.state().waiters === 1, 'lock: the next service read waits for the channel read');
    released(); hold = null;
    await settle();
    check(mainGot && ym.state().held && !ym.state().busy, 'lock: the channel read ended, then the service read took the lock');
    var chAns = last(pageA, 'channel');
    check(chAns && chAns.state === 'ok' && chAns.seq === 4 && chAns.items.length === 6 && chAns.channel.name === 'Guitar Coach Ryan', 'main: the channel answer goes to the page that asked, with its seq', chAns && { st: chAns.state, seq: chAns.seq, n: chAns.items.length });
    check(!pushed.some(function (p) { return p.c === pageB; }), 'main: a page that asked nothing hears nothing');
    ym.release();

    // Interactive first: the Library (a click) jumps a queued Subscriptions refresh.
    await ym.acquire();
    t += 11 * 60e3;
    ym.line(pageA, { op: 'subs', seq: 0, force: false });
    ym.line(pageA, { op: 'library', seq: 0, force: false });
    check(ym.state().jobs.join(',') === 'library,subs', 'queue: the Library (asked by a click) goes ahead of the feed refresh', ym.state().jobs);
    var before = stepsRun.length;
    ym.release();
    await settle(60);
    check(stepsRun.slice(before).map(function (x) { return x.split(' ')[0]; }).join(',') === 'wl,ll,playlists,subs', 'queue: Watch later, Liked, Playlists, then Subscriptions', stepsRun.slice(before));
    var libAns = last(pageA, 'library');
    check(libAns && libAns.state === 'ok' && libAns.wl.items.length > 0 && libAns.ll.items.length === 4 && libAns.playlists.items.length === 3, 'main: the Library answer has its three shelves', libAns && { st: libAns.state });

    // Paused: a game (or low memory) stops a read; the page hears why, with the cache.
    gate.why = 'paused while VALORANT is running';
    ym.line(pageA, { op: 'subs', seq: 0, force: true });
    await settle();
    var pz = last(pageA, 'subs');
    check(pz && pz.paused === 'paused while VALORANT is running' && pz.refreshing === false && pz.items.length === 10, 'paused: a game stops the read; the page keeps its tiles and hears why', pz && { paused: pz.paused, n: pz.items.length });
    gate.why = '';
    // The boot grace: a read waits for it on a timer, never a poll.
    gate.boot = 5000;
    ym.line(pageA, { op: 'subs', seq: 0, force: true });
    await settle();
    var nBoot = stepsRun.length;
    var bootT = timers.filter(function (h) { return h.at === t + 5000; });
    check(bootT.length === 1, 'boot: a read in the boot grace waits on one timer', timers.map(function (h) { return h.at - t; }));
    gate.boot = 0;
    timers.splice(timers.indexOf(bootT[0]), 1);
    bootT[0].fn();
    await settle();
    check(stepsRun.length === nBoot + 1, 'boot: the timer starts it');

    // New since: a visit later, two new uploads; playing one clears it.
    ym.sight(false);
    t += 2 * 3600e3;
    behaviour.subs = function (s) { return step(fx('youtube-subs-next.json'), s.url); };
    ym.sight(true);
    await settle();
    var nv = last(pageA, 'subs');
    check(nv && nv.newCount === 2 && nv.items[0].isNew && nv.items[1].isNew && !nv.items[2].isNew, 'new: back hours later, the feed reads on its own and the two uploads are new', nv && { nc: nv.newCount, first: nv.items.slice(0, 3).map(function (i) { return i.vid + (i.isNew ? '*' : ''); }) });
    ym.line(pageA, { op: 'played', id: 'sbNewVid012' });
    var pv = last(pageA, 'subs');
    check(pv && pv.newCount === 1 && !pv.items[1].isNew, 'new: playing one from Lumen clears its mark (1 new left)', pv && pv.newCount);

    // After YouTube's own read: signed out clears the feed; fine re-reads it when it is old.
    var nAfter = stepsRun.length;
    ym.afterRead('disney', 'ok');
    ym.afterRead('youtube', 'ok');
    await settle();
    check(stepsRun.length === nAfter, 'after-read: a fresh feed is not read again after a YouTube read (under 5 min)');
    t += 6 * 60e3;
    ym.afterRead('youtube', 'ok');
    await settle();
    check(stepsRun.length === nAfter + 1, 'after-read: a feed over 5 min old reads once after a YouTube read');
    ym.afterRead('youtube', 'signed-out');
    var sa = last(pageA, 'subs');
    check(sa && sa.state === 'signed-out' && sa.items.length === 0, 'after-read: YouTube signed out: the feed says so and shows none of his tiles', sa && sa.state);

    // Errors keep the last good tiles (stale), with the reason.
    behaviour.subs = function (s) { return step(fx('youtube-subs.json'), s.url); };
    ym.line(pageA, { op: 'subs', seq: 0, force: true });
    await settle();
    behaviour.subs = function (s) { return errStep(s.url, 'timeout'); };
    t += 60e3;
    ym.line(pageA, { op: 'subs', seq: 0, force: true });
    await settle();
    var se = last(pageA, 'subs');
    check(se && se.state === 'error' && /timed out/.test(se.reason) && se.items.length === 10 && se.lastOkAt < se.readAt, 'stale: a failed read keeps the last tiles, with the reason and when they are from', se && { st: se.state, r: se.reason, n: se.items.length });

    // A new main (Quartz restarted) reads the file back; Forget deletes it.
    ym.stop();
    var ym2 = mkMain();
    ym2.line(pageB, { op: 'subs', seq: 0, force: false });
    var re = last(pageB, 'subs');
    check(re && re.items.length === 10 && re.state === 'error', 'file: after a restart the page draws the saved feed at once', re && { st: re.state, n: re.items.length });
    ym2.forget();
    check(!fs.existsSync(path.join(dir, 'watch-ytlib.json')) && last(pageB, 'subs').state === 'never', 'forget: the file is gone and the page hears "never read"');
    ym2.stop();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* fine */ }
  }

  /* ---------------------------------------------------------------- the hooks in watch-main.js */
  var WM = require('../watch-main');
  var dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ytlib-wm-'));
  try {
    var t2 = T;
    var concurrent = 0;
    var maxConc = 0;
    var calls = [];
    var slow = {};
    var okStep = function (s) { return { ok: true, url: s.url, finalUrl: s.url, title: '', status: 200, extracted: { ok: true }, json: null, text: null, captures: [], error: null }; };
    var fakeAdapter = function (id) {
      return { id: id, steps: function () { return [{ name: 'home', type: 'view', url: Shape.serviceById(id).home }]; },
        parse: function () { return { state: 'ok', items: [{ service: id, kind: 'rec', title: id + ' title', url: Shape.serviceById(id).home + 'x', id: id + ':1' }], profile: '' }; } };
    };
    var adapters = {};
    Shape.SERVICE_IDS.forEach(function (id) { adapters[id] = fakeAdapter(id); });
    adapters.espn = Object.assign(fakeAdapter('espn'), { steps: function () { return [{ name: 'home', type: 'fetch', url: 'https://site.api.espn.com/x' }]; }, parse: function () { return { state: 'ok', items: [], events: [] }; } });
    fs.writeFileSync(path.join(dir2, WM.PREFS_FILE), JSON.stringify({ background: false }));
    var wm = WM.create({
      dir: dir2, adapters: adapters, bootGraceMs: 0, now: function () { return t2; },
      setTimeout: function (fn, ms) { return { fn: fn, at: t2 + ms, unref: function () {} }; }, clearTimeout: function () {},
      freeGb: function () { return 8; }, log: function () {}, isBundledPage: function (u) { return typeof u === 'string' && u.indexOf('file:///app/') === 0; },
      test: { gameRunning: function () { return ''; }, windowShowing: function () { return true; }, saverOn: function () { return false; } },
      runStep: async function (s) {
        concurrent++; maxConc = Math.max(maxConc, concurrent);
        calls.push(s.name + ' ' + s.url);
        await tick();
        if (slow[s.name]) await new Promise(function (r) { setTimeout(r, slow[s.name]); });
        concurrent--;
        if (s.name === 'subs') return step(fx('youtube-subs.json'), s.url);
        return okStep(s);
      }
    });
    var gp = [];
    var g = {
      url: 'file:///app/watch.html?theme=dark', getURL: function () { return g.url; }, isDestroyed: function () { return false; },
      executeJavaScript: function (code) { var m = /^window\.(__\w+) && window\.\1\(([\s\S]*)\)$/.exec(code); if (m) gp.push({ fn: m[1], payload: JSON.parse(m[2]) }); return Promise.resolve(); },
      on: function () {}
    };
    var heard = wm.handleGuestLine(g, 'quartz-watch:hello {"visible":true}');
    if (!heard) {
      wm.stop();
      wm = null;
    }
    check(heard, 'hooks: the fake page is heard (bundled-page check)');
    if (wm) {
      slow.home = 30;
      wm.handleGuestLine(g, 'quartz-watch:yt {"op":"subs"}');
      check(wm.handleGuestLine(g, 'quartz-watch:yt {"op":"channel","url":"https://evil.example/@x"}') === false, 'hooks: a bad yt line is refused');
      for (var w = 0; w < 400 && calls.filter(function (c) { return /^subs /.test(c); }).length === 0; w++) await new Promise(function (r) { setTimeout(r, 5); });
      for (var w2 = 0; w2 < 200; w2++) await new Promise(function (r) { setTimeout(r, 5); });
      var subsCalls = calls.filter(function (c) { return /^subs /.test(c); });
      check(subsCalls.length >= 1 && maxConc === 1, 'hooks: the feed reads beside the five service reads, never at the same time (max 1 reader)', { calls: calls.map(function (c) { return c.split(' ')[0]; }), maxConc: maxConc });
      var ans = gp.filter(function (p) { return p.fn === '__applyWatchYt'; });
      var lastAns = ans[ans.length - 1];
      check(lastAns && lastAns.payload.state === 'ok' && lastAns.payload.items.length === 10, 'hooks: the page gets __applyWatchYt with the feed', lastAns && lastAns.payload.state);
      wm.handleGuestLine(g, 'quartz-watch:forget {}');
      var after = gp.filter(function (p) { return p.fn === '__applyWatchYt'; });
      check(after[after.length - 1].payload.state === 'never' && !fs.existsSync(path.join(dir2, 'watch-ytlib.json')), "hooks: Lumen's Forget empties the feed and deletes its file");
      wm.stop();
    }
  } finally {
    try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (e) { /* fine */ }
  }
};
