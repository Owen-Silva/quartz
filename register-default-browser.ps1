# register-default-browser.ps1 - tell Windows Quartz exists, so it can be
# picked in Settings > Apps > Default apps.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File register-default-browser.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File register-default-browser.ps1 -RemoveOld
#   powershell -NoProfile -ExecutionPolicy Bypass -File register-default-browser.ps1 -Unregister
#
# What it writes (HKCU only - no admin, nothing machine-wide):
#   Software\Clients\StartMenuInternet\Quartz   the "this is a browser" entry
#   Software\Classes\QuartzURL                  the http/https handler
#   Software\Classes\QuartzHTML                 the .htm/.html handler
#   Software\RegisteredApplications             the pointer Settings reads
#
# Until 2026-09-26 the same entries were named OwenBrowser / OwenBrowserURL /
# OwenBrowserHTML. Registering Quartz leaves those alone, so a link keeps
# opening while Windows still points at an old ProgId. -RemoveOld deletes the
# old four, and only once no http/https/.htm/.html choice still names them
# (it reads those first and refuses by name; -Force overrides).
#
# What it does NOT do, ever: make itself the default, open Settings, or show a
# window. Windows 11 protects the UserChoice hash, and every tool that forges
# it is malware-shaped. This only puts "Quartz" in the list; the last step is
# the user pressing Set default in Settings > Apps > Default apps > Quartz.
#
# Re-running it is safe: every value is written to the same place with the same
# contents. -Unregister removes the Quartz four, leaving the profile alone.
#
# The command it registers starts Quartz.exe, not electron.exe (2026-10-10): the
# same binary renamed and stamped "Quartz" by tools/make-quartz-exe.js (npm
# postinstall), so a clicked link opens a process Task Manager calls Quartz.
# Run `npm run quartz-exe` first if Quartz.exe is missing.

param([switch]$Unregister, [switch]$RemoveOld, [switch]$Force)

$ErrorActionPreference = 'Stop'

# Everything is resolved from where this script sits, so a moved repo needs no
# edit - only a re-run.
$AppDir = $PSScriptRoot
$Exe    = Join-Path $AppDir 'node_modules\electron\dist\Quartz.exe'
$IcoRepo = Join-Path $AppDir 'assets\browser.ico'

$ProgIdUrl  = 'QuartzURL'
$ProgIdHtml = 'QuartzHTML'
$AppKeyName = 'Quartz'
$AppName    = 'Quartz'
# main.js APP_USER_MODEL_ID and relink-shortcut.ps1 carry the same string.
$AppUserModelId = 'com.owensilva.quartz'

# What this app registered as before the id changed. -RemoveOld only.
$OldProgIdUrl  = 'OwenBrowserURL'
$OldProgIdHtml = 'OwenBrowserHTML'
$OldAppKeyName = 'OwenBrowser'
$AppDesc    = "Quartz - a browser with tabs, workspaces, terminal and Claude in one window."

$ClientKey = "HKCU:\Software\Clients\StartMenuInternet\$AppKeyName"
$CapKey    = "$ClientKey\Capabilities"
$UrlKey    = "HKCU:\Software\Classes\$ProgIdUrl"
$HtmlKey   = "HKCU:\Software\Classes\$ProgIdHtml"
$RegAppKey = 'HKCU:\Software\RegisteredApplications'
# Every place Windows keeps "open this with ProgId X" for what we register.
# Each is the PARENT of the choice. Current Windows 11 builds keep TWO records
# that can disagree: the legacy UserChoice key and UserChoiceLatest\ProgId.
# Seen 2026-10-14: https said MSEdgeHTM in UserChoice and OwenBrowserURL in
# UserChoiceLatest, and Windows itself resolved https to Edge; .html said AceHTM
# vs OwenBrowserHTML and resolved to the OwenBrowserHTML command. So neither
# record alone is "the default": both are read, and what Windows will actually
# run is asked of Windows (AssocQueryString) - all read-only.
$ChoiceKeys = [ordered]@{
    'https' = 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https'
    'http'  = 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http'
    '.html' = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.html'
    '.htm'  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.htm'
}

