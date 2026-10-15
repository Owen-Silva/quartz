// uvboost.js -- keep Chromium's browser main thread from preempting Electron's libuv poll
// ("embed") thread, which is what locks the two into waking each other thousands of times a
// second (the focused-Home wakeup storm). By default: the embed thread's priority -> TimeCritical.
//
// Why (next-week/quartz-efficiency.md, "round 3", 2026-10-15; Electron 44.3 shell/common/
// node_bindings.cc + node_bindings_win.cc). Electron runs Node's loop with two threads sharing
// libuv's I/O completion port, which libuv creates with a CONCURRENCY OF 1:
//   - the embed thread: uv_sem_wait, then GetQueuedCompletionStatus(timeout); a real packet is put
//     straight back on the port; then it posts UvRunOnce to the main thread and loops;
//   - the main thread's UvRunOnce: uv_run(NOWAIT), whose poll takes packets with a zero timeout,
//     then uv_sem_post.
// A concurrency-1 port gives no packet to a caller while another thread associated with it is
// RUNNING (ready counts too), and both threads are associated. Chromium runs CrBrowserMain at
// AboveNormal (base 9); the embed thread is Normal (8). So when the embed thread's post wakes the
// main thread on the same CPU, the main thread preempts it BEFORE it reaches its semaphore wait,
// its zero-timeout poll comes back empty (the embed thread still counts as running), it posts the
// semaphore, and the moment it goes idle the embed thread finds the semaphore already posted and
// the packet still on the port, takes it, puts it back, posts again -- and the main thread
// preempts it again. Measured (rounds 9-11): two threads at the same rate, uv_run iterating
// 300-4,000 times a second with ~0 packets taken, every other process quiet, no JS. Electron knows
// the single-CPU form of it ("cpu pegging likely caused by a busy loop in PollEvents": it makes the
// port concurrency 2 on one-CPU machines); pinning plain Electron to one CPU reproduces it at
// ~6,000 wakeups/s. On more CPUs it happens in episodes, whenever the scheduler puts the woken main
// thread on the embed thread's CPU (often on a loaded machine). Any packet can start one: Node I/O
// (the stats sampler's typeperf pipe, the now-playing HTTP poll), uv_async_send, libuv's own
// handle-start interrupts. That is why focus "causes" it: focus starts those Home pollers.
// Turning the main thread's priority boost off only halved it (round 11): its BASE is already above.
//
// How: one hidden PowerShell, a few seconds after start, finds the embed thread and sets its
// priority to TimeCritical, so nothing in the process can preempt it between its post and its
// semaphore wait. It is identified as the one UNNAMED thread that starts at the same address as the
// threads Node and libuv create and name (V8Worker, DelayedTaskSchedulerWorker, libuv-worker):
// libuv's uv_thread_create trampoline. Exactly one, or nothing changes (state 'failed', logged).
// It runs for microseconds per wakeup, so the priority costs nothing measurable. Chromium's own
// threads, the main thread and every other process keep their priorities.
//
//   QUARTZ_UVBOOST=0 | off      do nothing (bench A/B)
//   QUARTZ_UVBOOST=main|boost|level|process   the main-thread / whole-process variants (bench A/B)
'use strict';

const DEFAULT_DELAY_MS = 3000;

/**
 * The env value as a scope:
 *   'embed'   (default) Electron's libuv embed thread: priority TimeCritical
 *   'main'    the main thread: boost off AND priority Normal (bench)
 *   'boost'   the main thread: boost off only (bench)
 *   'level'   the main thread: priority Normal only (bench)
 *   'process' the whole process: boost off (bench)
 *   'off'     nothing
 */
function scopeFrom(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === '0' || s === 'off' || s === 'false' || s === 'no') return 'off';
  if (s === 'process' || s === 'proc') return 'process';
  if (s === 'boost' || s === 'level' || s === 'main') return s;
  return 'embed';
}

