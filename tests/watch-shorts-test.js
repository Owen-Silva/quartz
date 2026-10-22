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

Promise.all(pending).then(() => {
  console.log('watch-shorts-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
});
