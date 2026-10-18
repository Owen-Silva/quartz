try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine: no cap needed */ }
// watch-ytlib-e2e.js -- YouTube past the home row in Lumen (watch/ytlib.js, watch/ytlib-main.js,
// watch/ytlib-page.js), end to end, in a REAL hidden Quartz test instance (tests/e2e-kit.js:
// --test-profile, off-screen, watched by testwatch.js). Modelled on watch-player-e2e.js.
//
// LOCAL ONLY. A "front" server stands in for www.youtube.com: /feed/subscriptions, /@guitarcoachryan/videos,
// /playlist?list=LL and /playlist?list=PL..., /feed/playlists come from tests/watch-fixtures/youtube-*.json
// (hand-made, next-week/scratch/n-subs/make-fixtures.js); every other path (the home, history, Watch
// later, /watch) goes on to tests/watch-mock.js. accounts.google.com is rebased to a local sign-in page.
// Every https request the Lumen page makes is caught over CDP Fetch: images get a local SVG, anything
// else is refused and counted (a check says none happened). Never a real account, cookie or profile.
//
//   node watch-ytlib-e2e.js [--cdp 9491] [--shots <dir>] [--prefix lumen-n-subs]
//
// Seeded before boot: <profile>/watch-ytlib.json says every video of the feed but 2 was seen days ago,
// and Lumen was last left an hour ago, so this boot is a new visit and exactly those 2 are new.
// Checks: the row (up top, the New marks, the "2 new" badge, avatars, newest first); a click plays in
// the player layer (no tab) and that video's mark clears (badge 1, the file keeps it); See all (the
// New / Earlier sections, the Shorts note); a tile there plays in the layer; the channel page; the
// stage's channel button; Esc; the Library (Watch later, Liked, playlists); a playlist page and a tile
// in it; Liked's See all; the Back button, Alt+Left and the mouse back button; a failed refresh keeps
// the tiles and says the reason (row and page); a failed channel says its reason; signed out (the row's
// card and the page's panel), whose sign-in opens IN the layer; shots at 1280x800, 1536x800 and
// 1920x1000 with no clipped descenders. One summary line: "watch-ytlib-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');
const L = require('./watch/ytlib');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9491'));
const SHOTS = opt('shots', 'C:/Users/you/next-week/morning-shots');
const PREFIX = opt('prefix', 'lumen-n-subs');
const SIZES = [[1280, 800], [1536, 800], [1920, 1000]];
const FIX = path.join(__dirname, 'tests', 'watch-fixtures');
const fx = (name) => JSON.parse(fs.readFileSync(path.join(FIX, 'youtube-' + name + '.json'), 'utf8'));
const PL_ID = 'PLbakingSourdough0000000001';
const CHANNEL = '/@guitarcoachryan';
const NEW_IDS = ['sbNewVid011', 'sbNewVid012'];

/* ---- the local servers ----------------------------------------------------------------------- */
function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 2000;
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, origin: 'http://127.0.0.1:' + s.address().port }));
  });
}
const BS = String.fromCharCode(92);
const inScript = (v) => JSON.stringify(v).split('<').join(BS + 'u003c')
  .split(String.fromCharCode(0x2028)).join(BS + 'u2028').split(String.fromCharCode(0x2029)).join(BS + 'u2029');
