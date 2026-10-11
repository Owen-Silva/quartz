<#
  memprobe.ps1 -- what one copy of Quartz costs in RAM, process by process.

  Written for the 2026-09-26 RAM round so every lane reports the same numbers.

    powershell -NoProfile -File memprobe.ps1                   # the LIVE browser (no --test-profile)
    powershell -NoProfile -File memprobe.ps1 -Match ram-main   # a test instance, by its --profile-name
    powershell -NoProfile -File memprobe.ps1 -Match ram-main -Json

  Columns:
    privMB  private bytes (commit charge) -- the number that is really ours; this is what
            the round is judged on.
    wsMB    working set, what Task Manager's details tab shows; includes shared pages, so
            the total over-counts.
  A copy is matched by command line: the live one runs from C:\Users\you\browser and
  has no --test-profile; a test one carries --profile-name=<Match>. Either may run as
  Quartz.exe (the named launch, built by tools/make-quartz-exe.js) or as electron.exe
  (`npx electron .`); both are read. Mantle is also electron.exe, and is never counted.
#>
param(
  [string]$Match = '',
  [switch]$Json
)

$procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Quartz.exe'"
$byId = @{}
Get-Process electron, Quartz -ErrorAction SilentlyContinue | ForEach-Object { $byId[[int]$_.Id] = $_ }

# Children do not repeat our own switches (Chromium copies only the ones it
# knows), so pick the MAIN process by command line and then take its children
# by parent pid. Every Chromium child (gpu, renderers, utilities) is a direct
# child of the main process.
$mains = @($procs | Where-Object {
  $cl = [string]$_.CommandLine
  if ($cl -match '--type=' -or $cl -match 'mantle' -or $cl -notmatch 'owens[\\/]+browser') { return $false }
  if ($Match) { return $cl -match ('--profile-name=' + [regex]::Escape($Match) + '(\s|"|$)') }
  return $cl -notmatch 'test-profile'
})
$mainIds = @{}
foreach ($m in $mains) { $mainIds[[int]$m.ProcessId] = $true }

$rows = foreach ($p in $procs) {
  if (-not ($mainIds[[int]$p.ProcessId] -or $mainIds[[int]$p.ParentProcessId])) { continue }
  $cl = [string]$p.CommandLine
  $g = $byId[[int]$p.ProcessId]
  if (-not $g) { continue }
  $type = if ($cl -match '--type=(\S+)') { $Matches[1] } else { 'main' }
  $sub = ''
  if ($cl -match '--utility-sub-type=(\S+)') { $sub = $Matches[1] -replace '\.mojom\.', ' ' }
  elseif ($cl -match '--renderer-client-id=(\d+)') { $sub = 'rcid ' + $Matches[1] }
  [pscustomobject]@{
    pid    = [int]$p.ProcessId
    type   = $type
    detail = $sub
    privMB = [math]::Round($g.PrivateMemorySize64 / 1MB, 1)
    wsMB   = [math]::Round($g.WorkingSet64 / 1MB, 1)
  }
}

if (-not $rows) {
  Write-Output ("memprobe: no Quartz processes matched (" + $(if ($Match) { "--profile-name=$Match" } else { 'live copy' }) + ")")
  exit 1
}

$total = [pscustomobject]@{
  processes = @($rows).Count
  privMB    = [math]::Round((($rows | Measure-Object privMB -Sum).Sum), 1)
  wsMB      = [math]::Round((($rows | Measure-Object wsMB -Sum).Sum), 1)
}

if ($Json) {
  [pscustomobject]@{ at = (Get-Date).ToString('s'); match = $Match; total = $total; processes = $rows } |
    ConvertTo-Json -Depth 4
} else {
  $rows | Sort-Object type, detail | Format-Table -AutoSize | Out-String -Width 160
  "TOTAL  processes={0}  private={1} MB  workingSet={2} MB" -f $total.processes, $total.privMB, $total.wsMB
}
