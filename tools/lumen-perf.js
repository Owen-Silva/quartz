require('./lowcpu-optional.js');   // first: the CPU cap, when one is configured (lowcpu-optional.js; none on a cloud runner)
// tools/lumen-perf.js -- Lumen's responsiveness budget, measured, in one table. Re-run before every release.
//
//   node tools/lumen-perf.js [--cdp 9620] [--reps 1] [--trace <dir>] [--json <file>] [--only a,b] [--idle 20]
//
// A REAL hidden Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen, watched by testwatch.js) on LOCAL
// FIXTURES ONLY: every service origin is rebased to a local front (tests/watch-mock.js rows, tests/comments-fixtures.js
// for /watch and its comments, tests/shorts-fixtures.js for /shorts, the synthetic clip), YouTube's stills are drawn
// locally (tests/watch-yt-stills.js), the hover preview's player is a local mock page (QUARTZ_WATCH_PREVIEW_MOCK=1),
// and every other host name resolves nowhere. Never a real account, cookie or service.
//
// What it measures (The user 10-18: "make sure nothing is laggy and everything is super responsive"), at the machine's
// own scale factor, the window kept in front of the z-order (not occluded) the way watch-e2e's --measure does:
//   feedback   input -> next paint (the Event Timing API) for every key and click: budget 100 ms
//   open       click -> the view shows (content or its skeleton), measured in the page that draws it: budget 300 ms
//              (the Lumen tab from the toolbar button, cold and warm; the video view; Shorts; search results)
//   frames     rAF intervals over 20 ms while stepping rows, wheeling rows, hovering tiles (and their previews),
//              scrolling the video view and its comments, and moving between Shorts: budget 0
//   long tasks main-thread tasks over 50 ms (PerformanceObserver longtask) in the Lumen page AND the Quartz window
//              during those interactions: budget 0
//   idle       CPU of the whole test tree, Lumen at rest in front vs a plain new tab, and timer / rAF wake-ups per
//              second in each renderer (a short trace)
//   memory     heap (after a GC), DOM nodes, listeners, <webview>s and CDP targets across 20 Shorts moves and 10
//              video view open/close cycles: must not grow
// --trace <dir>: a Chromium trace of each interaction, and for every long frame the busiest threads in that window
// with wall time vs thread (CPU) time: a frame whose threads were mostly NOT running was the machine, not Lumen.
// Kills only what it started. Last line: "lumen-perf: N passed, M failed" (each budget line is one check).
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const APPDIR = path.join(__dirname, '..');
const { run, Cdp, sleep } = require(path.join(APPDIR, 'tests', 'e2e-kit'));
const Mock = require(path.join(APPDIR, 'tests', 'watch-mock'));
const Stills = require(path.join(APPDIR, 'tests', 'watch-yt-stills'));
const X = require(path.join(APPDIR, 'tests', 'comments-fixtures'));
const SF = require(path.join(APPDIR, 'tests', 'shorts-fixtures'));
const { sendClip } = require(path.join(APPDIR, 'tests', 'fixture-clip'));
let PV = null; try { PV = require(path.join(APPDIR, 'watch', 'preview')); } catch (e) { PV = null; }

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9620'));
const REPS = Math.max(1, Number(opt('reps', '1')) || 1);
const TRACE_DIR = opt('trace', '');
const JSON_OUT = opt('json', '');
const ONLY = opt('only', '') ? opt('only', '').split(',') : null;
const IDLE_S = Math.max(5, Number(opt('idle', '20')) || 20);
const want = (k) => !ONLY || ONLY.includes(k);
// --cold-only: measure the cold Lumen open (toolbar click -> the guest's first contentful paint) and stop there.
// --coldtrace <dir>: a browser-wide trace (every process) of that cold open, for tools' breakdown of where it goes.
const COLD_ONLY = argv.includes('--cold-only');
const COLD_TRACE = opt('coldtrace', '');
const COLD_TAG = opt('tag', String(process.pid));
// --exp <js>: an expression run in the Quartz window just before the cold click (an A/B experiment, e.g. a suspect turned off).
const COLD_EXP = opt('exp', '');
const COLD_CATS = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink.user_timing', 'loading',
  'navigation', 'browser', 'content', 'renderer_host', 'blink', 'rail', 'electron', 'startup', '__metadata'];
const MOCK_ORIGIN = (PV && PV.MOCK_ORIGIN) || 'https://quartz-preview.invalid';
const BUDGET = { feedback: 100, open: 300, frame: 20, longtask: 50 };
const TRACE_CATS = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
  'toplevel', 'blink', 'cc', 'gpu', 'viz', 'benchmark', 'v8.execute', 'blink.user_timing'];

