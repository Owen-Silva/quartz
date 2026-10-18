<#
quartz-ff-golive.ps1 -- a CODE-ONLY Quartz release live (main 10-18, from tools/lumen-golive.ps1).
For a release whose package.json/package-lock.json are unchanged since the live HEAD, so the castlabs
Electron already in node_modules (EVS-signed at release 1) stays as it is: no npm, no swap, no re-sign.

    powershell -NoProfile -ExecutionPolicy Bypass -File <this> -Ref origin/wk/lumen-release3 -Expect <sha> [-DryRun]

  0. Preflight, with Quartz still open: git fetch; the checkout is clean and on master; HEAD -> Ref is a
     fast-forward; Ref is exactly -Expect; package.json and package-lock.json are unchanged HEAD..Ref
     (else STOP: that needs the swap script); node_modules electron is +wvcus and Quartz.exe.sig exists.
  1. Snapshot the default-browser registry and node-pty's native files and Quartz.exe(.sig) hashes.
  2. Close Quartz cleanly (CloseMainWindow on the MAIN Quartz.exe of this checkout; never kills).
  3. git merge --ff-only Ref.  (DRY RUN: skipped; the live checkout is never touched.)
  4. CHECK ONLY: electron still +wvcus; Quartz.exe and Quartz.exe.sig byte-identical to step 1.
  5. node-pty: the same bytes as before.
  6. Relaunch through explorer.exe on the Start Menu Quartz.lnk (keeps the AUMID).
  7. The registry compared with step 1's snapshot: it must be untouched.
  8. The rollback command (git reset --hard <old HEAD>; no Electron change to undo).
  Every check prints a PASS / FAIL line; the last line is the verdict. Secrets are never printed.
#>
param(
  [string]$Repo = 'C:\Users\you\browser',
  [string]$Ref = 'origin/wk/lumen-release3',
  [string]$Expect = '',
  [string]$Lnk = 'C:\Users\you\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Quartz.lnk',
  [int]$CloseTimeoutSec = 90,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path $Repo).Path
$Dist = Join-Path $Repo 'node_modules\electron\dist'
$PtyDir = Join-Path $Repo 'node_modules\@homebridge\node-pty-prebuilt-multiarch\build\Release'
$StateDir = Join-Path $env:LOCALAPPDATA 'Quartz-drm\ff-golive'
$script:fails = 0
$script:oldHead = ''
$script:merged = $false

function Say([string]$t) { Write-Output ('ff-golive: ' + $t) }
function Exe-Hash {
  $out = @()
  foreach ($n in @('Quartz.exe', 'Quartz.exe.sig')) {
    $p = Join-Path $Dist $n
    if (Test-Path $p) { $out += ($n + ':' + (Get-FileHash $p -Algorithm SHA256).Hash) } else { $out += ($n + ':missing') }
  }
  return ($out -join ';')
}
function Clean([string]$t) { if (-not $t) { return '' }; return ($t -replace '[A-Za-z0-9_\-\.=/+]{32,}', '<redacted>') }
function Tail([string]$t, [int]$n) { if (-not $t) { return '' }; $l = @($t -split "`r?`n" | Where-Object { $_.Trim() }); return (Clean (($l | Select-Object -Last $n) -join ' | ')) }
function Pass([string]$what) { Write-Output ('PASS ' + $what) }
function Fail([string]$what) { Write-Output ('FAIL ' + $what); $script:fails++ }
function Info([string]$what) { Write-Output ('INFO ' + $what) }

