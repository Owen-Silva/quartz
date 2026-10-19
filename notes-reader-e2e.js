try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine (a cloud runner): no cap needed */ }   // first: one capped browser at a time (The user, 2026-09-17)
// school-reader-e2e.js -- school-reader.ps1 against a Chromium stand-in for LessonPlayer
// (tests/school-standin.js). The user's LessonPlayer is never touched: the reader is pointed at the
// stand-in's process name, schoolstandin (a hardlink of electron.exe).
//
//   node school-reader-e2e.js                         the checks below
//   node school-reader-e2e.js --bench [--script <ps1>|none] [--secs 90] [--every 20]
//                                                     CPU of the reader and of the stand-in
//                                                     while school.js's 3 s reads run; the
//                                                     question changes every --every seconds
//
// Checks, doc mode (Chromium's TextPattern): a first read walks and returns the question; with
// nothing changing later reads come from the gate (cached, same text) and no UIA event is
// subscribed; a new question makes the next read walk (doc-changed) and return it; max-age and
// force walk; OCR does not re-run the engine on identical pixels. Events mode (TextPattern
// hidden by a test hook): reads are gated by UIA change events, a new question walks (events);
// a provider that raises no events is caught by the max-age safety read, which turns the gate
// off and says so, after which every read walks.
// STANDIN_MSAA=1 / STANDIN_EXTRA=N shape the stand-in (see tests/school-standin.js). Not launched under 2.5 GB free RAM (exit 3).
// testwatch.js fails the run if the stand-in ever touches the visible desktop (not in --bench:
// its 25 ms poll would pollute the measurement; the window is still created at -20000,-20000).
// Kills ONLY the processes it started. One summary line: "school-reader-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { MIN_FREE_GB, freeRamGb, startWatcher } = require('./testwatch');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BENCH = argv.includes('--bench');
const SCRIPT = opt('script', path.join(__dirname, 'school-reader.ps1'));
const SECS = Number(opt('secs', '90'));
const EVERY = Number(opt('every', '20'));
const DIST = path.join(__dirname, 'node_modules', 'electron', 'dist');
const STANDIN_EXE = path.join(DIST, 'schoolstandin.exe');
const PROC = 'schoolstandin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
}

/* ---- CPU time of a pid (kernel + user), in ms --------------------------------------------- */
let k32 = null;
function cpuMs(pid) {
  if (!k32) {
    const koffi = require('koffi');
    const lib = koffi.load('kernel32.dll');
    k32 = {
      open: lib.func('void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      times: lib.func('bool __stdcall GetProcessTimes(void* h, _Out_ uint64_t* c, _Out_ uint64_t* e, _Out_ uint64_t* k, _Out_ uint64_t* u)'),
      close: lib.func('bool __stdcall CloseHandle(void* h)'),
    };
  }
  const h = k32.open(0x1000, false, pid);
  if (!h) return NaN;
  const c = [0], e = [0], k = [0], u = [0];
  const ok = k32.times(h, c, e, k, u);
  k32.close(h);
  return ok ? (Number(k[0]) + Number(u[0])) / 1e4 : NaN;
}

/* ---- a JSON-lines child ----------------------------------------------------------------- */
function lineChild(file, args, env) {
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: Object.assign({}, process.env, env || {}) });
  const waiters = [];
  const lines = [];
  let buf = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.shift();
      if (w) w(msg); else lines.push(msg);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { err = (err + d).slice(-600); });
  return {
    child,
    get err() { return err; },
    next(timeoutMs) {
      if (lines.length) return Promise.resolve(lines.shift());
      return new Promise((resolve) => {
        const t = setTimeout(() => { const i = waiters.indexOf(fn); if (i >= 0) waiters.splice(i, 1); resolve({ ok: false, reason: 'timeout' }); }, timeoutMs || 20000);
        const fn = (m) => { clearTimeout(t); resolve(m); };
        waiters.push(fn);
      });
    },
    send(obj, timeoutMs) { child.stdin.write(JSON.stringify(obj) + '\n'); return this.next(timeoutMs); },
  };
}
function killPid(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ } }

let readId = 0;
const read = (r, extra) => r.send(Object.assign({ id: ++readId, cmd: 'read', process: PROC }, extra || {}), 20000);
const has = (m, s) => !!(m && m.ok && String(m.text || '').indexOf(s) !== -1);