/* ---- the local fronts: one per service; YouTube's /watch, its comments and /shorts are fixtures ---------------- */
function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 2000;
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, origin: 'http://127.0.0.1:' + s.address().port }));
  });
}
function sendHtml(res, body) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); }
async function startServers(mock) {
  const fronts = {};
  for (const svc of Mock.SERVICES) {
    fronts[svc] = await listen((req, res) => {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      const p = u.pathname.replace(/\/+$/, '') || '/';
      if (p === '/__media/clip.mp4' || p === '/__media/short.mp4') return sendClip(req, res);
      if (svc === 'youtube' && p === '/watch') return sendHtml(res, X.watch({ signedout: false, cm: '', vid: u.searchParams.get('v') || 'pvTest00001' }));
      if (svc === 'youtube' && p === '/youtubei/v1/next' && req.method === 'POST') {
        let raw = '';
        req.on('data', (d) => { raw += d; });
        req.on('end', () => {
          let body = {}; try { body = JSON.parse(raw); } catch (e) { body = {}; }
          let vid = 'pvTest00001'; try { vid = new URL(String(req.headers.referer || '')).searchParams.get('v') || vid; } catch (e) { /* default */ }
          const out = X.next(body, '', vid);
          res.writeHead(out.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out.json));
        });
        return undefined;
      }
      const m = /^\/shorts\/([A-Za-z0-9_-]{6,20})$/.exec(p);
      if (svc === 'youtube' && m) return sendHtml(res, SF.shortsPage(m[1], {}));
      const up = http.request({ host: '127.0.0.1', port: mock.ports[svc], path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + mock.ports[svc] }) }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
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
// The hover preview's player (the e2e's mock: it says "playing" the way YouTube's iframe API does, and animates).
function playerHtml(id) {
  return '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:#000}' +
    '#v{position:absolute;inset:0;background:linear-gradient(115deg,#24313d,#46525e 50%,#7a5c46)}#b{position:absolute;left:0;top:0;bottom:0;width:18%;background:rgba(255,255,255,.14);animation:s 2.4s linear infinite}' +
    '@keyframes s{from{transform:translateX(-100%)}to{transform:translateX(560%)}}</style></head><body><div id="v"></div><div id="b"></div><script>' +
    'var t0=0,iv=0;function post(o){parent.postMessage(JSON.stringify(o),"*");}window.addEventListener("message",function(e){var d;try{d=JSON.parse(e.data);}catch(x){return;}' +
    'if(!d||d.event!=="listening"||t0)return;t0=Date.now();post({event:"initialDelivery",info:{playerState:-1,duration:300}});setTimeout(function(){post({event:"onStateChange",info:1});},150);' +
    'iv=setInterval(function(){post({event:"infoDelivery",info:{currentTime:(Date.now()-t0)/1000,duration:300}});},500);});</script></body></html><!-- ' + id + ' -->';
}

/* ---- CDP helpers ------------------------------------------------------------------------------------------------ */
async function targetWhere(q, pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    let list = []; try { list = await q.targets(); } catch (e) { list = []; }
    const t = list.find((x) => x.webSocketDebuggerUrl && pred(x));
    if (t) return t;
    await sleep(100);
  }
  return null;
}
/** A CDP client for a page, with YouTube's stills and the preview player answered locally (Fetch). */
async function attach(t, stillsPage) {
  const c = await new Cdp(t.webSocketDebuggerUrl).open();
  c.handlers = [];
  c.ws.on('message', (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (m.method === 'Fetch.requestPaused') {
      const rid = m.params.requestId, u = String(m.params.request.url);
      if (u.indexOf(MOCK_ORIGIN + '/') === 0) {
        const id = (/\/embed\/([A-Za-z0-9_-]{11})/.exec(u) || [])[1] || '';
        c.send('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(playerHtml(id)).toString('base64') });
        return;
      }
      const p = Stills.parse(u);
      const r = p ? Stills.answer(stillsPage || c, u.replace(/\/(vi|vi_webp)\/[A-Za-z0-9_-]{11}\//, '/$1/watchE2E000/'), 'Lumen perf still') : Promise.resolve(null);
      r.then((x) => c.send('Fetch.fulfillRequest', x ? { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: x.mime }], body: x.body.toString('base64') }
        : { requestId: rid, responseCode: 404, responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }], body: '' }), () => c.send('Fetch.failRequest', { requestId: rid, errorReason: 'Failed' }));
    }
    for (const h of c.handlers) { try { h(m); } catch (e) { /* a handler */ } }
  });
  await c.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*.ytimg.com/*', resourceType: 'Image', requestStage: 'Request' }, { urlPattern: MOCK_ORIGIN + '/*', requestStage: 'Request' }] });
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => 0);
  await c.send('Performance.enable').catch(() => 0);
  c.target = t;
  return c;
}
async function key(c, k, code, vk, text) {
  const base = { key: k, code: code || k, windowsVirtualKeyCode: vk || 0, nativeVirtualKeyCode: vk || 0, modifiers: 0 };
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  if (text) await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'char', text }, base));
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}
const VK = { ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Escape: 27, Enter: 13, Tab: 9, Backspace: 8 };
async function click(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/* ---- the in-page probe: long tasks, Event Timing, frames, "first frame where X is true" (all on node's clock) ----- */
const PROBE = `(() => {
  if (window.__lp) return 'again';
  const lp = window.__lp = { fr: null, lt: [], ev: [], waits: {} };
  const abs = (t) => performance.timeOrigin + t;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { const a = e.attribution && e.attribution[0]; lp.lt.push({ at: abs(e.startTime), ms: Math.round(e.duration), by: a ? (a.containerType + ':' + (a.containerSrc || a.containerName || a.name || '')).slice(0, 80) : '' }); } if (lp.lt.length > 4000) lp.lt.splice(0, 2000); }).observe({ type: 'longtask' }); } catch (e) { lp.ltErr = String(e); }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) lp.ev.push({ at: abs(e.startTime), name: e.name, dur: e.duration, proc: Math.round(e.processingEnd - e.processingStart), delay: Math.round(e.processingStart - e.startTime), tgt: e.target ? (e.target.id || e.target.className || e.target.tagName || '').toString().slice(0, 40) : '' }); if (lp.ev.length > 4000) lp.ev.splice(0, 2000); }).observe({ type: 'event', durationThreshold: 16 }); } catch (e) { lp.evErr = String(e); }
  lp.now = () => abs(performance.now());
  lp.start = () => { const x = lp.fr = { d: [], at: [] }; let last = -1; const f = (t) => { if (x.stop) return; if (last >= 0) { x.d.push(t - last); x.at.push(abs(t)); } last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); return lp.now(); };
  lp.stop = () => { const x = lp.fr; lp.fr = null; if (!x) return { d: [], at: [] }; x.stop = true; return { d: x.d.map((v) => Math.round(v * 10) / 10), at: x.at }; };
  // The frame after the one in which fn() first held: by then what it drew is on screen.
  lp.when = (fn, ms) => new Promise((res) => { const t0 = performance.now(); const f = () => { let ok = false; try { ok = !!fn(); } catch (e) { ok = false; }
    if (ok) requestAnimationFrame((t) => res(abs(t))); else if (performance.now() - t0 > (ms || 15000)) res(0); else requestAnimationFrame(f); }; requestAnimationFrame(f); });
  return 'ok';
})()`;
/** The page clock minus node's (ms), from the round trip with the shortest wait. */
async function clockSkew(c) {
  let best = null;
  for (let i = 0; i < 7; i++) {
    const a = Date.now() + (performance.timeOrigin % 1);
    const t = await c.ev('performance.timeOrigin + performance.now()').catch(() => NaN);
    const b = Date.now();
    if (!best || b - a < best.rtt) best = { rtt: b - a, skew: t - (a + b) / 2 };
  }
  return best ? best.skew : 0;
}
async function probe(c) { await c.ev(PROBE); c.skew = await clockSkew(c); return c; }
const toNode = (c, t) => t - (c.skew || 0);
async function mark(c) { return toNode(c, await c.ev('__lp.now()')); }
async function since(c, t0) {
  const r = await c.ev('({ lt: __lp.lt.slice(), ev: __lp.ev.slice() })');
  const lt = r.lt.map((x) => Object.assign(x, { at: toNode(c, x.at) })).filter((x) => x.at >= t0 - 5);
  const ev = r.ev.map((x) => Object.assign(x, { at: toNode(c, x.at) })).filter((x) => x.at >= t0 - 5);
  return { lt, ev };
}
async function metrics(c, gc) {
  if (gc) { await c.send('HeapProfiler.enable').catch(() => 0); await c.send('HeapProfiler.collectGarbage').catch(() => 0); await sleep(150); await c.send('HeapProfiler.collectGarbage').catch(() => 0); }
  const m = await c.send('Performance.getMetrics');
  const o = {}; for (const x of ((m.result && m.result.metrics) || [])) o[x.name] = x.value;
  return { heapMB: +(o.JSHeapUsedSize / 1048576).toFixed(2), nodes: o.Nodes, listeners: o.JSEventListeners, docs: o.Documents, frames: o.Frames, layoutObjects: o.LayoutObjects };
}

/* ---- tracing: one Chromium trace per interaction, and why each long frame was long --------------------------- */
async function traceStart(c) {
  if (!TRACE_DIR) return false;
  const r = await c.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: TRACE_CATS } });
  if (r.error) return false;
  await sleep(250);
  return true;
}
async function traceStop(c, name) { return traceStopTo(c, TRACE_DIR, name); }
async function traceStopTo(c, dir, name) {
  let resolve; const done = new Promise((r) => { resolve = r; });
  const h = (m) => { if (m.method === 'Tracing.tracingComplete') resolve(m.params || {}); };
  c.handlers.push(h);
  await c.send('Tracing.end');
  const p = await Promise.race([done, sleep(60000).then(() => null)]);
  c.handlers.splice(c.handlers.indexOf(h), 1);
  if (!p || !p.stream) return '';
  const file = path.join(dir, name + '.trace.json');
  const fd = fs.openSync(file, 'w');
  try {
    for (;;) {
      const r = (await c.send('IO.read', { handle: p.stream, size: 4 << 20 })).result || {};
      if (r.data) fs.writeSync(fd, r.base64Encoded ? Buffer.from(r.data, 'base64') : Buffer.from(r.data, 'utf8'));
      if (r.eof || !r.data) break;
    }
  } finally { fs.closeSync(fd); await c.send('IO.close', { handle: p.stream }).catch(() => 0); }
  return file;
}
/** The cold open's trace: on the BROWSER target, so every process (browser, the Quartz window, the new guest, GPU) is in it. */
async function coldTraceStart(noWait) {
  let ver = null; try { ver = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); } catch (e) { ver = null; }
  if (!ver || !ver.webSocketDebuggerUrl) return null;
  const c = await new Cdp(ver.webSocketDebuggerUrl).open();
  c.handlers = [];
  c.ws.on('message', (raw) => { let m; try { m = JSON.parse(String(raw)); } catch (e) { return; } for (const h of c.handlers) { try { h(m); } catch (e) { /* a handler */ } } });
  fs.mkdirSync(COLD_TRACE, { recursive: true });
  const r = await c.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: COLD_CATS } });
  if (r.error) { try { c.ws.close(); } catch (e) { /* gone */ } return null; }
  if (!noWait) await sleep(250);
  return c;
}
async function coldTraceStop(c, name) {
  try { return await traceStopTo(c, COLD_TRACE, name); } finally { try { c.ws.close(); } catch (e) { /* gone */ } }
}
/**
 * For each long frame (node-clock window [a, b]): per thread of the renderer that drew it, the GPU process and the
 * browser, the busiest top-level tasks with wall ms and thread (CPU) ms. "ran" = CPU ms / wall ms of those tasks: a
 * frame where the busy threads mostly did NOT run (low ran) was waiting on the machine's scheduler, not on work.
 */