function Rollback-Text {
  $old = $(if ($script:oldHead) { $script:oldHead } else { '<HEAD before go-live>' })
  Write-Output 'ff-golive: ROLLBACK (close Quartz first, the same clean way; no Electron change to undo):'
  Write-Output ('  1. the code:   git -C ' + $Repo + ' reset --hard ' + $old)
  Write-Output ('  2. relaunch:   explorer.exe "' + $Lnk + '"')
}
function Stop-Golive([string]$t) {
  Fail $t
  Write-Output ('ff-golive: STOPPED - ' + $t + $(if ($script:merged) { ' (HEAD WAS ALREADY FAST-FORWARDED)' } else { ' (the checkout was NOT changed)' }))
  Rollback-Text
  Write-Output ('ff-golive: verdict FAIL (' + $script:fails + ' failed)' + $(if ($DryRun) { ' [dry run]' } else { '' }))
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
if ($Expect) {
  if ($target.StartsWith($Expect)) { Pass ('preflight: ' + $Ref + ' is the expected ' + $target.Substring(0, 7)) } else { Stop-Golive ($Ref + ' is ' + $target.Substring(0, 7) + ', not the expected ' + $Expect) }
} else { Stop-Golive 'no -Expect SHA given; refusing to ship whatever the branch points at' }
$pkgAt = (Run 'git' @('show', ($target + ':package.json'))).text
if ($pkgAt -match '"electron":\s*"[^"]*#v[0-9.]+\+wvcus"') { Pass 'preflight: the target package.json pins castlabs Electron (+wvcus)' } else { Stop-Golive 'the target package.json does not pin a castlabs +wvcus Electron' }
$dep = Run 'git' @('diff', '--quiet', $script:oldHead, $target, '--', 'package.json', 'package-lock.json')
if ($dep.code -eq 0) { Pass 'preflight: package.json and package-lock.json are unchanged HEAD..target (code-only release)' } else { Stop-Golive 'package.json or package-lock.json changed HEAD..target: this needs tools/lumen-golive.ps1 (npm + swap), not this script' }
$ev = ''
try { $ev = [string](Get-Content (Join-Path $Repo 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version } catch { $ev = '' }
if ($ev -match '\+wvcus$') { Pass ('preflight: electron here is ' + $ev) } else { Stop-Golive ('electron here is ' + $(if ($ev) { $ev } else { 'none' }) + ', not castlabs +wvcus') }
if (Test-Path (Join-Path $Dist 'Quartz.exe.sig')) { Pass 'preflight: Quartz.exe.sig exists (EVS-signed build)' } else { Stop-Golive 'Quartz.exe.sig is missing: the build is not signed' }
$tests = @(Test-Procs)
if ($tests.Count) { Stop-Golive ([string]$tests.Count + ' test instance(s) run from this checkout (PID ' + (($tests | ForEach-Object { $_.ProcessId }) -join ', ') + '); not going live under them') }
$exeBefore = Exe-Hash

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
$main = @(Main-Procs)
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
      $left = @(Main-Procs)
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
    $left = @(Main-Procs)
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
if ($DryRun) {
  Info ('3. would run: git merge --ff-only ' + $Ref + ' (' + $script:oldHead.Substring(0, 7) + ' -> ' + $target.Substring(0, 7) + '); dry run: the checkout is not touched')
} else {
  $ff = Run 'git' @('merge', '--ff-only', $Ref)
  if ($ff.code -ne 0) { Stop-Golive ('git merge --ff-only ' + $Ref + ' failed: ' + (Tail $ff.text 2)) }
  $script:merged = $true
  $now = (Run 'git' @('rev-parse', 'HEAD')).text.Trim()
  if ($now -eq $target) { Pass ('3. HEAD is ' + $now.Substring(0, 7) + ' (' + $Ref + ')') } else { Stop-Golive ('HEAD is ' + $now.Substring(0, 7) + ' after the merge, not ' + $target.Substring(0, 7)) }
}

# ---- 4. CHECK ONLY: the signed castlabs build is untouched --------------------------------
$ev2 = ''
try { $ev2 = [string](Get-Content (Join-Path $Repo 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version } catch { $ev2 = '' }
if ($ev2 -match '\+wvcus$') { Pass ('4. electron is still ' + $ev2) } else { Stop-Golive ('electron is ' + $ev2 + ' after the fast-forward, not castlabs') }
$exeAfter = Exe-Hash
if ($exeAfter -eq $exeBefore -and $exeAfter -notmatch 'missing') { Pass '4. Quartz.exe and Quartz.exe.sig are byte-identical to before (the EVS signature still matches)' } else { Stop-Golive ('Quartz.exe or its .sig changed or went missing: ' + $exeAfter) }

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
  $launchAt = Get-Date
  Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $Lnk + '"')
  # The first start after the swap runs a freshly written, freshly signed dist that Defender scans
  # on first use: on this laptop that took over 45 s on 10-18 (main Quartz created 00:37:15, after
  # the old 45 s window had closed). Wait 120 s, and look once more before the verdict.
  $deadline = $launchAt.AddSeconds(120)
  while ((Get-Date) -lt $deadline -and -not @(Main-Procs).Count) { Start-Sleep -Milliseconds 500 }
  $up = @(Main-Procs)
  if ($up.Count) { Pass ('6. Quartz relaunched through the shortcut (PID ' + (($up | ForEach-Object { $_.ProcessId }) -join ', ') + ', ' + (Split-Path -Leaf $up[0].ExecutablePath) + ', up ' + [math]::Round(($up[0].CreationDate - $launchAt).TotalSeconds) + ' s after explorer.exe)') }
  else { Info '6. no main Quartz yet 120 s after explorer.exe on the shortcut; looked at again before the verdict' }
  Start-Sleep -Seconds 10   # let it finish starting before the registry is compared
}

# ---- 7. registry untouched -----------------------------------------------------------------
$regAfter = Reg-Snapshot
if ($regAfter -eq $regBefore) { Pass '7. QuartzURL / QuartzHTML / StartMenuInternet / RegisteredApplications / UserChoice untouched' }
else {
  $a = $regBefore -split "`n"; $b = $regAfter -split "`n"
  Fail ('7. the default-browser registry changed: ' + ((Compare-Object $a $b | ForEach-Object { $_.SideIndicator + ' ' + $_.InputObject }) -join ' ; ') + ' (snapshot: ' + $regFile + ')')
}
# Step 6 again, when it saw no main Quartz in its 120 s: a late start is a start (with its time).
if (-not $DryRun -and $launchAt -and -not $up.Count) {
  $late = @(Main-Procs)
  if ($late.Count) { Pass ('6. Quartz started late (PID ' + (($late | ForEach-Object { $_.ProcessId }) -join ', ') + ', up ' + [math]::Round(($late[0].CreationDate - $launchAt).TotalSeconds) + ' s after explorer.exe)') }
  else { Fail ('6. Quartz did not start within ' + [math]::Round(((Get-Date) - $launchAt).TotalSeconds) + ' s of explorer.exe on the shortcut') }
}

# ---- 8. rollback -----------------------------------------------------------------------------
Rollback-Text
Write-Output ('ff-golive: verdict ' + $(if ($script:fails) { 'FAIL (' + $script:fails + ' failed)' } else { 'PASS' }) + $(if ($DryRun) { ' [dry run]' } else { '' }))
if ($script:fails) { exit 1 }
exit 0
