try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine (a cloud runner): no cap needed */ }   // first: one capped browser at a time (The user, 2026-09-17)
// watch-auto-e2e.js -- Watch keeps itself up to date, end to end: a REAL hidden Quartz test instance
// (--test-profile, off-screen, watched by testwatch.js: the run FAILS if a window touches the screen)
// reading a LOCAL mock of every service (tests/watch-mock.js). Never a real account, never the user's
// profile, cookies or live Quartz.
//
//   node watch-auto-e2e.js [--cdp 9457] [--measure]
//
// Boot 1, no Watch tab open at all -- the background refresh:
//   battery saver on (QUARTZ_WATCH_SAVER_FILE): nothing reads, and describe() says why; off: it reads,
//   oldest first, one reader at a time, the gap apart; a game (QUARTZ_WATCH_GAME_FILE) holds the next
//   one and says so; gone: the rest read. Turned off (watch:set-background): nothing more.
//   --measure: the idle CPU of the instance (Watch not on screen) with the background refresh on vs
//   off, and one forced read's peak RAM / CPU per service (the whole process tree, sampled).
// Boot 2, a cache 20-50 min old -- fresh on open, fresh after watching, the header:
//   Ctrl+Alt+W draws the cached rows at once, then every stale service reads, one at a time, oldest
//   first, the rows updating in place (never blank, no scroll jump); the header says "Updating X…"
//   and then "Updated …"; a quick tab flip reads nothing; a YouTube title opened from Watch makes
//   YouTube (only) re-read when Watch is back in front; a read past its time limit is stopped and the
//   header says why with Retry, which reads again; Settings > Watch has the background switch.
// Kills ONLY the processes it started and deletes its temp profile. One summary line:
// "watch-auto-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');
const Shape = require('./watch/shape');

// Every service Shape knows that the local mock serves; any other is off in the test profile (seedCache).
const IDS = Shape.SERVICE_IDS.filter((id) => !!(Mock.ORIGINS && Mock.ORIGINS[id]));
const NAMES = {}; for (const id of Shape.SERVICE_IDS) NAMES[id] = Shape.serviceById(id).name;
/** Oldest first (ages in minutes, `dflt` for one not listed), Shape order on a tie: the order the scheduler must read in. */
function oldestFirst(ages, dflt) {
  const age = (id) => (ages[id] !== undefined ? ages[id] : dflt);
  return IDS.slice().sort((a, b) => (age(b) - age(a)) || (Shape.SERVICE_IDS.indexOf(a) - Shape.SERVICE_IDS.indexOf(b)));
}
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9457'));
const MEASURE = argv.includes('--measure');
const TAG = 'quartz-watch-auto-e2e-' + process.pid;
const OPEN_STUB = path.join(os.tmpdir(), TAG + '-open.txt');
const EDGE_STUB = path.join(os.tmpdir(), TAG + '-edge.txt');
const GAME_FILE = path.join(os.tmpdir(), TAG + '-game.flag');
const SAVER_FILE = path.join(os.tmpdir(), TAG + '-saver.flag');
const SAMPLER = path.join(os.tmpdir(), TAG + '-sampler.ps1');
const BG_GAP_MS = 2500;

/* ---- a cache file as if every service had read fine `ages[id]` minutes ago ---------------------- */
function seedCache(dir, ages, dflt) {
  const t = Date.now();
  const services = {};
  for (const id of IDS) {
    const at = t - (ages[id] !== undefined ? ages[id] : dflt) * 60e3;
    const home = Shape.serviceById(id).home;
    const items = id === 'espn' ? [] : [1, 2, 3, 4, 5].map((i) => ({
      service: id, kind: 'resume', id: 'seed-' + id + '-' + i, title: 'Seed ' + NAMES[id] + ' ' + i, subtitle: '',
      url: home.replace(/\/?$/, '/') + 'seed-' + i, image: '', progress: 0.5,
    }));
    services[id] = { state: 'ok', reason: '', readAt: at, attemptAt: at, lastOkAt: at, items, profile: '', events: id === 'espn' ? [] : null, captured: 0, warnings: [] };
  }
  fs.mkdirSync(dir, { recursive: true });
  const off = Shape.SERVICE_IDS.filter((id) => IDS.indexOf(id) === -1);
  if (off.length) { const enabled = {}; for (const id of off) enabled[id] = false; fs.writeFileSync(path.join(dir, 'watch.json'), JSON.stringify({ enabled })); }
  fs.writeFileSync(path.join(dir, 'watch-cache.json'), JSON.stringify({ v: 1, services }));
}