function explain(file, longFrames, rendererUrlHint, offsetMs) {
  let raw; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { error: 'unreadable trace: ' + e.message }; }
  const ev = Array.isArray(raw) ? raw : (raw.traceEvents || []);
  const thread = {}, proc = {};
  for (const e of ev) if (e.ph === 'M' && e.args) { if (e.name === 'thread_name') thread[e.pid + ':' + e.tid] = e.args.name; else if (e.name === 'process_name') proc[e.pid] = e.args.name; }
  // node ms -> trace us: the lp-mark TimeStamp the harness logged (console.timeStamp) carries both clocks
  const marks = ev.filter((e) => e.name === 'TimeStamp' && e.args && e.args.data && /^lp-sync /.test(String(e.args.data.message || '')));
  if (!marks.length) return { error: 'no lp-sync mark in the trace' };
  const mk = marks[0];
  const nodeAt = Number(String(mk.args.data.message).split(' ')[1]);
  const us = (ms) => mk.ts + (ms - nodeAt) * 1000;
  const rpid = mk.pid;
  const top = ev.filter((e) => e.ph === 'X' && e.dur && (e.pid === rpid || /gpu/i.test(proc[e.pid] || '') || /browser/i.test(proc[e.pid] || ''))
    && /^(ThreadControllerImpl::RunTask|RunTask|TaskQueueManager::ProcessTaskFromWorkQueue|SequenceManager.*|ThreadPool_RunTask|MessageLoop::RunTask|Scheduler::.*|ProxyMain::BeginMainFrame|Graphics\.Pipeline|DrmEventFlipComplete)$/.test(e.name));
  // top-level tasks only: a task nested inside another on the same thread is not counted twice
  const byThread = new Map();
  for (const e of top) { const k = e.pid + ':' + e.tid; if (!byThread.has(k)) byThread.set(k, []); byThread.get(k).push(e); }
  const flat = [];
  for (const list of byThread.values()) { list.sort((p, q) => p.ts - q.ts || q.dur - p.dur); let end = -Infinity; for (const e of list) { if (e.ts < end) continue; flat.push(e); end = e.ts + e.dur; } }
  const out = [];
  for (const lf of longFrames.slice(0, 12)) {
    const a = us(lf.at - lf.dt), b = us(lf.at);
    const per = {};
    for (const e of flat) {
      const s = Math.max(a, e.ts), t = Math.min(b, e.ts + e.dur);
      if (t <= s) continue;
      const th = (e.pid === rpid ? 'renderer' : /gpu/i.test(proc[e.pid] || '') ? 'gpu' : 'browser') + ':' + (thread[e.pid + ':' + e.tid] || e.tid);
      const r = per[th] || (per[th] = { wall: 0, cpu: 0, n: 0, longest: 0, what: '' });
      const frac = (t - s) / e.dur;
      r.wall += (t - s) / 1000; r.cpu += (e.tdur ? e.tdur * frac : (t - s)) / 1000; r.n++;
      const src = e.args && e.args.src_func ? e.args.src_file + ':' + e.args.src_func : (e.args && e.args.src ? String(e.args.src) : '');
      if (e.dur > r.longest) { r.longest = e.dur; r.what = (src || e.name).slice(0, 90); }
    }
    // main-thread blink work inside the window, by name
    const blink = {};
    for (const e of ev) {
      if (e.pid !== rpid || e.ph !== 'X' || !e.dur || (thread[e.pid + ':' + e.tid] || '') !== 'CrRendererMain') continue;
      if (!/^(FunctionCall|EvaluateScript|TimerFire|FireAnimationFrame|EventDispatch|UpdateLayoutTree|Layout|Paint|PrePaint|Layerize|Commit|ParseHTML|Decode Image|ImageDecodeTask|v8\.callFunction|MajorGC|MinorGC|V8\.GC.*|HitTest|ScrollLayer|UpdateLayer|IntersectionObserverController::computeIntersections|ResizeObserverController::BroadcastObservations)$/.test(e.name)) continue;
      const s = Math.max(a, e.ts), t = Math.min(b, e.ts + e.dur);
      if (t <= s) continue;
      const nm = e.name + (e.args && e.args.data && (e.args.data.functionName || e.args.data.type) ? ' ' + (e.args.data.functionName || e.args.data.type) : '');
      blink[nm] = (blink[nm] || 0) + (t - s) / 1000;
    }
    const threads = Object.entries(per).map(([th, r]) => ({ th, wall: +r.wall.toFixed(1), cpu: +r.cpu.toFixed(1), n: r.n, longest: +(r.longest / 1000).toFixed(1), what: r.what }))
      .sort((p, q) => q.wall - p.wall).slice(0, 6);
    // the frame's critical threads (the VSync thread waits by design and is not one of them)
    const busiest = threads.filter((t) => /CrRendererMain|Compositor|CrGpuMain|VizCompositor|CrBrowserMain/.test(t.th))[0];
    out.push({ dt: lf.dt, at: Math.round(lf.at - (offsetMs || 0)), threads, mainWork: Object.entries(blink).sort((p, q) => q[1] - p[1]).slice(0, 8).map(([n, ms]) => n + ' ' + ms.toFixed(1)),
      ran: busiest && busiest.wall ? +(busiest.cpu / busiest.wall).toFixed(2) : null });
  }
  return { rendererPid: rpid, process: proc[rpid] || '', frames: out };
}
/** Idle wake-ups from a trace: per renderer / process, timer fires, rAF callbacks and tasks per second. */
function wakeups(file, seconds) {
  let raw; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { error: e.message }; }
  const ev = Array.isArray(raw) ? raw : (raw.traceEvents || []);
  const thread = {}, proc = {}, label = {};
  for (const e of ev) if (e.ph === 'M' && e.args) { if (e.name === 'thread_name') thread[e.pid + ':' + e.tid] = e.args.name; else if (e.name === 'process_name') proc[e.pid] = e.args.name; else if (e.name === 'process_labels') label[e.pid] = e.args.labels; }
  const per = {};
  for (const e of ev) {
    if (e.ph !== 'X' && e.ph !== 'I' && e.ph !== 'i') continue;
    const th = thread[e.pid + ':' + e.tid] || '';
    if (th !== 'CrRendererMain' && th !== 'CrBrowserMain') continue;
    const k = (proc[e.pid] || 'pid') + ' ' + e.pid + (label[e.pid] ? ' (' + String(label[e.pid]).slice(0, 40) + ')' : '');
    const r = per[k] || (per[k] = { timers: 0, raf: 0, frames: 0, tasks: 0, cpuMs: 0, fn: {} });
    if (e.name === 'TimerFire') r.timers++;
    else if (e.name === 'FireAnimationFrame') r.raf++;
    else if (e.name === 'BeginMainThreadFrame' || e.name === 'BeginFrame') r.frames++;
    else if (e.name === 'ThreadControllerImpl::RunTask') { r.tasks++; r.cpuMs += (e.tdur || e.dur || 0) / 1000; }
    if (e.name === 'FunctionCall' && e.args && e.args.data) { const f = (e.args.data.functionName || '?') + '@' + String(e.args.data.url || '').split('/').pop() + ':' + e.args.data.lineNumber; r.fn[f] = (r.fn[f] || 0) + 1; }
  }
  const out = {};
  for (const [k, r] of Object.entries(per)) out[k] = { timersPerS: +(r.timers / seconds).toFixed(2), rafPerS: +(r.raf / seconds).toFixed(2), tasksPerS: +(r.tasks / seconds).toFixed(1), cpuMsPerS: +(r.cpuMs / seconds).toFixed(2),
    topCalls: Object.entries(r.fn).sort((p, q) => q[1] - p[1]).slice(0, 5).map(([f, n]) => f + ' x' + n) };
  return out;
}

