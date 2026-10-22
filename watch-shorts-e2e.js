require('./tools/lowcpu-optional.js');   // first: the CPU cap, when one is configured (tools/lowcpu-optional.js; none on a cloud runner)
// watch-shorts-e2e.js -- Lumen's Shorts view (watch-shorts.js + watch-shorts-main.js), end to end, in a REAL hidden
// Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen, watched by testwatch.js), on LOCAL FIXTURES ONLY
// (tests/shorts-fixtures.js: a fake youtube.com/shorts page with 4 Shorts, YouTube's own up/down buttons, wheel and
// keys, Like/Dislike/Subscribe/Save that count their presses; a channel's Shorts grid). The clip is SYNTHETIC
// (ffmpeg testsrc2; QUARTZ_SHORTS_CLIP). YouTube is rebased to a local front; every other host name resolves nowhere.
//
//   node watch-shorts-e2e.js [--cdp 9851] [--shots <dir>]
//
// Checks: a Shorts tile on the home row opens the Shorts view in the layer (never a tab): only YouTube's Shorts
// player shows (9:16, centred), Lumen's info beside it; the wheel over Lumen's info, over the margin and over the
// player moves exactly ONE Short; a trackpad-style burst moves exactly one; ArrowUp/ArrowDown (in the chrome and in
// the page); Lumen's Next and Previous press YouTube's own buttons; the info follows the current Short; one click =
// one press (Like, Dislike, Subscribe, Unsubscribe with Lumen's confirm, Save); the channel page's Shorts button and
// the row's Shorts entry open the view, never a tab; signed out; the page failed; the info below on a narrow window;
// never OS fullscreen; shots at 1280x800, 1536x800, 1920x1000. One summary line: "watch-shorts-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');
const F = require('./tests/shorts-fixtures');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9851'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'quartz-shorts-shots'));
const CLIP = process.env.QUARTZ_SHORTS_CLIP || path.join(__dirname, 'tests', 'media', 'lumen-short-9x16.mp4');   // testsrc2, 270x480 (9:16), 30 s
// Made like tests/fixture-clip.js's, smaller: testsrc2=size=270x480:rate=12:duration=30 (3x4: 240x320, 10 s), -crf 45 -g 24,
// AAC 24k. // The Short's own shape (6a): a clip per shape, /__media/short.mp4?shape=<w>x<h>. 9x16 and 3x4 are in tests/media, 16x9 is
// the players' clip (640x360); any other (1x1, 1x3, ...) is <QUARTZ_SHORTS_SHAPES>/short-<shape>.mp4 when that dir has it.
const SHAPE_CLIPS = { '9x16': CLIP, '3x4': path.join(__dirname, 'tests', 'media', 'lumen-short-3x4.mp4'), '16x9': require('./tests/fixture-clip').CLIP };
function shapeClip(shape) {
  const k = String(shape || '');
  if (!k) return CLIP;
  if (SHAPE_CLIPS[k]) return SHAPE_CLIPS[k];
  const f = /^\d{1,2}x\d{1,2}$/.test(k) && process.env.QUARTZ_SHORTS_SHAPES ? path.join(process.env.QUARTZ_SHORTS_SHAPES, 'short-' + k + '.mp4') : '';
  return f && fs.existsSync(f) ? f : '';
}
const SHOT_PREFIX = opt('shot-prefix', 'playview-shorts-');
const SHOT_REAL = argv.indexOf('--no-real-shots') < 0;
const FIX = path.join(__dirname, 'tests', 'watch-fixtures');
const fx = (name) => JSON.parse(fs.readFileSync(path.join(FIX, 'youtube-' + name + '.json'), 'utf8'));
const CHANNEL = '/@guitarcoachryan';
const S = F.SHORTS;

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 2000;
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, origin: 'http://127.0.0.1:' + s.address().port }));
  });
}
function sendHtml(res, body) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); }
function sendClip(req, res, clip) {
  const file = clip || CLIP;
  let st;
  try { st = fs.statSync(file); } catch (e) { res.writeHead(404); res.end('no clip'); return; }
  const m = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range || ''));
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
  res.writeHead(m ? 206 : 200, Object.assign({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 }, m ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size } : {}));
  fs.createReadStream(file, { start, end }).pipe(res);
}
const BS = String.fromCharCode(92);
const inScript = (v) => JSON.stringify(v).split('<').join(BS + 'u003c');
function ytPage(f, label) {
  const data = f && f.ytInitialData ? 'window.ytInitialData=' + inScript(f.ytInitialData) + ';' : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>YouTube</title><script>var ytcfg={data_:{LOGGED_IN:' +
    (!f || f.loggedIn === true) + '},get:function(k){return this.data_[k];}};' + data + '</script></head><body><div id="content">front YouTube (' + label + ')</div></body></html>';
}
const hits = [];
// 11h: the front refuses its Shorts pages while "down" (the connection is cut), as a dead network does.
let frontDown = false;
async function startServers(mock) {
  const front = await listen((req, res) => {
    const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
    const p = u.pathname.replace(/\/+$/, '') || '/';
    hits.push(p);
    if (frontDown && /^\/shorts\//.test(p)) { req.socket.destroy(); return undefined; }
    if (p === '/__hang') return undefined;   // 11k: a page that never answers (its navigation is then stopped)
    if (p === '/__media/short.mp4') return sendClip(req, res, u.searchParams.has('shape') ? shapeClip(u.searchParams.get('shape')) || '-' : CLIP);
    let m = /^\/shorts\/([A-Za-z0-9_-]{6,20})$/.exec(p);
    if (m && u.searchParams.has('real')) return sendHtml(res, F.realShortsPage(m[1], { signedout: u.searchParams.has('signedout'), preload: u.searchParams.has('preload') }));
    if (m) return sendHtml(res, F.shortsPage(m[1], { signedout: u.searchParams.has('signedout'), ad: u.searchParams.get('ad'), slowsave: u.searchParams.has('slowsave'), long: u.searchParams.has('long'), shapes: u.searchParams.get('shapes') ? u.searchParams.get('shapes').split(',') : null }));
    if (p === '/shorts') return sendHtml(res, F.shortsPage('', {}));
    if (p === CHANNEL + '/shorts') return sendHtml(res, F.channelShorts(CHANNEL, { dead: u.searchParams.has('dead') }));
    if (p === CHANNEL + '/videos') return sendHtml(res, ytPage(fx('channel'), 'channel'));
    if (p === '/feed/subscriptions') return sendHtml(res, ytPage(fx('subs-next'), 'subs-next'));
    const up = http.request({ host: '127.0.0.1', port: mock.ports.youtube, path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + mock.ports.youtube }) }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('mock gone'); } });
    req.pipe(up);
    return undefined;
  });
  const rebase = [['https://www.youtube.com', front.origin]];
  for (const pair of mock.rebase) if (pair[0] !== 'https://www.youtube.com') rebase.push(pair);
  return { front, rebase, close: () => front.server.close() };
}
async function deadPort() { const s = await listen(() => {}); const p = s.port; await new Promise((r) => s.server.close(r)); return p; }
function pngSize(file) { try { const b = fs.readFileSync(file); return b.readUInt32BE(16) + 'x' + b.readUInt32BE(20); } catch (e) { return 'unreadable'; } }
async function targetWhere(q, pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    let list = [];
    try { list = await q.targets(); } catch (e) { list = []; }
    const t = list.find((x) => x.webSocketDebuggerUrl && pred(x));
    if (t) return t;
    await sleep(100);
  }
  return null;
}
async function cdpTo(t) { const c = await new Cdp(t.webSocketDebuggerUrl).open(); await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => 0); return c; }
async function keyIn(c, key, code, vk) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 };
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}
const ST = 'WatchPlayer._state()';
const SS = 'LumenShorts._state()';
const TRIM = `(() => { const vw = innerWidth, vh = innerHeight; const root = document.querySelector('[data-lumen-sh-root]');
  const act = document.querySelector('ytd-reel-video-renderer[is-active]'); const v = act && act.querySelector('video');
  const hid = (sel) => { const n = document.querySelector(sel); if (!n) return null; const cs = getComputedStyle(n); return cs.display === 'none' || cs.visibility === 'hidden'; };
  const out = { vw, vh, flag: document.documentElement.hasAttribute('data-lumen-sh'), root: !!root, rootTag: root ? root.tagName.toLowerCase() : '',
    playing: !!v && !v.paused && v.readyState >= 2, masthead: hid('#masthead-container'), guide: hid('#guide'), actions: hid('ytd-reel-video-renderer[is-active] #actions'),
    meta: hid('ytd-reel-video-renderer[is-active] yt-reel-metapanel-view-model'), nav: hid('#navigation-container'), ctrl: hid('ytd-reel-video-renderer[is-active] .ytp-play-button') };
  if (act) { const r = act.querySelector('#player-container').getBoundingClientRect(); out.player = [Math.round(r.left), Math.round(r.top), Math.round(r.width - vw), Math.round(r.height - vh)];
    out.center = (() => { const n = document.elementFromPoint(vw / 2, vh / 2); return !!n && act.contains(n); })(); }
  return out; })()`;

