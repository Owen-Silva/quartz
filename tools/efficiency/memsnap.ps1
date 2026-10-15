<#
  memsnap.ps1 -- one snapshot of every process on the box for mem-bench.js, as JSON to -Out:
    [{ pid, ppid, name, created (ISO), cmd, priv, wsPriv, ws }, ...]   (bytes)
      priv    PrivateBytes = commit charge (Win32_Process.PrivatePageCount)
      wsPriv  WorkingSetPrivate (perf counter): Task Manager's "Memory" column
      ws      the whole working set, shared pages included
  Runner only; it reads every process but never touches one.
#>
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Continue'
$perf = @{}
try {
  foreach ($p in (Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess, WorkingSetPrivate)) {
    $perf[[int]$p.IDProcess] = [int64]$p.WorkingSetPrivate
  }
} catch { }
$rows = New-Object System.Collections.Generic.List[object]
foreach ($w in (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, CreationDate, PrivatePageCount, WorkingSetSize)) {
  $id = [int]$w.ProcessId
  if ($id -eq 0) { continue }
  $wsp = 0; if ($perf.ContainsKey($id)) { $wsp = $perf[$id] }
  $created = ''; if ($w.CreationDate) { $created = $w.CreationDate.ToUniversalTime().ToString('o') }
  $rows.Add([pscustomobject]@{ pid = $id; ppid = [int]$w.ParentProcessId; name = [string]$w.Name; created = $created;
      cmd = [string]$w.CommandLine; priv = [int64]$w.PrivatePageCount; wsPriv = $wsp; ws = [int64]$w.WorkingSetSize })
}
$json = ConvertTo-Json -InputObject $rows.ToArray() -Compress -Depth 3
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
