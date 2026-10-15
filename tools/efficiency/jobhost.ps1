<#
  jobhost.ps1 -- start each browser inside its own Windows job object, so its CPU is counted
  EXACTLY: a job's accounting includes every process that ever ran in it, the short-lived ones
  too (a tasklist.exe that lives 200 ms between two samples is invisible to sampler.ps1, but not
  to its job). Runner only; idle-bench.js drives it over stdin, one command per line:

    launch <id> <exe> <cmdline> <cwd>    (tab-separated) -> "launched <id> <pid> <assigned:0|1> <error>"
    acct                                 -> "acct {"<id>":[user100ns,kernel100ns,totalProcesses,activeProcesses],...}"
    threads <pid,pid,...>                -> "threads {...}"  per-thread context switches + start module
    kill <id>                            -> TerminateJobObject: every process in that job, nothing else
    quit
  The process is created SUSPENDED, put in the job, then resumed, so not one child escapes it.
#>
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class QJob {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  public struct ACCT { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr j, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr j, int cls, out ACCT info, int len, IntPtr ret);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  public static IntPtr NewJob() { return CreateJobObjectW(IntPtr.Zero, null); }
  public static string Launch(IntPtr job, string exe, string cmdline, string cwd) {
    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(exe, new StringBuilder(cmdline, 32000), IntPtr.Zero, IntPtr.Zero, false, 0x4, IntPtr.Zero, cwd, ref si, out pi))
      return "0 0 CreateProcess=" + Marshal.GetLastWin32Error();
    bool ok = AssignProcessToJobObject(job, pi.hProcess);
    string err = ok ? "-" : ("Assign=" + Marshal.GetLastWin32Error());
    ResumeThread(pi.hThread); CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return pi.dwProcessId + " " + (ok ? 1 : 0) + " " + err;
  }
  public static string Acct(IntPtr job) {
    ACCT a; if (!QueryInformationJobObject(job, 1, out a, Marshal.SizeOf(typeof(ACCT)), IntPtr.Zero)) return "null";
    return "[" + a.TotalUserTime + "," + a.TotalKernelTime + "," + a.TotalProcesses + "," + a.ActiveProcesses + "]";
  }
  public static bool Kill(IntPtr job) { return TerminateJobObject(job, 1); }
}
"@
$jobs = @{}
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'quit') { break }
  try {
    if ($line.StartsWith('launch')) {
      $f = $line.Split("`t")
      $id = $f[1]
      $job = [QJob]::NewJob()
      $jobs[$id] = $job
      [Console]::Out.WriteLine('launched ' + $id + ' ' + [QJob]::Launch($job, $f[2], $f[3], $f[4]))
    } elseif ($line -eq 'acct') {
      $parts = foreach ($k in $jobs.Keys) { '"' + $k + '":' + [QJob]::Acct($jobs[$k]) }
      [Console]::Out.WriteLine('acct {' + ($parts -join ',') + '}')
    } elseif ($line.StartsWith('threads ')) {
      $want = @{}; foreach ($p in $line.Substring(8).Split(',')) { if ($p) { $want[[int]$p] = $true } }
      $out = @{}
      foreach ($t in (Get-CimInstance Win32_PerfRawData_PerfProc_Thread -Property IDProcess, IDThread, ContextSwitchesPersec, PercentProcessorTime, StartAddress, ThreadWaitReason)) {
        $id = [int]$t.IDProcess
        if (-not $want.ContainsKey($id)) { continue }
        if (-not $out.ContainsKey($id)) { $out[$id] = New-Object System.Collections.Generic.List[object] }
        $out[$id].Add(@([int]$t.IDThread, [int64]$t.ContextSwitchesPersec, [int64]$t.PercentProcessorTime, [string]('{0:x}' -f [uint64]$t.StartAddress), [int]$t.ThreadWaitReason))
      }
      $mods = @{}
      foreach ($id in $want.Keys) {
        try { $mods[[string]$id] = @((Get-Process -Id $id).Modules | ForEach-Object { ,@($_.ModuleName, ('{0:x}' -f $_.BaseAddress.ToInt64()), $_.ModuleMemorySize) }) } catch { $mods[[string]$id] = @() }
      }
      $o = @{ threads = @{}; modules = $mods }
      foreach ($k in $out.Keys) { $o.threads[[string]$k] = $out[$k] }
      [Console]::Out.WriteLine('threads ' + ($o | ConvertTo-Json -Compress -Depth 5))
    } elseif ($line.StartsWith('kill ')) {
      $id = $line.Substring(5)
      if ($jobs.ContainsKey($id)) { [Console]::Out.WriteLine('killed ' + $id + ' ' + [QJob]::Kill($jobs[$id])) } else { [Console]::Out.WriteLine('killed ' + $id + ' nojob') }
    } else { [Console]::Out.WriteLine('error unknown command') }
  } catch { [Console]::Out.WriteLine('error ' + ($_.Exception.Message -replace "`r?`n", ' ')) }
}