async function main() {
  const free = freeRamGb();
  if (!(free >= MIN_FREE_GB)) {
    console.log('school-reader-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB');
    process.exit(3);
  }
  if (!fs.existsSync(STANDIN_EXE)) fs.linkSync(path.join(DIST, 'electron.exe'), STANDIN_EXE);

  const watcher = BENCH ? null : startWatcher();
  if (watcher) await watcher.ready;
  const standin = lineChild(STANDIN_EXE, [path.join(__dirname, 'tests', 'school-standin.js')], { STANDIN_PARENT_PID: String(process.pid) });
  const up = await standin.next(60000);
  standin.cmd = async (c) => { try { return await (await fetch('http://127.0.0.1:' + up.port + '/' + c)).json(); } catch (e) { return { ok: false, reason: String(e.message || e) }; } };
  if (!up.ready) { console.log('the stand-in never came up: ' + JSON.stringify(up) + ' ' + standin.err); killPid(standin.child.pid); process.exit(1); }
  if (watcher) watcher.watch(up.pid);
  await sleep(1500);

  let reader = null;
  try {
    if (BENCH) await bench(standin);
    else {
      reader = lineChild('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { SCHOOL_READER_TEST: '1' });
      await checks(standin, reader);
    }
  } finally {
    if (reader) { try { reader.child.stdin.write('{"id":0,"cmd":"quit"}\n'); } catch (e) { /* gone */ } await sleep(400); killPid(reader.child.pid); }
    if (standin.cmd) await standin.cmd('quit');
    await sleep(800);
    killPid(standin.child.pid);
    if (watcher) { const v = watcher.verdict(); watcher.stop(); check(v.ok, v.line); }
  }
  if (!BENCH) console.log('school-reader-e2e: ' + pass + ' passed, ' + fail + ' failed');
}

async function settle(r, extra) {
  let n = 0, m = null;
  for (; n < 8; n++) { await sleep(1000); m = await read(r, extra); if (m.cached) break; }
  return { n: n + 1, m };
}

async function checks(standin, r) {
  const ping = await r.send({ id: ++readId, cmd: 'ping' });
  check(ping.ok && ping.gate === '', 'the reader starts with the change gate on', ping);

  /* ---- doc mode: the page has a TextPattern, so a read re-asks for its text and compares ---- */
  const first = await read(r);
  check(first.ok && !first.cached && first.walked === 'first', 'first read walks the tree', { walked: first.walked, cached: first.cached, via: first.via, nodes: first.nodes, reason: first.reason });
  check(has(first, 'Question 1:') && has(first, 'Sample Lesson') && has(first, 'Problem 1 of 20'), 'first read has the question, the lesson and the problem number', first.text);
  check(first.watch === 'doc', 'a page with a TextPattern is watched by its text (no event subscription)', first.watch);
  let s = await settle(r);
  check(s.m && s.m.cached, 'with nothing changing, reads come from the gate', 'cached after ' + s.n + ' reads; last walked=' + (s.m && s.m.walked));
  check(s.m && s.m.text === first.text, 'the gated answer is the walked text, unchanged');
  const again = await read(r);
  check(again.cached && again.text === first.text, 'and the next read too', { cached: again.cached, age: again.age });
  const ping1 = await r.send({ id: ++readId, cmd: 'ping' });
  check(/structure 0, name\/value 0, text 0/.test(String(ping1.events)), 'doc mode subscribes to no events', ping1.events);

  await standin.cmd('q?n=' + 2);
  await sleep(300);
  const q2 = await read(r);
  check(!q2.cached && q2.walked === 'doc-changed', 'a new question makes the next read walk (doc-changed)', { cached: q2.cached, walked: q2.walked });
  check(has(q2, 'Question 2:') && has(q2, 'Problem 2 of 20') && !has(q2, 'Question 1:'), 'and it reads the new question', q2.text);
  s = await settle(r);
  check(s.m && s.m.cached && has(s.m, 'Question 2:'), 'then settles back onto the gate', 'cached after ' + s.n + ' reads');
  const old = await read(r, { maxAgeMs: 0 });
  check(!old.cached && old.walked === 'max-age' && old.gate === '', 'the max-age walk still runs in doc mode, and an unchanged page is no "miss"', { walked: old.walked, gate: old.gate });

  const forced = await read(r, { force: true });
  check(!forced.cached && forced.walked === 'forced' && has(forced, 'Question 2:'), 'force always walks', { cached: forced.cached, walked: forced.walked });

  // OCR: identical pixels do not re-run the engine.
  await standin.cmd('anim?on=0');
  await sleep(300);
  const o1 = await r.send({ id: ++readId, cmd: 'ocr', process: PROC }, 30000);
  const o2 = await r.send({ id: ++readId, cmd: 'ocr', process: PROC }, 30000);
  check(o1.ok && o1.cached === false, 'first OCR runs the engine', { ok: o1.ok, cached: o1.cached, chars: o1.chars, reason: o1.reason });
  check(o2.ok && o2.cached === true && o2.text === o1.text, 'a second OCR on unchanged pixels reuses the text', { cached: o2.cached, chars: o2.chars });
  await standin.cmd('anim?on=1');

  /* ---- events mode: no TextPattern (test hook), so UIA change events gate the names walk ---- */
  await r.send({ id: ++readId, cmd: 'test-nodoc' });
  const ev0 = await read(r, { force: true });
  check(ev0.watch === 'events', 'without a TextPattern the reader watches change events', ev0.watch);
  s = await settle(r);
  check(s.m && s.m.cached, 'events mode: with nothing changing, reads come from the gate', 'cached after ' + s.n + ' reads');
  await standin.cmd('q?n=' + 3);
  await sleep(800);
  const q3 = await read(r);
  check(!q3.cached && q3.walked === 'events' && has(q3, 'Question 3:'), 'events mode: a new question makes the next read walk (events) and read it', { cached: q3.cached, walked: q3.walked });

  // A provider that raises no events: the safety read catches the change and turns the gate off.
  s = await settle(r);
  await r.send({ id: ++readId, cmd: 'test-mute' });
  await standin.cmd('q?n=' + 4);
  await sleep(800);
  const stale = await read(r, { maxAgeMs: 600000 });
  check(stale.cached && has(stale, 'Question 3:'), 'with events muted, the gate cannot see the change (the case the safety read exists for)', { cached: stale.cached });
  const safety = await read(r, { maxAgeMs: 0 });
  check(!safety.cached && safety.walked === 'max-age' && has(safety, 'Question 4:'), 'the safety read walks and finds the new question', { walked: safety.walked });
  check(/missed a new page/.test(String(safety.gate || '')), 'and turns the gate off, saying why', safety.gate);
  const after = await read(r);
  check(!after.cached && after.walked === 'gate-off' && has(after, 'Question 4:'), 'after that every read walks', { cached: after.cached, walked: after.walked });
  const ping2 = await r.send({ id: ++readId, cmd: 'ping' });
  check(/missed a new page/.test(String(ping2.gate || '')), 'ping reports the gate is off', ping2.gate);
}


async function bench(standin) {
  const none = SCRIPT === 'none';
  const r = none ? null : lineChild('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT]);
  if (r) {
    const first = await read(r);          // warm-up: assemblies, Chromium's tree
    if (!first.ok) console.log('first read failed: ' + JSON.stringify(first) + ' ' + r.err);
    else console.log('first read: via ' + first.via + ', ' + first.nodes + ' nodes, ' + first.chars + ' chars');
    for (let i = 0; i < 3; i++) { await sleep(3000); await read(r); }
  } else await sleep(12000);

  const cpu0 = { reader: r ? cpuMs(r.child.pid) : 0, standin: (await standin.cmd('cpu')).ms };
  const t0 = Date.now();
  let q = 1, changedAt = 0, seenAt = 0, walks = 0, cached = 0, reads = 0, readMs = 0;
  const latencies = [];
  const texts = {};
  let nextChange = t0 + EVERY * 1000;
  while (Date.now() - t0 < SECS * 1000) {
    const tick = Date.now();
    if (r) {
      const s = Date.now();
      const m = await read(r);
      readMs += Date.now() - s; reads++;
      if (m.cached) cached++; else walks++;
      if (m.ok && !texts[q] && has(m, 'Question ' + q + ':')) texts[q] = m.text;
      if (changedAt && !seenAt && has(m, 'Question ' + q + ':')) { seenAt = Date.now(); latencies.push(seenAt - changedAt); }
    }
    // The question changes MID-tick, as a real one lands at any moment between two 3 s reads.
    await sleep(Math.max(0, 1500 - (Date.now() - tick)));
    if (Date.now() >= nextChange) { q++; await standin.cmd('q?n=' + q); changedAt = Date.now(); seenAt = 0; nextChange += EVERY * 1000; }
    await sleep(Math.max(0, 3000 - (Date.now() - tick)));
  }
  const wall = Date.now() - t0;
  const cpu1 = { reader: r ? cpuMs(r.child.pid) : 0, standin: (await standin.cmd('cpu')).ms };
  const out = {
    script: none ? 'none' : path.basename(SCRIPT), secs: Math.round(wall / 1000), questions: q,
    readerCpuMs: Math.round(cpu1.reader - cpu0.reader), standinCpuMs: Math.round(cpu1.standin - cpu0.standin),
    readerPctOfOneCore: +((cpu1.reader - cpu0.reader) / wall * 100).toFixed(2),
    standinPctOfOneCore: +((cpu1.standin - cpu0.standin) / wall * 100).toFixed(2),
    reads, walks, cached, avgReadMs: reads ? Math.round(readMs / reads) : 0,
    latenciesMs: latencies,
  };
  console.log('BENCH ' + JSON.stringify(out));
  fs.writeFileSync(path.join(require('os').tmpdir(), 'school-bench-' + out.script + '.json'), JSON.stringify({ out, texts }, null, 1));
  if (r) { try { r.child.stdin.write('{"id":0,"cmd":"quit"}\n'); } catch (e) { /* gone */ } await sleep(400); killPid(r.child.pid); }
}

main().catch((e) => { console.log('school-reader-e2e crashed: ' + (e && e.stack || e)); console.log('school-reader-e2e: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
