<#
tools/drm-rollback.ps1 -- Quartz back on stock Electron after tools\drm-swap.ps1 (Quartz CLOSED).

    powershell -NoProfile -ExecutionPolicy Bypass -File tools\drm-rollback.ps1
    ... -Repo C:\path\to\worktree -NoCommit      (dry run on a test copy)

  1. Refuses while Quartz.exe / electron.exe from this checkout runs. Snapshots the
     default-browser registry; never writes it.
  2. package.json + package-lock.json back as they were before the swap (swap-state.json's
     preHead), committed as "DRM rollback" (skipped with -NoCommit or when nothing changed).
     The commit's e-mail: -CommitEmail, else $env:QUARTZ_COMMIT_EMAIL, else the repo's git config
     user.email; with none of them (and no -NoCommit) it stops before changing anything.
     The DRM code stays: on stock Electron it reports no Widevine, so Watch sends protected
     titles to Edge with the reason and the bar offers Edge, exactly as before the swap.
  3. node_modules\electron: the castlabs one is moved aside; the pre-swap one the swap kept is
     moved back (instant, offline). If it is gone: npm install --ignore-scripts + install.js.
  4. node-pty's native files checked unchanged; npm run quartz-exe (a no-op when current).
  5. Registry compared with the snapshot.
#>
param(
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [switch]$NoCommit,
  [string]$CommitEmail = ''
)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path $Repo).Path
$ElectronDir = Join-Path $Repo 'node_modules\electron'
$PtyDir = Join-Path $Repo 'node_modules\@homebridge\node-pty-prebuilt-multiarch\build\Release'
$StateDir = Join-Path $env:LOCALAPPDATA ('Quartz-drm\' + (Split-Path -Leaf $Repo))

function Say([string]$t) { Write-Output ('drm-rollback: ' + $t) }
function Stop-Back([string]$t) { Write-Output ('drm-rollback: STOPPED - ' + $t); exit 1 }
function Tail([string]$t, [int]$n) { if (-not $t) { return '' }; return ((@($t -split "`r?`n" | Where-Object { $_.Trim() }) | Select-Object -Last $n) -join ' | ') }
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
# The e-mail on the rollback commit: -CommitEmail, else $env:QUARTZ_COMMIT_EMAIL, else this repo's
# own git config user.email. None of them set = a loud stop, never a made-up address.
function Commit-Email {
  if ($CommitEmail) { return $CommitEmail.Trim() }
  if ($env:QUARTZ_COMMIT_EMAIL) { return $env:QUARTZ_COMMIT_EMAIL.Trim() }
  $e = (Run 'git' @('config', 'user.email')).text.Trim()
  if ($e) { return $e }
  Stop-Back 'no commit e-mail for the rollback commit: pass -CommitEmail you@example.com, set QUARTZ_COMMIT_EMAIL, or run "git config user.email you@example.com" in this repo (or use -NoCommit).'
}
function Pty-Hash {
  if (-not (Test-Path $PtyDir)) { return '' }
  return ((Get-ChildItem $PtyDir -Filter *.node | Sort-Object Name | ForEach-Object { $_.Name + ':' + (Get-FileHash $_.FullName -Algorithm SHA256).Hash }) -join ';')
}
# The same snapshot as drm-swap.ps1 (dot-sourcing it would run it).
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

$root = $ElectronDir.ToLower()
$run = @(Get-CimInstance Win32_Process -Filter "Name='Quartz.exe' OR Name='electron.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($root) })
if ($run.Count) { Stop-Back ('Quartz is running from this checkout (PID ' + (($run | ForEach-Object { $_.ProcessId }) -join ', ') + '). Close Quartz first.') }
$statePath = Join-Path $StateDir 'swap-state.json'
if (-not (Test-Path $statePath)) { Stop-Back ('no swap record at ' + $statePath + ' (was drm-swap.ps1 run on this checkout?)') }
$state = Get-Content $statePath -Raw | ConvertFrom-Json
# Only the swap this checkout is still on: its merged commit must be in HEAD's history.
if ((Run 'git' @('merge-base', '--is-ancestor', [string]$state.head, 'HEAD')).code -ne 0) {
  Stop-Back ('this checkout is not where the swap of ' + $state.at + ' left it (' + ([string]$state.head).Substring(0, 7) + ' is not in HEAD); nothing changed.')
}
$regBefore = Reg-Snapshot
$ptyBefore = Pty-Hash

# Resolved BEFORE anything changes, so a missing e-mail never leaves the package files half-restored.
$CommitAs = if ($NoCommit) { '' } else { Commit-Email }

# ---- package files back ------------------------------------------------------------------
$co = Run 'git' @('checkout', [string]$state.preHead, '--', 'package.json', 'package-lock.json')
if ($co.code -ne 0) { Stop-Back ('git checkout of the pre-swap package files failed: ' + (Tail $co.text 2)) }
$staged = (Run 'git' @('diff', '--cached', '--name-only')).text.Trim()
if ($staged -and -not $NoCommit) {
  $msg = Join-Path $env:TEMP ('drm-rollback-msg-' + $PID + '.txt')
  $body = "DRM rollback: Quartz back on stock Electron`n`npackage.json and package-lock.json as before tools\drm-swap.ps1 (" + ([string]$state.preHead).Substring(0, 7) + ").`nThe DRM code stays; on stock Electron it reports no Widevine and offers Edge.`n"
  [IO.File]::WriteAllText($msg, $body, (New-Object Text.UTF8Encoding($false)))
  $c = Run 'git' @('-c', 'user.name=Owen Silva', '-c', ('user.email=' + $CommitAs), 'commit', '-q', '-F', $msg)
  Remove-Item $msg -ErrorAction SilentlyContinue
  if ($c.code -ne 0) { Stop-Back ('commit failed: ' + (Tail $c.text 2)) }
  Say ('committed ' + (Run 'git' @('rev-parse', '--short', 'HEAD')).text.Trim() + ' (package files as before the swap).')
} elseif ($staged) { Say ('package files restored, NOT committed (-NoCommit): ' + $staged) }
else { Say 'package files already as before the swap.' }

# ---- electron back -------------------------------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path $ElectronDir) { Move-Item $ElectronDir (Join-Path $StateDir ('electron-castlabs-' + $stamp)) }
if ($state.backup -and (Test-Path ([string]$state.backup))) {
  Move-Item ([string]$state.backup) $ElectronDir
  Say ('pre-swap electron moved back from ' + $state.backup)
} else {
  Say 'the pre-swap electron folder is gone; installing it again.'
  $ni = Run 'npm' @('install', '--ignore-scripts', '--no-audit', '--no-fund')
  if ($ni.code -ne 0) { Stop-Back ('npm install failed: ' + (Tail $ni.text 3)) }
  $ij = Run 'node' @('node_modules\electron\install.js')
  if ($ij.code -ne 0) { Stop-Back ('electron install.js failed: ' + (Tail $ij.text 3)) }
  $left = (Run 'git' @('status', '--porcelain', '--untracked-files=no')).text
  if ($left.Trim() -and -not $NoCommit) { Run 'git' @('checkout', '--', 'package.json', 'package-lock.json') | Out-Null }
}
if ((Pty-Hash) -ne $ptyBefore) {
  if ($state.ptyBackup -and (Test-Path ([string]$state.ptyBackup))) { if (Test-Path $PtyDir) { Remove-Item $PtyDir -Recurse -Force }; Copy-Item ([string]$state.ptyBackup) $PtyDir -Recurse }
  if ((Pty-Hash) -ne $ptyBefore) { Stop-Back 'node-pty native files changed and could not be put back.' }
}
$q = Run 'npm' @('run', 'quartz-exe')
if ($q.code -ne 0) { Stop-Back ('npm run quartz-exe failed: ' + (Tail $q.text 3)) }
$ver = ''
try { $ver = [string](Get-Content (Join-Path $ElectronDir 'package.json') -Raw | ConvertFrom-Json).version } catch { $ver = '?' }

# This swap record is spent: a second rollback must not replay it.
Move-Item $statePath (Join-Path $StateDir ('swap-state.rolled-back-' + $stamp + '.json')) -Force
$regAfter = Reg-Snapshot
if ($regAfter -ne $regBefore) { Say 'WARNING: the default-browser registry changed during the run (this script never writes it).'; exit 2 }
Say ('DONE: electron ' + $ver + ', registry unchanged. Start Quartz from the pin.')
exit 0
