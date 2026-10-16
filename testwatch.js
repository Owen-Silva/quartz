// testwatch.js — shared by the test launchers (looksync-e2e.js, toprow-e2e.js, smoketest.js).
//
// The user works at this machine while tests run: a Quartz test window must never be on his screen,
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

module.exports = { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher };
