try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine: no cap needed */ }
// watch-playerbar-e2e.js -- Lumen's own play bar (watch-playerbar.js + watch-playerbar-page.js + watch/playerbar/*)
// end to end in a REAL hidden Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen). LOCAL FIXTURES
// ONLY (tests/playerbar-fixtures/): a fake YouTube watch page (a local looping clip, a fake movie_player API with
// quality levels, captions, audio tracks and an ad with its own Skip button), a fake Disney+ page with textTracks,
// a fake Hulu page with NO track API. Watch's rows come from the local mock (tests/watch-mock.js). Never a real
// service, account, cookie or profile.
//
//   node watch-playerbar-e2e.js [--cdp 9791] [--shots <dir>]
//
// Checks: each control changes the real <video> (play/pause, seek, +-10 s, volume, mute, speed); the menus
// (YouTube quality / captions / audio through its API, Disney+ captions through textTracks, Hulu's own menu);
// the keys reach the bar, not the page; the service's bar is hidden only while Lumen's is on; YouTube's Skip
// button stays clickable in the fake ad and seeking is blocked; auto-hide after 2.5 s; Lumen's fullscreen
// fills the window and never the screen (Shift+F is the only way to the screen); Settings' "service's own";
// the fallbacks (no video in 8 s, two failed commands) bring the service's bar back with the reason. Shots.
// One summary line: "watch-playerbar-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9791'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'quartz-playerbar-shots'));
// A SYNTHETIC clip (tests/playerbar-clip.js: colour bars, a moving box, a clock, a tone; 2 min), never a recording
// of his: made once with the local ffmpeg, cached in %TEMP%.
const Clip = require('./tests/playerbar-clip');
const CLIP = process.env.QUARTZ_PLAYERBAR_CLIP || path.join(os.tmpdir(), 'lumen-playerbar-testclip.mp4');
const ensureClip = () => Clip.ensureClip(CLIP);
const FIX = path.join(__dirname, 'tests', 'playerbar-fixtures');
const SIZES = [[1280, 800], [1536, 800], [1920, 1000]];

/* ---- the local servers ----------------------------------------------------------------------- */
function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 2000;
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, origin: 'http://127.0.0.1:' + s.address().port }));
  });
}
function send(res, type, body) { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); }
function sendClip(req, res) {
  let st;
  try { st = fs.statSync(CLIP); } catch (e) { res.writeHead(404); res.end('no clip'); return; }
  const m = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range || ''));
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : Math.min(start + 4 * 1024 * 1024 - 1, st.size - 1);
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size, 'Content-Length': end - start + 1 });
    fs.createReadStream(CLIP, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
  fs.createReadStream(CLIP).pipe(res);
}
const NOVIDEO = '<!doctype html><title>No video</title><body style="margin:0;background:#000;color:#eee;font:14px Segoe UI">' +
  '<p style="padding:20px">This page has no video yet.</p><div class="controls__footer" id="dbar" style="position:absolute;left:0;right:0;bottom:0;height:60px;background:#03c">Disney+\'s own bar</div></body>';
const FIXPATH = { youtube: '/watch?v=pbtest', disney: '/video/pbtest', hulu: '/watch/pbtest' };
async function startServers(mock) {
  const fronts = {};
  for (const svc of Mock.SERVICES) {
    fronts[svc] = await listen((req, res) => {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      const p = u.pathname;
      if (p === '/__media/clip.mp4') return sendClip(req, res);
      if (p === '/__vtt/en.vtt' || p === '/__vtt/fr.vtt') return send(res, 'text/vtt', 'WEBVTT\n\n00:00.000 --> 59:00.000\nLumen test caption (' + (p.indexOf('fr') > 0 ? 'Fran\u00e7ais' : 'English') + ')\n');
      // Each fixture at its service's real player URL shape, so Lumen's play view goes boxed (watch-playview.js pageKind).
      const real = svc === 'youtube' ? (p === '/watch' && u.searchParams.get('v') === 'pbtest') : (!!FIXPATH[svc] && p === FIXPATH[svc]);
      const f = real ? [p, svc] : /^\/__pb\/(youtube|disney|hulu)$/.exec(p);
      if (f) return send(res, 'text/html; charset=utf-8', fs.readFileSync(path.join(FIX, f[1] + '.html'), 'utf8'));
      if (p === '/__pb/novideo') return send(res, 'text/html; charset=utf-8', NOVIDEO);
      const up = http.request({ host: '127.0.0.1', port: mock.ports[svc], path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + mock.ports[svc] }) }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('mock gone'); } });
      req.pipe(up);
    });
  }
  const tmdb = await listen((req, res) => { res.writeHead(404); res.end('none'); });
  const rebase = [['https://www.themoviedb.org', tmdb.origin], ['https://api.themoviedb.org', tmdb.origin]];
  for (const svc of Mock.SERVICES) for (const from of Mock.ORIGINS[svc]) rebase.push([from, fronts[svc].origin]);
  return { fronts, rebase, close: () => { tmdb.server.close(); for (const f of Object.values(fronts)) f.server.close(); } };
}