/* ---- the process tree's working set and CPU, sampled (for --measure) ------------------------------ */
const SAMPLER_PS = String.raw`param([int]$Root, [int]$Seconds, [int]$EveryMs)
function Tree {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId)
  $ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add($Root)
  $more = $true
  while ($more) { $more = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { [void]$ids.Add([int]$p.ProcessId); $more = $true } } }
  return $ids
}
$sw = [Diagnostics.Stopwatch]::StartNew()
$ids = Tree; $treeAt = 0
while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
  if ($sw.Elapsed.TotalMilliseconds - $treeAt -gt 1000) { $ids = Tree; $treeAt = $sw.Elapsed.TotalMilliseconds }
  $ws = 0; $cpu = 0; $n = 0
  foreach ($id in $ids) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { $ws += $p.WorkingSet64; $cpu += $p.TotalProcessorTime.TotalMilliseconds; $n++ } }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  '{"t":' + $now + ',"ws":' + $ws + ',"cpu":' + [math]::Round($cpu) + ',"n":' + $n + '}'
  Start-Sleep -Milliseconds $EveryMs
}`;
/** Sample the tree of `pid` every `everyMs` until stop(); returns { stop(): Promise<samples[]> }. */
function sampler(pid, everyMs, maxS) {
  fs.writeFileSync(SAMPLER, SAMPLER_PS);
  const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SAMPLER, '-Root', String(pid), '-Seconds', String(maxS || 600), '-EveryMs', String(everyMs)], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  try { require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process -Id ' + proc.pid + ').PriorityClass = "BelowNormal"'], { stdio: 'ignore', windowsHide: true }); } catch (e) { /* fine */ }
  const out = [];
  let buf = '';
  proc.stdout.on('data', (d) => { buf += String(d); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); try { if (l) out.push(JSON.parse(l)); } catch (e) { /* partial */ } } });
  return {
    samples: out,
    stop: async () => { try { proc.kill(); } catch (e) { /* gone */ } await sleep(300); return out; },
  };
}
/** CPU % of one core and the mean working set over [t0, t1] from samples. */
function window_(samples, t0, t1) {
  const s = samples.filter((x) => x.t >= t0 && x.t <= t1);
  if (s.length < 2) return null;
  const a = s[0], b = s[s.length - 1];
  return { cpuPct: +((b.cpu - a.cpu) / (b.t - a.t) * 100).toFixed(2), wsMb: Math.round(s.reduce((n, x) => n + x.ws, 0) / s.length / 1048576), peakMb: Math.round(Math.max(...s.map((x) => x.ws)) / 1048576), n: s.length };
}

