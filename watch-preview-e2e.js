try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine: no cap needed */ }
// watch-preview-e2e.js -- the stage's hover preview, end to end, against a MOCK player and a MOCK TMDB:
// a REAL hidden Quartz test instance (e2e-kit: --test-profile, off-screen, watched by testwatch.js) with
// QUARTZ_WATCH_PREVIEW_MOCK=1, so the page's frame loads watch/preview.js MOCK_ORIGIN
// (https://quartz-preview.invalid, which no network resolves). This file answers that frame through CDP
// Fetch with a small fake player that speaks YouTube's postMessage protocol, and answers TMDB from a local
// server (QUARTZ_WATCH_REBASE). Any request to a real YouTube embed is failed and counted. Every picture
// is answered here too. Never a real account, key, profile or video.
//
//   node watch-preview-e2e.js [--cdp 9275] [--tmdb-port 9276] [--shots <dir>] [--prefix lumen-followup]
//
// Checks: resting the pointer on the stage for 600 ms mounts ONE frame at the mock origin, muted, that
// fades in once the player says it plays; leaving removes the frame at once; fast row steps make no
// frame at all, resting on the stage's tile makes one, the next step removes it; reduced motion: no
// frame, a note says why; no TMDB key: a note says how (no TMDB request); no trailer on TMDB: a note;
// a TMDB trailer plays from the mock; a player error: a note, the frame gone; no real embed request;
// no console errors. One line: "watch-preview-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');
const F = require('./tests/watch-snapshot');
const Pv = require('./watch/preview');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9275'));
const TMDB_PORT = Number(opt('tmdb-port', '9276'));
const SHOTS = opt('shots', '');
const PREFIX = opt('prefix', 'lumen-followup');
const TAG = 'quartz-watch-preview-' + process.pid;
const STUB = (n) => path.join(os.tmpdir(), TAG + '-' + n);
const TRAILER_ID = 'MOCKtrailr1';
const FAKE_KEY = '0123456789abcdef0123456789abcdef';   // a made-up v3-shaped key: only the mock ever sees it

/* ---- a real raster (24-bit BMP) of w x h in one colour, for every picture request ---- */
const bmps = new Map();
function bmp(w, h, rgb) {
  const k = w + 'x' + h + ':' + rgb.join(',');
  if (bmps.has(k)) return bmps.get(k);
  const row = Math.ceil(w * 3 / 4) * 4;
  const b = Buffer.alloc(54 + row * h);
  b.write('BM', 0); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = 54 + y * row + x * 3; b[o] = rgb[2]; b[o + 1] = rgb[1]; b[o + 2] = rgb[0]; }
  bmps.set(k, b);
  return b;
}

/* ---- the fake YouTube player: a moving picture, and YouTube's widget messages ---- */
const ERR_IDS = new Set();   // video ids the fake player answers with onError 150
function playerHtml(id) {
  const err = ERR_IDS.has(id);
  return '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:#123}' +
    '#v{position:absolute;inset:0;background:linear-gradient(115deg,#0c3b5e,#5b2a86 45%,#c2410c);}' +
    '#b{position:absolute;left:0;top:0;bottom:0;width:18%;background:rgba(255,255,255,.18);animation:s 2.4s linear infinite}' +
    '@keyframes s{from{transform:translateX(-100%)}to{transform:translateX(560%)}}' +
    '#t{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font:600 44px/1.2 Segoe UI,sans-serif;color:#fff;text-align:center;letter-spacing:.04em}' +
    '#t small{display:block;font-size:20px;font-weight:400;opacity:.8}</style></head><body><div id="v"></div><div id="b"></div>' +
    '<div id="t">MOCK PREVIEW<small>test player (' + id + '), not YouTube</small></div><script>' +
    'var ERR=' + (err ? 'true' : 'false') + ';function post(o){parent.postMessage(JSON.stringify(o),"*");}post({event:"mockLoaded"});' +
    'window.addEventListener("message",function(e){var d;try{d=JSON.parse(e.data);}catch(x){return;}' +
    'if(!d||d.event!=="listening")return;if(ERR){post({event:"onError",info:150});return;}' +
    'post({event:"initialDelivery",info:{playerState:-1}});setTimeout(function(){post({event:"onStateChange",info:1});},150);});' +
    '</script></body></html>';
}