/* ---- CDP helpers ------------------------------------------------------------------------------ */
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
const KEYS = {
  k: ['k', 'KeyK', 75], l: ['l', 'KeyL', 76], j: ['j', 'KeyJ', 74], m: ['m', 'KeyM', 77], f: ['f', 'KeyF', 70], F: ['F', 'KeyF', 70], c: ['c', 'KeyC', 67],
  ' ': [' ', 'Space', 32], ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowDown: ['ArrowDown', 'ArrowDown', 40], ArrowRight: ['ArrowRight', 'ArrowRight', 39],
  '>': ['>', 'Period', 190], '<': ['<', 'Comma', 188], Escape: ['Escape', 'Escape', 27]
};
async function key(c, k, shift) {
  const [kk, code, vk] = KEYS[k];
  const base = { key: kk, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: shift ? 8 : 0 };
  const text = kk.length === 1 ? kk : undefined;
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: text ? 'keyDown' : 'rawKeyDown', text }, base));
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}
async function mouse(c, type, x, y, count) {
  await c.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : (count || 1) });
}
async function click(c, x, y, count) {
  await mouse(c, 'mouseMoved', x, y);
  await mouse(c, 'mousePressed', x, y, count || 1);
  await mouse(c, 'mouseReleased', x, y, count || 1);
}
function pngSize(file) { const b = fs.readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; }
const S = 'LumenPlayerBar._state().slots[0]';