function Get-RegValue([string]$Key, [string]$Name) {
    if (-not (Test-Path $Key)) { return $null }
    try { return (Get-Item -LiteralPath $Key).GetValue($Name, $null) } catch { return $null }
}

# Every ProgId either record names for $kind (read-only - never written here).
function Get-RecordedChoices([string]$kind) {
    $base = $ChoiceKeys[$kind]
    $ids = @()
    foreach ($v in @((Get-RegValue "$base\UserChoiceLatest\ProgId" 'ProgId'), (Get-RegValue "$base\UserChoice" 'ProgId'))) {
        if ($v -and ($ids -notcontains $v)) { $ids += $v }
    }
    return ,$ids
}

# The command line Windows resolves for $kind right now - the real answer.
function Get-ResolvedCommand([string]$kind) {
    try {
        if (-not ('QuartzReg.Assoc' -as [type])) {
            Add-Type -Namespace QuartzReg -Name Assoc -MemberDefinition '[DllImport("Shlwapi.dll", CharSet = CharSet.Unicode)] public static extern uint AssocQueryString(int flags, int str, string assoc, string extra, [Out] System.Text.StringBuilder outBuf, ref uint outLen);'
        }
        $sb = New-Object System.Text.StringBuilder 2048
        [uint32]$n = 2048
        # str 1 = ASSOCSTR_COMMAND
        if ([QuartzReg.Assoc]::AssocQueryString(0, 1, $kind, 'open', $sb, [ref]$n) -ne 0) { return '<none>' }
        return $sb.ToString()
    } catch { return "<could not ask Windows: $($_.Exception.Message)>" }
}

function Show-CurrentDefault {
    foreach ($kind in $ChoiceKeys.Keys) {
        $ids = Get-RecordedChoices $kind
        if ($ids.Count -gt 0) { $rec = $ids -join ' / ' } else { $rec = '<none set>' }
        "current $kind default (read-only): recorded $rec; Windows runs $(Get-ResolvedCommand $kind)"
    }
}

# ---------------------------------------------------------------------------
# -RemoveOld: delete the pre-Quartz OwenBrowser* entries
# ---------------------------------------------------------------------------
if ($RemoveOld) {
    # Deleting a ProgId Windows still uses as a default would leave that link
    # or file type with nothing to open it, and Windows says nothing until the
    # next click asks "how do you want to open this?". So check first, and
    # refuse by name unless told otherwise.
    $oldKeys = @(
        "HKCU:\Software\Clients\StartMenuInternet\$OldAppKeyName",
        "HKCU:\Software\Classes\$OldProgIdUrl",
        "HKCU:\Software\Classes\$OldProgIdHtml"
    )
    $stillOld = @()
    foreach ($kind in $ChoiceKeys.Keys) {
        # Either record naming an old ProgId counts: Windows can switch to the
        # other one, and deleting under it would leave the type with no handler.
        $ids = Get-RecordedChoices $kind
        if ($ids.Count -gt 0) { "current $kind default (read-only): $($ids -join ' / ')" } else { "current $kind default (read-only): <none set>" }
        foreach ($progId in $ids) {
            if ($progId -eq $OldProgIdUrl -or $progId -eq $OldProgIdHtml) { $stillOld += "$kind -> $progId" }
        }
    }
    if ($stillOld.Count -gt 0 -and -not $Force) {
        ''
        "NOT removed: Windows still opens $($stillOld -join ', ') with the old entries."
        'Pick Quartz first (Settings > Apps > Default apps > Quartz > Set default), then run -RemoveOld again.'
        '(-Force removes them anyway; those links and files would then ask which app to use.)'
        exit 1
    }
    ''
    foreach ($k in $oldKeys) {
        if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse -Force; "removed  $k" }
        else { "absent   $k" }
    }
    if ((Get-RegValue $RegAppKey $OldAppKeyName) -ne $null) {
        Remove-ItemProperty -LiteralPath $RegAppKey -Name $OldAppKeyName -Force
        "removed  $RegAppKey\$OldAppKeyName"
    } else {
        "absent   $RegAppKey\$OldAppKeyName"
    }
    # Read back: a delete that did not land is not a success either.
    $left = @($oldKeys | Where-Object { Test-Path -LiteralPath $_ })
    if ((Get-RegValue $RegAppKey $OldAppKeyName) -ne $null) { $left += "$RegAppKey\$OldAppKeyName" }
    ''
    if ($left.Count -eq 0) {
        'Old OwenBrowser entries removed. Windows drops their row from Default apps on its next read.'
    } else {
        "Still present after removal: $($left -join ', ') - NOT removed cleanly."
        exit 1
    }
    return
}

