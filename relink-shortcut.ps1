# relink-shortcut.ps1 - give Quartz its Start Menu shortcut, carrying its identity.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File relink-shortcut.ps1
#
# Writes %APPDATA%\Microsoft\Windows\Start Menu\Programs\Quartz.lnk:
#   target   <this folder>\node_modules\electron\dist\electron.exe
#   args     "<this folder>"
#   icon     <this folder>\assets\browser.ico,0 (electron.exe's own if it is missing)
#   System.AppUserModel.ID = com.owensilva.quartz
#
# WHY the id matters. main.js calls app.setAppUserModelId('com.owensilva.quartz').
# Windows shows a toast for an unpackaged app (the "Claude is waiting"
# notification) only when a Start Menu shortcut carries that same id, and groups
# a shortcut with its windows only when the ids match. The id lives in the
# shortcut's property store, which neither WScript.Shell nor the .lnk text can
# set, so this compiles a few lines of C# (IShellLinkW + IPropertyStore) with
# Add-Type -- csc ships with .NET Framework and runs hidden; no C++ compiler.
#
# If an old Start Menu\Programs\Browser.lnk is there, its target, arguments,
# working folder and icon are kept, it is saved again as Quartz.lnk, and the
# old file goes only after the new one reads back right (a rename that cannot
# leave you with neither). If it is not there (the case on 2026-09-26: only the
# taskbar pin existed), Quartz.lnk is built from this folder.
#
# What it does NOT touch: the taskbar pin in User Pinned\TaskBar\Browser.lnk.
# Mantle reads that folder and orders its bar by finding each pin's FILE NAME in
# the Taskband blob, so renaming the pin would drop it out of order. Re-pin from
# the new Start Menu entry by hand if the pin should say Quartz (Windows 11
# refuses scripted pinning). It never opens a window, Settings or Explorer,
# never resolves the link (Resolve can show UI), and is safe to re-run.

param()

$ErrorActionPreference = 'Stop'

$AppUserModelId = 'com.owensilva.quartz'   # main.js APP_USER_MODEL_ID, register-default-browser.ps1
$LinkName    = 'Quartz.lnk'
$OldLinkName = 'Browser.lnk'
$Description = 'Quartz'

$AppDir = $PSScriptRoot
$Exe    = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
$Ico    = Join-Path $AppDir 'assets\browser.ico'
$Programs = [Environment]::GetFolderPath('Programs')   # %APPDATA%\Microsoft\Windows\Start Menu\Programs
$NewLink = Join-Path $Programs $LinkName
$OldLink = Join-Path $Programs $OldLinkName

if (-not (Test-Path -LiteralPath $Exe)) { throw "electron.exe not found at $Exe - run npm install in $AppDir first." }
if (-not $Programs -or -not (Test-Path -LiteralPath $Programs)) { throw "Start Menu Programs folder not found ('$Programs')." }

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace QuartzLink {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  class CShellLink {}

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hwnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct PropertyKey { public Guid fmtid; public uint pid; }

  // PROPVARIANT: 16 bytes on x86, 24 on x64 -- vt + 3 reserved words, then a union.
  [StructLayout(LayoutKind.Sequential)]
  struct PropVariant { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  interface IPropertyStore {
    void GetCount(out uint cProps);
    void GetAt(uint iProp, out PropertyKey pkey);
    void GetValue(ref PropertyKey key, out PropVariant pv);
    void SetValue(ref PropertyKey key, ref PropVariant pv);
    void Commit();
  }

  public class LinkInfo {
    public string Target, Arguments, WorkingDirectory, IconPath, Description, AppUserModelId;
    public int IconIndex;
  }

  public static class Link {
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant pv);

    // PKEY_AppUserModel_ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5
    static PropertyKey AumidKey() {
      PropertyKey k; k.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); k.pid = 5; return k;
    }
    const ushort VT_LPWSTR = 31;

    public static LinkInfo Read(string path) {
      var link = (IShellLinkW)new CShellLink();
      try {
        ((IPersistFile)link).Load(path, 0);  // STGM_READ; no Resolve, so no UI
        var info = new LinkInfo();
        var sb = new StringBuilder(1024);
        link.GetPath(sb, sb.Capacity, IntPtr.Zero, 0x4 /* SLGP_RAWPATH */); info.Target = sb.ToString();
        sb.Clear(); link.GetArguments(sb, sb.Capacity); info.Arguments = sb.ToString();
        sb.Clear(); link.GetWorkingDirectory(sb, sb.Capacity); info.WorkingDirectory = sb.ToString();
        sb.Clear(); link.GetDescription(sb, sb.Capacity); info.Description = sb.ToString();
        int idx; sb.Clear(); link.GetIconLocation(sb, sb.Capacity, out idx); info.IconPath = sb.ToString(); info.IconIndex = idx;
        var store = (IPropertyStore)link;
        var key = AumidKey();
        PropVariant pv;
        store.GetValue(ref key, out pv);
        try { info.AppUserModelId = pv.vt == VT_LPWSTR ? Marshal.PtrToStringUni(pv.p) : ""; }
        finally { PropVariantClear(ref pv); }
        return info;
      } finally { Marshal.FinalReleaseComObject(link); }
    }

    public static void Write(string path, string target, string args, string workDir,
                             string iconPath, int iconIndex, string description, string aumid) {
      var link = (IShellLinkW)new CShellLink();
      try {
        link.SetPath(target);
        link.SetArguments(args);
        link.SetWorkingDirectory(workDir);
        link.SetIconLocation(iconPath, iconIndex);
        link.SetDescription(description);
        var store = (IPropertyStore)link;
        var key = AumidKey();
        var pv = new PropVariant();
        pv.vt = VT_LPWSTR;
        pv.p = Marshal.StringToCoTaskMemUni(aumid);
        try { store.SetValue(ref key, ref pv); } finally { PropVariantClear(ref pv); }
        store.Commit();
        ((IPersistFile)link).Save(path, true);
      } finally { Marshal.FinalReleaseComObject(link); }
    }
  }
}
'@

