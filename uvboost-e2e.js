// uvboost-e2e.js -- uvboost.js in a REAL Electron main process (tests/uvboost-e2e-main.js),
// checked from OUTSIDE the process (PowerShell's own view of the threads, not uvboost's koffi):
//   - by default exactly one thread changes priority, to uvboost's DEFAULT_LEVEL, and that thread
//     is Electron's libuv embed thread: not the window's UI thread, and it wakes for every packet
//     the main process puts on libuv's port (40 uv_async_sends -> its context switches climb);
//   - the UI thread keeps Chromium's AboveNormal and its boost;
//   - the quartz.log line says so in words; the CPU guard reads that thread and finds it quiet;
//   - a guard limit it is over (UVB_GUARD_MAX=-1) puts the thread back to Normal, said in words;
//   - QUARTZ_UVBOOST=0 changes nothing.
//   node uvboost-e2e.js            -> "uvboost-e2e: N passed, M failed"
// Launches one hidden Electron window at a time (no Quartz, no real user profile); RAM-gated.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname;
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const MAIN = path.join(ROOT, 'tests', 'uvboost-e2e-main.js');
const THREADS = path.join(ROOT, 'tools', 'efficiency', 'wake-threads.ps1');
const ub = require(path.join(ROOT, 'uvboost.js'));
const PS_NAME = { abovenormal: 'AboveNormal', highest: 'Highest', timecritical: 'TimeCritical' };
const WANT = PS_NAME[ub.DEFAULT_LEVEL];

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('ok   ' + name + (detail ? '  (' + detail + ')' : '')); } else { fail++; console.log('FAIL ' + name + (detail ? '  ' + detail : '')); }
}

if (process.platform !== 'win32') { console.log('uvboost-e2e: not launched: Windows only'); console.log('uvboost-e2e: 0 passed, 0 failed'); process.exit(0); }
const { MIN_FREE_GB, freeRamGb } = require(path.join(ROOT, 'testwatch'));
const free = freeRamGb();
if (!(free >= MIN_FREE_GB)) { console.log('uvboost-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }

const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 90000 });

/** From outside: the window's owner thread, and every thread's priority level and boost. */
function inspect(pid, hwnd) {
  const out = ps([
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace UvbE2e -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);'",
    '$owner = 0',
    '$tid = [UvbE2e.U]::GetWindowThreadProcessId([IntPtr][Int64]' + BigInt(hwnd).toString() + ', [ref]$owner)',
    "'UVB-OWNER ' + $tid + ' ' + $owner",
    '$p = Get-Process -Id ' + Number(pid),
    "foreach ($t in $p.Threads) { try { 'UVB-T ' + $t.Id + ' ' + $t.PriorityLevel + ' ' + $t.PriorityBoostEnabled } catch { } }",
  ].join('; '));
  const r = { threads: new Map() };
  for (const l of out.split(/\r?\n/)) {
    let m = /^UVB-OWNER (\d+) (\d+)/.exec(l);
    if (m) { r.ui = Number(m[1]); r.owner = Number(m[2]); continue; }
    m = /^UVB-T (\d+) (\w+) (\w+)/.exec(l);
    if (m) r.threads.set(Number(m[1]), { level: m[2], boost: m[3] === 'True' });
  }
  return r;
}

/** Context switches of every thread of `pid` (tools/efficiency/wake-threads.ps1). */
function ctx(pid) {
  const j = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', THREADS, '-Pids', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 90000 }));
  return new Map(((j.p[String(pid)] || {}).th || []).map((x) => [x[0], x[1]]));
}

/** Threads whose priority level differs between two inspect()s of the same process: [[tid, before, after]]. */
function changed(a, b) {
  const out = [];
  for (const [t, v] of b.threads) { const w = a.threads.get(t); if (w && w.level !== v.level) out.push([t, w.level, v.level]); }
  return out;
}

