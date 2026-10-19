# autopause-smtc.ps1 - read and control Windows media sessions (SMTC).
#
# A small persistent helper for Quartz auto-pause. It talks to
# Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager
# through WinRT and speaks JSON lines: one request object per stdin line,
# exactly one compact reply object per stdout line. Nothing else is ever
# written to stdout. It exits when stdin closes.
#
# Requests:
#   {"id":1,"op":"ping"}
#   {"id":2,"op":"state"}
#   {"id":3,"op":"control","action":"play|pause|toggle|next|previous","aumid":"..."}
# Every failure is answered as {"id":n,"ok":false,"reason":"..."}.
#
# Windows PowerShell 5.1 only (WinRT projection is not available in pwsh 7).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Own UTF-8 (no BOM) streams, so titles survive whatever the console code page is.
$utf8 = New-Object System.Text.UTF8Encoding $false
$script:Out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$script:Out.AutoFlush = $true
$script:In = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)

$script:WinRtOk = $false
$script:WinRtError = ''
$script:AsTaskGeneric = $null
$script:AsTaskCache = @{}
$script:Manager = $null
$script:T_Manager = $null
$script:T_Props = $null
$script:T_Bool = [bool]

function Send-Reply($obj) {
    $json = ConvertTo-Json -InputObject $obj -Compress -Depth 5
    $script:Out.Write($json + "`n")
    $script:Out.Flush()
}

function Get-ShortError($err) {
    $m = ''
    try { $m = [string]$err.Exception.Message } catch { $m = [string]$err }
    $m = ($m -replace '\s+', ' ').Trim()
    if ($m.Length -gt 160) { $m = $m.Substring(0, 160) }
    if ($m -eq '') { $m = 'error' }
    return $m
}

# Load the WinRT types and find the generic AsTask(IAsyncOperation<T>) overload.
function Initialize-WinRt {
    try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
        $script:T_Manager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
        $script:T_Props = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
        $candidates = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.IsGenericMethodDefinition -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })
        if ($candidates.Count -lt 1) { throw 'AsTask(IAsyncOperation`1) not found' }
        $script:AsTaskGeneric = $candidates[0]
        $script:WinRtOk = $true
    } catch {
        $script:WinRtError = 'winrt load failed: ' + (Get-ShortError $_)
        $script:WinRtOk = $false
    }
}

# Await an IAsyncOperation<T> with a bounded wait. Throws 'timeout' on expiry.
function Wait-WinRtOp($Operation, [Type]$ResultType, [int]$TimeoutMs) {
    $key = $ResultType.FullName
    $asTask = $script:AsTaskCache[$key]
    if ($null -eq $asTask) {
        $asTask = $script:AsTaskGeneric.MakeGenericMethod($ResultType)
        $script:AsTaskCache[$key] = $asTask
    }
    $task = $asTask.Invoke($null, @($Operation))
    if (-not $task.Wait($TimeoutMs)) { throw 'timeout' }
    return $task.Result
}

# The session manager is requested once and reused. A failed request is
# retried on the next call so a transient failure does not stick.
function Get-Manager {
    if (-not $script:WinRtOk) { throw $script:WinRtError }
    if ($null -eq $script:Manager) {
        $script:Manager = Wait-WinRtOp ($script:T_Manager::RequestAsync()) $script:T_Manager 3000
        if ($null -eq $script:Manager) { throw 'no session manager' }
    }
    return $script:Manager
}

