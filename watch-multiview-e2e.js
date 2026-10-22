require('./tools/lowcpu-optional.js');   // first: the CPU cap, when one is configured (tools/lowcpu-optional.js; none on a cloud runner)
// watch-multiview-e2e.js -- Lumen multiview and the mini-player (watch-player-multi.js), end to end, in a
// REAL hidden Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen). Rows come from the local
// service mock; every service origin is rebased to a local "front" serving fixture pages: an HTML5 video
// looping a local clip, a YouTube-embed stand-in (with a fake movie_player that records the quality asked
// for), an embed that refuses, and a page that says "too many people are using your account". Never a real
// service, account, cookie or profile.
//
//   node watch-multiview-e2e.js [--cdp 9473] [--shots <dir>] [--size 1536x800] [--shots-only]
//
// Checks: the tile menu (Play / Add to multiview); Add to multiview with nothing playing -> the player in a
// corner waiting for a pick; a pick adds tile 2 (the first YouTube tile becomes the embed); layouts 2, 3, 4;
// the sound on one tile (1-4 from the layer and from inside a tile, a click on a header), M mutes all; the
// quality hint on YouTube tiles without the sound; the stream-limit sentence in its tile (no retry); the RAM
// guard (simulated low memory) and the four-tile cap; expand, swap (no reload), remove (X); Esc leaves
// multiview; the mini-player: corner, drag to each corner, click restores, X closes; an embed that refuses
// falls back to the watch page; RAM and CPU at 1, 2, 3 and 4 playing tiles; shots.
// One summary line: "watch-multiview-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9473'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'quartz-multiview-shots'));
const SIZE = opt('size', '1536x800');
const SHOTS_ONLY = argv.includes('--shots-only');
const PREFIX = opt('prefix', 'lumen-n-multiview');
// The playing video: a synthetic clip (testsrc2 + a sine tone), never a real recording.
const { CLIP, sendClip } = require('./tests/fixture-clip');
const FREE_FILE = path.join(os.tmpdir(), 'quartz-multiview-free-' + process.pid + '.txt');
const LIMIT_TEXT = 'Too many people are using your account right now. Stop playing on another device to continue.';

/* ---- the local servers ----------------------------------------------------------------------- */
function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 2000;
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, origin: 'http://127.0.0.1:' + s.address().port }));
  });
}
function sendHtml(res, body) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); }
// A playing HTML5 video (with its sound, when autoplay allows it), and a stamp that changes on every load.
const VIDEO = '<video id="v" src="/__media/clip.mp4" autoplay loop playsinline style="display:block;width:100%;height:100%;object-fit:contain;background:#000"></video>' +
  '<script>window.__born = Date.now() + Math.random(); window.addEventListener("keydown", function (e) { window.__lastKey = e.key; }, true); var v = document.getElementById("v"); v.play().catch(function () { v.muted = true; v.play().catch(function () {}); });</script>';
function page(title, extra) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title><style>html,body{margin:0;height:100%;background:#000;color:#ddd;font:15px/1.4 "Segoe UI",sans-serif;overflow:hidden}' +
    '#lim{position:absolute;left:0;right:0;top:40%;padding:24px;text-align:center;background:rgba(10,10,12,.92)}</style></head><body>' + VIDEO + (extra || '') + '</body></html>';
}
const EMBED_EXTRA = '<div id="movie_player"></div><script>window.__q = ""; document.getElementById("movie_player").setPlaybackQualityRange = function (a) { window.__q = a; };</script>';
const REFUSE_EXTRA = '<div class="ytp-error" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000"><div>Video unavailable</div><div>Playback on other websites has been disabled by the video owner.</div></div>';
const LIMIT_EXTRA = '<script>setTimeout(function () { var d = document.createElement("div"); d.id = "lim"; d.textContent = ' + JSON.stringify(LIMIT_TEXT) + '; document.body.appendChild(d); document.getElementById("v").pause(); }, 1200);</script>';
const PLAYER_PATH = /^\/(?:watch$|watch\/player|video\/|play\/|detail\/|movies\/|series\/|__p\/)/;
// YouTube Subscriptions (watch/ytlib.js reads /feed/subscriptions in a hidden view): the ytlib e2e's own
// fixture, so the rows show the Subscriptions row as the user does, not "couldn't read" (the mock has none).
const SUBS_FIX = path.join(__dirname, 'tests', 'watch-fixtures', 'youtube-subs.json');
function subsPage() {
  let f = null;
  try { f = JSON.parse(fs.readFileSync(SUBS_FIX, 'utf8')); } catch (e) { f = null; }
  const data = f && f.ytInitialData ? 'window.ytInitialData=' + JSON.stringify(f.ytInitialData).split('<').join('\\u003c') + ';' : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>YouTube</title><script>var ytcfg={data_:{LOGGED_IN:true},get:function(k){return this.data_[k];}};' +
    data + '</script></head><body><div id="content">front YouTube (subscriptions)</div></body></html>';
}

