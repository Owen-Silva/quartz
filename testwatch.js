// testwatch.js — shared by the test launchers (looksync-e2e.js, toprow-e2e.js, smoketest.js).
//
// The user works at this machine while tests run: a Quartz test window must never be on their screen,
// not even for one frame. Two halves:
//   OFFSCREEN_ARGS  the launch flags. main.js creates a --test-profile --offscreen window at
//                   -20000,-20000 with no taskbar button; --show-inactive never takes focus;
//                   --measure-visible keeps the hidden window rendering (no occlusion throttle).
//   startWatcher()  a PowerShell poller, started BEFORE electron, that looks at every visible
//                   top-level window of the test's main process every 25 ms and reports any
//                   rectangle that touches the virtual desktop. watch(pid) hands it the pid.
//                   verdict() is the check line: it FAILS if the window was ever on screen, and
//                   also if the watcher never saw the window at all (then it proved nothing).
// freeRamGb() is the RAM rule's input (launch only with >= 2.5 GB free).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const OFFSCREEN_ARGS = ['--offscreen', '--show-inactive', '--measure-visible'];
// 2.5 GB unless the run says otherwise (QUARTZ_TEST_MIN_FREE_GB, e.g. a day the user allows less).
const MIN_FREE_GB = (process.env.QUARTZ_TEST_MIN_FREE_GB || "") !== "" && Number(process.env.QUARTZ_TEST_MIN_FREE_GB) >= 0 ? Number(process.env.QUARTZ_TEST_MIN_FREE_GB) : 2.5;

const WATCH_PS = String.raw`param([string]$PidFile)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[W]::SetProcessDPIAware() | Out-Null
$vx = [W]::GetSystemMetrics(76); $vy = [W]::GetSystemMetrics(77); $vw = [W]::GetSystemMetrics(78); $vh = [W]::GetSystemMetrics(79)
"READY desktop $vx,$vy $($vw)x$vh"
$target = 0; $seen = 0
# Output inside an EnumWindows callback is swallowed (it becomes the delegate's return value),
# so the callback only collects; the lines are printed from the loop.
$out = New-Object System.Collections.Generic.List[string]
while ($true) {
  if ($target -eq 0 -and (Test-Path $PidFile)) { $target = [int](Get-Content $PidFile) }
  if ($target -ne 0) {
    $cb = [W+EnumProc]{ param($h, $p)
      $wp = 0; [W]::GetWindowThreadProcessId($h, [ref]$wp) | Out-Null
      if ($wp -eq $target -and [W]::IsWindowVisible($h)) {
        $r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null
        $script:seen++
        if ($script:seen -eq 1) { $out.Add("FIRST $h $($r.L),$($r.T),$($r.R),$($r.B)") }
        if ($r.R -gt $vx -and $r.L -lt ($vx + $vw) -and $r.B -gt $vy -and $r.T -lt ($vy + $vh) -and ($r.R - $r.L) -gt 0 -and ($r.B - $r.T) -gt 0) {
          $out.Add("ONSCREEN $h $($r.L),$($r.T),$($r.R),$($r.B)") } }
      return $true }
    [W]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
    foreach ($l in $out) { $l }
    $out.Clear()
  }
  Start-Sleep -Milliseconds 25
}`;

function freeRamGb() {
  const kb = Number(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], { encoding: 'utf8' }).trim());
  return kb / 1048576;
}

/**
 * Start the watcher; resolves once it is polling (after its Add-Type), so it is
 * looking before electron exists. log(line) receives its human-readable lines.
 */
function startWatcher(log) {
  const say = log || ((l) => console.log('     ' + l));
  const tag = 'testwatch-' + process.pid + '-' + Date.now();
  const ps1 = path.join(os.tmpdir(), tag + '.ps1');
  const pidFile = path.join(os.tmpdir(), tag + '.pid');
  fs.writeFileSync(ps1, WATCH_PS);
  const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-PidFile', pidFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const w = {
    first: null,
    onScreen: [],
    watch(pid) { fs.writeFileSync(pidFile, String(pid)); },
    stop() {
      try { proc.kill(); } catch (e) { /* gone */ }
      for (const f of [ps1, pidFile]) { try { fs.unlinkSync(f); } catch (e) { /* gone */ } }
    },
    /** { ok, line } for the run's check list. */
    verdict() {
      if (!w.first) return { ok: false, line: 'invisible: the watcher never saw the test window, so it proves nothing' };
      if (w.onScreen.length) return { ok: false, line: 'invisible: a test window touched the visible desktop ' + w.onScreen.length + ' time(s): ' + w.onScreen.slice(0, 3).join('; ') };
      return { ok: true, line: 'invisible: no test window on the visible desktop at any 25 ms poll (watcher ran from before launch; first seen ' + w.first.split(' ').slice(2).join(' ') + ')' };
    },
  };
  w.ready = new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('the window watcher did not start within 30 s')), 30000);
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (/^READY/.test(line)) { clearTimeout(t); say('watcher ' + line); resolve(w); }
        else if (/^ONSCREEN/.test(line)) { w.onScreen.push(line); say(line); }
        else if (/^FIRST/.test(line)) { w.first = line; say('watcher saw the test window: ' + line); }
      }
    });
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error('the window watcher exited (' + c + ')')); });
  });
  return w;
}

