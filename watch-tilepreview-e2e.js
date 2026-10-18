try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine: no cap needed */ }
// watch-tilepreview-e2e.js -- the hover previews INSIDE tiles (watch-tilepreview.js), end to end, against
// a MOCK player and a MOCK TMDB: a REAL hidden Quartz test instance (e2e-kit: --test-profile, off-screen,
// watched by testwatch.js) with QUARTZ_WATCH_PREVIEW_MOCK=1, so a frame loads watch/preview.js
// MOCK_ORIGIN (https://quartz-preview.invalid, which no network resolves), answered here through CDP
// Fetch by a fake player that speaks YouTube's postMessage protocol (state, currentTime, commands).
// TMDB is a local server (QUARTZ_WATCH_REBASE). Any request to a real YouTube embed is failed and
// counted. Never a real account, key, profile or video.
//
//   node watch-tilepreview-e2e.js [--cdp 9831] [--tmdb-port 9832] [--shots <dir>] [--prefix tilepreview]
//
// Checks, past the first row (the hero gone): resting on a YouTube tile starts exactly ONE preview
// after the delay, muted, faded in once it plays, with the progress line and the toggles; leaving
// removes the player element at once; a fast sweep starts none; the mute toggle is remembered by the
// next preview; a Disney+ tile plays its TMDB trailer; no trailer: nothing, the tile still; the
// gaming and battery-saver gates hold (with the reason on the tile); idle CPU after leaving is back
// to the baseline; a click opens the player at the previewed time (&t=). One line:
// "watch-tilepreview-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');
const F = require('./tests/watch-snapshot');
const Pv = require('./watch/preview');
const TP = require('./watch-tilepreview');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9831'));
const TMDB_PORT = Number(opt('tmdb-port', '9832'));
const SHOTS = opt('shots', '');
const PREFIX = opt('prefix', 'tilepreview');
const TAG = 'quartz-watch-tilepv-' + process.pid;
const STUB = (n) => path.join(os.tmpdir(), TAG + '-' + n);
const TRAILER_ID = 'MOCKtrailr1';
const FAKE_KEY = '0123456789abcdef0123456789abcdef';   // made up: only the local mock ever sees it

/* ---- a real raster (24-bit BMP) for every picture request ---- */
const bmps = new Map();
function bmp(w, h, rgb) {
  const k = w + 'x' + h + ':' + rgb.join(',');
  if (bmps.has(k)) return bmps.get(k);
  const row = Math.ceil(w * 3 / 4) * 4;
  const b = Buffer.alloc(54 + row * h);
  b.write('BM', 0); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = 54 + y * row + x * 3; const v = (x * 7 + y * 3) % 40; b[o] = rgb[2] + v; b[o + 1] = rgb[1] + v; b[o + 2] = rgb[0] + v; }
  bmps.set(k, b);
  return b;
}

/* ---- the fake YouTube player: a moving picture, state, currentTime, and an echo of commands ---- */
function playerHtml(id) {
  const trailer = id === TRAILER_ID;
  return '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:#000}' +
    '#v{position:absolute;inset:0;background:' + (trailer ? 'linear-gradient(120deg,#1d2b3a,#3c4d5e 50%,#8a6d3b)' : 'linear-gradient(115deg,#24313d,#46525e 50%,#7a5c46)') + '}' +
    '#b{position:absolute;left:0;top:0;bottom:0;width:18%;background:rgba(255,255,255,.14);animation:s 2.4s linear infinite}' +
    '@keyframes s{from{transform:translateX(-100%)}to{transform:translateX(560%)}}' +
    '#t{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font:600 22px/1.2 Segoe UI,sans-serif;color:#fff;text-align:center;letter-spacing:.04em;white-space:nowrap}' +
    '#t small{display:block;font-size:12px;font-weight:400;opacity:.8}</style></head><body><div id="v"></div><div id="b"></div>' +
    '<div id="t">' + (trailer ? 'MOCK TRAILER' : 'MOCK PREVIEW') + '<small>test player (' + id + '), not YouTube</small></div><script>' +
    'var t0=0,iv=0;function post(o){parent.postMessage(JSON.stringify(o),"*");}' +
    'window.addEventListener("message",function(e){var d;try{d=JSON.parse(e.data);}catch(x){return;}if(!d)return;' +
    'if(d.event==="command"){post({event:"mockCmd",func:d.func,args:d.args||[]});return;}' +
    'if(d.event!=="listening"||t0)return;t0=Date.now();post({event:"initialDelivery",info:{playerState:-1,duration:300}});' +
    'setTimeout(function(){post({event:"onStateChange",info:1});},150);' +
    'iv=setInterval(function(){post({event:"infoDelivery",info:{currentTime:(Date.now()-t0)/1000,duration:300}});},500);});' +
    '</script></body></html>';
}