async function startServers(mock) {
  const fronts = {};
  for (const svc of Mock.SERVICES) {
    fronts[svc] = await listen((req, res) => {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      const p = u.pathname;
      if (p === '/__media/clip.mp4') return sendClip(req, res);
      if (/^\/embed\/refuse/.test(p)) return sendHtml(res, page('Refused embed', REFUSE_EXTRA));
      if (p.indexOf('/embed/') === 0) return sendHtml(res, page(svc + ' embed ' + p.slice(7), EMBED_EXTRA));
      if (p === '/__p/limit') return sendHtml(res, page(svc + ' limit', LIMIT_EXTRA));
      if (svc === 'youtube' && p === '/feed/subscriptions') return sendHtml(res, subsPage());
      if (PLAYER_PATH.test(p)) return sendHtml(res, page(svc + ' ' + p, p === '/watch' ? EMBED_EXTRA : ''));
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

/* ---- CDP helpers ------------------------------------------------------------------------------ */
async function targetWhere(q, pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    let list = [];
    try { list = await q.targets(); } catch (e) { list = []; }
    const t = list.find((x) => x.webSocketDebuggerUrl && pred(x));
    if (t) return t;
    await sleep(150);
  }
  return null;
}
async function cdpTo(t) { const c = await new Cdp(t.webSocketDebuggerUrl).open(); await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => 0); return c; }
async function keyIn(c, key, code, vk) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 };
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}
async function mouse(c, type, x, y, button, count) {
  await c.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: button || 'left', buttons: type === 'mouseReleased' || type === 'mouseMoved' && !button ? 0 : 1, clickCount: count || (type === 'mouseMoved' ? 0 : 1) });
}
async function drag(c, from, to) {
  await mouse(c, 'mouseMoved', from[0], from[1]);
  await mouse(c, 'mousePressed', from[0], from[1], 'left', 1);
  for (let i = 1; i <= 8; i++) await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from[0] + (to[0] - from[0]) * i / 8), y: Math.round(from[1] + (to[1] - from[1]) * i / 8), button: 'left', buttons: 1 });
  await mouse(c, 'mouseReleased', to[0], to[1], 'left', 1);
}
const ST = 'WatchPlayer._state()';
const MS = '(WatchPlayer._state().multi || {})';
const DIG = { 1: 49, 2: 50, 3: 51, 4: 52 };