/* ---- CPU of the whole test tree (the window brought to the top of the z-order first: never measured occluded) ---- */
const CPU_PS = String.raw`param([int]$Root, [int]$Seconds)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class LPW {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
$cb = [LPW+EnumProc]{ param($h, $p)
  $wp = 0; [LPW]::GetWindowThreadProcessId($h, [ref]$wp) | Out-Null
  if ($wp -eq $Root -and [LPW]::IsWindowVisible($h)) { [LPW]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0013) | Out-Null }
  return $true }
[LPW]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
function Tree {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine)
  $ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add($Root)
  $more = $true
  while ($more) { $more = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { [void]$ids.Add([int]$p.ProcessId); $more = $true } } }
  $kind = @{}; foreach ($p in $all) { if ($ids.Contains([int]$p.ProcessId)) { $t = 'main'; if ($p.CommandLine -match '--type=([a-z-]+)') { $t = $Matches[1] }; $kind[[int]$p.ProcessId] = $t } }
  return $kind
}
function Cpu($kind) { $o = @{}; foreach ($id in $kind.Keys) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { $o[$id] = @($p.TotalProcessorTime.TotalMilliseconds, $p.PrivateMemorySize64) } }; return $o }
$k0 = Tree; $c0 = Cpu $k0
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Seconds $Seconds
$k1 = Tree; $c1 = Cpu $k1
$ms = $sw.Elapsed.TotalMilliseconds
$total = 0; $mem = 0; $byKind = @{}
foreach ($id in $c1.Keys) { $d = $c1[$id][0]; $mem += $c1[$id][1]; if ($c0.ContainsKey($id)) { $d = $d - $c0[$id][0] }; $total += $d; $t = $k1[$id]; if (-not $byKind.ContainsKey($t)) { $byKind[$t] = 0 }; $byKind[$t] += $d }
$parts = ($byKind.Keys | Sort-Object | ForEach-Object { '"' + $_ + '":' + [math]::Round($byKind[$_] / $ms * 100, 2) }) -join ','
'{"pct":' + [math]::Round($total / $ms * 100, 2) + ',"procs":' + $c1.Count + ',"privMB":' + [math]::Round($mem / 1MB) + ',"ms":' + [math]::Round($ms) + ',"byKind":{' + $parts + '}}'
`;
function cpuSample(pid, seconds) {
  const f = path.join(os.tmpdir(), 'lumen-perf-cpu-' + process.pid + '.ps1');
  fs.writeFileSync(f, CPU_PS);
  return new Promise((resolve) => {
    const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f, '-Root', String(pid), '-Seconds', String(seconds)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => { out += String(d); });
    proc.on('exit', () => { const line = out.split(/\r?\n/).find((l) => l.trim().startsWith('{')); try { resolve(JSON.parse(line)); } catch (e) { resolve({ pct: NaN, error: out.slice(0, 300) }); } });
  });
}

/* ---- the run ---------------------------------------------------------------------------------------------------- */
const LAYER_ON = `(() => { const l = document.querySelector('.wp-layer'); return !!l && !l.hidden && l.classList.contains('wp-in') && +getComputedStyle(l).opacity > 0.5; })()`;
const LAYER_OFF = `(() => { const l = document.querySelector('.wp-layer'); return !l || l.hidden || !WatchPlayer.isOpen(); })()`;
const ROWS_REAL = '[...document.querySelectorAll("#stack .lrow .rt > .card")].filter((c) => c._item && c._item.title).length';

