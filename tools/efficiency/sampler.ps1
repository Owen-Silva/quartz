<#
  sampler.ps1 -- one JSON line per sample of every process on the box, for idle-bench.js.

    powershell -NoProfile -File tools/efficiency/sampler.ps1 -Out samples.jsonl -EverySec 30 -StopFile stop.flag

  Each line: { t: <unix ms>, p: [[pid, parentPid, name, cpu100ns, wsPrivateBytes, privateBytes, threads, ctxSwitches], ...] }
    cpu100ns     PercentProcessorTime raw: user+kernel CPU used since the process started, 100 ns units
    wsPrivate    WorkingSetPrivate: Task Manager's "Memory (active private working set)"
    privateBytes commit charge
    ctxSwitches  the sum of every live thread's ContextSwitchesPersec RAW value, which is a running
                 count of context switches (each one is the thread being woken, or preempted)
  The process data comes from Win32_PerfRawData_PerfProc_Process (one query), the switches from
  Win32_PerfRawData_PerfProc_Thread (one query, summed per IDProcess). Stops when -StopFile exists.
  Written for the runner only: it reads every process but never touches one.
#>
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$EverySec = 30,
  [Parameter(Mandatory = $true)][string]$StopFile
)
$ErrorActionPreference = 'Continue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
while (-not (Test-Path $StopFile)) {
  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $ctx = @{}
  try {
    foreach ($th in (Get-CimInstance Win32_PerfRawData_PerfProc_Thread -Property IDProcess, ContextSwitchesPersec)) {
      $k = [int]$th.IDProcess
      if ($ctx.ContainsKey($k)) { $ctx[$k] += [int64]$th.ContextSwitchesPersec } else { $ctx[$k] = [int64]$th.ContextSwitchesPersec }
    }
  } catch { }
  $rows = New-Object System.Collections.Generic.List[string]
  foreach ($p in (Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess, CreatingProcessID, Name, PercentProcessorTime, WorkingSetPrivate, PrivateBytes, ThreadCount)) {
    $id = [int]$p.IDProcess
    if ($id -eq 0 -or $p.Name -eq '_Total') { continue }
    $c = 0; if ($ctx.ContainsKey($id)) { $c = $ctx[$id] }
    $nm = ([string]$p.Name) -replace '#\d+$', '' -replace '[\\"]', ''
    $rows.Add('[' + $id + ',' + [int]$p.CreatingProcessID + ',"' + $nm + '",' + [int64]$p.PercentProcessorTime + ',' + [int64]$p.WorkingSetPrivate + ',' + [int64]$p.PrivateBytes + ',' + [int]$p.ThreadCount + ',' + $c + ']')
  }
  $line = '{"t":' + $t0 + ',"p":[' + ($rows -join ',') + ']}' + "`n"
  [System.IO.File]::AppendAllText($Out, $line, $utf8)
  $spent = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0
  $wait = $EverySec * 1000 - $spent
  # Wake every second so the stop flag is seen promptly.
  while ($wait -gt 0 -and -not (Test-Path $StopFile)) { Start-Sleep -Milliseconds ([Math]::Min(1000, $wait)); $wait -= 1000 }
}
