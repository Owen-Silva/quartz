try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine: no cap needed */ }
// watch-look-e2e.js -- the look of Lumen's playback and Shorts views (watch-ambient.js + watch-ambient.css, and the
// view's own watch-playview.css / watch-shorts.css / watch-comments.css), end to end, in a REAL hidden Quartz test
// instance (tests/e2e-kit.js: --test-profile, off-screen, --measure-visible so it renders as if in front), on LOCAL
// FIXTURES ONLY: the comments fixture's youtube.com/watch page and the Shorts fixture's /shorts/<id> pages, every
// service origin rebased to a local front, every other host resolving nowhere. YouTube's stills (i.ytimg.com) are
// answered here through CDP Fetch with synthetic pictures, so nothing reaches a real CDN. The playing videos are
// synthetic (--media <dir>: computed scenes, never a recording; without it, tests/media's testsrc2 clip).
//
//   node watch-look-e2e.js [--cdp 9791] [--shots <dir>] [--prefix look] [--media <dir>] [--shots-only]
//                          [--baseline <before-perf.json>] [--perf-out <file>] [--no-cpu]
//
// Shots: the video view (playing; the comments scrolled into view) and the Shorts view, each at 1280x800, 1536x800 and
// 1919x942, plus the next Short. Checks (not with --shots-only, which is for the BEFORE shots on the old code):
//   the ambient field is on in the single view and drawn from the video (its still first, then the playing frame); it
//   refreshes while the video plays and repaints nothing while it is paused; reduced motion keeps a still field with no
//   refresh; multiview and the corner have none; a Short's field follows the current Short; on a WHITE video every
//   text over the field keeps WCAG AA (4.5:1 body, 3:1 large) against the brightest pixel around it; frames over 20 ms
//   while scrolling the view and the comments and while moving between Shorts; long tasks; idle CPU (process tree).
// One summary line: "watch-look-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');
const X = require('./tests/comments-fixtures');
const F = require('./tests/shorts-fixtures');
const Clip = require('./tests/fixture-clip');

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* stays normal */ }
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);
const CDP_PORT = Number(opt('cdp', '9791'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'quartz-look-shots'));
const PREFIX = opt('prefix', 'look');
const MEDIA = opt('media', '');
const SHOTS_ONLY = has('shots-only');
const BASELINE = opt('baseline', '');
const PERF_OUT = opt('perf-out', '');
const SIZES = [[1280, 800], [1536, 800], [1919, 942]];
const VID = 'pvTest00001';
const WHITE = 'whiteTest01';
const S = F.SHORTS;

/* ---- media: synthetic scenes from --media, else the testsrc2 clip and flat stills ---------------- */
const media = (name) => { if (!MEDIA) return null; const f = path.join(MEDIA, name); return fs.existsSync(f) ? f : null; };
function shortIndex(id) { const i = S.findIndex((s) => s.id === id); return i < 0 ? 0 : i; }
function clipFor(kind, id) {
  if (kind === 'short') return media(shortIndex(id) % 2 ? 'look-dunes.mp4' : 'look-aurora.mp4') || Clip.CLIP;
  return media(id === WHITE ? 'look-white.mp4' : 'look-sunset.mp4') || Clip.CLIP;
}
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
function flatPng(rgb) {
  const w = 32, h = 18, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = rgb[0]; raw[i + 1] = rgb[1]; raw[i + 2] = rgb[2]; }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function thumbFor(id) {
  if (id === WHITE) return media('look-white.png') ? fs.readFileSync(media('look-white.png')) : flatPng([255, 255, 255]);
  const si = S.findIndex((s) => s.id === id);
  const f = si >= 0 ? media(si % 2 ? 'look-dunes.png' : 'look-aurora.png') : media('look-sunset.png');
  return f ? fs.readFileSync(f) : flatPng(si >= 0 ? [40, 150, 130] : [210, 110, 70]);
}
/** A PNG (8-bit, RGB or RGBA, non-interlaced) to { w, h, px: RGBA }. */
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; } else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; out[o] = line[x * bpp]; out[o + 1] = line[x * bpp + 1]; out[o + 2] = line[x * bpp + 2]; out[o + 3] = 255; }
    prev = line;
  }
  return { w, h, px: out };
}
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/* ---- local servers ---------------------------------------------------------------------------- */
function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 2000;
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, origin: 'http://127.0.0.1:' + s.address().port }));
  });
}
function sendFile(req, res, file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { res.writeHead(404); res.end('no clip'); return; }
  const m = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range || ''));
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
  res.writeHead(m ? 206 : 200, Object.assign({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 }, m ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size } : {}));
  fs.createReadStream(file, { start, end }).pipe(res);
}
function refOf(req) { try { return new URL(String(req.headers.referer || '')); } catch (e) { return null; } }
async function startServers(mock) {
  const fronts = {};
  for (const svc of Mock.SERVICES) {
    fronts[svc] = await listen((req, res) => {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      const p = u.pathname.replace(/\/+$/, '') || '/';
      if (p === '/__media/clip.mp4') { const r = refOf(req); return sendFile(req, res, clipFor('video', r ? r.searchParams.get('v') : '')); }
      if (p === '/__media/short.mp4') { const r = refOf(req); const m = r && /\/shorts\/([A-Za-z0-9_-]+)/.exec(r.pathname); return sendFile(req, res, clipFor('short', m ? m[1] : '')); }
      if (svc === 'youtube' && p === '/watch') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(X.watch({ vid: u.searchParams.get('v') || VID, cm: '' }));
      }
      if (svc === 'youtube' && p === '/youtubei/v1/next' && req.method === 'POST') {
        let raw = '';
        req.on('data', (d) => { raw += d; });
        req.on('end', () => {
          let body = {};
          try { body = JSON.parse(raw); } catch (e) { body = {}; }
          const r = refOf(req);
          const out = X.next(body, '', r ? r.searchParams.get('v') || VID : VID);
          res.writeHead(out.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out.json));
        });
        return undefined;
      }
      const sm = svc === 'youtube' && /^\/shorts\/([A-Za-z0-9_-]{6,20})$/.exec(p);
      if (sm) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(F.shortsPage(sm[1], {})); }
      const up = http.request({ host: '127.0.0.1', port: mock.ports[svc], path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + mock.ports[svc] }) }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('mock gone'); } });
      req.pipe(up);
      return undefined;
    });
  }
  const rebase = [];
  for (const svc of Mock.SERVICES) for (const from of Mock.ORIGINS[svc]) rebase.push([from, fronts[svc].origin]);
  return { fronts, rebase, close: () => { for (const f of Object.values(fronts)) f.server.close(); } };
}
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