/** Thread name (GetThreadDescription) and start address (NtQueryInformationThread class 9). No single quotes: it is spliced into a PowerShell '...' string. */
const EMBED_CS = 'using System; using System.Runtime.InteropServices; public static class QuartzUvThreads { ' +
  '[DllImport("kernel32.dll")] static extern IntPtr OpenThread(uint a, bool i, uint id); ' +
  '[DllImport("kernel32.dll")] static extern int GetThreadDescription(IntPtr h, out IntPtr d); ' +
  '[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h); ' +
  '[DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p); ' +
  '[DllImport("ntdll.dll")] static extern int NtQueryInformationThread(IntPtr h, int c, out IntPtr i, int l, IntPtr r); ' +
  'public static string Info(uint tid) { IntPtr h = OpenThread(0x1040, false, tid); if (h == IntPtr.Zero) return null; ' +
  'string n = ""; IntPtr d; if (GetThreadDescription(h, out d) >= 0) { n = Marshal.PtrToStringUni(d); LocalFree(d); } ' +
  'IntPtr s; long a = 0; if (NtQueryInformationThread(h, 9, out s, IntPtr.Size, IntPtr.Zero) == 0) a = s.ToInt64(); ' +
  'CloseHandle(h); return a.ToString("X") + "|" + n; } }';

/** The PowerShell that applies it to process `pid`; prints one line starting "uvboost ok". */
function script(pid, scope) {
  const id = Math.floor(Number(pid));
  if (!(id > 0)) throw new Error('uvboost: bad pid ' + pid);
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '$p = Get-Process -Id ' + id,
  ];
  if (scope === 'process') {
    lines.push('$was = $p.PriorityBoostEnabled', '$p.PriorityBoostEnabled = $false',
      "'uvboost ok scope=process pid=' + $p.Id + ' was=' + $was");
  } else if (scope === 'embed') {
    // The embed thread is libuv's (uv_thread_create): it starts at the same address as the
    // threads Node and libuv name (V8Worker, DelayedTaskSchedulerWorker, libuv-worker), and it is
    // the only one of those without a name. Exactly one, or nothing is changed.
    lines.push("Add-Type -TypeDefinition '" + EMBED_CS + "'",
      '$rows = foreach ($t in $p.Threads) { $i = [QuartzUvThreads]::Info([uint32]$t.Id); if ($i) { $x = $i.Split([char]124, 2); [pscustomobject]@{ t = $t; a = $x[0]; n = $x[1] } } }',
      "$uv = @($rows | Where-Object { $_.n -eq 'libuv-worker' -or $_.n -eq 'V8Worker' -or $_.n -eq 'DelayedTaskSchedulerWorker' } | ForEach-Object { $_.a } | Select-Object -Unique)",
      "if ($uv.Count -ne 1) { throw ('libuv thread start: ' + $uv.Count + ' addresses') }",
      "$e = @($rows | Where-Object { $_.a -eq $uv[0] -and $_.n -eq '' })",
      "if ($e.Count -ne 1) { throw ('unnamed libuv threads: ' + $e.Count) }",
      "$t = $e[0].t; $was = [string]$t.PriorityLevel; $t.PriorityLevel = 'TimeCritical'",
      "'uvboost ok scope=embed tid=' + $t.Id + ' was=' + $was");
  } else {
    const sc = scope === 'boost' || scope === 'level' ? scope : 'main';
    // A thread can exit while it is listed: its StartTime then throws, so it sorts last.
    lines.push('$t = $p.Threads | Sort-Object { try { $_.StartTime } catch { [datetime]::MaxValue } } | Select-Object -First 1',
      "$was = [string]$t.PriorityBoostEnabled + '/' + [string]$t.PriorityLevel");
    if (sc !== 'level') lines.push('$t.PriorityBoostEnabled = $false');
    if (sc !== 'boost') lines.push("$t.PriorityLevel = 'Normal'");
    lines.push("'uvboost ok scope=" + sc + " tid=' + $t.Id + ' was=' + $was");
  }
  return lines.join('; ');
}

