// tests/watch-playerbar-test.js -- Lumen's play bar, the pure parts (no Electron, no DOM):
// the time format, the seek maths, the key map, each adapter's menus (YouTube's movie_player API on a
// fake player, the track and own-menu shapes of the others), the page style (hide by visibility only,
// the ad UI kept), the injected source, the auto-hide timing and the fallback rules; and the hooks.
// One summary line: "watch-playerbar-test: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined && !cond ? '  ' + JSON.stringify(detail).slice(0, 300) : ''));
}
const ROOT = path.join(__dirname, '..');
const PB = require(path.join(ROOT, 'watch-playerbar'));
const Page = require(path.join(ROOT, 'watch-playerbar-page'));
const AD = {};
for (const id of ['youtube', 'disney', 'hulu', 'prime', 'espn']) AD[id] = require(path.join(ROOT, 'watch', 'playerbar', id));

/* ---- time ---- */
check(PB.fmtTime(0) === '0:00' && PB.fmtTime(5.9) === '0:05' && PB.fmtTime(65) === '1:05' && PB.fmtTime(600) === '10:00', 'fmtTime: m:ss', [PB.fmtTime(5.9), PB.fmtTime(65)]);
check(PB.fmtTime(3723) === '1:02:03' && PB.fmtTime(65, 3700) === '0:01:05', 'fmtTime: h:mm:ss, and the hours column once the video is an hour long', [PB.fmtTime(3723), PB.fmtTime(65, 3700)]);
check(PB.fmtTime(NaN) === '0:00' && PB.fmtTime(-3) === '0:00' && PB.fmtTime(Infinity) === '0:00' && PB.fmtTime('12') === '0:12', 'fmtTime: NaN, negative, Infinity and strings never show garbage');

/* ---- seek maths ---- */
check(PB.clampSeek(-5, 100) === 0 && Math.abs(PB.clampSeek(200, 100) - 99.9) < 1e-9 && PB.clampSeek(42, 100) === 42, 'clampSeek: inside [0, duration - 0.1]');
check(Math.abs(PB.skipTarget(95, 10, 100) - 99.9) < 1e-9 && PB.skipTarget(5, -10, 100) === 0 && PB.skipTarget(30, 10, 100) === 40, '+-10 s stops at the ends');
check(PB.clampSeek(50, -1, [100, 400]) === 100 && PB.clampSeek(500, -1, [100, 400]) === 400 && PB.clampSeek(10, 0, null) === 0, 'live: a seek stays in the seekable window; no duration means no seek');
check(PB.fracAt(150, 100, 200) === 0.25 && PB.fracAt(50, 100, 200) === 0 && PB.fracAt(400, 100, 200) === 1 && PB.fracAt(10, 0, 0) === 0, 'fracAt: where the pointer is, clamped to 0..1');
check(PB.timeAt(0.25, 200) === 50 && PB.timeAt(0.5, -1, [100, 300]) === 200 && PB.timeAt(2, 200) === 200, 'timeAt: a fraction of the duration, or of the live window');
check(PB.fracOf(50, 200) === 0.25 && PB.fracOf(300, -1, [100, 300]) === 1 && PB.fracOf(250, 200) === 1, 'fracOf: elapsed as a fraction');

/* ---- keys ---- */
const K = (k, s, m) => PB.keyAction(k, s, m);
check(K(' ').c === 'toggle' && K('k').c === 'toggle' && K('K', true).c === 'toggle', 'Space / K: play-pause');
check(K('j').by === -10 && K('L').by === 10 && K('ArrowLeft').by === -5 && K('ArrowRight').by === 5, 'J/L 10 s, the arrows 5 s');
check(K('ArrowUp').c === 'vol' && K('ArrowUp').by === 0.05 && K('ArrowDown').by === -0.05, 'Up/Down: the volume');
check(K('m').c === 'mute' && K('f').c === 'fs' && K('F', true).c === 'whole' && K('c').c === 'cc', 'M mute, F Lumen\'s fullscreen, Shift+F the whole screen, C captions');
check(K('<', true).dir === -1 && K('>', true).dir === 1 && K('<', false) === null, 'Shift+< / Shift+>: the speed (never unshifted)');
check(K('x') === null && K('k', false, true) === null && K('Escape') === null && K('Tab') === null, 'other keys and any Ctrl/Alt/Meta combination are never the bar\'s');
check(['k', 'K', 'j', 'J', 'l', 'L', ' ', 'm', 'M', 'f', 'F', 'c', 'C', '<', '>', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].every((k) => PB.PAGE_KEYS.includes(k)) && !PB.PAGE_KEYS.includes('Escape'),
  'the page bridge catches every key of the map, both cases, and never Esc (the layer\'s)');