run('lumen-perf', async ({ check, launch, say }) => {
  if (TRACE_DIR) fs.mkdirSync(TRACE_DIR, { recursive: true });
  const mock = await Mock.start({ log: () => {} });
  const srv = await startServers(mock);
  const env = {
    QUARTZ_WATCH_BOOT_GRACE_MS: '0', QUARTZ_WATCH_REBASE: JSON.stringify(srv.rebase), QUARTZ_WATCH_MIN_FREE_GB: '0', QUARTZ_TEST_MIN_FREE_GB: process.env.QUARTZ_TEST_MIN_FREE_GB || '1.5',
    QUARTZ_PLAYER_FLOOR_GB: '0', QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1', QUARTZ_WATCH_PREVIEW_MOCK: '1', QUARTZ_WATCH_TPV_MIN_FREE_GB: '0',
    QUARTZ_EDGE_STUB: path.join(os.tmpdir(), 'lumen-perf-edge-' + process.pid + '.txt'), QUARTZ_WATCH_OPEN_STUB: path.join(os.tmpdir(), 'lumen-perf-open-' + process.pid + '.txt'),
  };
  const args = ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'];
  const R = { reps: [], meta: { node: process.version, at: new Date().toISOString(), load: fs.existsSync(path.join(os.tmpdir(), 'claude-heavytest.mutex2')) ? 'UNDER LOAD (mutex2 held)' : 'clean (mutex2 absent)' } };
  // --boottrace <file>: Chromium's own startup trace (--trace-startup), from the first instant of the process for
  // BOOT_S seconds, so the cold click lands exactly when it does untraced (nothing waits for a trace to start).
  const BOOT_TRACE = opt('boottrace', '');
  // --boot-prof: the V8 sampling profiler in the same trace (JS stacks per process; it slows every process a little)
  if (BOOT_TRACE) args.push('--trace-startup=' + COLD_CATS.concat(argv.includes('--boot-prof') ? ['disabled-by-default-v8.cpu_profiler'] : []).join(','), '--trace-startup-format=json', '--trace-startup-file=' + BOOT_TRACE, '--trace-startup-duration=' + opt('boot-s', '14'));
  // --adblock-cache <engine.bin>: start the profile with a built ad-blocker engine, as an installed profile has. A fresh
  // test profile has none, so main fetches the lists and builds the engine (a 1.0-1.6 s main-thread block, r61-coldopen)
  // at a random moment of the startup, and a cold open that it lands on waits for it.
  const ABC = opt('adblock-cache', '');
  if (ABC) {
    const pd = path.join(os.tmpdir(), 'browser-test-profile-lumenperf' + process.pid);
    fs.mkdirSync(pd, { recursive: true });
    fs.copyFileSync(ABC, path.join(pd, 'adblock-engine.bin'));
    say('ad-blocker engine cache seeded from ' + path.basename(ABC));
  }
  const q = await launch({ cdp: CDP_PORT, env, args });
  // the cold open's trace starts here, as soon as the window is up, so the click still lands when it does untraced
  // (the tail of Quartz's own startup is in the trace too, and nothing waits for the trace before the click)
  let coldTrace = COLD_TRACE ? await coldTraceStart(true) : null;
  const chrome = await attach({ webSocketDebuggerUrl: q.chrome.wsUrl }, null).catch(() => null) || q.chrome;
  if (!chrome.handlers) chrome.handlers = [];
  await probe(chrome);
  chrome.label = "quartz";
  // every still size drawn now, in the Quartz window, before Lumen opens: none is drawn inside a measurement
  for (const n of ['vi_webp/%/maxresdefault.webp', 'vi/%/maxresdefault.jpg', 'vi/%/hq720.jpg', 'vi/%/sddefault.jpg', 'vi/%/sddefault_live.jpg', 'vi/%/hqdefault.jpg', 'vi/%/hqdefault_live.jpg', 'vi/%/mqdefault.jpg', 'vi/%/oardefault.jpg', 'vi/%/frame0.jpg', 'vi/%/default.jpg']) {
    await Stills.answer(chrome, 'https://i.ytimg.com/' + n.replace('%', 'watchE2E000'), 'Lumen perf still').catch(() => 0);
  }
  R.meta.window = await chrome.ev('[innerWidth, innerHeight, devicePixelRatio]');
  say('window ' + JSON.stringify(R.meta.window) + ', ' + R.meta.load);
  let g = null;   // the Lumen page

  const results = {};   // budget line -> [{ v, detail }]
  const add = (line, v, detail) => { (results[line] = results[line] || []).push({ v, detail }); };
  const frameStats = (fr) => { const over = fr.d.filter((v) => v > BUDGET.frame); return { n: fr.d.length, over: over.length, max: fr.d.length ? Math.max.apply(null, fr.d) : 0, list: over.slice(0, 12) }; };
  /** Frames + long tasks + event timing over one interaction, in the pages given; optional trace on `tr`. */
  async function measure(name, pages, fn, o) {
    o = o || {};
    const tr = TRACE_DIR && o.trace !== false ? (o.tracePage || pages[0]) : null;
    const tracing = tr ? await traceStart(tr) : false;
    if (tracing) { const n = Date.now(); await tr.ev('console.timeStamp("lp-sync ' + n + '")'); }   // node's clock, in the trace
    for (const p of pages) await p.ev('__lp.start()');
    await sleep(400);   // the recorders' (and the trace's) own start is not the interaction: frames before t0 are dropped
    const t0 = Date.now();
    let extra = null;
    try { extra = await fn(); } finally { /* stop the recorders whatever happened */ }
    await sleep(o.tail === undefined ? 400 : o.tail);
    const out = { name, pages: {} };
    for (const p of pages) {
      const fr0 = await p.ev('__lp.stop()');
      const keep = fr0.at.map((t, i) => [fr0.d[i], toNode(p, t)]).filter(([dt, at]) => at - dt >= t0 - 2);
      const fr = { d: keep.map((x) => x[0]), at: keep.map((x) => x[1]) };
      const s = await since(p, t0);
      out.pages[p.label] = { frames: frameStats(fr), longTasks: s.lt.filter((x) => x.ms > BUDGET.longtask), events: s.ev, longFrames: fr.d.map((dt, i) => ({ dt, at: fr.at[i] })).filter((x) => x.dt > BUDGET.frame) };
    }
    if (tracing) {
      const file = await traceStop(tr, name.replace(/[^a-z0-9-]+/gi, '_') + '-r' + rep);
      const lf = out.pages[tr.label].longFrames;
      // the trace's clock mark is in tr's page clock: explain() takes node ms
      if (file && lf.length) out.explain = explain(file, lf, '', t0);
      out.trace = file;
    }
    out.extra = extra;
    return out;
  }
  function record(m, frameLine, ltLine, framesOf) {
    for (const [label, p] of Object.entries(m.pages)) {
      if (frameLine && (!framesOf || framesOf.includes(label))) add(frameLine, p.frames.over, m.name + ' [' + label + ']: ' + p.frames.over + ' of ' + p.frames.n + ' frames over 20 ms, max ' + p.frames.max + ' ms' + (p.frames.list.length ? ' ' + JSON.stringify(p.frames.list) : ''));
      if (ltLine) add(ltLine, p.longTasks.length, m.name + ' [' + label + ']: ' + p.longTasks.length + ' long tasks' + (p.longTasks.length ? ' ' + JSON.stringify(p.longTasks.map((x) => x.ms + 'ms ' + x.by).slice(0, 6)) : ''));
      // Event Timing reports only inputs whose next paint took 16 ms or more: none reported = all under 16 ms
      const inputs = p.events.filter((e) => /^(keydown|keypress|pointerdown|pointerup|click|mousedown|mouseup|keyup)$/.test(e.name));
      if (inputs.length) { const worst = inputs.reduce((a, b) => (b.dur > a.dur ? b : a)); add('feedback', worst.dur, m.name + ' [' + label + ']: slowest input ' + worst.name + ' ' + worst.dur + ' ms (handler ' + worst.proc + ', delay ' + worst.delay + ', on ' + worst.tgt + '); ' + inputs.length + ' inputs at 16 ms or more'); }
      else add('feedback', 0, m.name + ' [' + label + ']: no input took 16 ms or more to paint');
    }
    // one short line per long frame: dt, ran (CPU / wall of the busiest critical thread), the threads, the main thread's work
    if (m.explain && m.explain.frames) for (const f of m.explain.frames) say(m.name + ': long frame ' + f.dt + ' ms at +' + f.at + ' ms, ran ' + f.ran + '; ' + f.threads.filter((t) => !/VSync/.test(t.th)).slice(0, 4).map((t) => t.th + ' ' + t.wall + '/' + t.cpu + ' ms (longest ' + t.longest + ' ' + t.what + ')').join(', ') + ' | main: ' + f.mainWork.join(', '));
    else if (m.explain) say(m.name + ': trace: ' + JSON.stringify(m.explain).slice(0, 300));
    (R.measures = R.measures || []).push({ name: m.name, trace: m.trace, explain: m.explain, extra: m.extra, pages: Object.fromEntries(Object.entries(m.pages).map(([k, p]) => [k, { frames: p.frames, longTasks: p.longTasks, events: p.events.slice(0, 40) }])) });
  }
  let rep = 0;

  for (rep = 1; rep <= REPS; rep++) {
    say('==== rep ' + rep);
    /* ---- 1. the toolbar's Lumen button: cold (no Lumen tab yet) and warm (back from another tab) ---- */
    const findBtn = '(() => { const b = document.getElementById("lumen"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()';
    for (const cold of rep === 1 ? (COLD_ONLY ? [true] : [true, false]) : [false]) {
      if (!cold) { await chrome.ev('createTab(), 1'); await sleep(2500); }
      const b = await chrome.ev(findBtn);
      if (!b) { check(false, 'the toolbar has its Lumen button (#lumen)'); }
      else {
        if (cold && COLD_EXP) say('  cold open experiment: ' + JSON.stringify(await chrome.ev(COLD_EXP).catch((e) => 'threw ' + e.message)));
        const ct = cold ? coldTrace : null; coldTrace = null;
        const m = await measure('lumen-button-' + (cold ? 'cold' : 'warm'), [chrome], async () => {
          const t0 = Date.now();
          await click(chrome, b.x, b.y);
          if (cold) {
            const gt = await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 15000);
            g = await attach(gt, null); g.label = 'lumen';
            await probe(g).catch(() => 0);
            // the guest's own first contentful paint, on node's clock
            const fcp = await g.waitFor('(() => { const e = performance.getEntriesByName("first-contentful-paint")[0]; return e ? performance.timeOrigin + e.startTime : 0; })()', 15000).catch(() => 0);
            const skel = await g.ev('document.querySelectorAll("#stack .lrow").length').catch(() => 0);
            // where the cold open goes: the guest's process and navigation, its HTML, its scripts (parsed = DOM
            // interactive, after every blocking script ran), DOMContentLoaded, and the first paint
            const nav = await g.ev('(() => { const n = performance.getEntriesByType("navigation")[0]; return n ? { o: performance.timeOrigin, rs: n.responseStart, di: n.domInteractive, dcl: n.domContentLoadedEventEnd } : null; })()').catch(() => null);
            if (nav && fcp) {
              const ns = Math.round(toNode(g, nav.o) - t0);
              say('  cold open: ' + ns + ' ms to the guest\'s navigation start, then HTML +' + Math.round(nav.rs) + ', parsed (DOM interactive) +' + Math.round(nav.di) +
                ', DOMContentLoaded done +' + Math.round(nav.dcl) + ', first contentful paint +' + Math.round(fcp - nav.o) + ' ms');
              R.cold = { navStart: ns, html: Math.round(nav.rs), interactive: Math.round(nav.di), dcl: Math.round(nav.dcl), fcp: Math.round(fcp - nav.o), clickNode: t0, navOriginNode: Math.round(toNode(g, nav.o)) };
            }
            return { openMs: fcp ? Math.round(toNode(g, fcp) - t0) : NaN, what: 'first contentful paint of the Lumen page (' + skel + ' rows or skeleton rows drawn by then or soon after)' };
          }
          const shown = await chrome.ev('__lp.when(() => { const t = getActiveTab(); return t && isWatchUrl(t.url) && t.viewEl && t.viewEl.offsetParent !== null; }, 5000)');
          const seen = await g.ev('new Promise((r) => requestAnimationFrame((t) => r(performance.timeOrigin + t)))').catch(() => 0);
          return { openMs: Math.round(Math.max(toNode(chrome, shown), seen ? toNode(g, seen) : 0) - t0), what: 'the Lumen view on screen and its page painting' };
        }, { tracePage: chrome });
        if (ct) { await sleep(300); const f = await coldTraceStop(ct, 'cold-' + COLD_TAG); if (R.cold) R.cold.trace = f; say('  cold open trace: ' + (f || 'none')); }
        if (cold && R.cold) R.cold.openMs = m.extra.openMs;
        add('open', m.extra.openMs, m.name + ': ' + m.extra.openMs + ' ms to ' + m.extra.what);
        record(m, null, 'longtasks');
      }
    }
    if (COLD_ONLY) break;
    if (!g) { const gt = await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 15000); g = await attach(gt, null); g.label = 'lumen'; await probe(g); }
    // real rows, and nothing reading or queued (each snapshot redraws rows), before anything is measured
    await g.waitFor('(' + ROWS_REAL + ') >= 20 || null', 90000).catch(() => 0);
    await g.ev(`(() => { if (window.__lpWrapped) return 1; const o = window.__applyWatch; if (typeof o !== 'function') return 0;
      window.__applyWatch = function (s) { window.__lpSnap = s; window.__lpSnaps = (window.__lpSnaps || 0) + 1; return o.apply(this, arguments); }; window.__lpWrapped = 1; return 1; })()`).catch(() => 0);
    const idleReads = await g.waitFor(`(() => { const sn = window.__lpSnap; if (!sn || !Array.isArray(sn.services) || sn.reading) return false; return sn.services.every((s) => !s.queued && !s.reading); })()`, 90000).then(() => true, () => false);
    if (rep === 1) say('reads settled before measuring: ' + idleReads + ' (snapshots seen ' + await g.ev('window.__lpSnaps || 0') + ')');
    await chrome.ev('(() => { const w = findWatchTab(); if (w && w.viewEl) w.viewEl.focus(); return 1; })()').catch(() => 0);
    await sleep(2500);
    if (rep === 1) say('rows: ' + await g.ev(ROWS_REAL) + ' real cards; the page: ' + await g.ev('JSON.stringify({ els: document.getElementsByTagName("*").length, imgs: document.images.length, view: innerWidth + "x" + innerHeight + "@" + devicePixelRatio })'));

    /* ---- 2. home rows: arrow-key stepping (the lens), and the wheel ---- */
    const focusRow0 = async () => {
      await chrome.ev('(() => { const w = findWatchTab(); if (w && w.viewEl) w.viewEl.focus(); return 1; })()').catch(() => 0);
      await g.ev("(() => { const c = document.querySelector('#stack .lrow[data-d=\"0\"] .rt [tabindex=\"0\"]'); if (c) c.focus({ preventScroll: true }); return !!c; })()");
      const inRow = "(() => { const a = document.activeElement; return !!(a && a.closest && a.closest('#stack .lrow') && a.matches('.card, .gc')); })()";
      for (let i = 0; i < 20 && !(await g.ev(inRow).catch(() => false)); i++) await key(g, 'Tab', 'Tab', 9);
    };
    if (want('rows')) {
      await focusRow0();
      const STEPS = ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowRight', 'ArrowLeft'];
      const m = await measure('rows-arrows', [g, chrome], async () => { for (const k of STEPS) { await key(g, k, k, VK[k]); await sleep(450); } }, { tracePage: g });
      record(m, 'frames', 'longtasks');
      const wb = await g.ev('[innerWidth / 2, innerHeight * 0.7]');
      const m2 = await measure('rows-wheel', [g, chrome], async () => {
        for (const dy of [120, 120, 120, 120, -120, -120, -120, -120, 120, 120]) { await g.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wb[0], y: wb[1], deltaX: 0, deltaY: dy }); await sleep(320); }
      }, { tracePage: g });
      record(m2, 'frames', 'longtasks');
    }

    /* ---- 3. hover: across the top row's tiles (the hero preview) and, past the top, a tile's own preview ---- */
    if (want('hover')) {
      await focusRow0();
      for (let i = 0; i < 6; i++) await key(g, 'ArrowUp', 'ArrowUp', 38);
      await sleep(900);
      const tiles = async () => g.ev('[...document.querySelectorAll("#stack .lrow[data-d=\\"0\\"] .rt > .card")].map((c) => c.getBoundingClientRect()).filter((b) => b.left > 0 && b.right < innerWidth).slice(0, 5).map((b) => [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 3)])');
      let cards = await tiles();
      const m = await measure('hover-top-row', [g, chrome], async () => {
        for (let pass = 0; pass < 2; pass++) for (const [x, y] of cards) { for (let s = 0; s < 4; s++) { await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 30 + s * 20, y }); await sleep(60); } await sleep(200); }
        // rest on one: the hero's preview mounts and plays
        await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cards[1][0], y: cards[1][1] }); await sleep(2200);
        await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 }); await sleep(500);
      }, { tracePage: g });
      record(m, 'frames', 'longtasks');
      // past the top: the tile itself plays (watch-tilepreview.js), six rests and leaves
      await focusRow0(); await key(g, 'ArrowDown', 'ArrowDown', 40); await sleep(900);
      cards = await tiles();
      const f0 = await g.ev('document.querySelectorAll("iframe").length');
      const mem0 = await metrics(g, true);
      const m2 = await measure('hover-tile-preview', [g, chrome], async () => {
        const made = [];
        for (let i = 0; i < 6 && cards.length; i++) {
          const [x, y] = cards[i % cards.length];
          await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          made.push(await g.ev('new Promise((r) => { const t0 = performance.now(); const f = () => { const p = document.querySelector("#stack .tpv"); if (p || performance.now() - t0 > 2500) r(p ? Math.round(performance.now() - t0) : -1); else requestAnimationFrame(f); }; requestAnimationFrame(f); })'));
          await sleep(1300);
          await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: Math.round(y) - 200 > 0 ? Math.round(y) - 200 : 4 });
          await sleep(500);
        }
        return { made };
      }, { tracePage: g });
      record(m2, 'frames', 'longtasks');
      const f1 = await g.ev('document.querySelectorAll("iframe").length');
      const mem1 = await metrics(g, true);
      say('tile preview: made after ' + JSON.stringify(m2.extra.made) + ' ms (hover delay ' + 800 + '); iframes ' + f0 + ' -> ' + f1 + '; heap ' + mem0.heapMB + ' -> ' + mem1.heapMB + ' MB, nodes ' + mem0.nodes + ' -> ' + mem1.nodes + ', listeners ' + mem0.listeners + ' -> ' + mem1.listeners);
      add('memory', f1 - f0, 'hover previews x6: iframes ' + f0 + ' -> ' + f1 + ', heap ' + mem0.heapMB + ' -> ' + mem1.heapMB + ' MB, nodes ' + mem0.nodes + ' -> ' + mem1.nodes + ', listeners ' + mem0.listeners + ' -> ' + mem1.listeners);
    }

    /* ---- 4. search: typing, and the results ---- */
    if (want('search')) {
      await g.ev('(() => { const q = document.getElementById("q"); q.focus(); q.value = ""; q.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()');
      await sleep(400);
      const m = await measure('search-typing', [g], async () => {
        const t0 = Date.now();
        const word = 'the bear';
        let firstShown = 0;
        for (let i = 0; i < word.length; i++) {
          const ch = word[i];
          await key(g, ch, ch === ' ' ? 'Space' : 'Key' + ch.toUpperCase(), ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0), ch);
          if (i === 0) firstShown = await g.ev('__lp.when(() => { const r = document.getElementById("results"); return r && !r.hidden && r.querySelector("*"); }, 3000)');
          await sleep(110);
        }
        const done = await g.ev('__lp.when(() => { const r = document.getElementById("results"); return r && !r.hidden && r.querySelector("a, button, .card, td"); }, 5000)');
        return { firstMs: firstShown ? Math.round(toNode(g, firstShown) - t0) : NaN, lastMs: done ? Math.round(toNode(g, done) - t0) : NaN };
      }, { tracePage: g });
      add('open', m.extra.firstMs, 'search: ' + m.extra.firstMs + ' ms from the first key to the results view drawn');
      record(m, 'frames', 'longtasks');
      await g.ev('(() => { const q = document.getElementById("q"); q.value = ""; q.dispatchEvent(new Event("input", { bubbles: true })); q.blur(); return 1; })()');
      await sleep(800);
    }

    /* ---- 5. the video view: open from a tile, scroll it and its comments, close; 10 cycles for memory ---- */
    const ytCard = `([...document.querySelectorAll('#stack .lrow[data-d="0"] .rt > .card')].find((n) => n._item && n._item.service === 'youtube' && /watch\\?v=/.test(n._item.url) && n.getBoundingClientRect().left > 0 && n.getBoundingClientRect().right < innerWidth))`;
    const bringYtRow = async () => {
      await focusRow0();
      for (let i = 0; i < 12 && !(await g.ev('!!' + ytCard)); i++) { await key(g, 'ArrowDown', 'ArrowDown', 40); await sleep(500); }
      return g.ev(`(() => { const c = ${ytCard}; if (!c) return null; const b = c.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, url: c._item.url }; })()`);
    };
    const openVideo = async (at) => {
      const t0 = Date.now();
      await click(g, at.x, at.y);
      const on = await chrome.ev('__lp.when(() => ' + LAYER_ON + ', 8000)');
      return { t0, openMs: on ? Math.round(toNode(chrome, on) - t0) : NaN };
    };
    const closeLayer = async () => {
      const t0 = Date.now();
      await chrome.ev('(() => { if (WatchPlayer.isOpen()) WatchPlayer.close("Close"); return 1; })()');
      const off = await chrome.ev('__lp.when(() => ' + LAYER_OFF + ', 5000)');
      return off ? Math.round(toNode(chrome, off) - t0) : NaN;
    };
    const state = async () => ({ quartz: await metrics(chrome, true), lumen: await metrics(g, true), webviews: await chrome.ev('document.querySelectorAll("webview").length'), targets: (await q.targets()).length });
    // the player layer's idle font warm-up (watch-warm.js): done before the first video / Short open?
    say('warm-up before the first open: ' + JSON.stringify(await chrome.ev('window.LumenWarm ? LumenWarm._state() : "not loaded (old code)"').catch(() => null)));
    if (want('video')) {
      const at = await bringYtRow();
      if (!at) check(false, 'a YouTube tile to open in the video view');
      else {
        let opened = null, cm = NaN;
        const m = await measure('video-open', [chrome, g], async () => {
          opened = await openVideo(at);
          const c = await chrome.ev('__lp.when(() => document.querySelector(".wp-layer .cm-item"), 10000)');
          cm = c ? Math.round(toNode(chrome, c) - opened.t0) : NaN;
          await sleep(1200);
        }, { tracePage: chrome });
        add('open', opened.openMs, 'video view: ' + opened.openMs + ' ms from the click to the layer shown (its first comments drawn at ' + cm + ' ms)');
        record(m, 'frames', 'longtasks', ['quartz']);   // the Lumen page is under the layer now: its frames are not on screen
        // scroll the view (over the info under the video) down to the comments and back
        const box = await chrome.ev('(() => { const t = document.querySelector(".wp-layer .wp-tile.pv"); if (!t) return null; const r = t.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.bottom - 60)]; })()');
        if (box) {
          const m2 = await measure('video-scroll-comments', [chrome], async () => {
            for (const dy of [100, 100, 100, 100, 100, 100, 100, 100, -100, -100, -100, -100, -100, -100, -100, -100]) { await chrome.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box[0], y: box[1], deltaX: 0, deltaY: dy }); await sleep(140); }
          }, { tracePage: chrome });
          record(m2, 'frames', 'longtasks');
          say('video view scroll: comments drawn ' + await chrome.ev('document.querySelectorAll(".wp-layer .cm-item").length'));
        }
        const closeMs = await closeLayer();
        add('open', closeMs, 'video view: ' + closeMs + ' ms from Close to the layer gone');
        await sleep(1500);
        // 10 open/close cycles: does anything stay behind?
        const s0 = await state();
        const cyc = [];
        const m3 = await measure('video-open-close-x10', [chrome, g], async () => {
          for (let i = 0; i < 10; i++) {
            const a2 = await bringYtRow();
            if (!a2) break;
            const o2 = await openVideo(a2);
            await sleep(1600);
            const c2 = await closeLayer();
            cyc.push(o2.openMs + '/' + c2);
            await sleep(700);
          }
        }, { trace: false });
        await sleep(2500);
        const s1 = await state();
        record(m3, null, 'longtasks');
        say('video view x10 (open/close ms): ' + cyc.join(' '));
        const opens = cyc.map((x) => Number(x.split('/')[0])).filter(Number.isFinite);
        if (opens.length) add('open', Math.max.apply(null, opens), 'video view x10: slowest open ' + Math.max.apply(null, opens) + ' ms (median ' + opens.sort((a, b) => a - b)[opens.length >> 1] + ')');
        const grew = (s1.webviews - s0.webviews) + (s1.targets - s0.targets);
        add('memory', grew + (s1.quartz.listeners - s0.quartz.listeners > 20 ? 1 : 0) + (s1.quartz.nodes - s0.quartz.nodes > 200 ? 1 : 0) + (s1.quartz.heapMB - s0.quartz.heapMB > 3 ? 1 : 0),
          'video view x10: webviews ' + s0.webviews + ' -> ' + s1.webviews + ', CDP targets ' + s0.targets + ' -> ' + s1.targets + '; Quartz window heap ' + s0.quartz.heapMB + ' -> ' + s1.quartz.heapMB + ' MB, nodes ' + s0.quartz.nodes + ' -> ' + s1.quartz.nodes + ', listeners ' + s0.quartz.listeners + ' -> ' + s1.quartz.listeners
          + '; Lumen heap ' + s0.lumen.heapMB + ' -> ' + s1.lumen.heapMB + ' MB, nodes ' + s0.lumen.nodes + ' -> ' + s1.lumen.nodes + ', listeners ' + s0.lumen.listeners + ' -> ' + s1.lumen.listeners);
      }
    }

    /* ---- 6. Shorts: open from the row's Shorts tile, then 20 moves ---- */
    if (want('shorts')) {
      const shortCard = `([...document.querySelectorAll('#stack .lrow .rt > .card')].find((n) => n._item && n._item.service === 'youtube' && /\\/shorts\\//.test(n._item.url)))`;
      await focusRow0();
      for (let i = 0; i < 14 && !(await g.ev(`(() => { const c = ${shortCard}; return !!c && !!c.closest('.lrow[data-d="0"]'); })()`)); i++) { await key(g, 'ArrowDown', 'ArrowDown', 40); await sleep(500); }
      await g.ev(`(() => { const c = ${shortCard}; if (c) { c.focus({ preventScroll: false }); } return 1; })()`);
      await sleep(700);
      const at = await g.ev(`(() => { const c = ${shortCard}; if (!c) return null; const b = c.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null; })()`);
      if (!at) check(false, 'a Shorts tile in view on the rows');
      else {
        let opened = null;
        const m = await measure('shorts-open', [chrome, g], async () => {
          opened = await openVideo(at);
          await chrome.waitFor('(() => { const s = LumenShorts._state(); const x = s.slots[s.slots.length - 1]; return x && x.phase === "ready" ? 1 : 0; })()', 15000).catch(() => 0);
          await sleep(1000);
        }, { tracePage: chrome });
        add('open', opened.openMs, 'Shorts: ' + opened.openMs + ' ms from the click to the Shorts view shown');
        record(m, 'frames', 'longtasks', ['quartz']);
        const sg = await targetWhere(q, (x) => /\/shorts\//.test(String(x.url)), 10000);
        let sgc = null; if (sg) { sgc = await attach(sg, g); sgc.label = 'shorts-page'; await probe(sgc).catch(() => 0); }
        await chrome.ev('(() => { const i = document.querySelector(".wp-layer .sh-info"); if (i) { i.setAttribute("tabindex", "-1"); i.focus(); } return 1; })()');
        const s0 = await state(); const sh0 = sgc ? await metrics(sgc, true) : null;
        const moves = [];
        const pages = sgc ? [chrome, sgc] : [chrome];
        const m2 = await measure('shorts-20-moves', pages, async () => {
          const seq = ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp'];
          for (let i = 0; i < 20; i++) {
            const k = seq[i % seq.length];
            await chrome.ev('(() => { const s = LumenShorts._state(); const x = s.slots[s.slots.length - 1]; window.__lpCur = x ? x.cur : ""; return 1; })()');
            const t0 = Date.now();
            await key(chrome, k, k, VK[k]);
            const done = await chrome.ev('__lp.when(() => { const s = LumenShorts._state(); const x = s.slots[s.slots.length - 1]; return x && x.phase === "ready" && x.infoShort === x.cur && x.cur !== window.__lpCur; }, 3000)');
            moves.push(done ? Math.round(toNode(chrome, done) - t0) : -1);
            await sleep(650);
          }
        }, { tracePage: chrome });
        record(m2, 'frames', 'longtasks');
        await sleep(1500);
        const s1 = await state(); const sh1 = sgc ? await metrics(sgc, true) : null;
        say('Shorts moves (ms to the info following): ' + moves.join(' '));
        const okMoves = moves.filter((x) => x > 0);
        if (okMoves.length) add('open', Math.max.apply(null, okMoves), 'Shorts: slowest of ' + okMoves.length + ' moves ' + Math.max.apply(null, okMoves) + ' ms to the next Short with Lumen’s info following' + (okMoves.length < moves.length ? ' (' + (moves.length - okMoves.length) + ' did not move)' : ''));
        add('memory', (s1.webviews - s0.webviews) + (s1.targets - s0.targets) + (s1.quartz.listeners - s0.quartz.listeners > 20 ? 1 : 0) + (s1.quartz.nodes - s0.quartz.nodes > 200 ? 1 : 0) + (s1.quartz.heapMB - s0.quartz.heapMB > 3 ? 1 : 0),
          'Shorts x20 moves: webviews ' + s0.webviews + ' -> ' + s1.webviews + ', targets ' + s0.targets + ' -> ' + s1.targets + '; Quartz window heap ' + s0.quartz.heapMB + ' -> ' + s1.quartz.heapMB + ' MB, nodes ' + s0.quartz.nodes + ' -> ' + s1.quartz.nodes + ', listeners ' + s0.quartz.listeners + ' -> ' + s1.quartz.listeners
          + (sh0 ? '; Shorts page heap ' + sh0.heapMB + ' -> ' + sh1.heapMB + ' MB, nodes ' + sh0.nodes + ' -> ' + sh1.nodes + ', listeners ' + sh0.listeners + ' -> ' + sh1.listeners : ''));
        if (sgc) sgc.close();
        await closeLayer();
        await sleep(1200);
      }
    }

    /* ---- 7. idle: Lumen at rest in front, vs a plain new tab; wake-ups per renderer ---- */
    if (want('idle') && rep === REPS) {
      await chrome.ev('(() => { const w = findWatchTab(); if (w) activateTab(w.id); return 1; })()');
      await focusRow0(); for (let i = 0; i < 6; i++) await key(g, 'ArrowUp', 'ArrowUp', 38);
      await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 });
      await chrome.ev('document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1');
      await sleep(5000);
      const fps = await g.ev('new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); })');
      await sleep(1500);
      const a = await cpuSample(q.child.pid, IDLE_S);
      let wk = null;
      if (TRACE_DIR) {
        const traced = await traceStart(chrome);
        if (traced) { await chrome.ev('console.timeStamp("lp-sync 0")'); await sleep(5000); const f = await traceStop(chrome, 'idle-lumen'); wk = f ? wakeups(f, 5) : null; }
      }
      await chrome.ev('createTab(), 1');
      await sleep(5000);
      const b = await cpuSample(q.child.pid, IDLE_S);
      say('idle CPU (% of one core, whole tree, ' + IDLE_S + ' s): Lumen ' + a.pct + ' ' + JSON.stringify(a.byKind) + ' (' + a.privMB + ' MB private, ' + a.procs + ' procs) vs a new tab ' + b.pct + ' ' + JSON.stringify(b.byKind) + '; rAF/s while measuring ' + fps);
      if (wk) say('idle wake-ups (5 s trace, Lumen in front): ' + JSON.stringify(wk));
      add('idle', +(a.pct - b.pct).toFixed(2), 'idle CPU: Lumen ' + a.pct + '% vs new tab ' + b.pct + '% of one core (Lumen adds ' + (a.pct - b.pct).toFixed(2) + ')');
      R.idle = { lumen: a, newtab: b, fps, wakeups: wk };
    }
  }

  /* ---- the table ---- */
  const lines = [
    ['feedback', 'a click or key: input to next paint', (v) => v <= BUDGET.feedback, BUDGET.feedback + ' ms'],
    ['open', 'a view opens (or closes)', (v) => Number.isFinite(v) && v <= BUDGET.open, BUDGET.open + ' ms'],
    ['frames', 'frames over 20 ms while scrolling/stepping/moving', (v) => v === 0, '0'],
    ['longtasks', 'main-thread tasks over 50 ms', (v) => v === 0, '0'],
    ['idle', 'idle CPU Lumen minus new tab (% of a core)', (v) => v <= 1.0, '<= 1.0'],
    ['memory', 'growth across previews / 10 video views / 20 Shorts', (v) => v <= 0, 'none'],
  ];
  console.log('\n| budget | worst | limit | result | detail |\n|---|---|---|---|---|');
  for (const [k, label, ok, lim] of lines) {
    const rows = results[k] || [];
    if (!rows.length) { console.log('| ' + label + ' | - | ' + lim + ' | not measured | |'); continue; }
    const vals = rows.map((r) => r.v);
    const worst = k === 'idle' ? Math.max.apply(null, vals) : vals.reduce((a, b) => (Number.isFinite(b) && (!Number.isFinite(a) || b > a) ? b : a), vals[0]);
    const pass = rows.every((r) => ok(r.v));
    console.log('| ' + label + ' | ' + worst + ' | ' + lim + ' | ' + (pass ? 'PASS' : 'FAIL') + ' | ' + rows.filter((r) => !ok(r.v)).map((r) => r.detail).slice(0, 3).join('; ').slice(0, 600) + ' |');
    for (const r of rows) say('  ' + k + ': ' + r.detail);
    check(pass, 'budget: ' + label + ' (worst ' + worst + ', limit ' + lim + ')');
  }
  R.results = results;
  if (BOOT_TRACE) {   // the startup trace is written when its duration ends: wait for it (and for it to stop growing)
    let last = -1;
    for (let i = 0; i < 60; i++) {
      const n = fs.existsSync(BOOT_TRACE) ? fs.statSync(BOOT_TRACE).size : -1;
      if (n > 0 && n === last) break;
      last = n; await sleep(1000);
    }
    say('boot trace: ' + (fs.existsSync(BOOT_TRACE) ? BOOT_TRACE + ' (' + Math.round(fs.statSync(BOOT_TRACE).size / 1e6) + ' MB)' : 'none written'));
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(R, null, 1));
  await q.quit();
  srv.close();
  try { if (mock.close) await mock.close(); } catch (e) { /* gone */ }
});