run('watch-shorts-e2e', async ({ check, launch, say }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  check(fs.existsSync(CLIP) && !/roblox|videos[\\/]/i.test(CLIP), 'the clip is the synthetic one (testsrc2), not a recording', CLIP);
  const mock = await Mock.start({ log: () => {} });
  const srv = await startServers(mock);
  const FY = srv.front.origin;
  const env = {
    QUARTZ_WATCH_BOOT_GRACE_MS: '0', QUARTZ_WATCH_REBASE: JSON.stringify(srv.rebase), QUARTZ_WATCH_MIN_FREE_GB: '0',
    QUARTZ_PLAYER_FLOOR_GB: '0', QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1', QUARTZ_TEST_WINDOW_SIZE: '1280x800',
    QUARTZ_EDGE_STUB: path.join(os.tmpdir(), 'quartz-shorts-edge-' + process.pid + '.txt'),
  };
  const args = ['--force-device-scale-factor=1', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'];
  try {
    const q = await launch({ cdp: CDP_PORT, env, args });
    const chrome = q.chrome;
    await chrome.ev('window.__fsCalls = 0; window.toggleFullscreen = function () { window.__fsCalls++; }; 1');
    const win = () => chrome.ev('window.api.lumenPlayview.testWin()');
    const w0 = await win();
    check(w0 && w0.ok && w0.fullScreen === false && w0.content.width === 1280 && w0.content.height === 800, 'the test window is really 1280x800, not fullscreen', w0);
    check(await chrome.ev('typeof window.LumenShorts === "object" && typeof LumenShorts.gesture === "function"'), 'the Shorts view is loaded in the chrome');

    const sh = () => chrome.ev(`(() => { const s = ${SS}; return s.slots[s.slots.length - 1] || null; })()`);
    const shWait = (cond, ms) => chrome.waitFor(`(() => { const s = ${SS}; const x = s.slots[s.slots.length - 1]; return x && (${cond}) ? x : null; })()`, ms || 15000).catch(() => null);
    const tabsN = () => chrome.ev('tabs.length');
    let guest = null;
    const guestNow = async () => { if (guest) { try { guest.close(); } catch (e) { /* gone */ } } const t = await targetWhere(q, (x) => String(x.url).indexOf(FY + '/shorts/') === 0, 15000); guest = t ? await cdpTo(t) : null; return guest; };
    const moves = async () => (guest ? guest.ev('window.__moves.length').catch(() => -1) : -1);
    const presses = async () => (guest ? guest.ev('JSON.stringify(window.__presses)').then(JSON.parse).catch(() => null) : null);
    const curId = async () => (guest ? guest.ev('location.pathname.split("/").pop()').catch(() => '') : '');
    const clickAt = async (sel, label) => {
      const r = await chrome.ev(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, dis: !!n.disabled }; })()`);
      if (!r) { say('click: no ' + (label || sel)); return false; }
      for (const type of ['mousePressed', 'mouseReleased']) await chrome.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
      return true;
    };
    const wheelAt = (x, y, dy) => chrome.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
    // After a move: the page settles, then Lumen's info is for the page's current Short.
    const settled = async (label, wantId) => {
      const x = await shWait(`x.cur === ${JSON.stringify(wantId)} && x.infoShort === ${JSON.stringify(wantId)} && x.phase === 'ready'`, 8000);
      const want = S.concat(F.list('')).find((s) => s.id === wantId) || {};
      check(!!x && x.title === want.title && x.channel === want.channel, label + ': Lumen’s info follows the current Short (' + wantId + ')', x && { cur: x.cur, info: x.infoShort, title: x.title, ch: x.channel, phase: x.phase });
      return x;
    };
    let req = [1280, 800];
    // Lumen's play bar (watch-playerbar.js) on the Short.
    const pb = () => chrome.ev('(() => { const s = LumenPlayerBar._state(); return s.slots[s.slots.length - 1] || null; })()');
    const pbWait = (cond, ms) => chrome.waitFor(`(() => { const s = LumenPlayerBar._state(); const b = s.slots[s.slots.length - 1]; return b && (${cond}) ? b : null; })()`, ms || 10000).catch(() => null);
    const bars = () => chrome.ev('document.querySelectorAll(".wp-layer .wp-tile .pb").length');
    const inside = (a, o, tol) => !!a && !!o && a.x >= o.x - tol && a.y >= o.y - tol && a.x + a.w <= o.x + o.w + tol && a.y + a.h <= o.y + o.h + tol;
    const meets = (a, o) => !!a && !!o && a.x < o.x + o.w && o.x < a.x + a.w && a.y < o.y + o.h && o.y < a.y + a.h;
    const wake = async () => {
      const z = await sh();
      if (!z || !z.view) return;
      await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: z.view.x + z.view.w / 2, y: z.view.y + z.view.h * 0.55 });
      await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: z.view.x + z.view.w / 2 + 7, y: z.view.y + z.view.h * 0.55 + 5 });
      await pbWait('b.on && !b.idle', 3000);
    };
    const vt = () => (guest ? guest.ev('(() => { const v = document.querySelector("ytd-reel-video-renderer[is-active] video"); return v ? v.currentTime : -1; })()') : -1);
    const focusInfo = () => chrome.ev('(() => { const i = document.querySelector(".wp-layer .sh-info"); if (!i) return 0; i.setAttribute("tabindex", "-1"); i.focus(); return 1; })()');
    const keyShift = async (c, key, code, vk) => {
      const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 8 };
      await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
      await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
    };
    const resize = async (w, h) => {
      let rw = w, rh = h;
      for (let i = 0; i < 4; i++) {
        await chrome.ev(`window.api.watchPlayer.testCapture({ width: ${rw}, height: ${rh}, wait: 700 }).then(() => 1)`);
        const c = (await win()).content;
        if (c.width === w && c.height === h) { req = [rw, rh]; break; }
        rw += w - c.width; rh += h - c.height;
      }
      await sleep(600);
    };
    const shot = async (w, h, tag) => {
      await chrome.ev('(() => { const a = document.activeElement; if (a && a.closest && a.closest(".sh-info")) a.blur(); return 1; })()');
      if (tag !== 'idle') await wake();
      const r = await chrome.ev(`window.api.watchPlayer.testCapture({ width: ${req[0]}, height: ${req[1]}, wait: 1400 })`).catch((e) => ({ ok: false, err: String(e && e.message) }));
      if (!r || !r.ok || !r.png) { check(false, 'shot at ' + w + 'x' + h, r && r.err); return ''; }
      const f = path.join(SHOTS, SHOT_PREFIX + w + 'x' + h + (tag ? '-' + tag : '') + '.png');
      fs.writeFileSync(f, Buffer.from(r.png, 'base64'));
      const sz = pngSize(f);
      check(sz === w + 'x' + h, 'shot ' + path.basename(f) + ' is really ' + w + 'x' + h, sz);
      say('shot ' + f + ' ' + sz);
      return f;
    };
    const layoutOk = async (label, mode) => {
      const x = await sh();
      const v = x && x.view, inf = x && x.info, t = x && x.tile;
      const ratio = v ? v.w / v.h : 0;
      check(!!x && x.on && x.mode === mode && Math.abs(ratio - 9 / 16) < 0.02, label + ': the player is 9:16 and the info is ' + mode + ' it', x && { mode: x.mode, view: v });
      if (mode === 'beside') check(!!v && !!inf && Math.abs((v.x + v.w / 2) - (t.x + t.w / 2)) <= 2 && inf.x >= v.x + v.w + 40 && inf.x + inf.w <= t.x + t.w, label + ': the player is centred, the info beside it inside the layer', { v, inf, t });
      else check(!!v && !!inf && inf.y >= v.y + v.h + 8 && inf.y + 120 <= t.y + t.h, label + ': the info is under the player, inside the layer', { v, inf, t });
    };

    /* ============================ 1. a Shorts tile on the home row opens the Shorts view ============================ */
    await chrome.ev('openWatchTab(), 1');
    const gt = await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 15000);
    const g = await cdpTo(gt);
    const shortCard = `([...document.querySelectorAll('*')].find((n) => n._item && n._item.service === 'youtube' && /\\/shorts\\//.test(n._item.url) && n.offsetParent))`;
    await g.waitFor(`!!${shortCard}`, 60000).catch(() => 0);
    const item = await g.ev(`(() => { const c = ${shortCard}; return c ? { title: c._item.title, url: c._item.url, id: c._item.id } : null; })()`);
    check(!!item && /\/shorts\/hmShorts00\d$/.test(item.url), 'the home row has a Shorts tile (its URL is /shorts/<id>)', item);
    const tabs0 = await tabsN();
    for (let i = 0; i < 4 && item; i++) {
      await g.ev(`(() => { const c = ${shortCard}; c.scrollIntoView({ block: 'nearest' }); c.click(); return 1; })()`);
      if (await chrome.waitFor(`${ST}.open ? 1 : 0`, 2500).catch(() => 0)) break;
      await sleep(700);
    }
    const homeId = item ? item.url.split('/').pop() : '';
    let x = await shWait(`x.on && x.applied && x.phase === 'ready' && x.cur === ${JSON.stringify(homeId)}`, 20000);
    check(!!x && x.url.indexOf(FY + '/shorts/' + homeId) === 0, 'a click on the Shorts tile opens it in Lumen’s Shorts view', x && { url: x.url, phase: x.phase, why: x.why });
    check(await tabsN() === tabs0, 'no tab opened for the Short', { before: tabs0, after: await tabsN() });
    check(!!x && x.title === 'Home row Short ' + homeId && x.channel === '@lumenhomerow', 'the info: the Short’s title and channel, read from YouTube’s page', x && { title: x.title, ch: x.channel });
    check(await chrome.ev(`${ST}.title`) === 'YouTube Shorts', 'the layer’s bar names the view');
    await guestNow();
    await guest.waitFor('(() => { const v = document.querySelector("ytd-reel-video-renderer[is-active] video"); return v && !v.paused && v.currentTime > 0.2; })()', 15000).catch(() => 0);
    let t = await guest.ev(TRIM);
    check(t.flag && t.root && t.rootTag === 'ytd-shorts', 'the page marks YouTube’s Shorts app as the root', t);
    check(t.masthead && t.guide && t.actions && t.meta && t.nav, 'YouTube’s masthead, guide, action bar, title overlay and up/down buttons are hidden', t);
    check(t.playing && t.center, 'YouTube’s own player shows, and the clip plays', t);
    check(!!t.player && t.player.every((n) => Math.abs(n) <= 2), 'the player fills the page’s whole viewport', t.player);
    x = await sh();
    check(Math.abs(t.vw - x.view.w) <= 2 && Math.abs(t.vh - x.view.h) <= 2, 'the page’s own viewport is the 9:16 box', { vp: [t.vw, t.vh], view: x.view });
    await layoutOk('1280x800', 'beside');

    /* ============================ 1b. Lumen's play bar on the Short ============================ */
    await wake();
    let b = await pbWait('b.on && b.short && b.st && !b.idle', 12000);
    x = await sh();
    check(!!b && b.on && b.short && !b.fell, 'Lumen’s play bar is on over the Short', b ? { on: b.on, short: b.short, fell: b.fell, reason: b.reason } : await chrome.ev('LumenPlayerBar._state()'));
    check(await bars() === 1, 'exactly one Lumen bar in the tile', await bars());
    check(!!b && inside(b.bar, x.view, 1) && Math.abs(b.bar.w - x.view.w) <= 2 && Math.abs((b.bar.y + b.bar.h) - (x.view.y + x.view.h)) <= 14,
      'the bar is fitted to the vertical player: its width, at its bottom edge', b && { bar: b.bar, view: x.view });
    const want = ['play', 'mute', 'vol', 'time'], never = ['back', 'fwd', 'next', 'audio', 'quality', 'whole', 'fs'];
    check(!!b && want.every((k) => b.shown.includes(k)) && never.every((k) => !b.shown.includes(k)),
      'the Short’s bar: play/pause, the seek bar, the time, mute and the volume; no -10/+10, Next, audio, quality or full window', b && b.shown);
    check(!!b && inside(b.seekRect, b.bar, 0) && b.seekRect.w >= b.bar.w - 40, 'the seek bar spans the player’s width', b && { seek: b.seekRect, bar: b.bar });
    const fitOk = await chrome.ev(`(() => { const bar = document.querySelector('.wp-layer .wp-tile .pb'); const r = bar.getBoundingClientRect();
      return [...bar.querySelectorAll('.pb-btn, .pb-vol, .pb-time')].filter((n) => n.getBoundingClientRect().width > 0).every((n) => { const q = n.getBoundingClientRect(); return q.left >= r.left - 0.5 && q.right <= r.right + 0.5 && q.bottom <= r.bottom + 0.5; }); })()`);
    check(fitOk, 'every control of the Short’s bar sits inside it (nothing clipped)');
    check(!!b && !meets(b.bar, x.info) && !meets(b.bar, x.nav), 'the bar covers neither Lumen’s side panel nor its Up/Down buttons', b && { bar: b.bar, info: x.info, nav: x.nav });
    const tops = await chrome.ev(`(() => { const pts = [];
      const add = (sel) => { const n = document.querySelector('.wp-layer ' + sel); if (!n) return; const r = n.getBoundingClientRect(); pts.push([sel, r.left + r.width / 2, r.top + r.height / 2]); pts.push([sel, r.left + r.width * 0.3, r.top + r.height * 0.75]); pts.push([sel, r.left + r.width * 0.7, r.top + r.height * 0.75]); };
      add('.sh-prev'); add('.sh-next'); add('.sh-info');
      return pts.map(([sel, px, py]) => { const n = document.elementFromPoint(px, py); return { sel, at: n ? n.className : '', ok: !!n && !!n.closest(sel) && !n.closest('.pb, .pb-menu, .pb-pill') }; }); })()`);
    check(tops.length === 9 && tops.every((q) => q.ok), 'Lumen’s Up/Down buttons and its side panel are on top at their own points (nothing of the bar over them)', tops.filter((q) => !q.ok));
    t = await guest.ev(TRIM);
    check(t.ctrl === true, 'YouTube’s own Shorts play button gives way to Lumen’s bar (hidden while it is on)', t);
    const inj0 = b ? b.injected : -1;
    // Left/Right (and L) seek the Short with the bar; they never move a Short.
    const mLR = await moves();
    await guest.ev('(() => { const v = document.querySelector("ytd-reel-video-renderer[is-active] video"); v.currentTime = 8; return 1; })()');
    await sleep(400);
    // Keys in YouTube's page arrive there as key events (dispatched in the page: CDP key injection into the focused
    // <webview> guest never reaches the page in the test instance). The bar's page bridge takes them on the window.
    await guest.ev('(() => { window.__kd = []; addEventListener("keydown", (e) => window.__kd.push(e.key + ":" + e.defaultPrevented), true); return 1; })()');
    const pageKey = (k) => guest.ev('(() => { (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: ' + JSON.stringify(k) + ', code: ' + JSON.stringify(k) + ', bubbles: true, cancelable: true })); return 1; })()');
    let t0 = await vt();
    await pageKey('ArrowRight');
    await sleep(500);
    let t1 = await vt();
    check(t1 - t0 > 3.5 && t1 - t0 < 7, 'ArrowRight in the page: Lumen’s bar seeks the Short 5 s on', { t0, t1 });
    t0 = await vt();
    await pageKey('ArrowLeft');
    await sleep(500);
    t1 = await vt();
    check(t0 - t1 > 3 && t0 - t1 < 6.5 && (await guest.ev('window.__kd.length')) === 0, 'ArrowLeft in the page: 5 s back (both taken by the bar, not passed on)', { t0, t1, kd: await guest.ev('window.__kd.slice()') });
    await focusInfo();
    t0 = await vt();
    await keyIn(chrome, 'ArrowRight', 'ArrowRight', 39);
    await sleep(500);
    t1 = await vt();
    check(t1 - t0 > 3.5 && t1 - t0 < 7, 'ArrowRight with the focus on Lumen’s panel: the bar seeks 5 s on too', { t0, t1 });
    check(await moves() === mLR && (await curId()) === homeId, 'Left/Right never move a Short', { moves: (await moves()) - mLR, cur: await curId() });
    await shot(1280, 800);
    await sleep(3400);
    b = await pb();
    check(!!b && b.idle && b.on, 'still for 2.5 s while it plays: the bar hides', b && { idle: b.idle, on: b.on });
    const line = await chrome.ev(`(() => { const bar = document.querySelector('.wp-layer .wp-tile .pb'); const tr = bar.querySelector('.pb-track').getBoundingClientRect(); const row = getComputedStyle(bar.querySelector('.pb-row'));
      return { op: getComputedStyle(bar).opacity, h: Math.round(tr.height), w: Math.round(tr.width), bottom: Math.round(bar.getBoundingClientRect().bottom - tr.bottom), row: row.visibility }; })()`);
    check(line.op === '1' && line.h >= 2 && line.h <= 4 && line.w > 200 && line.bottom <= 12 && line.row === 'hidden', 'idle on a Short: a thin progress line stays at the player’s bottom, the buttons go', line);
    await shot(1280, 800, 'idle');

    /* ============================ 2. the wheel, one Short per gesture ============================ */
    let m0 = await moves();
    x = await sh();
    await wheelAt(x.info.x + x.info.w / 2, x.info.y + x.info.h / 2, 120);
    await settled('the wheel over Lumen’s info', S[0].id);
    check(await moves() === m0 + 1, 'one wheel notch over Lumen’s info: exactly ONE Short (forwarded, not swallowed)', { before: m0, after: await moves() });
    await sleep(500);
    m0 = await moves();
    x = await sh();
    for (let i = 0; i < 60; i++) { await wheelAt(x.info.x + x.info.w / 2, x.info.y + 60, Math.max(1, Math.round(36 * Math.pow(0.95, i)))); await sleep(14); }
    await settled('a trackpad burst', S[1].id);
    await sleep(600);
    check(await moves() === m0 + 1, 'a trackpad-style burst (60 small deltas and their inertia): exactly ONE Short', { before: m0, after: await moves() });
    m0 = await moves();
    await wheelAt(x.tile.x + 30, x.tile.y + x.tile.h / 2, -100);
    await settled('the wheel over the margin', S[0].id);
    check(await moves() === m0 + 1, 'the wheel over the margin beside the player: exactly one Short back', { before: m0, after: await moves() });
    await sleep(500);
    m0 = await moves();
    const stepsBefore = (await sh()).steps.length;
    await wheelAt(x.view.x + x.view.w / 2, x.view.y + x.view.h / 2, 100);
    await settled('the wheel over the player', S[1].id);
    x = await sh();
    check(await moves() === m0 + 1 && x.steps.length === stepsBefore, 'the wheel over the player: YouTube’s own handler moves one Short, and Lumen adds no second move', { moves: (await moves()) - m0, lumenSteps: x.steps.length - stepsBefore });

    /* ============================ 3. the arrows ============================ */
    await sleep(500);
    m0 = await moves();
    await chrome.ev('(() => { document.querySelector(".wp-layer .sh-hint").setAttribute("tabindex", "-1"); document.querySelector(".wp-layer .sh-info").setAttribute("tabindex", "-1"); document.querySelector(".wp-layer .sh-info").focus(); return 1; })()');
    await keyIn(chrome, 'ArrowDown', 'ArrowDown', 40);
    await settled('ArrowDown in Lumen', S[2].id);
    await sleep(450);
    await chrome.ev('(() => { document.querySelector(".wp-layer .sh-info").focus(); return 1; })()');
    await keyIn(chrome, 'ArrowUp', 'ArrowUp', 38);
    await settled('ArrowUp in Lumen', S[1].id);
    check(await moves() === m0 + 2, 'ArrowDown then ArrowUp with focus on Lumen’s info: one Short each way', { moves: (await moves()) - m0 });
    m0 = await moves();
    await keyIn(guest, 'ArrowDown', 'ArrowDown', 40);
    await settled('ArrowDown in the page', S[2].id);
    check(await moves() === m0 + 1, 'ArrowDown in the page: YouTube’s own key moves one Short');
    b = await pbWait('b.on && b.short', 5000);
    check(await bars() === 1 && !!b && b.injected === inj0, 'after 7 moves: still exactly one Lumen bar, and its page bridge was never put in again (no second set of listeners)', { bars: await bars(), injected: b && b.injected, inj0 });
    await focusInfo();
    await keyIn(chrome, 'k', 'KeyK', 75);
    await sleep(500);
    const pz = await guest.ev('(() => { const a = document.querySelector("ytd-reel-video-renderer[is-active] video"); return { act: a ? a.paused : null, id: location.pathname.split("/").pop() }; })()');
    b = await pb();
    check(pz.act === true && !!b && !!b.st && b.st.p === true, 'K after the moves pauses the Short now on screen (the bar follows each move) and the bar says paused', { pz, st: b && b.st });
    await keyIn(chrome, 'k', 'KeyK', 75);
    await sleep(500);
    check(await guest.ev('!document.querySelector("ytd-reel-video-renderer[is-active] video").paused'), 'K again plays it');
    m0 = await moves();
    await wake();
    const pp = await chrome.ev('(() => { const n = document.querySelector(".wp-layer .wp-tile .pb .pb-play"); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
    await wheelAt(pp.x, pp.y, 120);
    await settled('the wheel over Lumen’s bar', S[3].id);
    check(await moves() === m0 + 1, 'one wheel notch over Lumen’s bar: exactly one Short (the bar never eats the wheel)', { moves: (await moves()) - m0 });
    await sleep(500);
    await wake();
    await chrome.ev('(() => { const n = document.querySelector(".wp-layer .wp-tile .pb .pb-play"); n.focus(); return 1; })()');
    await keyIn(chrome, 'ArrowUp', 'ArrowUp', 38);
    await settled('ArrowUp with the focus on Lumen’s play button', S[2].id);
    check(await moves() === m0 + 2, 'ArrowUp with the focus on the bar’s own button: one Short back (never the volume)', { moves: (await moves()) - m0 });
    b = await pb();
    check(await bars() === 1 && !!b && b.on && b.short && b.injected === inj0, 'and still one bar', { bars: await bars(), b: b && { on: b.on, injected: b.injected } });
    // Up/Down as key events in YouTube's page: the bridge leaves them to YouTube's own Shorts keys (one Short, never the volume).
    m0 = await moves();
    const vol0 = await guest.ev('document.querySelector("ytd-reel-video-renderer[is-active] video").volume');
    const cmdsUD = (await pb() || {}).cmds;
    await guest.ev('window.__kd = [], 1');
    await pageKey('ArrowDown');
    await settled('ArrowDown in YouTube’s page, the bar on', S[3].id);
    await sleep(450);
    await pageKey('ArrowUp');
    await settled('ArrowUp in YouTube’s page, the bar on', S[2].id);
    const kdUD = await guest.ev('window.__kd.slice()');
    check(await moves() === m0 + 2 && kdUD.join() === 'ArrowDown:false,ArrowUp:false' && (await pb() || {}).cmds === cmdsUD,
      'ArrowDown/ArrowUp in YouTube’s page with the bar on: YouTube’s own keys move one Short each; the bar passes them on untouched', { moves: (await moves()) - m0, kd: kdUD });
    check(await guest.ev('document.querySelector("ytd-reel-video-renderer[is-active] video").volume') === vol0, 'and the volume never moved', vol0);

    /* ============================ 4. Lumen's Next and Previous ============================ */
    let pr0 = await presses();
    await clickAt('.wp-layer .sh-next', 'Next');
    await settled('Next', S[3].id);
    x = await sh();
    check(!!x.next && x.next.disabled && /last Short/.test(x.next.why), 'at YouTube’s last Short, Lumen’s Next is off and says why', x.next);
    await clickAt('.wp-layer .sh-prev', 'Previous');
    await settled('Previous', S[2].id);
    let pr = await presses();
    check(pr.next === pr0.next + 1 && pr.prev === pr0.prev + 1, 'Lumen’s Next and Previous each press YouTube’s own button once', { before: pr0, after: pr });
    for (let i = 0; i < 3; i++) { await clickAt('.wp-layer .sh-prev', 'Previous'); await shWait(`x.phase === 'ready' && !x.prev.disabled || x.cur === ${JSON.stringify(homeId)}`, 4000); await sleep(450); }
    x = await shWait(`x.cur === ${JSON.stringify(homeId)} && x.phase === 'ready' && x.prev && x.prev.disabled`, 8000);
    check(!!x && /first Short/.test(x.prev.why), 'at the first Short, Lumen’s Previous is off and says why', x && x.prev);
    await clickAt('.wp-layer .sh-next', 'Next');
    await settled('Next again', S[0].id);

    /* ============================ 5. one click = one press ============================ */
    pr0 = await presses();
    await clickAt('.wp-layer .pv-like', 'Like');
    x = await shWait('x.like && x.like.pressed === "true" && !x.busy', 5000);
    pr = await presses();
    check(pr.like === pr0.like + 1 && !!x, 'one click on Lumen’s Like = exactly one press of YouTube’s Like; Lumen shows it liked', { pr, like: x && x.like });
    await clickAt('.wp-layer .pv-dislike', 'Dislike');
    x = await shWait('x.dislike && x.dislike.pressed === "true" && x.like.pressed === "false" && !x.busy', 5000);
    pr = await presses();
    check(pr.dislike === pr0.dislike + 1 && pr.like === pr0.like + 1 && !!x, 'Dislike: one press; YouTube took the like off and Lumen follows its page', pr);
    await clickAt('.wp-layer .pv-sub', 'Subscribe');
    x = await shWait('x.sub && x.sub.text === "Subscribed" && !x.busy', 5000);
    pr = await presses();
    check(pr.sub === pr0.sub + 1 && !!x && x.sub.pressed === 'true', 'Subscribe: one press; Lumen says Subscribed', { pr, sub: x && x.sub });
    await clickAt('.wp-layer .pv-sub', 'Subscribed');
    x = await shWait('x.confirm', 3000);
    check(!!x && (await presses()).sub === pr0.sub + 1, 'Subscribed asks Lumen’s own confirm first (nothing pressed yet)');
    await clickAt('.wp-layer .pv-confirm .pv-danger', 'Unsubscribe');
    x = await shWait('x.sub && x.sub.text === "Subscribe" && !x.busy && !x.confirm', 6000);
    pr = await presses();
    check(pr.sub === pr0.sub + 2 && pr.confirm === pr0.confirm + 1 && !!x, 'Unsubscribe: one press of YouTube’s button and one of its own confirm', pr);
    await clickAt('.wp-layer .pv-save', 'Save');
    x = await shWait('x.save && x.save.list.length === 2 && !x.busy', 6000);
    pr = await presses();
    check(!!x && x.save.list.map((o) => o.name).join('|') === F.PLAYLISTS.join('|') && pr.menu === pr0.menu + 1 && pr.saveItem === pr0.saveItem + 1, 'Save: YouTube’s own menu, then its Save list, drawn by Lumen', { list: x && x.save, pr });
    await clickAt('.wp-layer .pv-saveopt', 'Watch later');
    x = await shWait('x.save && x.save.list[0].on && !x.busy', 5000);
    pr = await presses();
    check(!!x && pr.saveToggle === pr0.saveToggle + 1, 'a playlist: one press of its own checkbox, the state read back', pr);
    await clickAt('.wp-layer .pv-savelist-done', 'Done');
    x = await shWait('!x.save && !x.busy', 4000);
    check(!!x && (await presses()).saveClose === pr0.saveClose + 1, 'Done closes YouTube’s list (one press)');
    // The next Short has its own state: the info follows it.
    await sleep(300);
    await clickAt('.wp-layer .sh-next', 'Next');
    x = await settled('Next after the presses', S[1].id);
    check(!!x && x.like.pressed === 'false' && x.dislike.pressed === 'false', 'the next Short’s own Like state (not the last one’s)', x && x.like);
    check(((await sh()).presses.filter((p) => p.ok === false)).length === 0, 'every press went through', (await sh()).presses.filter((p) => !p.ok));

    /* ============================ 6. the other sizes ============================ */
    await resize(1536, 800);
    await layoutOk('1536x800', 'beside');
    await shot(1536, 800);
    await resize(1920, 1000);
    await layoutOk('1920x1000', 'beside');
    await shot(1920, 1000);
    await resize(900, 800);
    await layoutOk('900x800', 'below');
    await resize(1280, 800);
    await layoutOk('1280x800 again', 'beside');

    /* ============================ 6a. the Short's own shape ============================ */
    // YouTube sizes a Short's player to the Short's own shape (a 3:4 Short is wider than a 9:16 one); Lumen does too,
    // clamped to 9:16 ... 1:1. Four Shorts, four shapes (?shapes=: tests/shorts-fixtures.js, served by shapeClip()).
    {
      const SHM = require('./watch-shorts.js');
      const lastShape = shapeClip('1x3') ? '1x3' : '3x4';
      const shapes = ['3x4', '9x16', '16x9', lastShape];
      const want = { '3x4': 3 / 4, '9x16': 9 / 16, '16x9': 1, '1x3': 9 / 16 };   // the shape the box takes (clamped)
      if (lastShape !== '1x3') say('6a: no 1x3 clip (QUARTZ_SHORTS_SHAPES/short-1x3.mp4), so the 4th Short is 3x4: the 1:3 clamp is not checked here');
      const boxed = async (label, shape, id) => {
        const a = want[shape];
        // Settled: no ease running, and the box is exactly box() for the tile and the shape (never a frame mid-ease).
        const y = await shWait(`x.cur === ${JSON.stringify(id)} && x.on && x.applied && !x.ease && x.view && x.tile && (() => { const e = LumenShorts.box(x.tile.w, x.tile.h, ${a}); return Math.abs(x.view.w - e.vw) <= 1 && Math.abs(x.view.h - e.vh) <= 1; })()`, 8000);
        const z = y || await sh();
        const exp = z && z.tile ? SHM.box(z.tile.w, z.tile.h, a) : null;
        say('6a ' + label + ' (' + shape + '): view ' + (z && z.view ? z.view.w + 'x' + z.view.h : '?') + ' in tile ' + (z && z.tile ? z.tile.w + 'x' + z.tile.h : '?') + ', mode ' + (z && z.mode) + ', aspect ' + (z && z.aspect));
        check(!!y && !!exp && Math.abs(y.view.w - exp.vw) <= 2 && Math.abs(y.view.h - exp.vh) <= 2 && y.mode === exp.mode && y.mode === mode0,
          label + ': a ' + shape + ' Short’s box is its own shape' + (a !== Number(shape.split('x')[0]) / Number(shape.split('x')[1]) ? ' clamped to ' + (a === 1 ? '1:1' : '9:16') : '') + ', the info still ' + mode0 + ' it',
          z && { cur: z.cur, view: z.view, tile: z.tile, mode: z.mode, exp: exp && { vw: exp.vw, vh: exp.vh, mode: exp.mode }, aspect: z.aspect });
        return y;
      };
      // Every frame's box while a Short moves (the chrome's rAF; one probe at a time: a new one ends the last): a new
      // shape eases in, moving for at most 150 ms, then never moves again.
      const PROBE = `(() => { const v = document.querySelector('.wp-layer .wp-tile.sh > .wp-view'); const id = (window.__shmId || 0) + 1; window.__shmId = id;
        const out = window.__shm = []; if (!v) return 0; const t0 = performance.now();
        const f = () => { if (window.__shmId !== id) return; const r = v.getBoundingClientRect(); out.push([Math.round(performance.now() - t0), Math.round(r.width), Math.round(r.height), Math.round(r.left)]); if (performance.now() - t0 < 2500) requestAnimationFrame(f); };
        requestAnimationFrame(f); return 1; })()`;
      const motion = async () => {
        await chrome.waitFor('(() => { const f = window.__shm || []; return f.length && f[f.length - 1][0] >= 2400 ? 1 : 0; })()', 6000).catch(() => 0);
        const fr = await chrome.ev('window.__shm || []');
        const k = (q) => q[1] + 'x' + q[2] + '@' + q[3];
        if (fr.length < 2) return { frames: fr.length, move: -1 };
        const first = k(fr[0]), last = k(fr[fr.length - 1]);
        const i0 = fr.findIndex((q) => k(q) !== first);
        if (i0 < 0) return { frames: fr.length, move: 0, from: first, to: last };
        const i1 = fr.findIndex((q, i) => i >= i0 && k(q) === last);
        let gap = 0;
        for (let i = i0; i <= i1; i++) gap = Math.max(gap, fr[i][0] - fr[i - 1][0]);
        return { frames: fr.length, move: fr[i1][0] - fr[i0][0], bound: fr[i1][0] - fr[i0 - 1][0], maxGap: gap, steps: fr.slice(i0, i1 + 1).map((q) => q[0] + ':' + q[1] + 'x' + q[2]).join(' '),
          after: fr.slice(i1).filter((q) => k(q) !== last).length, from: first, to: last };
      };
      const mode0 = (await sh()).mode;
      await chrome.ev(`openInLumen(${JSON.stringify(FY + '/shorts/' + S[0].id + '?shapes=' + shapes.join(','))}, { service: 'youtube', title: 'Shorts' }), 1`);
      x = await shWait(`x.cur === ${JSON.stringify(S[0].id)} && x.on && x.applied && x.phase === 'ready' && /shapes=/.test(x.url)`, 15000);
      check(!!x, 'the shapes page opens in the Shorts view', x && { phase: x.phase, why: x.why });
      await boxed('open at 1280x800', '3x4', S[0].id);
      await chrome.ev(PROBE);
      await clickAt('.wp-layer .sh-next', 'Next');
      await boxed('Next', '9x16', S[1].id);
      let mo = await motion();
      say('6a motion 3x4 -> 9x16: ' + JSON.stringify(mo));
      check(mo.move >= 0 && mo.move <= 150 && mo.after === 0 && mo.from !== mo.to, 'Next to a 9:16 Short: the box re-boxes, moving for at most 150 ms (first moved frame to the final one), then still', mo);
      await chrome.ev(PROBE);
      await clickAt('.wp-layer .sh-next', 'Next');
      await boxed('Next', '16x9', S[2].id);
      mo = await motion();
      say('6a motion 9x16 -> 16x9 (1:1): ' + JSON.stringify(mo));
      check(mo.move >= 0 && mo.move <= 150 && mo.after === 0 && mo.from !== mo.to, 'Next to a 16:9 one: the box re-boxes to 1:1, moving for at most 150 ms (first moved frame to the final one), then still', mo);
      await resize(1920, 1000);
      await boxed('resized to 1920x1000', '16x9', S[2].id);
      await resize(1280, 800);
      await boxed('back at 1280x800', '16x9', S[2].id);
      await clickAt('.wp-layer .sh-next', 'Next');
      await boxed('Next', lastShape, S[3].id);
      await clickAt('.wp-layer .sh-prev', 'Previous');
      await boxed('Previous', '16x9', S[2].id);
    }

    /* ============================ 6b. an ad Short: the bar's ad rules ============================ */
    await chrome.ev(`openInLumen(${JSON.stringify(FY + '/shorts/' + S[0].id + '?ad=1')}, { service: 'youtube', title: 'Shorts' }), 1`);
    x = await shWait(`x.cur === ${JSON.stringify(S[0].id)} && x.on && x.applied && x.phase === 'ready' && /[?]ad=1/.test(x.url)`, 15000);
    await guestNow();
    b = await pbWait('b.on && b.short && b.st', 12000);
    const prA = await presses();
    await focusInfo();
    await keyIn(chrome, 'ArrowDown', 'ArrowDown', 40);
    await settled('ArrowDown onto the ad Short', S[1].id);
    b = await pbWait('b.st && b.st.ad && b.st.ad.on', 6000);
    check(!!b, 'the ad Short: Lumen’s bar knows an ad plays', b || await pb());
    await wake();
    const adLbl = await chrome.ev('(() => { const n = document.querySelector(".wp-layer .wp-tile .pb .pb-ad"); return n && !n.hidden ? n.textContent : ""; })()');
    check(/^Ad/.test(adLbl), 'the bar says “Ad” with the time left', adLbl);
    const bl0 = b ? b.blocked : 0;
    await guest.ev('(() => { const v = document.querySelector("ytd-reel-video-renderer[is-active] video"); v.currentTime = 4; return 1; })()');
    await sleep(400);
    const a0 = await vt();
    await focusInfo();
    await keyIn(chrome, 'ArrowRight', 'ArrowRight', 39);
    await pageKey('l');
    await sleep(600);
    const a1 = await vt();
    b = await pb();
    check(a1 - a0 < 1.6 && !!b && b.blocked >= bl0 + 2, 'during the ad, ArrowRight and L never seek; the bar says why', { a0, a1, blocked: b && b.blocked, note: await chrome.ev('LumenPlayerBar._state().note') });
    await focusInfo();
    await keyShift(chrome, '>', 'Period', 190);
    await sleep(500);
    const rate = await guest.ev('document.querySelector("ytd-reel-video-renderer[is-active] video").playbackRate');
    check(rate === 1, 'during the ad, Shift+> never speeds it up', { rate, note: await chrome.ev('LumenPlayerBar._state().note') });
    await wake();
    await sleep(300);
    const cta = await guest.ev(`(() => { const n = document.querySelector('ytd-reel-video-renderer[is-active] .fx-ad-cta'); if (!n) return null; const r = n.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { x: r.left + r.width / 2, y: r.top + r.height / 2, vis: getComputedStyle(n).visibility, top: !!top && (top === n || n.contains(top)) }; })()`);
    x = await sh();
    const cp = cta && x && x.view ? { x: Math.round(x.view.x + cta.x), y: Math.round(x.view.y + cta.y) } : null;
    const over = cp ? await chrome.ev(`(() => { const n = document.elementFromPoint(${cp.x}, ${cp.y}); return n ? n.tagName + ' ' + n.className : ''; })()`) : '';
    check(!!cta && cta.vis === 'visible' && cta.top && /^WEBVIEW/.test(over), 'YouTube’s own ad button shows above Lumen’s bar, with nothing of Lumen’s over it', { cta, cp, over, bar: (await pb() || {}).bar });
    await shot(1280, 800, 'ad');
    if (cp) for (const type of ['mousePressed', 'mouseReleased']) await chrome.send('Input.dispatchMouseEvent', { type, x: cp.x, y: cp.y, button: 'left', clickCount: 1 });
    await sleep(500);
    check((await presses()).adCta === prA.adCta + 1, 'one click on YouTube’s own ad button: one press of it, through Lumen', { before: prA.adCta, after: (await presses()).adCta });
    m0 = await moves();
    await focusInfo();
    await keyIn(chrome, 'ArrowDown', 'ArrowDown', 40);
    await settled('ArrowDown past the ad Short (YouTube’s own Shorts move)', S[2].id);
    b = await pbWait('b.st && !(b.st.ad && b.st.ad.on)', 6000);
    check(!!b && await bars() === 1, 'the next Short is no ad: the full Short bar again, still one bar', b && b.st);

    /* ============================ 7. signed out, the page failed ============================ */
    await chrome.ev(`openInLumen(${JSON.stringify(FY + '/shorts/' + S[2].id + '?signedout=1')}, { service: 'youtube', title: 'Shorts' }), 1`);
    x = await shWait(`x.cur === ${JSON.stringify(S[2].id)} && /signed out/.test(x.note) && x.read && x.read.signedIn === false`, 15000);
    check(!!x && x.like.disabled && /Sign in/.test(x.like.why) && x.sub.disabled, 'signed out: Like and Subscribe are off, the reason said', x && { note: x.note, like: x.like });
    const dead = 'http://127.0.0.1:' + (await deadPort());
    await chrome.ev(`openInLumen(${JSON.stringify(dead + '/shorts/' + S[0].id)}, { service: 'youtube', title: 'Shorts' }), 1`);
    x = await shWait(`x.phase === 'failed' && /didn’t load/.test(x.why)`, 15000);
    check(!!x && x.next.disabled && /didn’t load/.test(x.note), 'the page failed: Lumen says so with the reason, Next/Previous off', x && { why: x.why, note: x.note });
    await chrome.ev('WatchPlayer.close("Close"), 1');
    await sleep(500);

    /* ============================ 8. the channel's Shorts button and the row's Shorts ============================ */
    const tabs1 = await tabsN();
    await g.ev(`WatchYt.open({ kind: 'channel', path: ${JSON.stringify(CHANNEL)}, name: 'Guitar Coach Ryan' }), 1`);
    const btn = await g.waitFor(`(() => { const b = [...document.querySelectorAll('#ytp .yt-shorts-btn')].find((n) => n.textContent.trim() === 'Shorts' && n.offsetParent); return b ? { out: !!b.querySelector('svg, .ico'), url: b.dataset.shorts } : null; })()`, 30000).catch(() => null);
    check(!!btn && !btn.out && btn.url === 'https://www.youtube.com' + CHANNEL + '/shorts', 'the channel page’s Shorts button: no external-link mark, the channel’s Shorts', btn);
    await g.ev(`(() => { [...document.querySelectorAll('#ytp .yt-shorts-btn')].find((n) => n.textContent.trim() === 'Shorts').click(); return 1; })()`);
    x = await shWait(`x.cur === ${JSON.stringify(S[0].id)} && x.phase === 'ready' && x.on`, 20000);
    check(!!x && x.title === S[0].title, 'the channel’s Shorts button opens the Shorts view at the channel’s first Short', x && { url: x.url, phase: x.phase, why: x.why });
    check(await tabsN() === tabs1, 'no tab opened for the channel’s Shorts');
    check(hits.indexOf(CHANNEL + '/shorts') >= 0, 'the channel’s own Shorts tab was the page opened');
    await chrome.ev('WatchPlayer.close("Close"), 1');
    await g.ev('(() => { if (WatchYt.isOpen()) WatchYt.close(); return 1; })()');
    await sleep(600);
    const rowBtn = await g.waitFor(`(() => { const r = document.querySelector('#stack section.lrow[data-key="r:yt-subs"]'); const b = r && [...r.querySelectorAll('.yt-hacts .yt-shorts-btn')][0]; return b ? (b.scrollIntoView({ block: 'nearest' }), b.dataset.shorts) : null; })()`, 30000).catch(() => null);
    check(rowBtn === 'https://www.youtube.com/shorts', 'Lumen’s YouTube row has a plain Shorts entry (youtube.com/shorts)', rowBtn);
    await g.ev(`(() => { document.querySelector('#stack section.lrow[data-key="r:yt-subs"] .yt-hacts .yt-shorts-btn').click(); return 1; })()`);
    x = await shWait(`x.cur === ${JSON.stringify(S[0].id)} && x.phase === 'ready' && x.on`, 20000);
    check(!!x && x.title === S[0].title, 'the row’s Shorts entry opens youtube.com/shorts in the Shorts view (YouTube picks the first)', x && { url: x.url, phase: x.phase });
    check(await tabsN() === tabs1, 'no tab opened for the Shorts entry');

    /* ============ 10. today's REAL page shape (read 10-18 from public Shorts; tests/yt-real/): frame, bar, buttons, perf ============ */
    {
      const R0 = S[0].id;
      await chrome.ev(`openInLumen(${JSON.stringify(FY + '/shorts/' + R0 + '?real=1&preload=1')}, { service: 'youtube', title: 'Shorts' }), 1`);
      x = await shWait(`x.cur === ${JSON.stringify(R0)} && x.phase === 'ready' && x.on && x.applied`, 20000);
      check(!!x, 'real page: it opens in the Shorts view, trimmed', x && { phase: x.phase, why: x.why, applied: x.applied });
      await guestNow();
      await sleep(1200);
      const frame = () => guest.ev(`(() => { const v = document.querySelector('#shorts-player video'); const r = v.getBoundingClientRect(); const o = document.getElementById('reel-overlay-container').getBoundingClientRect();
        return { v: [r.left, r.top, r.width, r.height].map(Math.round), ov: [o.left, o.top, o.width, o.height].map(Math.round), iw: innerWidth, ih: innerHeight, style: v.getAttribute('style') }; })()`);
      let fr = await frame();
      const edge = (f) => !!f && f.v[0] === 0 && f.v[1] === 0 && Math.abs(f.v[2] - f.iw) <= 1 && Math.abs(f.v[3] - f.ih) <= 1 && f.ov[0] === 0 && f.ov[1] === 0 && f.ov[2] === f.iw && f.ov[3] === f.ih;
      check(edge(fr), 'real page: the Short fills the frame edge to edge, centred (no black strip at the left, nothing cut at the right), over YouTube\'s own pillarbox offset', fr);
      x = await sh();
      check(!!x && x.view && Math.abs(x.view.w / x.view.h - 9 / 16) < 0.02, 'real page: the frame is 9:16', x && x.view);
      x = (await shWait('x.phase === \'ready\' && x.sub && !x.sub.disabled && x.dislike && !x.dislike.disabled', 8000)) || await sh();
      check(!!x && !x.sub.disabled && !x.dislike.disabled && !x.like.disabled && !/on this Short/.test(x.note), 'real page: YouTube\'s Subscribe and Dislike are found (no "aren\'t on this Short")', x && { note: x.note, sub: x.sub, dislike: x.dislike });
      const avatar = () => chrome.waitFor(`(() => { const i = document.querySelector('.wp-layer .sh-info .pv-avatar img'); return i && i.complete && i.naturalWidth > 0 ? { src: String(i.getAttribute('src')).slice(0, 24), text: i.parentNode.textContent.trim() } : null; })()`, 8000).catch(() => null);
      let av = await avatar();
      check(!!av && /^data:image\//.test(av.src) && av.text === '', 'real page: the channel\'s avatar is its picture (YouTube\'s lazy image loads under Lumen\'s veil), never an initial', av);
      const pr0 = await presses();
      await clickAt('.wp-layer .sh-info .pv-sub', 'Subscribe');
      x = await shWait('x.sub && /Subscribed/.test(x.sub.text)', 5000);
      check((await presses()).sub === pr0.sub + 1 && !!x, 'real page: one click on Lumen\'s Subscribe, one press of YouTube\'s own, read back as Subscribed', { before: pr0.sub, after: (await presses()).sub, sub: x && x.sub });

      // The bar follows the Short that plays: never the hidden watch page's paused video, never a preloaded neighbour.
      const live = () => guest.ev('(() => { const v = document.querySelector("#shorts-player video"); return { t: v.currentTime, p: v.paused, d: v.duration }; })()');
      let b = await pbWait('b.st && b.st.p === false && b.st.c > 0.3', 8000);
      let lv = await live();
      check(!!b && !b.st.p && Math.abs(b.st.c - lv.t) < 1.2 && !lv.p, 'real page: Lumen\'s bar shows the Short that plays (its time, playing), not the hidden watch page\'s paused 0:00', b && { bar: { c: b.st.c, p: b.st.p, d: b.st.d }, live: lv });
      const LT = '(() => { window.__lt = []; try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(Math.round(e.duration)))).observe({ type: "longtask" }); } catch (e) { window.__lt = ["n/a"]; } return 1; })()';
      await guest.ev(LT); await chrome.ev(LT);
      const BAR = '(() => { window.__barT = 0; const el = document.querySelector(".wp-layer .pb .pb-time"); if (!el) return 0; if (window.__barMo) window.__barMo.disconnect(); window.__barMo = new MutationObserver(() => { if (!window.__barT && /^0:0[0-1]/.test(el.textContent.trim())) window.__barT = Date.now(); }); window.__barMo.observe(el, { childList: true, subtree: true, characterData: true }); return 1; })()';
      const perf = {};
      const moveBy = async (how, fn, wantId) => {
        const m0 = await moves();
        await chrome.ev(BAR);
        const t0 = Date.now();
        await fn();
        const mv = await guest.waitFor(`window.__moves.length > ${m0} ? window.__moves[window.__moves.length - 1] : null`, 3000).catch(() => null);
        x = await settled('real page, ' + how, wantId);
        const bt = await chrome.waitFor('window.__barT || 0', 3000).catch(() => 0);
        b = await pbWait('b.st && b.st.p === false', 3000);
        lv = await live();
        perf[how] = { shownMs: mv ? mv.at - t0 : -1, barMs: bt ? bt - t0 : -1, moves: (await moves()) - m0 };
        perf[how].hows = await guest.ev(`window.__moves.slice(${m0}).map((m) => m.how + '@' + (m.at - ${t0}))`).catch(() => null); perf[how].lumen = await sh().then((z) => z && { steps: z.steps.slice(-3), wheels: z.wheels }).catch(() => null);
        check(!!mv && perf[how].moves === 1 && mv.to === wantId, 'real page, ' + how + ': exactly ONE Short moved', perf[how]);
        check(perf[how].shownMs >= 0 && perf[how].shownMs <= 300, 'real page, ' + how + ': the next Short shows within 300 ms', perf[how]);
        check(perf[how].barMs >= 0 && perf[how].barMs <= 400 && !!b && Math.abs(b.st.c - lv.t) < 1.2 && b.st.p === lv.p, 'real page, ' + how + ': Lumen\'s bar re-binds at once (new time, play state)', { barMs: perf[how].barMs, bar: b && { c: b.st.c, p: b.st.p }, live: lv });
        fr = await frame();
        check(edge(fr), 'real page, ' + how + ': still edge to edge', fr);
      };
      await focusInfo();
      await moveBy('ArrowDown', () => keyIn(chrome, 'ArrowDown', 'ArrowDown', 40), S[1].id);
      x = await sh();
      const wc = { x: Math.round(x.view.x + x.view.w / 2), y: Math.round(x.view.y + x.view.h / 2) };
      await chrome.ev('(() => { window.__wt = []; document.addEventListener("wheel", (e) => window.__wt.push(String(e.target.tagName) + "." + String(e.target.className).slice(0, 30)), true); return 1; })()');
      say('wheel point: ' + await chrome.ev(`(() => { const n = document.elementFromPoint(${wc.x}, ${wc.y}); return n ? n.tagName + '.' + String(n.className).slice(0, 40) : ''; })()`));
      await moveBy('a wheel burst over the player', () => Promise.all([0, 1, 2, 3, 4, 5].map((i) => sleep(i * 16).then(() => wheelAt(wc.x, wc.y, 60)))), S[2].id);
      say('wheel targets in Lumen: ' + JSON.stringify(await chrome.ev('window.__wt')));
      await moveBy('Lumen\'s Next', () => clickAt('.wp-layer .sh-next', 'Next'), S[3].id);
      av = await avatar();
      check(!!av && av.text === '', 'real page: after three moves the avatar is still a picture', av);
      const lts = { guest: await guest.ev('window.__lt'), chrome: await chrome.ev('window.__lt') };
      check([].concat(lts.guest, lts.chrome).every((d) => typeof d === 'number' ? d <= 50 : true), 'real page: no long task over 50 ms in the page or in Lumen during the moves', lts);
      say('perf: moves ' + JSON.stringify(perf) + ' long tasks ' + JSON.stringify(lts));
      await chrome.ev('(() => { if (window.__barMo) window.__barMo.disconnect(); return 1; })()');

      // A click gives visible feedback within 100 ms: the bar's play button flips at once.
      const pp0 = await chrome.ev('document.querySelector(".wp-layer .pb .pb-play").getAttribute("aria-label")');
      await wake();
      await sleep(200);
      const tc = Date.now();
      await clickAt('.wp-layer .pb .pb-play', 'play/pause');
      const flip = await chrome.waitFor(`(() => { const a = document.querySelector(".wp-layer .pb .pb-play").getAttribute("aria-label"); return a !== ${JSON.stringify(pp0)} ? Date.now() : 0; })()`, 2000).catch(() => 0);
      perf.click = flip ? flip - tc : -1;
      check(perf.click >= 0 && perf.click <= 150, 'real page: a click on the bar\'s play/pause shows within 100 ms (+ the 100 ms poll here)', { ms: perf.click, from: pp0 });
      // Idle (paused): no polling, no per-frame work, in the page or in Lumen.
      await sleep(600);
      await guest.send('Performance.enable').catch(() => 0); await chrome.send('Performance.enable').catch(() => 0);
      const met = async (c) => { const r = await c.send('Performance.getMetrics').catch(() => null); const m = {}; (r && r.metrics || []).forEach((x2) => { m[x2.name] = x2.value; }); return m; };
      const g0 = await met(guest), c0 = await met(chrome);
      await sleep(3000);
      const g1 = await met(guest), c1 = await met(chrome);
      perf.idle = { pageScriptMs: Math.round(((g1.ScriptDuration || 0) - (g0.ScriptDuration || 0)) * 1000), pageTaskMs: Math.round(((g1.TaskDuration || 0) - (g0.TaskDuration || 0)) * 1000),
        lumenScriptMs: Math.round(((c1.ScriptDuration || 0) - (c0.ScriptDuration || 0)) * 1000), lumenTaskMs: Math.round(((c1.TaskDuration || 0) - (c0.TaskDuration || 0)) * 1000) };
      check(perf.idle.pageScriptMs <= 30 && perf.idle.lumenScriptMs <= 60, 'real page, paused, 3 s idle: next to no script work in the page or in Lumen (no polling)', perf.idle);
      say('perf: click ' + perf.click + ' ms; idle ' + JSON.stringify(perf.idle));

      // 5. The quality chip names a 1080x1920 picture 1080p (its shorter side), never "1920p".
      await guest.ev('(() => { const c = document.createElement("canvas"); c.width = 1080; c.height = 1920; const g2 = c.getContext("2d"); g2.fillStyle = "#345"; g2.fillRect(0, 0, 1080, 1920); const v = document.createElement("video"); v.muted = true; v.srcObject = c.captureStream(1); v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0"; document.body.appendChild(v); v.play().catch(() => 0); window.__tall = v; return 1; })()');
      const qn = await chrome.waitFor('(() => { const e = WatchPlayer._state().extras; return e && /^\\d+p/.test(e.quality || "") && e.height >= 1000 ? { q: e.quality, h: e.height } : null; })()', 6000).catch(() => null);
      check(!!qn && /^1080p/.test(qn.q) && qn.h === 1080, 'real page: a 1080x1920 picture is named 1080p (its shorter side), not 1920p', qn || (await chrome.ev('WatchPlayer._state().extras')));
      await guest.ev('(() => { if (window.__tall) { window.__tall.srcObject = null; window.__tall.remove(); } return 1; })()');

      // Shots of the real-shaped Short.
      if (SHOT_REAL) {
        await clickAt('.wp-layer .pb .pb-play', 'play');
        for (const [w, h] of [[1280, 800], [1920, 1000]]) { await resize(w, h); await sleep(800); fr = await frame(); check(edge(fr), 'real page at ' + w + 'x' + h + ': edge to edge', fr); await shot(w, h, 'real'); }
        await resize(1280, 800);
      }
      // Signed out (as today): no Dislike on YouTube's page, and Lumen says it's a signed-out thing, not "missing".
      await chrome.ev(`openInLumen(${JSON.stringify(FY + '/shorts/' + S[2].id + '?real=1&signedout=1')}, { service: 'youtube', title: 'Shorts' }), 1`);
      x = await shWait(`x.cur === ${JSON.stringify(S[2].id)} && /signed out/.test(x.note) && x.read && x.read.signedIn === false`, 15000);
      check(!!x && x.dislike.disabled && /Sign in/.test(x.dislike.why) && !/on this Short/.test(x.note), 'real page signed out: Dislike is off with "Sign in", never "isn\'t on this Short"', x && { note: x.note, dislike: x.dislike });
      await chrome.ev('WatchPlayer.close("Close"), 1');
      await sleep(500);
    }

    /* ============================ 11. r62: nothing outlives its Short or its page ============================ */
    {
      const open = async (u, cond, ms) => { await chrome.ev(`openInLumen(${JSON.stringify(u)}, { service: 'youtube', title: 'Shorts' }), 1`); return shWait(cond, ms || 15000); };
      const ready = (id) => `x.cur === ${JSON.stringify(id)} && x.infoShort === x.cur && x.phase === 'ready' && x.on && x.applied`;
      // The page of THIS slot: the target at the slot's own address that is a live Shorts page (a closed slot's page
      // can linger in the target list for a moment, and guestNow() took the first match).
      const guestCur = async () => {
        const u = (await sh()).url;
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) {
          let list = [];
          try { list = await q.targets(); } catch (e) { list = []; }
          for (const t of list.filter((t2) => t2.webSocketDebuggerUrl && String(t2.url) === u).reverse()) {
            const g2 = await cdpTo(t).catch(() => null);
            if (!g2) continue;
            if (await g2.ev('document.visibilityState === "visible" && !!document.querySelector("ytd-shorts")').catch(() => false)) {
              if (guest) { try { guest.close(); } catch (e) { /* gone */ } }
              guest = g2;
              return g2;
            }
            try { g2.close(); } catch (e) { /* gone */ }
          }
          await sleep(200);
        }
        say('guestCur: no live page at ' + u + ', falling back');
        return guestNow();
      };
      // A page call that can't hang the run (a page that went away never answers): d after 4 s.
      const gev = (code, d) => (guest ? Promise.race([guest.ev(code).catch(() => d), sleep(4000).then(() => d)]) : Promise.resolve(d));
      const moves11 = () => gev('window.__moves.length', -1);
      const presses11 = () => gev('JSON.stringify(window.__presses)', 'null').then((j) => { try { return JSON.parse(j) || {}; } catch (e) { return {}; } });
      // A move made by the page itself (YouTube's own down/up button, pressed in the page): no Lumen step involved.
      const pageMove = (dir) => gev('(() => { const b = document.querySelector(' + JSON.stringify(dir > 0 ? '#navigation-button-down button' : '#navigation-button-up button') + '); if (!b) return 0; b.click(); return 1; })()', 0);
      const openG = async (u, cond, ms) => { const z = await open(u, cond, ms); await guestCur(); return z; };
      const brief = (z) => z && { cur: z.cur, phase: z.phase, info: z.infoShort, title: z.title, note: z.note, why: z.why, busy: z.busy, save: !!z.save, cover: z.cover };
      // a. Reopened at a Short (a new document in the same view), the page's own move to the Short it last moved to
      // is still read: did-navigate-in-page skipped a repeat of the last in-page address, never forgotten.
      x = await openG(FY + '/shorts/' + S[0].id, ready(S[0].id));
      await guestCur();
      await pageMove(1);
      await settled('r62 the page’s own key', S[1].id);
      x = await openG(FY + '/shorts/' + S[0].id, ready(S[0].id));
      check(!!x, 'r62: the same Short opened again in place is read', brief(x || await sh()));
      await guestCur();
      await pageMove(1);
      x = await shWait(ready(S[1].id), 8000);
      check(!!x && x.title === S[1].title, 'r62: reopened, the page’s own move to the Short it last moved to is read (the info follows)', brief(x || await sh()));
      // b. A reason about one Short ("This is the first Short") is that Short's, never the next one's.
      await pageMove(-1);
      await settled('r62 back to the first', S[0].id);
      await chrome.ev('LumenShorts._step(-1), 1');
      x = await shWait('/first Short/.test(x.note)', 4000);
      check(!!x, 'r62: Previous at the first Short says why', brief(x || await sh()));
      await pageMove(1);
      x = await shWait(ready(S[1].id), 8000);
      check(!!x && !/first Short/.test(x.note) && !x.why, 'r62: on the next Short the first Short’s reason is gone', brief(x || await sh()));
      // c. A held ArrowDown in the chrome is ONE Short (its auto-repeats are not more).
      let m1 = await moves11();
      await focusInfo();
      const kd = { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 };
      await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, kd));
      for (let i = 0; i < 5; i++) { await sleep(35); await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown', autoRepeat: true }, kd)); }
      await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, kd));
      await settled('r62 a held ArrowDown', S[2].id);
      await sleep(600);
      check((await moves11()) === m1 + 1 && (await sh()).cur === S[2].id, 'r62: a held ArrowDown (1 press + 5 auto-repeats) moves exactly one Short', { moves: (await moves11()) - m1, cur: (await sh()).cur });
      // d. The info is rebuilt only when it changes: the keyboard focus stays on its button, through a no-op update
      // and through a real one (Save's list opening).
      await chrome.ev('(() => { const i = document.querySelector(".wp-layer .sh-info"); i.firstChild.__r62 = 1; document.querySelector(".wp-layer .sh-info .pv-like").focus(); window.dispatchEvent(new Event("online")); return 1; })()');
      await sleep(400);
      let fz = await chrome.ev('(() => { const i = document.querySelector(".wp-layer .sh-info"); const a = document.activeElement; return { same: !!(i.firstChild && i.firstChild.__r62), focus: a ? a.className : "" }; })()');
      check(fz.same && /pv-like/.test(fz.focus), 'r62: an update that changes nothing leaves the info alone and the focus on Like', fz);
      await chrome.ev('(() => { const b = document.querySelector(".wp-layer .sh-info .pv-save"); b.focus(); b.click(); return 1; })()');
      x = await shWait('x.save && x.save.list.length === 2 && !x.busy', 6000);
      fz = await chrome.ev('(() => { const a = document.activeElement; return { focus: a ? a.className : "", inInfo: !!(a && a.closest && a.closest(".sh-info")) }; })()');
      check(!!x && fz.inInfo && /pv-save\b/.test(fz.focus), 'r62: Save opened by keyboard: the list shows and the focus is still on Save', { fz, save: x && x.save });
      // e. YouTube's Save list is closed in the page when he moves on (it was left open, invisible, for the next Save).
      const pz0 = await presses11();
      await pageMove(1);
      await settled('r62 moved with the Save list open', S[3].id);
      await sleep(500);
      const pz1 = await presses11();
      const left = await gev('!!document.querySelector("ytd-add-to-playlist-renderer")', null);
      check(pz1.saveClose === pz0.saveClose + 1 && !left && !(await sh()).save, 'r62: moving on closes YouTube’s Save list in the page too', { closes: pz1.saveClose - pz0.saveClose, left });
      // f. A press still in flight when the page becomes a new document: its answer never lands on the new Short,
      // and the buttons never stay "Waiting for YouTube…".
      x = await openG(FY + '/shorts/' + S[0].id + '?slowsave=1', ready(S[0].id));
      await clickAt('.wp-layer .pv-save', 'Save (slow)');
      await shWait('x.busy === "save-open"', 2000);
      x = await openG(FY + '/shorts/' + S[1].id, ready(S[1].id));
      await sleep(3500);
      x = await sh();
      check(!!x && x.cur === S[1].id && !x.busy && !x.save && !x.why && !!x.like && !x.like.disabled, 'r62: a press in flight across a new page: no stale answer, nothing left "Waiting for YouTube…"', brief(x) && Object.assign(brief(x), { like: x.like }));
      // g. A channel grid whose first Short never opens says so instead of "Opening the channel's Shorts…" for good.
      await chrome.ev('WatchPlayer.close("Close"), 1');
      await sleep(400);
      x = await openG(FY + CHANNEL + '/shorts?dead=1', `x.phase === 'empty'`, 16000);
      check(!!x && x.cover && /didn’t open the first Short/.test(x.why), 'r62: a grid whose first Short never opens: the cover says why', brief(x || await sh()));
      await chrome.ev('WatchPlayer.close("Close"), 1');
      await sleep(400);
      // h. Offline, the page failed: back online, it loads again by itself, and the old reason goes.
      x = await openG(FY + '/shorts/' + S[3].id, ready(S[3].id));
      const net = (off) => chrome.send('Network.emulateNetworkConditions', { offline: off, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch((e) => say('emulate: ' + e.message));
      await chrome.send('Network.enable').catch(() => 0);
      frontDown = true;
      await net(true);
      await chrome.ev('(() => { const v = document.querySelector(".wp-layer .wp-tile webview"); v.reload(); return 1; })()');
      x = await shWait(`x.phase === 'offline' || x.phase === 'failed'`, 12000);
      const onl = await chrome.ev('navigator.onLine');
      check(!!x && x.phase === 'offline' && /offline/.test(x.note), 'r62: offline and the page failed: Lumen says you’re offline', Object.assign(brief(x || await sh()) || {}, { onLine: onl }));
      frontDown = false;
      await net(false);
      x = await shWait(ready(S[3].id) + ' && !x.note && !x.why', 15000);
      check(!!x, 'r62: back online, the Shorts page loads again by itself and its old reason is gone', Object.assign(brief(x || await sh()) || {}, { onLine: await chrome.ev('navigator.onLine'), state: (await chrome.ev(`${ST}.slots[0]`)) }));
      // i. A very long right-to-left title, an emoji-first very long channel name, no avatar picture.
      x = await openG(FY + '/shorts/' + S[0].id + '?long=1', ready(S[0].id), 15000);
      const lg = await chrome.ev(`(() => { const i = document.querySelector('.wp-layer .sh-info'); const t = i.querySelector('.sh-title'); const n = i.querySelector('.pv-chan-name'); const av = i.querySelector('.pv-avatar');
        const r = (e) => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; };
        return { dir: t.dir, cdir: getComputedStyle(t).direction, clamped: t.scrollHeight > t.clientHeight + 2, ndir: getComputedStyle(n).direction, av: av.textContent, img: !!av.querySelector('img'),
          info: r(i), title: r(t), name: r(n), sub: r(i.querySelector('.pv-sub')), tile: r(i.closest('.wp-tile')) }; })()`);
      check(lg.dir === 'auto' && lg.cdir === 'rtl' && lg.clamped, 'r62: a long right-to-left title reads right to left, clamped', lg);
      check(lg.av === '🏒' && !lg.img, 'r62: no avatar picture: the channel’s whole first character (an emoji, not half of one)', { av: lg.av, img: lg.img });
      check(lg.name.r <= lg.info.r && lg.sub.r <= lg.info.r && lg.title.r <= lg.info.r && lg.info.b <= lg.tile.b, 'r62: the long title and channel stay inside Lumen’s info, the info inside the layer', lg);
      await shot(1280, 800, 'r62-long');
      await resize(1920, 1000);
      await shot(1920, 1000, 'r62-long');
      // j. The narrow layer (the info below the player): a note and the Save list are shown whole, never clipped.
      await resize(900, 800);
      x = await openG(FY + '/shorts/' + S[2].id + '?signedout=1', `x.cur === ${JSON.stringify(S[2].id)} && /signed out/.test(x.note)`, 15000);
      await sleep(500);
      const clip = await chrome.ev(`(() => { const i = document.querySelector('.wp-layer .sh-info'); const n = i.querySelector('.pv-why'); const b = i.getBoundingClientRect(), c = n ? n.getBoundingClientRect() : null;
        return { mode: i.closest('.wp-tile').getAttribute('data-sh'), info: [Math.round(b.top), Math.round(b.bottom)], note: c ? [Math.round(c.top), Math.round(c.bottom)] : null, scroll: i.scrollHeight - i.clientHeight, oy: getComputedStyle(i).overflowY }; })()`);
      check(clip.mode === 'below' && !!clip.note && clip.note[0] >= clip.info[0] - 1 && clip.note[1] <= clip.info[1] + 1, 'r62: 900x800 (below): the signed-out note is in sight inside the info, not cut off', clip);
      check(clip.scroll <= 0 || clip.oy === 'auto', 'r62: 900x800 (below): what doesn’t fit the band scrolls, never hidden', clip);
      // The wheel over that band scrolls it while it can (and then moves a Short again, as before).
      if (clip.scroll > 0) {
        const ib = await chrome.ev('(() => { const b = document.querySelector(".wp-layer .sh-info").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 30 }; })()');
        const mv0 = await moves11();
        await wheelAt(ib.x, ib.y, 120);
        await sleep(700);
        const st = await chrome.ev('document.querySelector(".wp-layer .sh-info").scrollTop');
        check(st > 0 && (await moves11()) === mv0, 'r62: the wheel over the band scrolls it first (no Short moved)', { scrollTop: st, moves: (await moves11()) - mv0 });
      }
      await shot(900, 800, 'r62-below-note');
      await resize(1280, 800);
      // k. A navigation that starts and is stopped, then a move in place to a normal video (real YouTube, Short ->
      // video): the page's trim comes off, so the video page is never left hidden under it.
      x = await openG(FY + '/shorts/' + S[1].id, ready(S[1].id));
      await guestCur();
      await guest.ev('(() => { window.__r62 = 1; location.assign("/__hang"); setTimeout(() => { window.stop(); setTimeout(() => { history.pushState({}, "", "/watch?v=aqz-KE-bpKQ"); }, 300); }, 700); return 1; })()');
      const tk = await guest.waitFor('(() => { const f = document.documentElement.hasAttribute("data-lumen-sh"); return !f && window.__r62 === 1 && location.pathname === "/watch" ? { flag: f, body: getComputedStyle(document.body).visibility } : null; })()', 6000).catch(() => null);
      const tk2 = await guest.ev('({ flag: document.documentElement.hasAttribute("data-lumen-sh"), mark: window.__r62 === 1, path: location.pathname, body: getComputedStyle(document.body).visibility })').catch((e) => ({ err: e.message }));
      check(!!tk && tk.body !== 'hidden', 'r62: a stopped navigation, then in place to a video: the trim comes off the same page (not left hidden)', { tk, now: tk2, sh: brief(await sh()) });
      await chrome.ev('WatchPlayer.close("Close"), 1');
      await sleep(500);
    }

    /* ============================ 9. never OS fullscreen ============================ */
    const w1 = await win();
    check(w1 && w1.fullScreen === false && w1.entered === 0 && (await chrome.ev('window.__fsCalls')) === 0, 'the window never went OS-fullscreen', { w1, fsCalls: await chrome.ev('window.__fsCalls') });
    say('front hits: ' + hits.filter((h) => /shorts/.test(h)).length + ' Shorts pages');
    try { guest && guest.close(); } catch (e) { /* gone */ }
    g.close();
    await chrome.ev('(() => { if (WatchPlayer.isOpen()) WatchPlayer.close("Close"); return 1; })()');
    await q.quit();
  } finally {
    srv.close();
    try { await mock.close(); } catch (e) { /* gone */ }
  }
});
