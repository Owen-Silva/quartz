// tests/watch-playview-test.js -- Lumen's playback view's pure parts, no Electron, no network:
//   watch-playview.js:      which pages it boxes, the trim CSS (inert until the page's flag, the player
//                           never hidden, the ad UI and dialogs kept), episode words, the info's model
//                           (page first, item as the fallback, never invented), the reasons a button is off,
//                           and the in-page script (self-contained; it installs in a bare page);
//   watch-playview-main.js: "When a video plays" (default Lumen view, saved, junk refused), the TEST-only
//                           window seam, and the chrome-only IPC;
//   watch-player-yt.js:     the bar's "Full page" button defers to the view, and is as before without it.
// One summary line: "watch-playview-test: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined && !cond ? '  ' + JSON.stringify(detail).slice(0, 300) : ''));
}
const ROOT = path.join(__dirname, '..');
const PV = require(path.join(ROOT, 'watch-playview'));
const Main = require(path.join(ROOT, 'watch-playview-main'));

/* ---- pageKind / boxedFor ------------------------------------------------------------------------ */
const K = (u, s) => PV.pageKind(u, s);
check(K('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube') === 'watch', 'a YouTube watch page is a video');
check(K('https://www.youtube.com/watch', 'youtube') === 'other', 'a /watch with no v is not');
check(K('https://youtu.be/dQw4w9WgXcQ', 'youtube') === 'watch' && K('https://www.youtube.com/live/abcDEF12345', 'youtube') === 'watch', 'youtu.be and /live/ are videos');
check(K('https://www.youtube.com/shorts/abcDEF12345', 'youtube') === 'shorts' && K('https://www.youtube.com/embed/abcDEF12345', 'youtube') === 'embed', 'Shorts and the embed are their own kinds');
check(K('https://www.youtube.com/@channel', 'youtube') === 'other' && K('http://127.0.0.1:5555/watch?v=abcDEF12345', 'youtube') === 'watch', 'a channel page is other; a test origin counts by the slot’s service');
check(K('https://www.disneyplus.com/play/abc', 'disney') === 'player' && K('https://www.disneyplus.com/en-gb/play/abc', 'disney') === 'player' && K('https://www.disneyplus.com/browse/entity-abc', 'disney') === 'other', 'Disney+ /play/ (with a locale) is the player; browse is not');
check(K('https://www.hulu.com/watch/123', 'hulu') === 'player' && K('https://www.hulu.com/series/x', 'hulu') === 'other', 'Hulu /watch/ is the player');
check(K('https://www.primevideo.com/detail/0ABC/ref=x?autoplay=1', 'prime') === 'player' && K('https://www.amazon.com/gp/video/detail/B0X', 'prime') === 'player', 'Prime /detail/ is the player page');
check(K('https://www.espn.com/watch/player/_/id/abc', 'espn') === 'player' && K('https://www.espn.com/nhl/', 'espn') === 'other', 'ESPN /watch/player is the player');
check(K('notaurl', 'youtube') === '' && K('file:///c:/x', 'youtube') === '', 'not a web page: no kind');
const B = (o) => PV.boxedFor(Object.assign({ mode: 'lumen', kind: 'watch', multi: false, n: 1, blocked: '', noRoot: false }, o));
check(B({}) === true, 'the one player, Lumen view, a video: boxed');
check(B({ mode: 'page' }) === false, 'Full page (or the setting): not boxed');
check(B({ multi: true }) === false && B({ n: 2 }) === false, 'a multiview tile or a grid: never boxed (tiles keep their embed)');
check(B({ kind: 'embed' }) === false && B({ kind: 'other' }) === false && B({ kind: 'shorts' }) === false, 'an embed, a channel page, a Short: not boxed (yet)');
check(B({ blocked: 'DRM not ready' }) === false && B({ noRoot: true }) === false, 'a blocked slot, or a page whose player wasn’t found: not boxed');
check(B({ kind: 'player' }) === true, 'a service’s player page: boxed');

