<#
tools/lumen-golive.ps1 -- Lumen (wk/lumen) live in Quartz, on castlabs Electron (Widevine).

    powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\you\browser\tools\lumen-golive.ps1
    ... -Repo C:\Users\you\quartz-wt\lumen-integrate -DryRun     (every step but the close and the swap)

  0. Preflight, with Quartz still open: git fetch; the checkout is clean; HEAD -> origin/wk/lumen is a
     fast-forward; origin/master is the same SHA (main pushes it first); drm-swap.ps1's tools are there.
  1. Snapshot the default-browser registry (QuartzURL, QuartzHTML, StartMenuInternet\Quartz,
     RegisteredApplications, UserChoice) and node-pty's native files. Never writes the registry.
  2. Close Quartz cleanly: CloseMainWindow on the MAIN Quartz.exe of this checkout (no --type=, no
     --test-profile), then wait for every Quartz.exe/electron.exe of this checkout to exit. Never kills
     anything, never by image name; Helm's and other apps' electron.exe are not looked at.
  3. git merge --ff-only origin/wk/lumen.
  4. tools\drm-swap.ps1 -Repo <repo> -NoMerge (master already holds the drm2 merge, so the swap's own
     merge step is skipped): npm install --ignore-scripts, electron install.js, npm run quartz-exe,
     py -3 -m castlabs_evs.vmp -n sign-pkg -H Quartz + verify-pkg, Quartz.exe.sig checked.
  5. node-pty's Electron build: the same bytes as before the swap.
  6. Relaunch through explorer.exe on the Start Menu Quartz.lnk (keeps the AUMID).
  7. The registry compared with step 1's snapshot: it must be untouched.
  8. The rollback command.
  Every check prints a PASS / FAIL line; the last line is the verdict. Secrets are never printed.
#>
param(
  [string]$Repo = 'C:\Users\you\browser',
  [string]$Ref = 'origin/wk/lumen',
  [string]$Lnk = 'C:\Users\you\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Quartz.lnk',
  [int]$CloseTimeoutSec = 90,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path $Repo).Path
$Dist = Join-Path $Repo 'node_modules\electron\dist'
$PtyDir = Join-Path $Repo 'node_modules\@homebridge\node-pty-prebuilt-multiarch\build\Release'
$StateDir = Join-Path $env:LOCALAPPDATA 'Quartz-drm\lumen-golive'
$Swap = Join-Path $Repo 'tools\drm-swap.ps1'
$Rollback = Join-Path $Repo 'tools\drm-rollback.ps1'
$script:fails = 0
$script:oldHead = ''

function Say([string]$t) { Write-Output ('lumen-golive: ' + $t) }
function Clean([string]$t) { if (-not $t) { return '' }; return ($t -replace '[A-Za-z0-9_\-\.=/+]{32,}', '<redacted>') }
function Tail([string]$t, [int]$n) { if (-not $t) { return '' }; $l = @($t -split "`r?`n" | Where-Object { $_.Trim() }); return (Clean (($l | Select-Object -Last $n) -join ' | ')) }
function Pass([string]$what) { Write-Output ('PASS ' + $what) }
function Fail([string]$what) { Write-Output ('FAIL ' + $what); $script:fails++ }
function Info([string]$what) { Write-Output ('INFO ' + $what) }

function Rollback-Text {
  $old = $(if ($script:oldHead) { $script:oldHead } else { '<HEAD before go-live>' })
  Write-Output 'lumen-golive: ROLLBACK (close Quartz first, the same clean way):'
  Write-Output ('  1. back to stock Electron, Lumen code kept:  powershell -NoProfile -ExecutionPolicy Bypass -File ' + $Rollback + ' -Repo ' + $Repo + ' -NoCommit')
  Write-Output ('  2. and the code too (after 1):               git -C ' + $Repo + ' reset --hard ' + $old)
  Write-Output ('  3. relaunch:                                 explorer.exe "' + $Lnk + '"')
}
function Stop-Golive([string]$t) {
  Fail $t
  Write-Output ('lumen-golive: STOPPED - ' + $t)
  Rollback-Text
  Write-Output ('lumen-golive: verdict FAIL (' + $script:fails + ' failed)' + $(if ($DryRun) { ' [dry run]' } else { '' }))
  exit 1
}

