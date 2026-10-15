// tools/efficiency/probe.js -- what Quartz's OWN code does while nobody touches it.
//
// Used by idle-bench.js on the "profiled" Quartz instances only (never on the instances whose
// MB / CPU go into the Quartz-vs-Edge table: the probes cost something themselves).
//
// Two halves:
//   RENDERER_PROBE  evaluated in the chrome page (index.html) and in the Home page (newtab.html):
//                   wraps setTimeout / setInterval / requestAnimationFrame / requestIdleCallback so
//                   every callback that FIRES is counted by the place that scheduled it, with the
//                   milliseconds it ran. Installed at the start of the idle window, so a timer
//                   chain that reschedules itself is caught from its next turn; a setInterval made
//                   before that is not (the CPU profile still shows it).
//   MAIN_PROBE      evaluated in the main process through --inspect: the same for Node's timers,
//                   plus every ipcMain message / invoke by channel, every webContents.send by
//                   channel, every child process spawned and every fetch / https.request made.
// Both keep their tallies on globalThis.__qprobe; *_READ returns it and turns it off.
'use strict';

const RENDERER_PROBE = String.raw`(() => {
  if (globalThis.__qprobe) { globalThis.__qprobe.reset(); return 'reset'; }
  const P = { t0: performance.now(), on: true, sites: new Map() };
  const site = () => {
    const keep = Error.stackTraceLimit; Error.stackTraceLimit = 5;
    const s = String(new Error().stack || '').split('\n'); Error.stackTraceLimit = keep;
    // [0] "Error", [1] site(), [2] the wrapper, [3] the caller
    const l = (s[3] || s[2] || '').trim().replace(/^at\s+/, '');
    return l.replace(/(file|https?):\/\/\/?[^\s)]*\//, '').slice(0, 140);
  };
  const tally = (kind, where, ms) => {
    if (!P.on) return;
    const k = kind + ' ' + where;
    const e = P.sites.get(k) || { kind, where, fires: 0, ms: 0, max: 0 };
    e.fires++; e.ms += ms; if (ms > e.max) e.max = ms; P.sites.set(k, e);
  };
  const wrapTimer = (name, kind) => {
    const orig = globalThis[name];
    if (typeof orig !== 'function') return;
    globalThis[name] = function (fn, ...rest) {
      if (typeof fn !== 'function') return orig.call(this, fn, ...rest);
      const where = site();
      return orig.call(this, function (...a) { const t = performance.now(); try { return fn.apply(this, a); } finally { tally(kind, where, performance.now() - t); } }, ...rest);
    };
  };
  wrapTimer('setTimeout', 'timeout');
  wrapTimer('setInterval', 'interval');
  wrapTimer('requestAnimationFrame', 'raf');
  wrapTimer('requestIdleCallback', 'idle');
  P.reset = () => { P.sites.clear(); P.t0 = performance.now(); P.on = true; };
  P.read = () => {
    P.on = false;
    const anims = (document.getAnimations ? document.getAnimations() : []).filter((a) => a.playState === 'running').map((a) => {
      const el = a.effect && a.effect.target; const t = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
      return { name: a.animationName || a.constructor.name, iterations: t.iterations === Infinity ? 'inf' : t.iterations,
        on: el ? (el.tagName || '').toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') : '' };
    });
    const videos = Array.from(document.querySelectorAll('video')).map((v) => ({ paused: v.paused, src: String(v.currentSrc || '').slice(0, 80), w: v.clientWidth, h: v.clientHeight }));
    return { url: location.href.slice(0, 120), seconds: (performance.now() - P.t0) / 1000, hidden: document.hidden, visibility: document.visibilityState,
      sites: Array.from(P.sites.values()).sort((a, b) => b.ms - a.ms || b.fires - a.fires).slice(0, 60).map((e) => ({ ...e, ms: +e.ms.toFixed(2), max: +e.max.toFixed(2) })),
      runningAnimations: anims.slice(0, 40), videos };
  };
  globalThis.__qprobe = P;
  return 'installed';
})()`;

const RENDERER_READ = 'globalThis.__qprobe ? globalThis.__qprobe.read() : null';