/**
 * One launch. env: QUARTZ_UVBOOST etc.; o.poke: run the 40 uv_async_sends and measure context
 * switches; o.guardMs: the guard's interval (waits for UVB-GUARD and inspects once more).
 */
function run(env, o) {
  return new Promise((resolve) => {
    const tag = path.join(os.tmpdir(), 'uvboost-e2e-' + process.pid + '-' + Date.now());
    const goFile = tag + '-go', pokeFile = tag + '-poke';
    const childEnv = Object.assign({}, process.env, env, { UVB_GO_FILE: goFile, UVB_POKE_FILE: pokeFile, UVB_GUARD_MS: String(o.guardMs || '') });
    const child = spawn(ELECTRON, [MAIN], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    const r = { lines: [] };
    let buf = '', done = false, poked = !o.poke, guarded = !o.guardMs;
    const finish = (extra) => {
      if (done) return; done = true;
      clearTimeout(killer);
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (e) { /* gone */ }
      for (const f of [goFile, pokeFile]) { try { fs.unlinkSync(f); } catch (e) { /* never made */ } }
      resolve(Object.assign(r, extra || {}));
    };
    const killer = setTimeout(() => finish({ error: 'timed out (pre ' + !!r.pre + ', ready ' + !!r.ready + ', poked ' + poked + ', guarded ' + guarded + ')' }), 80000);
    const step = (fn) => { try { fn(); } catch (e) { finish({ error: String(e && e.message).slice(0, 300) }); } };
    const maybeDone = () => { if (r.ready && poked && guarded) finish(); };
    const onLine = (l) => {
      if (l.startsWith('UVB-LINE ')) { r.lines.push(l.slice(9)); return; }
      if (l.startsWith('UVB-PRE ')) {
        step(() => { r.info = JSON.parse(l.slice(8)); r.pre = inspect(r.info.pid, r.info.hwnd); fs.writeFileSync(goFile, 'go'); });
      } else if (l.startsWith('UVB-READY ')) {
        step(() => {
          r.status = JSON.parse(l.slice(10)).status;
          r.post = inspect(r.info.pid, r.info.hwnd);
          r.ready = true;
          if (o.poke) { r.before = ctx(r.info.pid); fs.writeFileSync(pokeFile, 'go'); }
          maybeDone();
        });
      } else if (/^POKED \d+/.test(l)) {
        step(() => { const after = ctx(r.info.pid); r.delta = new Map([...after].map(([t, n]) => [t, n - (r.before.get(t) || 0)])); poked = true; maybeDone(); });
      } else if (l.startsWith('UVB-GUARD ')) {
        step(() => { r.guardStatus = JSON.parse(l.slice(10)).status; r.afterGuard = inspect(r.info.pid, r.info.hwnd); guarded = true; maybeDone(); });
      }
    };
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while (!done && (i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); onLine(l); }
    });
    child.stderr.on('data', () => { /* Chromium chatter */ });
    child.on('close', () => finish({ error: 'exited early' }));
  });
}