check(PB.stepSpeed(1, 1) === 1.25 && PB.stepSpeed(2, 1) === 2 && PB.stepSpeed(0.25, -1) === 0.25 && PB.stepSpeed(1.1, -1) === 0.75, 'speed steps through 0.25-2, from the nearest step');
check(PB.stepVol(0.98, 0.05) === 1 && PB.stepVol(0.02, -0.05) === 0 && PB.stepVol(0.5, 0.05) === 0.55, 'volume steps clamp to 0..1');

/* ---- YouTube's menus on a fake movie_player ---- */
const calls = [];
const tracks = [{ languageCode: 'en', displayName: 'English' }, { languageCode: 'en', kind: 'asr', displayName: 'English (auto-generated)' }, { languageCode: 'es', displayName: 'Spanish' }];
let curTrack = { languageCode: 'es' };
const player = {
  classList: { contains: (c) => c === 'ad-showing' && player._ad },
  _ad: false,
  getAvailableQualityLevels: () => ['hd1080', 'hd720', 'large', 'auto'],
  getPlaybackQuality: () => 'hd720',
  setPlaybackQualityRange: (a, b) => calls.push(['range', a, b]),
  setPlaybackQuality: (q) => calls.push(['q', q]),
  getOption: (m, k) => (k === 'tracklist' ? tracks : curTrack),
  setOption: (m, k, v) => { calls.push(['opt', k, v]); curTrack = v; },
  loadModule: (m) => calls.push(['load', m]),
  unloadModule: (m) => calls.push(['unload', m]),
  getAvailableAudioTracks: () => [{ id: 'en.4', displayName: 'English (original)' }, { id: 'es.3', displayName: 'Spanish' }],
  getAudioTrack: () => ({ id: 'en.4' }),
  setAudioTrack: (t) => calls.push(['audio', t.id])
};
const fakeDoc = { getElementById: (id) => (id === 'movie_player' ? player : null), querySelector: () => null };
const ym = AD.youtube.page.menus(fakeDoc, { duration: 30, currentTime: 10 });
check(ym.quality && ym.quality.via === 'api' && ym.quality.items.map((i) => i.label).join(',') === '1080p,720p,480p,Auto' && ym.quality.cur === 'auto' && ym.quality.now === '720p',
  'YouTube quality: the player\'s own levels, labelled, Auto chosen, what plays now', ym.quality);
check(ym.captions && ym.captions.via === 'api' && ym.captions.items.length === 3 && ym.captions.cur === 'es' && ym.captions.items[1].id === 'en:asr', 'YouTube captions: the captions module\'s track list, auto-generated kept apart', ym.captions);
check(ym.audio && ym.audio.via === 'api' && ym.audio.items.length === 2 && ym.audio.cur === 'en.4', 'YouTube audio: the tracks it offers, the current one marked', ym.audio);
const q = PB.buildMenu('quality', ym.quality, 'YouTube', { ownMore: true });
check(q.items[0].label === '1080p' && q.items.filter((i) => i.on).map((i) => i.id).join() === 'auto' && /Playing at 720p/.test(q.note) && q.items[q.items.length - 1].id === '__more',
  'the quality menu: levels, Auto ticked, "Playing at", and YouTube\'s own controls last', q);