function sendHtml(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
/** A YouTube page as the mock serves one: a ytcfg for LOGGED_IN, then window.ytInitialData (or none). */
function ytPage(f, label) {
  const data = f && f.ytInitialData ? 'window.ytInitialData=' + inScript(f.ytInitialData) + ';' : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>YouTube</title><script>var ytcfg={data_:{LOGGED_IN:' +
    (!f || f.loggedIn === true) + '},get:function(k){return this.data_[k];}};' + data + '</script></head><body><div id="content">front YouTube (' + label + ')</div></body></html>';
}

// What /feed/subscriptions answers: 'ok' | 'error' (a page with no ytInitialData) | 'signed-out'.
const FRONT = { subs: 'ok' };
const frontLog = [];

async function startServers(mock) {
  const auth = await listen((req, res) => sendHtml(res, '<!doctype html><title>Sign in</title><body style="font:15px Segoe UI,sans-serif;padding:32px;background:#f4f4f4;color:#222">' +
    '<h2 id="si">Sign in (the test\'s local stand-in for accounts.google.com)</h2><p>' + String(req.url || '').replace(/[<>&"]/g, '') + '</p></body>'));
  const front = await listen((req, res) => {
    const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
    const p = u.pathname;
    frontLog.push({ path: p + u.search, t: Date.now() });
    if (p === '/feed/subscriptions') {
      if (FRONT.subs === 'signed-out') return sendHtml(res, ytPage(fx('subs-signedout'), 'subs-signedout'));
      if (FRONT.subs === 'error') return sendHtml(res, ytPage({ loggedIn: true }, 'subs: no ytInitialData'));
      return sendHtml(res, ytPage(fx('subs-next'), 'subs-next'));
    }
    if (p === CHANNEL + '/videos') return sendHtml(res, ytPage(fx('channel'), 'channel'));
    if (p === '/feed/playlists') return sendHtml(res, ytPage(fx('playlists'), 'playlists'));
    if (p === '/playlist' && u.searchParams.get('list') === 'LL') return sendHtml(res, ytPage(fx('liked'), 'liked'));
    if (p === '/playlist' && u.searchParams.get('list') === PL_ID) return sendHtml(res, ytPage(fx('playlist'), 'playlist'));
    // Everything else is the mock's: the home, history, Watch later, /watch, and the 404s.
    const up = http.request({ host: '127.0.0.1', port: mock.ports.youtube, path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + mock.ports.youtube }) }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('mock gone'); } });
    req.pipe(up);
    return undefined;
  });
  const rebase = [['https://www.youtube.com', front.origin], ['https://accounts.google.com', auth.origin]];
  for (const pair of mock.rebase) if (pair[0] !== 'https://www.youtube.com') rebase.push(pair);
  return { auth, front, rebase, close: () => { auth.server.close(); front.server.close(); } };
}

/* ---- the seeded file -------------------------------------------------------------------------- */
function seed(profileDir) {
  const f = fx('subs-next');
  const u = L.SUBS_URL;
  const feed = L.parseSubs({ steps: { subs: { ok: true, url: u, finalUrl: u, status: 200, extracted: { url: u, data: f.ytInitialData, loggedIn: f.loggedIn }, error: null } } });
  const ids = feed.items.map((it) => it.vid);
  const t = Date.now();
  const seen = {};
  for (const id of ids) if (NEW_IDS.indexOf(id) === -1) seen[id] = t - 3 * 86400e3;
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'watch-ytlib.json'), JSON.stringify({ v: 1, mark: { seen, played: {}, baseline: true, cutoff: t - 2 * 86400e3, lastOffAt: t - 3600e3 } }));
  return { ids, seen: Object.keys(seen).length };
}

/* ---- CDP helpers ------------------------------------------------------------------------------ */
function hue(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; }
function still(url) {
  const h1 = hue(url), h2 = (h1 + 40) % 360;
  const round = /ggpht|googleusercontent/.test(url);
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + (round ? 176 : 1280) + '" height="' + (round ? 176 : 720) + '"><defs><radialGradient id="a" cx="25%" cy="20%" r="95%">' +
    '<stop offset="0" stop-color="hsl(' + h1 + ',26%,46%)"/><stop offset="1" stop-color="hsl(' + h2 + ',20%,14%)"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#a)"/></svg>';
}
async function targetWhere(q, pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    let list = [];
    try { list = await q.targets(); } catch (e) { list = []; }
    const t = list.find((x) => x.webSocketDebuggerUrl && pred(x));
    if (t) return t;
    await sleep(60);
  }
  return null;
}
/** The Lumen page, attached as soon as it exists: every https request it makes is answered here. */
async function guest(q) {
  const t = await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 20000);
  if (!t) throw new Error('the Lumen page never appeared as a CDP target');
  const g = await new Cdp(t.webSocketDebuggerUrl).open();
  g.errors = [];
  g.fetched = { drawn: 0, refused: [] };
  g.ws.on('message', (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (m.method === 'Runtime.exceptionThrown') g.errors.push('exception: ' + String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).slice(0, 300));
    else if (m.method === 'Fetch.requestPaused') {
      const u = m.params.request.url;
      if (m.params.resourceType === 'Image') {
        g.fetched.drawn++;
        g.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/svg+xml' }], body: Buffer.from(still(u)).toString('base64') });
      } else {
        g.fetched.refused.push(m.params.resourceType + ' ' + u.slice(0, 120));
        g.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' });
      }
    }
  });
  await g.send('Runtime.enable');
  const fe = await g.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*', requestStage: 'Request' }] });
  if (fe && fe.error) throw new Error('Fetch.enable failed: ' + JSON.stringify(fe.error));
  await g.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return g;
}
async function keyIn(c, key, code, vk, mods) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods || 0 };
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}

// watch-design-e2e.js's descender check: no text cut by the box that clips it.
const DESCENDERS = `(() => {
  const clipOf = (e) => { for (let a = e, k = 0; a && a !== document.body && k < 8; a = a.parentElement, k++) { if (/hidden|clip|auto|scroll/.test(getComputedStyle(a).overflowY)) return a; } return null; };
  const bad = []; let n = 0;
  for (const e of document.querySelectorAll('body *')) {
    const own = [...e.childNodes].filter((x) => x.nodeType === 3 && x.textContent.trim());
    if (!own.length) continue;
    const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.fontSize) < 1) continue;
    const b = e.getBoundingClientRect(); if (!b.width || !b.height || b.bottom <= 0 || b.top >= innerHeight || b.right <= 0 || b.left >= innerWidth) continue;
    const c = clipOf(e); if (!c) continue;
    const cb = c.getBoundingClientRect(); const bottom = cb.bottom - parseFloat(getComputedStyle(c).borderBottomWidth);
    n++;
    for (const t of own) {
      const r = document.createRange(); r.selectNodeContents(t);
      const rects = [...r.getClientRects()].filter((x) => x.width > 0 && (x.top + x.bottom) / 2 < bottom);
      if (!rects.length) continue;
      const last = Math.max(...rects.map((x) => x.bottom));
      if (last > bottom + 0.5) bad.push({ el: e.tagName.toLowerCase() + '.' + String(e.className).split(' ').join('.'), text: t.textContent.trim().slice(0, 32), cutPx: Math.round((last - bottom) * 10) / 10 });
    }
  }
  return { n, bad: bad.slice(0, 10), count: bad.length }; })()`;