/* ---- TMDB, local: /search/multi finds the title; /videos has a YouTube trailer, or none ---- */
const NO_TRAILER = new Set();   // titles (lowercase) TMDB lists no trailer for
const tmdbLog = [];
function tmdbServer() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    tmdbLog.push(u.pathname);
    let body = { results: [] };
    if (/\/3\/search\/multi$/.test(u.pathname)) {
      const q = String(u.searchParams.get('query') || '');
      const id = NO_TRAILER.has(q.toLowerCase()) ? 2002 : 2001;
      body = { page: 1, results: [{ id, media_type: 'movie', title: q, release_date: '2020-01-01', popularity: 50 }, { id: id + 10, media_type: 'tv', name: q, first_air_date: '2020-01-01', popularity: 40 }] };
    } else if (/\/3\/(movie|tv)\/(\d+)\/videos$/.test(u.pathname)) {
      const id = Number(/\/(\d+)\/videos$/.exec(u.pathname)[1]);
      body = { id, results: id === 2002 || id === 2012 ? [] : [{ site: 'YouTube', key: TRAILER_ID, type: 'Trailer', official: true, name: 'Official Trailer', iso_639_1: 'en' }] };
    }
    const s = JSON.stringify(body);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
  });
  return new Promise((r) => srv.listen(TMDB_PORT, '127.0.0.1', () => r(srv)));
}

async function guest(q, errors, net) {
  let t = null;
  for (let i = 0; i < 250 && !t; i++) {
    try { t = (await q.targets()).find((x) => /\/watch\.html(\?|#|$)/.test(String(x.url)) && x.webSocketDebuggerUrl); } catch (e) { t = null; }
    if (!t) await sleep(60);
  }
  if (!t) throw new Error('the Watch page never appeared as a CDP target');
  const g = await new Cdp(t.webSocketDebuggerUrl).open();
  g.ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).slice(0, 300));
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + (m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ').slice(0, 300));
    else if (m.method === 'Fetch.requestPaused') {
      const p = m.params;
      const u = String(p.request.url);
      const rid = p.requestId;
      if (u.indexOf(Pv.MOCK_ORIGIN + '/') === 0) {
        const id = (/\/embed\/([A-Za-z0-9_-]{11})/.exec(u) || [])[1] || '';
        net.mock.push({ u, type: p.resourceType, at: Date.now() });
        const body = Buffer.from(playerHtml(id));
        g.send('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: body.toString('base64') });
      } else if (/youtube-nocookie\.com|youtube\.com\/embed/.test(u)) {
        net.real.push(u);   // a real embed: never let it out
        g.send('Fetch.failRequest', { requestId: rid, errorReason: 'BlockedByClient' });
      } else if (p.resourceType === 'Image') {
        const big = /maxresdefault/.test(u);
        const body = big ? bmp(1280, 720, [40, 110, 170]) : bmp(640, 360, [70, 80, 100]);
        g.send('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/bmp' }], body: body.toString('base64') });
      } else {
        g.send('Fetch.continueRequest', { requestId: rid });
      }
    }
  });
  await g.send('Runtime.enable');
  await g.send('Fetch.enable', { patterns: [
    { urlPattern: Pv.MOCK_ORIGIN + '/*', requestStage: 'Request' },
    { urlPattern: '*youtube-nocookie.com*', requestStage: 'Request' },
    { urlPattern: '*youtube.com/embed*', requestStage: 'Request' },
    { urlPattern: '*', resourceType: 'Image', requestStage: 'Request' },
  ] });
  await g.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return g;
}