function Test-SameFile([string]$a, [string]$b) {
    if (-not $a -or -not $b) { return $false }
    return ([IO.Path]::GetFullPath($a)).TrimEnd('\') -ieq ([IO.Path]::GetFullPath($b)).TrimEnd('\')
}

# What the shortcut should be. Start from the old one when it is ours, so a
# hand-tuned argument or icon on it survives the rename.
$want = @{
    Target = $Exe
    Arguments = '"' + $AppDir + '"'
    WorkingDirectory = $AppDir
    IconPath = $(if (Test-Path -LiteralPath $Ico) { $Ico } else { $Exe })
    IconIndex = 0
}
$source = 'built from ' + $AppDir
$oldIsOurs = $false
if (Test-Path -LiteralPath $OldLink) {
    $old = [QuartzLink.Link]::Read($OldLink)
    "found    $OldLink"
    "  target=$($old.Target)  args=$($old.Arguments)  icon=$($old.IconPath),$($old.IconIndex)  aumid=$($old.AppUserModelId)"
    if (Test-SameFile $old.Target $Exe) {
        $oldIsOurs = $true
        $want.Arguments = $old.Arguments
        if ($old.WorkingDirectory) { $want.WorkingDirectory = $old.WorkingDirectory }
        if ($old.IconPath) { $want.IconPath = $old.IconPath; $want.IconIndex = $old.IconIndex }
        $source = "kept from $OldLinkName"
    } else {
        "  it points somewhere else ($($old.Target)); left alone, Quartz.lnk is built from this folder."
    }
}

"writing  $NewLink ($source)"
[QuartzLink.Link]::Write($NewLink, $want.Target, $want.Arguments, $want.WorkingDirectory,
    $want.IconPath, $want.IconIndex, $Description, $AppUserModelId)

# Read it back from disk: a shortcut that did not land must not be reported.
$got = [QuartzLink.Link]::Read($NewLink)
$bad = @()
if (-not (Test-SameFile $got.Target $want.Target)) { $bad += "target '$($got.Target)'" }
if ($got.Arguments -ne $want.Arguments) { $bad += "args '$($got.Arguments)'" }
if ($got.AppUserModelId -ne $AppUserModelId) { $bad += "aumid '$($got.AppUserModelId)'" }
if (-not (Test-SameFile $got.IconPath $want.IconPath)) { $bad += "icon '$($got.IconPath)'" }
"  target=$($got.Target)"
"  args=$($got.Arguments)  wd=$($got.WorkingDirectory)"
"  icon=$($got.IconPath),$($got.IconIndex)"
"  System.AppUserModel.ID=$($got.AppUserModelId)"
if ($bad.Count -gt 0) {
    "Quartz.lnk did NOT read back right: $($bad -join ', '). $OldLinkName (if any) was left in place."
    exit 1
}

# Only now, with the new one proven, does the old Start Menu entry go -- and
# only if it was ours (same electron.exe), never someone else's Browser.lnk.
if ($oldIsOurs) {
    Remove-Item -LiteralPath $OldLink -Force
    "removed  $OldLink"
}

''
"Done. Start Menu > Quartz now carries $AppUserModelId."
'Taskbar pin (User Pinned\TaskBar\Browser.lnk) left as is; see the header for why.'