// Every picture in view loaded and decoded (or given up after 10 s), then two frames.
const SETTLE = `new Promise((done) => {
  const inView = () => [...document.querySelectorAll('img')].filter((i) => { const b = i.getBoundingClientRect();
    return b.width > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth && getComputedStyle(i).visibility !== 'hidden'; });
  const t0 = performance.now();
  const tick = () => {
    const imgs = inView(); const waiting = imgs.filter((i) => !i.complete || !i.naturalWidth);
    if (waiting.length && performance.now() - t0 < 10000) { setTimeout(tick, 100); return; }
    Promise.all(imgs.map((i) => (i.decode ? i.decode().catch(() => 0) : 0))).then(() => requestAnimationFrame(() => requestAnimationFrame(() =>
      done({ inView: imgs.length, notReady: waiting.length }))));
  };
  setTimeout(() => done({ stuck: true }), 15000);
  tick(); })`;

const YS = 'WatchYt._state()';
const PST = 'WatchPlayer._state()';
const ROW = `document.querySelector('#stack section.lrow[data-key="r:yt-subs"]')`;
const YTP = `document.getElementById('ytp')`;

run('watch-ytlib-e2e', async ({ check, launch, say, profileDir }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const seeded = seed(profileDir);
  check(seeded.ids.length === 11 && seeded.seen === 9, 'seeded: the file says 9 of the feed\'s 11 videos were seen before (2 are new)', seeded);
  const mock = await Mock.start({ log: () => {} });
  const srv = await startServers(mock);
  const FY = srv.front.origin;
  const env = {
    QUARTZ_WATCH_BOOT_GRACE_MS: '0',
    QUARTZ_WATCH_REBASE: JSON.stringify(srv.rebase),
    QUARTZ_EDGE_STUB: path.join(require('os').tmpdir(), 'quartz-ytlib-e2e-' + process.pid + '-edge.txt'),
    QUARTZ_WATCH_MIN_FREE_GB: '0',
    QUARTZ_PLAYER_AUTH_HOSTS: '127.0.0.1:' + srv.auth.port,
    QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1',
  };
  const fileNow = () => { try { return JSON.parse(fs.readFileSync(path.join(profileDir, 'watch-ytlib.json'), 'utf8')); } catch (e) { return null; } };
  const hits = (re, t) => frontLog.filter((l) => l.t >= (t || 0) && re.test(l.path)).length;

  try {
    const q = await launch({ cdp: CDP_PORT, env });
    const chrome = q.chrome;
    await chrome.ev('openWatchTab(), 1');
    const g = await guest(q);
    const wait = (expr, ms) => g.waitFor(expr, ms || 20000).catch(() => null);
    const click = (expr) => g.ev(`(() => { const b = ${expr}; if (!b) return false; b.click(); return true; })()`);
    // A tile on the rows opens on click only in the current row: focus it first (that makes its row current).
    const focusCard = (vid) => g.ev(`(() => { const c = [...document.querySelectorAll('#stack .card')].find((x) => x._item && x._item.vid === '${vid}'); if (!c) return null; c.focus({ preventScroll: true }); return c.closest('.lrow').dataset.key; })()`).then(async (k) => { await sleep(700); return k; });
    const btnIn = (root, re) => `[...((${root}) || document.createElement('i')).querySelectorAll('button, .btn')].find((x) => ${re}.test(x.textContent.trim()))`;
    const views = async () => (await g.ev(YS)).views;
    const player = () => chrome.ev(PST);
    const closeLayer = async () => {
      await chrome.ev('(() => { const b = document.querySelector(".wp-layer .wp-back"); if (b) b.click(); return 1; })()');
      let ok = !!(await chrome.waitFor(`!${PST}.open`, 8000).catch(() => null));
      if (!ok) { await chrome.ev('WatchPlayer.close(), 1'); ok = !!(await chrome.waitFor(`!${PST}.open`, 5000).catch(() => null)); }
      await sleep(400);
      return ok;
    };

    // Shots: the Lumen page grown to the size (the test window is smaller), then the guest's viewport.
    const ungrow = () => chrome.ev('(() => { const v = findWatchTab().viewEl; v.setAttribute("style", v.dataset.e2eStyle || ""); return 1; })()');
    const grow = () => chrome.ev('(() => { const v = findWatchTab().viewEl; v.dataset.e2eStyle = v.getAttribute("style") || ""; const s = v.style; s.setProperty("position", "fixed", "important"); s.setProperty("left", "0px", "important"); s.setProperty("top", "0px", "important"); s.setProperty("width", "1920px", "important"); s.setProperty("height", "1000px", "important"); s.setProperty("z-index", "2147483647", "important"); return 1; })()');
    await grow();
    const size = async (w, h) => { await g.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(600); };
    await size(1280, 800);
    const shots = async (name, prep) => {
      for (const [w, h] of SIZES) {
        await size(w, h);
        if (prep) await prep();
        const st = await g.ev(SETTLE).catch((e) => ({ error: e.message }));
        await sleep(350);
        const cut = await g.ev(DESCENDERS).catch((e) => ({ error: e.message }));
        check(cut && cut.count === 0, `shot ${name} ${w}x${h}: no clipped text cuts its descenders (${cut && cut.n} clipped texts in view)`, cut && cut.count ? cut.bad : undefined);
        if (st && (st.notReady || st.stuck)) say(`shot ${name} ${w}x${h}: pictures ${JSON.stringify(st)}`);
        try { await g.shot(path.join(SHOTS, `${PREFIX}-${name}-${w}x${h}.png`)); } catch (e) { check(false, `shot ${name} ${w}x${h} saved`, e.message); }
      }
      await size(1280, 800);
    };
    const focusRow = () => g.ev(`(() => { const r = ${ROW}; const c = r && r.querySelector('.card'); if (c) c.focus({ preventScroll: true }); return !!c; })()`).then(() => sleep(900));
    const blur = () => g.ev('(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return 1; })()');

    /* ============================ the row ============================ */
    const s0 = await wait(`(() => { const s = ${YS}.subs; return s && s.state === 'ok' && !s.refreshing && s.n === 11 && ${ROW} ? s : null; })()`, 120000);
    check(!!s0, 'the Subscriptions feed is read (11 videos, Shorts left out) and its row is on the page', s0 || await g.ev(YS).catch((e) => e.message));
    // The other services' rows too, so the row's place and the shots are the real page's.
    const nRows = await wait(`document.querySelectorAll('#stack section.lrow').length >= 4 ? document.querySelectorAll('#stack section.lrow').length : null`, 60000);
    say('rows on the page: ' + nRows);
    check(hits(/^\/feed\/subscriptions$/) >= 1, 'the reader read /feed/subscriptions from the front server', frontLog.slice(-6));
    const r0 = await g.ev(`(() => { const r = ${ROW}; if (!r) return null; const rows = [...document.querySelectorAll('#stack section.lrow')].map((x) => x.dataset.key);
      const cards = [...r.querySelectorAll('.card')];
      return { idx: rows.indexOf('r:yt-subs'), rows: rows.slice(0, 4), title: (r.querySelector('.lr-h h2, .lr-h h3, .lr-h .t, .lr-h b') || {}).textContent || r.querySelector('.lr-h').textContent,
        badge: (r.querySelector('.lr-h .yt-badge') || {}).textContent || '', n: cards.length, chips: cards.filter((c) => c.querySelector('.art .chips .mk')).length,
        vids: cards.map((c) => c._item && c._item.vid), isNew: cards.filter((c) => c.classList.contains('is-new')).map((c) => c._item && c._item.vid),
        marks: cards.filter((c) => c.querySelector('.art .yt-new')).length, avatars: cards.filter((c) => c.querySelector('.m > .yt-av')).length,
        aria: cards[0] ? cards[0].getAttribute('aria-label') : '', hacts: [...r.querySelectorAll('.yt-hacts .btn')].map((b) => b.textContent.trim()) }; })()`);
    check(r0 && /Subscriptions/.test(r0.title) && r0.idx >= 0 && r0.idx <= 1, 'the row is called Subscriptions and sits at the top (first, or after Continue watching)', r0 && { idx: r0.idx, rows: r0.rows, title: r0.title });
    check(r0 && r0.badge === '2 new', 'the row\'s badge says "2 new"', r0 && r0.badge);
    check(r0 && r0.isNew.length === 2 && NEW_IDS.every((id) => r0.isNew.indexOf(id) !== -1) && r0.marks === 2, 'exactly the 2 unseen videos carry the New mark', r0 && { isNew: r0.isNew, marks: r0.marks });
    check(r0 && r0.vids[0] === NEW_IDS[0] && r0.vids[1] === NEW_IDS[1], 'newest first: the 2 new videos lead the row', r0 && r0.vids.slice(0, 4));
    check(r0 && r0.avatars === r0.n && r0.n >= 6, 'every tile shows its channel\'s avatar', r0 && { avatars: r0.avatars, n: r0.n });
    // "Plays in Watch" there is watch.js's opensHere() (lumen-player's hub name), not this lane's words.
    check(r0 && /^New\. /.test(r0.aria) && /Plays in /.test(r0.aria), 'a New tile says "New." and that it plays here to a screen reader', r0 && r0.aria);
    check(r0 && r0.chips === 0, 'no YouTube chip on the row\'s tiles (the whole row is YouTube; the New mark has that corner)', r0 && r0.chips);
    check(r0 && r0.hacts.join('|') === 'See all|Library|Shorts', 'the row\'s header has See all, Library and Shorts (Lumen’s Shorts view)', r0 && r0.hacts);
    await sleep(1200);
    const f0 = fileNow();
    check(f0 && f0.subs && f0.subs.state === 'ok' && f0.mark && NEW_IDS.every((id) => typeof f0.mark.seen[id] === 'number' && f0.mark.seen[id] > f0.mark.cutoff), 'watch-ytlib.json keeps the feed and when the 2 new videos were first seen (after the cutoff)', f0 && f0.mark && { cutoff: f0.mark.cutoff, n: Object.keys(f0.mark.seen).length });
    await shots('row', async () => { await focusRow(); });

    /* ============================ click to play; the mark clears ============================ */
    const tabsBefore = await chrome.ev('tabs.length');
    await focusCard(NEW_IDS[0]);
    check((await g.ev(`(${ROW}).dataset.d`)) === '0', 'focusing a tile makes the Subscriptions row current');
    await click(`[...(${ROW}).querySelectorAll('.card')].find((c) => c._item && c._item.vid === '${NEW_IDS[0]}')`);
    const p1 = await chrome.waitFor(`(() => { const s = ${PST}; return s.open && s.n === 1 && s.slots[0].url ? s : null; })()`, 15000).catch(() => null);
    check(!!p1 && p1.slots[0].url === FY + '/watch?v=' + NEW_IDS[0], 'a click on a New tile plays it in the player layer (the watch page, rebased to the test)', p1 && p1.slots[0].url);
    check(p1 && /Reading the Shooter/.test(p1.title) && (await chrome.ev('tabs.length')) === tabsBefore, 'the layer\'s bar has the title; no new tab opened', p1 && p1.title);
    const s1 = await wait(`(() => { const s = ${YS}.subs; return s && s.newCount === 1 ? s : null; })()`, 10000);
    const r1 = await g.ev(`(() => { const r = ${ROW}; const c = r && [...r.querySelectorAll('.card')].find((x) => x._item && x._item.vid === '${NEW_IDS[0]}'); return { badge: (r.querySelector('.lr-h .yt-badge') || {}).textContent || '', played: c ? c.classList.contains('is-new') || !!c.querySelector('.yt-new') : 'gone', other: !![...r.querySelectorAll('.card.is-new')].find((x) => x._item && x._item.vid === '${NEW_IDS[1]}') }; })()`);
    check(!!s1 && r1.badge === '1 new' && r1.played === false && r1.other, 'the played video\'s New mark clears; the badge says "1 new"; the other stays new', r1);
    check(await closeLayer(), 'the layer closes (its Back button)');
    await sleep(1200);
    const f1 = fileNow();
    check(f1 && f1.mark && typeof f1.mark.played[NEW_IDS[0]] === 'number', 'the file remembers it was played from Lumen (never new again)', f1 && f1.mark && Object.keys(f1.mark.played));

    /* ============================ See all ============================ */
    await click(btnIn(`${ROW}.querySelector('.yt-hacts')`, '/^See all$/'));
    const v1 = await wait(`(() => { const y = ${YTP}; return y && !y.hidden && document.body.classList.contains('yt-open') && ${YS}.views.join() === 'subs' ? 1 : null; })()`, 8000);
    const pg1 = await g.ev(`(() => { const y = ${YTP}; if (!y) return null; return { h2: (y.querySelector('.ytp-t1 h2') || {}).textContent, badge: (y.querySelector('.ytp-t1 .yt-badge') || {}).textContent || '',
      secs: [...y.querySelectorAll('.yt-sec')].map((s) => s.querySelector('.yt-sec-h h3').textContent + ':' + s.querySelectorAll('.yt-cell').length),
      shorts: !!${btnIn("document.querySelector('#ytp .yt-shorts')", '/^Open Shorts/')}, back: document.activeElement && document.activeElement.classList.contains('ytp-back'),
      acts: [...y.querySelectorAll('.ytp-acts .btn')].map((b) => b.textContent.trim()) }; })()`);
    check(!!v1 && pg1 && pg1.h2 === 'Subscriptions' && pg1.badge === '1 new', 'See all opens the Subscriptions page in Lumen (title, "1 new")', pg1);
    check(pg1 && pg1.secs.join('|') === 'New since you last opened Lumen:1|Earlier:10', 'the page splits New since you last opened Lumen (1) from Earlier (10)', pg1 && pg1.secs);
    check(pg1 && pg1.shorts, 'the Shorts note offers "Open Shorts" (Shorts are left out of the grid)');
    check(pg1 && pg1.back, 'focus lands on the page\'s Back button');
    check(pg1 && pg1.acts.indexOf('Library') !== -1 && pg1.acts.indexOf('Refresh') !== -1 && pg1.acts.some((a) => /^Open on YouTube/.test(a)), 'the page\'s actions: Library, Refresh, Open on YouTube', pg1 && pg1.acts);
    await shots('subs', blur);
    await click(`document.querySelector('#ytp .yt-play[data-fk="v:sbVideo0004"]')`);
    const p2 = await chrome.waitFor(`(() => { const s = ${PST}; return s.open && s.slots[0] && s.slots[0].url ? s : null; })()`, 15000).catch(() => null);
    // sbVideo0004 is also in the mock's Continue watching (history), so it resumes there (&t=).
    check(!!p2 && p2.slots[0].url.indexOf(FY + '/watch?v=sbVideo0004') === 0 && (await chrome.ev('tabs.length')) === tabsBefore, 'a tile on the page plays in the layer too', p2 && p2.slots[0].url);
    check(!!p2 && /[?&]t=\d+s?$/.test(p2.slots[0].url), 'a video that is in Continue watching resumes where it was left (&t=)', p2 && p2.slots[0].url);
    check(await closeLayer(), 'the layer closes again');
    check((await views()).join() === 'subs', 'closing the layer leaves the Subscriptions page open');

    /* ============================ the channel ============================ */
    let t = Date.now();
    await click(`document.querySelector('#ytp .yt-ch[data-fk="c:sbVideo0004"]')`);
    const c1 = await wait(`(() => { const s = ${YS}; const y = ${YTP}; return s.views.join() === 'subs,channel:${CHANNEL}' && y.querySelectorAll('.yt-sec .yt-cell').length === 6 ? 1 : null; })()`, 30000);
    const cp = await g.ev(`(() => { const y = ${YTP}; return { h2: (y.querySelector('.ytp-t1 h2') || {}).textContent, sub: (y.querySelector('.ytp-ttl > .sub') || {}).textContent, av: !!y.querySelector('.ytp-ch .yt-av.lg'),
      sec: (y.querySelector('.yt-sec-h h3') || {}).textContent, n: y.querySelectorAll('.yt-sec .yt-cell').length, acts: [...y.querySelectorAll('.ytp-acts .btn')].map((b) => b.textContent.trim()) }; })()`);
    check(!!c1 && cp.h2 === 'Guitar Coach Ryan' && cp.n === 6 && cp.av, 'a channel name opens its page in Lumen: the name, the avatar, its 6 videos', cp);
    check(/@guitarcoachryan/.test(cp.sub || '') && /subscriber/.test(cp.sub || ''), 'the channel\'s handle and subscriber count', cp.sub);
    check(cp.acts.indexOf('Shorts') !== -1 && cp.acts.indexOf('Refresh') !== -1, 'the channel page offers Shorts (in Lumen) and Refresh', cp.acts);
    check(hits(new RegExp('^' + CHANNEL + '/videos$'), t) === 1, 'the reader read the channel\'s Videos tab once', frontLog.filter((l) => l.t >= t).map((l) => l.path));
    await shots('channel', blur);
    await g.ev(`(() => { const b = document.querySelector('#ytp .ytp-back'); b.focus(); return 1; })()`);
    await keyIn(g, 'Escape', 'Escape', 27);
    check(!!(await wait(`${YS}.views.join() === 'subs' ? 1 : null`, 5000)), 'Esc walks back from the channel to Subscriptions');
    await keyIn(g, 'Escape', 'Escape', 27);
    const out1 = await wait(`(() => { const y = ${YTP}; return y.hidden && !document.body.classList.contains('yt-open') && ${YS}.views.length === 0 ? 1 : null; })()`, 5000);
    const foc1 = await g.ev('(() => { const a = document.activeElement; return a ? (a.closest("#stack") ? "stack" : a.tagName + "." + a.className) : "none"; })()');
    check(!!out1 && foc1 === 'stack', 'Esc again closes the pages; focus is back on the rows', foc1);

    /* ============================ the stage's channel button ============================ */
    await focusCard('sbVideo0004');
    const chb = await wait(`(() => { const b = document.querySelector('.stage .yt-chbtn'); return b && b.offsetParent && /Guitar Coach Ryan/.test(b.textContent) ? b.textContent.trim() : null; })()`, 8000);
    check(!!chb, 'the stage of a focused tile offers its channel', chb);
    await click(`document.querySelector('.stage .yt-chbtn')`);
    check(!!(await wait(`${YS}.views.join() === 'channel:${CHANNEL}' && ${YTP}.querySelectorAll('.yt-sec .yt-cell').length === 6 ? 1 : null`, 8000)), 'the stage\'s channel button opens the channel page (from memory)');
    await g.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 500, button: 'back', buttons: 8, clickCount: 1 });
    await g.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 600, y: 500, button: 'back', buttons: 0, clickCount: 1 });
    check(!!(await wait(`${YS}.views.length === 0 && ${YTP}.hidden ? 1 : null`, 5000)), 'the mouse\'s back button closes the page', await views());

    /* ============================ the Library ============================ */
    t = Date.now();
    await click(btnIn(`${ROW}.querySelector('.yt-hacts')`, '/^Library$/'));
    const lb = await wait(`(() => { const y = ${YTP}; const secs = [...y.querySelectorAll('.yt-sec')].map((s) => s.querySelector('.yt-sec-h h3').textContent + ':' + s.querySelectorAll('.yt-cell').length);
      return ${YS}.views.join() === 'library' && secs.length === 3 && !y.querySelector('.yt-loading') ? secs : null; })()`, 45000);
    check(!!lb && lb.join('|') === 'Watch later:6|Liked videos:4|Playlists:3', 'the Library: Watch later (6), Liked videos (4), Playlists (3)', lb || await g.ev(`[...${YTP}.querySelectorAll('.yt-sec-h h3, .yt-panel, .res-note')].map((x) => x.textContent.slice(0, 90))`));
    check(hits(/^\/playlist\?list=WL$/, t) >= 1 && hits(/^\/playlist\?list=LL$/, t) === 1 && hits(/^\/feed\/playlists$/, t) === 1, 'the Library read Watch later, Liked and the playlists page', frontLog.filter((l) => l.t >= t).map((l) => l.path));
    const lh = await g.ev(`(() => { const y = ${YTP}; return { h2: y.querySelector('.ytp-t1 h2').textContent, more: [...y.querySelectorAll('.yt-sec-h .btn')].map((b) => b.textContent.trim()) }; })()`);
    check(lh.h2 === 'Library' && lh.more.some((m) => /^See all/.test(m)), 'the Library page\'s title, and See all on its shelves', lh);
    await shots('library', blur);

    /* ============================ a playlist ============================ */
    t = Date.now();
    await click(`document.querySelector('#ytp .yt-play.yt-pl[data-fk="p:${PL_ID}"]')`);
    const pl = await wait(`(() => { const y = ${YTP}; return ${YS}.views.join() === 'library,playlist:${PL_ID}' && y.querySelectorAll('.yt-sec .yt-cell').length === 3 ? { h2: y.querySelector('.ytp-t1 h2').textContent, sub: (y.querySelector('.ytp-ttl > .sub') || {}).textContent } : null; })()`, 30000);
    check(!!pl && pl.h2 === 'Recipes to try out' && /by the user/.test(pl.sub) && /3 videos/.test(pl.sub), 'a playlist tile opens the playlist in Lumen: title, owner, count, 3 videos', pl);
    check(hits(new RegExp('^/playlist\\?list=' + PL_ID + '$'), t) === 1, 'the reader read that playlist once', frontLog.filter((l) => l.t >= t).map((l) => l.path));
    await shots('playlist', blur);
    const firstPl = await g.ev(`(() => { const b = document.querySelector('#ytp .yt-sec .yt-play'); return b && b._item ? b._item.vid : null; })()`);
    await click(`document.querySelector('#ytp .yt-sec .yt-play')`);
    const p3 = await chrome.waitFor(`(() => { const s = ${PST}; return s.open && s.slots[0] && s.slots[0].url ? s : null; })()`, 15000).catch(() => null);
    check(!!p3 && !!firstPl && p3.slots[0].url.indexOf(FY + '/watch?v=' + firstPl) === 0, 'a playlist video plays in the layer', p3 && p3.slots[0].url);
    check(await closeLayer(), 'the layer closes');
    await click(`document.querySelector('#ytp .ytp-back')`);
    check(!!(await wait(`${YS}.views.join() === 'library' ? 1 : null`, 5000)), 'Back (the page\'s button) walks from the playlist to the Library');
    await click(btnIn(`[...document.querySelectorAll('#ytp .yt-sec')].find((s) => /Liked/.test(s.querySelector('h3').textContent))`, '/^See all/'));
    const ll = await wait(`(() => { const y = ${YTP}; return ${YS}.views.join() === 'library,playlist:LL' && y.querySelectorAll('.yt-sec .yt-cell').length === 4 ? y.querySelector('.ytp-t1 h2').textContent : null; })()`, 30000);
    check(!!ll, 'Liked videos\' See all opens the whole list (4)', ll || await views());
    await g.ev(`document.querySelector('#ytp .ytp-back').focus(), 1`);
    await keyIn(g, 'ArrowLeft', 'ArrowLeft', 37, 1);
    check(!!(await wait(`${YS}.views.join() === 'library' ? 1 : null`, 5000)), 'Alt+Left walks back too');
    await click(`document.querySelector('#ytp .ytp-back')`);
    check(!!(await wait(`${YS}.views.length === 0 && ${YTP}.hidden ? 1 : null`, 5000)), 'Back from the Library closes the pages');

    // (a failure above must not leave a page open under the next part)
    await g.ev('(window.WatchYt.isOpen() && window.WatchYt.close(), 1)');

    /* ============================ a failed refresh: the reason, the tiles kept ============================ */
    FRONT.subs = 'error';
    await click(btnIn(`${ROW}.querySelector('.yt-hacts')`, '/^See all$/'));
    await wait(`${YS}.views.join() === 'subs' ? 1 : null`, 5000);
    await click(btnIn(`document.querySelector('#ytp .ytp-acts')`, '/^Refresh/'));
    const e1 = await wait(`(() => { const s = ${YS}.subs; const n = document.querySelector('#ytp .res-note.err'); return s.state === 'error' && !s.refreshing && n ? { why: (n.querySelector('.why') || {}).textContent, cells: document.querySelectorAll('#ytp .yt-cell').length, retry: !!${btnIn("document.querySelector('#ytp .res-note.err')", '/^Retry$/')} } : null; })()`, 30000);
    check(!!e1 && /ytInitialData/.test(e1.why) && e1.cells === 11 && e1.retry, 'a failed refresh keeps the 11 tiles and says why (with Retry) on the page', e1);
    await size(1280, 800); await blur(); await g.ev(SETTLE).catch(() => 0);
    try { await g.shot(path.join(SHOTS, `${PREFIX}-error-page-1280x800.png`)); } catch (e) { say('shot failed: ' + e.message); }
    await keyIn(g, 'Escape', 'Escape', 27);
    await wait(`${YS}.views.length === 0 ? 1 : null`, 5000);
    const e2 = await wait(`(() => { const r = ${ROW}; const s = r && r.querySelector('.lr-h .sub.err'); return s ? { text: s.textContent, title: s.title, retry: !!${btnIn(`${ROW}.querySelector('.lr-h')`, '/^Retry$/')}, cards: r.querySelectorAll('.card').length } : null; })()`, 8000);
    check(!!e2 && /Couldn.t refresh/.test(e2.text) && /ytInitialData/.test(e2.title) && e2.retry && e2.cards >= 6, 'the row says it couldn\'t refresh (the reason on hover), offers Retry, and keeps its tiles', e2);
    await focusRow();
    try { await g.shot(path.join(SHOTS, `${PREFIX}-error-row-1280x800.png`)); } catch (e) { say('shot failed: ' + e.message); }
    // A channel the front server doesn't have (the mock's 404): a page with nothing to keep says its reason.
    t = Date.now();
    await g.ev(`window.WatchYt.open({ kind: 'channel', path: '/@recipebreakdown', name: 'Recipe Breakdown' }), 1`);
    const e3 = await wait(`(() => { const p = document.querySelector('#ytp .yt-panel.st-error'); return p ? { h3: p.querySelector('h3').textContent, why: (p.querySelector('.why') || {}).textContent, acts: [...p.querySelectorAll('.btn')].map((b) => b.textContent.trim()) } : null; })()`, 30000);
    check(!!e3 && /Couldn.t read this channel/.test(e3.h3) && /^YouTube: \S/.test(e3.why) && e3.acts.indexOf('Retry') !== -1, 'a channel that fails to read says so, with the reason and Retry', e3);
    try { await g.shot(path.join(SHOTS, `${PREFIX}-error-channel-1280x800.png`)); } catch (e) { say('shot failed: ' + e.message); }
    await keyIn(g, 'Escape', 'Escape', 27);
    await wait(`${YS}.views.length === 0 ? 1 : null`, 5000);

    /* ============================ signed out: sign-in opens IN the layer ============================ */
    FRONT.subs = 'signed-out';
    await click(btnIn(`${ROW}.querySelector('.lr-h')`, '/^Retry$/'));
    const so = await wait(`(() => { const s = ${YS}.subs; const r = ${ROW}; const c = r && r.querySelector('.card.yt-state.st-signed-out');
      const rows = [...document.querySelectorAll('#stack section.lrow')].map((x) => x.dataset.key);
      return s.state === 'signed-out' && !s.refreshing && c ? { text: c.textContent, idx: rows.indexOf('r:yt-subs'), rows: rows.length } : null; })()`, 30000);
    check(!!so && /Sign in to YouTube/.test(so.text) && /inside Lumen/.test(so.text), 'signed out: the row is one card, "Sign in to YouTube" (opens inside Lumen)', so);
    check(!!so && r0 && so.idx > r0.idx + 1, 'signed out, the card moves down, below the rows with videos', so && { idx: so.idx, was: r0 && r0.idx, rows: so.rows });
    await g.ev(`(() => { const c = document.querySelector('#stack .card.yt-state'); c.focus({ preventScroll: true }); return 1; })()`);
    await sleep(800);
    try { await g.shot(path.join(SHOTS, `${PREFIX}-signedout-row-1280x800.png`)); } catch (e) { say('shot failed: ' + e.message); }
    await click(`document.querySelector('#stack .card.yt-state.st-signed-out')`);
    const sl = await chrome.waitFor(`(() => { const s = ${PST}; return s.open && s.slots[0] && s.slots[0].url ? s : null; })()`, 15000).catch(() => null);
    check(!!sl && sl.slots[0].url.indexOf(srv.auth.origin + '/ServiceLogin') === 0 && (await chrome.ev('tabs.length')) === tabsBefore, 'its sign-in opens IN the player layer (the test\'s accounts.google.com), no tab', sl && { url: sl.slots[0].url, title: sl.title });
    // The window's own shot (the layer sits in the chrome, over the Lumen view): the view back in its
    // place for it, the window at 1280x800, as watch-player-e2e.js shoots the layer.
    await ungrow();
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(1200);
    try { await chrome.shot(path.join(SHOTS, `${PREFIX}-signin-layer-1280x800.png`)); } catch (e) { say('shot failed: ' + e.message); }
    await chrome.send('Emulation.clearDeviceMetricsOverride');
    await grow();
    await sleep(400);
    check(await closeLayer(), 'the sign-in layer closes');
    await g.ev(`window.WatchYt.open({ kind: 'subs' }), 1`);
    const sp = await wait(`(() => { const p = document.querySelector('#ytp .yt-panel.st-signed-out'); return p ? [...p.querySelectorAll('.btn')].map((b) => b.textContent.trim()) : null; })()`, 8000);
    check(!!sp && sp.indexOf('Sign in to YouTube') !== -1, 'the Subscriptions page, signed out: a Sign in panel', sp);
    await blur();
    try { await g.shot(path.join(SHOTS, `${PREFIX}-signedout-page-1280x800.png`)); } catch (e) { say('shot failed: ' + e.message); }
    await click(btnIn(`document.querySelector('#ytp .yt-panel.st-signed-out')`, '/^Sign in to YouTube$/'));
    const sl2 = await chrome.waitFor(`(() => { const s = ${PST}; return s.open && s.slots[0] && s.slots[0].url ? s : null; })()`, 15000).catch(() => null);
    check(!!sl2 && sl2.slots[0].url.indexOf(srv.auth.origin + '/ServiceLogin') === 0, 'the page\'s Sign in opens in the layer too', sl2 && sl2.slots[0].url);
    await closeLayer();
    await keyIn(g, 'Escape', 'Escape', 27);

    /* ============================ nothing left the machine ============================ */
    check(g.fetched.drawn > 10 && g.fetched.refused.length === 0, `every https request of the Lumen page was a picture, filled locally (${g.fetched.drawn}); nothing else asked`, g.fetched.refused.slice(0, 6));
    check(g.errors.length === 0, 'no exception on the Lumen page', g.errors.slice(0, 4));
    g.close();
    await q.quit();
  } finally {
    srv.close();
    try { await mock.close(); } catch (e) { /* gone */ }
  }
});