/* In the page: when the pointer came over the stage, when a .pv frame was added / shown / removed. */
const WATCHER = `(() => {
  const st = document.getElementById('stage');
  const pv = window.__pv = { over: 0, adds: 0, addAt: 0, onAt: 0, remAt: 0, opacityAtAdd: '' };
  st.addEventListener('pointerover', () => { if (pv.over) return; pv.over = performance.now(); setTimeout(() => { pv.at400 = document.querySelectorAll('#stage iframe').length; }, 400); }, true);
  window.__pvMsgs = [];
  window.addEventListener('message', (e) => { if (window.__pvMsgs.length < 30) window.__pvMsgs.push(Math.round(performance.now()) + ' ' + e.origin + ' ' + String(e.data).slice(0, 60)); });
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches('.pv') || n.querySelector('.pv'))) { pv.adds++; pv.addAt = performance.now(); const e = n.matches('.pv') ? n : n.querySelector('.pv'); pv.opacityAtAdd = getComputedStyle(e).opacity; }
        for (const n of m.removedNodes) if (n.nodeType === 1 && (n.matches('.pv') || n.querySelector('.pv'))) pv.remAt = performance.now();
      } else if (m.target.classList && m.target.classList.contains('pv') && m.target.classList.contains('on') && !pv.onAt) pv.onAt = performance.now();
    }
  }).observe(st, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  return 1;
})()`;
const RESET = '(() => { Object.assign(window.__pv, { over: 0, at400: -1, adds: 0, addAt: 0, onAt: 0, remAt: 0, opacityAtAdd: "" }); window.__pvMsgs.length = 0; return 1; })()';
const STATE = `(() => {
  const f = document.querySelectorAll('#stage iframe');
  const w = document.querySelector('#stage .pv');
  const n = document.querySelector('#stage .pvnote');
  return { frames: f.length, src: f[0] ? f[0].src : '', on: !!(w && w.classList.contains('on')), opacity: w ? getComputedStyle(w).opacity : '',
    note: n ? n.textContent : '', tone: n ? n.className : '', now: performance.now(), pv: Object.assign({}, window.__pv),
    stage: (document.querySelector('#stage h1, #stage .title') || {}).textContent || '', msgs: (window.__pvMsgs || []).slice(-8) };
})()`;
/* Focus the card for `pick` (a function body over c._item), after a blur; null when none. */
const FOCUS = (pick) => `(() => {
  const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur();
  const c = [...document.querySelectorAll('#stack .card')].find((c) => c._item && (${pick})(c._item));
  if (!c) return null;
  c.focus();
  return { title: c._item.title, service: c._item.service, url: c._item.url };
})()`;