# ---------------------------------------------------------------------------
# -Unregister
# ---------------------------------------------------------------------------
if ($Unregister) {
    foreach ($k in @($ClientKey, $UrlKey, $HtmlKey)) {
        if (Test-Path $k) { Remove-Item -LiteralPath $k -Recurse -Force; "removed  $k" }
        else { "absent   $k" }
    }
    if ((Get-RegValue $RegAppKey $AppKeyName) -ne $null) {
        Remove-ItemProperty -LiteralPath $RegAppKey -Name $AppKeyName -Force
        "removed  $RegAppKey\$AppKeyName"
    } else {
        "absent   $RegAppKey\$AppKeyName"
    }
    ''
    Show-CurrentDefault
    'Unregistered. Windows drops the entry from Default apps on its next read.'
    return
}

# ---------------------------------------------------------------------------
# Register
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $Exe)) {
    throw "Quartz.exe not found at $Exe - run 'npm run quartz-exe' (or npm install) in $AppDir first."
}

# The repo's own .ico if it is there, Quartz.exe's own icon if it is not.
# Converting an image into one is not this script's job.
if (Test-Path -LiteralPath $IcoRepo) { $IconPath = "$IcoRepo,0" } else { $IconPath = "$Exe,0" }

# Quoted, always: both paths contain no spaces today, but "C:\Program Files"
# is one move away and an unquoted command line breaks silently there.
$CmdPlain = '"' + $Exe + '" "' + $AppDir + '"'
$CmdUrl   = '"' + $Exe + '" "' + $AppDir + '" "%1"'

function New-RegKey([string]$Key) {
    if (-not (Test-Path -LiteralPath $Key)) { New-Item -Path $Key -Force | Out-Null }
}

# Name '' is the key's default value.
function Set-RegValue([string]$Key, [string]$Name, [string]$Value) {
    New-RegKey $Key
    if ($Name -eq '') {
        Set-ItemProperty -LiteralPath $Key -Name '(Default)' -Value $Value -Force
        "  $Key\(Default) = $Value"
    } else {
        Set-ItemProperty -LiteralPath $Key -Name $Name -Value $Value -Force
        "  $Key\$Name = $Value"
    }
}

"Quartz.exe   : $Exe"
"app dir      : $AppDir"
"icon         : $IconPath"
''
'writing:'

# 1. The StartMenuInternet client entry - this is what makes Windows file the
#    app under "Web browser" rather than as a stray URL handler.
Set-RegValue $ClientKey '' $AppName
Set-RegValue "$ClientKey\DefaultIcon" '' $IconPath
Set-RegValue "$ClientKey\shell\open\command" '' $CmdPlain

# 2. Capabilities - the block Settings actually reads for the Default apps page.
Set-RegValue $CapKey 'ApplicationName' $AppName
Set-RegValue $CapKey 'ApplicationDescription' $AppDesc
Set-RegValue $CapKey 'ApplicationIcon' $IconPath
Set-RegValue "$CapKey\URLAssociations" 'http' $ProgIdUrl
Set-RegValue "$CapKey\URLAssociations" 'https' $ProgIdUrl
Set-RegValue "$CapKey\FileAssociations" '.htm' $ProgIdHtml
Set-RegValue "$CapKey\FileAssociations" '.html' $ProgIdHtml
Set-RegValue "$CapKey\StartMenu" 'StartMenuInternet' $AppKeyName