/* ---- trimCss ---------------------------------------------------------------------------------------- */
const css = PV.trimCss('youtube');
const rules = css.split('\n').filter((l) => /\{/.test(l));
check(rules.every((l) => /html\[data-lumen-pv\]/.test(l)) && css.split('}').filter((x) => x.trim()).every((blk) => /html\[data-lumen-pv\]/.test(blk)), 'every rule is inert until the page’s <html data-lumen-pv> is set');
check(/> body \{ visibility: hidden !important; \}/.test(css) && /\[data-lumen-pv-root\] \{ visibility: visible !important; position: fixed !important;/.test(css), 'body invisible, the marked player visible and over the viewport');
check(!/#movie_player[^{]*\{[^}]*display: none/.test(css) && !/ytp-ad|ytp-error|ytp-paid/.test(css), 'the player is never hidden, nor its ads, errors or paid-promotion note');
check(/#secondary/.test(css) && /#comments/.test(css) && /ytd-masthead/.test(css) && /ytd-ad-slot-renderer/.test(css) && /#player-ads/.test(css), 'YouTube’s masthead, recommendations, comments and sponsored cards are hidden');
check(/html\[data-lumen-pv\]\.lumen-pv-bar \.ytp-chrome-bottom/.test(css) && /\.lumen-pv-bar \.ytp-gradient-bottom/.test(css), 'the control bar is hidden only under the playerbar bridge’s root class');
check(/:not\(\[data-lumen-pv-pressing\]\) ytd-popup-container tp-yt-paper-dialog:has\(yt-confirm-dialog-renderer\)[^{]*\{ visibility: visible/.test(css), '“Continue watching?” stays seen over the player (not while Lumen answers its own confirm)');
check(!/lumen-pv-bar/.test(PV.trimCss('hulu')) && /\[data-lumen-pv-root\]/.test(PV.trimCss('hulu')) && !/display: none/.test(PV.trimCss('hulu')), 'Hulu: the generic trim only, nothing of its page hidden outright');
check(PV.trimCss('nope').length > 0 && !/undefined/.test(PV.trimCss('nope')), 'an unknown service: the generic trim, no junk');

/* ---- the ad-slot rules follow Quartz's ad blocker ------------------------------------------------ */
// The YouTube hide list as it was before the ad-slot rules became conditional, written out literally:
// with the blocker on (or its state not known yet) the trim must be exactly this, in this order.
const OLD_YT_HIDE = ['#masthead-container', 'ytd-masthead', 'tp-yt-app-drawer#guide', 'ytd-mini-guide-renderer', '#secondary', '#related',
  '#comments', 'ytd-comments', '#chat', 'ytd-live-chat-frame', '#player-ads', 'ytd-ad-slot-renderer', 'ytd-companion-slot-renderer',
  'ytd-merch-shelf-renderer', 'ytd-engagement-panel-section-list-renderer', '#panels', '#offer-module'];
const AD_SLOTS = ['#player-ads', 'ytd-ad-slot-renderer', 'ytd-companion-slot-renderer', 'ytd-merch-shelf-renderer'];
const hideBlock = (list) => list.map((s) => 'html[data-lumen-pv] ' + s).join(',\n') + ' { display: none !important; }';
const ytOn = PV.trimCss('youtube', true), ytOff = PV.trimCss('youtube', false);
check(JSON.stringify(PV.HIDE.youtube) === JSON.stringify(OLD_YT_HIDE) && JSON.stringify(PV.ADSLOTS.youtube) === JSON.stringify(AD_SLOTS), 'the YouTube hide list is unchanged; the ad slots are #player-ads, the ad-slot, companion-slot and merch-shelf renderers', PV.ADSLOTS);
check(ytOn === css && PV.trimCss('youtube', undefined) === css && PV.trimCss('youtube', null) === css && PV.trimCss('youtube', 'yes') === css, 'blocker on, or not answered yet: the trim is byte for byte the one with no blocker state given');
check(ytOn.endsWith('\n' + hideBlock(OLD_YT_HIDE)), 'blocker on: the hide rule is the literal old list, in order', ytOn.slice(-200));
check(ytOff.endsWith('\n' + hideBlock(OLD_YT_HIDE.filter((s) => AD_SLOTS.indexOf(s) < 0))) && AD_SLOTS.every((s) => ytOff.indexOf(s) < 0), 'blocker off: the four ad/merch selectors are gone, the rest of the hide list as before, in order', ytOff.slice(-200));
check(ytOff === ytOn.replace('\n' + hideBlock(OLD_YT_HIDE), '\n' + hideBlock(OLD_YT_HIDE.filter((s) => AD_SLOTS.indexOf(s) < 0))), 'blocker off: everything else in the trim (keep, bar, body, player root) is identical');
check(['disney', 'hulu', 'prime', 'espn', 'nope'].every((s) => PV.trimCss(s, false) === PV.trimCss(s, true) && PV.trimCss(s, true) === PV.trimCss(s)), 'the other services: the blocker changes nothing');
check(Object.keys(PV.ADSLOTS).every((s) => PV.ADSLOTS[s].every((x) => (PV.HIDE[s] || []).indexOf(x) >= 0)), 'every ad slot is a member of its service’s hide list (the blocker only ever removes, never adds)');

/* ---- epParts / cleanPageTitle ------------------------------------------------------------------------ */
const E = PV.epParts;
check(JSON.stringify(E('S2 E4 · Honeydew')) === '{"ep":"S2 E4","name":"Honeydew"}', 'S2 E4 · Honeydew', E('S2 E4 · Honeydew'));
check(JSON.stringify(E('S2:E4 Honeydew')) === '{"ep":"S2 E4","name":"Honeydew"}' && JSON.stringify(E('Season 3 Episode 10 - The End')) === '{"ep":"S3 E10","name":"The End"}', 'S2:E4 and "Season 3 Episode 10"');
check(JSON.stringify(E('E7')) === '{"ep":"E7","name":""}' && JSON.stringify(E('')) === '{"ep":"","name":""}' && JSON.stringify(E('Live')) === '{"ep":"","name":"Live"}', 'E7 alone, nothing, plain words');
check(PV.cleanPageTitle('(3) Big Video - YouTube', 'youtube') === 'Big Video' && PV.cleanPageTitle('Watch The Bear | Hulu', 'hulu') === 'The Bear', 'a page title loses the service’s suffix and the unread count');

/* ---- model --------------------------------------------------------------------------------------------- */
const read = { ok: true, videoId: 'abcDEF12345', signedIn: true, title: 'Page Title', titleFrom: 'page', channel: { name: 'Chan', subs: '1.2M subscribers', avatar: 'https://x/a.jpg' },
  desc: { text: 'Hello', meta: '10K views · 2 days ago' }, like: { found: true, on: true, count: '12K' }, dislike: { found: true, on: false }, sub: { found: true, on: false }, save: { found: false }, comments: { token: 'TOK' } };
let m = PV.model('youtube', read, { id: 'youtube:x', title: 'Item Title' }, 'Slot');
check(m.title === 'Page Title' && m.titleFrom === 'page' && m.channel.name === 'Chan' && m.channel.subs === '1.2M subscribers', 'YouTube: the page’s title and channel come first');
check(m.buttons.like.on === true && m.buttons.like.count === '12K' && m.buttons.sub.on === false && m.buttons.save.found === false && m.missing.join() === 'save', 'the buttons’ state is the page’s; a missing one is listed');
check(m.desc.meta === '10K views · 2 days ago' && m.comments.token === 'TOK' && m.videoId === 'abcDEF12345', 'the description, the comments token (for a later module), the video id');
m = PV.model('youtube', null, { id: 'youtube:x', title: 'Item Title' }, 'Slot');
check(m.title === 'Item Title' && m.titleFrom === 'item' && m.channel === null && m.missing.length === 0 && m.signedIn === null, 'nothing read yet: the item’s title, no channel, nothing claimed missing');
m = PV.model('youtube', { ok: true, pageTitle: 'Other - YouTube' }, { title: 'Old' }, '', { moved: true });
check(m.title === 'Other' && m.titleFrom === 'page-title', 'moved on in the page: the page’s own title, not the stale item');
m = PV.model('hulu', { ok: true, title: 'Watch The Bear | Hulu' }, { id: 'hulu:1', title: 'The Bear', subtitle: 'S2 E4 · Honeydew' }, '');
check(m.title === 'The Bear' && m.ep === 'S2 E4' && m.epName === 'Honeydew' && m.name === 'Hulu' && m.channel === null, 'Hulu: the item’s title, SxEy and the episode’s name, the service');
m = PV.model('prime', { ok: true, title: 'Watch Next One | Prime Video' }, { title: 'First' }, '', { moved: true });
check(m.title === 'Next One' && m.ep === '', 'Prime, moved to another episode in its own player: the page’s title, no stale SxEy');
m = PV.model('espn', null, null, 'Game · Live');
check(m.title === 'Game' && m.titleFrom === 'item', 'ESPN with only the slot’s title: its first part');
check(PV.complete(read) === true && PV.complete(Object.assign({}, read, { sub: { found: false } })) === false && PV.complete(null) === false, 'complete(): title, channel, Like and Subscribe');

/* ---- r62-playview: a YouTube page that moved on to another video ------------------------------------------ */
// The view used to treat YouTube as never "moved": after autoplay or an end-screen card (moves in the page),
// the LAST video's title from Lumen's row stood in under the next one, and stayed when the read failed.
check(PV.ytId('https://www.youtube.com/watch?v=abcDEF12345&t=30s') === 'abcDEF12345' && PV.ytId('https://youtu.be/abcDEF12345') === 'abcDEF12345'
  && PV.ytId('https://www.youtube.com/live/abcDEF12345') === 'abcDEF12345' && PV.ytId('https://www.youtube.com/@chan') === '', 'ytId: watch, youtu.be and live addresses; a channel has none');
check(PV.ytMoved('https://www.youtube.com/watch?v=AAAAAAAAAAA', 'https://www.youtube.com/watch?v=BBBBBBBBBBB&pp=x') === true, 'ytMoved: another video id is a move');
check(PV.ytMoved('https://www.youtube.com/watch?v=AAAAAAAAAAA', 'https://www.youtube.com/watch?v=AAAAAAAAAAA&t=95s&pp=x') === false
  && PV.ytMoved('https://youtu.be/AAAAAAAAAAA', 'https://www.youtube.com/watch?v=AAAAAAAAAAA') === false, 'ytMoved: the same video with a time or a short link is not');
check(PV.ytMoved('https://www.youtube.com/@chan', 'https://www.youtube.com/watch?v=BBBBBBBBBBB') === false, 'ytMoved: an item that was not one video never moves');
{
  const rowItem = { title: 'Video A (from the row)' };
  const mv = PV.model('youtube', null, rowItem, 'Video A (slot)', { moved: true });
  check(mv.title === '' && mv.titleFrom === '', 'model: moved and not read yet: no title from the row (the skeleton, never the last video’s)', mv);
  const mv2 = PV.model('youtube', { ok: true, videoId: 'BBBBBBBBBBB', pageTitle: 'Video B - YouTube' }, rowItem, 'Video A (slot)', { moved: true });
  check(mv2.title === 'Video B' && mv2.titleFrom === 'page-title', 'model: moved, the page has only its <title>: that, cleaned', mv2);
}
// watch-player-hosts.js: an Amazon prefix is whole path segments (amazon.com/videogames is shopping, not Prime Video).
{
  const Hs = require(path.join(ROOT, 'watch-player-hosts'));
  check(Hs.serviceFor('https://www.amazon.com/videogames/b?node=468642') === '' && Hs.serviceFor('https://www.amazon.com/video/detail/B0X') === 'prime'
    && Hs.serviceFor('https://www.amazon.com/gp/video/detail/B0X') === 'prime' && Hs.serviceFor('https://www.amazon.com/Amazon-Video/b?node=2858778011') === 'prime',
  'hosts: amazon.com/videogames is not Prime Video; /video/, /gp/video and /Amazon-Video still are');
}

/* ---- whyOff ---------------------------------------------------------------------------------------------- */
const mm = PV.model('youtube', read, null, '');
check(PV.whyOff(mm, 'like', 'ready') === '' && /Save button isn’t on this page/.test(PV.whyOff(mm, 'save', 'ready')), 'a found button is on; a missing one says why');
check(/^Sign in to YouTube to subscribe$/.test(PV.whyOff(PV.model('youtube', Object.assign({}, read, { signedIn: false }), null, ''), 'sub', 'ready')), 'signed out: Sign in, in words');
check(PV.whyOff(mm, 'like', 'offline') === 'You’re offline' && /Reading/.test(PV.whyOff(PV.model('youtube', { ok: true }, null, ''), 'like', 'loading')), 'offline, and still reading');

/* ---- the in-page script ---------------------------------------------------------------------------------- */
let compiled = true;
try { new vm.Script(PV.call('tick', ['youtube', true])); new vm.Script(PV.call('press', ['youtube', 'like', null])); } catch (e) { compiled = e.message; }
check(compiled === true, 'the page calls compile', compiled);
check(PV.call('read', ['he said "hi"</script>']).indexOf('"he said \\"hi\\"</script>"') > 0, 'arguments are JSON, never pasted in raw');
// A bare page: no player, nothing on it. The script installs, finds no root, and leaves the page alone.
const attrs = {};
const docEl = { hasAttribute: (k) => k in attrs, setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } };
const win = { location: { href: 'https://www.youtube.com/watch?v=abcDEF12345' }, dispatchEvent: () => true };
const doc = { documentElement: docEl, title: 'T - YouTube', querySelector: () => null, querySelectorAll: () => [] };
const sb = vm.createContext({ window: win, document: doc, location: win.location, URL, setTimeout, clearTimeout, Promise, Event: function () {}, KeyboardEvent: function () {}, JSON, Math, Date, Number, String, Array, Object });
let tick = null;
try { tick = vm.runInContext(PV.call('tick', ['youtube', true]), sb); } catch (e) { tick = { err: e.message }; }
check(tick && tick.ok === true && tick.applied === false && !('data-lumen-pv' in attrs), 'a page with no #movie_player: not trimmed (the whole page shows)', tick);
check(tick && tick.like && tick.like.found === false && tick.sub.found === false && tick.videoId === 'abcDEF12345' && tick.signedIn === null, 'and nothing claimed: no buttons found, sign-in unknown', tick);
check(typeof win.__lumenPv.press === 'function' && win.__lumenPv.v >= 1, 'installed once, as window.__lumenPv');
let pr = null;
vm.runInContext(PV.call('press', ['youtube', 'like', null]), sb).then((r) => { pr = r; });
let prOther = null;
vm.runInContext(PV.call('press', ['hulu', 'like', null]), sb).then((r) => { prOther = r; });

/* ---- the description's links (descLink, descSegs, model, the page's seek) ---------------------------------- */
const VIDX = 'abcDEF12345';
const DL = (h) => PV.descLink(h, VIDX);
check(DL('/watch?v=' + VIDX + '&t=83s').kind === 'time' && DL('/watch?v=' + VIDX + '&t=83s').t === 83, 'a chapter link in this video (YouTube’s relative /watch?v=…&t=83s) is a time: 83 s');
check(DL('/watch?v=' + VIDX + '&t=0s').kind === 'time' && DL('/watch?v=' + VIDX + '&t=0s').t === 0, '0:00 is a real time: it seeks to the start, never reloads the video');
check(DL('https://youtu.be/' + VIDX + '?t=1h2m3s').t === 3723 && DL('https://www.youtube.com/watch?v=' + VIDX + '&start=90').t === 90, 'youtu.be ?t=1h2m3s and &start= are times too');
check(DL('/watch?v=' + VIDX).kind === 'same', 'this video with no time: “same” (nothing to open; the note says so)');
check(DL('/watch?v=otherVID001').kind === 'yt' && DL('/watch?v=otherVID001&t=30s').kind === 'yt', 'another video (with or without a time) opens in Lumen');
check(['/shorts/abcDEF12345', 'https://youtu.be/zzzzzzzzzzz', '/@somehandle', '/channel/UC123', '/playlist?list=PL123', '/hashtag/music', 'https://m.youtube.com/@x']
  .every((h) => DL(h) && DL(h).kind === 'yt' && /^https:\/\/(www|m)\.youtube\.com\/|^https:\/\/youtu\.be\//.test(DL(h).href)), 'Shorts, youtu.be, @handles, channels, playlists and hashtags: YouTube pages, opened in Lumen');
check(DL('https://www.youtube.com/redirect?event=video_description&q=https%3A%2F%2Fexample.com%2Fpage').kind === 'web' && DL('https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.com%2Fpage').href === 'https://example.com/page', 'YouTube’s /redirect?q= is unwrapped to the site it goes to: a Quartz tab');
check(DL('https://example.com/x').kind === 'web' && DL('http://example.org').kind === 'web', 'any other http(s) site: a Quartz tab');
check(['javascript:alert(1)', 'data:text/html,hi', 'file:///c:/x', 'mailto:a@b.c', '', null].every((h) => DL(h) === null), 'javascript:, data:, file: and mailto: are no link at all');
check(DL('https://www.youtube.com.evil.example/watch?v=' + VIDX + '&t=5s').kind === 'web', 'a host that only starts with youtube.com is another site');
check(PV.clockSeconds('0:00') === 0 && PV.clockSeconds('1:23') === 83 && PV.clockSeconds('1:23:45') === 5025 && PV.clockSeconds('99:99') === null && PV.clockSeconds('1:60:00') === null, 'chapter times as written: 0:00, 1:23, 1:23:45; nonsense refused');
check(PV.clock(0) === '0:00' && PV.clock(83) === '1:23' && PV.clock(5025) === '1:23:45', 'and back, for a link’s title');
// The text with the page's own links: found in order; the rest scanned for plain times and addresses.
const TXT = 'Chapters:\n0:00 Intro\n1:23 Part two\nSite: example.com/very-lo...\nBy @somehandle #music\nRatio 16:9, 10:30am, v1.2:34';
const LINKS = [{ t: '0:00', h: '/watch?v=' + VIDX + '&t=0s' }, { t: '1:23', h: '/watch?v=' + VIDX + '&t=83s' },
  { t: 'example.com/very-lo...', h: 'https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.com%2Fvery-long-path' },
  { t: '@somehandle', h: '/@somehandle' }, { t: '#music', h: '/hashtag/music' }, { t: 'not in the text', h: '/@nobody' }];
let segs = PV.descSegs(TXT, LINKS, VIDX);
check(segs.map((x) => x.text).join('') === TXT, 'the segments are the text, every character, in order', segs);
const ls = segs.filter((x) => x.link);
check(ls.map((x) => x.text + '=' + x.link.kind).join('|') === '0:00=time|1:23=time|example.com/very-lo...=web|@somehandle=yt|#music=yt', 'the page’s links become links by their words; one whose words aren’t in the text is dropped', ls.map((x) => x.text + '=' + x.link.kind));
check(ls[2].link.href === 'https://example.com/very-long-path', 'a shortened address opens the whole one YouTube links to');
segs = PV.descSegs('Watch at 2:05 and 1:02:03. More: https://example.com/a?b=c). Not 16:9 or 10:30am.', [], VIDX);
check(segs.filter((x) => x.link).map((x) => x.text + '=' + x.link.kind + (x.link.t !== undefined ? x.link.t : '')).join('|') === '2:05=time125|1:02:03=time3723|https://example.com/a?b=c=web',
  'no page links (ytInitialData’s plain text): times and addresses in the text are found; “16:9”, “10:30am” and a trailing “).” are not links', segs.filter((x) => x.link));
check(PV.descSegs('At 2:05', [], '').every((x) => !x.link), 'no video id: a time can’t seek anything, so it stays text');
// A hostile description: markup and script are words, every one; a hostile href is no link.
const EVIL = '<img src=x onerror=alert(1)> <script>alert(2)</script> <a href="javascript:alert(3)">click</a> 0:05';
segs = PV.descSegs(EVIL, [{ t: 'click', h: 'javascript:alert(3)' }, { t: '<script>', h: 'javascript:alert(4)' }], VIDX);
check(segs.map((x) => x.text).join('') === EVIL && segs.filter((x) => x.link).map((x) => x.text).join() === '0:05', 'a hostile description: its markup is text, its javascript: links are no links (only 0:05 is)', segs);
// The model: links carried as words and an address only, capped; junk dropped.
const mL = PV.model('youtube', { ok: true, videoId: VIDX, desc: { text: 'x 0:10', meta: '', links: [{ t: '0:10', h: '/watch?v=' + VIDX + '&t=10s', extra: '<b>' }, { t: 5, h: '/x' }, null, { t: 'a', h: '' }, { t: 'y'.repeat(600), h: '/z' }] } }, null, '');
check(mL.desc.links.length === 1 && JSON.stringify(mL.desc.links[0]) === JSON.stringify({ t: '0:10', h: '/watch?v=' + VIDX + '&t=10s' }), 'the model keeps each link’s words and address only (strings, capped); junk is dropped', mL.desc.links);
check(Array.isArray(PV.model('youtube', { ok: true, desc: { text: 'x' } }, null, '').desc.links), 'a read with no links: an empty list, never undefined');
// The page side: its own links read raw (relative hrefs kept), and seek() in place.
function aNode(text, href) { return { innerText: text, textContent: text, getAttribute: (k) => (k === 'href' ? href : null) }; }
const seeks = [];
const vidEl = { paused: true, currentTime: 7, play() { this.paused = false; seeks.push('play'); return Promise.resolve(); } };
const mpEl = { classList: { contains: () => false }, seekTo(t, a) { seeks.push('seekTo:' + t + ':' + a); vidEl.currentTime = t; }, playVideo() { seeks.push('playVideo'); vidEl.paused = false; } };
const descNode = { innerText: 'Intro 0:00 then 1:23', querySelectorAll: (sel) => (sel === 'a[href]' ? [aNode('0:00', '/watch?v=' + VIDX + '&t=0s'), aNode('1:23', '/watch?v=' + VIDX + '&t=83s'), aNode('', '/x')] : []) };
const doc2 = { documentElement: { hasAttribute: () => false, setAttribute() {}, removeAttribute() {} }, title: 'T - YouTube',
  querySelector: (sel) => (/yt-attributed-string/.test(sel) ? descNode : sel === '#movie_player' ? mpEl : sel === '#movie_player video' ? vidEl : null), querySelectorAll: () => [] };
const win2 = { location: { href: 'https://www.youtube.com/watch?v=' + VIDX }, dispatchEvent: () => true };
const sb2 = vm.createContext({ window: win2, document: doc2, location: win2.location, URL, setTimeout, clearTimeout, Promise, Event: function () {}, KeyboardEvent: function () {}, JSON, Math, Date, Number, String, Array, Object });
let rd2 = null;
try { rd2 = vm.runInContext(PV.call('read', ['youtube']), sb2); } catch (e) { rd2 = { err: e.message }; }
check(rd2 && rd2.desc && rd2.desc.links && rd2.desc.links.length === 2 && rd2.desc.links[0].h === '/watch?v=' + VIDX + '&t=0s', 'the page reads its description’s links with their raw (relative) hrefs; a link with no words is skipped', rd2 && rd2.desc);
let sk = null;
try { sk = vm.runInContext(PV.call('seek', [83]), sb2); } catch (e) { sk = { err: e.message }; }
check(sk && sk.ok && sk.how === 'player' && seeks.join() === 'seekTo:83:true,playVideo', 'seek(83): YouTube’s own player seeks and plays; nothing loads', { sk, seeks });
mpEl.classList.contains = (c) => c === 'ad-showing';
sk = vm.runInContext(PV.call('seek', [10]), sb2);
check(sk && sk.ok === false && /ad is playing/.test(sk.reason), 'during an ad: refused, with the reason in words', sk);
let sk3 = null;
try { sk3 = vm.runInContext(PV.call('seek', [5]), sb); } catch (e) { sk3 = { err: e.message }; }
check(sk3 && sk3.ok === false && /no video/.test(sk3.reason), 'a page with no video: refused, with the reason', sk3);
// ytInitialData's commandRuns when the DOM drew no links: a hashtag goes to /hashtag/<tag> (never /channel/FEhashtag),
// a chapter time keeps t=0s, another site keeps its /redirect (unwrapped later by descLink).
const CONTENT = 'Intro 0:00 #music site';
const ytd3 = { currentVideoEndpoint: { watchEndpoint: { videoId: VIDX } }, contents: { twoColumnWatchNextResults: { results: { results: { contents: [
  { videoSecondaryInfoRenderer: { owner: { videoOwnerRenderer: { title: { runs: [{ text: 'C' }] } } }, attributedDescription: { content: CONTENT, commandRuns: [
    { startIndex: 18, length: 4, onTap: { innertubeCommand: { urlEndpoint: { url: 'https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.com%2F' } } } },
    { startIndex: 6, length: 4, onTap: { innertubeCommand: { watchEndpoint: { videoId: VIDX, startTimeSeconds: 0 } } } },
    { startIndex: 11, length: 6, onTap: { innertubeCommand: { commandMetadata: { webCommandMetadata: { url: '/hashtag/music' } }, browseEndpoint: { browseId: 'FEhashtag', params: 'x' } } } },
  ] } } },
] } } } } };
const descNode3 = { innerText: CONTENT, querySelectorAll: () => [] };
const doc3 = { documentElement: { hasAttribute: () => false, setAttribute() {}, removeAttribute() {} }, title: 'T - YouTube',
  querySelector: (sel) => (/yt-attributed-string/.test(sel) ? descNode3 : null), querySelectorAll: () => [] };
const win3 = { location: { href: 'https://www.youtube.com/watch?v=' + VIDX }, dispatchEvent: () => true, ytInitialData: ytd3 };
const sb3 = vm.createContext({ window: win3, document: doc3, location: win3.location, URL, setTimeout, clearTimeout, Promise, Event: function () {}, KeyboardEvent: function () {}, JSON, Math, Date, Number, String, Array, Object });
let rd3 = null;
try { rd3 = vm.runInContext(PV.call('read', ['youtube']), sb3); } catch (e) { rd3 = { err: e.message }; }
const l3 = rd3 && rd3.desc ? rd3.desc.links : [];
check(JSON.stringify(l3.map((l) => [l.t, l.h])) === JSON.stringify([['0:00', '/watch?v=' + VIDX + '&t=0s'], ['#music', '/hashtag/music'], ['site', 'https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.com%2F']]),
  'no links in the DOM: ytInitialData’s runs, in order; 0:00 keeps t=0s; a hashtag is /hashtag/<tag>, not /channel/FEhashtag', l3);
check(PV.descSegs(CONTENT, l3, VIDX).filter((x) => x.link).map((x) => x.link.kind).join() === 'time,yt,web', 'and they draw as a time, a YouTube page and another site');

/* ---- r64: a watch page still drawn for the LAST video (an in-place move YouTube hasn't redrawn yet) ---------- */
// Up next's Play now moves the page in place: the address names video B at once, but YouTube redraws the title,
// the channel, Like and Subscribe (and ytd-watch-flexy's video-id) hundreds of ms later. A read in that gap took A's
// info as B's, found it complete, and the reads stopped: B played under A's title for good.
const VA = 'videoAAAAA1', VB = 'videoBBBBB2';
function ytPage(addrId, flexyId, extra) {
  // flexyId: null = no ytd-watch-flexy at all; '' = one with no video-id; an id = its video-id
  const node = (text, attrs, more) => Object.assign({ textContent: text, innerText: text, getAttribute: (k) => (attrs && k in attrs ? attrs[k] : null), closest: () => null, querySelectorAll: () => [] }, more || {});
  const flexAttrs = flexyId ? { 'video-id': flexyId } : {};
  const nodes = {
    'ytd-watch-flexy': flexyId === null ? null : node('', flexAttrs, { setAttribute: (k, v) => { flexAttrs[k] = v; } }),
    '#title h1': node('Video A title'),
    '#channel-name #text a': node('Channel A', null, { href: 'https://www.youtube.com/@channela' }),
    '#owner-sub-count': node('1.2M subscribers'),
    'like-button-view-model button': node('12K', { 'aria-pressed': 'false', 'aria-label': 'like this video along with 12,345 other people' }),
    'dislike-button-view-model button': node('', { 'aria-pressed': 'false', 'aria-label': 'Dislike this video' }),
    '#subscribe-button button': node('Subscribe', { 'aria-label': 'Subscribe to Channel A.' }),
    'button[aria-label="Save to playlist"]': node('Save', { 'aria-label': 'Save to playlist' }),
    '#description-inline-expander yt-attributed-string': node('Video A’s description'),
    '#info-container #info': node('48K views 3 days ago'),
  };
  // the page's own data is the FIRST video's after an in-place move (YouTube never rewrites ytInitialData)
  const yd = { currentVideoEndpoint: { watchEndpoint: { videoId: VA } }, contents: { twoColumnWatchNextResults: { results: { results: { contents: [
    { videoPrimaryInfoRenderer: { title: { runs: [{ text: 'Video A title' }] } } },
    { videoSecondaryInfoRenderer: { owner: { videoOwnerRenderer: { title: { runs: [{ text: 'Channel A' }] } } }, attributedDescription: { content: 'Video A’s description' } } },
    { itemSectionRenderer: { sectionIdentifier: 'comment-item-section', contents: [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOKEN-OF-A' } } } }] } },
  ] } } } } };
  const d = { documentElement: { hasAttribute: () => false, setAttribute() {}, removeAttribute() {} }, title: 'Video A title - YouTube',
    querySelector: (sel) => (sel in nodes ? nodes[sel] : null), querySelectorAll: () => [] };
  const w = Object.assign({ location: { href: 'https://www.youtube.com/watch?v=' + addrId }, dispatchEvent: () => true, ytInitialData: yd,
    ytInitialPlayerResponse: { videoDetails: { videoId: VA, title: 'Video A title', author: 'Channel A' } } }, extra || {});
  const c = vm.createContext({ window: w, document: d, location: w.location, URL, setTimeout, clearTimeout, Promise, Event: function () {}, KeyboardEvent: function () {}, JSON, Math, Date, Number, String, Array, Object });
  return { w, d, c, flexAttrs, nodes, read: () => { try { return vm.runInContext(PV.call('read', ['youtube']), c); } catch (e) { return { err: e.message }; } } };
}
{
  const st = ytPage(VB, VA).read();
  check(!!st && st.ok && st.videoId === VB && st.stale === true && st.drawnId === VA, 'stale page (the address says B, ytd-watch-flexy still says A): the read says stale, for B', st);
  check(!!st && st.title === '' && st.channel === null && st.pageTitle === '' && st.desc.text === '' && st.desc.meta === '' && st.desc.links.length === 0,
    'and takes none of the DOM’s words: no title, channel, document.title, description or views line (all A’s)', st && { title: st.title, channel: st.channel, pageTitle: st.pageTitle, desc: st.desc });
  check(!!st && !st.like.found && !st.dislike.found && !st.sub.found && !st.save.found && st.comments === null, 'nor A’s Like, Dislike, Subscribe or Save, nor A’s comments token (ytInitialData is A’s: never used for B)', st && { like: st.like, sub: st.sub, comments: st.comments });
  check(PV.complete(st) === false, 'so the read is NOT complete: the reads go on and the watch catches YouTube’s redraw');
  const ms = PV.model('youtube', st, { title: 'Video B (Lumen’s row)' }, 'Video B (slot)', { moved: false });
  check(ms.title === 'Video B (Lumen’s row)' && ms.titleFrom === 'item' && ms.channel === null && ms.stale === true, 'the info meanwhile: B’s own row title, no channel (never A’s)', ms);
  const mm2 = PV.model('youtube', st, null, '', { moved: true });
  check(mm2.title === '' && mm2.titleFrom === '', 'YouTube’s own move (no row for B): the skeleton, never A’s title nor A’s document.title', mm2);
  check(/Reading YouTube’s page/.test(PV.whyOff(ms, 'like', 'loading')) && /still showed the last video/.test(PV.whyOff(ms, 'like', 'unread')), 'its buttons: “Reading…” while the reads go on; after the last one, why they are off (the page was the last video’s)');
  const fresh = ytPage(VA, VA).read();
  check(!!fresh && fresh.stale === false && fresh.title === 'Video A title' && fresh.titleFrom === 'page' && fresh.channel && fresh.channel.name === 'Channel A' && fresh.like.found && fresh.sub.found
    && fresh.pageTitle === 'Video A title - YouTube' && fresh.desc.text === 'Video A’s description' && fresh.comments && fresh.comments.token === 'TOKEN-OF-A' && PV.complete(fresh) === true,
    'a page drawn for this video (ytd-watch-flexy’s video-id matches): read as before, complete', fresh);
  const noId = ytPage(VA, '').read(), noFlexy = ytPage(VA, null).read();
  check([noId, noFlexy].every((r) => r && r.stale === false && r.title === 'Video A title' && r.channel && r.channel.name === 'Channel A' && r.like.found && PV.complete(r) === true),
    'ytd-watch-flexy with no video-id, or none at all: read as before (nothing to compare), complete', { noId, noFlexy });
  check(PV.complete(ytPage(VB, '').read()) === true, 'and so without a video-id a moved page reads as it did before (the timing is the only guard there)');
  // The player moves on before the page redraws (a real-YouTube probe: 1-1.3 s sooner): its title and channel for
  // THIS id stand in while the page is stale; never another id's; still not complete (no buttons).
  const pp = ytPage(VB, VA);
  pp.nodes['#movie_player'] = { getPlayerResponse: () => ({ videoDetails: { videoId: VB, title: 'Video B from the player', author: 'Channel B', channelId: 'UCbbbbbbbbbb' } }) };
  const rp = pp.read();
  check(!!rp && rp.stale && rp.title === 'Video B from the player' && rp.titleFrom === 'player' && rp.channel && rp.channel.name === 'Channel B' && rp.channel.url === 'https://www.youtube.com/channel/UCbbbbbbbbbb'
    && !rp.like.found && rp.desc.text === '' && PV.complete(rp) === false, 'stale page, the player already on B: B’s title and channel from the player; no buttons or description yet, so not complete', rp);
  const pa = ytPage(VB, VA);
  pa.nodes['#movie_player'] = { getPlayerResponse: () => ({ videoDetails: { videoId: VA, title: 'Video A title', author: 'Channel A' } }), getVideoData: () => ({ video_id: VA, title: 'Video A title', author: 'Channel A' }) };
  const ra = pa.read();
  check(!!ra && ra.title === '' && ra.channel === null, 'the player still on A: nothing from it (another id’s words are never shown under B)', ra && { title: ra.title, channel: ra.channel });
  const pg = ytPage(VB, VA);
  pg.nodes['#movie_player'] = { getVideoData: () => ({ video_id: VB, title: 'Video B (getVideoData)', author: 'Channel B' }) };
  const rg = pg.read();
  check(!!rg && rg.title === 'Video B (getVideoData)' && rg.channel && rg.channel.name === 'Channel B' && rg.channel.url === '', 'no getPlayerResponse: getVideoData for this id does the same', rg && { title: rg.title, channel: rg.channel });
  const mpl = PV.model('youtube', rp, { title: 'Video B (Lumen’s row)' }, '', { moved: false });
  check(mpl.title === 'Video B from the player' && mpl.titleFrom === 'player' && mpl.channel.name === 'Channel B', 'the info draws the player’s title over the row’s', mpl);
  // The description after an in-place move (r64): on real YouTube ytd-watch-flexy, the title and the buttons were B's
  // about 1 s after the move while B's description wasn't drawn yet. That read was complete, the reads stopped, and B
  // never showed a description or a link. Now the description must be READ (descRead) from a page drawn for B.
  {
    const pm = ytPage(VB, VA);
    const B_DESC = 'Video B’s description: 0:05 and @channelb';
    pm.nodes['#movie_player'] = { getPlayerResponse: () => ({ videoDetails: { videoId: VB, title: 'Video B from the player', author: 'Channel B', channelId: 'UCbbbbbbbbbb', shortDescription: B_DESC } }) };
    const r1 = pm.read();   // stale: the page still A's, the player on B
    check(!!r1 && r1.stale && r1.title === 'Video B from the player' && r1.descRead === false && r1.descFrom === 'player' && r1.desc.text === B_DESC && r1.desc.links.length === 0 && PV.complete(r1) === false,
      'stale page, the player on B: B’s title first, and B’s description words from the player (no links); not complete', r1 && { stale: r1.stale, title: r1.title, descRead: r1.descRead, descFrom: r1.descFrom, desc: r1.desc });
    // YouTube redraws all but the description: ytd-watch-flexy, the title, the channel and the buttons are B's
    pm.flexAttrs['video-id'] = VB;
    pm.nodes['#title h1'] = Object.assign({}, pm.nodes['#title h1'], { textContent: 'Video B title', innerText: 'Video B title' });
    pm.nodes['#channel-name #text a'] = Object.assign({}, pm.nodes['#channel-name #text a'], { textContent: 'Channel B', innerText: 'Channel B' });
    pm.nodes['#description-inline-expander yt-attributed-string'] = null;   // not drawn yet
    const r2 = pm.read();
    check(!!r2 && r2.stale === false && r2.title === 'Video B title' && r2.like.found && r2.sub.found && r2.descRead === false && r2.descFrom === 'player' && PV.complete(r2) === false,
      'the page drawn for B but not its description: still NOT complete (the reads and the watch go on)', r2 && { stale: r2.stale, title: r2.title, descRead: r2.descRead, descFrom: r2.descFrom });
    const m2 = PV.model('youtube', r2, null, '');
    check(m2.descPending === true && m2.descFrom === 'player' && m2.desc && m2.desc.text === B_DESC, 'the info meanwhile: the player’s words, marked as still to be read from the page', m2 && { descPending: m2.descPending, descFrom: m2.descFrom, desc: m2.desc });
    // then the description, with its links
    const a = (t, h) => ({ textContent: t, innerText: t, getAttribute: (k) => (k === 'href' ? h : null) });
    pm.nodes['#description-inline-expander yt-attributed-string'] = { textContent: B_DESC, innerText: B_DESC, getAttribute: () => null, closest: () => null,
      querySelectorAll: (sel) => (/a\[href\]/.test(sel) ? [a('0:05', '/watch?v=' + VB + '&t=5s'), a('@channelb', '/@channelb')] : []) };
    const r3 = pm.read();
    check(!!r3 && r3.descRead === true && r3.descFrom === 'page' && r3.desc.text === B_DESC && r3.desc.links.length === 2 && r3.desc.links[1].h === '/@channelb' && PV.complete(r3) === true,
      'the page’s own description drawn for B: read, with its 2 links, and now complete', r3 && { descRead: r3.descRead, descFrom: r3.descFrom, links: r3.desc && r3.desc.links });
    const m3 = PV.model('youtube', r3, null, '');
    check(m3.descPending === false && m3.desc.links.length === 2, 'and the info takes them (nothing pending)', m3 && { descPending: m3.descPending, links: m3.desc && m3.desc.links });
    // a video with no description: this id's player data says so, and the read is complete without waiting for one
    const pn = ytPage(VB, VB);
    pn.nodes['#description-inline-expander yt-attributed-string'] = null;
    pn.nodes['#movie_player'] = { getPlayerResponse: () => ({ videoDetails: { videoId: VB, title: 'Video B title', author: 'Channel B', shortDescription: '' } }) };
    const rn = pn.read();
    check(!!rn && rn.descRead === true && PV.complete(rn) === true, 'no description at all (this id’s player data says so): read, complete, nothing waited for', rn && { descRead: rn.descRead, descFrom: rn.descFrom });
    // another id's player saying "none" never counts for this one
    const po = ytPage(VB, VB);
    po.nodes['#description-inline-expander yt-attributed-string'] = null;
    po.nodes['#movie_player'] = { getPlayerResponse: () => ({ videoDetails: { videoId: VA, title: 'Video A title', author: 'Channel A', shortDescription: '' } }) };
    const ro2 = po.read();
    check(!!ro2 && ro2.descRead === false && ro2.desc.text === '' && PV.complete(ro2) === false, 'another video’s player data is never taken for this one’s (no words, no “none”)', ro2 && { descRead: ro2.descRead, desc: ro2.desc });
    check(PV.complete(Object.assign({}, read)) === true && PV.complete(Object.assign({}, read, { descRead: false })) === false, 'complete(): a read with descRead false is not; one without the field counts as before');
  }
  check(PV.STALE_MS >= PV.READS[PV.READS.length - 1], 'a stale page is waited for at least a whole load’s span (' + PV.STALE_MS + ' ms), not the in-place reads’ 4 s', PV.STALE_MS);
  // An older guest still in the page (installed by the last Quartz): the new one replaces it, so the stale check is in.
  const old = ytPage(VB, VA, { __lumenPv: { v: 6, read: () => ({ ok: true, svc: 'youtube', title: 'Video A title', old: true }) } });
  const ro = old.read();
  check(!!ro && !ro.old && ro.stale === true && ro.title === '' && old.w.__lumenPv.v > 6, 'an older guest (v6) in the page is replaced by this one (v' + (old.w.__lumenPv && old.w.__lumenPv.v) + '): its read is stale-aware', ro);
}
// The watch on a stale page: YouTube's redraw ends it at once (the text, or the video-id attribute alone).
const staleW = { at: -1, r: null, rText: null };
{
  const pg = ytPage(VB, VA);
  const mo = [];
  pg.c.MutationObserver = function (fn) { const o = { fn, on: false, opts: null, observe(n, opts) { o.on = true; o.opts = opts; }, disconnect() { o.on = false; } }; mo.push(o); return o; };
  vm.runInContext(PV.call('tick', ['youtube', true]), pg.c);   // the stale read the chrome has
  const t0 = Date.now();
  vm.runInContext(PV.call('watch', ['youtube', true, 3000]), pg.c).then((r) => { staleW.r = r; staleW.at = Date.now() - t0; });
  staleW.mo = mo[mo.length - 1];
  setTimeout(() => { staleW.mo.fn([]); }, 40);   // something else on the page changes: still A's, still stale: no answer
  setTimeout(() => { staleW.early = staleW.r; pg.flexAttrs['video-id'] = VB; pg.nodes['#title h1'].textContent = 'Video B title'; staleW.mo.fn([{ type: 'attributes', attributeName: 'video-id' }]); }, 200);
}

/* ---- watch-playview-main.js -------------------------------------------------------------------------------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-test-'));
const handlers = {};
const ipc = { handle: (ch, fn) => { handlers[ch] = fn; } };
const chrome = { sender: { id: 1 } };
const winStub = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFullScreen: () => winStub.fs, fs: false, setFullScreen(v) { winStub.fs = v; }, isMaximized: () => false, getContentBounds: () => ({ x: -32000, y: -32000, width: 1280, height: 800 }) });
const logs = [];
const a = Main.create({ ipcMain: ipc, userData: dir, getWindow: () => winStub, isChromeSender: (e) => e === chrome, log: (l) => logs.push(l), test: true });
a.registerIpc();
check(a.view() === 'lumen', 'the default: Lumen view');
check(handlers['watch-playview:set-view'](chrome, { view: 'page' }).view === 'page' && JSON.parse(fs.readFileSync(path.join(dir, Main.PREFS_FILE), 'utf8')).view === 'page', 'set to the full page: saved to watch-playview.json');
const b2 = Main.create({ ipcMain: { handle() {} }, userData: dir, getWindow: () => null, test: false });
check(b2.view() === 'page', 'a fresh start reads it back');
check(handlers['watch-playview:set-view'](chrome, { view: 'javascript:1' }).view === 'lumen', 'junk is refused: back to the default');
let threw = false;
try { handlers['watch-playview:get']({ sender: { id: 9 } }, {}); } catch (e) { threw = /not the chrome/.test(e.message); }
check(threw, 'only the chrome may ask');
const tw = handlers['watch-playview:test-win'](chrome, {});
check(tw && tw.ok && tw.fullScreen === false && tw.content.width === 1280 && tw.entered === 0, 'TEST: the window’s real state');
winStub.fs = true; winStub.emit('enter-full-screen');
check(winStub.fs === false && handlers['watch-playview:test-win'](chrome, {}).entered === 1, 'TEST: OS fullscreen is undone at once and counted');
const h2 = {};
Main.create({ ipcMain: { handle: (ch, fn) => { h2[ch] = fn; } }, userData: dir, test: false }).registerIpc();
check(!h2['watch-playview:test-win'] && !!h2['watch-playview:get'], 'not a test profile: no window seam at all');
fs.writeFileSync(path.join(dir, Main.PREFS_FILE), '{not json');
check(Main.create({ userData: dir }).view() === 'lumen', 'a broken prefs file: the default');

/* ---- watch-player-yt.js's "Full page" button ------------------------------------------------------------------ */
const ytSrc = fs.readFileSync(path.join(ROOT, 'watch-player-yt.js'), 'utf8');
function ytIn(withPv) {
  const made = [];
  const mk = () => { const n = { hidden: false, textContent: '', title: '', attrs: {}, listeners: {}, className: '', setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.listeners[k] = f; }, click() { this.listeners.click({ stopPropagation() {} }); } }; made.push(n); return n; };
  const w = { WatchPlayerHosts: require(path.join(ROOT, 'watch-player-hosts')) };
  const toggled = [];
  if (withPv) w.LumenPlayview = { toggleFor: (s) => (s && s.pv ? { label: s.pv, title: 't' } : null), toggle: (s) => { toggled.push(s.id); return true; } };
  const c = vm.createContext({ window: w, self: w, document: { createElement: mk }, URL, Promise, console, JSON, Math, Number, String, Object });
  vm.runInContext(ytSrc.replace(/typeof module === 'object' && module\.exports/, 'false'), c);
  const Y = w.WatchPlayerYT;
  const barEl = { appendChild() {} };
  const s1 = { id: 1, view: {}, url: 'https://www.youtube.com/watch?v=abcDEF12345', service: 'youtube', pv: 'Full page' };
  const ctx = { focused: () => s1 };
  Y.bar(ctx, barEl);
  return { Y, ctx, s1, btn: made[0], toggled };
}
let t = ytIn(true);
t.Y.sync(t.ctx, t.s1);
check(!t.btn.hidden && t.btn.textContent === 'Full page', 'with the view: the full watch page shows “Full page”');
t.btn.click();
check(t.toggled.join() === '1', 'and its click toggles the view (no reload, no new URL)');
t.s1.pv = 'Lumen view'; t.Y.sync(t.ctx, t.s1);
check(t.btn.textContent === 'Lumen view' && !t.btn.hidden, 'in Full page it says “Lumen view”');
t.s1.pv = null; t.Y.sync(t.ctx, t.s1);
check(t.btn.hidden && t.btn.textContent === 'Full page', 'no view for the slot (the setting says full page): hidden on the watch page, as before');
t = ytIn(false);
t.Y.sync(t.ctx, t.s1);
check(t.btn.hidden === true, 'without watch-playview.js: the watch page has no button, as before');
t.s1.url = 'https://www.youtube.com/embed/abcDEF12345'; t.Y.sync(t.ctx, t.s1);
check(t.btn.hidden === false && t.btn.textContent === 'Full page', 'and the embed still offers “Full page”');

/* ---- r64: the read's watch (between the timed reads, answered as soon as the page draws something new) ---- */
check(PV.READS[0] === 0 && PV.READS[PV.READS.length - 1] === 8000, 'the first read is at once (dom-ready); the last timed read still says at 8 s', PV.READS);
const mos = [];
sb.MutationObserver = function (fn) { const o = { fn, on: false, opts: null, observe(n, opts) { o.on = true; o.opts = opts; }, disconnect() { o.on = false; } }; mos.push(o); return o; };
vm.runInContext(PV.call('tick', ['youtube', true]), sb);   // the read the chrome has
const w0 = Date.now();
let wr = null, wAt = 0;
vm.runInContext(PV.call('watch', ['youtube', true, 5000]), sb).then((r) => { wr = r; wAt = Date.now() - w0; });
const mo1 = mos[mos.length - 1];
check(!!mo1 && mo1.on && mo1.opts && mo1.opts.childList && mo1.opts.subtree && (!mo1.opts.attributes || JSON.stringify(mo1.opts.attributeFilter) === '["video-id"]'),
  'a watch observes the page’s own DOM (children and text; of the attributes only video-id, never the player’s churn)', mo1 && mo1.opts);
mo1.fn([]);   // a change the info doesn't show: no new read handed out
let wSame = null;
setTimeout(() => {
  wSame = wr;
  doc.title = 'Another title - YouTube';
  mo1.fn([]); mo1.fn([]); mo1.fn([]);   // three changes in a row: one read
}, 160);
let wq = null, wqAt = 0;
setTimeout(() => {
  const q0 = Date.now();
  vm.runInContext(PV.call('watch', ['youtube', true, 120]), sb).then((r) => { wq = r; wqAt = Date.now() - q0; });
}, 420);

// A player that turns up while a watch waits: the watch says so (canRoot) and never trims the page itself (the chrome
// does, or doesn't: after "the whole page shows" a late player must not be trimmed behind the bar's back).
let wp = null;
setTimeout(() => {
  const mp = { tagName: 'DIV', querySelector: (q) => (q === 'video' ? { tagName: 'VIDEO' } : null), hasAttribute: () => false, setAttribute: () => {}, removeAttribute: () => {} };
  vm.runInContext(PV.call('watch', ['youtube', true, 3000]), sb).then((r) => { wp = r; });
  doc.querySelector = (q) => (q === '#movie_player' ? mp : null);
  mos[mos.length - 1].fn([]);
}, 560);
setTimeout(() => {
  check(!!wp && wp.canRoot === true && wp.applied === false && !('data-lumen-pv' in attrs), 'a player turns up during a watch: it is said (canRoot), and the watch never trims the page itself', { wp: wp && { canRoot: wp.canRoot, applied: wp.applied }, attrs });
  doc.querySelector = () => null;
}, 820);
// The early read: the page's videoDetails (before its app has run), for this address's video only.
let e1 = null, e2 = 'pending', e2At = 0;
setTimeout(() => {
  win.ytInitialPlayerResponse = { videoDetails: { videoId: 'otherVID999', title: 'Another video', author: 'Someone' } };
  const t0 = Date.now();
  vm.runInContext(PV.call('early', [120]), sb).then((r) => { e2 = r; e2At = Date.now() - t0; });
}, 600);
setTimeout(() => {
  win.ytInitialPlayerResponse = { videoDetails: { videoId: 'abcDEF12345', title: 'Early title', author: 'The Channel', channelId: 'UCabc_123', shortDescription: 'See https://example.com/a at 1:05' } };
  vm.runInContext(PV.call('early', [3000]), sb).then((r) => { e1 = r; });
}, 760);
setTimeout(() => {
  check(e2 === null && e2At >= 100, 'early read: videoDetails for another video (an in-page move keeps the first one’s) is never used; null at its limit', { e2, e2At });
  check(!!e1 && e1.early && e1.title === 'Early title' && e1.channel && e1.channel.name === 'The Channel' && e1.channel.url === 'https://www.youtube.com/channel/UCabc_123' && e1.desc.text === 'See https://example.com/a at 1:05'
    && e1.like.found === false && e1.applied === false && e1.comments === null && !('data-lumen-pv' in attrs), 'early read: this video’s title, channel and description at once; no buttons, no trim, no comments token', e1);
  const em = e1 && PV.model('youtube', e1, null, '');
  check(!!em && em.title === 'Early title' && em.channel.name === 'The Channel' && em.desc.links.length === 0 && em.videoId === 'abcDEF12345', 'and the info draws from it (the plain description’s links come from its text)', em && { title: em.title, ch: em.channel });
  // r64 (#5): the early read stays the info's read until a later one lands. All the reads after it failing (took's
  // catch on the last one: phase 'unread', with why) used to leave lumen-pv-info saying early:true on every draw,
  // and the comments waited "Loading…" for good with no reason. early is said only while reads are still to come.
  check(!!e1 && PV.infoEarly('loading', e1) === true, 'early read, the reads still to come: lumen-pv-info says early (the comments wait one draw for the page’s own data)');
  check(!!e1 && PV.infoEarly('unread', e1) === false, 'early read, then every read failed (the info says unread, and why): early is false, so the comments start (the page’s data or /next) or say their own reason');
  check(!!e1 && ['partial', 'ready', 'failed', 'offline'].every((ph) => PV.infoEarly(ph, e1) === false), 'and in every other end state (partial, ready, failed, offline): false');
  check(PV.infoEarly('loading', Object.assign({}, e1, { early: undefined })) === false && PV.infoEarly('loading', null) === false, 'a page read (not the early one), or none: false, as before');
  delete win.ytInitialPlayerResponse;
}, 900);
setTimeout(() => {
  check(staleW.early === null, 'a watch on a stale page: another change while the page is still the last video’s answers nothing (the read is the same stale one)', staleW.early);
  check(!!staleW.r && staleW.r.stale === false && staleW.r.title === 'Video B title' && staleW.at >= 200 && staleW.at < 1000 && staleW.mo && !staleW.mo.on,
    'YouTube redraws for this video (video-id turns to B): the watch answers within a read gap (not at its 3 s limit) and lets go', { at: staleW.at, r: staleW.r && { stale: staleW.r.stale, title: staleW.r.title } });
}, 700);
setTimeout(() => {
  check(wSame === null, 'a page change that reads the same: the watch keeps waiting (nothing new to draw)');
  check(!!wr && wr.pageTitle === 'Another title - YouTube' && wAt < 1000 && !mo1.on, 'the page draws something new: the watch answers with it within a read gap, not at its 5 s limit, and lets go of the page', { wAt, title: wr && wr.pageTitle, on: mo1.on });
  check(!!wq && wq.ok && wq.pageTitle === 'Another title - YouTube' && wqAt >= 100 && wqAt < 1000 && !mos[mos.length - 1].on, 'nothing new: the watch answers at its limit with the same read, and lets go', { wqAt });
}, 800);

/* ---- a closed view holds nothing (r64) ------------------------------------------------------------------------- */
// lumen-perf: +650 nodes and +160 listeners per video view opened and closed, the whole view kept alive by a page call
// that never answered (a removed <webview>'s executeJavaScript: the watch's and the early read's long waits left one
// out at nearly every close). gate(): every call ends at its limit or at the slot's close; an answer after that is
// never applied, and nothing of the closed view waits on the page's promise.
const FD = require('./fake-dom');
const gcNow = FD.gcFn();
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const leakDone = (async () => {
  check(!!gcNow, 'node’s GC is reachable for the closed-view checks');
  const G = PV.gate();
  const never = new Promise(() => {});
  let late = null;
  const t0 = Date.now();
  await G.run(never, 60).then(() => { late = 'answered'; }, (e) => { late = e; });
  check(late && late.code === 'late' && /didn’t answer in 0\.1 s/.test(late.message) && Date.now() - t0 >= 50 && G.open() === 0,
    'a page call that never answers fails at its limit, with the reason, and is no longer out', late && (late.message || late));
  let ans = null, rej = null;
  await G.run(Promise.resolve({ ok: 1 }), 5000).then((r) => { ans = r; });
  await G.run(Promise.reject(new Error('page threw')), 5000).catch((e) => { rej = e; });
  check(ans && ans.ok === 1 && rej && rej.message === 'page threw' && G.open() === 0, 'an answer, or the page’s own error, passes through as it was (and its limit goes with it)');
  let answer = null, applied = false, out1 = null;
  const r1 = G.run(new Promise((ok) => { answer = ok; }), 0).then(() => { applied = true; }, (e) => { out1 = e; });
  const r2 = G.run(never, 0).catch((e) => e);
  const twoOut = G.open() === 2;
  G.close();
  await r1;
  const e2 = await r2;
  answer({ ok: true });   // the page answers after the close
  await wait(5);
  check(twoOut && out1 && out1.code === 'closed' && /view is closed/.test(out1.message) && e2 && e2.code === 'closed' && G.open() === 0, 'close() ends every call still out ("the view is closed")');
  check(!applied, 'an answer after the close is dropped, never applied');
  let after = null;
  await G.run(Promise.resolve(1), 100).then(() => { after = 'ran'; }, (e) => { after = e; });
  check(after && after.code === 'closed', 'a call after the close fails at once');
  if (gcNow) {
    const G2 = PV.gate();
    const held = new Promise(() => {});   // the page's promise: held, never answered
    const ref = (() => { const big = { rows: new Array(2000).fill('row') }; G2.run(held, 0).then(() => big.rows.length, () => big.rows.length); return new WeakRef(big); })();
    await FD.collect(gcNow);
    const kept = ref.deref() !== undefined;
    G2.close();
    await FD.collect(gcNow);
    check(kept && ref.deref() === undefined, 'what waits on a page that never answers is held while the call is out and released by close()');
  }

  // The chrome itself (a stand-in DOM, no layer: the info isn't drawn; the reads and the gate are what run).
  const W = FD.makeWindow({ api: { adblock: { state: () => Promise.resolve({ enabled: true }), onStateChanged() {} } } });
  W.load(path.join(ROOT, 'watch-playview.js'));
  const LP = W.win.LumenPlayview;
  const pctx = {};
  const URL0 = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const of = (calls, m) => calls.filter((c) => c.code.indexOf('__lumenPv.' + m + '(') >= 0);
  // A slot opened the way watch-player.js does, to the point where its page has an early read and a watch out.
  async function openSlot(id) {
    const pg = FD.page(W.doc);
    const s = { id, wcId: 7, service: 'youtube', url: URL0, item: null, tile: new FD.El(W.doc, 'div') };
    W.doc.body.appendChild(s.tile);
    s.view = pg.v;
    s.tile.appendChild(pg.v);
    LP.attach(pctx, s, pg.v);
    pg.v.dispatchEvent({ type: 'did-navigate', url: URL0 });   // the commit: the early read (EARLY_MS) goes out
    pg.v.dispatchEvent({ type: 'dom-ready' });                 // the timed reads begin, the first at once
    await wait(30);
    const t1 = of(pg.calls, 'tick')[0];
    if (t1) t1.ok({ ok: true, svc: 'youtube', url: URL0, title: 'First words', channel: null, like: { found: false }, sub: { found: false } });   // incomplete: a watch goes out
    await wait(10);
    return { s, pg };
  }
  // watch-player.js destroySlot's order: the hooks, then the view goes, then the tile.
  function closeSlot(o) { LP.destroy(pctx, o.s); o.s.view = null; o.pg.v.remove(); o.s.tile.remove(); }

  const A = await openSlot('A');
  const pA = A.s._pv;
  const outA = of(A.pg.calls, 'early').length === 1 && of(A.pg.calls, 'watch').length === 1 && !!pA.gate && pA.gate.open() === 2;
  check(outA, 'an opened video view: its early read and a watch are out on the page', A.pg.calls.map((c) => (/__lumenPv\.(\w+)\(/.exec(c.code) || [])[1]));
  pA.info.appendChild(new FD.El(W.doc, 'div'));   // as a drawn info would hold
  const callsAtClose = A.pg.calls.length;
  closeSlot(A);
  check(!!pA.gate && pA.gate.open() === 0 && pA.gate.shut() && pA.gone === true, 'destroy() ends every call still out on the closed view’s page');
  check(pA.info.childNodes.length === 0, 'destroy() empties the info (no title, description or comments mount left on it)');
  of(A.pg.calls, 'early')[0].ok({ ok: true, early: true, svc: 'youtube', url: URL0, title: 'Late early words', channel: { name: 'Late channel' } });
  of(A.pg.calls, 'watch')[0].ok({ ok: true, svc: 'youtube', url: URL0, title: 'Late watch words', channel: { name: 'C' }, like: { found: true }, sub: { found: true }, applied: false });
  await wait(20);
  check(pA.read && pA.read.title === 'First words' && pA.phase === 'loading', 'the closed view’s page answering late: nothing of it is applied', { title: pA.read && pA.read.title, phase: pA.phase });
  check(A.pg.calls.length === callsAtClose, 'and nothing more is asked of a closed view’s page', A.pg.calls.length - callsAtClose);
  check(!LP._state().slots.some((x) => x.id === 'A'), 'the closed slot is no longer one of the view’s slots');

  if (gcNow) {
    // The leak itself: a closed view whose page never answers (its early read and watch out for good) is collected.
    const B = await openSlot('B');
    const pending = B.pg.calls.filter((c) => !/__lumenPv\.tick\(/.test(c.code));   // held, as the page holds them
    const refs = { slot: new WeakRef(B.s), tile: new WeakRef(B.s.tile), info: new WeakRef(B.s._pv.info), view: new WeakRef(B.pg.v) };
    closeSlot(B);
    B.s = null; B.pg = null;
    await FD.collect(gcNow);
    const alive = Object.keys(refs).filter((k) => refs[k].deref() !== undefined);
    check(pending.length === 2 && alive.length === 0, 'a closed video view whose page never answers is collected whole (slot, tile, info, view)', { pending: pending.length, alive });
  }
})();

setTimeout(() => {
  check(pr && pr.ok === false && /Like button isn’t on this page/.test(pr.reason), 'a press with no button on the page: refused, with the reason (never a silent no-op)', pr);
  check(prOther && prOther.ok === false, 'nothing is pressed on Disney+, Hulu, Prime or ESPN');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
  leakDone.catch((e) => check(false, 'the closed-view checks ran to the end', e && e.stack)).then(() => {
    console.log('watch-playview-test: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  });
}, 1000);
