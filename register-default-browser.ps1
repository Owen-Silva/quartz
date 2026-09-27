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
# The user pressing Set default in Settings > Apps > Default apps > Quartz.
#
# Re-running it is safe: every value is written to the same place with the same
# contents. -Unregister removes the Quartz four, leaving the profile alone.

param([switch]$Unregister, [switch]$RemoveOld, [switch]$Force)

$ErrorActionPreference = 'Stop'

# Everything is resolved from where this script sits, so a moved repo needs no
# edit - only a re-run.
$AppDir = $PSScriptRoot
$Exe    = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
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
$AppDesc    = "the user's browser - tabs, workspaces, terminal and Claude in one window."

$ClientKey = "HKCU:\Software\Clients\StartMenuInternet\$AppKeyName"
$CapKey    = "$ClientKey\Capabilities"
$UrlKey    = "HKCU:\Software\Classes\$ProgIdUrl"
$HtmlKey   = "HKCU:\Software\Classes\$ProgIdHtml"
$RegAppKey = 'HKCU:\Software\RegisteredApplications'
$UserChoiceKey = 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice'

# Every place Windows keeps "open this with ProgId X" for what we register.
$ChoiceKeys = [ordered]@{
    'https' = 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice'
    'http'  = 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice'
    '.html' = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.html\UserChoice'
    '.htm'  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.htm\UserChoice'
}

function Get-RegValue([string]$Key, [string]$Name) {
    if (-not (Test-Path $Key)) { return $null }
    try { return (Get-Item -LiteralPath $Key).GetValue($Name, $null) } catch { return $null }
}

function Show-CurrentDefault {
    $progId = Get-RegValue $UserChoiceKey 'ProgId'
    if ($progId) { "current https default (read-only): $progId" }
    else { 'current https default (read-only): <none set>' }
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
        $progId = Get-RegValue $ChoiceKeys[$kind] 'ProgId'
        if ($progId) { "current $kind default (read-only): $progId" } else { "current $kind default (read-only): <none set>" }
        if ($progId -eq $OldProgIdUrl -or $progId -eq $OldProgIdHtml) { $stillOld += "$kind -> $progId" }
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
    throw "electron.exe not found at $Exe - run npm install in $AppDir first."
}

# The repo's own .ico if it is there, electron.exe's own icon if it is not.
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

"electron.exe : $Exe"
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
        'The old OwenBrowser entries are still registered too (a second row in Default apps);'
        'run this again with -RemoveOld once Quartz is picked.'
    }
} else {
    "$bad value(s) did not read back - NOT registered cleanly."
    exit 1
}