run('watch-playerbar-e2e', async ({ check, launch, say }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  check(await ensureClip(), 'the synthetic test clip is here (made locally, no recording)', CLIP);
  const mock = await Mock.start({ log: () => {} });
  const srv = await startServers(mock);
  const env = {
    QUARTZ_WATCH_BOOT_GRACE_MS: '0',
    QUARTZ_WATCH_REBASE: JSON.stringify(srv.rebase),
    QUARTZ_WATCH_MIN_FREE_GB: '0',
    QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1',
    QUARTZ_TEST_VMP: 'signed',
    QUARTZ_TEST_CDM: 'ready'
  };
  const FY = srv.fronts.youtube.origin, FD = srv.fronts.disney.origin, FH = srv.fronts.hulu.origin;
  const q = await launch({ cdp: CDP_PORT, env });
  const chrome = q.chrome;
  try {
    // A window going fullscreen would leave the off-screen spot: the chrome's half is a counter here.
    await chrome.ev('window.__fsCalls = 0; window.toggleFullscreen = function () { window.__fsCalls++; }; 1');
    await chrome.ev('try { localStorage.removeItem("lumen.playbar"); } catch (e) {} 1');
    check(await chrome.ev('!!window.LumenPlayerBar && !!window.LumenPlayerBarPage && !!(window.LumenPlayerBarAdapters && LumenPlayerBarAdapters.youtube && LumenPlayerBarAdapters.hulu)'), 'the bar, the bridge and the adapters are loaded');
    await chrome.ev('openWatchTab(), 1');
    await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 20000);
    await sleep(1500);

    const open = async (origin, svc, title) => {
      const url = origin + FIXPATH[svc];
      await chrome.ev(`openInLumen(${JSON.stringify(url)}, { service: ${JSON.stringify(svc)}, title: ${JSON.stringify(title)} }), 1`);
      const t = await targetWhere(q, (x) => String(x.url).indexOf(url) === 0, 15000);
      return t ? cdpTo(t) : null;
    };
    // Lumen's play view boxes a service's player page (the fixtures sit at real player URL shapes), and the bar must
    // then live in #lumen-pv-barmount at the video box's bottom edge. Not boxed is a failure, not a pass.
    const PVQ = '(() => { const t = document.querySelector(".wp-tile.pv"); const m = document.getElementById("lumen-pv-barmount"); const b = document.querySelector(".pb"); if (!b) return null; const br = b.getBoundingClientRect(); const mr = m && m.getBoundingClientRect(); return { boxed: !!t, inMount: !!m && b.parentNode === m, mountInTile: !!t && !!m && m.parentNode === t, barBottom: Math.round(br.bottom), mountTop: mr ? Math.round(mr.top) : null, barW: Math.round(br.width), mountW: mr ? Math.round(mr.width) : null }; })()';
    const pvMount = async (label) => {
      await chrome.waitFor('(() => { const x = ' + PVQ + '; return x && x.boxed && x.inMount ? x : null; })()', 10000).catch(() => 0);
      const pv = await chrome.ev(PVQ);
      check(!!pv && pv.boxed, label + ': Lumen\'s play view is boxed at the player URL', pv);
      check(!!pv && pv.boxed && pv.inMount && pv.mountInTile && Math.abs(pv.barBottom - pv.mountTop) <= 2 && Math.abs(pv.barW - pv.mountW) <= 2,
        label + ': the bar is in #lumen-pv-barmount, at the video box\'s bottom edge and as wide as the box', pv);
      return pv;
    };
    const vid = (g, expr) => g.ev(`(() => { const v = document.querySelector('video'); return ${expr}; })()`);
    const at = (sel) => chrome.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.offsetParent) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]; })()`);
    const viewAt = () => chrome.ev('(() => { const r = document.querySelector(".wp-layer webview").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()');
    const wake = async () => { const r = await viewAt(); await mouse(chrome, 'mouseMoved', r[0] + r[2] * 0.5, r[1] + r[3] * 0.4); await mouse(chrome, 'mouseMoved', r[0] + r[2] * 0.52, r[1] + r[3] * 0.42); await sleep(350); };
    const press = async (sel) => { await wake(); const p = await at(sel); if (!p) return false; await click(chrome, p[0], p[1]); await sleep(450); return true; };
    const pickItem = async (id) => { const p = await at(`.pb-menu:not([hidden]) .pb-item[data-id="${id}"]`); if (!p) return false; await click(chrome, p[0], p[1]); await sleep(600); return true; };
    const shoot = async (name, prep) => {
      for (const [w, h] of SIZES) {
        await chrome.ev(`window.api.watchPlayer.testCapture({ width: ${w}, height: ${h}, wait: 1200 })`);
        if (prep) await prep();
        await sleep(500);
        // An open menu follows its button when the window resizes (the box re-centres; the video's rect doesn't change).
        const mp = await chrome.ev('(() => { const m = document.querySelector(".pb-menu:not([hidden])"); const a = document.querySelector(".pb [aria-expanded=\\"true\\"]"); if (!m || !a || !m.offsetParent) return null; const mr = m.getBoundingClientRect(), ar = a.getBoundingClientRect(); return { dRight: Math.round(mr.right - ar.right), above: Math.round(ar.top - mr.bottom) }; })()');
        if (mp) check(Math.abs(mp.dRight) <= 40 && mp.above >= 0 && mp.above <= 80, name + ' ' + w + 'x' + h + ': the open menu sits just above its button', mp);
        const cap = await chrome.ev('window.api.watchPlayer.testCapture({ wait: 0 })');
        const file = path.join(SHOTS, 'playerbar-' + name + '-' + w + 'x' + h + '.png');
        if (cap && cap.ok && cap.png) fs.writeFileSync(file, Buffer.from(cap.png, 'base64'));
        const sz = fs.existsSync(file) ? pngSize(file) : null;
        check(!!sz && sz[0] >= w && sz[1] >= h, 'shot ' + path.basename(file) + ' is ' + (sz ? sz.join('x') : 'missing'), sz);
      }
      await chrome.ev('window.api.watchPlayer.testCapture({ width: 1536, height: 800, wait: 900 })');
    };

    /* ============================== YouTube ============================== */
    await chrome.ev('window.api.watchPlayer.testCapture({ width: 1536, height: 800, wait: 600 })');
    const g = await open(FY, 'youtube', 'Lumen play bar test');
    check(!!g, 'the fake YouTube page opened in the layer');
    const ready = await g.waitFor('(() => { const v = document.querySelector("video"); return !!v && v.readyState >= 2 && v.duration > 30; })()', 20000).then(() => true, () => false);
    check(ready, 'the fake YouTube page\'s video plays', await g.ev('(() => { const v = document.querySelector("video"); return v ? { rs: v.readyState, d: v.duration, err: v.error && v.error.code, src: v.currentSrc } : null; })()'));
    if (!ready) throw new Error('the clip never played: nothing else can be judged');
    await chrome.waitFor(S + ' && ' + S + '.on && ' + S + '.st', 15000).catch(() => 0);
    let st = await chrome.ev(S);
    check(st && st.on && st.ready && !st.fell, 'Lumen\'s bar is on for YouTube', st && { on: st.on, fell: st.fell });
    check(await g.ev('document.documentElement.classList.contains("lumen-pb-on") && getComputedStyle(document.getElementById("ytbar")).visibility === "hidden" && getComputedStyle(document.getElementById("yttop")).visibility === "hidden"'),
      'YouTube\'s own bar is hidden (one class on <html>) while Lumen\'s is on');
    check(await g.ev('getComputedStyle(document.getElementById("ytbar")).pointerEvents === "none"'), 'and it takes no clicks');
    // Lumen's play view (merged): the bar sits in its mount at the video box's bottom edge, and the view's own
    // YouTube-bar hook (html.lumen-pv-bar) is set while Lumen's bar is on.
    await pvMount('YouTube');
    check(await g.ev('document.documentElement.classList.contains("lumen-pv-bar")'), 'the play view\'s hook class lumen-pv-bar is on the page while Lumen\'s bar is');
    const dur = await vid(g, 'v.duration');
    // play / pause
    const p0 = await vid(g, 'v.paused');
    await press('.pb-play');
    check((await vid(g, 'v.paused')) === !p0, 'the play/pause button changes the video', { before: p0 });
    if (!(await vid(g, 'v.paused'))) await press('.pb-play');
    check(await vid(g, 'v.paused'), 'paused by Lumen\'s button');
    // seek bar click at ~50%
    await wake();
    const sb = await at('.pb-seek');
    const sbr = await chrome.ev('(() => { const r = document.querySelector(".pb-seek").getBoundingClientRect(); return [r.left, r.width]; })()');
    await click(chrome, sbr[0] + sbr[1] * 0.5, sb[1]);
    await sleep(700);
    const t50 = await vid(g, 'v.currentTime');
    check(Math.abs(t50 - dur / 2) < Math.max(4, dur * 0.02), 'a click in the middle of the seek bar seeks to the middle', { t: t50, dur });
    await press('.pb-fwd');
    const t60 = await vid(g, 'v.currentTime');
    check(Math.abs(t60 - (t50 + 10)) < 1.2, '+10 s', { from: t50, to: t60 });
    await press('.pb-back');
    await press('.pb-back');
    const t40 = await vid(g, 'v.currentTime');
    check(Math.abs(t40 - (t60 - 20)) < 1.2, '-10 s (twice)', { from: t60, to: t40 });
    st = await chrome.ev(S);
    check(st.st && Math.abs(st.st.c - t40) < 1.5 && /\d+:\d\d \/ \d+:\d\d/.test(await chrome.ev('document.querySelector(".pb-time").textContent')), 'the bar shows time / duration', await chrome.ev('document.querySelector(".pb-time").textContent'));
    check(await chrome.ev('parseFloat(getComputedStyle(document.querySelector(".pb-buf")).width) > 0'), 'the buffered part is drawn');
    // volume and mute (the clip autoplays muted)
    await chrome.ev('(() => { const r = document.querySelector(".pb-vol"); r.value = "40"; r.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()');
    await sleep(500);
    check(Math.abs((await vid(g, 'v.volume')) - 0.4) < 0.02 && (await vid(g, 'v.muted')) === false, 'the volume slider sets the volume (and unmutes)', { vol: await vid(g, 'v.volume'), muted: await vid(g, 'v.muted') });
    await press('.pb-mute');
    check((await vid(g, 'v.muted')) === true, 'the mute button mutes');
    await press('.pb-mute');
    check((await vid(g, 'v.muted')) === false, 'and unmutes');
    // speed menu
    await press('.pb-speed');
    check(await chrome.ev('!document.querySelector(".pb-menu").hidden && document.querySelector(".pb-menu").dataset.kind === "speed"'), 'the speed menu opens');
    await pickItem('1.5');
    check((await vid(g, 'v.playbackRate')) === 1.5, 'Speed 1.5x sets playbackRate', await vid(g, 'v.playbackRate'));
    // quality menu (YouTube's own API)
    await press('.pb-quality');
    st = await chrome.ev(S);
    const ql = st.menu && st.menu.model ? st.menu.model.items.map((i) => i.label) : [];
    check(st.menu && st.menu.kind === 'quality' && ql.join(',').indexOf('1080p,720p,480p,360p,Auto') === 0, 'the quality menu lists the player\'s own levels', ql);
    const lab = await chrome.ev('(() => [...document.querySelectorAll(".pb-menu:not([hidden]) .pb-item")].map((b) => { const l = b.querySelector(".pb-item-label"); const br = b.getBoundingClientRect(), lr = l.getBoundingClientRect(); const c = b.querySelector(".pb-item-check"); const cr = c ? c.getBoundingClientRect() : br; return { jc: getComputedStyle(b).justifyContent, ta: getComputedStyle(l).textAlign, gap: Math.round(lr.left - (c ? cr.right : br.left)) }; }))()');
    check(Array.isArray(lab) && lab.length > 0 && lab.every((x) => x.jc === 'flex-start' && x.ta === 'left' && x.gap >= 0 && x.gap <= 12), 'menu labels are left-aligned, right after the check column (not centred)', lab);
    await shoot('youtube-quality-menu');
    await press('.pb-quality');
    if (!(await chrome.ev('!document.querySelector(".pb-menu").hidden'))) await press('.pb-quality');
    await pickItem('hd1080');
    check(JSON.stringify(await g.ev('window.__range')) === '["hd1080","hd1080"]', 'picking 1080p calls setPlaybackQualityRange(hd1080, hd1080)', await g.ev('window.__range'));
    // captions (YouTube's captions module)
    await press('.pb-cc');
    st = await chrome.ev(S);
    check(st.menu && st.menu.kind === 'captions' && st.menu.model.items.map((i) => i.label).join(',') === 'Off,English,Espa\u00f1ol', 'the captions menu: Off and YouTube\'s tracks', st.menu && st.menu.model.items);
    await pickItem('es');
    check((await g.ev('window.__cc && window.__cc.languageCode')) === 'es', 'picking Espa\u00f1ol sets YouTube\'s caption track');
    // audio
    await press('.pb-audio');
    await pickItem('es.3');
    check((await g.ev('window.__at && window.__at.id')) === 'es.3', 'picking the dubbed audio calls setAudioTrack');

    /* ---- keys, pressed in the page (the focus is there) ---- */
    await g.ev('window.__pageKeys = []; 1');
    await g.ev('document.body.focus(), 1');
    const kp = await vid(g, 'v.paused');
    await key(g, 'k'); await sleep(400);
    check((await vid(g, 'v.paused')) === !kp, 'K plays/pauses');
    await key(g, ' '); await sleep(400);
    check((await vid(g, 'v.paused')) === kp, 'Space plays/pauses');
    if (!(await vid(g, 'v.paused'))) { await key(g, 'k'); await sleep(400); }
    const kt = await vid(g, 'v.currentTime');
    await key(g, 'l'); await sleep(400);
    check(Math.abs((await vid(g, 'v.currentTime')) - (kt + 10)) < 1.2, 'L +10 s');
    await key(g, 'j'); await sleep(400);
    check(Math.abs((await vid(g, 'v.currentTime')) - kt) < 1.2, 'J -10 s');
    await key(g, 'ArrowRight'); await sleep(400);
    check(Math.abs((await vid(g, 'v.currentTime')) - (kt + 5)) < 1.2, 'Right arrow +5 s');
    const kv = await vid(g, 'v.volume');
    await key(g, 'ArrowUp'); await sleep(400);
    check(Math.abs((await vid(g, 'v.volume')) - Math.min(1, kv + 0.05)) < 0.011, 'Up arrow: volume +5%', { from: kv, to: await vid(g, 'v.volume') });
    await key(g, 'm'); await sleep(400);
    check((await vid(g, 'v.muted')) === true, 'M mutes');
    await key(g, 'm'); await sleep(300);
    const kr = await vid(g, 'v.playbackRate');
    await key(g, '>', true); await sleep(400);
    check((await vid(g, 'v.playbackRate')) === 1.75 && kr === 1.5, 'Shift+> speeds up a step', { from: kr, to: await vid(g, 'v.playbackRate') });
    await key(g, '<', true); await key(g, '<', true); await sleep(400);
    check((await vid(g, 'v.playbackRate')) === 1.25, 'Shift+< slows down a step');
    await key(g, 'c'); await sleep(500);
    check(!(await g.ev('window.__cc && window.__cc.languageCode')), 'C turns captions off');
    await key(g, 'c'); await sleep(500);
    check((await g.ev('window.__cc && window.__cc.languageCode')) === 'es', 'C turns them back on (the last track)');
    check(!(await g.ev('window.__pageKeys.some((k) => /^[kKjJlLmMfFcC <>]$|^Arrow/.test(k))')), 'YouTube\'s own key handler never saw the bar\'s keys', await g.ev('window.__pageKeys'));

    /* ---- Lumen's fullscreen: the window, never the screen ---- */
    await key(g, 'f'); await sleep(700);
    const fsBox = await chrome.ev('(() => { const r = document.querySelector(".wp-layer").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), innerWidth, innerHeight, document.body.classList.contains("page-fullscreen"), window.__fsCalls, !!document.querySelector(".wp-layer.wp-fs.pb-lumenfs")]; })()');
    check(fsBox[0] === fsBox[2] && fsBox[1] === fsBox[3] && fsBox[6], 'F: the video fills the Lumen window', fsBox);
    check(fsBox[5] === 0 && !fsBox[4] && (await g.ev('!document.fullscreenElement')), 'F never makes the window or the page fullscreen', fsBox);
    await wake();
    const fsBar = await chrome.ev('(() => { const b = document.querySelector(".pb"); const r = b.getBoundingClientRect(); return { inTile: b.parentNode.classList.contains("wp-tile"), bottom: Math.round(r.bottom), w: Math.round(r.width), idle: b.classList.contains("is-idle"), ih: innerHeight }; })()');
    check(fsBar.inTile && Math.abs(fsBar.bottom - fsBar.ih) <= 2 && !fsBar.idle, 'in Lumen\'s full window the bar is on the tile, at the bottom of the window', fsBar);
    await key(g, 'Escape'); await sleep(700);
    st = await chrome.ev(S);
    check(!st.fs && (await chrome.ev('!!document.querySelector(".wp-layer") && !document.querySelector(".wp-layer.wp-fs") && WatchPlayer._state().n === 1')), 'Esc leaves Lumen\'s full window and the player stays open');
    const vr = await viewAt();
    await click(chrome, vr[0] + vr[2] * 0.5, vr[1] + vr[3] * 0.4, 1);
    await click(chrome, vr[0] + vr[2] * 0.5, vr[1] + vr[3] * 0.4, 2);
    await sleep(800);
    st = await chrome.ev(S);
    check(st.fs && (await chrome.ev('window.__fsCalls')) === 0 && (await g.ev('!document.fullscreenElement')), 'a double-click on the video: Lumen\'s full window, not the screen', { fs: st.fs, calls: await chrome.ev('window.__fsCalls') });
    await press('.pb-fs');
    check(!(await chrome.ev(S)).fs, 'the fullscreen button leaves it');
    await g.ev('document.getElementById("ytfs").click(), 1');
    await sleep(600);
    check((await chrome.ev(S)).fs && (await chrome.ev('window.__fsCalls')) === 0, 'YouTube\'s own fullscreen call becomes Lumen\'s full window too');
    await key(g, 'F', true); await sleep(600);
    check((await chrome.ev(S)).whole && (await chrome.ev('window.__fsCalls')) === 1, 'Shift+F (the second action) is the only way to the whole screen', await chrome.ev('window.__fsCalls'));
    await key(g, 'Escape'); await sleep(700);
    st = await chrome.ev(S);
    check(!st.fs && !st.whole && !(await chrome.ev('document.body.classList.contains("page-fullscreen")')), 'Esc leaves both');

    /* ---- auto-hide ---- */
    if (await vid(g, 'v.paused')) await press('.pb-play');
    await wake();
    check(!(await chrome.ev(S)).idle, 'the bar shows on a mouse move');
    await sleep(3200);
    st = await chrome.ev(S);
    check(st.idle && (await chrome.ev('getComputedStyle(document.querySelector(".pb")).opacity')) === '0' && (await g.ev('document.documentElement.classList.contains("lumen-pb-idle")')), 'still for 2.5 s while playing: the bar and the cursor hide', { idle: st.idle, hover: st.hover, p: st.st && st.st.p, op: await chrome.ev('getComputedStyle(document.querySelector(".pb")).opacity'), cur: await g.ev('document.documentElement.className') });
    await key(g, 'ArrowDown'); await sleep(400);
    check(!(await chrome.ev(S)).idle, 'any key shows it again');
    await sleep(3200);
    await wake();
    check(!(await chrome.ev(S)).idle, 'and a mouse move');
    await press('.pb-play');
    await sleep(3000);
    check(!(await chrome.ev(S)).idle, 'paused, it stays');

    await shoot('youtube-idle', wake);

    /* ---- the ad ---- */
    await press('.pb-play');
    await g.ev('window.__startAd()');
    await sleep(800);
    st = await chrome.ev(S);
    check(st.st && st.st.ad && st.st.ad.on && /^Ad \u00b7 0:[0-3]\d/.test(await chrome.ev('document.querySelector(".pb-ad").textContent')), 'during the ad the bar says "Ad" with its countdown', await chrome.ev('document.querySelector(".pb-ad").textContent'));
    const adT = await vid(g, 'v.currentTime');
    await key(g, 'l'); await sleep(400);
    await key(g, 'ArrowRight'); await sleep(400);
    const adT2 = await vid(g, 'v.currentTime');
    // It keeps playing (at 1.25x) through the waits; L + Right would have been +15 s.
    check(adT2 - adT < 6 && adT2 >= adT - 0.05, 'seeking is blocked during the ad (L, Right)', { from: adT, to: adT2 });
    await wake();
    const sk2 = await chrome.ev('(() => { const r = document.querySelector(".pb-seek").getBoundingClientRect(); return [r.left + r.width * 0.2, r.top + r.height / 2]; })()');
    await click(chrome, sk2[0], sk2[1]);
    await sleep(400);
    const adT3 = await vid(g, 'v.currentTime');
    check(adT3 - adT2 < 6 && adT3 >= adT2 - 0.05, 'a click on the seek bar during the ad does not seek', { from: adT2, to: adT3 });
    check(/Seeking is off while the ad plays/.test((await chrome.ev('LumenPlayerBar._state()')).note), 'and it says why', (await chrome.ev('LumenPlayerBar._state()')).note);
    check(await g.ev('getComputedStyle(document.getElementById("whyad")).visibility === "visible" && getComputedStyle(document.getElementById("whyad")).pointerEvents !== "none"'), '"Why this ad" inside YouTube\'s hidden bar stays visible and clickable');
    check(await g.ev('!document.documentElement.classList.contains("lumen-pv-bar") && document.documentElement.classList.contains("lumen-pb-on")'), 'during the ad the play view\'s display:none hook is off (ad pieces inside YouTube\'s bar stay), Lumen\'s bar stays on');
    await wake();
    // "Why this ad" sits inside YouTube's bar, under where Lumen's bar is: lifted above it while Lumen's bar shows,
    // so nothing of Lumen's is over it (never half under a translucent bar).
    await sleep(300);
    const wy = await g.ev('(() => { const r = document.getElementById("whyad").getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, iw: innerWidth, lift: getComputedStyle(document.documentElement).getPropertyValue("--lumen-pb-lift") }; })()');
    const wyHost = await chrome.ev(`(() => { const w = ${JSON.stringify(wy)}; const vr = document.querySelector(".wp-layer webview").getBoundingClientRect(); const k = vr.width / w.iw; const x = vr.left + (w.l + w.w / 2) * k, y = vr.top + (w.t + w.h / 2) * k, bottom = vr.top + (w.t + w.h) * k; const pb = document.querySelector(".pb").getBoundingClientRect(); const e = document.elementFromPoint(x, y); return { bottom: Math.round(bottom), barTop: Math.round(pb.top), at: e ? e.tagName : null }; })()`);
    check(wyHost.bottom <= wyHost.barTop + 2 && wyHost.at === 'WEBVIEW', '"Why this ad" is lifted above Lumen\'s bar during the ad, and nothing of Lumen\'s covers it', Object.assign({ lift: wy.lift }, wyHost));
    // Today's ad overlay (read 10-18 from a real pre-roll): "Sponsored", the advertiser's link and its card sit in
    // YouTube's own whole-player layer, anchored to its bottom, where Lumen's bar is. Each is wholly above the bar,
    // nothing of Lumen's is over it, and a real click on it lands (one click, one press).
    await wake();
    await sleep(300);
    for (const [id, what, counter] of [['adsponsored', '"Sponsored"', ''], ['adlink', 'the advertiser\'s link', '__adLinks'], ['adcard', 'the advertiser\'s card', ''], ['adplay', 'the card\'s "Play now"', '__adClicks']]) {
      const pr = await g.ev(`(() => { const n = document.getElementById(${JSON.stringify(id)}); const r = n.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const top = document.elementFromPoint(cx, cy);
        return { l: r.left, t: r.top, w: r.width, h: r.height, iw: innerWidth, hit: !!top && (top === n || n.contains(top)), vis: getComputedStyle(n).visibility, pe: getComputedStyle(n).pointerEvents }; })()`);
      const host = await chrome.ev(`(() => { const w = ${JSON.stringify(pr)}; const vr = document.querySelector(".wp-layer webview").getBoundingClientRect(); const k = vr.width / w.iw;
        const x = vr.left + (w.l + w.w / 2) * k, y = vr.top + (w.t + w.h / 2) * k, top = vr.top + w.t * k, bottom = vr.top + (w.t + w.h) * k;
        const pb = document.querySelector(".pb").getBoundingClientRect(); const e = document.elementFromPoint(x, y);
        return { x: Math.round(x), y: Math.round(y), top: Math.round(top), bottom: Math.round(bottom), barTop: Math.round(pb.top), barBottom: Math.round(pb.bottom), at: e ? e.tagName : null }; })()`);
      check(host.bottom <= host.barTop + 1 && host.at === 'WEBVIEW' && pr.hit && pr.vis === 'visible' && pr.pe !== 'none', 'during the ad, YouTube\'s ' + what + ' is wholly above Lumen\'s bar, nothing of Lumen\'s over it, and its own', Object.assign({ hit: pr.hit, vis: pr.vis }, host));
      if (counter) {
        const before = await g.ev('window.' + counter + ' || 0');
        await click(chrome, host.x, host.y);
        await sleep(300);
        check((await g.ev('window.' + counter + ' || 0')) === before + 1, 'one click on YouTube\'s ' + what + ' through Lumen: one press of it', { before });
      }
    }
    await shoot('youtube-ad', wake);
    // The Skip button: where it is on screen, nothing of Lumen's is over it, and a real click lands.
    await wake();
    const skr = await g.ev('(() => { const r = document.getElementById("skip").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, innerWidth]; })()');
    const vr2 = await viewAt();
    const k2 = vr2[2] / skr[2];
    const sx = vr2[0] + skr[0] * k2, sy = vr2[1] + skr[1] * k2;
    check((await chrome.ev(`(() => { const e = document.elementFromPoint(${sx}, ${sy}); return e && e.tagName; })()`)) === 'WEBVIEW', 'nothing of Lumen\'s bar is over YouTube\'s Skip button', await chrome.ev(`(() => { const e = document.elementFromPoint(${sx}, ${sy}); return e && (e.className || e.tagName); })()`));
    await click(chrome, sx, sy);
    await sleep(800);
    check((await g.ev('window.__skipped')) === true, 'a real click on YouTube\'s Skip button works during the ad');
    st = await chrome.ev(S);
    check(st.st && !(st.st.ad && st.st.ad.on) && (await chrome.ev('document.querySelector(".pb-ad").hidden')), 'the ad over: the bar is back to normal');

    /* ---- Settings: the service's own bar ---- */
    await chrome.ev('localStorage.setItem("lumen.playbar", "service"), LumenPlayerBar.applyMode(), 1');
    await sleep(600);
    check(!(await chrome.ev(S)).on && (await g.ev('!document.documentElement.classList.contains("lumen-pb-on") && getComputedStyle(document.getElementById("ytbar")).visibility === "visible"')),
      'Settings "The service\'s own": Lumen\'s bar goes and YouTube\'s comes back');
    await chrome.ev('localStorage.removeItem("lumen.playbar"), LumenPlayerBar.applyMode(), 1');
    await sleep(600);
    check((await chrome.ev(S)).on && (await g.ev('document.documentElement.classList.contains("lumen-pb-on")')), 'back to Lumen: Lumen\'s bar again');
    const setOk = await chrome.ev('(() => { const f = document.createElement("div"); const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }; const seg = (opts, cur, pick) => { const w = el("div", "set-seg"); opts.forEach((o) => { const b = el("button", "set-seg-opt" + (o.id === cur ? " is-on" : ""), o.name); b.onclick = () => pick(o.id); w.appendChild(b); }); return w; }; LumenPlayerBar.renderSetting(f, { el, segmented: seg }); return f.textContent; })()');
    check(/Play bar/.test(setOk) && /Lumen/.test(setOk) && /The service\u2019s own/.test(setOk), 'the Settings row offers "Lumen" and "The service\'s own"', setOk);
    g.close();

    /* ============================== Disney+ (textTracks) ============================== */
    const d = await open(FD, 'disney', 'Lumen play bar test: Disney+');
    check(!!d, 'the fake Disney+ page opened');
    await d.waitFor('(() => { const v = document.querySelector("video"); return !!v && v.readyState >= 2; })()', 20000);
    await chrome.waitFor(S + ' && ' + S + '.svc === "disney" && ' + S + '.on', 15000).catch(() => 0);
    check((await chrome.ev(S)).on && (await d.ev('getComputedStyle(document.getElementById("dbar")).visibility === "hidden"')), 'Disney+: Lumen\'s bar on, Disney+\'s own bar hidden');
    await pvMount('Disney+');
    check(await d.ev('getComputedStyle(document.getElementById("drating")).visibility === "visible"'), 'Disney+\'s age-rating card inside its bar stays visible');
    await press('.pb-play');
    if (!(await vid(d, 'v.paused'))) await press('.pb-play');
    check(await vid(d, 'v.paused'), 'Disney+: Lumen\'s play/pause drives its video');
    await press('.pb-cc');
    st = await chrome.ev(S);
    check(st.menu && st.menu.model.via === 'tracks' && st.menu.model.items.map((i) => i.label).join(',') === 'Off,English,Fran\u00e7ais', 'Disney+ captions: Lumen-drawn from the video\'s textTracks', st.menu && st.menu.model);
    await shoot('disney-captions-menu');
    if (!(await chrome.ev('!document.querySelector(".pb-menu").hidden'))) await press('.pb-cc');
    await pickItem('1');
    check((await vid(d, '[...v.textTracks].map((t) => t.mode).join()')) === 'disabled,showing', 'picking Fran\u00e7ais shows that textTrack', await vid(d, '[...v.textTracks].map((t) => t.mode).join()'));
    await press('.pb-cc');
    await pickItem('off');
    check((await vid(d, '[...v.textTracks].map((t) => t.mode).join()')) === 'disabled,disabled', 'Off hides every track');
    await press('.pb-quality');
    st = await chrome.ev(S);
    check(st.menu && /picks the quality itself/.test(st.menu.model.note) && st.menu.model.items.some((i) => i.id === '__more'), 'Disney+ quality: the reason, and its own controls one click away', st.menu && st.menu.model);
    await press('.pb-quality');
    d.close();

    /* ============================== Hulu (no track API) ============================== */
    const hu = await open(FH, 'hulu', 'Lumen play bar test: Hulu');
    check(!!hu, 'the fake Hulu page opened');
    await hu.waitFor('(() => { const v = document.querySelector("video"); return !!v && v.readyState >= 2; })()', 20000);
    await chrome.waitFor(S + ' && ' + S + '.svc === "hulu" && ' + S + '.on', 15000).catch(() => 0);
    check((await chrome.ev(S)).on && (await hu.ev('getComputedStyle(document.getElementById("hbar")).visibility === "hidden"')), 'Hulu: Lumen\'s bar on, Hulu\'s own bar hidden');
    await pvMount('Hulu');
    await press('.pb-play');
    if (!(await vid(hu, 'v.paused'))) await press('.pb-play');
    await press('.pb-cc');
    st = await chrome.ev(S);
    check(st.menu && st.menu.model.via === 'own' && /Open Hulu\u2019s captions menu/.test(st.menu.model.items[0].label) && /opens Hulu\u2019s own menu/.test(st.menu.model.note), 'Hulu captions: no list, so the item opens Hulu\'s own menu and says so', st.menu && st.menu.model);
    await shoot('hulu-own-menu-path');
    if (!(await chrome.ev('!document.querySelector(".pb-menu").hidden'))) await press('.pb-cc');
    await pickItem('__own');
    await sleep(400);
    check((await hu.ev('document.documentElement.classList.contains("lumen-pb-own") && getComputedStyle(document.getElementById("hbar")).visibility === "visible" && !document.getElementById("hmenu").hidden')),
      'Hulu\'s own bar is unhidden just for that, and its Settings menu is open');
    check(/Hulu\u2019s own captions menu is open/.test(await chrome.ev('document.querySelector(".pb-ownpill").hidden ? "" : document.querySelector(".pb-ownpill").textContent')), 'Lumen says Hulu\'s own menu is open');
    await shoot('hulu-own-menu-open');
    const bk = await at('.pb-ownpill .pb-pill-btn');
    if (bk) await click(chrome, bk[0], bk[1]);
    await sleep(500);
    check((await hu.ev('!document.documentElement.classList.contains("lumen-pb-own") && getComputedStyle(document.getElementById("hbar")).visibility === "hidden"')) && !(await chrome.ev(S)).own, '"Back to Lumen\'s bar" hides Hulu\'s bar again');
    // Fallback: two failed commands in a row.
    await hu.ev('window.__breakPause()');
    await press('.pb-play');
    check(!(await chrome.ev(S)).fell && (await chrome.ev(S)).on, 'one failed command: still Lumen\'s bar (and a note)');
    await press('.pb-play');
    st = await chrome.ev(S);
    check(!st.on && /couldn\u2019t play or pause twice in a row/.test(st.fell) && /Hulu\u2019s own bar is back/.test(st.reason), 'the second failure in a row: the fallback, with the reason on screen', { fell: st.fell, reason: st.reason });
    check(await hu.ev('!document.documentElement.classList.contains("lumen-pb-on") && getComputedStyle(document.getElementById("hbar")).visibility === "visible"'), 'and Hulu\'s own bar is back');
    hu.close();

    /* ============================== no video in 8 s ============================== */
    await chrome.ev(`openInLumen(${JSON.stringify(FD + '/__pb/novideo')}, { service: 'disney', title: 'No video' }), 1`);
    const nt = await targetWhere(q, (x) => String(x.url).indexOf(FD + '/__pb/novideo') === 0, 15000);
    const n = nt ? await cdpTo(nt) : null;
    await sleep(2000);
    check(n && (await n.ev('getComputedStyle(document.getElementById("dbar")).visibility === "visible" && !document.documentElement.classList.contains("lumen-pb-on")')), 'before any video is found, the service\'s bar is never hidden');
    await chrome.waitFor(S + ' && !!' + S + '.fell', 12000).catch(() => 0);
    st = await chrome.ev(S);
    check(/found no video on Disney\+\u2019s page in 8 s, so Disney\+\u2019s own bar is back/.test(st.fell) && st.reason === st.fell && /found no video/.test((await chrome.ev('LumenPlayerBar._state()')).note), 'no video in 8 s: the fallback and its one-line reason, shown', { fell: st.fell, reason: st.reason });
    await shoot('fallback-reason');
    if (n) n.close();

    check((await chrome.ev('window.__fsCalls')) === 1, 'the only screen fullscreen all run was the one Shift+F asked for');
    await chrome.ev('WatchPlayer.close && WatchPlayer.close("e2e"), 1').catch(() => 0);
  } finally {
    await q.quit().catch(() => 0);
    srv.close();
    try { await mock.close(); } catch (e) { /* gone */ }
  }
});
