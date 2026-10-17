<#
tools/drm-swap.ps1 -- put Quartz on castlabs Electron (Widevine) and sign it for streaming.

  Live swap (Quartz CLOSED; run from the live checkout):
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\drm-swap.ps1
  After an Electron update or a Quartz.exe rebuild (sign again, verify, re-mark):
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\drm-swap.ps1 -ResignOnly
  Dry run on a test copy (no merge, no signing):
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\drm-swap.ps1 -Repo C:\path\to\worktree -NoMerge -SkipSign

What it does, in order (any failure stops it with "drm-swap: STOPPED - <reason>"):
  0. Refuses while Quartz.exe / electron.exe from THIS checkout runs, with uncommitted tracked
     changes, without castlabs-evs, or (unless -SkipSign) while EVS is not signed in
     ("py -3 -m castlabs_evs.account reauth" is the user's step). Snapshots the default-browser
     registry (QuartzURL, QuartzHTML, StartMenuInternet\Quartz, RegisteredApplications,
     the http/https/.htm/.html UserChoice). It never writes any of them.
  1. git merge --ff-only <Branch> (a real merge only if master moved; aborted on conflict).
  2. Moves node_modules\electron aside (kept for drm-rollback.ps1), then
     npm install --ignore-scripts (only electron changes: npm ci would delete node-pty's
     Electron build, which cannot be rebuilt from npm) and node node_modules\electron\install.js.
  3. Checks node-pty's native files are byte-identical to before (restores them if not).
  4. npm run quartz-exe (rcedit) BEFORE signing.
  5. py -3 -m castlabs_evs.vmp -n sign-pkg -H Quartz <dist>, then verify-pkg -H Quartz.
     -H Quartz matters: without it sign-pkg signs electron.exe and Quartz.exe stays unsigned.
     castlabs moves electron.exe.sig while signing Quartz.exe; the dev one is put back.
  6. Quartz.exe.sig must exist; writes node_modules\electron\quartz-vmp.json, which Quartz
     reads to know it is signed (Settings > Protected video, Watch, the DRM bar).
  7. Registry compared with the snapshot: any difference is reported (exit 2).
It never starts Quartz, never touches the default browser, and never prints EVS credentials.
#>
param(
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [string]$Branch = 'wk/quartz-drm2',
  [switch]$NoMerge,
  [switch]$SkipSign,
  [switch]$ResignOnly
)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path $Repo).Path
$ElectronDir = Join-Path $Repo 'node_modules\electron'
$Dist = Join-Path $ElectronDir 'dist'
$PtyDir = Join-Path $Repo 'node_modules\@homebridge\node-pty-prebuilt-multiarch\build\Release'
$StateDir = Join-Path $env:LOCALAPPDATA ('Quartz-drm\' + (Split-Path -Leaf $Repo))
$Marker = Join-Path $ElectronDir 'quartz-vmp.json'

function Say([string]$t) { Write-Output ('drm-swap: ' + $t) }
function Stop-Swap([string]$t) { Write-Output ('drm-swap: STOPPED - ' + $t); exit 1 }
# Long token-like runs never reach the console.
function Clean([string]$t) { if (-not $t) { return '' }; return ($t -replace '[A-Za-z0-9_\-\.=/+]{32,}', '<redacted>') }
function Tail([string]$t, [int]$n) { if (-not $t) { return '' }; $l = @($t -split "`r?`n" | Where-Object { $_.Trim() }); return (Clean (($l | Select-Object -Last $n) -join ' | ')) }

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

function Running-Here {
  $root = $ElectronDir.ToLower()
  return @(Get-CimInstance Win32_Process -Filter "Name='Quartz.exe' OR Name='electron.exe'" |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($root) })
}

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

function Ms([IO.FileInfo]$f) { return [DateTimeOffset]::new($f.LastWriteTimeUtc).ToUnixTimeMilliseconds() }

function Evs-Check {
  $v = Run 'py' @('-3', '-m', 'castlabs_evs.vmp', '--version')
  if ($v.code -ne 0) { Stop-Swap 'castlabs-evs is not installed. The user: py -3 -m pip install --upgrade castlabs-evs' }
  $a = Run 'py' @('-3', '-m', 'castlabs_evs.account', '-n', 'refresh')
  if ($a.code -ne 0) { Stop-Swap ("EVS isn't signed in (" + (Tail $a.text 1) + '). The user: py -3 -m castlabs_evs.account reauth, then run this again.') }
  Say ('castlabs-evs ' + (Tail $v.text 1) + ', EVS signed in.')
}

