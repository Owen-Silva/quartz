# tools/efficiency/wake-threads.ps1 -- one reading of the cumulative context switches of every
# thread of the given processes, each process's CPU time, and the same two summed over each
# one's whole process TREE (the browser with all its children). Used by wake-bisect.js at the
# start, middle and end of a window; the difference over the window is the rate.
#   powershell -NoProfile -File wake-threads.ps1 -Pids 123,456
# Prints one JSON line:
#   {"t":ms,"p":{"123":{"cpu":s,"th":[[tid,ctx],...],"tree":{"n":procs,"cpu":s,"ctx":count,"pids":[...]}},...}}
param([Parameter(Mandatory = $true)][string]$Pids)
$ErrorActionPreference = 'Continue'
$roots = @()
foreach ($x in ($Pids -split ',')) { if ($x.Trim()) { $roots += [int]$x.Trim() } }
$t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

# The trees: every process whose parent chain reaches a root.
$kids = @{}
foreach ($p in (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)) {
  $pp = [int]$p.ParentProcessId
  if (-not $kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.Generic.List[int] }
  $kids[$pp].Add([int]$p.ProcessId)
}
$treeOf = @{}   # pid -> root
foreach ($r in $roots) {
  $stack = New-Object System.Collections.Generic.Stack[int]
  $stack.Push($r)
  while ($stack.Count -gt 0) {
    $c = $stack.Pop()
    if ($treeOf.ContainsKey($c)) { continue }
    $treeOf[$c] = $r
    if ($kids.ContainsKey($c)) { foreach ($k in $kids[$c]) { $stack.Push($k) } }
  }
}

$th = @{}; $treeCtx = @{}; $treeCpu = @{}; $treeN = @{}; $treePids = @{}
foreach ($r in $roots) { $treeCtx[$r] = [int64]0; $treeCpu[$r] = [int64]0; $treeN[$r] = 0; $treePids[$r] = New-Object System.Collections.Generic.List[string] }
foreach ($row in (Get-CimInstance Win32_PerfRawData_PerfProc_Thread -Property IDProcess, IDThread, ContextSwitchesPersec)) {
  $k = [int]$row.IDProcess
  if (-not $treeOf.ContainsKey($k)) { continue }
  $treeCtx[$treeOf[$k]] += [int64]$row.ContextSwitchesPersec
  if ($roots -contains $k) {
    if (-not $th.ContainsKey($k)) { $th[$k] = New-Object System.Collections.Generic.List[string] }
    $th[$k].Add('[' + [int]$row.IDThread + ',' + [int64]$row.ContextSwitchesPersec + ']')
  }
}
foreach ($pr in (Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess, PercentProcessorTime)) {
  $k = [int]$pr.IDProcess
  if ($k -eq 0 -or -not $treeOf.ContainsKey($k)) { continue }
  $r = $treeOf[$k]
  $treeCpu[$r] += [int64]$pr.PercentProcessorTime
  $treeN[$r] += 1
  $treePids[$r].Add('[' + $k + ',' + [int64]$pr.PercentProcessorTime + ']')
}

$parts = New-Object System.Collections.Generic.List[string]
foreach ($k in $roots) {
  $cpu = -1
  try { $cpu = (Get-Process -Id $k -ErrorAction Stop).TotalProcessorTime.TotalSeconds } catch { }
  $list = ''
  if ($th.ContainsKey($k)) { $list = ($th[$k] -join ',') }
  $tcpu = ([string]([double]$treeCpu[$k] / 1e7)).Replace(',', '.')
  $parts.Add('"' + $k + '":{"cpu":' + ([string]$cpu).Replace(',', '.') + ',"th":[' + $list + '],"tree":{"n":' + $treeN[$k] + ',"cpu":' + $tcpu + ',"ctx":' + $treeCtx[$k] + ',"pids":[' + ($treePids[$k] -join ',') + ']}}')
}
'{"t":' + $t + ',"p":{' + ($parts -join ',') + '}}'