/* ---- CPU of the instance's whole process tree (ms of CPU time) --------------------------------- */
const CPU_PS = path.join(os.tmpdir(), 'quartz-look-cpu-' + process.pid + '.ps1');
fs.writeFileSync(CPU_PS, [
  'param([int]$Root)',
  '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId',
  '$ids = @($Root)',
  'do { $n = $ids.Count; $ids = @($ids + @($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId })) | Select-Object -Unique } while ($ids.Count -gt $n)',
  '$t = 0; foreach ($p in (Get-Process -Id $ids -ErrorAction SilentlyContinue)) { $t += $p.TotalProcessorTime.TotalMilliseconds }',
  'Write-Output ([math]::Round($t))'
].join('\r\n'));
function cpuMs(pid) { try { return Number(String(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CPU_PS, '-Root', String(pid)], { windowsHide: true })).trim()); } catch (e) { return NaN; } }
async function cpuOver(pid, ms) {
  const a = cpuMs(pid), t0 = Date.now();
  await sleep(ms);
  const b = cpuMs(pid), dt = Date.now() - t0;
  return Math.round(((b - a) / dt) * 1000) / 10;   // % of one core
}

run('watch-look-e2e', async ({ check, launch, say }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  check(!MEDIA || ['look-sunset.mp4', 'look-aurora.mp4', 'look-dunes.mp4', 'look-white.mp4'].every((f) => !!media(f)), 'the synthetic clips are there (--media)', MEDIA);
  const mock = await Mock.start({ log: () => {} });
  const srv = await startServers(mock);
  const FY = srv.fronts.youtube.origin;
  const env = {
    QUARTZ_WATCH_BOOT_GRACE_MS: '0', QUARTZ_WATCH_REBASE: JSON.stringify(srv.rebase), QUARTZ_WATCH_MIN_FREE_GB: '0',
    QUARTZ_PLAYER_FLOOR_GB: '0', QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1', QUARTZ_TEST_WINDOW_SIZE: '1280x800',
    QUARTZ_EDGE_STUB: path.join(os.tmpdir(), 'quartz-look-edge-' + process.pid + '.txt'),
  };
  const args = ['--force-device-scale-factor=1', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'];
  const perf = { at: new Date().toISOString(), ambient: false };
  try {
    const q = await launch({ cdp: CDP_PORT, env, args });
    const chrome = q.chrome;
    await chrome.ev('window.__fsCalls = 0; window.toggleFullscreen = function () { window.__fsCalls++; }; 1');
    const AMB = await chrome.ev('typeof window.LumenAmbient === "object"');
    perf.ambient = AMB;
    if (!SHOTS_ONLY) check(AMB, 'watch-ambient.js is loaded in the chrome');

    // YouTube's stills: answered here, never from the real CDN.
    const asked = [];
    await chrome.send('Fetch.enable', { patterns: [{ urlPattern: '*://i.ytimg.com/*', requestStage: 'Request' }] });
    chrome.ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
      if (m.method !== 'Fetch.requestPaused') return;
      const u = String(m.params.request.url || '');
      const id = (/\/vi(?:_webp)?\/([A-Za-z0-9_-]{6,20})\//.exec(u) || [])[1] || '';
      asked.push(id);
      const body = id ? thumbFor(id) : null;
      chrome.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: body ? 200 : 404,
        responseHeaders: [{ name: 'Content-Type', value: 'image/png' }, { name: 'Cache-Control', value: 'max-age=3600' }], body: (body || Buffer.alloc(0)).toString('base64') });
    });
    // long tasks in the chrome, from here on
    await chrome.ev('(() => { window.__lt = []; window.__lt2 = []; window.__cap = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__lt.push(Math.round(e.duration)); window.__lt2.push([e.startTime, e.duration]); } }).observe({ type: "longtask" }); } catch (e) { window.__lt = null; } return 1; })()');

    const PS = 'LumenPlayview._state()';
    const SS = 'LumenShorts._state()';
    const amb = () => (AMB ? chrome.ev('LumenAmbient._state()') : Promise.resolve(null));
    const ambWait = (cond, ms) => (AMB ? chrome.waitFor(`(() => { const a = LumenAmbient._state(); return a && (${cond}) ? a : null; })()`, ms || 10000).catch(() => null) : Promise.resolve(null));
    const pvWait = (cond, ms) => chrome.waitFor(`(() => { const s = ${PS}; const x = s.slots.find((y) => y.boxed) || s.slots[s.slots.length - 1]; return x && (${cond}) ? x : null; })()`, ms || 15000).catch(() => null);
    const shWait = (cond, ms) => chrome.waitFor(`(() => { const s = ${SS}; const x = s.slots[s.slots.length - 1]; return x && (${cond}) ? x : null; })()`, ms || 15000).catch(() => null);
    const win = () => chrome.ev('window.api.lumenPlayview.testWin()');
    let req = [1280, 800];
    const resize = async (w, h) => {
      let rw = w, rh = h;
      for (let i = 0; i < 4; i++) {
        await chrome.ev(`(() => { const t0 = performance.now(); return window.api.watchPlayer.testCapture({ width: ${rw}, height: ${rh}, wait: 700 }).then(() => { window.__cap && window.__cap.push([t0, performance.now() + 50]); return 1; }); })()`);
        const c = (await win()).content;
        if (c.width === w && c.height === h) { req = [rw, rh]; break; }
        rw += w - c.width; rh += h - c.height;
      }
      await sleep(500);
    };
    const shotFiles = [];
    const shot = async (name, w, h, wait) => {
      const r = await chrome.ev(`(() => { const t0 = performance.now(); return window.api.watchPlayer.testCapture({ width: ${req[0]}, height: ${req[1]}, wait: ${wait || 1400} }).then((r) => { window.__cap && window.__cap.push([t0, performance.now() + 50]); return r; }); })()`).catch((e) => ({ ok: false, err: String(e && e.message) }));
      if (!r || !r.ok || !r.png) { check(false, 'shot ' + name + ' at ' + w + 'x' + h, r && r.err); return null; }
      const f = path.join(SHOTS, PREFIX + '-' + name + '-' + w + 'x' + h + '.png');
      const buf = Buffer.from(r.png, 'base64');
      fs.writeFileSync(f, buf);
      shotFiles.push(f);
      say('shot ' + f);
      return buf;
    };
    const tileSel = '.wp-layer .wp-tile.pv';
    const scrollTo = (top) => chrome.ev(`(() => { const t = document.querySelector(${JSON.stringify(tileSel)}); if (!t) return -1; t.scrollTop = ${top}; return t.scrollTop; })()`);
    const toComments = () => chrome.ev(`(() => { const t = document.querySelector(${JSON.stringify(tileSel)}); const n = document.querySelector('#lumen-pv-comments');
      if (!t || !n) return -1; t.scrollTop += n.getBoundingClientRect().top - t.getBoundingClientRect().top - 40; return t.scrollTop; })()`);
    const play = (v, title) => chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=' + v)}, { service: 'youtube', title: ${JSON.stringify(title)} }), 1`);
    const guestFor = async (pred) => { const t = await targetWhere(q, pred, 15000); return t ? cdpTo(t) : null; };
    const framesDuring = async (label, action) => {
      await chrome.ev('(() => { window.__fr = { d: [], on: true }; let last = performance.now(); const f = (t) => { const x = window.__fr; if (!x.on) return; x.d.push(t - last); last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); return 1; })()');
      const lt0 = await chrome.ev('window.__lt ? window.__lt.length : 0');
      await action();
      const fr = await chrome.ev('(() => { const x = window.__fr; x.on = false; const d = x.d.slice(2); return { n: d.length, over: d.filter((v) => v > 20).map((v) => Math.round(v)), max: Math.round(Math.max(0, ...d)) }; })()');
      fr.longTasks = await chrome.ev(`window.__lt ? window.__lt.slice(${lt0}) : null`);
      say('frames ' + label + ': ' + fr.n + ', over 20 ms: ' + fr.over.length + ' ' + JSON.stringify(fr.over) + ', max ' + fr.max + ' ms, long tasks ' + JSON.stringify(fr.longTasks));
      return fr;
    };
    const wheel = async (x, y, n, dy, gap) => { for (let i = 0; i < n; i++) { await chrome.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy }); await sleep(gap); } };
    // paints during an action: Chromium's own trace (Paint events and their area)
    const paintsDuring = async (label, action) => {
      const ev = [];
      let done = null;
      const onMsg = (raw) => { let m; try { m = JSON.parse(String(raw)); } catch (e) { return; } if (m.method === 'Tracing.dataCollected') for (const e of m.params.value) ev.push(e); else if (m.method === 'Tracing.tracingComplete' && done) done(); };
      chrome.ws.on('message', onMsg);
      const st = await chrome.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] } });
      if (st.error) { chrome.ws.off('message', onMsg); say('trace: ' + JSON.stringify(st.error)); await action(); return null; }
      await action();
      const fin = new Promise((r) => { done = r; });
      await chrome.send('Tracing.end');
      await Promise.race([fin, sleep(8000)]);
      chrome.ws.off('message', onMsg);
      const vp = await chrome.ev('innerWidth * innerHeight');
      const paints = ev.filter((e) => e.name === 'Paint' && e.ph === 'X');
      const big = paints.filter((e) => { const c = e.args && e.args.data && e.args.data.clip; if (!c || c.length < 8) return false; const w = Math.abs(c[2] - c[0]), h = Math.abs(c[5] - c[1]); return w * h > vp * 0.25; });
      const paintMs = Math.round(paints.reduce((a, e) => a + (e.dur || 0), 0) / 100) / 10;
      const r = { paints: paints.length, big: big.length, paintMs, maxPaint: Math.round(Math.max(0, ...paints.map((e) => e.dur || 0)) / 100) / 10 };
      say('paints ' + label + ': ' + JSON.stringify(r));
      return r;
    };
    // text over the field, against the background under it (the median pixel of its box)
    const contrastOf = async (png, sels) => {
      const img = decodePng(png);
      const els = await chrome.ev(`(() => { const out = []; for (const s of ${JSON.stringify(sels)}) { const n = [...document.querySelectorAll('.wp-layer ' + s)].find((x) => { const r = x.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(x).visibility !== 'hidden'; });
        if (!n) continue; const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); out.push({ s, x: r.left, y: r.top, w: r.width, h: r.height, color: cs.color, size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) || 400 }); } return out; })()`);
      const res = [];
      for (const e of els) {
        const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(e.color);
        if (!m) continue;
        const tl = lum(+m[1], +m[2], +m[3]);
        // The background: the median pixel of the text's own box (glyphs cover far less than half of it, and the
        // field under one line of text is smooth), so a neighbouring button or icon never counts as its background.
        const ls = [];
        const x0 = Math.max(0, Math.floor(e.x - 2)), x1 = Math.min(img.w - 1, Math.ceil(e.x + e.w + 2)), y0 = Math.max(0, Math.floor(e.y - 2)), y1 = Math.min(img.h - 1, Math.ceil(e.y + e.h + 2));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const o = (y * img.w + x) * 4; ls.push(lum(img.px[o], img.px[o + 1], img.px[o + 2])); }
        ls.sort((p, q) => p - q);
        const worst = ls.length ? ls[Math.floor(ls.length / 2)] : -1;
        if (worst < 0 || worst > 1) continue;
        const large = e.size >= 24 || (e.size >= 18.66 && e.weight >= 600);
        res.push({ s: e.s, ratio: Math.round(ratio(tl, worst) * 100) / 100, need: large ? 3 : 4.5 });
      }
      return res;
    };

    /* ============================ 1. the video view ============================ */
    await chrome.ev('openWatchTab(), 1');
    await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 15000);
    await sleep(1500);
    await resize(1280, 800);
    await play(VID, 'Golden hour over the lake');
    const ready = await pvWait('x.boxed && x.applied && x.phase === "ready"', 20000);
    check(!!ready, 'the video plays in Lumen’s view (boxed, trimmed, read)', ready && { phase: ready.phase, why: ready.why });
    const vg = await guestFor((x) => String(x.url).indexOf(FY + '/watch') === 0);
    const vPlaying = () => (vg ? vg.ev('(() => { const v = document.querySelector("video"); return !!v && !v.paused && v.currentTime > 0.3; })()').catch(() => false) : false);
    await (vg ? vg.waitFor('(() => { const v = document.querySelector("video"); return v && !v.paused && v.currentTime > 0.5; })()', 15000).catch(() => 0) : sleep(3000));
    await chrome.waitFor('document.querySelector("#lumen-pv-comments .cm-item") ? 1 : 0', 15000).catch(() => 0);
    if (AMB && !SHOTS_ONLY) {
      const a0 = await ambWait('a.on && a.mode === "pv" && a.paints > 0', 8000);
      check(!!a0, 'the video view has the ambient field, painted', a0 || await amb());
      check(asked.indexOf(VID) >= 0, 'its first colours come from the video’s own still (i.ytimg.com, answered locally)', asked);
      const a1 = await ambWait('a.src === "frame" && a.samples >= 1', 12000);
      check(!!a1, 'then from the playing frame (the page’s own canvas sample)', a1 || await amb());
    } else await sleep(4000);
    for (const [w, h] of SIZES) {
      await resize(w, h);
      await scrollTo(0);
      await shot('video', w, h, 1800);
      const top = await toComments();
      if (top < 0) say('no comments to scroll to at ' + w + 'x' + h);
      await shot('video-comments', w, h, 1200);
      // the field sinks to a tint down at the comments (an IntersectionObserver's class, no scroll-linked paint), and rises at the top
      const sunk = AMB && top > 200 ? await ambWait('a.sunk === true', 3000) : null;
      await scrollTo(0);
      const risen = sunk ? await ambWait('a.sunk === false', 3000) : null;
      if (AMB && top > 200 && !SHOTS_ONLY && w === SIZES[0][0]) check(!!sunk && !!risen, 'the field sinks at the comments and rises again at the top (' + w + 'x' + h + ')', { sunk: !!sunk, risen: !!risen });
    }

    /* ---- the field while it plays, while it is paused ---- */
    if (AMB && !SHOTS_ONLY) {
      const s0 = await amb();
      await sleep(9000);
      const s1 = await amb();
      check(s1.samples >= s0.samples + 2 && s1.on, 'while it plays the field refreshes from the frame every few seconds (' + (s1.samples - s0.samples) + ' samples in 9 s)', { s0: s0.samples, s1: s1.samples, every: s1.every });
      check(s1.maxSampleMs < 50 && s1.maxPaintMs < 50, 'a refresh is no long task: sample ' + s1.maxSampleMs + ' ms on the page’s main thread (' + s1.maxSampleWallMs + ' ms to the answer, the shrink off-thread), paint ' + s1.maxPaintMs + ' ms at most', s1);
      if (vg) await vg.ev('(() => { const v = document.querySelector("video"); v.pause(); return v.paused; })()').catch(() => 0);
      await sleep(5000);
      const p0 = await amb();
      await sleep(10000);
      const p1 = await amb();
      check(p1.paints === p0.paints, 'paused: the field repaints nothing (' + (p1.paints - p0.paints) + ' paints in 10 s)', { p0: p0.paints, p1: p1.paints, samples: [p0.samples, p1.samples] });
      if (vg) await vg.ev('(() => { const v = document.querySelector("video"); v.play(); return 1; })()').catch(() => 0);
    }

    /* ---- perf: scrolling the view and the comments ---- */
    await resize(1919, 942);
    await scrollTo(0);
    await sleep(1500);
    const info = await chrome.ev('(() => { const n = document.querySelector(".wp-layer .pv-info"); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: Math.min(innerHeight - 40, r.top + 40) }; })()');
    if (info) {
      perf.scroll = await framesDuring('scrolling the video view', async () => { await wheel(info.x, info.y, 14, 100, 110); await sleep(400); await wheel(info.x, info.y, 14, -100, 110); await sleep(500); });
      await toComments();
      await sleep(600);
      perf.comments = await framesDuring('scrolling the comments', async () => { await wheel(info.x, 400, 16, 100, 100); await sleep(400); await wheel(info.x, 400, 10, -100, 100); await sleep(500); });
      await scrollTo(0);
      await sleep(600);
      perf.scrollPaint = await paintsDuring('scrolling the video view', async () => { await wheel(info.x, info.y, 10, 100, 110); await sleep(300); await wheel(info.x, info.y, 10, -100, 110); await sleep(400); });
      // the same span with no input: what paints anyway while the video plays (the control for the line above)
      await sleep(600);
      perf.idlePaint = await paintsDuring('the same 2.9 s with no scrolling (control)', async () => { await sleep(2900); });
    }
    if (!has('no-cpu')) {
      await scrollTo(0);
      await sleep(3000);
      perf.cpuPlaying = await cpuOver(q.child.pid, 20000);
      if (vg) await vg.ev('(() => { const v = document.querySelector("video"); v.pause(); return 1; })()').catch(() => 0);
      await sleep(3000);
      perf.cpuPaused = await cpuOver(q.child.pid, 20000);
      say('idle CPU (whole tree, % of one core): video view playing ' + perf.cpuPlaying + ', paused ' + perf.cpuPaused);
      if (vg) await vg.ev('(() => { const v = document.querySelector("video"); v.play(); return 1; })()').catch(() => 0);
    }

    /* ---- reduced motion: a still field, no refresh ---- */
    if (AMB && !SHOTS_ONLY) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await sleep(5000);
      const r0 = await amb();
      await sleep(9000);
      const r1 = await amb();
      check(r1.on && !r1.refreshing && r1.samples === r0.samples, 'reduced motion: the still field stays, nothing refreshes', { on: r1.on, refreshing: r1.refreshing, samples: [r0.samples, r1.samples], why: r1.why });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    }

    /* ---- the worst case: a white video ---- */
    if (vg) vg.close();
    await play(WHITE, 'A white test card');
    await pvWait('x.boxed && x.applied && x.phase === "ready" && /whiteTest01/.test(x.url)', 20000);
    await chrome.waitFor('document.querySelector("#lumen-pv-comments .cm-item") ? 1 : 0', 15000).catch(() => 0);
    if (AMB) await ambWait('a.src === "frame" && /whiteTest01/.test(a.key)', 15000); else await sleep(5000);
    const TEXT = ['.wp-title', '.pv-title', '.pv-chan-name', '.pv-subs', '.pv-desc-meta', '.pv-desc-text', '.cm-count', '.cm-author', '.cm-time', '.cm-text', '.cm-like-n', '.cm-replies'];
    for (const [w, h] of [[1919, 942], [1280, 800]]) {
      await resize(w, h);
      await scrollTo(0);
      const a = await shot('white-video', w, h, 1800);
      await toComments();
      const b = await shot('white-video-comments', w, h, 1200);
      await scrollTo(0);
      if (!SHOTS_ONLY && a && b) {
        // the top shot: the info's words; the comments shot: the comments' words (both in view there)
        const ca = await contrastOf(a, TEXT.slice(0, 6));
        await toComments(); await sleep(900);
        const cb = await contrastOf(b, TEXT.slice(6));
        await scrollTo(0);
        const all = ca.concat(cb);
        const bad = all.filter((x) => x.ratio < x.need);
        check(all.length >= 8 && bad.length === 0, 'a WHITE video at ' + w + 'x' + h + ': every text over the field is WCAG AA (min ' + Math.min(...all.map((x) => x.ratio)) + ':1)', bad.length ? bad : all);
      }
    }

    /* ============================ 2. Shorts ============================ */
    await chrome.ev(`openInLumen(${JSON.stringify(FY + '/shorts/' + S[0].id)}, { service: 'youtube', title: 'Shorts' }), 1`);
    let x = await shWait(`x.on && x.applied && x.phase === 'ready' && x.cur === ${JSON.stringify(S[0].id)}`, 20000);
    check(!!x, 'a Short plays in Lumen’s Shorts view', x && { phase: x.phase, cur: x.cur, why: x.why });
    const sg = await guestFor((y) => String(y.url).indexOf(FY + '/shorts/') === 0);
    if (sg) await sg.waitFor('(() => { const v = document.querySelector("ytd-reel-video-renderer[is-active] video"); return v && !v.paused && v.currentTime > 0.4; })()', 15000).catch(() => 0);
    if (AMB && !SHOTS_ONLY) {
      const a = await ambWait('a.on && a.mode === "sh" && a.paints > 0 && a.key.indexOf(' + JSON.stringify(S[0].id) + ') >= 0', 10000);
      check(!!a, 'the Shorts view has the ambient field, for this Short', a || await amb());
      await ambWait('a.src === "frame"', 10000);
    } else await sleep(4000);
    for (const [w, h] of SIZES) {
      await resize(w, h);
      await shot('shorts', w, h, 1800);
    }
    if (!SHOTS_ONLY) {
      const png = await shot('white-shorts-check', 1919, 942, 600);
      if (png) {
        const c = await contrastOf(png, ['.sh-kicker', '.sh-title', '.pv-chan-name', '.sh-hint', '.pv-btn-txt']);
        const bad = c.filter((y) => y.ratio < y.need);
        check(c.length >= 3 && bad.length === 0, 'Shorts: the info’s words are WCAG AA on its island (min ' + Math.min(...c.map((y) => y.ratio)) + ':1)', bad.length ? bad : c);
      }
      try { fs.unlinkSync(path.join(SHOTS, PREFIX + '-white-shorts-check-1919x942.png')); } catch (e) { /* kept */ }
      // the group: reel | capsule | island, 16px apart, all on the reel's baseline; both halves' glyphs readable; an initial for a placeholder avatar
      const g = await chrome.ev(`(() => { const t = document.querySelector('.wp-layer .wp-tile.sh'); if (!t) return null; const R = (n) => { const r = n.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
        const btns = [...t.querySelectorAll('.sh-nav button')]; const av = t.querySelector('.sh-info .pv-avatar'); const img = av && av.querySelector('img');
        return { view: R(t.querySelector('.wp-view')), nav: R(t.querySelector('.sh-nav')), info: R(t.querySelector('.sh-info')), cap: btns.length ? { t: R(btns[0]).t, b: R(btns[btns.length - 1]).b } : null,
          glyph: btns.map((b) => ({ c: getComputedStyle(b).color, o: getComputedStyle(b).opacity, bg: getComputedStyle(b).backgroundColor, dis: b.disabled })),
          av: av ? { txt: av.textContent.trim(), img: img ? { w: img.naturalWidth, h: img.naturalHeight } : null } : null }; })()`);
      const gapA = g && g.nav.l - g.view.r, gapB = g && g.info.l - g.nav.r;
      check(!!g && Math.abs(gapA - gapB) <= 1 && gapA >= 12 && gapA <= 20 && Math.abs(g.info.b - g.view.b) <= 1 && g.cap && Math.abs(g.cap.b - g.view.b) <= 1,
        'Shorts: reel, capsule and island sit together on the reel’s baseline (equal gaps)', g && { gapA, gapB, info: g.info, view: g.view, cap: g.cap });
      const cOk = (y) => { const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(y.c), n = /(\d+),\s*(\d+),\s*(\d+)/.exec(y.bg); return m && n && +y.o >= 0.99 && ratio(lum(+m[1], +m[2], +m[3]), lum(+n[1], +n[2], +n[3])) >= 4.5; };
      check(!!g && g.glyph.length === 2 && g.glyph.every(cOk), 'Shorts: both halves of the capsule have readable glyphs (a disabled one dims, still 4.5:1)', g && g.glyph);
      check(!!g && !!g.av && (g.av.img ? g.av.img.w > 2 && g.av.img.h > 2 : /^[A-Z0-9À-ɏ]$/i.test(g.av.txt)), 'Shorts: a placeholder avatar shows the channel’s initial, never an empty ring', g && g.av);
    }
    // the next Short: the field follows it
    const nextBtn = await chrome.ev('(() => { const b = document.querySelectorAll(".wp-layer .sh-nav button")[1]; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
    const pressNext = async () => { if (!nextBtn) return; for (const type of ['mousePressed', 'mouseReleased']) await chrome.send('Input.dispatchMouseEvent', { type, x: nextBtn.x, y: nextBtn.y, button: 'left', clickCount: 1 }); };
    perf.shorts = await framesDuring('moving between Shorts', async () => { await pressNext(); await sleep(1800); });
    x = await shWait(`x.cur === ${JSON.stringify(S[1].id)} && x.phase === 'ready'`, 10000);
    check(!!x, 'Next moves to the next Short', x && { cur: x.cur });
    if (AMB && !SHOTS_ONLY) {
      const a = await ambWait('a.key.indexOf(' + JSON.stringify(S[1].id) + ') >= 0 && a.paints > 0', 10000);
      check(!!a && asked.indexOf(S[1].id) >= 0, 'the field follows the current Short (its still, then its frame)', a || await amb());
    }
    await sleep(2500);
    await shot('shorts-next', 1919, 942, 1800);
    const more = await framesDuring('moving between Shorts (2)', async () => { await pressNext(); await sleep(1600); await pressNext(); await sleep(1800); });
    perf.shorts.n += more.n; perf.shorts.over = perf.shorts.over.concat(more.over); perf.shorts.max = Math.max(perf.shorts.max, more.max); perf.shorts.longTasks = (perf.shorts.longTasks || []).concat(more.longTasks || []);
    if (!has('no-cpu')) {
      await sleep(3000);
      perf.cpuShorts = await cpuOver(q.child.pid, 20000);
      say('idle CPU (whole tree, % of one core): Shorts playing ' + perf.cpuShorts);
    }

    /* ---- multiview and the corner: no field ---- */
    if (AMB && !SHOTS_ONLY) {
      await chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=' + VID)}, { service: 'youtube', title: 'Second', multi: true }), 1`);
      const m = await ambWait('!a.on', 10000);
      const n = await chrome.ev('WatchPlayer._state().n');
      check(!!m && n >= 2 && !m.refreshing, 'multiview (' + n + ' tiles): no ambient field, no refresh', m || await amb());
      const vis = await chrome.ev('(() => { const n = document.querySelector(".wp-layer .amb"); return n ? getComputedStyle(n).opacity + "/" + getComputedStyle(n).display : "none"; })()');
      check(/^0\/|\/none$|^none$/.test(vis), 'multiview: the field is not drawn', vis);
    }

    /* ---- the numbers ---- */
    const lts = await chrome.ev('window.__lt');
    perf.longTasks = lts;
    // the harness's own window resizes and captures (a resize relayouts the whole chrome; a capture hands it a PNG of several MB) are not the app's
    const own = await chrome.ev('(() => (window.__lt2 || []).filter((e) => e[1] > 50 && !(window.__cap || []).some((c) => e[0] + e[1] > c[0] && e[0] < c[1])).map((e) => Math.round(e[1])))()');
    perf.longOver50All = Array.isArray(lts) ? lts.filter((d) => d > 50) : null;
    perf.longOver50 = Array.isArray(own) ? own : perf.longOver50All;
    say('long tasks over 50 ms: ' + JSON.stringify(perf.longOver50All) + ' in all, ' + JSON.stringify(perf.longOver50) + ' outside the harness’s own resizes and captures');
    if (AMB) perf.amb = await amb();
    if (PERF_OUT) fs.writeFileSync(PERF_OUT, JSON.stringify(perf, null, 1));
    say('perf ' + JSON.stringify({ scroll: perf.scroll && { n: perf.scroll.n, over: perf.scroll.over.length, max: perf.scroll.max }, comments: perf.comments && { n: perf.comments.n, over: perf.comments.over.length, max: perf.comments.max },
      shorts: perf.shorts && { n: perf.shorts.n, over: perf.shorts.over.length, max: perf.shorts.max }, paint: perf.scrollPaint, cpu: [perf.cpuPlaying, perf.cpuPaused, perf.cpuShorts], longOver50: perf.longOver50 }));
    if (!SHOTS_ONLY) {
      let base = null;
      try { base = BASELINE ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null; } catch (e) { base = null; }
      for (const k of ['scroll', 'comments', 'shorts']) {
        const fr = perf[k];
        if (!fr) { check(false, 'frames ' + k + ': measured'); continue; }
        const b = base && base[k];
        if (b) check(fr.over.length <= b.over.length && fr.max <= Math.max(24, b.max + 4), 'frames over 20 ms ' + k + ': ' + fr.over.length + ' (max ' + fr.max + ' ms); the old code ' + b.over.length + ' (max ' + b.max + ' ms)', fr.over);
        else check(fr.over.length === 0, 'frames over 20 ms ' + k + ': ' + fr.over.length + ' (max ' + fr.max + ' ms)', fr.over);
      }
      if (perf.scrollPaint) {
        const b = base && base.scrollPaint;
        check(b ? perf.scrollPaint.big <= b.big : perf.scrollPaint.big === 0, 'scrolling repaints no big layer: ' + perf.scrollPaint.big + ' paints over a quarter of the window' + (b ? ' (the old code ' + b.big + ')' : ''), perf.scrollPaint);
      }
      check(!perf.longOver50 || perf.longOver50.length === 0 || (base && base.longOver50 && perf.longOver50.length <= base.longOver50.length), 'long tasks over 50 ms in the chrome: ' + (perf.longOver50 ? perf.longOver50.length : 'n/a') + (base && base.longOver50 ? ' (the old code ' + base.longOver50.length + ')' : ''), perf.longOver50);
      if (base && !has('no-cpu')) say('idle CPU before -> after: playing ' + base.cpuPlaying + ' -> ' + perf.cpuPlaying + ', paused ' + base.cpuPaused + ' -> ' + perf.cpuPaused + ', Shorts ' + base.cpuShorts + ' -> ' + perf.cpuShorts);
    }
    say('shots: ' + shotFiles.length);
    if (vg) vg.close();
    if (sg) sg.close();
    await q.quit();
  } finally {
    srv.close();
    try { if (mock.close) await mock.close(); } catch (e) { /* gone */ }
    try { fs.unlinkSync(CPU_PS); } catch (e) { /* gone */ }
  }
});