/* ---- TMDB, local ---- */
const NO_TRAILER = new Set();
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

/* ---- CPU of the test instance's whole process tree over N s, % of one core (no window is touched) ---- */
const CPU_PS = String.raw`param([int]$Root, [int]$Seconds)
function Tree {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine)
  $ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add($Root)
  $more = $true
  while ($more) { $more = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { [void]$ids.Add([int]$p.ProcessId); $more = $true } } }
  $kind = @{}; foreach ($p in $all) { if ($ids.Contains([int]$p.ProcessId)) { $t = 'main'; if ($p.CommandLine -match '--type=([a-z-]+)') { $t = $Matches[1] }; $kind[[int]$p.ProcessId] = $t } }
  return $kind
}
function Cpu($kind) { $o = @{}; foreach ($id in $kind.Keys) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { $o[$id] = $p.TotalProcessorTime.TotalMilliseconds } }; return $o }
$k0 = Tree; $c0 = Cpu $k0
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Seconds $Seconds
$k1 = Tree; $c1 = Cpu $k1
$ms = $sw.Elapsed.TotalMilliseconds
$total = 0; $byKind = @{}
foreach ($id in $c1.Keys) { $d = $c1[$id]; if ($c0.ContainsKey($id)) { $d = $d - $c0[$id] }; $total += $d; $t = $k1[$id]; if (-not $byKind.ContainsKey($t)) { $byKind[$t] = 0 }; $byKind[$t] += $d }
$parts = ($byKind.Keys | Sort-Object | ForEach-Object { '"' + $_ + '":' + [math]::Round($byKind[$_] / $ms * 100, 2) }) -join ','
'{"pct":' + [math]::Round($total / $ms * 100, 2) + ',"procs":' + $c1.Count + ',"ms":' + [math]::Round($ms) + ',"byKind":{' + $parts + '}}'
`;
function cpuSample(pid, seconds) {
  const f = STUB('cpu.ps1');
  fs.writeFileSync(f, CPU_PS);
  return new Promise((resolve) => {
    const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f, '-Root', String(pid), '-Seconds', String(seconds)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => { out += String(d); });
    proc.on('exit', () => { const line = out.split(/\r?\n/).find((l) => l.trim().startsWith('{')); try { resolve(JSON.parse(line)); } catch (e) { resolve({ pct: NaN, error: out.slice(0, 300) }); } });
  });
}