/** Parse the script's output into { ok, scope, tid, was } (ok false when the line is missing). */
function parse(out) {
  const m = /uvboost ok scope=(main|boost|level|process|embed) (?:tid|pid)=(\d+) was=(\S+)/.exec(String(out || ''));
  if (!m) return { ok: false };
  return { ok: true, scope: m[1], tid: m[1] === 'process' ? null : Number(m[2]), was: m[3] };
}

let current = null;

/**
 * Arm it once per process. Windows + Electron main process only; anything else returns
 * { state: 'skipped', reason }. Returns the live status object:
 *   { state: 'pending' | 'applied' | 'failed' | 'off' | 'skipped', scope, tid, reason, ms }
 *   opts.proc      process object (harness)
 *   opts.env       env object (harness; default proc.env)
 *   opts.execFile  child_process.execFile stand-in (harness)
 *   opts.delayMs   wait before applying (default 3 s: off the boot path)
 *   opts.log       (line) => void; default console.log
 */
function install(opts) {
  const o = opts || {};
  const proc = o.proc || process;
  if (current && !o.proc) return current;
  const env = o.env || proc.env || {};
  const log = typeof o.log === 'function' ? o.log : (line) => { try { console.log(line); } catch { /* no console */ } };
  const status = { state: 'pending', scope: scopeFrom(env.QUARTZ_UVBOOST), tid: null, reason: '', ms: null };
  if (!o.proc) current = status;
  if (proc.platform !== 'win32') { status.state = 'skipped'; status.reason = 'not Windows'; return status; }
  if (proc.type !== 'browser') { status.state = 'skipped'; status.reason = 'not the Electron main process'; return status; }
  if (status.scope === 'off') { status.state = 'off'; status.reason = 'QUARTZ_UVBOOST=' + env.QUARTZ_UVBOOST; return status; }
  const execFile = o.execFile || require('child_process').execFile;
  const delayMs = Number.isFinite(o.delayMs) ? Math.max(0, o.delayMs) : DEFAULT_DELAY_MS;
  const apply = () => {
    const t0 = Date.now();
    let cmd;
    try { cmd = script(proc.pid, status.scope); } catch (e) { status.state = 'failed'; status.reason = e.message; log('[uvboost] ' + e.message); return; }
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
        { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
          status.ms = Date.now() - t0;
          const r = parse(stdout);
          if (r.ok) {
            status.state = 'applied'; status.tid = r.tid; status.reason = 'was ' + r.was;
            const what = r.scope === 'process' ? 'priority boost off (process' : r.scope === 'boost' ? 'priority boost off (main thread ' + r.tid
              : r.scope === 'level' ? 'priority Normal (main thread ' + r.tid : r.scope === 'embed' ? 'priority TimeCritical (libuv embed thread ' + r.tid : 'priority Normal, boost off (main thread ' + r.tid;
            log('[uvboost] ' + what + ', was ' + r.was + ') in ' + status.ms + ' ms');
          } else {
            status.state = 'failed';
            status.reason = String((err && err.message) || stderr || stdout || 'no output').trim().split(/\r?\n/)[0].slice(0, 200);
            log('[uvboost] could not turn the priority boost off: ' + status.reason);
          }
        });
    } catch (e) {
      status.state = 'failed'; status.reason = String(e && e.message || e).slice(0, 200);
      log('[uvboost] could not start PowerShell: ' + status.reason);
    }
  };
  if (delayMs === 0) apply();
  else { const t = setTimeout(apply, delayMs); if (t && typeof t.unref === 'function') t.unref(); }
  return status;
}

/** The status of this process's install() (null before it ran). */
function status() { return current; }

module.exports = { install, status, script, parse, scopeFrom, DEFAULT_DELAY_MS };