// Evaluated with includeCommandLineAPI so require() exists in the inspector's scope.
const MAIN_PROBE = String.raw`(() => {
  if (globalThis.__qprobe) { globalThis.__qprobe.reset(); return 'reset'; }
  const req = typeof require === 'function' ? require : process.mainModule.require.bind(process.mainModule);
  const { performance } = req('perf_hooks');
  const P = { t0: performance.now(), on: true, sites: new Map(), ipc: new Map(), sends: new Map(), spawns: [], fetches: new Map() };
  const bump = (m, k, ms) => { if (!P.on) return; const e = m.get(k) || { n: 0, ms: 0 }; e.n++; e.ms += ms || 0; m.set(k, e); };
  const site = () => {
    const keep = Error.stackTraceLimit; Error.stackTraceLimit = 5;
    const s = String(new Error().stack || '').split('\n'); Error.stackTraceLimit = keep;
    const l = (s[3] || s[2] || '').trim().replace(/^at\s+/, '');
    return l.replace(/[A-Za-z]:[\\/][^\s)]*[\\/]/, '').slice(0, 140);
  };
  const tally = (kind, where, ms) => {
    if (!P.on) return;
    const k = kind + ' ' + where;
    const e = P.sites.get(k) || { kind, where, fires: 0, ms: 0, max: 0 };
    e.fires++; e.ms += ms; if (ms > e.max) e.max = ms; P.sites.set(k, e);
  };
  for (const [name, kind] of [['setTimeout', 'timeout'], ['setInterval', 'interval'], ['setImmediate', 'immediate']]) {
    const orig = globalThis[name];
    globalThis[name] = function (fn, ...rest) {
      if (typeof fn !== 'function') return orig.call(this, fn, ...rest);
      const where = site();
      return orig.call(this, function (...a) { const t = performance.now(); try { return fn.apply(this, a); } finally { tally(kind, where, performance.now() - t); } }, ...rest);
    };
  }
  const electron = req('electron');
  const { ipcMain, webContents } = electron;
  const origEmit = ipcMain.emit;
  ipcMain.emit = function (ch, ...a) { const t = performance.now(); try { return origEmit.call(this, ch, ...a); } finally { bump(P.ipc, 'on ' + String(ch), performance.now() - t); } };
  if (ipcMain._invokeHandlers && typeof ipcMain._invokeHandlers.forEach === 'function') {
    for (const [ch, fn] of Array.from(ipcMain._invokeHandlers.entries())) {
      ipcMain._invokeHandlers.set(ch, function (...a) { const t = performance.now(); try { return fn.apply(this, a); } finally { bump(P.ipc, 'invoke ' + ch, performance.now() - t); } });
    }
  }
  const all = webContents.getAllWebContents();
  if (all.length) {
    const proto = Object.getPrototypeOf(all[0]);
    const origSend = proto.send;
    proto.send = function (ch, ...a) { bump(P.sends, String(ch)); return origSend.call(this, ch, ...a); };
  }
  const cp = req('child_process');
  for (const name of ['spawn', 'execFile', 'exec', 'fork']) {
    const orig = cp[name];
    cp[name] = function (cmd, args) { if (P.on) P.spawns.push({ how: name, cmd: String(cmd).slice(-60), args: Array.isArray(args) ? args.join(' ').slice(0, 120) : '', at: +((performance.now() - P.t0) / 1000).toFixed(1) }); return orig.apply(this, arguments); };
  }
  if (typeof globalThis.fetch === 'function') {
    const of = globalThis.fetch;
    globalThis.fetch = function (u, ...a) { try { bump(P.fetches, 'fetch ' + new URL(String(u && u.url || u)).host); } catch (e) { bump(P.fetches, 'fetch ?'); } return of.call(this, u, ...a); };
  }
  for (const mod of ['https', 'http']) {
    const m = req(mod); const orig = m.request;
    m.request = function (u) { let h = '?'; try { h = typeof u === 'string' || u instanceof URL ? new URL(String(u)).host : (u && (u.hostname || u.host)) || '?'; } catch (e) { /* keep ? */ } bump(P.fetches, mod + ' ' + h); return orig.apply(this, arguments); };
  }
  if (electron.net && typeof electron.net.fetch === 'function') {
    const nf = electron.net.fetch;
    electron.net.fetch = function (u, ...a) { try { bump(P.fetches, 'net.fetch ' + new URL(String(u && u.url || u)).host); } catch (e) { bump(P.fetches, 'net.fetch ?'); } return nf.call(this, u, ...a); };
  }
  P.reset = () => { P.sites.clear(); P.ipc.clear(); P.sends.clear(); P.fetches.clear(); P.spawns.length = 0; P.t0 = performance.now(); P.on = true; };
  const list = (m) => Array.from(m.entries()).map(([k, e]) => ({ k, n: e.n, ms: +e.ms.toFixed(2) })).sort((a, b) => b.n - a.n);
  P.read = () => {
    P.on = false;
    let metrics = [];
    try { metrics = electron.app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name || m.serviceName || '', cpuIdleWakeups: m.cpu && m.cpu.idleWakeupsPerSecond, cpuPct: m.cpu && m.cpu.percentCPUUsage, privMB: m.memory && m.memory.privateBytes ? Math.round(m.memory.privateBytes / 1024) : undefined, wsMB: m.memory ? Math.round(m.memory.workingSetSize / 1024) : undefined })); } catch (e) { metrics = String(e); }
    const wcs = webContents.getAllWebContents().map((w) => { let pid = 0; try { pid = w.getOSProcessId(); } catch (e) { /* gone */ } return { id: w.id, type: w.getType(), pid, url: String(w.getURL()).replace(/\?.*$/, '').slice(0, 100), throttle: w.getBackgroundThrottling ? w.getBackgroundThrottling() : null, audible: w.isCurrentlyAudible ? w.isCurrentlyAudible() : null }; });
    return { seconds: (performance.now() - P.t0) / 1000,
      sites: Array.from(P.sites.values()).sort((a, b) => b.ms - a.ms || b.fires - a.fires).slice(0, 60).map((e) => ({ ...e, ms: +e.ms.toFixed(2), max: +e.max.toFixed(2) })),
      ipc: list(P.ipc).slice(0, 60), sends: list(P.sends).slice(0, 60), fetches: list(P.fetches), spawns: P.spawns.slice(0, 200), appMetrics: metrics, webContents: wcs,
      procfind: (() => { try { const pf = req(req('path').join(process.cwd(), 'procfind.js')); return { explorer: pf.running('explorer.exe'), reason: pf.reason() }; } catch (e) { return 'n/a: ' + e.message; } })(),
      activeResources: typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo().reduce((o, k) => { o[k] = (o[k] || 0) + 1; return o; }, {}) : null };
  };
  globalThis.__qprobe = P;
  return 'installed';
})()`;

