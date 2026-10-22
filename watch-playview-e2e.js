require('./tools/lowcpu-optional.js');   // first: the CPU cap, when one is configured (tools/lowcpu-optional.js; none on a cloud runner)
// watch-playview-e2e.js -- Lumen's playback view (watch-playview.js + watch-playview-main.js), end to end, in a REAL
// hidden Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen, watched by testwatch.js), on LOCAL
// FIXTURES ONLY (tests/playview-fixtures.js): a fake youtube.com/watch page with the real ids and a fake player page
// for Disney+, Hulu, Prime Video and ESPN+. Every service origin is rebased to a local front; every other host name
// resolves nowhere (--host-resolver-rules), so no request can reach a real service. Never a real account or cookie.
//
//   node watch-playview-e2e.js [--cdp 9771] [--shots <dir>]
//
// Checks: a YouTube tile plays in the view (only #movie_player visible, filling a 16:9 box, the info peeking under
// it); the info's title, channel, subscribers and description; Like, Dislike, Subscribe (with Lumen's confirm for
// Unsubscribe) and Save: one click = exactly one press of the page's own button, the state read back; the player's
// keys (Space/K, J/L, M, F) reach the player; F's fullscreen stays inside the window (never OS fullscreen); the wheel
// over the video scrolls Lumen's view; Full page and back, without a reload; 1280x800, 1536x800 and 1920x1000;
// Disney+, Hulu, Prime Video and ESPN+ (their own header and footer gone, the title, SxEy, the service, Show page);
// the states (the page failed, signed out, the info can't be read, no player found, "Continue watching?", offline);
// Settings > Lumen "The service's full page" behaves as before; the mini-player and multiview. Shots of each.
// One summary line: "watch-playview-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');
const F = require('./tests/playview-fixtures');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9771'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'quartz-playview-shots'));
// The playing video: a synthetic clip (testsrc2 + a sine tone), never a real recording.
const { CLIP, sendClip } = require('./tests/fixture-clip');
const SIZES = [[1280, 800], [1536, 800], [1920, 1000]];
const VID = 'pvTest00001';

/* ---- local servers --------------------------------------------------------------------------- */
function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 2000;
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, origin: 'http://127.0.0.1:' + s.address().port }));
  });
}
function sendHtml(res, body) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); }
const EMBED = '<!doctype html><title>embed</title><style>body{margin:0;background:#000}#movie_player{position:fixed;inset:0}video{width:100%;height:100%}</style>' +
  '<div id="movie_player"><video id="v" src="/__media/clip.mp4" autoplay muted loop playsinline></video></div>';
const hits = { youtube: 0, disney: 0, hulu: 0, prime: 0, espn: 0 };
async function startServers(mock) {
  const fronts = {};
  for (const svc of Mock.SERVICES) {
    fronts[svc] = await listen((req, res) => {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      const p = u.pathname;
      if (p === '/__media/clip.mp4') return sendClip(req, res);
      if (svc === 'youtube' && p === '/watch') {
        hits.youtube++;
        const q = { signedout: u.searchParams.has('signedout'), bare: u.searchParams.has('bare'), noplayer: u.searchParams.has('noplayer'), still: u.searchParams.has('still') };
        return sendHtml(res, F.youtubeWatch(q));
      }
      if (svc === 'youtube' && /^\/embed\//.test(p)) return sendHtml(res, EMBED);
      if (svc === 'disney' && /^\/play\//.test(p)) { hits.disney++; return sendHtml(res, F.servicePlayer('disney', 'Andor')); }
      if (svc === 'hulu' && /^\/watch\//.test(p)) { hits.hulu++; return sendHtml(res, F.servicePlayer('hulu', 'The Bear')); }
      if (svc === 'prime' && /^\/detail\//.test(p)) { hits.prime++; return sendHtml(res, F.servicePlayer('prime', 'The Boys')); }
      if (svc === 'espn' && /^\/watch\/player/.test(p)) { hits.espn++; return sendHtml(res, F.servicePlayer('espn', 'Bruins at Rangers')); }
      const up = http.request({ host: '127.0.0.1', port: mock.ports[svc], path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + mock.ports[svc] }) }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('mock gone'); } });
      req.pipe(up);
    });
  }
  const rebase = [];
  for (const svc of Mock.SERVICES) for (const from of Mock.ORIGINS[svc]) rebase.push([from, fronts[svc].origin]);
  return { fronts, rebase, close: () => { for (const f of Object.values(fronts)) f.server.close(); } };
}
async function deadPort() { const s = await listen(() => {}); const p = s.port; await new Promise((r) => s.server.close(r)); return p; }
function pngSize(file) { try { const b = fs.readFileSync(file); return b.readUInt32BE(16) + 'x' + b.readUInt32BE(20); } catch (e) { return 'unreadable'; } }

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
async function keyIn(c, key, code, vk) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 };
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  if (key.length === 1) await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'char', text: key }, base));
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}
const ST = 'WatchPlayer._state()';
const PS = 'LumenPlayview._state()';
// The page, seen from inside: is only the player there, filling the webview?
const TRIM = `(() => { const vw = innerWidth, vh = innerHeight; const mp = document.querySelector('[data-lumen-pv-root]');
  const v = document.getElementById('v');
  const base = { vw, vh, flag: document.documentElement.hasAttribute('data-lumen-pv'), playing: !!v && !v.paused && v.readyState >= 2 };
  const out = ['#masthead', '#search', '#secondary', '#related', 'ytd-ad-slot-renderer', '#comments', '#below', '#svc-header', '#svc-footer', '#svc-more'].map((sel) => {
    const n = document.querySelector(sel); if (!n) return null; const cs = getComputedStyle(n); return [sel, cs.display === 'none' || cs.visibility === 'hidden']; }).filter(Boolean);
  base.outside = out; base.outsideHidden = out.every((h) => h[1]);
  if (!mp) return Object.assign(base, { root: false });
  const r = mp.getBoundingClientRect();
  const pts = [[0.03, 0.03], [0.5, 0.5], [0.97, 0.97], [0.03, 0.97], [0.97, 0.03], [0.5, 0.97]].map(([x, y]) => document.elementFromPoint(vw * x, vh * y));
  return Object.assign(base, { root: true, rootId: mp.id || mp.className, fill: [Math.round(r.left), Math.round(r.top), Math.round(r.width - vw), Math.round(r.height - vh)],
    onlyPlayer: pts.every((n) => !!n && mp.contains(n)), visible: getComputedStyle(mp).visibility }); })()`;

