// uvboost-e2e.js -- uvboost.js in a REAL Electron main process (tests/uvboost-e2e-main.js),
// checked from OUTSIDE the process:
//   - by default it raises exactly one thread to TimeCritical, and that thread is Electron's libuv
//     embed thread: not the window's UI thread, and it wakes for every packet the main process
//     puts on libuv's port (40 uv_async_sends -> its context switches climb with the main thread's);
//   - the UI thread keeps Chromium's AboveNormal and its boost;
//   - QUARTZ_UVBOOST=0 changes nothing.
//   node uvboost-e2e.js            -> "uvboost-e2e: N passed, M failed"
// Launches one hidden Electron window at a time (no Quartz, no profile of the user's); RAM-gated.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname;
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const MAIN = path.join(ROOT, 'tests', 'uvboost-e2e-main.js');
const THREADS = path.join(ROOT, 'tools', 'efficiency', 'wake-threads.ps1');

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

function run(env, withPoke) {
  return new Promise((resolve) => {
    const pokeFile = path.join(os.tmpdir(), 'uvboost-e2e-poke-' + process.pid + '-' + Date.now());
    const child = spawn(ELECTRON, [MAIN], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, env, { UVB_POKE_FILE: pokeFile }) });
    let text = '', done = false, ready = null, before = null;
    const finish = (r) => {
      if (done) return; done = true;
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (e) { /* gone */ }
      try { fs.unlinkSync(pokeFile); } catch (e) { /* never made */ }
      resolve(Object.assign({ ready, seen: ready && ready.seen }, r));
    };
    const killer = setTimeout(() => finish({ error: 'timed out (' + (ready ? 'no POKED' : 'no UVB-READY') + ')' }), 80000);
    child.stdout.on('data', (d) => {
      text += d;
      if (done) return;
      if (!ready) {
        const line = text.split(/\r?\n/).find((l) => l.startsWith('UVB-READY '));
        if (!line) return;
        try { ready = JSON.parse(line.slice(10)); } catch (e) { clearTimeout(killer); finish({ error: 'torn UVB-READY' }); return; }
        let seen;
        try { seen = inspect(ready.pid, ready.hwnd); } catch (e) { clearTimeout(killer); finish({ ready, error: 'inspect: ' + String(e && e.message).slice(0, 300) }); return; }
        if (!withPoke) { clearTimeout(killer); finish({ ready, seen }); return; }
        try { before = ctx(ready.pid); } catch (e) { clearTimeout(killer); finish({ ready, seen, error: 'ctx: ' + String(e && e.message).slice(0, 200) }); return; }
        ready.seen = seen;
        fs.writeFileSync(pokeFile, 'go');
      } else if (/POKED \d+/.test(text)) {
        clearTimeout(killer);
        let after;
        try { after = ctx(ready.pid); } catch (e) { finish({ ready, seen: ready.seen, error: 'ctx: ' + String(e && e.message).slice(0, 200) }); return; }
        const delta = new Map([...after].map(([t, n]) => [t, n - (before.get(t) || 0)]));
        finish({ ready, seen: ready.seen, delta });
      }
    });
    child.stderr.on('data', () => { /* Chromium chatter */ });
    child.on('close', () => { clearTimeout(killer); finish({ ready, error: 'exited early' }); });
  });
}

(async () => {
  const on = await run({ QUARTZ_UVBOOST: '' }, true);
  const st = on.ready && on.ready.status, seen = on.seen || { threads: new Map() };
  ok('default: Electron ' + (on.ready && on.ready.electron) + ' ran it', !!on.ready && !on.error, on.error);
  ok('default: uvboost applied to the embed thread', !!st && st.state === 'applied' && st.scope === 'embed' && st.tid > 0, JSON.stringify(st));
  const mine = st && seen.threads.get(st.tid);
  ok('that thread is TimeCritical, read from outside', !!mine && mine.level === 'TimeCritical', JSON.stringify(mine));
  const crit = [...seen.threads].filter(([, v]) => v.level === 'TimeCritical').map(([t]) => t);
  ok('it is the only TimeCritical thread', crit.length === 1, crit.join(','));
  ok('the window belongs to this process', seen.owner === (on.ready && on.ready.pid), seen.owner + ' vs ' + (on.ready && on.ready.pid));
  ok('it is not the window\'s UI thread', !!st && seen.ui > 0 && seen.ui !== st.tid, 'ui ' + seen.ui + ', raised ' + (st && st.tid));
  const ui = seen.threads.get(seen.ui);
  ok('the UI thread keeps AboveNormal and its boost', !!ui && ui.level === 'AboveNormal' && ui.boost === true, JSON.stringify(ui));
  const d = on.delta || new Map();
  const rank = [...d].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const dEmb = st ? d.get(st.tid) || 0 : 0;
  ok('it wakes for the main process\'s libuv packets (40 uv_async_sends)', dEmb >= 20, dEmb + ' context switches; UI thread ' + (d.get(seen.ui) || 0));
  ok('it is among the 3 threads that woke most', !!st && rank.slice(0, 3).includes(st.tid), 'top ' + rank.slice(0, 3).map((t) => t + ':' + d.get(t)).join(' '));

  const off = await run({ QUARTZ_UVBOOST: '0' }, false);
  const st0 = off.ready && off.ready.status, seen0 = off.seen || { threads: new Map() };
  ok('QUARTZ_UVBOOST=0: state off', !!st0 && st0.state === 'off', JSON.stringify(st0) + (off.error ? ' ' + off.error : ''));
  const crit0 = [...seen0.threads].filter(([, v]) => v.level === 'TimeCritical').length;
  ok('QUARTZ_UVBOOST=0: no thread raised, UI thread untouched', crit0 === 0 && (seen0.threads.get(seen0.ui) || {}).level === 'AboveNormal', crit0 + ' TimeCritical');

  console.log(`uvboost-e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
