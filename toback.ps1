# toback.ps1 - push a TEST INSTANCE's windows to the bottom of the z-order without
# activating them, so a live check never steals focus from whoever is at the machine.
#
#   powershell -File toback.ps1 -Match <profile-name> [-WaitSec 40] [-Restore <hwnd>]
#
# -Match   is the --profile-name you launched the test instance with; it is matched as
#          the whole '--profile-name=<x>' flag, never as a bare substring; every visible window of those pids is sent
#          to HWND_BOTTOM with SWP_NOACTIVATE the moment it appears (polls for -WaitSec).
# -Restore is the hwnd that should be in the foreground afterwards (read
#          GetForegroundWindow before launching); it is put back via AttachThreadInput.
# Never point -Match at the live browser (its command line has no --profile-name).
# Launch the instance from Bash run_in_background with a long timeout, then run this.

param([string]$Match = 'dockfallback', [int]$WaitSec = 40, [long]$Restore = 0)

$sig = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WB {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(int a, int b, bool attach);
  [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
  public static List<IntPtr> ForPids(HashSet<int> pids) {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int p; GetWindowThreadProcessId(h, out p);
      if (pids.Contains(p)) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
try { Add-Type -TypeDefinition $sig -ErrorAction Stop } catch { }

function Get-TreePids([string]$m) {
  # Quartz.exe is the named launch (tools/make-quartz-exe.js); electron.exe is `npx electron .`.
  $all = Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Quartz.exe'"
  # Match the --profile-name flag itself, never a bare substring: '-Match ws'
  # matched 'browser' in the live browser's path and sent IT to the back once.
  $needle = if ($m.Contains('=')) { $m } else { '--profile-name=' + $m }
  $mine = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) })
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($p in $mine) { [void]$ids.Add([int]$p.ProcessId) }
  # The comma keeps the HashSet whole: a bare return unrolls it into an object[]
  # and [WB]::ForPids never matches its signature (seen live 2026-09-12).
  return ,$ids
}

$deadline = (Get-Date).AddSeconds($WaitSec)
$sent = @{}
$did = $false
while ((Get-Date) -lt $deadline) {
  $pids = Get-TreePids $Match
  if ($pids.Count -gt 0) {
    $wins = [WB]::ForPids($pids)
    foreach ($h in $wins) {
      if ($sent.ContainsKey([int64]$h)) { continue }
      $sb = New-Object System.Text.StringBuilder 256
      [void][WB]::GetWindowTextW($h, $sb, 256)
      # Titleless and IME helper windows are not the instance's real windows.
      if ($sb.Length -eq 0 -or $sb.ToString() -in @('MSCTFIME UI', 'Default IME')) { continue }
      # HWND_BOTTOM = 1, SWP_NOMOVE 0x2 | SWP_NOSIZE 0x1 | SWP_NOACTIVATE 0x10
      [void][WB]::SetWindowPos($h, [IntPtr]1, 0, 0, 0, 0, 0x13)
      $sent[[int64]$h] = $true
      $did = $true
      "sent to back: hwnd=$([int64]$h) title=$($sb.ToString())"
    }
  }
  if ($did) { break }
  Start-Sleep -Milliseconds 300
}

if ($Restore -ne 0) {
  $target = [IntPtr]$Restore
  $cur = [WB]::GetForegroundWindow()
  if ($cur -ne $target) {
    $tid = [WB]::GetWindowThreadProcessId($cur, [ref]([int]0))
    $curPid = 0
    $curTid = [WB]::GetWindowThreadProcessId($cur, [ref]$curPid)
    $me = [WB]::GetCurrentThreadId()
    [void][WB]::AttachThreadInput($me, $curTid, $true)
    [void][WB]::SetForegroundWindow($target)
    [void][WB]::AttachThreadInput($me, $curTid, $false)
  }
  $now = [WB]::GetForegroundWindow()
  "foreground now: $([int64]$now) (wanted $Restore)"
}
if (-not $did) { "no window found for '$Match'" }