const c = PB.buildMenu('captions', ym.captions, 'YouTube');
check(c.items[0].id === 'off' && !c.items[0].on && c.items.find((i) => i.id === 'es').on, 'the captions menu: Off first, the current track ticked', c.items);
AD.youtube.page.pick('quality', 'hd1080', fakeDoc, {});
check(calls.some((x) => x[0] === 'range' && x[1] === 'hd1080' && x[2] === 'hd1080') && player.__lumenQ === 'hd1080', 'picking 1080p calls setPlaybackQualityRange(hd1080, hd1080)', calls);
AD.youtube.page.pick('captions', 'en:asr', fakeDoc, {});
check(calls.some((x) => x[0] === 'load') && curTrack.kind === 'asr', 'picking a caption track loads the module and sets that very track');
AD.youtube.page.pick('captions', 'off', fakeDoc, {});
check(calls.some((x) => x[0] === 'unload'), 'captions Off unloads the captions module');
AD.youtube.page.pick('audio', 'es.3', fakeDoc, {});
check(calls.some((x) => x[0] === 'audio' && x[1] === 'es.3'), 'picking an audio track calls setAudioTrack with it');
check(AD.youtube.page.ad(fakeDoc, { duration: 30, currentTime: 10 }) === null, 'no .ad-showing: no ad');
player._ad = true;
global.getComputedStyle = () => ({ display: 'block' });
const ad = AD.youtube.page.ad(fakeDoc, { duration: 15, currentTime: 5 });
check(ad && ad.on === true && ad.left === 10, 'an ad: on, with the time left from the ad\'s own video', ad);
delete global.getComputedStyle;

/* ---- the other services' shapes ---- */
const dz = PB.buildMenu('captions', { via: 'tracks', off: true, items: [{ id: '0', label: 'English' }, { id: '1', label: 'Français' }], cur: 'off' }, 'Disney+');
check(dz.items.length === 3 && dz.items[0].on && dz.items[2].label === 'Français' && dz.via === 'tracks', 'Disney+ captions from textTracks: Lumen-drawn, Off ticked');
const hu = PB.buildMenu('captions', { via: 'own', items: [] }, 'Hulu');
check(hu.items.length === 1 && hu.items[0].id === '__own' && /Hulu’s captions menu/.test(hu.items[0].label) && /opens Hulu’s own menu/.test(hu.note), 'Hulu (no track API): the item opens Hulu\'s own menu and says so', hu);
const dq = PB.buildMenu('quality', { via: 'none', items: [], why: AD.disney.none.quality }, 'Disney+', { ownMore: true });
check(/picks the quality itself/.test(dq.note) && dq.items.length === 1 && dq.items[0].id === '__more', 'Disney+ quality: none, the reason, and its own controls still one click away', dq);
const sp = PB.buildMenu('speed', null, 'Hulu', { rate: 1.5 });
check(sp.items.length === 8 && sp.items.find((i) => i.on).id === '1.5' && sp.items.find((i) => i.id === '1').label === 'Normal', 'speed: Lumen\'s own menu everywhere (playbackRate), the current one ticked');
const yb = PB.buildMenu('captions', { via: 'button', off: true, items: [{ id: 'on', label: 'On' }], cur: 'off' }, 'YouTube');
check(yb.items.length === 2 && /turns its captions on or off/.test(yb.note), 'YouTube before its list: On/Off through its own CC button, said');
check(PB.captionsToggle({ via: 'api', items: [{ id: 'en' }, { id: 'es' }], cur: 'off' }, 'es').id === 'es' && PB.captionsToggle({ via: 'api', items: [{ id: 'en' }], cur: 'en' }).id === 'off' &&
  PB.captionsToggle({ via: 'own', items: [] }).open === true, 'C: off -> the last track (else the first), on -> off, no list -> the menu');

/* ---- every adapter ---- */
for (const [id, a] of Object.entries(AD)) {
  check(a.id === id && a.name && Array.isArray(a.video) && a.video.length && a.hide.length && a.keep.length && a.own && a.own.captions,
    id + ': adapter has its video, the parts to hide, the parts to keep, and its own captions button');
  check(a.keep.some((k) => /dialog|skip|Skip|ad/.test(k)), id + ': keeps dialogs / skip / ad UI visible');
}

/* ---- the page's style and source ---- */
const css = Page.css(AD.youtube.hide, AD.youtube.keep);
check(/html\.lumen-pb-on \.ytp-chrome-bottom[^{]*\{ visibility: hidden !important; pointer-events: none !important; \}/.test(css), 'the style hides YouTube\'s bar only under html.lumen-pb-on');
check(css.includes('html.lumen-pb-on .ytp-chrome-bottom [class*="ytp-ad"]') && /\[class\*="skip"\][^{]*\{ visibility: visible !important; pointer-events: auto !important; \}/.test(css),
  'inside it, every ad piece and Skip stays visible and clickable');
check(!/display\s*:\s*none/.test(css) && !/opacity/.test(css), 'hiding is visibility only: no display:none, no opacity (a kept child could not come back)');
check(/html\.lumen-pb-on\.lumen-pb-own \.ytp-chrome-bottom/.test(css), 'the own-menu class brings the service\'s bar back for that moment');
check(Page.css([], ['x']) === '', 'nothing to hide: no style');
const src = Page.source({ find: 8000, keys: PB.PAGE_KEYS }, AD.youtube);
let parsed = true;
try { new Function(src); } catch (e) { parsed = false; }
check(parsed && src.includes('"menus": function') && src.includes('"ad": function') && src.includes('"find":8000'), 'the injected source parses and carries YouTube\'s page functions and the 8 s find');
check(!/MediaKeys|requestMediaKeySystemAccess|setMediaKeys|captureStream|MediaRecorder|\.src\s*=|srcObject/.test(src), 'the injected source never touches EME/DRM or the stream (no MediaKeys, captureStream, src)');
check(!/\.click\(\)[^;]*skip|skip[^;]*\.click\(\)|playbackRate\s*=\s*16|currentTime\s*=\s*v\.duration/i.test(src) && !/ytp-ad[^"]*"\)\.click/.test(src), 'no ad skipping or fast-forwarding anywhere in the page code');
let p2 = true;
try { new Function(Page.source({ keys: [] }, AD.hulu)); } catch (e) { p2 = false; }
check(p2, 'an adapter with no page functions still makes a valid source');
check(/__lumenPB/.test(Page.command({ c: 'seek', to: 3 })) && /"to":3/.test(Page.command({ c: 'seek', to: 3 })), 'command(): one call into the bridge');

/* ---- auto-hide timing ---- */
check(PB.HIDE_MS === 2500, 'the bar hides after 2.5 s still');
check(PB.hideDelay({ now: 1000, lastAct: 0 }) === 1500 && PB.hideDelay({ now: 3000, lastAct: 0 }) === 0 && PB.hideDelay({ now: 2400, lastAct: 0 }) === 100, 'hideDelay counts from the last move or key');
check([{ paused: true }, { menu: true }, { hover: true }, { drag: true }, { own: true }, { ended: true }].every((o) => PB.hideDelay(Object.assign({ now: 99999, lastAct: 0 }, o)) === -1),
  'it stays while paused, ended, a menu is open, the pointer is on it, a drag, or the service\'s own menu is open');

/* ---- fallback rules ---- */
check(PB.FIND_MS === 8000 && PB.FAILS === 2, 'fallback: no video in 8 s, or two failed commands');
const H = PB.Health('Hulu');
check(H.fail('seek', 'no answer') === '' && /couldn’t seek twice in a row \(no answer\), so Hulu’s own bar is back\./.test(H.fail('seek', 'no answer')), 'the second failure in a row brings back the service\'s bar, with the reason');
const H2 = PB.Health('Disney+');
H2.fail('vol'); H2.ok();
check(H2.fail('vol') === '' && H2.count() === 1, 'a success in between resets the count');
check(/found no video on Disney\+’s page in 8 s, so Disney\+’s own bar is back\./.test(H2.novideo(8000)), 'no video in 8 s: the one-line reason names the service');
check(/couldn’t start on Hulu’s page \(boom\)/.test(H.broken('boom')), 'a bridge that never got in: its reason too');
check(PB.modeFrom(null) === 'lumen' && PB.modeFrom('service') === 'service' && PB.modeFrom('junk') === 'lumen', 'Settings: Lumen\'s bar by default; "service" only when he picks it');
check(PB.tileRule(1) === 'full' && PB.tileRule(2) === 'none' && PB.tileRule(4) === 'none', 'multiview tiles: no Lumen bar; one video: the full bar');

/* ---- the hooks ---- */
const wp = fs.readFileSync(path.join(ROOT, 'watch-player.js'), 'utf8');
check(/\[window\.WatchPlayerExtras, window\.WatchPlayerYT,( window\.LumenPlayview,)? window\.LumenPlayerBar(, window\.LumenShorts)?\]/.test(wp), 'watch-player.js X() hands attach / destroy / sync to the bar (after the play view; the Shorts view, if there, last)');
check(/LumenPlayerBar\.shortcut\(id\) === true\) return true;\s*\n\s*if \(L\.fsSlot\)/.test(wp), 'Esc asks the bar first (menu, own menu, Lumen\'s window), then the layer');
const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const order = ['watch/playerbar/youtube.js', 'watch/playerbar/hulu.js', 'watch-playerbar-page.js', 'watch-playerbar.js', 'watch-player.js'].map((f) => idx.indexOf('src="' + f + '"'));
check(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])) && idx.includes('href="watch-playerbar.css"'), 'index.html loads the adapters, the bridge and the bar before the layer, and its CSS', order);
const st = fs.readFileSync(path.join(ROOT, 'settings.js'), 'utf8');
check(/data-field', 'watchplaybar'/.test(st) && /LumenPlayerBar\.renderSetting\(field/.test(st), 'Settings > Lumen has the Play bar field');

/* ---- a YouTube Short (Lumen's Shorts view): the bar follows the active Short, Up/Down stay the view's ---- */
{
  const yp = AD.youtube.page;
  const vid = { tagName: 'VIDEO' };
  const reel = { querySelector: (q) => (q === 'video' ? vid : null) };
  const appOld = { querySelector: (q) => (q === 'ytd-reel-video-renderer[is-active]' ? reel : null), querySelectorAll: () => [] };
  const doc = { querySelector: (q) => (q === 'ytd-shorts' ? appOld : q === 'ytd-reel-video-renderer[is-active]' ? reel : null) };
  // Today's page (read 10-18): no is-active; the hidden watch page's paused #movie_player video is NOT in ytd-shorts;
  // in it, the #shorts-player's one video on screen, plus (older layout) paused neighbours above and below.
  const V = (x, y, w, h, paused) => ({ tagName: 'VIDEO', paused, getBoundingClientRect: () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }) });
  const shown = V(0, 0, 468, 832, false), above = V(0, -848, 468, 832, true), below = V(0, 848, 468, 832, true), half = V(0, 416, 468, 832, true);
  const appNew = (list, sp) => ({ querySelector: (q) => (q === '#shorts-player video' ? sp || null : null), querySelectorAll: (q) => (q === 'video' ? list : []) });
  const docOf = (app) => ({ defaultView: { innerWidth: 468, innerHeight: 832 }, querySelector: (q) => (q === 'ytd-shorts' ? app : null) });
  const had = Object.prototype.hasOwnProperty.call(global, 'location'), old = global.location;
  global.location = { pathname: '/shorts/Xk3pQ9vLm2A' };
  const onShort = yp.current(doc);
  const today = yp.current(docOf(appNew([above, shown, below], shown)));
  const midMove = yp.current(docOf(appNew([shown, half], shown)));
  const playingWins = yp.current(docOf(appNew([V(0, 0, 468, 832, true), V(0, 0, 468, 832, false)])));
  const notYet = yp.current({ querySelector: () => null });
  const noVideoYet = yp.current(docOf(appNew([], null)));
  global.location = { pathname: '/watch' };
  const onWatch = yp.current(doc);
  if (had) global.location = old; else delete global.location;
  check(onShort === vid && onWatch === null, 'YouTube: on an older Shorts page the current video is the is-active Short\'s; on a watch page none (its #movie_player)');
  check(today === shown && midMove === shown && !!playingWins && playingWins.paused === false, 'today\'s Shorts page: the video ON SCREEN (a playing one first), never a paused neighbour or the hidden watch page\'s', { today: today === shown, midMove: midMove === shown });
  const ytCss = Page.source({}, AD.youtube);
  check(/lumen-pb-ad:not\(\.lumen-pb-idle\):not\(\.lumen-pb-own\) \.ytp-ad-player-overlay-layout,/.test(ytCss) && /bottom: var\(--lumen-pb-lift, 0px\) !important; height: auto/.test(ytCss) && !/display: none|opacity: 0/.test(ytCss),
    'during an ad, YouTube\'s own overlay layer (Sponsored, the advertiser, Skip) ends above Lumen\'s bar; nothing of it is hidden');
  check(notYet === false && noVideoYet === false, 'a Shorts page with no Short video yet: false (the bridge waits, never binding the hidden watch page\'s video)');
  check(src.includes('if (cur === false) return null;') && src.includes("e.type === 'loadedmetadata'") && src.includes('watchAd(v);'), 'the bridge waits on false, re-binds on the new video\'s own play/playing/loadedmetadata, and re-aims its one ad observer per bind');
  check(AD.youtube.video.indexOf('ytd-reel-video-renderer[is-active] video') > AD.youtube.video.indexOf('#movie_player video'), 'the Shorts video comes after the watch player in the find list');
  const mk = (mark, showing) => {
    const r = { querySelector: (q) => (mark && /ytd-ad-slot-renderer/.test(q) ? {} : null) };
    const sp = { classList: { contains: (c) => c === 'ad-showing' && showing } };
    return { duration: 20, currentTime: 5, closest: (q) => (q === '#reel-overlay-container' ? r : q === '.html5-video-player' ? sp : null) };
  };
  const nd = { getElementById: () => null, querySelector: () => null };
  const a1 = yp.ad(nd, mk(true, false)), a2 = yp.ad(nd, mk(false, true)), a3 = yp.ad(nd, mk(false, false));
  check(!!a1 && a1.on && a1.left === 15 && a1.skip === false && !!a2 && a2.on && a3 === null, 'an ad Short (YouTube\'s ad slot in its reel, or the Shorts player\'s ad state) is an ad; a plain Short is not', { a1, a2, a3 });
  check(AD.youtube.keep.indexOf('ytd-reel-ad-metadata-renderer') >= 0 && AD.youtube.lift.indexOf('#reel-overlay-container') >= 0 && /#shorts-player/.test(AD.youtube.adRoot), 'an ad Short\'s own pieces stay visible and are lifted above Lumen\'s bar');
  check(src.includes("(e.key === 'ArrowUp' || e.key === 'ArrowDown') && R.hasAttribute('data-lumen-sh')"), 'the page bridge leaves Up/Down to YouTube on Lumen\'s Shorts view (never the volume there)');
  check(src.includes("case 'rate': if (ad && ad.on) return { ok: false, blocked: 'ad' }"), 'no speed change while an ad plays (any service)');
  check(src.includes("current() === e.target) attach(e.target)") && src.includes('else if (now && now !== v) attach(now)'), 'the bridge swaps to the Short that plays now (on its playing, and on a rescan)');
  const pbjs = fs.readFileSync(path.join(ROOT, 'watch-playerbar.js'), 'utf8');
  check(/inShorts\(s\) && \(e\.key === 'ArrowUp' \|\| e\.key === 'ArrowDown'\)\) return;/.test(pbjs) && /return shortsMove\(s, k === 'ArrowDown' \? 1 : -1\)/.test(pbjs), 'in the chrome Up/Down on a Short go to the Shorts view; from the page, the bar hands them to it');
  const pbcss = fs.readFileSync(path.join(ROOT, 'watch-playerbar.css'), 'utf8');
  check(/\.pb\.is-short \.pb-fs \{ display: none !important; \}|\.pb\.is-short \.pb-fs/.test(pbcss) && /\.pb\.is-short\.is-idle \{ opacity: 1; \}/.test(pbcss), 'the Short\'s bar: no full window; idle leaves the thin progress line');
}

console.log('watch-playerbar-test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