/* ---- page helpers ---------------------------------------------------------------------------------- */
async function guestTarget(q, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    let list = [];
    try { list = await q.targets(); } catch (e) { list = []; }
    const t = list.find((x) => /\/watch\.html(\?|#|$)/.test(String(x.url)) && x.webSocketDebuggerUrl);
    if (t) return t;
    await sleep(60);
  }
  return null;
}
async function openGuest(q, ms) {
  const t = await guestTarget(q, ms);
  if (!t) throw new Error('the Watch page never appeared as a CDP target');
  const g = await new Cdp(t.webSocketDebuggerUrl).open();
  await g.send('Runtime.enable');
  await g.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return g;
}
const centerOf = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
  let b = e.getBoundingClientRect(); if (!b.width || !b.height) return null;
  if (b.top < 0 || b.bottom > innerHeight || b.left < 0 || b.right > innerWidth) { try { e.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (err) { /* gone */ } b = e.getBoundingClientRect(); }
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`;
async function click(c, sel) {
  const r = await c.ev(centerOf(sel));
  if (!r) return false;
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
  return true;
}
async function ctrlAltW(chrome) {
  await chrome.ev('(() => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); return 1; })()').catch(() => 0);
  const base = { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, modifiers: 3 };
  await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}
const ACTIVE_IS_WATCH = '(() => { const w = findWatchTab(); return !!w && activeTabId === w.id; })()';
const FRESH = "(document.getElementById('fresh').textContent || '').replace(/\\s+/g, ' ').trim()";
/** First request time per service since t (the mock's log): the order the reads started in. */
function startOrder(mock, t) {
  const first = {};
  for (const l of mock.log) if (l.t >= t && IDS.indexOf(l.svc) !== -1 && first[l.svc] === undefined) first[l.svc] = l.t;
  return Object.keys(first).sort((a, b) => first[a] - first[b]).map((id) => ({ id, t: first[id] }));
}

run('watch-auto-e2e', async (k) => {
  const { launch, say, profileDir } = k;
  const check = k.check;
  for (const f of [OPEN_STUB, EDGE_STUB, GAME_FILE, SAVER_FILE]) { try { fs.rmSync(f, { force: true }); } catch (e) { /* none */ } }
  process.on('exit', () => { for (const f of [OPEN_STUB, EDGE_STUB, GAME_FILE, SAVER_FILE, SAMPLER]) { try { fs.rmSync(f, { force: true }); } catch (e) { /* none */ } } });
  const mock = await Mock.start({ log: () => {} });
  const baseEnv = {
    QUARTZ_WATCH_BOOT_GRACE_MS: '0',
    QUARTZ_WATCH_REBASE: JSON.stringify(mock.rebase),
    QUARTZ_WATCH_OPEN_STUB: OPEN_STUB,
    QUARTZ_EDGE_STUB: EDGE_STUB,
    QUARTZ_WATCH_MIN_FREE_GB: '0',
    QUARTZ_WATCH_BG_MIN_FREE_GB: '0',      // the 2.5 GB gate is the harness's (both ways); this box is often under it
    QUARTZ_WATCH_GAME_FILE: GAME_FILE,
    QUARTZ_WATCH_SAVER_FILE: SAVER_FILE,
  };
  // A mock page alive = a hidden reader on it. Sampled every 150 ms for the whole run.
  let q = null;
  const poll = { max: 0, on: true, live: [] };
  const poller = (async () => {
    while (poll.on) {
      if (q) {
        try {
          const n = (await q.targets()).filter((t) => t.type === 'page' && IDS.some((id) => String(t.url).indexOf(mock.origin(id)) === 0)).length;
          poll.max = Math.max(poll.max, n);
        } catch (e) { /* between targets */ }
      }
      await sleep(150);
    }
  })();

  /* ================================ boot 1: the background refresh ================================ */
  const bgAges = { youtube: 70, disney: 90, prime: 65, espn: 80 };
  const bgWant = oldestFirst(bgAges, 60);
  seedCache(profileDir, bgAges, 60);
  fs.writeFileSync(SAVER_FILE, 'on');
  const t1 = Date.now();
  q = await launch({ cdp: CDP_PORT, env: Object.assign({}, baseEnv, { QUARTZ_WATCH_BG_BOOT_MS: '3000', QUARTZ_WATCH_BG_GAP_MS: String(BG_GAP_MS), QUARTZ_WATCH_BG_EVERY_MS: String(20 * 60e3), QUARTZ_WATCH_BG_PAUSE_MS: '3000', QUARTZ_WATCH_BG_TIMER_MIN_MS: '1000' }) });
  const chrome = q.chrome;
  const describe = () => chrome.ev('window.api.watch.describe()');
  check((await chrome.ev('tabs.filter((t) => t && isWatchUrl(t.url)).length')) === 0, 'boot 1: no Watch tab is open');
  await sleep(9000);
  const hitsSaver = IDS.reduce((n, id) => n + mock.hits(id, t1), 0);
  let d1 = await describe();
  check(hitsSaver === 0 && d1 && d1.background && /battery saver/.test(d1.background.waiting), 'bg: battery saver on: no background read in 9 s, and describe() says why', { hits: hitsSaver, bg: d1 && d1.background });
  check(d1 && d1.background && d1.background.on === true, 'bg: the background refresh is on by default');
  fs.rmSync(SAVER_FILE, { force: true });
  const tOff = Date.now();
  let first = null;
  try { first = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 15000) { const o = startOrder(mock, tOff); if (o.length) return o[0]; await sleep(100); } return null; })(); } catch (e) { first = null; }
  check(!!first && first.id === bgWant[0], 'bg: battery saver off: the background refresh reads, oldest first (' + NAMES[bgWant[0]] + '), with no Watch tab open', first);
  // A game starts while the first read runs: the next one waits and says why.
  fs.writeFileSync(GAME_FILE, 'on');
  await sleep(9000);
  const afterGame = startOrder(mock, tOff).map((x) => x.id);
  d1 = await describe();
  check(afterGame.length === 1 && /VALORANT/.test(d1.background.waiting), 'bg: a game: the next background read waits, and describe() says why', { order: afterGame, waiting: d1.background.waiting });
  fs.rmSync(GAME_FILE, { force: true });
  const tGame = Date.now();
  try { await chrome.waitFor('window.api.watch.describe().then((d) => d.services.every((s) => s.readAt >= ' + tOff + ') && !d.reading)', 40000); } catch (e) { say('bg: waiting for all four: ' + e.message.slice(0, 160)); }
  const order = startOrder(mock, tOff);
  check(order.map((x) => x.id).join(',') === bgWant.join(','), 'bg: game gone: the rest read, oldest first', { got: order.map((x) => x.id), want: bgWant });
  const gaps = order.slice(1).map((x, i) => x.t - order[i].t);
  check(gaps.length === IDS.length - 1 && gaps.every((g) => g >= BG_GAP_MS - 300), 'bg: background reads start at least the gap (' + BG_GAP_MS + ' ms) apart', gaps);
  check(poll.max <= 1, 'bg: never more than one hidden reader page at a time', poll.max);
  d1 = await describe();
  check(d1.background.waiting === '' && d1.background.reads >= 4 && d1.background.lastAt >= tGame, 'bg: describe() shows the reads, waiting nothing', d1.background);
  // Off: nothing more, even when due.
  await chrome.ev('window.api.watch.setBackground(false)');
  d1 = await describe();
  check(d1.background.on === false, 'bg: watch:set-background(false) turns it off');

  let measured = null;
  if (MEASURE) {
    measured = {};
    const pid = q.child.pid;
    const sm = sampler(pid, 500, 900);
    await sleep(3000);
    // Idle, Watch not on screen, nothing due: background refresh on vs off, ABAB, 45 s each.
    const legs = [];
    for (const on of [true, false, true, false]) {
      await chrome.ev('window.api.watch.setBackground(' + on + ')');
      await sleep(5000);
      const a = Date.now();
      await sleep(45000);
      legs.push({ on, w: window_(sm.samples, a, Date.now()) });
    }
    measured.idle = legs;
    say('measure idle (Watch not on screen): ' + legs.map((l) => (l.on ? 'on ' : 'off ') + (l.w ? l.w.cpuPct + '% ' + l.w.wsMb + ' MB' : '?')).join(' | '));
    // One forced read per service, 15 s apart: the tree's peak working set over the 3 s before, and its CPU.
    measured.reads = {};
    for (const id of IDS) {
      await sleep(6000);
      const pre = window_(sm.samples, Date.now() - 4000, Date.now());
      const a = Date.now();
      await chrome.ev('window.api.watch.refresh(' + JSON.stringify(id) + ')');
      try { await chrome.waitFor('window.api.watch.describe().then((d) => { const s = d.services.find((x) => x.id === ' + JSON.stringify(id) + '); return s.readAt >= ' + a + ' && !d.reading; })', 60000); } catch (e) { say('measure ' + id + ': ' + e.message.slice(0, 120)); }
      const b = Date.now();
      await sleep(1500);
      const s = sm.samples.filter((x) => x.t >= a && x.t <= b + 1500);
      const cpuMs = s.length > 1 ? s[s.length - 1].cpu - s[0].cpu : null;
      measured.reads[id] = { ms: b - a, peakMbOverBase: pre && s.length ? Math.round(Math.max(...s.map((x) => x.ws)) / 1048576 - pre.wsMb) : null, cpuMs, cpuPctDuring: cpuMs !== null ? +(cpuMs / (b - a + 1500) * 100).toFixed(1) : null, procsPeak: s.length ? Math.max(...s.map((x) => x.n)) : null };
      say('measure read ' + id + ': ' + JSON.stringify(measured.reads[id]));
    }
    await sm.stop();
    await chrome.ev('window.api.watch.setBackground(false)');
  }
  const tQuiet = Date.now();
  await sleep(4000);
  check(IDS.reduce((n, id) => n + mock.hits(id, tQuiet), 0) === 0, 'bg off: nothing reads in the background');
  await q.quit();

  /* ================================ boot 2: fresh on open ================================ */
  const openAges = { youtube: 30, disney: 50, prime: 20, espn: 40 };
  const openWant = oldestFirst(openAges, 15);
  seedCache(profileDir, openAges, 15);
  q = await launch({ cdp: CDP_PORT, env: Object.assign({}, baseEnv, { QUARTZ_WATCH_BG_BOOT_MS: String(60 * 60e3), QUARTZ_WATCH_WATCHED_AWAY_MS: '2000', QUARTZ_WATCH_READ_LIMIT_MS: '15000' }) });
  const chrome2 = q.chrome;
  poll.max = 0;
  const t2 = Date.now();
  await ctrlAltW(chrome2);
  await chrome2.waitFor(ACTIVE_IS_WATCH, 8000).catch(() => 0);
  const g = await openGuest(q, 10000);
  let seedDrawn = null;
  try { seedDrawn = await g.waitFor("(() => { const c = [...document.querySelectorAll('#stack .card')].filter((c) => /^Seed /.test((c._item && c._item.title) || '')); return c.length ? c.length : null; })()", 4000); } catch (e) { seedDrawn = null; }
  const readsDoneAtSeed = IDS.filter((id) => mock.hits(id, t2) > 0).length;
  check(!!seedDrawn, 'open: the cached rows draw at once (' + seedDrawn + ' seed cards; reads started for ' + readsDoneAtSeed + ' service(s) by then)');
  // While the reads run: the header's words, the rows never blank, no scroll jump.
  const seen = new Set();
  const samples = { blank: 0, n: 0, scroll: new Set(), rowKey: new Set() };
  const startKey = await g.ev("(document.querySelector('#stack .lrow[data-d=\"0\"]') || {}).dataset ? document.querySelector('#stack .lrow[data-d=\"0\"]').dataset.key : ''").catch(() => '');
  const tEnd = Date.now() + 60000;
  while (Date.now() < tEnd) {
    const s = await g.ev('(() => ({ f: ' + FRESH + ', cards: document.querySelectorAll("#stack .card").length, y: Math.round(window.scrollY), key: ((document.querySelector("#stack .lrow[data-d=\\"0\\"]") || {}).dataset || {}).key || "" }))()').catch(() => null);
    if (s) { seen.add(s.f); samples.n++; if (!s.cards) samples.blank++; samples.scroll.add(s.y); samples.rowKey.add(s.key); }
    const done = IDS.every((id) => mock.hits(id, t2) > 0) && s && /^Updated /.test(s.f);
    if (done) break;
    await sleep(120);
  }
  const order2 = startOrder(mock, t2).map((x) => x.id);
  check(order2.join(',') === openWant.join(','), 'open: every service over 10 min old reads, oldest first', { got: order2, want: openWant });
  check(poll.max <= 1, 'open: one hidden reader at a time', poll.max);
  const words = Array.from(seen);
  check(words.some((w) => /^Updating Disney\+…$/.test(w)) && words.some((w) => /^Updating Prime Video…$/.test(w)), 'header: "Updating Disney+…" / "Updating Prime Video…" while each reads', words);
  const final = await g.ev(FRESH);
  check(/^Updated (just now|1 min ago)$/.test(final), 'header: idle after the reads: "' + final + '"');
  check(!words.some((w) => /Reading/.test(w)), 'header: never "Reading…"', words);
  check(samples.n > 5 && samples.blank === 0, 'in place: the rows never went blank while they updated (' + samples.n + ' samples)', samples.blank);
  check(samples.scroll.size === 1, 'in place: no scroll jump', Array.from(samples.scroll));
  check(Array.from(samples.rowKey).every((x) => x === startKey || x === ''), 'in place: the row in front stayed the row in front', { start: startKey, seen: Array.from(samples.rowKey) });
  const fixtureDrawn = await g.ev("[...document.querySelectorAll('#stack .card')].filter((c) => c._item && !/^Seed /.test(c._item.title || '')).length").catch(() => 0);
  check(fixtureDrawn > 0, 'in place: the fresh rows replaced the cached ones (' + fixtureDrawn + ' fixture cards)');

  // A quick flip to another tab and back: nothing is stale, nothing reads.
  const tFlip = Date.now();
  await chrome2.ev('(() => { createTab(); return 1; })()');
  await chrome2.waitFor('!' + ACTIVE_IS_WATCH, 5000).catch(() => 0);
  await sleep(800);
  await chrome2.ev('(() => { const w = findWatchTab(); const o = tabs.filter((t) => t.id !== w.id); for (const t of o) closeTab(t.id); activateTab(w.id); return 1; })()');
  await chrome2.waitFor(ACTIVE_IS_WATCH, 5000).catch(() => 0);
  await sleep(4000);
  check(IDS.reduce((n, id) => n + mock.hits(id, tFlip), 0) === 0, 'flip: back in front 1 s later, nothing under 10 min old reads');

  // Fresh after watching: a YouTube title opened from Watch (a Quartz tab), then back to Watch.
  const opened = await g.ev(`(() => { const c = [...document.querySelectorAll('#stack .lrow .rt > .card')].find((c) => c._item && c._item.service === 'youtube');
    if (!c) return null; c.setAttribute('data-e2e-card', '1'); c.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return c._item.url; })()`).catch(() => null);
  let ytTab = false;
  if (opened) {
    await sleep(400);
    await click(g, '[data-e2e-card="1"]');
    try { ytTab = await chrome2.waitFor('!' + ACTIVE_IS_WATCH + ' && tabs.some((t) => String(t.url).indexOf(' + JSON.stringify(mock.origin('youtube')) + ') === 0)', 6000); } catch (e) { ytTab = false; }
  }
  check(!!opened && !!ytTab, 'watched: a YouTube card opens a Quartz tab (Watch goes behind it)', opened);
  await sleep(3000);   // away over QUARTZ_WATCH_WATCHED_AWAY_MS (2 s)
  const tBack = Date.now();
  await chrome2.ev('(() => { const w = findWatchTab(); for (const t of tabs.filter((t) => t.id !== w.id)) closeTab(t.id); activateTab(w.id); return 1; })()');
  await chrome2.waitFor(ACTIVE_IS_WATCH, 5000).catch(() => 0);
  await sleep(8000);
  const backHits = {}; for (const id of IDS) backHits[id] = mock.hits(id, tBack);
  check(backHits.youtube > 0 && IDS.every((id) => id === 'youtube' || backHits[id] === 0), 'watched: back on Watch, YouTube (only) re-reads: its Continue watching moved', backHits);

  // The time limit: Disney+ never answers (mock "slow"); past 15 s Watch stops it and the header says why, with Retry.
  await mock.setMode('disney', 'slow');
  const tSlow = Date.now();
  await g.ev("console.log('quartz-watch:refresh ' + JSON.stringify({ service: 'disney' })), 1");
  let updating = null;
  try { updating = await g.waitFor(FRESH + " === 'Updating Disney+…' ? 1 : null", 6000); } catch (e) { updating = null; }
  check(!!updating, 'limit: "Updating Disney+…" while the read hangs');
  let failed = null;
  try { failed = await g.waitFor("(() => { const t = " + FRESH + "; return /^Couldn’t update Disney\\+: .*longer than 15 s/.test(t) && !!document.querySelector('#fresh .fresh-retry') ? t : null; })()", 30000); } catch (e) { failed = e.message.slice(0, 200); }
  const tFailed = Date.now();
  check(typeof failed === 'string' && /^Couldn’t update/.test(failed) && tFailed - tSlow < 15000 + 9000, 'limit: past its 15 s limit the header says why and offers Retry (' + Math.round((tFailed - tSlow) / 1000) + ' s)', failed);
  check(poll.max <= 1 && (await q.targets()).filter((t) => t.type === 'page' && String(t.url).indexOf(mock.origin('disney')) === 0).length === 0, 'limit: the stopped reader page is gone');
  await mock.setMode('disney', 'ok');
  const tRetry = Date.now();
  await click(g, '#fresh .fresh-retry');
  let recovered = null;
  try { recovered = await g.waitFor("/^Updated /.test(" + FRESH + ") ? " + FRESH + " : null", 30000); } catch (e) { recovered = null; }
  check(!!recovered && mock.hits('disney', tRetry) > 0, 'limit: Retry (a real click, right away) reads Disney+ again and the header is back to "' + recovered + '"');

  // Settings > Watch: the background switch and its cost line.
  await click(g, '#settings');
  let sw = null;
  try { sw = await chrome2.waitFor("(() => { const b = document.querySelector('.set-watch-bg'); if (!Settings.isOpen() || !b) return null; return { label: b.textContent.trim(), on: b.getAttribute('aria-checked'), hint: (b.nextElementSibling || {}).textContent || '', state: (document.querySelector('.set-watch-bg-state') || {}).textContent || '' }; })()", 8000); } catch (e) { sw = null; }
  check(!!sw && sw.label === 'Keep Watch up to date in the background' && sw.on === 'true', 'settings: "Keep Watch up to date in the background", on', sw);
  check(!!sw && /once an hour/.test(sw.hint) && /2\.5 GB/.test(sw.hint) && /battery saver/.test(sw.hint), 'settings: one line says what it costs and when it skips', sw && sw.hint);
  await click(chrome2, '.set-watch-bg');
  let offNow = null;
  try { offNow = await chrome2.waitFor("window.api.watch.describe().then((d) => d.background.on === false && (document.querySelector('.set-watch-bg') || {}).getAttribute && document.querySelector('.set-watch-bg').getAttribute('aria-checked') === 'false')", 5000); } catch (e) { offNow = null; }
  check(!!offNow, 'settings: a click turns it off (main and the switch agree)');
  await click(chrome2, '.set-watch-bg');
  let onNow = null;
  try { onNow = await chrome2.waitFor("window.api.watch.describe().then((d) => d.background.on === true)", 5000); } catch (e) { onNow = null; }
  check(!!onNow, 'settings: and back on');
  g.close();
  await q.quit();
  poll.on = false;
  await poller;
  await mock.close();
  if (measured) console.log('[measure] ' + JSON.stringify(measured));
});