if (require.main === module) {
  run('watch-preview', async (k) => {
    const { launch, say, check } = k;
    const dog = setTimeout(() => { console.log('FAIL HARNESS TIMEOUT: watch-preview-e2e did not finish in 6 min'); process.exit(1); }, 6 * 60 * 1000);
    dog.unref();
    const mock = await Mock.start({ log: () => {} });
    const tmdb = await tmdbServer();
    const rebase = [['https://api.themoviedb.org', 'http://127.0.0.1:' + TMDB_PORT]].concat(mock.rebase);
    const env = { QUARTZ_WATCH_BOOT_GRACE_MS: '0', QUARTZ_WATCH_REBASE: JSON.stringify(rebase), QUARTZ_WATCH_OPEN_STUB: STUB('open.txt'), QUARTZ_EDGE_STUB: STUB('edge.txt'),
      QUARTZ_WATCH_MIN_FREE_GB: '0', QUARTZ_WATCH_GAME_FILE: STUB('game.flag'), QUARTZ_WATCH_PREVIEW_MOCK: '1', QUARTZ_TEST_MIN_FREE_GB: process.env.QUARTZ_TEST_MIN_FREE_GB || '1.5' };
    const errors = [];
    const net = { mock: [], real: [] };
    const q = await launch({ cdp: CDP_PORT, env });
    const chrome = q.chrome;
    try {
      await chrome.ev('(() => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); return 1; })()');
      const W = { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, modifiers: 3 };
      await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, W));
      await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, W));
      const g = await guest(q, errors, net);
      // the tab's view grown to 1920x1000 (as watch-design-e2e does), so the page's surface is that big
      // and a shot is the page, not a tiling of a smaller view
      await chrome.ev('(() => { const w = findWatchTab(); const v = w && w.viewEl; if (!v) return 0; const s = v.style; s.setProperty("position", "fixed", "important"); s.setProperty("left", "0px", "important"); s.setProperty("top", "0px", "important"); s.setProperty("width", "1920px", "important"); s.setProperty("height", "1000px", "important"); s.setProperty("z-index", "2147483647", "important"); return 1; })()').catch(() => 0);
      await sleep(500);
      await g.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1000, deviceScaleFactor: 1, mobile: false });
      await g.waitFor('document.querySelectorAll("#stack .lrow .rt > .card").length > 3 || null', 120000).catch(() => 0);
      await g.waitFor('(() => { const p = document.querySelectorAll("#pills .sp.st-busy"); return p.length === 0 || null; })()', 90000).catch(() => 0);
      await g.ev(WATCHER);

      // main's own snapshot (the mock read) told the page "on, mock"; from here the page draws dense()
      const snap = F.dense(Date.now());
      snap.tmdb = { hasKey: true };
      const yts = snap.items.filter((it) => it.service === 'youtube');
      const ytIds = yts.map((it) => (/v=([A-Za-z0-9_-]{11})/.exec(it.url) || [])[1]).filter(Boolean);
      const prime = snap.items.find((it) => it.service === 'prime' && it.kind !== 'live' && it.title);
      const disney = snap.items.find((it) => it.service === 'disney' && it.kind !== 'live' && it.title && (!prime || it.title !== prime.title));
      if (prime) NO_TRAILER.add(prime.title.trim().toLowerCase());
      const apply = (s) => g.ev('(() => { if (!window.__pvApply) { window.__pvApply = window.__applyWatch; window.__applyWatch = function () {}; } window.__pvApply(' + JSON.stringify(s) + '); return 1; })()');
      await apply(snap);
      await sleep(1200);
      // the stage (and so its preview) shows only at the top: every tile used below is in the FIRST row
      // (a lower row's tile turns the top slim, the stage goes, and correctly no preview starts)
      const row0 = await g.ev(`[...((document.querySelectorAll('#stack .lrow')[0] || document).querySelectorAll('.card'))].filter((c) => c._item)
        .map((c) => ({ title: c._item.title, service: c._item.service, kind: c._item.kind || '', id: (/[?&]v=([A-Za-z0-9_-]{11})/.exec(c._item.url || '') || [])[1] || '' }))`);
      const row0Yt = row0.filter((c) => c.service === 'youtube' && c.id);
      const errId = row0Yt.length > 1 ? row0Yt[row0Yt.length - 1].id : '';
      if (errId) ERR_IDS.add(errId);
      say(yts.length + ' YouTube items; first row ' + row0.length + ' tiles (' + row0Yt.length + ' YouTube); prime "' + (prime && prime.title) + '" (no trailer), disney "' + (disney && disney.title) + '" (trailer), error id ' + (errId || 'none in the first row'));
      const okYt = `(it) => it.service === 'youtube' && it.url.indexOf(${JSON.stringify(errId || '#none#')}) === -1`;

      // 1. the stage, by pointer: put a YouTube video on the stage, then rest the pointer on its still
      const f1 = await g.ev(FOCUS(okYt));
      await sleep(250);
      await g.ev('(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return 1; })()');
      await sleep(900);
      const s0 = await g.ev(STATE);
      check(s0.frames === 0, 'focus moved off the tile: no frame (' + (f1 && f1.title) + ')', s0);
      const hit = await g.ev('(() => { const h = document.querySelector("#stage .pic .pvhit"); if (!h) return null; const r = h.getBoundingClientRect(); return { x: Math.round(r.left + r.width * 0.6), y: Math.round(r.top + r.height * 0.45), w: Math.round(r.width), h: Math.round(r.height) }; })()');
      check(!!hit && hit.w > 100 && hit.h > 100, 'the stage has its hover target over the still', hit);
      await g.ev(RESET);
      await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 6, y: 40 });
      await sleep(100);
      await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit ? hit.x : 1400, y: hit ? hit.y : 300 });
      await sleep(400);
      await g.waitFor('(() => { const w = document.querySelector("#stage .pv.on"); return w && getComputedStyle(w).opacity === "1" || null; })()', 6000).catch(() => 0);
      const s2 = await g.ev(STATE);
      const delay = s2.pv.addAt && s2.pv.over ? Math.round(s2.pv.addAt - s2.pv.over) : -1;
      check(s2.pv.at400 === 0, 'hover: no frame yet 400 ms after the pointer came to rest (timed in the page)', s2.pv);
      check(s2.frames === 1 && s2.src.indexOf(Pv.MOCK_ORIGIN + '/embed/') === 0 && /[?&]mute=1(&|$)/.test(s2.src) && /[?&]autoplay=1(&|$)/.test(s2.src), 'hover: one muted frame, from the mock origin only', { frames: s2.frames, src: s2.src.slice(0, 90) });
      check(delay >= 590 && delay < 1500, 'hover: the frame is made ' + delay + ' ms after the pointer came to rest (>= 600)', s2.pv);
      check(s2.pv.opacityAtAdd === '0' && s2.on && s2.opacity === '1' && s2.pv.onAt > s2.pv.addAt && s2.pv.onAt - s2.pv.addAt < 2300, 'hover: it fades in (opacity 0 -> 1) once the player says it plays, not by the 2.5 s fallback (' + Math.round(s2.pv.onAt - s2.pv.addAt) + ' ms after the frame)', { pv: s2.pv, msgs: s2.msgs });
      check(!s2.note, 'hover: no note while it plays', s2.note);
      if (SHOTS) {
        try { fs.mkdirSync(SHOTS, { recursive: true }); } catch (e) { /* there */ }
        await sleep(400);
        const r = await g.shot(path.join(SHOTS, PREFIX + '-preview-1920.png'));
        say('shot ' + PREFIX + '-preview-1920.png ' + JSON.stringify(r).slice(0, 80));
      }

      // 2. leaving the stage removes the frame at once
      await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 6, y: 40 });
      const tLeave = await g.ev('performance.now()');
      await sleep(250);
      const s3 = await g.ev(STATE);
      check(s3.frames === 0 && s3.opacity === '', 'leave: the frame is removed (' + (s3.pv.remAt ? Math.round(s3.pv.remAt - tLeave) + ' ms' : 'never') + ')', s3);
      check(s3.pv.remAt > 0 && s3.pv.remAt - tLeave < 150, 'leave: removed within 150 ms of the pointer leaving', s3.pv);

      // 3. row steps: fast steps make no frame; resting on the stage's tile makes one; the next step removes it
      await g.ev(RESET);
      const steps = await g.ev(`(async () => {
        const first = document.querySelectorAll('#stack .lrow')[0];
        const all = first ? [...first.querySelectorAll('.card')].filter((c) => c._item) : [];
        const noTrailer = ${JSON.stringify(prime ? prime.title : '#none#')};
        const plays = (it) => (${okYt})(it) || (/^(prime|disney|hulu)$/.test(it.service) && !/^(live|upcoming)$/.test(it.kind || '') && it.title !== noTrailer);
        const rest = all.slice(1).find((c) => (${okYt})(c._item)) || all.slice(1).find((c) => plays(c._item));   // YouTube first: no TMDB key is saved yet
        if (all.length < 4 || !rest) return { few: all.length, rest: !!rest };
        const others = all.filter((c) => c !== rest);
        const out = { n: 0, framesDuring: 0, rest: rest._item.service + ': ' + rest._item.title };
        for (let i = 0; i < Math.min(6, others.length); i++) { others[i].focus(); out.n++; await new Promise((r) => setTimeout(r, 220)); if (document.querySelector('#stage iframe')) out.framesDuring++; }
        out.addsDuring = window.__pv.adds;
        rest.focus();
        const t = performance.now();
        for (let i = 0; i < 60 && !document.querySelector('#stage iframe'); i++) await new Promise((r) => setTimeout(r, 50));
        out.restMs = Math.round(performance.now() - t);
        out.restFrame = document.querySelectorAll('#stage iframe').length;
        const pic = document.querySelector('#stage .pic');
        out.stageShown = !!(pic && pic.offsetParent !== null);
        const next = others[0];
        const t2 = performance.now();
        next.focus();
        await new Promise((r) => setTimeout(r, 60));
        out.afterStep = document.querySelectorAll('#stage iframe').length;
        out.removedMs = window.__pv.remAt ? Math.round(window.__pv.remAt - t2) : -1;
        return out;
      })()`);
      check(steps && steps.n >= 3 && steps.framesDuring === 0 && steps.addsDuring === 0, 'row steps (' + (steps && steps.n) + ' at 220 ms): no frame is ever made', steps);
      check(steps && steps.restFrame === 1 && steps.restMs >= 550, 'resting on the stage\'s tile: one frame after ' + (steps && steps.restMs) + ' ms', steps);
      check(steps && steps.afterStep === 0 && steps.removedMs >= 0 && steps.removedMs < 60, 'the next step removes it (' + (steps && steps.removedMs) + ' ms)', steps);
      await sleep(900);   // the next step's own preview
      await g.ev('(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return 1; })()');
      await sleep(200);

      // 4. reduced motion: no autoplay, the note says why
      await g.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await sleep(200);
      await g.ev(FOCUS(okYt));
      await sleep(1100);
      const s4 = await g.ev(STATE);
      check(s4.frames === 0 && /reduce motion/i.test(s4.note), 'reduced motion: no frame, and the note says why ("' + s4.note + '")', s4);
      await g.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: '' }] });
      await g.ev('(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return 1; })()');
      await sleep(200);

      // 5. no TMDB key: a Prime title says how to get trailers, and TMDB is never asked
      const noKey = JSON.parse(JSON.stringify(snap)); noKey.tmdb = { hasKey: false };
      await apply(noKey);
      await sleep(600);
      const tm0 = tmdbLog.length;
      const f5 = await g.ev(FOCUS('(it) => it.service === "prime" && it.kind !== "live"'));
      await sleep(1100);
      const s5 = await g.ev(STATE);
      check(!!f5 && s5.frames === 0 && /TMDB key in Settings > Lumen/.test(s5.note) && tmdbLog.length === tm0, 'no TMDB key: a ' + (f5 && f5.service) + ' title says how ("' + s5.note + '"), no TMDB request', { note: s5.note, tmdb: tmdbLog.length - tm0 });
      await g.ev('(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return 1; })()');

      // 6. with a key (the made-up one, saved in this test profile): no trailer on TMDB -> a note
      const setKey = await chrome.ev('(async () => { const r = await window.api.watch.setTmdbKey(' + JSON.stringify(FAKE_KEY) + '); return !!(r && r.tmdb && r.tmdb.hasKey); })()').catch((e) => String(e.message || e));
      check(setKey === true, 'a made-up TMDB key is saved in the test profile', setKey);
      await apply(snap);
      await sleep(600);
      if (prime) {
        await g.ev(FOCUS('(it) => it.title === ' + JSON.stringify(prime.title)));
        await g.waitFor('(() => { const n = document.querySelector("#stage .pvnote"); return n && /TMDB lists no/.test(n.textContent) || null; })()', 6000).catch(() => 0);
        const s6 = await g.ev(STATE);
        check(s6.frames === 0 && /TMDB lists no YouTube trailer/.test(s6.note), 'no trailer: a note says so ("' + s6.note + '")', s6);
        check(tmdbLog.some((p) => /\/3\/search\/multi$/.test(p)) && tmdbLog.some((p) => /\/videos$/.test(p)), 'the trailer lookup went to the local TMDB mock only', tmdbLog.slice(-4));
        await g.ev('(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return 1; })()');
      } else check(false, 'the fixture has a Prime title');

      // 7. a TMDB trailer plays from the mock
      if (disney) {
        await g.ev(RESET);
        await g.ev(FOCUS('(it) => it.title === ' + JSON.stringify(disney.title)));
        await g.waitFor('(() => { const w = document.querySelector("#stage .pv.on"); return w || null; })()', 8000).catch(() => 0);
        const s7 = await g.ev(STATE);
        check(s7.frames === 1 && s7.src.indexOf(Pv.MOCK_ORIGIN + '/embed/' + TRAILER_ID + '?') === 0 && s7.on, 'trailer: the TMDB trailer (' + TRAILER_ID + ') plays from the mock for "' + disney.title + '"', { src: s7.src.slice(0, 80), on: s7.on, note: s7.note });
        await g.ev('(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return 1; })()');
        await sleep(200);
      } else check(false, 'the fixture has a Disney+ title');

      // 8. the player says it cannot play: a note, the frame gone
      if (errId) {
        await g.ev(FOCUS('(it) => it.url.indexOf(' + JSON.stringify(errId) + ') !== -1'));
        await g.waitFor('(() => { const n = document.querySelector("#stage .pvnote.err"); return n || null; })()', 6000).catch(() => 0);
        const s8 = await g.ev(STATE);
        check(s8.frames === 0 && /doesn.t allow/.test(s8.note) && /err/.test(s8.tone), 'player error 150: a note ("' + s8.note + '"), the frame removed', s8);
        await g.ev('(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return 1; })()');
      } else check(false, "the first row has a second YouTube tile for the player-error case");

      say('mock player loads: ' + net.mock.length + ' (' + [...new Set(net.mock.map((r) => r.type))].join(',') + ')');
      check(net.mock.length >= 3, 'the frames were answered by this test\'s mock player (' + net.mock.length + ' loads)');
      check(net.real.length === 0, 'no request to a real YouTube embed', net.real.slice(0, 3));
      const electron = errors.filter((e) => /sandboxed_renderer\.bundle\.js|binding\.startupData|preloadScripts/.test(e));
      const mine = errors.filter((e) => electron.indexOf(e) === -1);
      check(!mine.length, 'no console errors or exceptions on the Watch page', mine.slice(0, 5));
      g.close();
    } finally {
      try { await mock.close(); } catch (e) { /* gone */ }
      try { tmdb.close(); } catch (e) { /* gone */ }
      for (const n of ['open.txt', 'edge.txt', 'game.flag']) { try { fs.rmSync(STUB(n), { force: true }); } catch (e) { /* none */ } }
    }
  });
}