# 3. The two ProgIds the associations point at. "%1" is the URL or the file
#    path Windows substitutes; main.js's urlFromArgv() reads it off argv.
Set-RegValue $UrlKey '' 'Quartz URL'
Set-RegValue $UrlKey 'URL Protocol' ''
Set-RegValue "$UrlKey\DefaultIcon" '' $IconPath
Set-RegValue "$UrlKey\shell\open\command" '' $CmdUrl

Set-RegValue $HtmlKey '' 'Quartz HTML Document'
Set-RegValue "$HtmlKey\DefaultIcon" '' $IconPath
Set-RegValue "$HtmlKey\shell\open\command" '' $CmdUrl

# The name, icon and identity Windows shows for a ProgId in "Open with" and on
# the Default apps page (the same Application subkey Chrome and Edge write).
# AppUserModelId ties the handler to the identity the running app carries.
foreach ($k in @($UrlKey, $HtmlKey)) {
    Set-RegValue "$k\Application" 'ApplicationName' $AppName
    Set-RegValue "$k\Application" 'ApplicationIcon' $IconPath
    Set-RegValue "$k\Application" 'AppUserModelId' $AppUserModelId
}

# 4. The pointer. Without this line the Capabilities block above is never read.
Set-RegValue $RegAppKey $AppKeyName "Software\Clients\StartMenuInternet\$AppKeyName\Capabilities"

# 5. The pre-Quartz OwenBrowser* entries, while they still exist. Windows may
#    still open every link and .html with them (it did on 2026-10-14, via
#    UserChoiceLatest), and they started electron.exe as a row called "Browser".
#    Repoint them at the same Quartz.exe command so a click lands in Quartz
#    today, and rename them so the leftover row is recognisable. Only keys that
#    already exist are touched - this never creates an old entry - and
#    -RemoveOld deletes them once the user has picked the new "Quartz" row.
$OldName = 'Quartz (old entry)'
$OldClientKey = "HKCU:\Software\Clients\StartMenuInternet\$OldAppKeyName"
$OldUrlKey    = "HKCU:\Software\Classes\$OldProgIdUrl"
$OldHtmlKey   = "HKCU:\Software\Classes\$OldProgIdHtml"
$legacyChecks = @()
if (Test-Path -LiteralPath $OldClientKey) {
    ''
    'repointing the old OwenBrowser entries at Quartz.exe:'
    Set-RegValue $OldClientKey '' $OldName
    Set-RegValue "$OldClientKey\shell\open\command" '' $CmdPlain
    $legacyChecks += @{ Key = $OldClientKey; Name = ''; Want = $OldName }
    $legacyChecks += @{ Key = "$OldClientKey\shell\open\command"; Name = ''; Want = $CmdPlain }
    if (Test-Path -LiteralPath "$OldClientKey\Capabilities") {
        Set-RegValue "$OldClientKey\Capabilities" 'ApplicationName' $OldName
        $legacyChecks += @{ Key = "$OldClientKey\Capabilities"; Name = 'ApplicationName'; Want = $OldName }
    }
}
foreach ($pair in @(@($OldUrlKey, 'Quartz URL (old entry)'), @($OldHtmlKey, 'Quartz HTML Document (old entry)'))) {
    $k = $pair[0]
    if (-not (Test-Path -LiteralPath $k)) { continue }
    Set-RegValue $k '' $pair[1]
    Set-RegValue $k 'FriendlyTypeName' $OldName
    Set-RegValue "$k\shell\open" 'FriendlyAppName' $OldName
    Set-RegValue "$k\shell\open\command" '' $CmdUrl
    $legacyChecks += @{ Key = $k; Name = ''; Want = $pair[1] }
    $legacyChecks += @{ Key = $k; Name = 'FriendlyTypeName'; Want = $OldName }
    $legacyChecks += @{ Key = "$k\shell\open"; Name = 'FriendlyAppName'; Want = $OldName }
    $legacyChecks += @{ Key = "$k\shell\open\command"; Name = ''; Want = $CmdUrl }
}