function Get-SessionInfo($s, [int]$propsMs) {
    $aumid = ''
    try { $aumid = [string]$s.SourceAppUserModelId } catch { }
    $status = 'unknown'
    $can = [ordered]@{ play = $false; pause = $false; toggle = $false; next = $false; previous = $false }
    try {
        $pb = $s.GetPlaybackInfo()
        if ($null -ne $pb) {
            $status = ([string]$pb.PlaybackStatus).ToLowerInvariant()
            $c = $pb.Controls
            if ($null -ne $c) {
                $can.play = [bool]$c.IsPlayEnabled
                $can.pause = [bool]$c.IsPauseEnabled
                $can.toggle = [bool]$c.IsPlayPauseToggleEnabled
                $can.next = [bool]$c.IsNextEnabled
                $can.previous = [bool]$c.IsPreviousEnabled
            }
        }
    } catch { }
    $posMs = 0; $durMs = 0
    try {
        $tl = $s.GetTimelineProperties()
        if ($null -ne $tl) {
            $posMs = [int64][math]::Round($tl.Position.TotalMilliseconds)
            $durMs = [int64][math]::Round($tl.EndTime.TotalMilliseconds)
        }
    } catch { }
    $title = ''; $artist = ''; $album = ''
    try {
        $props = Wait-WinRtOp ($s.TryGetMediaPropertiesAsync()) $script:T_Props $propsMs
        if ($null -ne $props) {
            $title = [string]$props.Title
            $artist = [string]$props.Artist
            $album = [string]$props.AlbumTitle
        }
    } catch { }   # timed out or failed: the session still appears, with empty strings
    return [ordered]@{
        aumid = $aumid; status = $status
        title = $title; artist = $artist; album = $album
        positionMs = $posMs; durationMs = $durMs
        can = $can
    }
}

function Invoke-State($id) {
    $mgr = Get-Manager
    $current = ''
    try {
        $cur = $mgr.GetCurrentSession()
        if ($null -ne $cur) { $current = [string]$cur.SourceAppUserModelId }
    } catch { }
    # Media properties get ~1200 ms per session, but the whole request shares a
    # 2500 ms budget so many slow sessions cannot outlast the caller's timeout.
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $list = New-Object System.Collections.ArrayList
    foreach ($s in $mgr.GetSessions()) {
        $left = 2500 - [int]$sw.ElapsedMilliseconds
        $wait = [math]::Max(100, [math]::Min(1200, $left))
        [void]$list.Add((Get-SessionInfo $s $wait))
    }
    return [ordered]@{ id = $id; ok = $true; current = $current; sessions = @($list.ToArray()) }
}

function Invoke-Control($id, $req) {
    $action = [string]$req.action
    $method = switch ($action) {
        'play' { 'TryPlayAsync' }
        'pause' { 'TryPauseAsync' }
        'toggle' { 'TryTogglePlayPauseAsync' }
        'next' { 'TrySkipNextAsync' }
        'previous' { 'TrySkipPreviousAsync' }
        default { $null }
    }
    if ($null -eq $method) { return [ordered]@{ id = $id; ok = $false; reason = 'bad action' } }
    $aumid = [string]$req.aumid
    if ($aumid -eq '') { return [ordered]@{ id = $id; ok = $false; reason = 'no session' } }
    $mgr = Get-Manager
    $target = $null
    foreach ($s in $mgr.GetSessions()) {
        $a = ''
        try { $a = [string]$s.SourceAppUserModelId } catch { }
        if ([string]::Equals($a, $aumid, [System.StringComparison]::OrdinalIgnoreCase)) { $target = $s; break }
    }
    if ($null -eq $target) { return [ordered]@{ id = $id; ok = $false; reason = 'no session' } }
    $sent = Wait-WinRtOp ($target.$method()) $script:T_Bool 2000
    return [ordered]@{ id = $id; ok = $true; sent = [bool]$sent }
}

function Invoke-Request([string]$line) {
    $id = $null
    try {
        $req = $null
        try { $req = ConvertFrom-Json -InputObject $line } catch { $req = $null }
        if ($null -eq $req -or $req -isnot [System.Management.Automation.PSCustomObject]) {
            return [ordered]@{ id = $null; ok = $false; reason = 'bad json' }
        }
        $id = $req.id
        switch ([string]$req.op) {
            'ping' { return [ordered]@{ id = $id; ok = $true } }
            'state' { return (Invoke-State $id) }
            'control' { return (Invoke-Control $id $req) }
            default { return [ordered]@{ id = $id; ok = $false; reason = 'unknown op' } }
        }
    } catch {
        return [ordered]@{ id = $id; ok = $false; reason = (Get-ShortError $_) }
    }
}

Initialize-WinRt

# Main loop: one request per line until stdin closes. Blank lines are skipped.
while ($true) {
    $line = $null
    try { $line = $script:In.ReadLine() } catch { break }
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }
    try {
        Send-Reply (Invoke-Request $line)
    } catch {
        # Last resort: the reply itself failed to serialise. Answer anyway.
        try { $script:Out.Write('{"id":null,"ok":false,"reason":"reply failed"}' + "`n"); $script:Out.Flush() } catch { break }
    }
}
exit 0