function Sign-And-Mark {
  $exe = Join-Path $Dist 'Quartz.exe'
  if (-not (Test-Path $exe)) { Stop-Swap 'Quartz.exe is missing; npm run quartz-exe did not make it.' }
  $devSig = Join-Path $Dist 'electron.exe.sig'
  $keep = Join-Path $StateDir 'electron.exe.sig.dev'
  if (Test-Path $devSig) { Copy-Item $devSig $keep -Force }
  Say 'signing Quartz.exe with castlabs EVS (sign-pkg -H Quartz) ...'
  $s = Run 'py' @('-3', '-m', 'castlabs_evs.vmp', '-n', 'sign-pkg', '-H', 'Quartz', $Dist)
  # castlabs moves (or deletes) electron.exe.sig whenever it signs OR verifies another exe in the
  # folder; electron.exe gets its shipped development signature back once both are done.
  $restore = { if ((-not (Test-Path $devSig)) -and (Test-Path $keep)) { Copy-Item $keep $devSig -Force } }
  if ($s.code -ne 0) {
    & $restore
    if ($s.text -match 'NonInteractive|[Aa]uth|Unauthori|[Tt]oken|[Cc]redential|[Pp]asswd|[Pp]assword|Forbidden|[Aa]ccount') {
      Stop-Swap ("EVS refused: not signed in (" + (Tail $s.text 1) + '). The user: py -3 -m castlabs_evs.account reauth, then tools\drm-swap.ps1 -ResignOnly.')
    }
    Stop-Swap ('sign-pkg failed: ' + (Tail $s.text 3))
  }
  $vf = Run 'py' @('-3', '-m', 'castlabs_evs.vmp', '-n', 'verify-pkg', '-H', 'Quartz', $Dist)
  & $restore
  if ($vf.code -ne 0) { Stop-Swap ('verify-pkg says the signature is not valid for streaming: ' + (Tail $vf.text 2)) }
  $sig = Join-Path $Dist 'Quartz.exe.sig'
  if (-not (Test-Path $sig)) { Stop-Swap 'Quartz.exe.sig does not exist after signing.' }
  $fe = Get-Item $exe; $fs = Get-Item $sig
  $tag = ''
  try { $tag = [string](Get-Content (Join-Path $ElectronDir 'package.json') -Raw | ConvertFrom-Json).version } catch { $tag = '' }
  $m = [ordered]@{ exe = 'Quartz.exe'; exeSize = $fe.Length; exeMtimeMs = (Ms $fe); sigSize = $fs.Length; sigMtimeMs = (Ms $fs);
    signedAt = (Get-Date).ToUniversalTime().ToString('o'); electron = $tag; evs = 'verify-pkg ok' }
  [IO.File]::WriteAllText($Marker, ($m | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  Say ('signed and verified (' + (Tail $vf.text 1) + '); Quartz.exe.sig ' + $fs.Length + ' bytes; marker written.')
}

# ---- 0. preflight ------------------------------------------------------------------------
if (-not (Test-Path (Join-Path $Repo '.git'))) { Stop-Swap ($Repo + ' is not a Quartz checkout.') }
$run = Running-Here
if ($run.Count) { Stop-Swap ('Quartz is running from this checkout (PID ' + (($run | ForEach-Object { $_.ProcessId }) -join ', ') + '). Close Quartz first; this script never closes it.') }
$dirty = (Run 'git' @('status', '--porcelain', '--untracked-files=no')).text
if ($dirty.Trim()) { Stop-Swap ('uncommitted changes in ' + $Repo + ': ' + (Tail $dirty 3)) }
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force $StateDir | Out-Null }
if (-not $SkipSign) { Evs-Check } else { Say 'SKIPPING EVS (-SkipSign): this run will not sign anything.' }
$regBefore = Reg-Snapshot
$ptyBefore = Pty-Hash
$preHead = (Run 'git' @('rev-parse', 'HEAD')).text.Trim()

function Finish {
  $regAfter = Reg-Snapshot
  if ($regAfter -ne $regBefore) {
    $a = $regBefore -split "`n"; $b = $regAfter -split "`n"
    Say ('WARNING: the default-browser registry changed during the run (this script never writes it): ' + ((Compare-Object $a $b | ForEach-Object { $_.SideIndicator + ' ' + $_.InputObject }) -join ' ; '))
    exit 2
  }
  Say 'registry unchanged (QuartzURL, QuartzHTML, StartMenuInternet\Quartz, RegisteredApplications, UserChoice).'
}

if ($ResignOnly) {
  Say 'resign only: npm run quartz-exe (no-op when Quartz.exe is current), then sign.'
  $q = Run 'npm' @('run', 'quartz-exe')
  if ($q.code -ne 0) { Stop-Swap ('npm run quartz-exe failed: ' + (Tail $q.text 3)) }
  Sign-And-Mark
  Finish
  Say 'DONE. Start Quartz from the pin; Settings > Protected video should say it can play DRM-protected video.'
  exit 0
}

# ---- 1. merge ----------------------------------------------------------------------------
if (-not $NoMerge) {
  if ((Run 'git' @('rev-parse', '--verify', '--quiet', $Branch)).code -ne 0) { Stop-Swap ('branch ' + $Branch + ' does not exist here.') }
  $ff = Run 'git' @('merge', '--ff-only', $Branch)
  if ($ff.code -ne 0) {
    Say 'master moved since the branch was made: a real merge.'
    $mg = Run 'git' @('-c', 'user.name=Owen Silva', '-c', 'user.email=272956043+Owen-Silva@users.noreply.github.com', 'merge', '--no-edit', $Branch)
    if ($mg.code -ne 0) { Run 'git' @('merge', '--abort') | Out-Null; Stop-Swap ('merge conflict, merge aborted, nothing changed: ' + (Tail $mg.text 3)) }
  }
  Say ('merged ' + $Branch + ': ' + $preHead.Substring(0, 7) + ' -> ' + (Run 'git' @('rev-parse', '--short', 'HEAD')).text.Trim())
} else { Say 'no merge (-NoMerge): installing what this checkout already has.' }

$spec = [string]((Get-Content (Join-Path $Repo 'package.json') -Raw | ConvertFrom-Json).dependencies.electron)
if ($spec -notmatch '#v([0-9.]+\+wvcus)$') { Stop-Swap ('package.json electron is not a castlabs +wvcus tag: ' + $spec) }
$want = $Matches[1]

# ---- 2. electron: aside, then the castlabs one -------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $StateDir ('electron-before-' + $stamp)
if (Test-Path $ElectronDir) { Move-Item $ElectronDir $backup; Say ('previous electron kept at ' + $backup) } else { $backup = '' }
$ptyKeep = ''
if (Test-Path $PtyDir) { $ptyKeep = Join-Path $StateDir ('pty-release-' + $stamp); Copy-Item $PtyDir $ptyKeep -Recurse }
$state = [ordered]@{ repo = $Repo; preHead = $preHead; head = (Run 'git' @('rev-parse', 'HEAD')).text.Trim(); backup = $backup; ptyBackup = $ptyKeep; at = (Get-Date).ToString('o'); electron = $want }
[IO.File]::WriteAllText((Join-Path $StateDir 'swap-state.json'), ($state | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))

$ni = Run 'npm' @('install', '--ignore-scripts', '--no-audit', '--no-fund')
if ($ni.code -ne 0) { Stop-Swap ('npm install failed (rollback: tools\drm-rollback.ps1): ' + (Tail $ni.text 3)) }
$ij = Run 'node' @('node_modules\electron\install.js')
if ($ij.code -ne 0) { Stop-Swap ('electron install.js failed (rollback: tools\drm-rollback.ps1): ' + (Tail $ij.text 3)) }
$got = ''
try { $got = [string](Get-Content (Join-Path $ElectronDir 'package.json') -Raw | ConvertFrom-Json).version } catch { $got = '' }
if ($got -ne $want -or -not (Test-Path (Join-Path $Dist 'electron.exe'))) { Stop-Swap ('installed electron is "' + $got + '", wanted ' + $want + ' (rollback: tools\drm-rollback.ps1)') }
Say ('castlabs electron ' + $got + ' installed.')
$lockDiff = (Run 'git' @('status', '--porcelain', '--untracked-files=no')).text
if ($lockDiff.Trim()) { Run 'git' @('checkout', '--', 'package.json', 'package-lock.json') | Out-Null; Say ('npm rewrote ' + (Tail $lockDiff 2) + '; put back as committed.') }

# ---- 3. node-pty's Electron build must be untouched -------------------------------------
if ((Pty-Hash) -ne $ptyBefore) {
  if ($ptyKeep) { if (Test-Path $PtyDir) { Remove-Item $PtyDir -Recurse -Force }; Copy-Item $ptyKeep $PtyDir -Recurse }
  if ((Pty-Hash) -ne $ptyBefore) { Stop-Swap 'node-pty native files changed and could not be put back (the terminal would break).' }
  Say 'node-pty native files were touched by npm and have been put back.'
} else { Say ('node-pty native files unchanged' + $(if ($ptyBefore) { '' } else { ' (none in this checkout)' }) + '.') }

# ---- 4. Quartz.exe (rcedit) before signing ------------------------------------------------
$q = Run 'npm' @('run', 'quartz-exe')
if ($q.code -ne 0) { Stop-Swap ('npm run quartz-exe failed: ' + (Tail $q.text 3)) }
Say ('Quartz.exe made: ' + (Tail $q.text 1))

# ---- 5-6. sign, verify, mark ---------------------------------------------------------------
if ($SkipSign) {
  Say 'SKIPPED signing (-SkipSign). Quartz shows "not signed for streaming services yet" and Watch sends Disney+, Prime and Hulu to Edge until tools\drm-swap.ps1 -ResignOnly runs with EVS signed in.'
} else { Sign-And-Mark }

# ---- 7. registry -------------------------------------------------------------------------
Finish
Say ('DONE: electron ' + $got + $(if ($SkipSign) { ', NOT signed' } else { ', Quartz.exe signed for streaming' }) + '. Start Quartz from the pin (never started by this script).')
exit 0