run('watch-playview-e2e', async ({ check, launch, say }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const mock = await Mock.start({ log: () => {} });
  const srv = await startServers(mock);
  const FY = srv.fronts.youtube.origin;
  const env = {
    QUARTZ_WATCH_BOOT_GRACE_MS: '0', QUARTZ_WATCH_REBASE: JSON.stringify(srv.rebase), QUARTZ_WATCH_MIN_FREE_GB: '0',
    QUARTZ_PLAYER_FLOOR_GB: '0', QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1', QUARTZ_TEST_WINDOW_SIZE: '1280x800',
    QUARTZ_EDGE_STUB: path.join(os.tmpdir(), 'quartz-playview-edge-' + process.pid + '.txt'),
  };
  // No host name outside 127.0.0.1 resolves: nothing here can reach a real service. Scale 1: the shots are the window's true size.
  const args = ['--force-device-scale-factor=1', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'];
  try {
    const q = await launch({ cdp: CDP_PORT, env, args });
    const chrome = q.chrome;
    // The page's fullscreen asks the window to follow: here that is a counter, never the OS window.
    await chrome.ev('window.__fsCalls = 0; window.toggleFullscreen = function () { window.__fsCalls++; }; 1');
    const win = () => chrome.ev('window.api.lumenPlayview.testWin()');
    const w0 = await win();
    check(w0 && w0.ok && w0.fullScreen === false && w0.content.width === 1280 && w0.content.height === 800, 'the test window is really 1280x800, not fullscreen', w0);
    check(await chrome.ev('typeof window.LumenPlayview === "object" && LumenPlayview.view() === "lumen"'), 'Lumen view is the default');

    const pv = () => chrome.ev(`(() => { const s = ${PS}; return s.slots.find((x) => x.boxed) || s.slots[s.slots.length - 1] || null; })()`);
    const pvWait = (cond, ms) => chrome.waitFor(`(() => { const s = ${PS}; const x = s.slots.find((y) => y.boxed) || s.slots[s.slots.length - 1]; return x && (${cond}) ? x : null; })()`, ms || 15000).catch(() => null);
    const guestFor = async (prefix) => { const t = await targetWhere(q, (x) => String(x.url).indexOf(prefix) === 0, 15000); return t ? cdpTo(t) : null; };
    const grid = () => chrome.ev('(() => { const g = document.querySelector(".wp-grid").getBoundingClientRect(); return { x: Math.round(g.left), y: Math.round(g.top), w: Math.round(g.width), h: Math.round(g.height) }; })()');
    const clickAt = async (sel, label, between) => {
      // Scroll it into view, let that paint, then aim at the node that is there now (and say if something else is on top).
      const r = await chrome.ev(`(async () => { const q = () => document.querySelector(${JSON.stringify(sel)}); if (!q()) return null; q().scrollIntoView({ block: 'nearest' });
        await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
        const n = q(); if (!n) return null; const b = n.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const h = document.elementFromPoint(x, y);
        return { x, y, dis: !!n.disabled, hit: !!h && n.contains(h), at: h ? h.tagName + '.' + String(h.className).slice(0, 60) : null }; })()`);
      if (!r) { say('click: no ' + (label || sel)); return false; }
      if (!r.hit) say('click: ' + (label || sel) + ' is not under its own centre: ' + JSON.stringify(r));
      await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      if (between) await between();   // something else happens while the button is held down
      await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      return true;
    };
    const shot = async (name, w, h) => {
      const r = await chrome.ev(`window.api.watchPlayer.testCapture({ width: ${req[0]}, height: ${req[1]}, wait: 1400 })`).catch((e) => ({ ok: false, err: String(e && e.message) }));
      if (!r || !r.ok || !r.png) { check(false, 'shot ' + name + ' at ' + w + 'x' + h, r && r.err); return ''; }
      const f = path.join(SHOTS, 'playview-' + name + '-' + w + 'x' + h + '.png');
      fs.writeFileSync(f, Buffer.from(r.png, 'base64'));
      const sz = pngSize(f);
      check(sz === w + 'x' + h, 'shot ' + path.basename(f) + ' is really ' + w + 'x' + h, sz);
      return f;
    };
    // setContentSize on this frameless window can land a few px off (16x8 seen): ask again, corrected, until it is exact.
    let req = [1280, 800];
    const resize = async (w, h) => {
      let rw = w, rh = h;
      for (let i = 0; i < 4; i++) {
        await chrome.ev(`window.api.watchPlayer.testCapture({ width: ${rw}, height: ${rh}, wait: 700 }).then(() => 1)`);
        const c = (await win()).content;
        if (c.width === w && c.height === h) { req = [rw, rh]; break; }
        rw += w - c.width; rh += h - c.height;
      }
      await sleep(500);
    };
    // The box: 16:9, as wide as the layer allows, capped so 128px of the info always shows.
    const boxOk = async (label, svcPrefix) => {
      const s = await pv(); const g = await grid();
      const want = Math.min(g.w - 48, (g.h - 14 - 128) * 16 / 9);
      const okW = s && s.view && Math.abs(s.view.w - want) <= 2 && Math.abs(s.view.h - s.view.w * 9 / 16) <= 2;
      const peek = s && s.info && s.view ? (g.y + g.h) - s.info.y : 0;
      check(!!s && s.boxed && okW, label + ': the video box is 16:9 and as wide as allowed', { view: s && s.view, want: Math.round(want), grid: g });
      check(peek >= 100 && s.info.y >= s.view.y + s.view.h + 8, label + ': the info peeks under the video (' + Math.round(peek) + 'px shown)', { info: s && s.info, grid: g });
      if (svcPrefix) {
        const p = await guestFor(svcPrefix);
        const vp = p ? await p.ev('[innerWidth, innerHeight]') : null;
        check(!!vp && Math.abs(vp[0] - s.view.w) <= 2 && Math.abs(vp[1] - s.view.h) <= 2, label + ': the page’s own viewport is the box', { vp, view: s.view });
        if (p) p.close();
      }
    };

    /* ============================ 1. a YouTube tile plays in Lumen's view ============================ */
    await chrome.ev('openWatchTab(), 1');
    const gt = await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 15000);
    const g = await cdpTo(gt);
    const card = (svc) => `([...document.querySelectorAll('#stack .lrow[data-d="0"] *')].find((n) => n._item && n._item.service === '${svc}' && n.offsetParent)
      || [...document.querySelectorAll('*')].find((n) => n._item && n._item.service === '${svc}' && n.offsetParent))`;
    await g.waitFor(`!!(${card('youtube')})`, 60000);
    // A click on a tile whose row is not in focus brings the row up first (watch.js): click until the layer opens.
    const clickYT = async () => {
      for (let i = 0; i < 4; i++) {
        await g.ev(`(() => { const c = ${card('youtube')}; c.scrollIntoView({ block: 'nearest' }); c.click(); return 1; })()`);
        if (await chrome.waitFor(`${ST}.open ? 1 : 0`, 2500).catch(() => 0)) return true;
        await sleep(700);
      }
      return false;
    };
    const ytItem = await g.ev(`(() => { const c = ${card('youtube')}; return { title: c._item.title, id: c._item.id }; })()`);
    await clickYT();
    const s1 = await chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.n === 1 && s.slots[0].wcId !== null ? s : null; })()`, 15000).catch(() => null);
    check(!!s1 && s1.slots[0].url.indexOf(FY + '/watch?v=') === 0, 'a click on a YouTube tile opens its watch page in the layer', s1 && s1.slots[0].url);
    let ready = await pvWait('x.applied && x.phase === "ready"', 15000);
    check(!!ready && ready.boxed && ready.mode === 'lumen' && !ready.cover, 'the Lumen view: boxed, the page trimmed, the read complete, the cover gone', ready && { phase: ready.phase, applied: ready.applied, why: ready.why });
    let p = await guestFor(FY + '/watch?v=');
    await p.waitFor('(() => { const v = document.getElementById("v"); return v && !v.paused && v.currentTime > 0.2; })()', 20000).catch(() => 0);
    let t = await p.ev(TRIM);
    check(t.root && t.rootId === 'movie_player' && t.flag && t.visible === 'visible', 'the page marks #movie_player as the player', t);
    check(t.onlyPlayer && t.fill.every((n) => Math.abs(n) <= 1), 'only the player is visible, and it fills the page’s whole viewport', { fill: t.fill, onlyPlayer: t.onlyPlayer });
    check(t.outsideHidden && t.outside.length >= 6, 'YouTube’s masthead, search, recommendations, sponsored card, comments and metadata are not shown', t.outside);
    check(t.playing, 'the clip plays in YouTube’s own player');
    await boxOk('1280x800', FY + '/watch?v=');
    const bar = await chrome.ev(`(() => ({ title: ${ST}.title, yt: WatchPlayerYT._state() }))()`);
    check(bar.title === ytItem.title && bar.yt.fullShown && bar.yt.label === 'Full page', 'the bar keeps the tile’s title, and “Full page” is there', bar);
    ready = await pv();
    check(ready.title === F.TITLE && ready.channel === F.CHANNEL && ready.subs === F.SUBS, 'the info: the page’s title, the channel and its subscribers', { title: ready.title, channel: ready.channel, subs: ready.subs });
    check(ready.desc.indexOf(F.META) >= 0 && ready.desc.indexOf('A local clip') >= 0 && ready.comments && ready.read.comments && ready.read.comments.token === F.TOKEN,
      'the description (views, date, text) and a spot for comments; the comments continuation token is read for a later module', { desc: ready.desc.slice(0, 80), tok: ready.read && ready.read.comments });
    check(await chrome.ev('!!document.querySelector(".wp-layer.pv-on #lumen-pv-barmount") && !!document.querySelector("#lumen-pv-comments")'), 'the bar mount (#lumen-pv-barmount) and the comments spot (#lumen-pv-comments) exist');
    check(ready.like && !ready.like.disabled && ready.like.pressed === 'false' && ready.sub && ready.sub.text === 'Subscribe' && !ready.sub.disabled && ready.savebtn && !ready.savebtn.disabled,
      'Like, Subscribe and Save are on and read from the page', { like: ready.like, sub: ready.sub });
    await shot('youtube-first', 1280, 800);

    /* ============================ 2. one click = one press of YouTube's own button ============================ */
    const presses = () => p.ev('JSON.stringify(window.__presses)').then(JSON.parse);
    const born = await p.ev('window.__born');
    await clickAt('.wp-layer .pv-like', 'Like');
    let st = await pvWait('x.like && x.like.pressed === "true" && !x.busy', 5000);
    let pr = await presses();
    check(pr.like === 1 && !!st, 'one click on Lumen’s Like = exactly one press of YouTube’s Like, and Lumen shows it liked', { pr, like: st && st.like });
    check(await p.ev('document.getElementById("like").getAttribute("aria-pressed")') === 'true', 'YouTube’s own button is pressed');
    await clickAt('.wp-layer .pv-dislike', 'Dislike');
    st = await pvWait('x.dislike && x.dislike.pressed === "true" && x.like.pressed === "false" && !x.busy', 5000);
    pr = await presses();
    check(pr.dislike === 1 && pr.like === 1 && !!st, 'Dislike: one press; the page took the like off and Lumen follows the page', { pr });
    await clickAt('.wp-layer .pv-dislike', 'Dislike');
    st = await pvWait('x.dislike && x.dislike.pressed === "false" && !x.busy', 5000);
    pr = await presses();
    check(pr.dislike === 2 && !!st, 'Dislike again: one more press, off');
    // Subscribe, then Unsubscribe through Lumen's own confirm (Cancel presses nothing).
    await clickAt('.wp-layer .pv-sub', 'Subscribe');
    st = await pvWait('x.sub && x.sub.text === "Subscribed" && !x.busy', 5000);
    pr = await presses();
    check(pr.sub === 1 && !!st && st.sub.pressed === 'true', 'Subscribe: one press; Lumen says Subscribed', { pr, sub: st && st.sub });
    await clickAt('.wp-layer .pv-sub', 'Subscribed');
    st = await pvWait('x.confirm === true', 3000);
    pr = await presses();
    check(!!st && pr.sub === 1, 'a click on Subscribed asks first, in Lumen, and presses nothing yet', { pr });
    await clickAt('.wp-layer .pv-confirm .pv-ghost', 'Cancel');
    await sleep(300);
    pr = await presses();
    check(pr.sub === 1 && pr.confirm === 0 && (await pv()).confirm === false, 'Cancel: nothing pressed', pr);
    // r62-playview regression: Esc on "Unsubscribe from X?" closed the whole video. Esc now closes the confirm
    // first (watch-player takeShortcut asks the Lumen view), presses nothing, and the layer stays. (Opening the
    // confirm presses nothing either, so the exact counts below are untouched.)
    await clickAt('.wp-layer .pv-sub', 'Subscribed');
    await pvWait('x.confirm === true', 3000);
    const escTook = await chrome.ev('WatchPlayer.handleShortcut("escape")');
    await sleep(300);
    pr = await presses();
    check(escTook === true && (await pv()).confirm === false && pr.sub === 1 && pr.confirm === 0 && (await chrome.ev(`${ST}.open`)),
      'Esc on the Unsubscribe confirm closes the confirm only: nothing pressed, the video stays open', { escTook, pr, open: await chrome.ev(`${ST}.open`) });
    await clickAt('.wp-layer .pv-sub', 'Subscribed');
    await pvWait('x.confirm === true', 3000);
    await clickAt('.wp-layer .pv-confirm .pv-danger', 'Unsubscribe');
    st = await pvWait('x.sub && x.sub.text === "Subscribe" && !x.busy', 6000);
    pr = await presses();
    check(pr.sub === 2 && pr.confirm === 1 && !!st, 'Unsubscribe: YouTube’s button once and its own confirm once; Lumen says Subscribe', { pr });
    check(await p.ev('!document.querySelector("tp-yt-paper-dialog")'), 'YouTube’s confirm is gone from its page');
    // Save: YouTube's list, drawn by Lumen; one row = one press of that playlist's own checkbox.
    await clickAt('.wp-layer .pv-save', 'Save');
    st = await pvWait('x.save && x.save.list && x.save.list.length === 2 && !x.busy', 6000);
    pr = await presses();
    check(pr.save === 1 && !!st && st.save.list[0].name === 'Watch later' && st.save.list[0].on === false && st.save.list[1].on === true, 'Save: one press opens YouTube’s list; Lumen draws it with its states', { pr, save: st && st.save });
    await clickAt('.wp-layer .pv-saveopt', 'Watch later');
    st = await pvWait('x.save && x.save.list[0].on === true && !x.busy', 5000);
    pr = await presses();
    check(pr.saveOpt === 1 && !!st, '“Watch later”: one press of its own checkbox, now ticked', pr);
    await clickAt('.wp-layer .pv-savelist-done', 'Done');
    st = await pvWait('!x.save && !x.busy', 5000);
    pr = await presses();
    check(pr.saveClose === 1 && !!st && (await p.ev('!document.querySelector("ytd-add-to-playlist-renderer")')), 'Done: YouTube’s list closed with its own button', pr);
    check(pr.like === 1 && pr.dislike === 2 && pr.sub === 2 && pr.confirm === 1 && pr.save === 1 && pr.saveOpt === 1, 'no press ever happened by itself (the counts are exactly the clicks)', pr);
    // r62-playview regression: "Show more" rebuilds the info panel, and the rebuild dropped the keyboard focus
    // (a keyboard user lost his place) and the new button's state. Now the focus stays on the button, which
    // says it is expanded. Clicked again after, so the info is back to three lines for the sections below.
    await clickAt('.wp-layer .pv-more', 'Show more');
    await sleep(500);
    const more = await chrome.ev('(() => { const a = document.activeElement; const b = document.querySelector(".wp-layer .pv-more"); return { focused: !!a && a.classList.contains("pv-more"), expanded: b ? b.getAttribute("aria-expanded") : null, text: b ? b.textContent : null }; })()');
    check(more.focused && more.expanded === 'true' && /Show less/.test(more.text || ''), '“Show more”: the panel rebuilds with the focus still on the button, now aria-expanded="true"', more);
    await clickAt('.wp-layer .pv-more', 'Show less');
    await sleep(400);

    /* ============================ 3. the player's own keys ============================ */
    await chrome.ev('(() => { const v = document.querySelector(".wp-layer .wp-tile.pv webview"); v.focus(); return 1; })()');
    await p.ev('(() => { const v = document.getElementById("v"); v.currentTime = 20; return 1; })()');
    const vs = () => p.ev('(() => { const v = document.getElementById("v"); return { paused: v.paused, t: Math.round(v.currentTime), muted: v.muted }; })()');
    // With Lumen's play bar (watch-playerbar.js) on this video, the bar owns the keys and F is Lumen's full window.
    const PBS = '(() => { const z = window.LumenPlayerBar && LumenPlayerBar._state(); return z ? z.slots[z.slots.length - 1] || null : null; })()';
    const barOn = !!(await chrome.waitFor(`(() => { const b = ${PBS}; return b && b.on ? 1 : 0; })()`, 6000).catch(() => 0));
    const v0 = await vs();
    await keyIn(p, ' ', 'Space', 32); await sleep(250);
    const v1 = await vs();
    await keyIn(p, 'k', 'KeyK', 75); await sleep(250);
    const v2 = await vs();
    await p.ev('(() => { const v = document.getElementById("v"); v.pause(); v.currentTime = 15; return 1; })()');
    await keyIn(p, 'j', 'KeyJ', 74); await sleep(200);
    const v3 = await vs();
    await keyIn(p, 'l', 'KeyL', 76); await sleep(200);
    const v4 = await vs();
    await keyIn(p, 'm', 'KeyM', 77); await sleep(200);
    const v5 = await vs();
    await keyIn(p, 'm', 'KeyM', 77);
    await p.ev('document.getElementById("v").play().then(() => 1, () => 0)');
    check(v1.paused !== v0.paused && v2.paused === v0.paused, 'Space and K pause and play the player', { v0, v1, v2 });
    check(Math.abs(v3.t - 5) <= 1 && Math.abs(v4.t - 15) <= 1, 'J and L seek back and forward 10 s', { v3, v4 });
    check(v5.muted !== v4.muted, 'M mutes', { v4, v5 });
    await keyIn(p, 'f', 'KeyF', 70);
    const fsIn = barOn ? await chrome.waitFor(`(() => { const b = ${PBS}; return b && b.fs && document.querySelector('.wp-layer').classList.contains('wp-fs') ? 1 : 0; })()`, 5000).catch(() => 0)
      : await chrome.waitFor(`${ST}.fs ? 1 : 0`, 5000).catch(() => 0);
    const gfs = await p.ev('document.fullscreenElement ? document.fullscreenElement.id : ""');
    const wfs = await win();
    if (barOn) check(fsIn === 1 && gfs === '', 'F (Lumen’s play bar on): Lumen’s full window, the video fills it; YouTube’s page never goes fullscreen', { fsIn, gfs });
    else check(fsIn === 1 && gfs === 'movie_player', 'F: YouTube’s player goes fullscreen inside the window', { fsIn, gfs });
    check(wfs.fullScreen === false && wfs.entered === 0 && wfs.content.width === 1280, 'and the OS window did NOT go fullscreen', wfs);
    await keyIn(p, 'f', 'KeyF', 70);
    if (barOn) await chrome.waitFor(`(() => { const b = ${PBS}; return b && !b.fs ? 1 : 0; })()`, 5000).catch(() => 0);
    else await chrome.waitFor(`!${ST}.fs`, 5000).catch(() => 0);
    const keys = await p.ev('window.__keys.join(",")');
    if (barOn) check(keys === '', 'Lumen’s play bar took every one of those keys (none reached YouTube’s page as well: no double action)', keys);
    else check(keys === ' ,k,j,l,m,m,f,f', 'every key reached the player’s page (and only those)', keys);
    st = await pvWait('x.boxed && x.applied', 4000);
    check(!!st && !(await chrome.ev(`${ST}.fs`)), 'out of fullscreen: back in the box');

    /* ============================ 4. the wheel over the video scrolls Lumen's view ============================ */
    const vb = (await pv()).view;
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vb.x + vb.w / 2, y: vb.y + vb.h / 2, deltaX: 0, deltaY: 360 });
    await sleep(700);
    const scrolled = await chrome.ev('document.querySelector(".wp-layer .wp-tile.pv").scrollTop');
    check(scrolled > 20, 'the wheel over the video scrolls Lumen’s view down to the info (not trapped in the page)', scrolled);
    await chrome.ev('document.querySelector(".wp-layer .wp-tile.pv").scrollTop = 0, 1');

    /* ============================ 5. Full page and back, no reload ============================ */
    await clickAt('.wp-layer .wp-yt-full', 'Full page');
    st = await pvWait('x.mode === "page" && !x.boxed && !x.applied', 5000);
    const fullBox = await chrome.ev('(() => { const v = document.querySelector(".wp-layer webview").getBoundingClientRect(); const t = document.querySelector(".wp-layer .wp-tile").getBoundingClientRect(); return [v.width - t.width, v.height - t.height].map(Math.round); })()');
    t = await p.ev(TRIM);
    check(!!st && fullBox.every((n) => Math.abs(n) <= 1) && !t.flag && !t.outsideHidden, 'Full page: YouTube’s whole page fills the tile (masthead, recommendations, comments)', { fullBox, flag: t.flag, outside: t.outside });
    check((await chrome.ev('WatchPlayerYT._state().label')) === 'Lumen view' && (await p.ev('window.__born')) === born && t.playing, 'the button now says “Lumen view”; the page was not reloaded and still plays');
    await shot('fullpage-first', 1280, 800);
    await clickAt('.wp-layer .wp-yt-full', 'Lumen view');
    st = await pvWait('x.mode === "lumen" && x.boxed && x.applied', 6000);
    t = await p.ev(TRIM);
    check(!!st && t.flag && t.onlyPlayer && (await p.ev('window.__born')) === born, 'Lumen view again: only the player, same page, no reload');

    /* ============================ 6. three sizes: the view, after Like, Full page ============================ */
    for (const [w, h] of SIZES) {
      await resize(w, h);
      const ww = await win();
      check(ww.content.width === w && ww.content.height === h && !ww.fullScreen, 'resized to ' + w + 'x' + h, ww.content);
      await pvWait('x.boxed && x.applied', 4000);
      await boxOk(w + 'x' + h, FY + '/watch?v=');
      t = await p.ev(TRIM);
      check(t.onlyPlayer && t.fill.every((n) => Math.abs(n) <= 1), w + 'x' + h + ': the player still fills its box', t.fill);
      await shot('youtube', w, h);
      await clickAt('.wp-layer .pv-like', 'Like');
      await pvWait('x.like && x.like.pressed === "true" && !x.busy', 5000);
      await shot('youtube-liked', w, h);
      await clickAt('.wp-layer .pv-like', 'Like');
      await pvWait('x.like && x.like.pressed === "false" && !x.busy', 5000);
      await clickAt('.wp-layer .wp-yt-full', 'Full page');
      await pvWait('x.mode === "page" && !x.boxed', 5000);
      await shot('fullpage', w, h);
      await clickAt('.wp-layer .wp-yt-full', 'Lumen view');
      await pvWait('x.mode === "lumen" && x.boxed && x.applied', 6000);
    }
    pr = await presses();
    check(pr.like === 7, 'six more Like clicks over the three sizes: six more presses, no more', pr);
    p.close();

    /* ============================ 7. Disney+, Hulu, Prime Video, ESPN+ ============================ */
    const others = [
      ['disney', srv.fronts.disney.origin + '/play/andor-s1e3', { id: 'disney:andor', service: 'disney', title: 'Andor', subtitle: 'S1 E3 · Reckoning' }, 'Andor', 'S1 E3', 'Reckoning', 'Disney+'],
      ['hulu', srv.fronts.hulu.origin + '/watch/bear-s2e4', { id: 'hulu:bear', service: 'hulu', title: 'The Bear', subtitle: 'S2 E4 · Honeydew' }, 'The Bear', 'S2 E4', 'Honeydew', 'Hulu'],
      ['prime', srv.fronts.prime.origin + '/detail/0BOYS00001/ref=atv_dp?autoplay=1', { id: 'prime:boys', service: 'prime', title: 'The Boys', subtitle: 'S4 E1 · Department of Dirty Tricks' }, 'The Boys', 'S4 E1', 'Department of Dirty Tricks', 'Prime Video'],
      ['espn', srv.fronts.espn.origin + '/watch/player/_/id/nhl-123', { id: 'espn:nhl-123', service: 'espn', title: 'Bruins at Rangers', subtitle: '' }, 'Bruins at Rangers', '', '', 'ESPN'],
    ];
    for (const [svc, url, item, title, ep, epName, name] of others) {
      await chrome.ev(`openInLumen(${JSON.stringify(url)}, { service: ${JSON.stringify(svc)}, title: ${JSON.stringify(title)}, item: ${JSON.stringify(item)} }), 1`);
      st = await pvWait(`x.service === ${JSON.stringify(svc)} && x.applied && x.phase === "ready"`, 15000);
      check(!!st && st.boxed, name + ': its own player page, trimmed and boxed', st && { phase: st.phase, why: st.why, applied: st.applied, kind: st.kind });
      const gp = await guestFor(new URL(url).origin + '/' + new URL(url).pathname.split('/')[1] + '/');
      t = gp ? await gp.ev(TRIM) : {};
      check(t.root && t.onlyPlayer && t.outsideHidden && t.fill.every((n) => Math.abs(n) <= 1) && t.playing, name + ': only its player shows (its header, footer and rows gone), filling the box, playing', t);
      st = await pv();
      check(st.title === title && st.ep === ep + epName && st.svc === name, name + ': the info says the title, SxEy and the episode, the service', { title: st.title, ep: st.ep, svc: st.svc });
      check(!!st.showPage, name + ': a “Show page” button, ' + (st.showPage && st.showPage.disabled ? 'off: ' + st.showPage.why : 'on'), st.showPage);
      if (svc === 'disney' || svc === 'hulu') {
        for (const [w, h] of SIZES) {
          await resize(w, h);
          await boxOk(name + ' ' + w + 'x' + h, null);
          await shot(svc, w, h);
        }
      }
      if (gp) gp.close();
    }

    /* ============================ 8. the states ============================ */
    await resize(1280, 800);
    const playYT = (q2, title) => chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=' + VID + q2)}, { service: 'youtube', title: ${JSON.stringify(title)} }), 1`);
    // r62-playview regression: YouTube moving IN THE PAGE to another video (history.pushState to another ?v=,
    // what its autoplay and end-screen cards do) kept the last video's title: the info fell back to the row's
    // title (YouTube was treated as never "moved") and the bar kept the slot's title for good. Now, the moment
    // the slot's address has another v=, the info drops the row title (the skeleton '' or the new read) and the
    // bar falls back to the page's own document.title. The page changes its title and h1 the way the SPA does.
    const ROW_T = 'Row title before the move';
    const NEXT_ID = 'pvTest00002', NEXT_T = 'The next video after autoplay';
    await playYT('&mv=1', ROW_T);
    await pvWait('x.applied && x.phase === "ready" && /mv=1/.test(x.url)', 15000);
    p = await guestFor(FY + '/watch?v=' + VID + '&mv=1');
    await p.ev(`(() => { history.pushState({}, '', '/watch?v=${NEXT_ID}'); const h = document.querySelector('ytd-watch-metadata #title h1 yt-formatted-string'); if (h) h.textContent = ${JSON.stringify(NEXT_T)}; document.title = ${JSON.stringify(NEXT_T + ' - YouTube')}; return 1; })()`);
    const seen = [];
    for (let i = 0; i < 8; i++) { const x = await pv(); seen.push(x ? x.title : null); await sleep(120); }
    check(seen.every((x) => x !== ROW_T), 'a move in the page to another video: the info never shows the last row’s title (the skeleton or the new read)', seen);
    const barT = await chrome.waitFor(`(() => { const t = ${ST}.title; return t && t.indexOf(${JSON.stringify(NEXT_T)}) >= 0 ? t : null; })()`, 3000).catch(() => null);
    const movedUrl = (await chrome.ev(ST)).slots[0].url;
    // ... and the view read the new video afresh (newPage): nothing busy, the player looked for again, ready.
    const fresh = await pvWait('x.phase === "ready" && x.title === ' + JSON.stringify(NEXT_T), 8000);
    check(!!fresh && fresh.busy === '' && fresh.noRoot === false && fresh.applied, 'and the view reads the new video afresh: its title, nothing busy, the player trimmed', fresh && { phase: fresh.phase, title: fresh.title, busy: fresh.busy, noRoot: fresh.noRoot, why: fresh.why });
    check(!!barT && movedUrl.indexOf('v=' + NEXT_ID) >= 0, 'and the bar drops the slot’s title for the page’s own new title (the slot’s address has the new id)', { bar: barT || (await chrome.ev(`${ST}.title`)), url: movedUrl });
    p.close();
    // Signed out: the buttons are off and say so; nothing is pressed.
    await playYT('&signedout=1', 'Signed out');
    st = await pvWait('x.service === "youtube" && x.applied && x.phase === "ready" && /signedout/.test(x.url)', 15000);
    check(!!st && st.like.disabled && /Sign in to YouTube/.test(st.like.why) && st.sub.disabled && st.savebtn.disabled && /signed out of YouTube/.test(st.note), 'signed out: Like, Subscribe and Save are off, with “Sign in” in words', st && { like: st.like, note: st.note });
    p = await guestFor(FY + '/watch?v=' + VID + '&signedout');
    await clickAt('.wp-layer .pv-like', 'Like (off)');
    await sleep(400);
    check((await presses()).like === 0 && (await presses()).sub === 0, 'signed out: a click on the off Like presses nothing');
    await shot('state-signedout', 1280, 800);
    p.close();
    // "Video paused. Continue watching?": YouTube's own dialog stays seen over the player.
    await playYT('&still=1', 'Still watching');
    st = await pvWait('x.applied && /still/.test(x.url)', 15000);
    p = await guestFor(FY + '/watch?v=' + VID + '&still');
    await p.waitFor('!!document.getElementById("still")', 5000).catch(() => 0);
    const still = await p.ev('(() => { const d = document.getElementById("still"); if (!d) return null; const b = d.getBoundingClientRect(); const n = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return { vis: getComputedStyle(d).visibility, top: !!n && d.contains(n) }; })()');
    check(!!still && still.vis === 'visible' && still.top, '“Continue watching?” shows over the player (YouTube’s own, never hidden)', still);
    p.close();
    // The info can't be read: a player and nothing else.
    await playYT('&bare=1', 'Bare page');
    st = await pvWait('x.applied && /bare/.test(x.url) && (x.phase === "unread" || x.phase === "partial")', 15000);
    check(!!st && st.like.disabled && /isn’t on this page/.test(st.like.why) && /couldn’t read|aren’t on this page|isn’t on this page/.test(st.note) && st.title === 'Bare page',
      'the info can’t be read: Lumen’s own title, the buttons off with the reason', st && { phase: st.phase, note: st.note, title: st.title, like: st.like });
    await shot('state-unread', 1280, 800);
    // No player on the page: the whole page shows, and the bar says why.
    await playYT('&noplayer=1', 'No player');
    st = await pvWait('x.noRoot && !x.boxed && /noplayer/.test(x.url)', 15000);
    const noteNow = await chrome.ev(`${ST}.note`);
    check(!!st && /couldn’t find YouTube’s player/.test(noteNow) && !(await chrome.ev('WatchPlayerYT._state().fullShown')), 'no player found: the whole page shows, the bar says why, no toggle', { note: noteNow });
    // r62-playview regression: once the player was not found, a later update() trimmed the page anyway (wantTrim
    // ignored noRoot), leaving a bare player with no info and no toggle. The player root turns up late here
    // (the page wraps its video in #movie_player), then the layer's class changes (the MutationObserver's
    // update): the page stays whole, as the bar said.
    p = await guestFor(FY + '/watch?v=' + VID + '&noplayer');
    if (p) await p.ev('(() => { const v = document.getElementById("v"); const mp = document.createElement("div"); mp.id = "movie_player"; mp.className = "html5-video-player"; v.parentNode.insertBefore(mp, v); mp.appendChild(v); return 1; })()').catch(() => 0);
    await chrome.ev('(() => { const l = document.querySelector(".wp-layer"); l.classList.add("e2e-poke"); setTimeout(() => l.classList.remove("e2e-poke"), 200); return 1; })()');
    await sleep(1500);
    const late = await pv();
    const lateFlag = p ? await p.ev('document.documentElement.hasAttribute("data-lumen-pv")').catch(() => null) : null;
    check(!!p && lateFlag === false && !!late && late.applied === false && late.boxed === false && late.noRoot === true,
      'no player found, then one turns up and the layer updates: the page is never trimmed after the bar said the whole page shows', { flag: lateFlag, applied: late && late.applied, boxed: late && late.boxed, noRoot: late && late.noRoot });
    if (p) p.close();
    // The page failed: the reason, in the layer's state and in the info.
    const dead = await deadPort();
    await chrome.ev(`openInLumen(${JSON.stringify('http://127.0.0.1:' + dead + '/watch?v=' + VID)}, { service: 'youtube', title: 'Dead page' }), 1`);
    const failed = await chrome.waitFor(`(() => { const s = ${ST}.slots[0]; return s && s.state === 'failed' ? s : null; })()`, 15000).catch(() => null);
    check(!!failed && /didn’t load: .*(REFUSED|refused|ERR_)/i.test(failed.stateText), 'the page failed: the layer says it didn’t load, with the reason', failed && failed.stateText);
    await shot('state-failed', 1280, 800);
    // Offline: the info says so, and reads again when the connection is back.
    await playYT('', 'Offline test');
    await pvWait('x.applied && x.phase === "ready" && x.url.indexOf("noplayer") < 0', 15000);
    await chrome.send('Network.enable');
    await chrome.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(500);
    const off = await chrome.ev(`(() => { const s = ${PS}.slots.find((x) => x.boxed); return { online: navigator.onLine, note: s && s.note, like: s && s.like }; })()`);
    check(off.online === false && /offline/i.test(off.note) && off.like.disabled, 'offline: the info says so and the buttons wait', off);
    await shot('state-offline', 1280, 800);
    await chrome.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    st = await pvWait('x.boxed && x.phase === "ready" && !/offline/i.test(x.note)', 10000);
    check(!!st && !st.like.disabled, 'back online: the info is whole again');

    /* ============================ 9. mini-player and multiview ============================ */
    const mini = await chrome.ev('(() => { const b = document.querySelector(".wp-layer .mv-minibtn"); if (!b) return false; b.click(); return true; })()');
    if (mini) {
      await sleep(900);
      const mb = await chrome.ev('(() => { const l = document.querySelector(".wp-layer"); const v = l.querySelector("webview").getBoundingClientRect(); const t = l.querySelector(".wp-tile").getBoundingClientRect(); const i = l.querySelector(".pv-info"); return { mini: l.classList.contains("mv-mini"), fill: [v.width - t.width, v.height - t.height].map(Math.round), info: i ? getComputedStyle(i).display : "none", lw: Math.round(l.getBoundingClientRect().width) }; })()');
      p = await guestFor(FY + '/watch?v=' + VID);
      t = p ? await p.ev(TRIM) : {};
      check(mb.mini && mb.fill.every((n) => Math.abs(n) <= 1) && mb.info === 'none' && t.onlyPlayer, 'the mini-player: just the player, filling the corner box, no info', { mb, onlyPlayer: t.onlyPlayer });
      await shot('mini', 1280, 800);
      if (p) p.close();
      await chrome.ev('(() => { const b = document.querySelector(".wp-layer .mv-mini-restore"); if (b) b.click(); return 1; })()');
      st = await pvWait('x.boxed && x.applied', 5000);
      check(!!st && !(await chrome.ev('document.querySelector(".wp-layer").classList.contains("mv-mini")')), 'restored from the corner: the Lumen view again');
    } else check(false, 'the mini-player button exists');
    await chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=pvTest00002')}, { service: 'youtube', title: 'Second', multi: true }), 1`);
    const grid2 = await chrome.waitFor(`(() => { const s = ${ST}; return s.n === 2 && s.slots[0].url.indexOf('/embed/') > 0 ? s : null; })()`, 15000).catch(() => null);
    st = await chrome.ev(PS);
    check(!!grid2 && st.slots.every((x) => !x.boxed) && !st.layerOn, 'multiview: two tiles, the first back to its embed, no tile boxed', grid2 && grid2.slots.map((x) => x.url));
    await shot('multiview', 1280, 800);
    await chrome.ev('WatchPlayer.close("Close"), 1');
    await chrome.waitFor(`!${ST}.open`, 5000).catch(() => 0);
    await sleep(800);

    /* ============================ 10. Show page ============================ */
    const huluTile = await g.ev(`(() => { const n = [...document.querySelectorAll('*')].find((x) => x._item && x._item.service === 'hulu' && x._item.kind !== 'resume' && window.LumenShows && LumenShows.stageButton(x._item));
      return n ? { id: n._item.id, title: n._item.title } : null; })()`);
    if (huluTile) {
      await chrome.ev(`openInLumen(${JSON.stringify(srv.fronts.hulu.origin + '/watch/show-page-test')}, { service: 'hulu', title: ${JSON.stringify(huluTile.title)}, item: ${JSON.stringify({ id: huluTile.id, service: 'hulu', title: huluTile.title, subtitle: 'S1 E2 · Second' })} }), 1`);
      st = await pvWait('x.service === "hulu" && x.showPage && !x.showPage.disabled', 15000);
      check(!!st, 'a Hulu title from Lumen’s rows: “Show page” is on', st && st.showPage);
      // While the button is held down, the layer's class changes (as the page's reads and the bar do): the
      // view updates, and the click must still land (a redraw between press and release would swallow it).
      await clickAt('.wp-layer .pv-showpage', 'Show page', async () => {
        await chrome.ev('(() => { const l = document.querySelector(".wp-layer"); l.classList.add("pv-e2e-poke"); return 1; })()');
        await sleep(60);
        await chrome.ev('(() => { document.querySelector(".wp-layer").classList.remove("pv-e2e-poke"); return 1; })()');
        await sleep(60);
      });
      const shown = await g.waitFor('window.LumenShows && LumenShows.isOpen() ? 1 : 0', 6000).catch(() => 0);
      // The show page opens in the Lumen tab first; the chrome hears back from it, then sends the player to the corner.
      const AFTER = `(() => { const s = ${ST}; return { open: s.open, mini: !!(s.multi && s.multi.mini) }; })()`;
      const after = (await chrome.waitFor(`(() => { const a = ${AFTER}; return a.mini || !a.open ? a : null; })()`, 4000).catch(() => null)) || await chrome.ev(AFTER);
      check(shown === 1 && (after.mini || !after.open), 'Show page: Lumen’s show page opens; the player waits in the corner',
        Object.assign({ shown }, after, after.mini || !after.open ? {} : await chrome.ev(`(() => { const s = ${PS}.slots.find((y) => y.service === 'hulu'); const L = WatchPlayer._state(); const b = document.querySelector('.wp-layer .mv-minibtn'); return { why: s && s.why, showPage: s && s.showPage, fs: L.fs, sheet: L.sheet, minibtn: b ? { hidden: b.hidden, disabled: b.disabled } : null }; })()`).catch((e) => ({ err: e.message }))));
      await shot('showpage', 1280, 800);
      await chrome.ev('(() => { if (WatchPlayer.isOpen()) WatchPlayer.close("Close"); return 1; })()');
      await g.ev('(() => { if (window.LumenShows) LumenShows.close(); return 1; })()');
      await sleep(600);
    } else say('no Hulu tile with a show page in the mock rows: Show page checked off-with-reason above only');

    /* ============================ 11. Settings > Lumen: the service's full page ============================ */
    await chrome.ev('Settings.open("Lumen"), 1');
    const seg = await chrome.waitFor('(() => { const s = document.querySelector("[data-field=watchplayer] [data-pv-view]"); return s ? [...s.querySelectorAll(".set-seg-opt")].map((b) => b.textContent) : null; })()', 8000).catch(() => null);
    check(!!seg && seg[0] === 'Lumen view' && /full page/.test(seg[1]), 'Settings > Lumen: “When a video plays”: Lumen view / The service’s full page', seg);
    await chrome.ev('(() => { const s = document.querySelector("[data-field=watchplayer] [data-pv-view]"); [...s.querySelectorAll(".set-seg-opt")][1].click(); return 1; })()');
    const saved = await chrome.waitFor('window.api.lumenPlayview.get().then((r) => r.view === "page" ? r : null)', 5000).catch(() => null);
    check(!!saved && (await chrome.ev('LumenPlayview.view()')) === 'page', 'picked “The service’s full page”: saved', saved);
    await chrome.ev('(() => { if (window.Settings && Settings.close) Settings.close(); return 1; })()');
    await sleep(500);
    await clickYT();
    await chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.n === 1 && s.slots[0].wcId !== null ? 1 : 0; })()`, 15000).catch(() => 0);
    await sleep(2500);
    st = await pv();
    p = await guestFor(FY + '/watch?v=');
    t = p ? await p.ev(TRIM) : {};
    const asToday = await chrome.ev('(() => { const v = document.querySelector(".wp-layer webview").getBoundingClientRect(); const t = document.querySelector(".wp-layer .wp-tile").getBoundingClientRect(); return { fill: [v.width - t.width, v.height - t.height].map(Math.round), full: WatchPlayerYT._state().fullShown, on: document.querySelector(".wp-layer").classList.contains("pv-on") }; })()');
    check(st && !st.boxed && st.mode === 'page' && !t.flag && !t.outsideHidden && asToday.fill.every((n) => Math.abs(n) <= 1) && !asToday.full && !asToday.on,
      'with the setting at the full page: YouTube’s whole page fills the layer, no Lumen info, no toggle (as before)', { asToday, flag: t.flag });
    await shot('setting-fullpage', 1280, 800);
    if (p) p.close();
    await chrome.ev('LumenPlayview.setView("lumen").then(() => 1)');
    st = await pvWait('x.boxed && x.applied', 8000);
    check(!!st, 'back to Lumen view: the playing video moves into the view');

    /* ============================ 12. never OS fullscreen ============================ */
    const wEnd = await win();
    check(wEnd.fullScreen === false && wEnd.entered === 0, 'the OS window never went fullscreen in the whole run', wEnd);
    say('page hits: ' + JSON.stringify(hits) + '; fullscreen asks counted by the stub: ' + (await chrome.ev('window.__fsCalls')));
    g.close();
    await chrome.ev('(() => { if (WatchPlayer.isOpen()) WatchPlayer.close("Close"); return 1; })()');
    await q.quit();
  } finally {
    srv.close();
    try { if (mock.close) await mock.close(); } catch (e) { /* gone */ }
  }
});