async function guest(q, errors, net) {
  let t = null;
  for (let i = 0; i < 250 && !t; i++) {
    try { t = (await q.targets()).find((x) => /\/watch\.html(\?|#|$)/.test(String(x.url)) && x.webSocketDebuggerUrl); } catch (e) { t = null; }
    if (!t) await sleep(60);
  }
  if (!t) throw new Error('the Lumen page never appeared as a CDP target');
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
        net.mock.push({ u, at: Date.now() });
        const body = Buffer.from(playerHtml(id));
        g.send('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: body.toString('base64') });
      } else if (/youtube-nocookie\.com|youtube\.com\/embed/.test(u)) {
        net.real.push(u);
        g.send('Fetch.failRequest', { requestId: rid, errorReason: 'BlockedByClient' });
      } else if (p.resourceType === 'Image') {
        const body = /maxresdefault/.test(u) ? bmp(1280, 720, [60, 70, 82]) : bmp(640, 360, [72, 80, 92]);
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

/* In the page: when the pointer came onto a tile, when a .tpv was added / shown / removed, and the player's messages. */
const WATCHER = `(() => {
  const st = document.getElementById('stack');
  const w = window.__tp = { overAt: 0, overKey: '', adds: 0, addAt: 0, onAt: 0, remAt: 0, opacityAtAdd: '', maxAlive: 0, msgs: [] };
  st.addEventListener('pointerover', (e) => { const c = e.target.closest && e.target.closest('.card'); if (!c) return; const k = c.dataset.key || ''; if (k !== w.overKey) { w.overKey = k; w.overAt = performance.now(); } }, true);
  window.addEventListener('message', (e) => { if (w.msgs.length < 200 && /mockCmd/.test(String(e.data))) w.msgs.push(String(e.data).slice(0, 120)); });
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) if (n.nodeType === 1 && n.matches('.tpv')) { w.adds++; w.addAt = performance.now(); w.opacityAtAdd = getComputedStyle(n).opacity; }
        for (const n of m.removedNodes) if (n.nodeType === 1 && n.matches('.tpv')) w.remAt = performance.now();
        w.maxAlive = Math.max(w.maxAlive, document.querySelectorAll('#stack .tpv').length);
      } else if (m.target.classList && m.target.classList.contains('tpv') && m.target.classList.contains('on') && !w.onAt) w.onAt = performance.now();
    }
  }).observe(st, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  return 1;
})()`;
const RESET = '(() => { Object.assign(window.__tp, { overAt: 0, overKey: "", adds: 0, addAt: 0, onAt: 0, remAt: 0, opacityAtAdd: "", maxAlive: 0 }); window.__tp.msgs.length = 0; return 1; })()';
const STATE = `(() => {
  const f = document.querySelectorAll('#stack iframe');
  const w = document.querySelector('#stack .tpv');
  const n = document.querySelector('#stack .tpv-note');
  const host = document.querySelector('#stack .card.tpv-host');
  const bar = document.querySelector('#stack .tpv-bar');
  const mute = document.querySelector('#stack .tpv-mute');
  const cc = document.querySelector('#stack .tpv-cc');
  return { frames: f.length, src: f[0] ? f[0].src : '', on: !!(w && w.classList.contains('on')), opacity: w ? getComputedStyle(w).opacity : '',
    note: n ? n.textContent : '', host: host ? host.dataset.key : '', bar: !!(bar && bar.classList.contains('run')),
    mute: mute ? mute.getAttribute('aria-pressed') : '', cc: cc ? cc.getAttribute('aria-pressed') : '',
    stageFrames: document.querySelectorAll('#stage iframe').length, compact: document.body.classList.contains('is-compact'),
    ctl: window.WatchTilePreview && window.WatchTilePreview._ctl() ? window.WatchTilePreview._ctl().state() : null,
    tp: Object.assign({}, window.__tp, { msgs: window.__tp.msgs.slice(-6) }), now: performance.now() };
})()`;
/* the centre of the art of the card with this key in the lens row, or null */
const ART = (key) => `(() => { const c = [...document.querySelectorAll('#stack .lrow[data-d="0"] .card')].find((c) => c.dataset.key === ${JSON.stringify(key)}); if (!c) return null;
  const r = c.querySelector('.art').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight }; })()`;

if (require.main === module) {
  run('watch-tilepreview', async (k) => {
    const { launch, say, check } = k;
    const dog = setTimeout(() => { console.log('FAIL HARNESS TIMEOUT: watch-tilepreview-e2e did not finish in 8 min'); process.exit(1); }, 8 * 60 * 1000);
    dog.unref();
    const mock = await Mock.start({ log: () => {} });
    const tmdb = await tmdbServer();
    const rebase = [['https://api.themoviedb.org', 'http://127.0.0.1:' + TMDB_PORT]].concat(mock.rebase);
    const env = { QUARTZ_WATCH_BOOT_GRACE_MS: '0', QUARTZ_WATCH_REBASE: JSON.stringify(rebase), QUARTZ_WATCH_OPEN_STUB: STUB('open.txt'), QUARTZ_EDGE_STUB: STUB('edge.txt'),
      QUARTZ_WATCH_MIN_FREE_GB: '0', QUARTZ_WATCH_GAME_FILE: STUB('game.flag'), QUARTZ_WATCH_SAVER_FILE: STUB('saver.flag'), QUARTZ_WATCH_TPV_MIN_FREE_GB: '0',
      QUARTZ_WATCH_PREVIEW_MOCK: '1', QUARTZ_TEST_MIN_FREE_GB: process.env.QUARTZ_TEST_MIN_FREE_GB || '1.5' };
    const errors = [];
    const net = { mock: [], real: [] };
    const q = await launch({ cdp: CDP_PORT, env });
    const chrome = q.chrome;
    const pid = q.child && q.child.pid;
    try {
      await chrome.ev('(() => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); return 1; })()');
      const W = { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, modifiers: 3 };
      await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, W));
      await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, W));
      const g = await guest(q, errors, net);
      await chrome.ev('(() => { const w = findWatchTab(); const v = w && w.viewEl; if (!v) return 0; const s = v.style; s.setProperty("position", "fixed", "important"); s.setProperty("left", "0px", "important"); s.setProperty("top", "0px", "important"); s.setProperty("width", "1920px", "important"); s.setProperty("height", "1000px", "important"); s.setProperty("z-index", "2147483647", "important"); return 1; })()').catch(() => 0);
      await sleep(500);
      const size = async (w, h) => { await g.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(700); };
      await size(1920, 1000);
      await g.waitFor('document.querySelectorAll("#stack .lrow .rt > .card").length > 3 || null', 120000).catch(() => 0);
      await g.waitFor('(() => { const p = document.querySelectorAll("#pills .sp.st-busy"); return p.length === 0 || null; })()', 90000).catch(() => 0);
      const setKey = await chrome.ev('(async () => { const r = await window.api.watch.setTmdbKey(' + JSON.stringify(FAKE_KEY) + '); return !!(r && r.tmdb && r.tmdb.hasKey); })()').catch((e) => String(e.message || e));
      check(setKey === true, 'a made-up TMDB key is saved in the test profile (trailers come from the local mock)', setKey);
      const desc = await chrome.ev('(async () => { const r = await window.api.watch.describe(); return r && r.tilePreview; })()').catch((e) => String(e.message || e));
      check(desc && desc.on === true, 'Settings > Lumen: "Preview videos when I hover" is on by default', desc);
      await sleep(800);
      await g.ev(WATCHER);

      const snap = F.dense(Date.now());
      snap.tmdb = { hasKey: true };
      const prime = snap.items.find((it) => it.service === 'prime' && it.kind !== 'live' && it.title);
      if (prime) NO_TRAILER.add(prime.title.trim().toLowerCase());
      await g.ev('(() => { if (!window.__tpApply) { window.__tpApply = window.__applyWatch; window.__applyWatch = function () {}; } window.__tpApply(' + JSON.stringify(snap) + '); return 1; })()');
      await sleep(1200);

      // a row past the first with a YouTube tile and a Disney+ tile (the hero gone, as after scrolling)
      const rows = await g.ev(`[...document.querySelectorAll('#stack .lrow')].map((r, i) => ({ i, cards: [...r.querySelectorAll('.card')].filter((c) => c._item && !c.classList.contains('sk-card')).map((c) => ({ key: c.dataset.key, service: c._item.service, kind: c._item.kind || '', title: c._item.title, url: c._item.url, id: (/[?&]v=([A-Za-z0-9_-]{11})/.exec(c._item.url || '') || [])[1] || '' })) }))`);
      const pick = (want) => rows.find((r) => r.i > 0 && want(r.cards));
      const ytRow = pick((cs) => cs.filter((c) => c.service === 'youtube' && c.id && c.kind !== 'live' && c.kind !== 'upcoming').length >= 6) || pick((cs) => cs.some((c) => c.service === 'youtube' && c.id));
      const dRow = pick((cs) => cs.some((c) => c.service === 'disney' && c.kind !== 'live' && c.kind !== 'upcoming' && (!prime || c.title !== prime.title)));
      const dPick = dRow ? dRow.cards.find((c) => c.service === 'disney' && c.kind !== 'live' && c.kind !== 'upcoming' && (!prime || c.title !== prime.title)) : null;
      // a title TMDB lists no trailer for: the Prime one if it is past the first row, else another film or show there
      const isTitle = (c) => /^(prime|disney|hulu)$/.test(c.service) && c.kind !== 'live' && c.kind !== 'upcoming' && (!dPick || c.title !== dPick.title);
      let pRow = prime ? pick((cs) => cs.some((c) => c.title === prime.title)) : null;
      let noTrail = pRow ? pRow.cards.find((c) => c.title === prime.title) : null;
      if (!noTrail) { pRow = pick((cs) => cs.some(isTitle)); noTrail = pRow ? pRow.cards.find(isTitle) : null; }
      if (noTrail) NO_TRAILER.add(noTrail.title.trim().toLowerCase());
      say(rows.length + ' rows; YouTube row ' + (ytRow && ytRow.i) + ', Disney+ row ' + (dRow && dRow.i) + ', no-trailer row ' + (pRow && pRow.i) + ' ("' + (noTrail && noTrail.title) + '")');
      check(!!ytRow && !!dRow, 'the fixture has a YouTube row and a Disney+ row past the first', { yt: !!ytRow, d: !!dRow });
      if (!ytRow || !dRow) throw new Error('fixture rows missing');
      const goRow = async (i) => {
        await g.ev('(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return 1; })()');
        for (let n = 0; n < 30; n++) {
          const cur = await g.ev(`[...document.querySelectorAll('#stack .lrow')].findIndex((r) => r.dataset.d === '0')`);
          if (cur === i) break;
          await g.ev(cur < i ? 'document.getElementById("ldn").click(), 1' : 'document.getElementById("lup").click(), 1');
          await sleep(350);
        }
        await sleep(900);
      };
      const off = async () => { await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 960, y: 990 }); };
      const to = async (key) => { const p = await g.ev(ART(key)); if (p) await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); return p; };
      const ytCards = ytRow.cards.filter((c) => c.service === 'youtube' && c.id && c.kind !== 'live' && c.kind !== 'upcoming');
      const ytA = ytCards[1] || ytCards[0];

      await goRow(ytRow.i);
      await off();
      await sleep(1500);
      const s0 = await g.ev(STATE);
      check(s0.compact && s0.frames === 0, 'past the first row: the hero is gone (slim top) and no tile plays', s0);
      if (SHOTS) {
        for (const [w, h] of [[1280, 800], [1536, 800], [1920, 1000]]) {
          await size(w, h); await off(); await sleep(500);
          await g.shot(path.join(SHOTS, PREFIX + '-rest-' + w + '.png'));
        }
        await size(1920, 1000);
      }

      // idle CPU before any preview (the same row, the pointer off the tiles)
      let cpuA = null;
      if (pid) { await sleep(2000); cpuA = await cpuSample(pid, 20); say('idle CPU before: ' + JSON.stringify(cpuA)); }

      // 1. hover a YouTube tile: one preview after the delay, faded in once it plays
      await g.ev(RESET);
      const pA = await to(ytA.key);
      await sleep(400);
      const s400 = await g.ev(STATE);
      check(!!pA && s400.frames === 0 && s400.tp.adds === 0, 'hover: nothing yet 400 ms after the pointer came to rest', s400.tp);
      await g.waitFor('(() => { const w = document.querySelector("#stack .tpv.on"); return w && getComputedStyle(w).opacity === "1" || null; })()', 7000).catch(() => 0);
      await sleep(300);
      const s1 = await g.ev(STATE);
      const delay = s1.tp.addAt && s1.tp.overAt ? Math.round(s1.tp.addAt - s1.tp.overAt) : -1;
      check(s1.frames === 1 && document_like(s1.src) && s1.host === ytA.key, 'hover: exactly ONE preview, in the hovered tile, from the mock origin, muted', { frames: s1.frames, src: s1.src.slice(0, 90), host: s1.host });
      check(delay >= TP.HOVER_DELAY_MS - 10 && delay < TP.HOVER_DELAY_MS + 900, 'hover: the player is made ' + delay + ' ms after the pointer came onto the tile (delay ' + TP.HOVER_DELAY_MS + ')', s1.tp);
      check(s1.tp.opacityAtAdd === '0' && s1.on && s1.tp.onAt > s1.tp.addAt && s1.tp.onAt - s1.tp.addAt < TP.REVEAL_FALLBACK_MS, 'hover: it fades in once the player says it plays (' + Math.round(s1.tp.onAt - s1.tp.addAt) + ' ms after the frame), not before', s1.tp);
      check(s1.bar && s1.mute === 'true' && s1.cc === 'false', 'hover: the progress line runs; mute (on) and CC (off) toggles are there', { bar: s1.bar, mute: s1.mute, cc: s1.cc });
      check(s1.stageFrames === 0, 'hover: the hidden hero plays nothing (one preview in all)');
      const geo = await g.ev(`(() => { const c = document.querySelector('#stack .card.tpv-host'); const a = c && c.querySelector('.art'); const t = c && c.querySelector('.tpv'); const k = c && c.querySelector('.tpv-ctl'); if (!a || !t || !k) return null;
        const ra = a.getBoundingClientRect(), rt = t.getBoundingClientRect(), rk = k.getBoundingClientRect(); return { art: [ra.width, ra.height], tpv: [rt.width, rt.height], dx: Math.abs(ra.left - rt.left) + Math.abs(ra.top - rt.top), ctlIn: rk.left >= ra.left && rk.right <= ra.right && rk.top >= ra.top && rk.bottom <= ra.bottom }; })()`);
      check(geo && geo.art[0] === geo.tpv[0] && geo.art[1] === geo.tpv[1] && geo.dx < 1 && geo.ctlIn, 'hover: the player fills the art box exactly (no resize) and the toggles sit inside it', geo);
      check(!!pA && pA.w === (await g.ev(ART(ytA.key))).w, 'hover: the tile kept its size');
      if (SHOTS) {
        for (const [w, h] of [[1280, 800], [1536, 800], [1920, 1000]]) {
          await size(w, h); await off(); await sleep(300); await g.ev(RESET); await to(ytA.key);
          await g.waitFor('document.querySelector("#stack .tpv.on") || null', 7000).catch(() => 0); await sleep(1200);
          await g.shot(path.join(SHOTS, PREFIX + '-youtube-' + w + '.png'));
        }
      }

      // 2. leaving tears it down: the player element is gone
      await g.waitFor('document.querySelector("#stack .tpv.on") || null', 7000).catch(() => 0);
      await off();
      const tLeave = await g.ev('performance.now()');
      await sleep(250);
      const s2 = await g.ev(STATE);
      check(s2.frames === 0 && !s2.host && s2.ctl && s2.ctl.phase === 'idle' && !s2.ctl.live && !s2.ctl.timer, 'leave: the player element is gone (no iframe, no host, no timer)', s2);
      check(s2.tp.remAt > 0 && s2.tp.remAt - tLeave < 150, 'leave: removed within 150 ms (' + Math.round(s2.tp.remAt - tLeave) + ' ms)', s2.tp);

      // 3. a fast sweep across the row starts nothing
      await g.ev(RESET);
      const sweep = ytRow.cards.slice(0, 7);
      for (const c of sweep) { await to(c.key); await sleep(120); }
      await off();
      await sleep(1600);
      const s3 = await g.ev(STATE);
      check(sweep.length >= 4 && s3.tp.adds === 0 && s3.frames === 0 && (s3.ctl && s3.ctl.sentGates) === (s2.ctl && s2.ctl.sentGates), 'sweep: ' + sweep.length + ' tiles at 120 ms: no preview, not even a gate asked', { adds: s3.tp.adds, gates: s3.ctl && s3.ctl.sentGates });

      // 4. mute is remembered: unmute, leave, hover again -> the next preview starts unmuted
      await g.ev(RESET);
      await to(ytA.key);
      await g.waitFor('document.querySelector("#stack .tpv.on") || null', 7000).catch(() => 0);
      await sleep(300);
      const mb = await g.ev('(() => { const b = document.querySelector("#stack .tpv-mute"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
      const opens0 = fs.existsSync(STUB('open.txt')) ? fs.readFileSync(STUB('open.txt'), 'utf8').split('\n').filter(Boolean).length : 0;
      if (mb) {
        await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mb.x, y: mb.y });
        await g.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mb.x, y: mb.y, button: 'left', clickCount: 1 });
        await g.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mb.x, y: mb.y, button: 'left', clickCount: 1 });
      }
      await sleep(400);
      const s4 = await g.ev(STATE);
      const saved = await g.ev('window.localStorage.getItem(' + JSON.stringify(TP.MUTE_KEY) + ')');
      const opens1 = fs.existsSync(STUB('open.txt')) ? fs.readFileSync(STUB('open.txt'), 'utf8').split('\n').filter(Boolean).length : 0;
      check(!!mb && s4.frames === 1 && s4.mute === 'false' && saved === '0' && s4.tp.msgs.some((m) => /"func":"unMute"/.test(m)), 'mute: the toggle unmutes the player (it got unMute) and is saved', { mute: s4.mute, saved, msgs: s4.tp.msgs });
      check(opens1 === opens0, 'mute: clicking the toggle opens nothing');
      await off();
      await sleep(400);
      await g.ev(RESET);
      await to(ytA.key);
      await g.waitFor('document.querySelector("#stack .tpv.on") || null', 7000).catch(() => 0);
      await sleep(700);
      const s4b = await g.ev(STATE);
      check(s4b.frames === 1 && s4b.mute === 'false' && s4b.tp.msgs.some((m) => /"func":"unMute"/.test(m)), 'mute: remembered: the next preview starts unmuted', { mute: s4b.mute, msgs: s4b.tp.msgs });
      // muted again for the rest (and for the user's default)
      const mb2 = await g.ev('(() => { const b = document.querySelector("#stack .tpv-mute"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
      if (mb2) { await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mb2.x, y: mb2.y }); await g.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mb2.x, y: mb2.y, button: 'left', clickCount: 1 }); await g.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mb2.x, y: mb2.y, button: 'left', clickCount: 1 }); }
      await sleep(300);
      check((await g.ev('window.localStorage.getItem(' + JSON.stringify(TP.MUTE_KEY) + ')')) === '1', 'mute: toggled back to muted and saved');
      await off();
      await sleep(300);

      // 5. the gates: a game running, battery saver
      fs.writeFileSync(STUB('game.flag'), '1');
      await g.ev(RESET);
      await to(ytA.key);
      await g.waitFor('document.querySelector("#stack .tpv-note") || null', 5000).catch(() => 0);
      await sleep(600);
      const s5 = await g.ev(STATE);
      check(s5.frames === 0 && s5.tp.adds === 0 && /VALORANT/.test(s5.note), 'gate: a game running: no preview, the tile says why ("' + s5.note + '")', s5);
      await off(); fs.rmSync(STUB('game.flag'), { force: true }); await sleep(300);
      fs.writeFileSync(STUB('saver.flag'), '1');
      await g.ev(RESET);
      await to(ytA.key);
      await g.waitFor('document.querySelector("#stack .tpv-note") || null', 5000).catch(() => 0);
      await sleep(600);
      const s6 = await g.ev(STATE);
      check(s6.frames === 0 && s6.tp.adds === 0 && /battery saver/.test(s6.note), 'gate: battery saver: no preview, the tile says why ("' + s6.note + '")', s6);
      await off(); fs.rmSync(STUB('saver.flag'), { force: true }); await sleep(300);
      check((await g.ev(STATE)).note === '', 'gate: the note goes with the pointer');

      // 6. a Disney+ tile plays its TMDB trailer; a title with no trailer stays still
      const dCard = dPick;
      await goRow(dRow.i);
      await off(); await sleep(400);
      await g.ev(RESET);
      await to(dCard.key);
      await g.waitFor('document.querySelector("#stack .tpv.on") || null', 8000).catch(() => 0);
      await sleep(900);
      const s7 = await g.ev(STATE);
      check(s7.frames === 1 && s7.src.indexOf(Pv.MOCK_ORIGIN + '/embed/' + TRAILER_ID + '?') === 0 && s7.on && s7.host === dCard.key, 'trailer: the Disney+ tile "' + dCard.title + '" plays its TMDB trailer in the tile', { src: s7.src.slice(0, 80), on: s7.on });
      if (SHOTS) {
        for (const [w, h] of [[1280, 800], [1536, 800], [1920, 1000]]) {
          await size(w, h); await off(); await sleep(300); await g.ev(RESET); await to(dCard.key);
          await g.waitFor('document.querySelector("#stack .tpv.on") || null', 8000).catch(() => 0); await sleep(1200);
          await g.shot(path.join(SHOTS, PREFIX + '-disney-' + w + '.png'));
        }
        await size(1920, 1000);
      }
      await off(); await sleep(300);
      if (pRow && noTrail) {
        const pCard = noTrail;
        await goRow(pRow.i);
        await off(); await sleep(400);
        await g.ev(RESET);
        await to(pCard.key);
        await sleep(3000);
        const s8 = await g.ev(STATE);
        check(s8.frames === 0 && s8.tp.adds === 0 && s8.note === '' && s8.ctl && s8.ctl.phase === 'none', 'no trailer on TMDB: nothing plays, no note, the tile stays still', s8.ctl);
        await off(); await sleep(300);
      } else check(false, 'the fixture has a film or show past the first row for the no-trailer case');
      check(tmdbLog.length > 0 && tmdbLog.every((p) => /^\/3\//.test(p)), 'trailers were looked up on the local TMDB mock only (' + tmdbLog.length + ' requests)');

      // 7. idle CPU after leaving is back to the baseline, and nothing is left behind
      await goRow(ytRow.i);
      await off();
      await sleep(3000);
      const left = await g.ev(STATE);
      check(left.frames === 0 && !left.ctl.live && !left.ctl.timer && left.tp.maxAlive <= 1, 'after leaving: no player, no timer; never more than one player at once (max ' + left.tp.maxAlive + ')', left.ctl);
      if (pid && cpuA) {
        const cpuB = await cpuSample(pid, 20);
        say('idle CPU after: ' + JSON.stringify(cpuB));
        const rise = cpuB.pct - cpuA.pct;
        check(Number.isFinite(rise) && rise <= 1.0 && cpuB.procs <= cpuA.procs, 'idle CPU: before ' + cpuA.pct + '% vs after leaving ' + cpuB.pct + '% of one core (rise ' + (Number.isFinite(rise) ? rise.toFixed(2) : '?') + ', limit 1.0); processes ' + cpuA.procs + ' -> ' + cpuB.procs, { cpuA, cpuB });
      } else check(false, 'idle CPU: no pid to measure');

      // 8. a click on a previewing tile opens the player at the previewed time
      await g.ev(RESET);
      const pC = await to(ytA.key);
      await g.waitFor('document.querySelector("#stack .tpv.on") || null', 7000).catch(() => 0);
      await sleep(3200);
      const before = fs.existsSync(STUB('open.txt')) ? fs.readFileSync(STUB('open.txt'), 'utf8') : '';
      if (pC) {
        await g.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pC.x, y: pC.y + 20, button: 'left', clickCount: 1 });
        await g.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pC.x, y: pC.y + 20, button: 'left', clickCount: 1 });
      }
      let opened = null;
      for (let i = 0; i < 40 && !opened; i++) {
        await sleep(100);
        const now = fs.existsSync(STUB('open.txt')) ? fs.readFileSync(STUB('open.txt'), 'utf8') : '';
        const extra = now.slice(before.length).split('\n').filter(Boolean);
        if (extra.length) { try { opened = JSON.parse(extra[0]); } catch (e) { opened = { url: extra[0] }; } }
      }
      const tAt = opened && /[?&]t=(\d+)s/.exec(opened.url);
      check(!!opened && opened.url.indexOf(ytA.id) !== -1 && !!tAt && Number(tAt[1]) >= 2 && Number(tAt[1]) <= 8, 'click: the player opens the same video at the previewed time (' + (opened && opened.url) + ')', opened);
      await sleep(300);
      const s9 = await g.ev(STATE).catch(() => null);
      check(!s9 || s9.frames === 0, 'click: the preview is gone once the player opens');

      say('mock player loads: ' + net.mock.length);
      check(net.mock.length >= 4, 'the players were answered by this test\'s mock (' + net.mock.length + ' loads)');
      check(net.real.length === 0, 'no request to a real YouTube embed', net.real.slice(0, 3));
      const electron = errors.filter((e) => /sandboxed_renderer\.bundle\.js|binding\.startupData|preloadScripts/.test(e));
      const mine = errors.filter((e) => electron.indexOf(e) === -1);
      check(!mine.length, 'no console errors or exceptions on the Lumen page', mine.slice(0, 5));
      g.close();
    } finally {
      try { await mock.close(); } catch (e) { /* gone */ }
      try { tmdb.close(); } catch (e) { /* gone */ }
      for (const n of ['open.txt', 'edge.txt', 'game.flag', 'saver.flag', 'cpu.ps1']) { try { fs.rmSync(STUB(n), { force: true }); } catch (e) { /* none */ } }
    }
  });
}

/** the frame's URL: the mock origin, muted, autoplaying */
function document_like(src) {
  return String(src).indexOf(Pv.MOCK_ORIGIN + '/embed/') === 0 && /[?&]mute=1(&|$)/.test(src) && /[?&]autoplay=1(&|$)/.test(src);
}
