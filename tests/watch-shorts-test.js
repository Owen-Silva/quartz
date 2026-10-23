// tests/watch-shorts-test.js -- Lumen's Shorts view's pure parts, no Electron, no network:
//   watch-shorts.js:      which URLs are Shorts pages (and so open in the Shorts view), the URLs Lumen's
//                         ways in open, the wheel as one Short per gesture (a trackpad burst and its inertia
//                         = ONE move), Up/Down, the info following the current Short, the layout (beside /
//                         below, the Short’s own shape clamped to 9:16 ... 1:1; the in-page shape read), the trim CSS (inert until the page's flag; the player, ads and consent
//                         never hidden) and the in-page script;
//   watch/ytlib-page.js:  the channel's Shorts, Subscriptions' Shorts and the row's Shorts open in Lumen;
//   watch-shorts-main.js: its quartz.log lines (chrome only, cleaned, repeats dropped).
// One summary line: "watch-shorts-test: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined && !cond ? '  ' + JSON.stringify(detail).slice(0, 300) : ''));
}
const ROOT = path.join(__dirname, '..');
const SH = require(path.join(ROOT, 'watch-shorts'));
const PV = require(path.join(ROOT, 'watch-playview'));
const Main = require(path.join(ROOT, 'watch-shorts-main'));
const YtLib = require(path.join(ROOT, 'watch', 'ytlib'));

/* ---- route: which pages are the Shorts view's ------------------------------------------------- */
const R = (u, s) => SH.route(u, s);
check(JSON.stringify(R('https://www.youtube.com/shorts/aB3dE5gH7jK')) === '{"kind":"short","id":"aB3dE5gH7jK"}', 'a Short is a short, with its id');
check(R('https://m.youtube.com/shorts/aB3dE5gH7jK/').kind === 'short' && R('https://youtube.com/shorts/aB3dE5gH7jK?feature=share').id === 'aB3dE5gH7jK', 'm. and bare youtube.com, a trailing slash and a query count');
check(R('https://www.youtube.com/shorts').kind === 'feed' && R('https://www.youtube.com/shorts/').kind === 'feed', 'youtube.com/shorts is the feed');
check(JSON.stringify(R('https://www.youtube.com/@guitarcoachryan/shorts')) === '{"kind":"channel","path":"/@guitarcoachryan"}', 'a channel’s Shorts tab is a channel, with its path');
check(R('https://www.youtube.com/channel/UC1234567890abcdefghijkl/shorts').kind === 'channel' && R('https://www.youtube.com/c/Name/shorts').kind === 'channel' && R('https://www.youtube.com/user/name/shorts').kind === 'channel', '/channel/, /c/ and /user/ Shorts tabs too');
check(R('https://www.youtube.com/feed/subscriptions/shorts').kind === 'subs', 'Subscriptions’ Shorts is subs');
check(R('https://www.youtube.com/watch?v=aB3dE5gH7jK') === null && R('https://www.youtube.com/@guitarcoachryan') === null && R('https://www.youtube.com/@x/videos') === null, 'a video, a channel and its Videos tab are not Shorts pages');
check(R('https://www.youtube.com/shorts/bad id') === null && R('https://www.youtube.com/shorts/x') === null, 'a Short id YouTube can’t have is no Short');
check(R('https://evil.example/shorts/aB3dE5gH7jK') === null && R('https://evil.example/shorts/aB3dE5gH7jK', 'disney') === null, 'another host is no Short');
check(R('http://127.0.0.1:5555/shorts/aB3dE5gH7jK', 'youtube').kind === 'short' && R('http://127.0.0.1:5555/shorts/aB3dE5gH7jK') === null, 'a test origin counts by the slot’s service only');
check(R('javascript:alert(1)') === null && R('file:///C:/shorts/aB3dE5gH7jK') === null && R('') === null && R(null) === null, 'not a web page: null');
check(SH.idOf('https://www.youtube.com/shorts/aB3dE5gH7jK') === 'aB3dE5gH7jK' && SH.idOf('https://www.youtube.com/shorts') === '' && SH.idOf('https://www.youtube.com/@x/shorts') === '', 'idOf: only a Short has an id');

