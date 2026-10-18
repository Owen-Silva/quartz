// tests/watch-shorts-test.js -- Lumen's Shorts view's pure parts, no Electron, no network:
//   watch-shorts.js:      which URLs are Shorts pages (and so open in the Shorts view), the URLs Lumen's
//                         ways in open, the wheel as one Short per gesture (a trackpad burst and its inertia
//                         = ONE move), Up/Down, the info following the current Short, the layout (beside /
//                         below), the trim CSS (inert until the page's flag; the player, ads and consent
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

console.log('watch-shorts-test: ' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