run('watch-multiview-e2e', async ({ check, launch, say, profileDir }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  try { fs.unlinkSync(FREE_FILE); } catch (e) { /* none */ }
  check(fs.existsSync(CLIP), 'the local fixture clip exists', CLIP);
  const mock = await Mock.start({ log: () => {} });
  const srv = await startServers(mock);
  const FY = srv.fronts.youtube.origin, FD = srv.fronts.disney.origin, FH = srv.fronts.hulu.origin, FP = srv.fronts.prime.origin, FE = srv.fronts.espn.origin;
  const env = {
    QUARTZ_WATCH_BOOT_GRACE_MS: '0',
    QUARTZ_WATCH_REBASE: JSON.stringify(srv.rebase),
    QUARTZ_WATCH_MIN_FREE_GB: '0',
    QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1',
    QUARTZ_TEST_VMP: 'signed',
    QUARTZ_PLAYER_FREE_FILE: FREE_FILE,
    QUARTZ_TEST_WINDOW_SIZE: SIZE,
  };
  const results = { size: SIZE, perTiles: [] };
  try {
    // --menu-dump: a right-click that reaches main (no tile under it) dumps Quartz's native menu instead
    // of popping it. Menu.popup() opens at the REAL cursor, on the visible desktop, whatever the window.
    const q = await launch({ cdp: CDP_PORT, env, args: ['--menu-dump'] });
    const chrome = q.chrome;
    await chrome.ev('window.__fsCalls = 0; window.toggleFullscreen = function () { window.__fsCalls++; }; 1');
    check(await chrome.ev('!!window.WatchPlayerMulti && typeof window.openInLumen === "function"'), 'watch-player-multi.js is loaded in the chrome');
    await chrome.ev('openWatchTab(), 1');
    const gt = await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 15000);
    const g = await cdpTo(gt);
    const ytCards = `[...document.querySelectorAll('#stack .lrow[data-d="0"] .card')].filter((n) => n._item && n._item.service === 'youtube' && /watch\\?v=/.test(n._item.url))`;
    const anyYt = `[...document.querySelectorAll('.card')].filter((n) => n._item && n._item.service === 'youtube' && /watch\\?v=/.test(n._item.url))`;
    await g.waitFor(`${anyYt}.length >= 2`, 60000).catch(() => 0);
    const shoot = async (name) => {
      await sleep(900);
      const file = path.join(SHOTS, PREFIX + '-' + name + '-' + SIZE + '.png');
      try { await chrome.shot(file); results.shots = (results.shots || []).concat([path.basename(file)]); } catch (e) { say('shot ' + name + ' failed: ' + e.message); }
    };
    const viewRect = () => chrome.ev('(() => { const b = findWatchTab().viewEl.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })()');
    const mstate = () => chrome.ev(MS);
    const waitN = (n, ms) => chrome.waitFor(`(() => { const m = ${MS}; return m.n === ${n} && m.tiles.every((t) => t.wcId !== null) ? m : null; })()`, ms || 15000).catch(() => null);
    const add = (url, service, title) => chrome.ev(`openInLumen(${JSON.stringify(url)}, { service: ${JSON.stringify(service)}, title: ${JSON.stringify(title)}, multi: true }), 1`);
    const muted = async () => { await sleep(400); return chrome.ev('[...document.querySelectorAll(".wp-layer webview")].map((v) => { try { return v.isAudioMuted(); } catch (e) { return null; } })'); };
    const why = async () => { const m = await mstate(); return { focus: (await chrome.ev(ST)).focus, meant: m.tiles.map((t) => t.muted), audio: m.tiles.map((t) => t.audio), actual: await muted(), note: (await chrome.ev(ST)).note }; };
    const order = () => chrome.ev('WatchPlayer._state().slots.map((s) => s.wcId)');

    /* ===== 1. the tile menu; Add to multiview with nothing playing ===== */
    // The rows settle first: YouTube Subscriptions (watch/ytlib-page.js) answers on its own and re-renders
    // them, and a right-click aimed before that lands on whatever moved under the pointer.
    await g.waitFor('(() => { if (!window.WatchYt) return true; const s = WatchYt._state().subs; return !!s && s.state !== "loading" && !s.refreshing; })()', 20000).catch(() => 0);
    await sleep(600);
    // A YouTube tile wholly in view, and a point on it that hit-tests to that tile (the focused row first).
    const aim = (list) => g.ev(`(async () => {
      const owner = (n) => { for (; n && n !== document.body; n = n.parentNode) if (n._item || n._event) return n; return null; };
      for (const c of (${list}).slice(0, 16)) {
        c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise((r) => setTimeout(r, 350));
        const r = c.getBoundingClientRect();
        if (r.width < 40 || r.height < 30 || r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) continue;
        for (const [fx, fy] of [[0.5, 0.33], [0.5, 0.5], [0.25, 0.25]]) {
          const x = r.left + r.width * fx, y = r.top + r.height * fy;
          if (owner(document.elementFromPoint(x, y)) === c) return { key: c.dataset.key || '', x, y };
        }
      }
      return null;
    })()`).catch(() => null);
    const pt = (await aim(ytCards)) || (await aim(anyYt));
    check(!!pt, 'a YouTube tile is in view, under the pointer', pt);
    let menu = null;
    if (pt) {
      await mouse(g, 'mouseMoved', pt.x, pt.y);
      await mouse(g, 'mousePressed', pt.x, pt.y, 'right', 1);
      await mouse(g, 'mouseReleased', pt.x, pt.y, 'right', 1);
      menu = await g.waitFor('(() => { const s = window.LumenTileMenu && LumenTileMenu._state(); return s && s.open ? s : null; })()', 4000).catch(() => null);
    }
    check(!!menu && !!pt && JSON.stringify(menu.items) === '["Play","Add to multiview"]' && menu.last.key === pt.key, 'a right-click on a playable tile opens its menu: Play, Add to multiview', menu);
    // ...and never Quartz's own page menu: with --menu-dump main writes it to the profile instead of showing it.
    const dumped = (() => { try { return JSON.parse(fs.readFileSync(path.join(profileDir, 'menu-dump.json'), 'utf8')); } catch (e) { return null; } })();
    check(!dumped, 'the right-click stayed Lumen’s: Quartz’s page menu never came up', dumped);
    const firstTitle = await g.ev(`(${anyYt}).find((c) => c.dataset.key === ${JSON.stringify(menu && menu.last && menu.last.key)})?._item.title || ''`).catch(() => '');
    const ap = await g.ev('(() => { const b = document.querySelectorAll(".tm-item")[1]; if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()');
    if (ap) { await mouse(g, 'mouseMoved', ap[0], ap[1]); await mouse(g, 'mousePressed', ap[0], ap[1]); await mouse(g, 'mouseReleased', ap[0], ap[1]); }
    let m1 = await chrome.waitFor(`(() => { const m = ${MS}; return m.n === 1 && m.mini && m.tiles[0].wcId !== null ? m : null; })()`, 15000).catch(() => null);
    check(!!m1 && m1.pick === true, 'Add to multiview with nothing playing: it plays in a corner, waiting for the next pick', m1 && { n: m1.n, mini: m1.mini, pick: m1.pick });
    if (!m1) say('why no tile: ' + JSON.stringify({ menuAt: ap, player: await chrome.ev(`(() => { const s = WatchPlayer._state(); return { open: s.open, mode: s.mode, note: s.note, title: s.title, slots: (s.slots || []).map((x) => ({ url: String(x.url).slice(0, 90), wcId: x.wcId, svc: x.service })), multi: s.multi }; })()`).catch((e) => 'ev failed: ' + e.message), tabs: await chrome.ev('typeof tabs !== "undefined" ? tabs.map((t) => String(t.url).slice(0, 80)) : null').catch(() => null) }).slice(0, 1500));
    check(!(await g.ev('LumenTileMenu._state().open')), 'the menu closed after the click');
    const vr = await viewRect();
    let box = m1 && m1.box;
    check(!!box && Math.abs((box[0] + box[2]) - (vr[0] + vr[2] - 16)) <= 2 && Math.abs((box[1] + box[3]) - (vr[1] + vr[3] - 16)) <= 2 && box[2] < vr[2] / 2, 'the mini-player sits in the bottom-right corner of the Lumen tab, small', { box, view: vr });
    check((await chrome.ev(`WatchPlayer._state().title`)) !== '' && (await chrome.ev('document.querySelector(".mv-mini-title").textContent')).indexOf('Pick a title') === 0, 'its header says to pick a title');
    // The shot waits for the corner's video to be painting (a fresh embed is black for its first second).
    const miniT = m1 && await targetWhere(q, (x) => String(x.url) === m1.tiles[0].url, 4000);
    const miniP = miniT && await cdpTo(miniT).catch(() => null);
    if (miniP) { await miniP.waitFor('(() => { const v = document.querySelector("video"); return !!v && !v.paused && v.currentTime > 0.5; })()', 8000).catch(() => 0); miniP.close(); }
    await shoot('mini-pick');
    // Esc in the rows is the rows' own while the player sits in a corner.
    check((await chrome.ev('WatchPlayer.handleShortcut("escape")')) === false && (await chrome.ev(`${MS}.mini`)), 'Esc with the mini-player up is not the player’s (it stays playing)');

    // Drag it to the top-left corner (a real mouse drag in the chrome).
    const cen = (b) => { if (!b) throw new Error('the mini-player never came up, so it cannot be dragged (see the FAILs above)'); return [b[0] + b[2] / 2, b[1] + 15]; };
    await drag(chrome, cen(box), [vr[0] + 120, vr[1] + 90]);
    await sleep(400);
    let m = await mstate();
    check(m.corner === 'tl' && Math.abs(m.box[0] - (vr[0] + 16)) <= 2 && Math.abs(m.box[1] - (vr[1] + 16)) <= 2, 'dragged to the top left: it snaps to that corner', { corner: m.corner, box: m.box });
    await drag(chrome, cen(m.box), [vr[0] + vr[2] - 60, vr[1] + 80]);
    await sleep(400);
    m = await mstate();
    check(m.corner === 'tr', 'dragged to the top right: that corner', m.corner);
    await drag(chrome, cen(m.box), [vr[0] + 80, vr[1] + vr[2] * 0 + vr[3] - 40]);
    await sleep(400);
    m = await mstate();
    check(m.corner === 'bl', 'dragged to the bottom left: that corner', m.corner);

    /* ===== 2. the pick: tile 2 ===== */
    // A click on a card in a row that is not the focused one only focuses that row (watch.js onStackClick),
    // so a card of the focused row is picked, else its row is focused first and the card clicked again.
    const secondTitle = await g.ev(`(async () => {
      const ft = ${JSON.stringify(firstTitle)};
      const inFocus = (x) => !!x.closest('.lrow') && x.closest('.lrow').dataset.d === '0';
      const all = ${anyYt};
      const c = all.find((x) => x._item.title !== ft && inFocus(x)) || all.find((x) => x._item.title !== ft) || all[1];
      const key = c.dataset.key;
      if (!inFocus(c)) { c.click(); await new Promise((r) => setTimeout(r, 900)); }
      const again = (${anyYt}).find((x) => x.dataset.key === key && inFocus(x)) || c;
      again.click();
      return again._item.title;
    })()`);
    let s2 = await waitN(2);
    if (!s2) say('why no tile 2: ' + JSON.stringify({ picked: secondTitle, note: (await chrome.ev(ST)).note, multi: await mstate() }).slice(0, 900));
    check(!!s2 && !s2.mini && s2.layout === '2', 'a title picked from the rows joins as tile 2: two side by side, full size', s2 && { n: s2.n, mini: s2.mini, layout: s2.layout });
    check(!!s2 && s2.tiles[1].embed && s2.tiles[1].url.indexOf(FY + '/embed/') === 0, 'the new YouTube tile plays the embed', s2 && s2.tiles[1].url);
    await chrome.waitFor(`${MS}.tiles[0].url.indexOf('/embed/') > 0`, 10000).catch(() => 0);
    s2 = await mstate();
    check(s2.tiles[0].url.indexOf(FY + '/embed/') === 0, 'the first YouTube tile became the embed, where it was', s2.tiles[0].url);
    check(s2.tiles[0].audio && !s2.tiles[1].audio && JSON.stringify(await muted()) === '[false,true]', 'the sound stays on tile 1; tile 2 comes in muted', { tiles: s2.tiles.map((t) => t.audio), muted: await muted() });
    const r2 = s2.tiles.map((t) => t.rect);
    check(Math.abs(r2[0][1] - r2[1][1]) <= 1 && r2[1][0] > r2[0][0] + r2[0][2] - 2 && Math.abs(r2[0][2] - r2[1][2]) <= 2, '2-up: side by side, the same size', r2);
    check(s2.tiles.every((t) => t.headShown && /\d/.test(t.head)), 'each tile has its header (number, service, title)', s2.tiles.map((t) => t.head));
    void secondTitle;

    /* ===== 3. tiles 3 and 4; layouts ===== */
    await add(FD + '/__p/gameB', 'disney', 'Game B');
    const s3 = await waitN(3);
    const r3 = s3 && s3.tiles.map((t) => t.rect);
    check(!!s3 && s3.layout === '3-spot' && r3[0][3] > r3[1][3] * 1.8 && r3[0][2] > r3[1][2] * 1.5 && Math.abs(r3[1][0] - r3[2][0]) <= 1, '3-up: one big tile and two small', { layout: s3 && s3.layout, rects: r3 });
    await add(FP + '/__p/limit', 'prime', 'Game C');
    const s4 = await waitN(4);
    const r4 = s4 && s4.tiles.map((t) => t.rect);
    check(!!s4 && s4.layout === '4' && Math.abs(r4[0][1] - r4[1][1]) <= 1 && Math.abs(r4[2][1] - r4[3][1]) <= 1 && Math.abs(r4[0][0] - r4[2][0]) <= 1 && Math.abs(r4[0][2] - r4[3][2]) <= 2, '4-up: 2 x 2', { layout: s4 && s4.layout, rects: r4 });

    // The stream-limit page: its own sentence, repeated in its tile's header; never retried.
    const lim = await chrome.waitFor(`(() => { const t = ${MS}.tiles[3]; return t && t.limit ? t : null; })()`, 15000).catch(() => null);
    check(!!lim && lim.limit === LIMIT_TEXT && lim.head.indexOf(LIMIT_TEXT) >= 0, 'too many streams: the service’s own sentence shows in that tile', lim && { limit: lim.limit, head: lim.head });
    const limT = await targetWhere(q, (x) => String(x.url) === FP + '/__p/limit', 5000);
    const lp = limT && await cdpTo(limT);
    const born = lp && await lp.ev('window.__born');
    check(!!lp && (await lp.ev('!!document.getElementById("lim") && getComputedStyle(document.getElementById("lim")).display !== "none"')) && (await chrome.ev(`WatchPlayer._state().slots[3].state`)) === '', 'and the service’s page stays visible in the tile (Lumen draws nothing over it)');
    if (lp) {
      // r62: the tile moves to another page (he freed a device; the service moved on): the old refusal goes from
      // its header; back on the limit page, the fresh watch reports it again
      await lp.ev('location.href = ' + JSON.stringify(FP + '/__p/limit-gone') + ', 1').catch(() => 0);
      const gone = await chrome.waitFor(`(() => { const t = ${MS}.tiles[3]; return t && t.url.indexOf('limit-gone') >= 0 && !t.limit ? t : null; })()`, 10000).catch(() => null);
      check(!!gone && gone.head.indexOf(LIMIT_TEXT) < 0, 'a new page in the tile: the old stream-limit sentence leaves its header', gone && { limit: gone.limit, head: gone.head });
      const limT2 = await targetWhere(q, (x) => String(x.url).indexOf(FP + '/__p/limit-gone') === 0, 5000);
      const lp2 = limT2 && await cdpTo(limT2);
      if (lp2) { await lp2.ev('location.href = ' + JSON.stringify(FP + '/__p/limit') + ', 1').catch(() => 0); try { lp2.close(); } catch (e) { /* gone */ } }
      const back = await chrome.waitFor(`(() => { const t = ${MS}.tiles[3]; return t && t.limit ? t : null; })()`, 15000).catch(() => null);
      check(!!back && back.limit === LIMIT_TEXT, 'and back on the limit page, the sentence is reported again', back && { limit: back.limit });
    }

    // Shots: 2-up, 3-up, 4-up were built in that order; 4-up now (2 and 3 again after removes below).
    await shoot('4up');

    /* ===== 4. the sound ===== */
    await chrome.ev('document.querySelector(".wp-layer .mv-sound").focus(), 1');
    await chrome.key('2', { code: 'Digit2', vk: DIG[2] });
    let sa = await chrome.waitFor(`${MS}.tiles[1].audio ? ${MS} : null`, 3000).catch(() => null);
    check(!!sa && sa.tiles.filter((t) => t.audio).length === 1 && JSON.stringify(await muted()) === '[true,false,true,true]', '2 (pressed in the layer): the sound moves to tile 2 only', { audio: sa && sa.tiles.map((t) => t.audio), muted: await muted() });
    const t3T = await targetWhere(q, (x) => String(x.url) === FD + '/__p/gameB', 5000);
    const p3 = t3T && await cdpTo(t3T);
    if (p3) await keyIn(p3, '3', 'Digit3', DIG[3]);
    sa = await chrome.waitFor(`${MS}.tiles[2].audio ? ${MS} : null`, 3000).catch(() => null);
    check(!!sa && JSON.stringify(await muted()) === '[true,true,false,true]', '3 (pressed inside a tile’s page): main hands it over, the sound moves to tile 3', await why());
    check(!!p3 && (await p3.ev('window.__lastKey || ""')) !== '3', 'and the page never saw that 3');
    await chrome.ev('document.querySelector(\'.wp-layer .wp-tile[data-pos="0"] .mv-head\').click(), 1');
    sa = await chrome.waitFor(`${MS}.tiles[0].audio ? ${MS} : null`, 3000).catch(() => null);
    check(!!sa, 'a click on tile 1’s header moves the sound there');
    const r3c = await chrome.ev('(() => { const b = document.querySelector(\'.wp-layer .wp-tile[data-pos="2"] webview\').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 3]; })()');
    await mouse(chrome, 'mouseMoved', r3c[0], r3c[1]);
    await mouse(chrome, 'mousePressed', r3c[0], r3c[1]);
    await mouse(chrome, 'mouseReleased', r3c[0], r3c[1]);
    sa = await chrome.waitFor(`${MS}.tiles[2].audio ? ${MS} : null`, 3000).catch(() => null);
    check(!!sa && JSON.stringify(await muted()) === '[true,true,false,true]', 'a click into tile 3’s page moves the sound there', await why());
    await chrome.ev('document.querySelector(".wp-layer .mv-sound").focus(), 1');
    await chrome.key('m', { code: 'KeyM', vk: 77 });
    sa = await chrome.waitFor(`${MS}.muteAll ? ${MS} : null`, 3000).catch(() => null);
    check(!!sa && JSON.stringify(await muted()) === '[true,true,true,true]' && sa.tiles.every((t) => !t.audio), 'M mutes every tile', await muted());
    await chrome.ev('document.querySelector(".wp-layer .mv-sound").focus(), 1');
    await chrome.key('m', { code: 'KeyM', vk: 77 });
    await sleep(300);
    check(JSON.stringify(await muted()) === '[true,true,false,true]', 'M again: the sound is back on its tile', await why());
    const audible = await chrome.ev('[...document.querySelectorAll(".wp-layer webview")].map((v) => { try { return v.isCurrentlyAudible(); } catch (e) { return null; } })');
    say('audible right now (informative only: Chromium reports a muted tab as audible too): ' + JSON.stringify(audible));

    // The quality hint: a YouTube tile without the sound was asked for 360p by its own player API.
    const ytT = await targetWhere(q, (x) => String(x.url).indexOf(FY + '/embed/') === 0, 5000);
    const yp = ytT && await cdpTo(ytT);
    const qWas = yp && await yp.waitFor('window.__q === "medium" ? window.__q : null', 12000).catch(() => null);
    check(qWas === 'medium', 'a YouTube tile without the sound asks its player for 360p (setPlaybackQualityRange)', qWas);
    await chrome.ev('document.querySelector(".wp-layer .mv-sound").focus(), 1');
    const ytIdx = (await mstate()).tiles.findIndex((t) => ytT && t.url === ytT.url);
    if (ytIdx >= 0) await chrome.key(String(ytIdx + 1), { code: 'Digit' + (ytIdx + 1), vk: DIG[ytIdx + 1] });
    const qNow = yp && await yp.waitFor('window.__q === "auto" ? window.__q : null', 5000).catch(() => null);
    check(qNow === 'auto', 'given the sound, it gets its own quality back', qNow);

    /* ===== 5. the cap and the RAM guard ===== */
    await add(FE + '/__p/fifth', 'espn', 'A fifth');
    let rf = await chrome.waitFor(`${MS}.refusal && /four streams/.test(${MS}.refusal.text) ? ${MS} : null`, 4000).catch(() => null);
    check(!!rf && rf.n === 4, 'a fifth tile is refused: "Multiview holds four streams…"', rf && rf.refusal);
    const before = await order();
    await chrome.ev('document.querySelector(".wp-layer .mv-sound").focus(), 1');
    await chrome.key('4', { code: 'Digit4', vk: DIG[4] });
    await sleep(200);
    await chrome.ev('document.querySelector(".wp-layer .mv-sound").focus(), 1');
    await chrome.key('x', { code: 'KeyX', vk: 88 });
    let sx = await waitN(3, 5000);
    const after = await order();
    check(!!sx && after.length === 3 && after.join() === before.slice(0, 3).join(), 'X removes the selected tile (4); the others keep playing, unreloaded', { before, after });
    check(!!sx && sx.layout === '3-spot', 'back to the 3-up layout', sx && sx.layout);
    await shoot('3up');
    fs.writeFileSync(FREE_FILE, '0.94');
    await add(FH + '/__p/gameD', 'hulu', 'Game D');
    rf = await chrome.waitFor(`${MS}.refusal && /memory/.test(${MS}.refusal.text) ? ${MS} : null`, 4000).catch(() => null);
    check(!!rf && rf.refusal.text === 'Not enough memory for another stream: 0.9 GB free' && rf.n === 3, 'low memory (simulated 0.94 GB): the tile is refused, in words', rf && rf.refusal);
    check((await chrome.ev('WatchPlayer._state().note')).indexOf('Not enough memory') === 0, 'the bar says it too');
    fs.unlinkSync(FREE_FILE);
    await add(FH + '/__p/gameD', 'hulu', 'Game D');
    check(!!(await waitN(4)), 'with the memory back, the same tile is added');

    /* ===== 6. expand, swap ===== */
    let o0 = await order();
    const borns = async () => {
      const out = [];
      for (const t of (await mstate()).tiles) {
        const tt = await targetWhere(q, (x) => String(x.url) === t.url, 3000);
        const c = tt && await cdpTo(tt);
        out.push(c ? await c.ev('window.__born').catch(() => null) : null);
        if (c) c.close();
      }
      return out;
    };
    const b0 = await borns();
    await chrome.ev('document.querySelector(\'.wp-layer .wp-tile[data-pos="2"] .mv-expand\').click(), 1');
    let se = await chrome.waitFor(`${MS}.layout === '4-spot' ? ${MS} : null`, 3000).catch(() => null);
    const o1 = await order();
    check(!!se && o1[0] === o0[2] && o1[2] === o0[0] && se.tiles[0].rect[3] > se.tiles[1].rect[3] * 2.5, 'Expand on tile 3: it takes the big slot (one big, three small)', { order: o1, layout: se && se.layout });
    await shoot('4up-expanded');
    await chrome.ev('document.querySelector(".wp-layer .mv-sound").focus(), 1');
    await chrome.key('1', { code: 'Digit1', vk: DIG[1] });
    await chrome.ev('document.querySelector(".wp-layer .mv-sound").focus(), 1');
    await chrome.key('f', { code: 'KeyF', vk: 70 });
    se = await chrome.waitFor(`${MS}.layout === '4' ? ${MS} : null`, 3000).catch(() => null);
    check(!!se, 'F on the big tile: back to the even 2 x 2', se && se.layout);
    o0 = await order();
    await chrome.ev('document.querySelector(\'.wp-layer .wp-tile[data-pos="0"] .mv-swap\').click(), 1');
    check(await chrome.ev(`${MS}.swapping`), 'Swap on tile 1: the other tiles offer "Swap here"');
    await chrome.ev('document.querySelector(\'.wp-layer .wp-tile[data-pos="3"] .mv-swap-here\').click(), 1');
    await sleep(300);
    const o2 = await order();
    check(o2[0] === o0[3] && o2[3] === o0[0] && o2[1] === o0[1], 'tile 1 and tile 4 traded places', { before: o0, after: o2 });
    const b1 = await borns();
    check(JSON.stringify([...b0].sort()) === JSON.stringify([...b1].sort()) && b1.every((x) => x !== null), 'expand and swap never reloaded a page (each page’s load stamp is the same)', { b0, b1 });

    /* ===== 7. the mini-player with the grid; restore ===== */
    await chrome.ev('document.querySelector(".mv-minibtn").click(), 1');
    let mm = await chrome.waitFor(`${MS}.mini ? ${MS} : null`, 3000).catch(() => null);
    check(!!mm && mm.n === 4 && !mm.pick, 'the bar’s mini-player button: all four keep playing in a corner', mm && { n: mm.n, mini: mm.mini });
    await shoot('mini-grid');
    const hb = mm.box;
    await mouse(chrome, 'mouseMoved', hb[0] + hb[2] / 2, hb[1] + hb[3] / 2 + 10);
    await mouse(chrome, 'mousePressed', hb[0] + hb[2] / 2, hb[1] + hb[3] / 2 + 10);
    await mouse(chrome, 'mouseReleased', hb[0] + hb[2] / 2, hb[1] + hb[3] / 2 + 10);
    mm = await chrome.waitFor(`!${MS}.mini ? ${MS} : null`, 3000).catch(() => null);
    check(!!mm && mm.n === 4 && mm.box[2] > vr[2] - 4, 'a click on the mini-player restores it, full size', mm && mm.box);

    /* ===== 7b. Back (Alt+Left) in multiview: one tile's history, never the others ===== */
    const bk = await targetWhere(q, (x) => String(x.url) === FD + '/__p/gameB', 3000);
    const bkp = bk && await cdpTo(bk);
    if (bkp) {
      const k = { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37, modifiers: 1 };
      await bkp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, k));
      await bkp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, k));
      bkp.close();
    }
    await sleep(700);
    const sb = await chrome.ev(ST);
    check(sb.open && sb.n === 4, 'Alt+Left in multiview never closes the tiles (Back is the selected tile’s own history)', { open: sb.open, n: sb.n, note: sb.note });

    /* ===== 7c. r62: a tile in its own fullscreen: X waits, F leaves it (X used to remove the tile and wedge the layer) ===== */
    {
      const fsT = await targetWhere(q, (x) => String(x.url) === FD + '/__p/gameB', 3000);
      const fp = fsT && await cdpTo(fsT);
      if (fp) {
        const n0 = (await chrome.ev(MS)).n;
        await fp.send('Runtime.evaluate', { expression: 'document.documentElement.requestFullscreen().then(() => 1, (e) => String(e))', awaitPromise: true, userGesture: true }).catch(() => 0);
        const inFs = await chrome.waitFor(`${ST}.fs ? ${ST} : null`, 4000).catch(() => null);
        check(!!inFs, 'a tile page asks for fullscreen: the layer goes full-window (the setup for the next two)', inFs && inFs.fs);
        if (inFs) {
          await keyIn(fp, 'x', 'KeyX', 88); await sleep(600);
          const afterX = await chrome.ev(MS);
          check(afterX.n === n0 && (await chrome.ev(ST)).fs === true, 'X in a fullscreen tile removes nothing (the tile and the fullscreen stay)', { before: n0, after: afterX.n });
          await keyIn(fp, 'f', 'KeyF', 70);
          const outFs = await chrome.waitFor(`!${ST}.fs ? ${ST} : null`, 4000).catch(() => null);
          check(!!outFs && (await fp.ev('!document.fullscreenElement')) && (await chrome.ev(MS)).n === n0, 'F in a fullscreen tile leaves the fullscreen (the page’s own key), not Expand', outFs && { fs: outFs.fs });
          if (!outFs) await fp.ev('document.fullscreenElement ? document.exitFullscreen().then(() => 1) : 0').catch(() => 0);
        }
        fp.close();
      }
    }

    /* ===== 8. Esc leaves multiview ===== */
    const keepWc = (await chrome.ev(ST)).slots[(await chrome.ev(ST)).focus].wcId;
    const anyT = await targetWhere(q, (x) => String(x.url) === FD + '/__p/gameB', 3000);
    const ap2 = anyT && await cdpTo(anyT);
    if (ap2) await keyIn(ap2, 'Escape', 'Escape', 27);
    let sesc = await chrome.waitFor(`(() => { const s = ${ST}; return s.n === 1 ? s : null; })()`, 5000).catch(() => null);
    check(!!sesc && sesc.open && sesc.slots[0].wcId !== null, 'Esc leaves multiview: one tile stays as the single player', sesc && { n: sesc.n, open: sesc.open });
    check(!!sesc && sesc.slots[0].wcId === keepWc, 'the tile that kept the sound is the one that stays', { kept: sesc && sesc.slots[0].wcId, had: keepWc });
    check((await mstate()).layout === '1' && !(await chrome.ev('document.querySelector(".wp-layer").classList.contains("mv-multi")')), 'the single player has the whole layer again', await mstate().then((x) => x.layout));

    /* ===== 9. the single mini-player: shots, drag, X ===== */
    const PBON = '(window.LumenPlayerBar && LumenPlayerBar._state().slots[0] ? LumenPlayerBar._state().slots[0].on : null)';
    await sleep(1500);
    const pbBefore = await chrome.ev(PBON);
    await chrome.ev('document.querySelector(".mv-minibtn").click(), 1');
    mm = await chrome.waitFor(`${MS}.mini ? ${MS} : null`, 3000).catch(() => null);
    check(!!mm && mm.n === 1, 'the single player shrinks into a corner too');
    await sleep(300);
    // r62: the play bar syncs on the way in and out (it stayed on inside the corner box until the next navigation)
    check((await chrome.ev(PBON)) !== true, 'in the corner the play bar is off (synced on the way in)', { before: pbBefore, now: await chrome.ev(PBON) });
    await shoot('mini');
    {
      // r62: a restore while a drag is under way: the drag's full-window shield and listeners go with it
      // (they stayed for good, and nothing in the window took a click)
      const b9 = mm.box;
      await mouse(chrome, 'mouseMoved', b9[0] + b9[2] / 2, b9[1] + 15);
      await mouse(chrome, 'mousePressed', b9[0] + b9[2] / 2, b9[1] + 15, 'left', 1);
      for (let i = 1; i <= 3; i++) await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(b9[0] + b9[2] / 2 - 20 * i), y: Math.round(b9[1] + 15 - 10 * i), button: 'left', buttons: 1 });
      const mid = await chrome.ev('!!document.querySelector(".mv-drag-shield")');
      await chrome.ev('document.querySelector(".mv-mini-restore").click(), 1');
      await sleep(200);
      const left = await chrome.ev('document.querySelectorAll(".mv-drag-shield").length');
      await mouse(chrome, 'mouseReleased', b9[0] + b9[2] / 2 - 60, b9[1] - 15, 'left', 1);
      const rs = await chrome.waitFor(`!${MS}.mini ? ${MS} : null`, 3000).catch(() => null);
      check(mid === true && left === 0 && !!rs, 'a restore mid-drag: the drag shield goes with it', { shieldMidDrag: mid, shieldsAfter: left, restored: !!rs });
      await sleep(300);
      check((await chrome.ev(PBON)) === pbBefore, 'restored full size: the play bar is as it was before the corner', { before: pbBefore, now: await chrome.ev(PBON) });
      await chrome.ev('document.querySelector(".mv-minibtn").click(), 1');
      mm = await chrome.waitFor(`${MS}.mini ? ${MS} : null`, 3000).catch(() => null);
    }
    check((await chrome.ev('(() => { const r = document.querySelector(".mv-mini-title").getBoundingClientRect(); const h = document.querySelector(".mv-mini-head").getBoundingClientRect(); return r.bottom <= h.bottom + 0.5 && r.top >= h.top - 0.5; })()')), 'the mini header’s title fits its header (nothing clipped)');
    await chrome.ev('document.querySelector(".mv-mini-close").click(), 1');
    const closed = await chrome.waitFor(`!${ST}.open ? ${ST} : null`, 3000).catch(() => null);
    check(!!closed && closed.lastClosed && closed.lastClosed.wcIds.length === 1, 'X on the mini-player closes it (its view destroyed)', closed && closed.lastClosed);
    if (closed) {
      const gone = await chrome.ev(`window.api.watchPlayer.alive(${closed.lastClosed.wcIds[0]}).then((r) => r.alive)`);
      check(gone === false, 'its webContents is gone');
    }

    /* ===== 10. an embed that refuses: the watch page instead ===== */
    await chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=hiLockupB02')}, { service: 'youtube', title: 'One' }), 1`);
    await chrome.waitFor(`${ST}.n === 1 && ${ST}.slots[0].wcId !== null`, 10000).catch(() => 0);
    await add(FY + '/watch?v=refuseVid01', 'youtube', 'Refused embed');
    const fb = await chrome.waitFor(`(() => { const t = ${MS}.tiles[1]; return t && !t.embed && t.url.indexOf('/watch?v=refuseVid01') > 0 ? t : null; })()`, 15000).catch(() => null);
    check(!!fb, 'an embed that shows YouTube’s error: the tile plays the watch page instead', fb || await mstate().then((x) => x.tiles[1]));
    check((await chrome.ev('WatchPlayer._state().note')).indexOf('embedded player') >= 0, 'and says why (bar note)', await chrome.ev('WatchPlayer._state().note'));
    await chrome.ev('WatchPlayer.close("e2e"), 1');
    await sleep(800);

    /* ===== 11. RAM and CPU at 1-4 playing tiles ===== */
    if (!SHOTS_ONLY) {
      const cpuSnap = () => { let idle = 0, total = 0; for (const c of os.cpus()) { for (const k of Object.keys(c.times)) total += c.times[k]; idle += c.times.idle; } return { idle, total }; };
      const urls = [[FD + '/__p/cpu1', 'disney'], [FH + '/__p/cpu2', 'hulu'], [FP + '/__p/cpu3', 'prime'], [FE + '/__p/cpu4', 'espn']];
      const memBase = await chrome.ev('window.api.watchPlayer.memory()');
      results.base = { totalMb: memBase.totalMb, freeGb: memBase.freeGb };
      for (let i = 0; i < 4; i++) {
        if (i === 0) await chrome.ev(`openInLumen(${JSON.stringify(urls[0][0])}, { service: 'disney', title: 'CPU 1' }), 1`);
        else await add(urls[i][0], urls[i][1], 'CPU ' + (i + 1));
        await chrome.waitFor(`${ST}.n === ${i + 1} && ${ST}.slots.every((s) => s.wcId !== null)`, 15000).catch(() => 0);
        await sleep(5000);
        const playing = [];
        for (let j = 0; j <= i; j++) {
          const tt = await targetWhere(q, (x) => String(x.url) === urls[j][0], 3000);
          const c = tt && await cdpTo(tt);
          playing.push(c ? await c.ev('(() => { const v = document.getElementById("v"); return !!v && !v.paused && v.currentTime > 0.5; })()').catch(() => false) : false);
          if (c) c.close();
        }
        const a = await chrome.ev('window.api.watchPlayer.memory()'); const ca = cpuSnap(); const t0 = Date.now();
        await sleep(8000);
        const b = await chrome.ev('window.api.watchPlayer.memory()'); const cb = cpuSnap(); const dt = (Date.now() - t0) / 1000;
        const appPct = Math.round(((b.cpuSec - a.cpuSec) / dt) * 1000) / 10;
        const gpuPct = Math.round((((b.cpuByType.GPU || 0) - (a.cpuByType.GPU || 0)) / dt) * 1000) / 10;
        const machinePct = Math.round((1 - (cb.idle - ca.idle) / Math.max(1, cb.total - ca.total)) * 1000) / 10;
        const tilePct = b.players.map((p) => { const pa = a.players.find((x) => x.wcId === p.wcId); return pa ? Math.round(((p.cpuSec - pa.cpuSec) / dt) * 1000) / 10 : null; });
        const row = { tiles: i + 1, playing, totalMb: b.totalMb, addedMb: b.totalMb - memBase.totalMb, tileMb: b.players.map((p) => p.mb), freeGb: b.freeGb, appCpuPctOfOneCore: appPct, gpuProcPct: gpuPct, tileRendererPct: tilePct, machineCpuPct: machinePct, cores: os.cpus().length };
        results.perTiles.push(row);
        say('measure ' + JSON.stringify(row));
        check(playing.every(Boolean), (i + 1) + ' tile(s): every fixture video is playing', playing);
      }
      const last = results.perTiles[3];
      check(!!last && last.machineCpuPct < 85, '4 tiles do not peg the machine (whole-machine CPU under 85%)', last && last.machineCpuPct);
      await chrome.ev('WatchPlayer.close("e2e"), 1');
    }

    /* ===== 12. 2-up shot ===== */
    await chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=hiLockupB02')}, { service: 'youtube', title: 'Game night: Bruins at Leafs' }), 1`);
    await chrome.waitFor(`${ST}.n === 1 && ${ST}.slots[0].wcId !== null`, 10000).catch(() => 0);
    await add(FD + '/__p/gameB', 'disney', 'Rangers at Devils');
    await waitN(2);
    await sleep(2500);
    await shoot('2up');
    await add(FH + '/__p/gameC', 'hulu', 'Oilers at Flames');
    await waitN(3);
    await sleep(2000);
    await shoot('3up-b');
    await chrome.ev('WatchPlayer.close("e2e"), 1');
    await sleep(600);
    check(await chrome.ev('tabs.length') >= 1, 'Quartz is still up at the end');
    await q.quit();
  } finally {
    try { fs.unlinkSync(FREE_FILE); } catch (e) { /* none */ }
    srv.close();
    try { await mock.close(); } catch (e) { /* gone */ }
    say('RESULTS ' + JSON.stringify(results));
  }
});