const MAIN_READ = 'globalThis.__qprobe ? globalThis.__qprobe.read() : null';

/**
 * A V8 CPU profile (Profiler.stop's result) folded to self milliseconds per function and per
 * script. sampleMs is the interval actually used. Returns { totalMs, idleMs, byUrl[], top[] }.
 */
function foldProfile(profile, keep) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const counts = new Map();
  for (const id of profile.samples || []) counts.set(id, (counts.get(id) || 0) + 1);
  const deltas = profile.timeDeltas || [];
  const samples = profile.samples || [];
  // Self time per sample = the gap to the NEXT sample (Chrome DevTools' convention).
  const self = new Map();
  for (let i = 0; i < samples.length; i++) {
    const dt = (deltas[i + 1] !== undefined ? deltas[i + 1] : 0) / 1000;
    self.set(samples[i], (self.get(samples[i]) || 0) + dt);
  }
  const byFn = new Map(); const byUrl = new Map();
  let total = 0, idle = 0;
  for (const [id, ms] of self) {
    const n = nodes.get(id); if (!n) continue;
    const cf = n.callFrame || {};
    const fn = cf.functionName || '(anonymous)';
    if (fn === '(idle)' || fn === '(program)') { idle += fn === '(idle)' ? ms : 0; if (fn === '(idle)') continue; }
    total += ms;
    const url = String(cf.url || '').replace(/^.*[\\/]/, '').replace(/\?.*$/, '') || (fn.startsWith('(') ? fn : '(native)');
    const k = fn + ' ' + url + ':' + (cf.lineNumber + 1);
    byFn.set(k, (byFn.get(k) || 0) + ms);
    byUrl.set(url, (byUrl.get(url) || 0) + ms);
  }
  const top = Array.from(byFn.entries()).sort((a, b) => b[1] - a[1]).slice(0, keep || 30).map(([k, ms]) => ({ k, ms: +ms.toFixed(1) }));
  const urls = Array.from(byUrl.entries()).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, ms]) => ({ k, ms: +ms.toFixed(1) }));
  return { totalMs: +total.toFixed(1), idleMs: +idle.toFixed(1), byUrl: urls, top };
}

module.exports = { RENDERER_PROBE, RENDERER_READ, MAIN_PROBE, MAIN_READ, foldProfile };