(async () => {
  console.log('uvboost-e2e: default level ' + ub.DEFAULT_LEVEL + ' (' + WANT + ')');
  const on = await run({ QUARTZ_UVBOOST: '' }, { poke: true, guardMs: 2000 });
  const st = on.status;
  ok('default: Electron ' + (on.info && on.info.electron) + ' ran it', !!on.ready && !on.error, on.error);
  ok('default: uvboost applied at ' + ub.DEFAULT_LEVEL, !!st && st.state === 'applied' && st.level === ub.DEFAULT_LEVEL && st.tid > 0, JSON.stringify(st));
  const ch = on.pre && on.post ? changed(on.pre, on.post) : [];
  ok('exactly one thread changed priority, read from outside', ch.length === 1, JSON.stringify(ch));
  ok('it is the thread uvboost names, now ' + WANT + ' (was Normal)', ch.length === 1 && !!st && ch[0][0] === st.tid && ch[0][2] === WANT && ch[0][1] === 'Normal', JSON.stringify(ch));
  const seen = on.post || { threads: new Map() };
  ok('the window belongs to this process', !!on.info && seen.owner === on.info.pid, seen.owner + ' vs ' + (on.info && on.info.pid));
  ok('it is not the window\'s UI thread', !!st && seen.ui > 0 && seen.ui !== st.tid, 'ui ' + seen.ui + ', raised ' + (st && st.tid));
  const ui = seen.threads.get(seen.ui);
  ok('the UI thread keeps AboveNormal and its boost', !!ui && ui.level === 'AboveNormal' && ui.boost === true, JSON.stringify(ui));
  const d = on.delta || new Map();
  const rank = [...d].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const dEmb = st ? d.get(st.tid) || 0 : 0;
  ok('it wakes for the main process\'s libuv packets (40 uv_async_sends)', dEmb >= 20, dEmb + ' context switches; UI thread ' + (d.get(seen.ui) || 0));
  ok('it is among the 3 threads that woke most', !!st && rank.slice(0, 3).includes(st.tid), 'top ' + rank.slice(0, 3).map((t) => t + ':' + d.get(t)).join(' '));
  const okLine = on.lines.find((l) => l.startsWith('Idle wakeup-storm fix on:'));
  ok('quartz.log line in words, naming the thread and the level', !!okLine && !!st && okLine.includes('thread ' + st.tid) && okLine.includes(WANT) && okLine.includes('up from Normal'), JSON.stringify(on.lines));
  const gs = on.guardStatus;
  ok('the guard read the raised thread and found it quiet (< 5% of a core)', !!gs && typeof gs.share === 'number' && gs.share >= 0 && gs.share < 0.05 && gs.state === 'applied', JSON.stringify(gs));
  ok('still ' + WANT + ' after the guard ran', !!on.afterGuard && !!st && (on.afterGuard.threads.get(st.tid) || {}).level === WANT);

  const und = await run({ QUARTZ_UVBOOST: '', UVB_GUARD_MAX: '-1' }, { guardMs: 1500 });
  const su = und.guardStatus;
  ok('guard over its limit: state undone', !!su && su.state === 'undone' && su.tid > 0, JSON.stringify(su) + (und.error ? ' ' + und.error : ''));
  ok('guard over its limit: the thread is back at Normal, read from outside', !!su && !!und.afterGuard && (und.afterGuard.threads.get(su.tid) || {}).level === 'Normal',
    JSON.stringify(su && und.afterGuard && und.afterGuard.threads.get(su.tid)));
  ok('guard over its limit: no thread is left changed', !!und.pre && !!und.afterGuard && changed(und.pre, und.afterGuard).length === 0, JSON.stringify(und.pre && und.afterGuard && changed(und.pre, und.afterGuard)));
  ok('guard over its limit: quartz.log says it was undone and why', und.lines.some((l) => l.startsWith('Idle wakeup-storm fix undone:') && l.includes('is back at Normal') && /% of a CPU core/.test(l)), JSON.stringify(und.lines));

  const off = await run({ QUARTZ_UVBOOST: '0' }, {});
  const st0 = off.status;
  ok('QUARTZ_UVBOOST=0: state off', !!st0 && st0.state === 'off', JSON.stringify(st0) + (off.error ? ' ' + off.error : ''));
  ok('QUARTZ_UVBOOST=0: no thread changed, UI thread untouched', !!off.pre && !!off.post && changed(off.pre, off.post).length === 0 && (off.post.threads.get(off.post.ui) || {}).level === 'AboveNormal',
    JSON.stringify(off.pre && off.post && changed(off.pre, off.post)));
  ok('QUARTZ_UVBOOST=0: quartz.log says it is off', off.lines.some((l) => l.startsWith('Idle wakeup-storm fix: off')), JSON.stringify(off.lines));

  console.log(`uvboost-e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
