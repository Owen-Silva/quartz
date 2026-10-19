try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine: no cap needed */ }
// watch-rowkeys-e2e.js -- the arrow keys walk Lumen's home rows, the YouTube Subscriptions row
// included, with REAL key input (CDP Input.dispatchKeyEvent into the Lumen page; no synthetic DOM
// events). The user (10-18): ArrowDown stopped at the Subscriptions row; only the lens's Next button
// went on. A REAL hidden Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen), the
// same local fronts as watch-ytlib-e2e.js (tests/watch-fixtures/youtube-*.json + tests/watch-mock.js);
// every https request of the page is answered locally (pictures) or refused and counted.
//
//   node watch-rowkeys-e2e.js [--cdp 9562]
//
// Checks: with nothing focused, ArrowDown steps the lens one row per press from the first row to the
// last (through Subscriptions) and ArrowUp back to the first; with a tile focused the same, and the
// focus follows into each row; on the Subscriptions row ArrowRight / ArrowLeft move between its tiles
// and ArrowUp / ArrowDown leave it; with the pointer resting on a Subscriptions tile (its hover
// preview running) the keys still step; after a trip into the YouTube pages (See all, then Esc) the
// keys still step. One summary line: "watch-rowkeys-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');
const L = require('./watch/ytlib');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9562'));
const FIX = path.join(__dirname, 'tests', 'watch-fixtures');
const fx = (name) => JSON.parse(fs.readFileSync(path.join(FIX, 'youtube-' + name + '.json'), 'utf8'));
const SUBS = 'r:yt-subs';

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
function sendHtml(res, body) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); }
function ytPage(f, label) {
  const data = f && f.ytInitialData ? 'window.ytInitialData=' + inScript(f.ytInitialData) + ';' : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>YouTube</title><script>var ytcfg={data_:{LOGGED_IN:' +
    (!f || f.loggedIn === true) + '},get:function(k){return this.data_[k];}};' + data + '</script></head><body><div id="content">front YouTube (' + label + ')</div></body></html>';
}
async function startServers(mock) {
  const auth = await listen((req, res) => sendHtml(res, '<!doctype html><title>Sign in</title><body>local sign-in stand-in</body>'));
  const front = await listen((req, res) => {
    const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
    if (u.pathname === '/feed/subscriptions') return sendHtml(res, ytPage(fx('subs-next'), 'subs-next'));
    if (u.pathname === '/feed/playlists') return sendHtml(res, ytPage(fx('playlists'), 'playlists'));
    if (u.pathname === '/playlist' && u.searchParams.get('list') === 'LL') return sendHtml(res, ytPage(fx('liked'), 'liked'));
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
  return { rebase, close: () => { auth.server.close(); front.server.close(); } };
}
function seed(profileDir) {
  const f = fx('subs-next');
  const u = L.SUBS_URL;
  const feed = L.parseSubs({ steps: { subs: { ok: true, url: u, finalUrl: u, status: 200, extracted: { url: u, data: f.ytInitialData, loggedIn: f.loggedIn }, error: null } } });
  const t = Date.now();
  const seen = {};
  feed.items.forEach((it, i) => { if (i >= 2) seen[it.vid] = t - 3 * 86400e3; });
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'watch-ytlib.json'), JSON.stringify({ v: 1, mark: { seen, played: {}, baseline: true, cutoff: t - 2 * 86400e3, lastOffAt: t - 3600e3 } }));
}
function still() { return '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="100%" height="100%" fill="#3a3f46"/></svg>'; }
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
      if (m.params.resourceType === 'Image') {
        g.fetched.drawn++;
        g.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/svg+xml' }], body: Buffer.from(still()).toString('base64') });
      } else {
        g.fetched.refused.push(m.params.resourceType + ' ' + m.params.request.url.slice(0, 120));
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
const KEYS = { ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37, Escape: 27 };
/** One REAL key press into the page (the renderer's input path, as a keyboard's). */
async function press(c, key) {
  const vk = KEYS[key];
  const base = { key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 };
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}

// Where the lens is and where the focus is; the last key as the page saw it (first and last listener).
const LENS = `(() => { const rows = [...document.querySelectorAll('#stack section.lrow')]; const i = rows.findIndex((r) => r.dataset.d === '0');
  const a = document.activeElement; const card = a && a.closest ? a.closest('.card, .gc') : null; const ar = card ? card.closest('.lrow') : null;
  const k = window.__rk || {};
  return { i, n: rows.length, key: i >= 0 ? rows[i].dataset.key : '', keys: rows.map((r) => r.dataset.key), lpos: (document.getElementById('lpos') || {}).textContent || '',
    active: a ? (a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + (a.className && typeof a.className === 'string' ? '.' + a.className.trim().split(/\\s+/).slice(0, 3).join('.') : '')) : 'none',
    activeRow: ar ? ar.dataset.key : '', cardIdx: card && ar ? [...ar.querySelectorAll('.rt > .card, .rt > .gw > .gc')].indexOf(card) : -1,
    last: k.last || null, ytOpen: !!(window.WatchYt && window.WatchYt._state && window.WatchYt._state().views.length) }; })()`;
const SPY = `(() => { if (window.__rk) return 1; window.__rk = {};
  window.addEventListener('keydown', (e) => { window.__rk.cur = { key: e.key, target: e.target && e.target.tagName, trusted: e.isTrusted }; }, true);
  window.addEventListener('keydown', (e) => { const c = window.__rk.cur || {}; c.prevented = e.defaultPrevented; c.reachedWindowBubble = true; window.__rk.last = c; }, false);
  return 1; })()`;

run('watch-rowkeys-e2e', async ({ check, launch, say, profileDir }) => {
  seed(profileDir);
  const mock = await Mock.start({ log: () => {} });
  const srv = await startServers(mock);
  const env = {
    QUARTZ_WATCH_BOOT_GRACE_MS: '0',
    QUARTZ_WATCH_REBASE: JSON.stringify(srv.rebase),
    QUARTZ_EDGE_STUB: path.join(require('os').tmpdir(), 'quartz-rowkeys-e2e-' + process.pid + '-edge.txt'),
    QUARTZ_WATCH_MIN_FREE_GB: '0',
    QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1',
  };
  try {
    const q = await launch({ cdp: CDP_PORT, env });
    const chrome = q.chrome;
    await chrome.ev('openWatchTab(), 1');
    const g = await guest(q);
    const wait = (expr, ms) => g.waitFor(expr, ms || 20000).catch(() => null);
    await chrome.ev('(() => { const v = findWatchTab().viewEl; const s = v.style; s.setProperty("position", "fixed", "important"); s.setProperty("left", "0px", "important"); s.setProperty("top", "0px", "important"); s.setProperty("width", "1280px", "important"); s.setProperty("height", "800px", "important"); s.setProperty("z-index", "2147483647", "important"); return 1; })()');
    await g.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    // the page takes real keys only when it has the focus: the Lumen view focused, as a click on it does
    await chrome.ev('(() => { const v = findWatchTab().viewEl; v.focus(); return document.activeElement === v; })()');

    const s0 = await wait(`(() => { const s = WatchYt._state().subs; return s && s.state === 'ok' && !s.refreshing && document.querySelector('#stack section.lrow[data-key="${SUBS}"]') ? s.n : null; })()`, 120000);
    check(!!s0, 'the Subscriptions row is on the page (' + s0 + ' videos)');
    const nRows = await wait(`document.querySelectorAll('#stack section.lrow').length >= 5 ? document.querySelectorAll('#stack section.lrow').length : null`, 60000);
    // the rest of the reads land (rows arrive above and below) before the walk: the same rows for 3 s
    let lastKeys = '', same = 0;
    for (let k = 0; k < 90 && same < 6; k++) { await sleep(500); const ks = await g.ev(`[...document.querySelectorAll('#stack section.lrow')].map((r) => r.dataset.key).join(',')`); same = ks === lastKeys ? same + 1 : 0; lastKeys = ks; }
    check(same >= 6, 'the rows settle before the walk (the same ' + lastKeys.split(',').length + ' rows for 3 s)');
    await g.ev(SPY);
    let st = await g.ev(LENS);
    say('rows: ' + st.keys.join(', '));
    let subsAt = st.keys.indexOf(SUBS);
    check(nRows >= 5 && subsAt >= 0 && subsAt < st.n - 1, 'at least 5 rows, Subscriptions not the last (' + st.n + ' rows; Subscriptions is row ' + (subsAt + 1) + ')', st.keys);
    const blur = () => g.ev('(() => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); return document.activeElement === document.body; })()');
    const step = async (key, ms) => { await press(g, key); await sleep(ms || 750); return g.ev(LENS); };

    /** Walk the lens with `key` until the end; every press must move it exactly one row. */
    async function walk(label, key, wantFocus) {
      const dir = key === 'ArrowDown' ? 1 : -1;
      let s = await g.ev(LENS);
      const bad = [], path0 = [s.key];
      const end = dir > 0 ? s.n - 1 : 0;
      let guard = 0;
      while (s.i !== end && guard++ < 40) {
        const t = await step(key);
        path0.push(t.key);
        if (t.i !== s.i + dir) bad.push({ from: s.key, to: t.key, lpos: t.lpos, active: t.active, last: t.last, ytOpen: t.ytOpen });
        else if (wantFocus && t.activeRow !== t.key) bad.push({ from: s.key, to: t.key, focusLeftIn: t.activeRow, active: t.active });
        if (t.i === s.i) { s = t; break; }    // stuck: say where, do not loop
        s = t;
      }
      const passedSubs = path0.indexOf(SUBS) !== -1;
      check(!bad.length && s.i === end && passedSubs, label + ': ' + key + ' steps one row per press, ' + (dir > 0 ? 'first to last' : 'last to first') + ', through Subscriptions' + (wantFocus ? ', the focus following' : ''),
        bad.length ? bad.slice(0, 3) : { path: path0.length + ' rows', end: s.key });
      return s;
    }

    /* ---- 1. nothing focused (the page's body) ---- */
    await blur();
    for (let k = 0; k < 20 && (await g.ev(LENS)).i > 0; k++) await step('ArrowUp', 400);
    await blur();
    await walk('nothing focused', 'ArrowDown', false);
    await blur();
    await walk('nothing focused', 'ArrowUp', false);

    /* ---- 2. a tile focused (ArrowRight from the body puts the focus on the lens's tile) ---- */
    st = await step('ArrowRight');
    check(st.activeRow === st.key && st.cardIdx >= 0, 'ArrowRight from nothing focused puts the focus on a tile in the lens row', { active: st.active, row: st.activeRow, lens: st.key });
    await walk('a tile focused', 'ArrowDown', true);
    await walk('a tile focused', 'ArrowUp', true);

    /* ---- 3. on the Subscriptions row: all four arrows ---- */
    st = await g.ev(LENS);
    subsAt = st.keys.indexOf(SUBS);
    for (let k = 0; k < 20 && st.i < subsAt; k++) st = await step('ArrowDown');
    check(st.key === SUBS && st.activeRow === SUBS, 'ArrowDown reaches the Subscriptions row with a tile focused', { lens: st.key, focus: st.activeRow, active: st.active });
    const c0 = st.cardIdx;
    const r1 = await step('ArrowRight', 500);
    check(r1.key === SUBS && r1.activeRow === SUBS && r1.cardIdx === c0 + 1, 'Subscriptions row: ArrowRight moves to the next tile in the row', { from: c0, to: r1.cardIdx, row: r1.activeRow });
    const r2 = await step('ArrowLeft', 500);
    check(r2.key === SUBS && r2.cardIdx === c0, 'Subscriptions row: ArrowLeft moves back', { to: r2.cardIdx, row: r2.activeRow });
    const r3 = await step('ArrowDown');
    check(r3.i === subsAt + 1 && r3.activeRow === r3.key, 'Subscriptions row: ArrowDown leaves it for the next row', { lens: r3.key, focus: r3.activeRow, last: r3.last });
    const r4 = await step('ArrowUp');
    check(r4.key === SUBS && r4.activeRow === SUBS, 'the next row: ArrowUp comes back to Subscriptions', { lens: r4.key, focus: r4.activeRow });
    if (subsAt > 0) {
      const r5 = await step('ArrowUp');
      check(r5.i === subsAt - 1, 'Subscriptions row: ArrowUp leaves it for the row above', { lens: r5.key, last: r5.last });
      await step('ArrowDown');
    }

    /* ---- 4. the pointer resting on a Subscriptions tile (its hover preview) ---- */
    const pt = await g.ev(`(() => { const r = document.querySelector('#stack section.lrow[data-key="${SUBS}"]'); const c = r && [...r.querySelectorAll('.rt > .card')].find((x) => { const b = x.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight; });
      if (!c) return null; const b = c.querySelector('.art').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    if (pt) {
      await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
      await sleep(2200);
      const pv = await g.ev('(() => { const s = window.WatchTilePreview && window.WatchTilePreview._state ? window.WatchTilePreview._state() : null; return { frames: document.querySelectorAll("#stack iframe").length, s: s && { tile: !!s.tile, phase: s.phase } }; })()').catch((e) => e.message);
      say('pointer on a Subscriptions tile: ' + JSON.stringify(pv) + '; focus ' + (await g.ev(LENS)).active);
      const h1 = await step('ArrowDown');
      check(h1.i === subsAt + 1, 'the pointer resting on a Subscriptions tile: ArrowDown still leaves the row', { lens: h1.key, active: h1.active, last: h1.last });
      const h2 = await step('ArrowUp');
      check(h2.key === SUBS, 'the pointer resting there: ArrowUp comes back', { lens: h2.key, active: h2.active, last: h2.last });
      await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 790 });
    } else check(false, 'a Subscriptions tile fully in view for the pointer');

    /* ---- 5. after the YouTube pages (See all, then Esc back to the rows) ---- */
    await g.ev(`window.WatchYt.open({ kind: 'subs' }), 1`);
    const op = await wait(`WatchYt._state().views.length > 0 ? 1 : null`, 8000);
    await sleep(600);
    await press(g, 'Escape');
    const shut = await wait(`WatchYt._state().views.length === 0 ? 1 : null`, 8000);
    check(!!op && !!shut, 'the Subscriptions page opens and Esc closes it', { op, shut });
    await sleep(700);
    await blur();
    for (let k = 0; k < 20 && (await g.ev(LENS)).i > 0; k++) await step('ArrowUp', 400);
    await walk('after the YouTube page', 'ArrowDown', false);

    /* ---- 6. a click on the row's own controls leaves the focus on them (The user's stuck row) ---- */
    const toSubs = async () => { let s = await g.ev(LENS); const at = s.keys.indexOf(SUBS); for (let k = 0; k < 20 && s.i !== at; k++) s = await step(s.i < at ? 'ArrowDown' : 'ArrowUp', 500); return s; };
    const click = async (p) => {
      await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await sleep(250);
      await g.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
      await g.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
    };
    const ctlAt = (sel, text) => g.ev(`(() => { const r = document.querySelector('#stack section.lrow[data-key="${SUBS}"]'); const b = r && [...r.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${JSON.stringify(text || '')} === '' || x.textContent.trim() === ${JSON.stringify(text || '')});
      if (!b) return null; const q = b.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2), vis: getComputedStyle(b).visibility, w: Math.round(q.width) }; })()`);
    const focusIs = (what) => g.ev(`(() => { const a = document.activeElement; return !!a && a.tagName === 'BUTTON' && !!a.closest('section.lrow[data-key="${SUBS}"]') && ${what}; })()`);
    await blur();
    st = await toSubs();
    subsAt = st.keys.indexOf(SUBS);
    // See all (a REAL click), its page, Esc: the focus is back on See all, and the arrows still step
    const sa = await ctlAt('.yt-hacts button', 'See all');
    if (sa) {
      await click(sa);
      const o2 = await wait(`WatchYt._state().views.length > 0 ? 1 : null`, 8000);
      await sleep(600);
      await press(g, 'Escape');
      const s2 = await wait(`WatchYt._state().views.length === 0 ? 1 : null`, 8000);
      await sleep(500);
      const onSa = await focusIs("a.textContent.trim() === 'See all'");
      check(!!o2 && !!s2 && onSa, 'a click on the Subscriptions See all opens its page; Esc closes it and gives the focus back to See all', { o2, s2, onSa, active: (await g.ev(LENS)).active });
      const d1 = await step('ArrowDown');
      check(d1.i === subsAt + 1 && d1.activeRow === d1.key, 'the focus on See all: ArrowDown leaves the Subscriptions row, the focus into the next row tile', { lens: d1.key, focus: d1.activeRow, active: d1.active, last: d1.last });
      const d2 = await step('ArrowDown');
      check(d2.i === subsAt + 2, 'and ArrowDown goes on from there', { lens: d2.key, active: d2.active });
      await step('ArrowUp'); const d3 = await step('ArrowUp');
      check(d3.key === SUBS && d3.activeRow === SUBS, 'ArrowUp comes back to Subscriptions', { lens: d3.key, focus: d3.activeRow });
      // the same from See all with ArrowUp
      await click(sa);
      await wait(`WatchYt._state().views.length > 0 ? 1 : null`, 8000); await sleep(500);
      await press(g, 'Escape'); await wait(`WatchYt._state().views.length === 0 ? 1 : null`, 8000); await sleep(500);
      const u1 = await step('ArrowUp');
      check(u1.i === subsAt - 1, 'the focus on See all: ArrowUp leaves the Subscriptions row for the one above', { lens: u1.key, active: u1.active, last: u1.last });
      await step('ArrowDown');
    } else check(false, 'the Subscriptions row has a See all button');
    // the row's own scroll arrow (Next), a REAL click: the arrows still step
    await blur();
    st = await toSubs();
    const art = await g.ev(`(() => { const c = document.querySelector('#stack section.lrow[data-key="${SUBS}"] .rt > .card .art'); if (!c) return null; const q = c.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) }; })()`);
    if (art) { await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: art.x, y: art.y }); await sleep(400); }
    const nx = await ctlAt('.row-nav.next button', '');
    if (nx && nx.vis !== 'hidden' && nx.w > 0) {
      await click(nx);
      await sleep(700);
      const onNx = await focusIs("!!a.closest('.row-nav')");
      const n1 = await step('ArrowDown');
      check(n1.i === subsAt + 1, 'after a click on the Subscriptions row Next arrow' + (onNx ? ' (the focus on it)' : ' (the focus NOT on it: ' + n1.active + ')') + ': ArrowDown leaves the row', { lens: n1.key, active: n1.active, last: n1.last });
      const n2 = await step('ArrowUp');
      check(n2.key === SUBS, 'and ArrowUp comes back', { lens: n2.key, active: n2.active });
      await click(nx); await sleep(700);
      const n3 = await step('ArrowUp');
      check(n3.i === subsAt - 1, 'after a click on the Next arrow: ArrowUp leaves the row for the one above', { lens: n3.key, active: n3.active });
    } else check(false, 'the Subscriptions row Next arrow is on screen for the pointer', nx);
    await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 790 });

    check(g.fetched.refused.length === 0, 'every https request of the Lumen page was a picture, filled locally (' + g.fetched.drawn + '); nothing else asked', g.fetched.refused.slice(0, 6));
    check(g.errors.length === 0, 'no exception on the Lumen page', g.errors.slice(0, 4));
    g.close();
    await q.quit();
  } finally {
    srv.close();
    try { await mock.close(); } catch (e) { /* gone */ }
  }
});