# ---------------------------------------------------------------------------
# Read it all back - a write that did not land must not be reported as success.
# ---------------------------------------------------------------------------
''
'verifying (read back from the registry):'
$checks = @(
    @{ Key = $ClientKey;                    Name = '';                       Want = $AppName },
    @{ Key = "$ClientKey\DefaultIcon";      Name = '';                       Want = $IconPath },
    @{ Key = "$ClientKey\shell\open\command"; Name = '';                     Want = $CmdPlain },
    @{ Key = $CapKey;                       Name = 'ApplicationName';        Want = $AppName },
    @{ Key = $CapKey;                       Name = 'ApplicationDescription'; Want = $AppDesc },
    @{ Key = $CapKey;                       Name = 'ApplicationIcon';        Want = $IconPath },
    @{ Key = "$CapKey\URLAssociations";     Name = 'http';                   Want = $ProgIdUrl },
    @{ Key = "$CapKey\URLAssociations";     Name = 'https';                  Want = $ProgIdUrl },
    @{ Key = "$CapKey\FileAssociations";    Name = '.htm';                   Want = $ProgIdHtml },
    @{ Key = "$CapKey\FileAssociations";    Name = '.html';                  Want = $ProgIdHtml },
    @{ Key = "$CapKey\StartMenu";           Name = 'StartMenuInternet';      Want = $AppKeyName },
    @{ Key = $UrlKey;                       Name = '';                       Want = 'Quartz URL' },
    @{ Key = $UrlKey;                       Name = 'URL Protocol';           Want = '' },
    @{ Key = "$UrlKey\DefaultIcon";         Name = '';                       Want = $IconPath },
    @{ Key = "$UrlKey\shell\open\command";  Name = '';                       Want = $CmdUrl },
    @{ Key = $HtmlKey;                      Name = '';                       Want = 'Quartz HTML Document' },
    @{ Key = "$HtmlKey\DefaultIcon";        Name = '';                       Want = $IconPath },
    @{ Key = "$HtmlKey\shell\open\command"; Name = '';                       Want = $CmdUrl },
    @{ Key = $RegAppKey;                    Name = $AppKeyName;              Want = "Software\Clients\StartMenuInternet\$AppKeyName\Capabilities" }
)
foreach ($k in @($UrlKey, $HtmlKey)) {
    $checks += @{ Key = "$k\Application"; Name = 'ApplicationName'; Want = $AppName }
    $checks += @{ Key = "$k\Application"; Name = 'ApplicationIcon'; Want = $IconPath }
    $checks += @{ Key = "$k\Application"; Name = 'AppUserModelId';  Want = $AppUserModelId }
}
$checks += $legacyChecks

$bad = 0
foreach ($c in $checks) {
    $got = Get-RegValue $c.Key $c.Name
    if ($got -eq $null) { $got = '' }
    $label = $c.Key
    if ($c.Name -eq '') { $label = "$label\(Default)" } else { $label = "$label\$($c.Name)" }
    if ($got -eq $c.Want) {
        "  OK   $label = $got"
    } else {
        $bad = $bad + 1
        "  BAD  $label = '$got' (wanted '$($c.Want)')"
    }
}

''
Show-CurrentDefault
''
if ($bad -eq 0) {
    'Registered. Last step is yours: Settings > Apps > Default apps > Quartz > Set default.'
    '(Windows 11 will not let an app set that for itself, and this script does not try.)'
    if ((Test-Path -LiteralPath "HKCU:\Software\Clients\StartMenuInternet\$OldAppKeyName") -or
        (Test-Path -LiteralPath "HKCU:\Software\Classes\$OldProgIdUrl")) {
        'The old OwenBrowser entries are still registered too (a second row in Default apps,'
        'now called "Quartz (old entry)" and also starting Quartz.exe);'
        'run this again with -RemoveOld once the new "Quartz" row is picked.'
    }
} else {
    "$bad value(s) did not read back - NOT registered cleanly."
    exit 1
}