/*
 * "The chrome is up" means init() has run and the boot strip is built, not that app.js has loaded.
 *
 * app.js is one <script> of many in index.html. createTab, openWatchTab and the rest exist the moment
 * it is evaluated, but the DOM refs they need (the tab strip, the views well) are bound in init(),
 * which runs on DOMContentLoaded, after every later script (settings.js and ~30 others) has loaded;
 * the first tab comes one IPC turn after that (the session read). A CDP Runtime.evaluate runs between
 * those script tasks, so a test that only waits for `typeof createTab === "function"` (plus whatever
 * main answers early, such as Drm's state) can act in that gap: createTab() returns null ("Cannot
 * read properties of null (reading 'id')") and openWatchTab() quietly opens nothing. How wide the gap
 * is depends on the machine and on how soon the test attaches, so the same commit passed one night
 * and failed the next. CHROME_BOOTED is what e2e-kit.js has always waited for.
 */
const CHROME_SCRIPTS = 'typeof createTab === "function"';
const CHROME_BOOTED = '(typeof createTab === "function" && typeof viewsEl !== "undefined" && !!viewsEl'
  + ' && typeof tabs !== "undefined" && Array.isArray(tabs) && tabs.length > 0 && !restoring)';

/**
 * Wait until the chrome has booted. ev(expr) evaluates in the chrome window (resolves to the value,
 * rejects on an exception: a page still loading is retried, never fatal). extra is the test's own
 * readiness expression (e.g. Drm's state is in), ANDed into both phases. Resolves to
 * { scriptsMs, bootedMs }: ms after the call that the scripts alone first answered (null when the
 * first answer was already the booted one) and that the boot was done; say(line) gets that as one
 * line, the evidence of how wide the gap was on this run. Rejects after ms with both phases named.
 * opts.now / opts.sleep are the harness's seams (testwatch-harness.js).
 */
async function waitChromeBooted(ev, extra, ms, say, opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const pause = o.sleep || ((n) => new Promise((r) => setTimeout(r, n)));
  const poll = o.poll || 50;
  const limit = ms || 30000;
  const and = extra ? ' && (' + extra + ')' : '';
  const expr = '(() => { try { return { s: !!(' + CHROME_SCRIPTS + and + '), b: !!(' + CHROME_BOOTED + and + ') }; }'
    + ' catch (e) { return { s: false, b: false, e: String(e && e.message || e) }; } })()';
  const t0 = now();
  let scriptsMs = null, last = null;
  while (now() - t0 < limit) {
    let r = null;
    try { r = await ev(expr); } catch (e) { last = String(e && e.message || e); }
    if (r && typeof r === 'object') {
      last = r.e || null;
      const t = now() - t0;
      if (r.b) {
        const res = { scriptsMs: scriptsMs, bootedMs: t };
        if (say) say(scriptsMs === null
          ? 'chrome booted ' + t + ' ms into the wait (its scripts and the boot answered together)'
          : 'chrome booted ' + t + ' ms into the wait; its scripts alone answered at ' + scriptsMs
            + ' ms (a test acting in those ' + (t - scriptsMs) + ' ms gets a null tab)');
        return res;
      }
      if (r.s && scriptsMs === null) scriptsMs = t;
    }
    await pause(poll);
  }
  throw new Error('the chrome never booted in ' + limit + ' ms (scripts '
    + (scriptsMs === null ? 'never answered' : 'answered at ' + scriptsMs + ' ms, init()/the boot strip never followed')
    + (last ? '; last: ' + String(last).slice(0, 160) : '') + ')');
}

module.exports = { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher, CHROME_BOOTED, waitChromeBooted };