# A native command, its output to a file (PowerShell 5.1 turns stderr into errors otherwise).
function Run([string]$exe, [string[]]$argList) {
  $log = [IO.Path]::GetTempFileName()
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  Push-Location $Repo
  try { & $exe @argList *> $log; $code = $LASTEXITCODE } finally { Pop-Location; $ErrorActionPreference = $old }
  $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
  if ($null -eq $text) { $text = '' } else { $text = [string]$text }
  Remove-Item $log -ErrorAction SilentlyContinue
  return @{ code = $code; text = $text }
}

# Every Quartz.exe / electron.exe running from THIS checkout's electron (never by image name alone).
function Here-Procs {
  $root = ($Dist + '\').ToLower()
  return @(Get-CimInstance Win32_Process -Filter "Name='Quartz.exe' OR Name='electron.exe'" |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($root) })
}
function Main-Procs { return @(Here-Procs | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--test-profile' }) }
function Test-Procs { return @(Here-Procs | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match '--test-profile' }) }

function Reg-Snapshot {
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($k in @('HKCU:\Software\Classes\QuartzURL', 'HKCU:\Software\Classes\QuartzHTML', 'HKCU:\Software\Clients\StartMenuInternet\Quartz')) {
    if (-not (Test-Path $k)) { $out.Add($k + ' <absent>'); continue }
    $items = @(Get-Item $k) + @(Get-ChildItem $k -Recurse -ErrorAction SilentlyContinue)
    foreach ($item in $items) {
      foreach ($n in $item.GetValueNames()) { $out.Add($item.Name + '|' + $n + '=' + [string]$item.GetValue($n, $null, 'DoNotExpandEnvironmentNames')) }
    }
  }
  $ra = Get-ItemProperty 'HKCU:\Software\RegisteredApplications' -Name Quartz -ErrorAction SilentlyContinue
  $out.Add('RegisteredApplications|Quartz=' + [string]$(if ($ra) { $ra.Quartz } else { '' }))
  foreach ($p in @('Shell\Associations\UrlAssociations\http', 'Shell\Associations\UrlAssociations\https', 'CurrentVersion\Explorer\FileExts\.html', 'CurrentVersion\Explorer\FileExts\.htm')) {
    $uc = Get-ItemProperty ('HKCU:\Software\Microsoft\Windows\' + $p + '\UserChoice') -Name ProgId -ErrorAction SilentlyContinue
    $out.Add($p + ' UserChoice ProgId=' + [string]$(if ($uc) { $uc.ProgId } else { '' }))
  }
  return (($out | Sort-Object) -join "`n")
}

function Pty-Hash {
  if (-not (Test-Path $PtyDir)) { return '' }
  return ((Get-ChildItem $PtyDir -Filter *.node | Sort-Object Name | ForEach-Object { $_.Name + ':' + (Get-FileHash $_.FullName -Algorithm SHA256).Hash }) -join ';')
}

Say ('repo ' + $Repo + ', target ' + $Ref + $(if ($DryRun) { ' [DRY RUN: Quartz is not closed and nothing is swapped]' } else { '' }))
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force $StateDir | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ---- 0. preflight (Quartz still open) ------------------------------------------------------
if (-not (Test-Path (Join-Path $Repo '.git'))) { Stop-Golive ($Repo + ' is not a Quartz checkout') }
$f = Run 'git' @('fetch', 'origin')
if ($f.code -ne 0) { Stop-Golive ('git fetch origin failed: ' + (Tail $f.text 2)) }
Pass 'preflight: git fetch origin'
$dirty = (Run 'git' @('status', '--porcelain', '--untracked-files=no')).text
if ($dirty.Trim()) { Stop-Golive ('uncommitted changes in ' + $Repo + ': ' + (Tail $dirty 3)) }
Pass 'preflight: checkout clean'
$branch = (Run 'git' @('rev-parse', '--abbrev-ref', 'HEAD')).text.Trim()
$script:oldHead = (Run 'git' @('rev-parse', 'HEAD')).text.Trim()
$target = (Run 'git' @('rev-parse', '--verify', '--quiet', $Ref)).text.Trim()
if (-not $target) { Stop-Golive ($Ref + ' does not exist after the fetch') }
if ($branch -eq 'master') { Pass 'preflight: on master' } elseif ($DryRun) { Info ('preflight: on ' + $branch + ' (dry run on a worktree; the real run needs master)') } else { Stop-Golive ('on ' + $branch + ', not master') }
if ((Run 'git' @('merge-base', '--is-ancestor', $script:oldHead, $target)).code -ne 0) { Stop-Golive ('HEAD ' + $script:oldHead.Substring(0, 7) + ' -> ' + $target.Substring(0, 7) + ' is not a fast-forward') }
Pass ('preflight: ' + $script:oldHead.Substring(0, 7) + ' -> ' + $target.Substring(0, 7) + ' is a fast-forward')
$om = (Run 'git' @('rev-parse', '--verify', '--quiet', 'origin/master')).text.Trim()
if ($om -eq $target) { Pass ('preflight: origin/master is ' + $target.Substring(0, 7) + ' too') }
else { Info ('preflight: origin/master is ' + $(if ($om) { $om.Substring(0, 7) } else { 'missing' }) + ', not ' + $target.Substring(0, 7) + ' (main pushes master to the same SHA first)') }
$pkgAt = (Run 'git' @('show', ($target + ':package.json'))).text
if ($pkgAt -match '"electron":\s*"[^"]*#v[0-9.]+\+wvcus"') { Pass 'preflight: the target package.json pins castlabs Electron (+wvcus)' } else { Stop-Golive 'the target package.json does not pin a castlabs +wvcus Electron' }
$v = Run 'py' @('-3', '-m', 'castlabs_evs.vmp', '--version')
if ($v.code -eq 0) { Pass ('preflight: castlabs-evs ' + (Tail $v.text 1)) } else { Stop-Golive 'castlabs-evs is not installed (py -3 -m pip install --upgrade castlabs-evs)' }
$evsCfg = Join-Path $env:USERPROFILE '.config\evs\config.json'
if ((Test-Path $evsCfg) -and ((Get-Item $evsCfg).Length -gt 2)) { Pass 'preflight: EVS config present (not printed)' } else { Stop-Golive 'no EVS account config (~/.config/evs/config.json); py -3 -m castlabs_evs.account reauth' }
$tests = Test-Procs
if ($tests.Count) { Info ('preflight: ' + $tests.Count + ' test instance(s) from this checkout run (PID ' + (($tests | ForEach-Object { $_.ProcessId }) -join ', ') + '); the swap refuses until they end') }

# ---- 1. snapshots --------------------------------------------------------------------------
$regBefore = Reg-Snapshot
$regFile = Join-Path $StateDir ('registry-before-' + $stamp + '.txt')
[IO.File]::WriteAllText($regFile, $regBefore, (New-Object Text.UTF8Encoding($false)))
$quartzUrl = @($regBefore -split "`n" | Where-Object { $_ -match 'QuartzURL' })
Pass ('1. registry snapshot: ' + $quartzUrl.Count + ' QuartzURL value(s), saved to ' + $regFile)
$ptyBefore = Pty-Hash
if ($ptyBefore) { Pass ('1. node-pty native files hashed (' + (@($ptyBefore -split ';')).Count + ' .node files)') } else { Stop-Golive ('node-pty native files missing in ' + $PtyDir + ' (the terminal would break); not going live') }
$state = [ordered]@{ repo = $Repo; oldHead = $script:oldHead; target = $target; at = (Get-Date).ToString('o'); registry = $regFile; dryRun = [bool]$DryRun }
[IO.File]::WriteAllText((Join-Path $StateDir ('state-' + $stamp + '.json')), ($state | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))

# ---- 2. close Quartz cleanly ---------------------------------------------------------------
$main = Main-Procs
if ($DryRun) {
  if ($main.Count) { Info ('2. would close main Quartz PID ' + (($main | ForEach-Object { $_.ProcessId }) -join ', ') + ' (CloseMainWindow, then wait); dry run: not closed') }
  else { Info ('2. no Quartz runs from ' + $Dist + '; nothing to close') }
  $live = @(Get-CimInstance Win32_Process -Filter "Name='Quartz.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq 'c:\users\you\browser\node_modules\electron\dist\quartz.exe' -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--test-profile' })
  Info ('2. probe of the live checkout (read only): main Quartz PID ' + $(if ($live.Count) { ($live | ForEach-Object { $_.ProcessId }) -join ', ' } else { 'none' }) + ' is what the real run closes')
} else {
  if (-not $main.Count) { Pass '2. Quartz is not running from this checkout; nothing to close' }
  else {
    if ($main.Count -gt 1) { Info ('2. ' + $main.Count + ' main Quartz processes: ' + (($main | ForEach-Object { $_.ProcessId }) -join ', ')) }
    $deadline = (Get-Date).AddSeconds($CloseTimeoutSec)
    $closed = @{}
    while ((Get-Date) -lt $deadline) {
      $left = Main-Procs
      if (-not $left.Count) { break }
      foreach ($m in $left) {
        $p = $null
        try { $p = Get-Process -Id $m.ProcessId -ErrorAction Stop } catch { $p = $null }
        if (-not $p) { continue }
        $h = [int64]$p.MainWindowHandle
        $key = [string]$m.ProcessId + ':' + $h
        if ($h -ne 0 -and -not $closed.ContainsKey($key)) {
          $closed[$key] = $true
          Say ('closing Quartz PID ' + $m.ProcessId + ' window ' + $h + ' (CloseMainWindow)')
          [void]$p.CloseMainWindow()
        }
      }
      Start-Sleep -Milliseconds 1000
    }
    $left = Main-Procs
    if ($left.Count) { Stop-Golive ('Quartz PID ' + (($left | ForEach-Object { $_.ProcessId }) -join ', ') + ' did not exit within ' + $CloseTimeoutSec + ' s of CloseMainWindow; NOT killed. Close it by hand, then run this again') }
    Pass '2. main Quartz exited after CloseMainWindow'
  }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and (@(Here-Procs | Where-Object { $_.CommandLine -notmatch '--test-profile' })).Count) { Start-Sleep -Milliseconds 500 }
  $rest = @(Here-Procs | Where-Object { $_.CommandLine -notmatch '--test-profile' })
  if ($rest.Count) { Stop-Golive ('Quartz helper processes still run 30 s after the main one left (PID ' + (($rest | ForEach-Object { $_.ProcessId }) -join ', ') + '); NOT killed') }
  Pass '2. no Quartz process from this checkout is left'
}

# ---- 3. fast-forward -----------------------------------------------------------------------
$ff = Run 'git' @('merge', '--ff-only', $Ref)
if ($ff.code -ne 0) { Stop-Golive ('git merge --ff-only ' + $Ref + ' failed: ' + (Tail $ff.text 2)) }
$now = (Run 'git' @('rev-parse', 'HEAD')).text.Trim()
if ($now -eq $target) { Pass ('3. HEAD is ' + $now.Substring(0, 7) + ' (' + $Ref + ')') } else { Stop-Golive ('HEAD is ' + $now.Substring(0, 7) + ' after the merge, not ' + $target.Substring(0, 7)) }

# ---- 4. the castlabs swap ------------------------------------------------------------------
if (-not (Test-Path $Swap)) { Stop-Golive ('tools\drm-swap.ps1 is missing in ' + $Repo) }
$swapText = Get-Content $Swap -Raw
if ($swapText -notmatch '\[switch\]\$NoMerge') { Stop-Golive 'drm-swap.ps1 has no -NoMerge switch' }
if ($DryRun) {
  Info ('4. would run: powershell -NoProfile -ExecutionPolicy Bypass -File ' + $Swap + ' -Repo ' + $Repo + ' -NoMerge  (dry run: not run)')
  $q = Run 'npm' @('run', 'quartz-exe')
  if ($q.code -eq 0) { Pass ('4. npm run quartz-exe: ' + (Tail $q.text 1)) } else { Fail ('4. npm run quartz-exe failed: ' + (Tail $q.text 2)) }
  $ev = ''
  try { $ev = [string](Get-Content (Join-Path $Repo 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version } catch { $ev = '' }
  if ($ev -match '\+wvcus$') { Pass ('4. electron here is ' + $ev) } else { Info ('4. electron here is ' + $(if ($ev) { $ev } else { 'none' }) + ' (the swap installs the castlabs one)') }
  $sig = Join-Path $Dist 'Quartz.exe.sig'
  Info ('4. Quartz.exe.sig ' + $(if (Test-Path $sig) { 'present' } else { 'absent here (the real swap signs it and checks it exists)' }))
} else {
  Say ('running ' + $Swap + ' -Repo ' + $Repo + ' -NoMerge ...')
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $swapOut = & powershell -NoProfile -ExecutionPolicy Bypass -File $Swap -Repo $Repo -NoMerge 2>&1
  $swapCode = $LASTEXITCODE
  $ErrorActionPreference = $old
  foreach ($l in @($swapOut)) { Write-Output ('  ' + (Clean ([string]$l))) }
  if ($swapCode -ne 0) { Stop-Golive ('drm-swap.ps1 exited ' + $swapCode + ' (its STOPPED line above says why)') }
  Pass '4. drm-swap.ps1 -NoMerge finished (castlabs Electron, Quartz.exe made, signed and verified)'
  $sig = Join-Path $Dist 'Quartz.exe.sig'
  if (Test-Path $sig) { Pass ('4. Quartz.exe.sig exists (' + (Get-Item $sig).Length + ' bytes)') } else { Stop-Golive 'Quartz.exe.sig does not exist after the swap' }
}

# ---- 5. node-pty ---------------------------------------------------------------------------
$ptyAfter = Pty-Hash
if ($ptyAfter -and $ptyAfter -eq $ptyBefore) { Pass '5. node-pty native files are byte-identical to before' } else { Stop-Golive ('node-pty native files changed or went missing (before: ' + (@($ptyBefore -split ';')).Count + ' files, after: ' + $(if ($ptyAfter) { (@($ptyAfter -split ';')).Count } else { 0 }) + ')') }

# ---- 6. relaunch through the Start Menu shortcut -------------------------------------------
if (-not (Test-Path $Lnk)) { Stop-Golive ('the Start Menu shortcut is missing: ' + $Lnk) }
$sc = (New-Object -ComObject WScript.Shell).CreateShortcut($Lnk)
$want = (Join-Path $Dist 'Quartz.exe')
if ($DryRun) {
  Info ('6. would run: explorer.exe "' + $Lnk + '" (dry run: not launched)')
  if (Test-Path $sc.TargetPath) { Pass ('6. the shortcut targets ' + $sc.TargetPath + ' (exists)') } else { Fail ('6. the shortcut target is missing: ' + $sc.TargetPath) }
  if ($sc.TargetPath -ieq $want) { Pass '6. the shortcut targets this checkout' } else { Info ('6. the shortcut targets ' + $sc.TargetPath + ', not this checkout (expected for a worktree dry run)') }
} else {
  if ($sc.TargetPath -ine $want) { Stop-Golive ('the shortcut targets ' + $sc.TargetPath + ', not ' + $want) }
  Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $Lnk + '"')
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline -and -not (Main-Procs).Count) { Start-Sleep -Milliseconds 500 }
  $up = Main-Procs
  if ($up.Count) { Pass ('6. Quartz relaunched through the shortcut (PID ' + (($up | ForEach-Object { $_.ProcessId }) -join ', ') + ', ' + (Split-Path -Leaf $up[0].ExecutablePath) + ')') }
  else { Fail '6. Quartz did not start within 45 s of explorer.exe on the shortcut' }
  Start-Sleep -Seconds 10   # let it finish starting before the registry is compared
}

# ---- 7. registry untouched -----------------------------------------------------------------
$regAfter = Reg-Snapshot
if ($regAfter -eq $regBefore) { Pass '7. QuartzURL / QuartzHTML / StartMenuInternet / RegisteredApplications / UserChoice untouched' }
else {
  $a = $regBefore -split "`n"; $b = $regAfter -split "`n"
  Fail ('7. the default-browser registry changed: ' + ((Compare-Object $a $b | ForEach-Object { $_.SideIndicator + ' ' + $_.InputObject }) -join ' ; ') + ' (snapshot: ' + $regFile + ')')
}

# ---- 8. rollback -----------------------------------------------------------------------------
Rollback-Text
Write-Output ('lumen-golive: verdict ' + $(if ($script:fails) { 'FAIL (' + $script:fails + ' failed)' } else { 'PASS' }) + $(if ($DryRun) { ' [dry run]' } else { '' }))
if ($script:fails) { exit 1 }
exit 0