/* ---- the ways in -------------------------------------------------------------------------------- */
check(SH.entryUrl('feed') === 'https://www.youtube.com/shorts' && R(SH.entryUrl('feed')).kind === 'feed', 'Lumen’s Shorts entry opens youtube.com/shorts, a Shorts page');
check(SH.entryUrl('channel', '/@guitarcoachryan') === 'https://www.youtube.com/@guitarcoachryan/shorts' && R(SH.entryUrl('channel', '/@guitarcoachryan')).kind === 'channel', 'a channel’s Shorts button opens its Shorts tab, a Shorts page');
check(SH.entryUrl('channel', 'https://evil.example') === '' && SH.entryUrl('short', 'no') === '' && SH.entryUrl('nope') === '', 'a junk path or id: no URL');
check(R(YtLib.channelShortsUrl('/@guitarcoachryan')).kind === 'channel', 'ytlib’s channelShortsUrl is a Shorts page');
check(R(SH.entryUrl('subs')).kind === 'subs' && R(SH.entryUrl('short', 'hmShorts004')).id === 'hmShorts004', 'Subscriptions’ Shorts and a Short tile route to the view');
// A Shorts tile on the home row is built by the YouTube adapter as ORIGIN/shorts/<id> (watch/adapters/youtube.js).
const adapterSrc = fs.readFileSync(path.join(ROOT, 'watch', 'adapters', 'youtube.js'), 'utf8');
check(/isShort \? ORIGIN \+ '\/shorts\/' \+ id/.test(adapterSrc), 'the home row’s Shorts tiles carry /shorts/<id> URLs (the view’s)');
check(PV.pageKind('https://www.youtube.com/shorts/aB3dE5gH7jK', 'youtube') === 'shorts' && PV.viewable('shorts') === false, 'the playback view leaves a Short to the Shorts view (never boxes it 16:9)');
const ytp = fs.readFileSync(path.join(ROOT, 'watch', 'ytlib-page.js'), 'utf8');
check(/shortsBtn\('Shorts', ORIGIN \+ v\.path \+ '\/shorts'/.test(ytp) && !/hostedBtn\('Shorts'/.test(ytp), 'the channel page’s Shorts button opens in Lumen, with no external-link mark');
check(/shortsBtn\('Open Shorts', ORIGIN \+ '\/feed\/subscriptions\/shorts'/.test(ytp) && /shortsBtn\('Shorts', ORIGIN \+ '\/shorts'/.test(ytp), 'Subscriptions’ Shorts note and the row’s plain Shorts entry open in Lumen');
check(/function shortsBtn[\s\S]{0,200}H\.openUrl\(url, ttl\)/.test(ytp) && !/function shortsBtn[\s\S]{0,200}icon\('out'/.test(ytp), 'shortsBtn plays through openUrl (the player layer), never a tab');
const wp = fs.readFileSync(path.join(ROOT, 'watch-player.js'), 'utf8');
check(/window\.LumenPlayview,( window\.LumenPlayerBar,)? window\.LumenShorts\]/.test(wp), 'watch-player.js calls the Shorts view at its hooks (last, after the play bar when it is there)');

/* ---- the wheel: one Short per gesture ---------------------------------------------------------- */
function feed(events) {
  let st = null; const steps = [];
  for (const e of events) { const g = SH.gesture(st, e); st = g.st; if (g.step) steps.push(g.step); }
  return steps;
}
check(feed([{ dy: 100, t: 1000 }]).join() === '1', 'one mouse-wheel notch down: one Short');
check(feed([{ dy: -100, t: 1000 }]).join() === '-1', 'one notch up: one Short back');
// A trackpad swipe: a burst of small deltas and a long inertia tail, 16 ms apart, 1.6 s in all.
const burst = []; let t = 5000;
for (let i = 0; i < 100; i++) { burst.push({ dy: Math.max(1, Math.round(38 * Math.pow(0.955, i))), t }); t += 16; }
check(feed(burst).join() === '1', 'a trackpad burst (100 small deltas, 1.6 s of inertia): exactly ONE Short', feed(burst));
check(feed(burst.map((e) => ({ dy: -e.dy, t: e.t }))).join() === '-1', 'the same burst upward: exactly one Short back');
check(feed([{ dy: 100, t: 1000 }, { dy: 100, t: 1090 }, { dy: 100, t: 1180 }]).join() === '1', 'a quick flick of three notches (one gesture): one Short');
check(feed([{ dy: 100, t: 1000 }, { dy: 100, t: 1500 }]).join() === '1,1', 'two notches half a second apart: two Shorts');
check(feed([{ dy: 3, t: 1000 }, { dy: 4, t: 1016 }, { dy: 3, t: 1032 }, { dy: 2, t: 1048 }]).length === 0, 'a twitch (12px in all): no move');
check(feed([{ dy: 8, t: 1000 }, { dy: 9, t: 1016 }, { dy: 10, t: 1032 }]).join() === '1', 'small deltas add up within a gesture: one move once past the threshold');
check(feed([{ dy: 0, dx: 120, t: 1000 }]).length === 0, 'a sideways swipe moves no Short');
check(feed([{ dy: 3, mode: 1, t: 1000 }]).join() === '1', 'deltaMode lines (3 lines) is a notch');
// A second swipe inside the first one's inertia (a rise far over the decaying tail) is a new gesture...
const two = burst.slice(0, 40).concat([{ dy: 60, t: burst[39].t + 16 }, { dy: 50, t: burst[39].t + 32 }]);
check(feed(two).join() === '1,1', 'a new swipe inside the inertia (a sharp rise): one more Short', feed(two));
// ...but never within the lock after a move (the snap is still running).
const fast = [{ dy: 30, t: 1000 }, { dy: 2, t: 1016 }, { dy: 80, t: 1032 }];
check(feed(fast).join() === '1', 'a rise within the lock after a move: no second move');
check(feed([{ dy: 100, t: 1000 }, { dy: 6, t: 1016 }, { dy: -90, t: 1500 }]).join() === '1,-1', 'down then, later, up: one each way');

/* ---- keys --------------------------------------------------------------------------------------- */
check(SH.keyStep({ key: 'ArrowDown' }) === 1 && SH.keyStep({ key: 'ArrowUp' }) === -1, 'ArrowDown: next; ArrowUp: previous');
check(SH.keyStep({ key: 'ArrowDown', altKey: true }) === 0 && SH.keyStep({ key: 'ArrowUp', ctrlKey: true }) === 0 && SH.keyStep({ key: 'j' }) === 0, 'with a modifier, or another key: nothing');

/* ---- the info follows the current Short ---------------------------------------------------------- */
const read = (id, title) => ({ ok: true, videoId: id, title, channel: { name: '@chan' }, like: { found: true }, sub: { found: true } });
let f = SH.follow('aB3dE5gH7jK', read('aB3dE5gH7jK', 'One'), '');
check(f.fresh && f.moved && f.id === 'aB3dE5gH7jK', 'the first read of the current Short: shown (fresh, moved from nothing)');
f = SH.follow('cD4eF6hI8kL', read('aB3dE5gH7jK', 'One'), 'aB3dE5gH7jK');
check(!f.fresh && f.moved, 'the page moved on but the read is still the last Short’s: NOT shown (the new one’s skeleton instead)');
f = SH.follow('cD4eF6hI8kL', read('cD4eF6hI8kL', 'Two'), 'aB3dE5gH7jK');
check(f.fresh && f.moved, 'the new Short’s own read: shown');
f = SH.follow('cD4eF6hI8kL', read('cD4eF6hI8kL', 'Two'), 'cD4eF6hI8kL');
check(f.fresh && !f.moved, 'the same Short read again: shown, not a move');
check(!SH.follow('', read('aB3dE5gH7jK', 'One'), '').fresh && !SH.follow('aB3dE5gH7jK', null, '').fresh, 'no current Short (a grid), or no read: nothing shown');
// A sequence: the shown Short always equals the page's current one.
let shown = '', ok = true;
const seq = [['s1', 's1'], ['s2', 's1'], ['s2', 's2'], ['s3', 's2'], ['s2', 's3'], ['s2', 's2']].map(([cur, rid]) => [cur.replace('s', 'shortId000'), rid.replace('s', 'shortId000')]);
for (const [cur, rid] of seq) { const g = SH.follow(cur, read(rid, rid), shown); if (g.fresh) shown = g.id; if (g.fresh && shown !== cur) ok = false; }
check(ok && shown === 'shortId0002', 'over next, next, previous: Lumen never shows one Short’s info on another');
check(SH.complete(read('aB3dE5gH7jK', 'One')) && !SH.complete(read('', 'One')) && !SH.complete(Object.assign(read('aB3dE5gH7jK', 'One'), { sub: { found: false } })), 'a read is complete with its id, title, channel, Like and Subscribe');
const m = PV.model('youtube', read('aB3dE5gH7jK', 'One'), null, '', { moved: true });
check(m.title === 'One' && m.channel.name === '@chan' && m.buttons.like.found && m.missing.indexOf('dislike') >= 0, 'the info’s model is the playback view’s (the same words, the same missing buttons)');

/* ---- the layout --------------------------------------------------------------------------------- */
const wide = SH.box(1256, 740);
check(wide.mode === 'beside' && Math.abs(wide.vw / wide.vh - 9 / 16) < 0.01 && wide.vh === 740 - 32, 'a 1280-wide layer: the player 9:16, as tall as allowed, the info beside', wide);
check(Math.abs((wide.x + wide.vw / 2) - 1256 / 2) <= 1 && wide.infoX >= wide.navX + 44 + 16 && wide.navX >= wide.x + wide.vw + 16 && wide.infoX + wide.infoW <= 1256, 'beside: the player centred; Previous/Next then the info to its right, inside the layer', wide);
const big = SH.box(1896, 940);
check(big.mode === 'beside' && big.infoW <= 420 && big.infoW >= 340, 'a 1920-wide layer: beside, the info 340-420px', big);
const narrow = SH.box(760, 740);
check(narrow.mode === 'below' && narrow.infoY >= narrow.y + narrow.vh + 16 && narrow.infoY + 150 <= 740 && Math.abs(narrow.vw / narrow.vh - 9 / 16) < 0.01, 'a narrow layer: the info below, the player shorter so it fits', narrow);
check(narrow.infoX >= 0 && narrow.infoX + narrow.infoW <= 760 && narrow.navX + 44 <= 760, 'below: nothing off the layer', narrow);

/* ---- the layout: the Short's own shape ---------------------------------------------------------- */
// A Short's box follows its own shape (YouTube: a 3:4 Short gets 572x762 at a 1919x858 page), clamped to 9:16 ... 1:1.
const SHAPES = [['9:16', 9 / 16, 9 / 16], ['3:4', 3 / 4, 3 / 4], ['1:1', 1, 1], ['16:9 (clamps to 1:1)', 16 / 9, 1], ['1:3 (clamps to 9:16)', 1 / 3, 9 / 16]];
const PAGES = [[1919, 858], [1919, 814], [1896, 940], [1280, 671], [1256, 740], [1100, 740], [760, 740]];
check(SH.shape(0) === 9 / 16 && SH.shape(NaN) === 9 / 16 && SH.shape(undefined) === 9 / 16 && SH.shape(-1) === 9 / 16 && SH.shape(Infinity) === 9 / 16, 'a shape not known yet is 9:16');
check(SH.shape(16 / 9) === 1 && SH.shape(1 / 3) === 9 / 16 && SH.shape(3 / 4) === 3 / 4, 'a shape is clamped to 9:16 ... 1:1');
let same916 = true, shapeOk = true, inside = true, modeKept = true, centred = true, tallest = true; const bad = [];
for (const [W, H] of PAGES) {
  const b0 = SH.box(W, H);
  if (JSON.stringify(SH.box(W, H, 9 / 16)) !== JSON.stringify(b0) || JSON.stringify(SH.box(W, H, 0)) !== JSON.stringify(b0)) { same916 = false; bad.push(['916', W, H]); }
  for (const [name, a, want] of SHAPES) {
    const b = SH.box(W, H, a);
    // Rounding: within a pixel of the clamped shape.
    if (Math.abs(b.vw - b.vh * want) > 1) { shapeOk = false; bad.push([name, W, H, b.vw, b.vh]); }
    if (b.mode !== b0.mode) { modeKept = false; bad.push(['mode', name, W, H]); }
    if (b.x < 0 || b.x + b.vw > W || b.y + b.vh > H || b.navX + 44 > W || b.infoX < 0 || b.infoX + b.infoW > W) { inside = false; bad.push(['inside', name, W, H, b]); }
    if (b.mode === 'beside' && (Math.abs(b.x + b.vw / 2 - W / 2) > 1 || b.infoX < b.navX + 44 + 16 || b.navX < b.x + b.vw + 16)) { centred = false; bad.push(['centre', name, W, H]); }
    // A wider shape is never taller than 9:16's box, and as tall as it whenever it fits beside at full height.
    if (b.vh > b0.vh) { tallest = false; bad.push(['taller', name, W, H]); }
  }
}
check(same916, '9:16, or a shape not known yet: exactly the old 9:16 box at every size', bad.filter((x) => x[0] === '916'));
check(shapeOk, 'every shape at every size: the box is the Short’s shape (clamped), within a pixel', bad.filter((x) => typeof x[1] === 'number' && x[0] !== '916'));
check(modeKept, 'the shape never moves the info between beside and below (the mode is 9:16’s)', bad.filter((x) => x[0] === 'mode'));
check(inside && centred, 'every shape: the player centred, nav and info beside it, nothing off the layer', bad.filter((x) => x[0] === 'inside' || x[0] === 'centre'));
check(tallest, 'a wider Short is never taller than a 9:16 one', bad.filter((x) => x[0] === 'taller'));
const yt = SH.box(1919, 858, 608 / 810);
check(yt.mode === 'beside' && yt.vh === 826 && yt.vw === 620, 'a 3:4 Short (608x810) at a 1919x858 layer: 620x826 (YouTube: 572x762 at height - 96; Lumen keeps its own height)', yt);
const ytTile = SH.box(1919, 814, 608 / 810), yt916 = SH.box(1919, 814, 9 / 16);
check(ytTile.vh === 782 && ytTile.vw === 587 && yt916.vw === 440 && Math.abs(ytTile.vw / 572 - yt916.vw / 429) < 0.01, 'at the 1919x942 window’s tile: 3:4 is 587x782, 9:16 440x782: both the same ~3% over YouTube’s 572x762 / 429x762', { ytTile, yt916 });
const sq = SH.box(1280, 671, 1), q34 = SH.box(1280, 671, 3 / 4), q916 = SH.box(1280, 671, 9 / 16);
check(sq.mode === 'beside' && sq.vw === 448 && sq.vh === 448 && q34.vw === 448 && q34.vh === 597 && q916.vw === 359 && q916.vh === 639,
  'a 1280x800 window (1280x671 tile): 9:16 359x639; 3:4 and 1:1 as wide as the room beside allows (448), shorter', { sq, q34, q916 });
const nb = SH.box(760, 740, 3 / 4);
check(nb.mode === 'below' && nb.vh === 520 && nb.vw === 390 && nb.infoY >= nb.y + nb.vh + 16, 'below: a 3:4 Short as tall as 9:16’s (520), wider (390), the info under it', nb);
check(SH.ASP.EASE <= 150 && SH.ASP.EVERY > 0 && SH.ASP.POLL > 0, 'a new shape eases in at most 150 ms', SH.ASP);
const css2 = fs.readFileSync(path.join(ROOT, 'watch-shorts.css'), 'utf8');
check(/\[data-sh-ease\] > \.wp-view[\s\S]*?transition: left 120ms/.test(css2) && /prefers-reduced-motion: reduce\)[\s\S]*?\[data-sh-ease\][\s\S]*?transition: none !important/.test(css2), 'the ease is 120 ms in the CSS (under the 150 ms limit), none with reduced motion');

/* ---- the trim ----------------------------------------------------------------------------------- */
const css = SH.trimCss();
const rules = css.split('}').map((r) => r.trim()).filter(Boolean);
check(rules.every((r) => r.split('{')[0].replace(/:not\(:has\([^)]*\)\)/g, '').replace(/:has\([^)]*\)/g, '').split(',').every((sel) => /^html\[data-lumen-sh\]/.test(sel.trim()))), 'every rule waits for the page’s <html data-lumen-sh> (inert until Lumen sets it)');
check(/#masthead-container/.test(css) && /reel-action-bar-view-model/.test(css) && /yt-reel-metapanel-view-model/.test(css) && /#navigation-container/.test(css), 'YouTube’s masthead, its action bar, its title overlay and its up/down buttons are hidden (Lumen draws its own)');
const hidden = css.slice(css.lastIndexOf('\n') + 1);
check(!/#shorts-player[^-]|video|\.ytp-|ytd-player|consent|error/.test(hidden.replace(/:not\(:has\([^)]*\)\)/g, '')), 'the hide list never names the player, its controls (.ytp-), the video, consent or errors', hidden.slice(0, 200));
check(/:not\(:has\(ytd-ad-slot-renderer/.test(hidden) && /ytd-consent-bump-v2-lightbox/.test(css) && /yt-playability-error-supported-renderers/.test(css), 'an ad’s own panel is never hidden; consent and errors are kept visible');
check(/\[data-lumen-sh-root\] \{ visibility: visible !important; position: fixed/.test(css) && /> body \{ visibility: hidden/.test(css), 'the Shorts app is laid over the page’s viewport; the rest is invisible');

/* ---- the in-page script -------------------------------------------------------------------------- */
let parses = true;
try { new Function(SH.call('step', [1])); new Function(SH.call('press', ['like', null])); } catch (e) { parses = false; }
check(parses && SH.call('step', [1]).indexOf('window.__lumenSh.step(1)') > 0, 'the page script is self-contained JavaScript and calls the asked method');
const gsrc = String(SH.guest);
check(!/fetch\(|XMLHttpRequest|\.src\s*=|mediaSource|captureStream|requestFullscreen/.test(gsrc), 'the page script fetches nothing, pulls no stream and asks no fullscreen');
check(/navigation-button-down button/.test(gsrc) && /scrollBy\(\{ top: dir \* box\.clientHeight, behavior: 'smooth' \}\)/.test(gsrc), 'Next/Previous press YouTube’s own buttons, else scroll its own snap container one Short');

/* ---- the in-page shape read (guest aspect()) ----------------------------------------------------- */
{
  const vm = require('vm');
  const ev = {};
  const video = { readyState: 0, videoWidth: 0, videoHeight: 0, currentSrc: 'blob:a', addEventListener: (k, fn) => { ev[k] = fn; } };
  let pdata = null;
  const player = { getVideoData: () => (pdata ? { video_id: pdata.id } : {}), getPlayerResponse: () => (pdata ? { streamingData: { adaptiveFormats: [{ mimeType: 'audio/mp4' }, { width: pdata.w, height: pdata.h }] } } : {}) };
  const reel = { getBoundingClientRect: () => ({ top: 0, bottom: 800, height: 800 }), querySelector: (sel) => (sel === '#shorts-player video' ? video : sel === '#shorts-player' ? player : null) };
  const doc = { documentElement: { hasAttribute: () => false, setAttribute() {}, removeAttribute() {} },
    querySelector: (sel) => (sel === 'ytd-reel-video-renderer[is-active]' ? reel : null), querySelectorAll: (sel) => (sel === 'ytd-reel-video-renderer' ? [reel] : []) };
  const win = { addEventListener() {}, innerHeight: 800 };
  const loc = { pathname: '/shorts/aaaaaaaaaaa', href: 'https://www.youtube.com/shorts/aaaaaaaaaaa' };
  const ctx = vm.createContext({ window: win, document: doc, location: loc, innerHeight: 800, setTimeout, clearTimeout, Event: function () {} });
  vm.runInContext('(' + String(SH.guest) + ')();', ctx);
  const A = () => win.__lumenSh.aspect();
  const a0 = A();
  check(a0.w === 0 && !a0.fresh, 'before the video’s metadata (and no player data): no shape yet', a0);
  pdata = { id: 'aaaaaaaaaaa', w: 608, h: 810 };
  const a1 = A();
  check(a1.from === 'player' && a1.w === 608 && a1.h === 810 && a1.fresh, 'YouTube’s player data for THIS Short: its shape, before the video loads', a1);
  pdata = { id: 'zzzzzzzzzzz', w: 1080, h: 1080 };
  check(A().w === 0, 'player data for another Short is never used');
  pdata = null;
  Object.assign(video, { readyState: 1, videoWidth: 608, videoHeight: 810 });
  const a2 = A();
  check(a2.from === 'video' && a2.w === 608 && a2.h === 810 && a2.fresh, 'once the video has its metadata: the video’s own size, this Short’s', a2);
  // A move: the address is the next Short's, the one player still holds the last Short's video.
  loc.pathname = '/shorts/bbbbbbbbbbb';
  const a3 = A();
  check(a3.w === 608 && !a3.fresh, 'just after a move, the old video: its size (what shows), but NOT fresh (the chrome keeps asking)', a3);
  Object.assign(video, { videoWidth: 720, videoHeight: 1280, currentSrc: 'blob:b' });
  const a4 = A();
  check(a4.w === 720 && a4.h === 1280 && a4.fresh, 'the next Short’s video (a new source): its size, fresh', a4);
  loc.pathname = '/shorts/ccccccccccc';
  Object.assign(video, { videoWidth: 1080, videoHeight: 1080 });
  ev.loadedmetadata.call(video);
  const a5 = A();
  check(typeof ev.resize === 'function' && a5.w === 1080 && a5.fresh, 'its loadedmetadata (same source) marks the size as this Short’s', a5);
}

const pending = [];   // async checks, all settled before the summary line
/* ---- r62: a press is for the Short Lumen names (guest press(kind, arg, forId)) ---------------------- */
{
  const vm = require('vm');
  let pdata = { id: 'aaaaaaaaaaa' };
  const like = { clicks: 0, getAttribute: (k) => (k === 'aria-pressed' ? 'false' : ''), click() { this.clicks++; } };
  const player = { getVideoData: () => (pdata ? { video_id: pdata.id } : {}), getPlayerResponse: () => ({}) };
  const reel = { getBoundingClientRect: () => ({ top: 0, bottom: 800, height: 800 }), querySelector: (sel) => (sel === '#shorts-player' ? player : sel === 'like-button-view-model button' ? like : null) };
  const doc = { documentElement: { hasAttribute: () => false, setAttribute() {}, removeAttribute() {} },
    querySelector: (sel) => (sel === 'ytd-reel-video-renderer[is-active]' ? reel : null), querySelectorAll: (sel) => (sel === 'ytd-reel-video-renderer' ? [reel] : []) };
  const win = { addEventListener() {}, innerHeight: 800 };
  const loc = { pathname: '/shorts/aaaaaaaaaaa', href: 'https://www.youtube.com/shorts/aaaaaaaaaaa' };
  const ctx = vm.createContext({ window: win, document: doc, location: loc, innerHeight: 800, setTimeout, clearTimeout, Event: function () {}, Promise, Date });
  vm.runInContext('(' + String(SH.guest) + ')();', ctx);
  const P = (forId) => win.__lumenSh.press('like', null, forId);
  pending.push((async () => {
    pdata = { id: 'bbbbbbbbbbb' };   // the address still says a, YouTube's one player already plays b
    const r1 = await P('aaaaaaaaaaa');
    check(!r1.ok && /Short changed/.test(r1.reason) && like.clicks === 0, 'r62: the player already holds the next Short: the press is refused, nothing clicked', r1);
    pdata = { id: 'aaaaaaaaaaa' }; loc.pathname = '/shorts/ccccccccccc';
    const r2 = await P('aaaaaaaaaaa');
    check(!r2.ok && /Short changed/.test(r2.reason) && like.clicks === 0, 'r62: the address moved on: the press is refused, nothing clicked', r2);
    loc.pathname = '/shorts/aaaaaaaaaaa';
    const r3 = P('aaaaaaaaaaa');
    check(like.clicks === 1, 'r62: the Short Lumen names is the page\'s: YouTube\'s Like is clicked once', like.clicks);
    pdata = null;   // no player data (an older page): the address alone decides
    P('aaaaaaaaaaa');
    check(like.clicks === 2, 'r62: no player data: the address decides, the press goes through', like.clicks);
    void r3;
  })().catch((e) => check(false, 'r62 press harness', String(e && e.stack || e))));
}
check(SH.initial('🎮 Gamer') === '🎮' && SH.initial('@élan') === 'É' && SH.initial('👨‍👩‍👧 fam') === '👨‍👩‍👧' && SH.initial('@') === '' && SH.initial('@abc') === 'A',
  'r62: a channel\'s initial is its first whole character (an emoji, never half of one), upper-cased', [SH.initial('🎮 Gamer'), SH.initial('👨‍👩‍👧 fam')]);
check(/e\.repeat\) return;/.test(fs.readFileSync(path.join(ROOT, 'watch-shorts.js'), 'utf8')), 'r62: a held arrow in the chrome is one Short (auto-repeat is ignored)');

/* ---- watch-shorts-main.js ----------------------------------------------------------------------- */
const lines = []; let clock = 1000;
const mm = Main.create({ log: (l) => lines.push(l), now: () => clock });
check(mm.write('opened: short') === true && lines[0] === 'opened: short', 'a line is written');
check(mm.write('opened: short') === false && lines.length === 1, 'the same line again within 5 s: dropped');
clock += 6000;
check(mm.write('opened: short') === true && lines.length === 2, 'after 5 s: written again');
check(mm.write('a\u0000b\nc') === true && lines[2] === 'a b c' && mm.write('') === false && Main.cleanLine('x'.repeat(500)).length === 200, 'control characters cleaned, empty dropped, 200 chars at most');
const ipc = new EventEmitter(); const handlers = {};
ipc.handle = (ch, fn) => { handlers[ch] = fn; };
const m2 = Main.create({ ipcMain: ipc, isChromeSender: (e) => e && e.chrome === true, log: () => {} });
m2.registerIpc();
let threw = false;
try { handlers['watch-shorts:log']({ chrome: false }, { line: 'x' }); } catch (e) { threw = true; }
check(threw && handlers['watch-shorts:log']({ chrome: true }, { line: 'opened: feed' }).ok === true, 'the IPC answers the chrome only');

// r63: Share's link is YouTube's own address for the Short; nothing for no Short. The page's own Comments and Share
// stay under the trim (Lumen draws its own), and its comments panel stays hidden.
check(SH.shortUrl('Xk3pQ9vLm2A') === 'https://www.youtube.com/shorts/Xk3pQ9vLm2A' && SH.shortUrl('') === '' && SH.shortUrl('a/b?c') === '' && SH.shortUrl(null) === '',
  'r63: Share’s link is https://www.youtube.com/shorts/<id>, and nothing without a Short');
check(SH.HIDE.indexOf('reel-action-bar-view-model') >= 0 && SH.HIDE.indexOf('ytd-shorts ytd-engagement-panel-section-list-renderer') >= 0,
  'r63: YouTube’s own action bar (its Comments, Share) and its comments panel stay under the trim');

/* ---- r64: the read the moment the page has it (guest until()), and a move's lag ------------------------------ */
// The page answers an ask at once when its read differs from what the chrome has (sig), else when YouTube's app
// changes under it (a MutationObserver), else at the ask's time limit (final). One wait at a time; stop() ends it.
// For a moment after the address names the next Short, a read whose player or title is still the last Short's is
// not the new Short's (videoId ''), so the info never names the new Short with the old one's title.
{
  const vm = require('vm');
  const attrs = {};
  const obs = [];
  // (the page's own is-active watch, watchActive(), filters is-active alone: only the read's waits are counted)
  class MO { constructor(fn) { this.fn = fn; this.on = false; obs.push(this); } observe(t, o) { this.on = true; this.wait = !(o && o.attributeFilter && o.attributeFilter.length === 1); } disconnect() { this.on = false; } }
  const fire = (recs) => obs.filter((o) => o.on).forEach((o) => o.fn(recs || [{ type: 'childList' }]));
  const live = () => obs.filter((o) => o.on && o.wait).length;
  let title = 'First Short', chan = '@one', pid = 'aaaaaaaaaaa';
  const node = (t) => ({ textContent: t, getAttribute: () => null, href: 'https://www.youtube.com/' + t });
  const player = { getVideoData: () => ({ video_id: pid }), getPlayerResponse: () => ({}) };
  const video = { readyState: 0, videoWidth: 0, videoHeight: 0, currentSrc: '', addEventListener() {} };
  const reel = { getBoundingClientRect: () => ({ top: 0, bottom: 800, height: 800 }), hasAttribute: () => false, setAttribute() {}, removeAttribute() {},
    querySelector: (sel) => (sel === 'yt-shorts-video-title-view-model h2' ? node(title) : sel === 'yt-reel-channel-bar-view-model a[href*="/@"]' ? node(chan)
      : sel === '#shorts-player' ? player : sel === '#shorts-player video' ? video : null) };
  const app = { hasAttribute: (k) => !!attrs['app:' + k], setAttribute: (k) => { attrs['app:' + k] = 1; }, removeAttribute: (k) => { delete attrs['app:' + k]; }, querySelector: (sel) => (sel === 'video' ? video : null) };
  const doc = { documentElement: { hasAttribute: (k) => !!attrs[k], setAttribute: (k) => { attrs[k] = 1; }, removeAttribute: (k) => { delete attrs[k]; } }, body: {},
    querySelector: (sel) => (sel === 'ytd-reel-video-renderer[is-active]' ? reel : sel === 'ytd-shorts' ? app : null),
    querySelectorAll: (sel) => (sel === 'ytd-reel-video-renderer' ? [reel] : sel === '[data-lumen-sh-root]' ? (attrs['app:data-lumen-sh-root'] ? [app] : []) : []) };
  const win = { addEventListener() {}, dispatchEvent() {}, innerHeight: 800, MutationObserver: MO };
  const loc = { pathname: '/shorts/aaaaaaaaaaa', href: 'https://www.youtube.com/shorts/aaaaaaaaaaa' };
  const ctx = vm.createContext({ window: win, document: doc, location: loc, innerHeight: 800, setTimeout, clearTimeout, Event: function () {}, MutationObserver: MO, Promise, Date, Math });
  vm.runInContext('(' + String(SH.guest) + ')();', ctx);
  const G = win.__lumenSh;
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  pending.push((async () => {
    const a = await G.until(true, '', 5000);
    check(a.ok && a.applied && a.videoId === 'aaaaaaaaaaa' && a.title === 'First Short' && !a.final && a.waited < 50 && live() === 0,
      'r64: an ask the chrome has nothing for is answered at once, the trim applied', { applied: a.applied, id: a.videoId, waited: a.waited, live: live() });
    // Nothing new: the page waits (one observer); a change in YouTube's app answers it.
    let b = null;
    const pb = G.until(true, a.sig, 5000).then((x) => { b = x; });
    await wait(60);
    check(b === null && live() === 1, 'r64: an ask with nothing new waits in the page (one observer, no answer yet)', { live: live() });
    // Lumen's own trim attribute written in the page: never taken for YouTube's app changing.
    fire([{ type: 'attributes', attributeName: 'data-lumen-sh-root' }]);
    await wait(60);
    check(b === null && live() === 1, 'r64: Lumen’s own data-lumen-sh writes never wake the wait');
    chan = '@one'; title = 'First Short';
    fire();
    await wait(60);
    check(b === null, 'r64: a change in YouTube’s app that changes nothing Lumen shows answers nothing');
    title = 'First Short, edited';
    fire();
    await pb;
    check(!!b && b.title === 'First Short, edited' && !b.final && b.waited < 1000 && live() === 0, 'r64: the read answers the moment the page changes, and its observer goes',
      { title: b && b.title, waited: b && b.waited, live: live() });
    // The time limit answers (final), observer gone.
    const c = await G.until(true, b.sig, 120);
    check(c.final && c.waited >= 100 && live() === 0, 'r64: at the ask’s time limit the page answers anyway (final)', { final: c.final, waited: c.waited, live: live() });
    // A newer ask answers the older one at once; stop() ends a wait without touching the trim.
    let d = null;
    const pd = G.until(true, c.sig, 5000).then((x) => { d = x; });
    const e = G.until(true, c.sig, 5000);
    await pd;
    check(!!d && !d.final && live() === 1, 'r64: a newer ask answers the older one (one wait at a time)', { live: live() });
    G.stop();
    const e1 = await e;
    check(e1.ok && live() === 0 && !!attrs['data-lumen-sh'], 'r64: stop() ends the wait and its observer, the trim left as it was', { live: live() });
    G.apply(false);
    check(!attrs['data-lumen-sh'], 'r64: apply(false) still takes the trim off');
    G.apply(true);
    // A move: the address names the next Short while the player and the title are still the last one's.
    loc.pathname = '/shorts/bbbbbbbbbbb'; loc.href = 'https://www.youtube.com/shorts/bbbbbbbbbbb';
    const m1 = G.tick(true);
    check(m1.videoId === '' && m1.lag === 'player', 'r64: the address moved, the player still the last Short’s: not the new Short’s read yet', { id: m1.videoId, lag: m1.lag });
    pid = 'bbbbbbbbbbb';
    const m2 = G.tick(true);
    check(m2.videoId === '' && m2.lag === 'title', 'r64: the player moved, the title and channel still the last Short’s: not yet either', { id: m2.videoId, lag: m2.lag });
    // An ask in the lag answers when the renderer has the new Short's own title.
    let m3 = null;
    const pm = G.until(true, '', 5000).then((x) => { m3 = x; });
    await pm;
    const pm2 = G.until(true, m3.sig, 5000).then((x) => { m3 = x; });
    title = 'Second Short'; chan = '@two';
    fire();
    await pm2;
    check(!!m3 && m3.videoId === 'bbbbbbbbbbb' && m3.title === 'Second Short' && !m3.lag, 'r64: the new Short’s own title in the page: its read, at once', { id: m3 && m3.videoId, title: m3 && m3.title });
    // A Short whose title and channel really are the last one's (a series): shown once the lag is over.
    loc.pathname = '/shorts/ccccccccccc'; pid = 'ccccccccccc';
    const s1 = await G.until(true, '', 3000);
    const t0 = Date.now();
    const s2 = await G.until(true, s1.sig, 4000);
    check(s1.videoId === '' && s2.videoId === 'ccccccccccc' && s2.title === 'Second Short' && !s2.final && Date.now() - t0 < 2200,
      'r64: the same title and channel on the next Short: read as its own once the lag (1500 ms) is over, not at the time limit', { s1: s1.videoId, s2: s2.videoId, ms: Date.now() - t0 });
  })());
}

/* ---- r64: the player's own word ends a move's lag (guest current(), playerData()) ------------------------------ */
// Real YouTube: the page's #shorts-player was on the new Short (getVideoData()) ~470 ms before the active renderer's
// own player lookup was, and that lookup held the read back. The read is released as soon as a player is on the
// address's Short with a title that is not the last Short's; never by a player with the last Short's title, never by
// a player on another id, never while the renderer still has the last Short's title or none (an ad's slot: the
// player's title there was the ad's internal asset name). Each read says where its wait went (gate: why, lag).
{
  const vm = require('vm');
  const attrs = {};
  class MO { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} }
  let title = 'First Short', chan = '@one', rpid = 'aaaaaaaaaaa';
  let dp = { video_id: 'aaaaaaaaaaa', title: 'First Short', author: 'One' };
  const node = (t) => ({ textContent: t, getAttribute: () => null, href: 'https://www.youtube.com/' + t });
  const btn = { getAttribute: (k) => (k === 'aria-label' ? 'like this video' : null), closest: () => null, textContent: '12' };
  const rplayer = { getVideoData: () => ({ video_id: rpid }), getPlayerResponse: () => ({}) };     // the renderer's own: no title
  const dplayer = { getVideoData: () => dp, getPlayerResponse: () => ({}) };                     // today's pinned one
  const video = { readyState: 0, videoWidth: 0, videoHeight: 0, currentSrc: '', addEventListener() {} };
  const reel = { getBoundingClientRect: () => ({ top: 0, bottom: 800, height: 800 }), hasAttribute: () => false, setAttribute() {}, removeAttribute() {},
    querySelector: (sel) => (sel === 'yt-shorts-video-title-view-model h2' ? (title ? node(title) : null) : sel === 'yt-reel-channel-bar-view-model a[href*="/@"]' ? node(chan)
      : sel === 'like-button-view-model button' ? btn : sel === '#shorts-player' ? rplayer : sel === '#shorts-player video' ? video : null) };
  const app = { hasAttribute: (k) => !!attrs['app:' + k], setAttribute: (k) => { attrs['app:' + k] = 1; }, removeAttribute: (k) => { delete attrs['app:' + k]; }, querySelector: (sel) => (sel === 'video' ? video : null) };
  const doc = { documentElement: { hasAttribute: (k) => !!attrs[k], setAttribute: (k) => { attrs[k] = 1; }, removeAttribute: (k) => { delete attrs[k]; } }, body: {},
    querySelector: (sel) => (sel === 'ytd-reel-video-renderer[is-active]' ? reel : sel === 'ytd-shorts' ? app : sel === '#reel-overlay-container #shorts-player' ? dplayer : null),
    querySelectorAll: (sel) => (sel === 'ytd-reel-video-renderer' ? [reel] : sel === '[data-lumen-sh-root]' ? (attrs['app:data-lumen-sh-root'] ? [app] : []) : []) };
  const win = { addEventListener() {}, dispatchEvent() {}, innerHeight: 800, MutationObserver: MO };
  const loc = { pathname: '/shorts/aaaaaaaaaaa', href: 'https://www.youtube.com/shorts/aaaaaaaaaaa' };
  const ctx = vm.createContext({ window: win, document: doc, location: loc, innerHeight: 800, setTimeout, clearTimeout, Event: function () {}, MutationObserver: MO, Promise, Date, Math });
  vm.runInContext('(' + String(SH.guest) + ')();', ctx);
  const G = win.__lumenSh;
  const go = (id) => { loc.pathname = '/shorts/' + id; loc.href = 'https://www.youtube.com' + loc.pathname; };
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  pending.push((async () => {
    const a = G.tick(true);
    check(a.videoId === 'aaaaaaaaaaa' && a.title === 'First Short' && a.gate && a.gate.why === 'player-data',
      'r64 gate: the first Short, its player and renderer agreeing: released by the player’s word, the renderer’s text shown', { id: a.videoId, gate: a.gate });
    // A move: the renderer's own player still on the last Short, its title already the new one's (real YouTube's ~470 ms).
    go('bbbbbbbbbbb'); dp = { video_id: 'bbbbbbbbbbb', title: 'Second Short', author: 'Two' }; title = 'Second Short'; chan = '@two';
    const b = G.tick(true);
    check(b.videoId === 'bbbbbbbbbbb' && b.title === 'Second Short' && !b.lag && b.gate.why === 'player-data' && b.gate.lag < 100 && b.like.found,
      'r64 gate: the player on the new Short with a new title releases the read at once (the renderer’s own player still the last one’s)', { id: b.videoId, lag: b.lag, gate: b.gate });
    // A move where the renderer still shows the last Short: the player alone releases nothing (never the last title).
    go('ccccccccccc'); dp = { video_id: 'ccccccccccc', title: 'Third Short', author: 'Three' };
    const c = G.tick(true);
    check(c.videoId === '' && c.gate.why === 'held' && c.gate.player === 'new-title',
      'r64 gate: the player on the new Short but the renderer still the last Short’s: held, the last title never read as the new Short’s', { id: c.videoId, gate: c.gate });
    // The renderer with no title at all (an ad's slot): held too; the player's title (an ad's asset name) is never shown.
    title = '';
    const c2 = G.tick(true);
    check(c2.videoId === '' && c2.gate.why === 'held', 'r64 gate: a renderer with no title yet: held, the player’s title not taken', { id: c2.videoId, gate: c2.gate });
    // A move whose player has the LAST Short's title (a series, or a player mid-swap): it releases nothing.
    title = 'Third Short'; chan = '@three'; G.tick(true);   // the renderer redrew for the third Short (told)
    go('ddddddddddd'); dp = { video_id: 'ddddddddddd', title: 'Third Short', author: 'Three' }; rpid = 'ccccccccccc';
    const d = G.tick(true);
    check(d.videoId === '' && !!d.lag && d.gate.why === 'held' && d.gate.player === 'last-title',
      'r64 gate: a player on the new id with the last Short’s title does not release the read', { id: d.videoId, lag: d.lag, gate: d.gate });
    // A player on another id (the last Short's, or one further on) with a new title: it releases nothing either.
    dp = { video_id: 'eeeeeeeeeee', title: 'Fifth Short', author: 'Five' };
    const e = G.tick(true);
    check(e.videoId === '' && e.gate.why === 'held' && e.gate.player === 'none', 'r64 gate: a player on another id does not release the read', { id: e.videoId, gate: e.gate });
    // Nothing ever releases it early: at LAG the read is taken as it is ('cap'), as before.
    await wait(1560);
    const f = G.tick(true);
    check(f.videoId === 'ddddddddddd' && f.gate.why === 'cap' && f.gate.lag >= 1500, 'r64 gate: no release by the player or the renderer: the read at LAG, said as the cap', { id: f.videoId, gate: f.gate });
    // The renderer's own read released it (no player title to go by): 'renderer'.
    go('fffffffffff'); dp = { video_id: 'fffffffffff' }; rpid = 'fffffffffff'; title = 'Sixth Short'; chan = '@six';
    const g = G.tick(true);
    check(g.videoId === 'fffffffffff' && g.title === 'Sixth Short' && g.gate.why === 'renderer', 'r64 gate: no player title: the renderer’s own read releases it', { id: g.videoId, gate: g.gate });
  })());
}

/* ---- r64: the reader goes into a page once per document; every call is short ------------------------------ */
// Electron keeps a call's code until its promise settles, and a call into a page that went away never settles: the
// ~30 KB reader in front of every call (until(), step, press, openFirst all wait in the page) left a copy behind
// each time. Now INSTALL (the reader, run at once) goes in once per document, and every call is a short string.
{
  const calls = [['until', [true, 'x'.repeat(300), 2500]], ['step', [1]], ['press', ['save-toggle', 3, 'abcdefghijk']], ['openFirst', []], ['stop', []],
    ['read', []], ['aspect', []], ['apply', [false]], ['tick', [true]]];
  const sizes = calls.map(([m, a]) => SH.short(m, a).length);
  check(SH.INSTALL.length > 20000 && sizes.every((n) => n < 1024) && SH.GUEST_V > 0, 'r64 calls: every call the chrome makes is under 1 KB (the reader itself goes in once)',
    { install: SH.INSTALL.length, sizes, v: SH.GUEST_V });
  // The chrome's own code: no page call carries the reader (call()), and its only executeJavaScript is js(), used by
  // askSh (askVia: INSTALL or a short call). So no call over 1 KB can wait in a page.
  const src = fs.readFileSync(path.join(ROOT, 'watch-shorts.js'), 'utf8');
  const chrome = src.slice(src.indexOf('/* ================================================================ the chrome */'));
  check(chrome.length > 1000 && !/(^|[^.\w])call\(/.test(chrome) && (chrome.match(/\bjs\(/g) || []).length === 1 && (chrome.match(/executeJavaScript\(/g) || []).length === 1,
    'r64 calls: the chrome never sends the reader with a call; its one executeJavaScript is js(), reached only through askSh', { calls: (chrome.match(/(^|[^.\w])call\(/g) || []).length, js: (chrome.match(/\bjs\(/g) || []).length });
  // INSTALL runs at once and settles (true, not a promise); a page without the reader answers notInstalled.
  const vm = require('vm');
  const bare = vm.createContext({ window: {}, document: {} });
  const ni = vm.runInContext(SH.short('until', [true, '', 2500]), bare);
  check(ni && ni.notInstalled === true && ni.ok === false, 'r64 calls: a page without the reader answers notInstalled (never runs nothing silently)', ni);
  // askVia: once per document, a retry after notInstalled, a reason when the reader never goes in.
  const page = { installed: false, broken: false };
  const sent = [];
  const run = (v, code) => {
    sent.push(code === SH.INSTALL ? 'INSTALL' : code.length < 1024 ? 'short' : 'BIG');
    if (code === SH.INSTALL) { if (!page.broken) page.installed = true; return Promise.resolve(true); }
    return Promise.resolve(page.installed ? { ok: true } : { ok: false, notInstalled: true });
  };
  const view = {};
  pending.push((async () => {
    const r1 = await SH.askVia(run, view, 'until', [true, '', 2500]);
    const r2 = await SH.askVia(run, view, 'step', [1]);
    check(r1.ok && r2.ok && sent.join(',') === 'INSTALL,short,short', 'r64 calls: the reader goes in once for the document, first; every call after is short', sent.slice());
    view.__shDocs = 1; page.installed = false; sent.length = 0;
    const r3 = await SH.askVia(run, view, 'read', []);
    check(r3.ok && sent.join(',') === 'INSTALL,short', 'r64 calls: a new document gets the reader again with its first call', sent.slice());
    page.installed = false; sent.length = 0;   // the reader gone with no new document Lumen saw
    const r4 = await SH.askVia(run, view, 'press', ['like', null, 'abcdefghijk']);
    check(r4.ok && sent.join(',') === 'short,INSTALL,short', 'r64 calls: a notInstalled answer brings one install and one retry, whose answer is taken', sent.slice());
    page.installed = false; page.broken = true; sent.length = 0;
    let why = '';
    try { await SH.askVia(run, view, 'step', [1]); } catch (e) { why = e.message; }
    check(/reader couldn’t be put in YouTube’s page/.test(why) && sent.join(',') === 'short,INSTALL,short', 'r64 calls: a reader that never goes in fails the call with its reason (once retried, never silent)', { why, sent });
  })());
}

Promise.all(pending).then(() => {
  console.log('watch-shorts-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
});
