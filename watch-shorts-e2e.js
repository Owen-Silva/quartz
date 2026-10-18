try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine: no cap needed */ }
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
const CLIP = process.env.QUARTZ_SHORTS_CLIP || require('./tests/fixture-clip').CLIP;   // tests/media/lumen-test-clip.mp4 (testsrc2)
const SHOT_PREFIX = opt('shot-prefix', 'playview-shorts-');
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
function sendClip(req, res) {
  let st;
  try { st = fs.statSync(CLIP); } catch (e) { res.writeHead(404); res.end('no clip'); return; }
  const m = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range || ''));
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
  res.writeHead(m ? 206 : 200, Object.assign({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 }, m ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size } : {}));
  fs.createReadStream(CLIP, { start, end }).pipe(res);
}
const BS = String.fromCharCode(92);
const inScript = (v) => JSON.stringify(v).split('<').join(BS + 'u003c');
function ytPage(f, label) {
  const data = f && f.ytInitialData ? 'window.ytInitialData=' + inScript(f.ytInitialData) + ';' : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>YouTube</title><script>var ytcfg={data_:{LOGGED_IN:' +
    (!f || f.loggedIn === true) + '},get:function(k){return this.data_[k];}};' + data + '</script></head><body><div id="content">front YouTube (' + label + ')</div></body></html>';
}
const hits = [];
async function startServers(mock) {
  const front = await listen((req, res) => {
    const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
    const p = u.pathname.replace(/\/+$/, '') || '/';
    hits.push(p);
    if (p === '/__media/short.mp4') return sendClip(req, res);
    let m = /^\/shorts\/([A-Za-z0-9_-]{6,20})$/.exec(p);
    if (m) return sendHtml(res, F.shortsPage(m[1], { signedout: u.searchParams.has('signedout'), ad: u.searchParams.get('ad') }));
    if (p === '/shorts') return sendHtml(res, F.shortsPage('', {}));
    if (p === CHANNEL + '/shorts') return sendHtml(res, F.channelShorts(CHANNEL));
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
      const add = (sel) => { const n = document.querySelector('.wp-layer ' + sel); if (!n) return; const r = n.getBoundingClientRect(); pts.push([sel, r.left + r.width / 2, r.top + r.height / 2]); pts.push([sel, r.left + 4, r.bottom - 4]); pts.push([sel, r.right - 4, r.bottom - 4]); };
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
    let t0 = await vt();
    await keyIn(guest, 'ArrowRight', 'ArrowRight', 39);
    await sleep(500);
    let t1 = await vt();
    check(t1 - t0 > 3.5 && t1 - t0 < 7, 'ArrowRight in the page: Lumen’s bar seeks the Short 5 s on', { t0, t1 });
    t0 = await vt();
    await keyIn(guest, 'ArrowLeft', 'ArrowLeft', 37);
    await sleep(500);
    t1 = await vt();
    check(t0 - t1 > 3 && t0 - t1 < 6.5, 'ArrowLeft in the page: 5 s back', { t0, t1 });
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
    await keyIn(guest, 'l', 'KeyL', 76);
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
