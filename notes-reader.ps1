# notes-reader.ps1 — the notes pane's fallback reader (see notes-pane-main.js).
#
# It reads the visible text of ONE desktop app ("the reader app": the program
# the question on screen lives in), so the notes pane can find the matching
# topic in the notes. Which app is never decided here: the caller names it
# in every command ("process", from reader.exe in notes-pane.json), and a
# command with no process is refused with a reason rather than guessed at.
#
# A PERSISTENT child process: notes-pane-main.js spawns it once and then talks to it in
# JSON lines over stdin/stdout, because paying PowerShell's ~700 ms startup on
# every three-second poll would be absurd.
#
#   in  : {"id":7,"cmd":"read","process":"ReaderApp"}
#   out : {"id":7,"ok":true,"cmd":"read","title":"...","text":"...","chars":812,"via":"uia-text-pattern"}
#   out : {"id":7,"ok":false,"cmd":"read","reason":"ReaderApp has no visible top-level window"}
#   out : {"id":8,"ok":false,"cmd":"read","reason":"no reader app configured (reader.exe in notes-pane.json)"}
#
# Commands
#   ping  — is the reader alive (used after a restart)
#   read  — walk the window's UI Automation tree and return its visible text
#   ocr   — PrintWindow-capture the window and run Windows.Media.Ocr over it
#   quit  — exit cleanly
#
# It NEVER activates, raises, resizes or focuses anything: FromHandle() and
# PrintWindow both read a window where it sits, even fully covered. That is a
# hard rule — the user is at the machine while this runs.
#
# What a read costs, and why most reads cost almost nothing (2026-10-16)
#   A full "read" is Get-Process + a UI Automation walk of the window (up to
#   4000 nodes, each a cross-process call into the reader app's WebView2) + JSON,
#   every 3 s while the reader app is open: ~2-3% of the whole CPU on battery (measured 10-15).
#   Now a read only walks when something can have changed since the last walk;
#   otherwise it answers from that walk ("cached": true), after checking the
#   window still exists (a few Win32 calls). What "changed" means depends on
#   what the last walk found ("watch" in a walked answer):
#     doc    - the page is a Document with a TextPattern (Chromium's own UIA):
#              ask for just its text (one call) and compare with the last walk.
#     events - no TextPattern, so only the names walk can read it: subscribe to
#              the window's UIA change events (structure, Name/Value, text) and
#              walk when one fired. Not used in doc mode: a managed UIA event
#              subscription costs a steady ~0.5% of a core by itself.
#   Guards: a full walk at least every MaxAgeMs (24 s) regardless; in events
#   mode, if that walk finds different text and no event fired, the events are
#   not trustworthy: the gate turns off ("gate" says why) and every read walks,
#   as before, until the reader restarts (notes-pane-main.js restarts it each time
#   the reader app opens). {"force":true} always walks (the pane's "probe").
#   "ocr" hashes the captured pixels and only runs the OCR engine when they
#   differ from the last capture it recognised.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:TextCap  = 4096
$script:MaxNodes = 4000
$script:WalkSeconds = 6
$script:MaxAgeMs = 24000      # a full walk at least this often, events or not
$script:TestHooks = ($env:NOTES_READER_TEST -eq '1')

# ---------------------------------------------------------------- assemblies

$script:LoadError = ''
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
} catch {
  $script:LoadError = "could not load the automation assemblies: $($_.Exception.Message)"
}

if (-not ('NotesWin32' -as [type])) {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class NotesWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int n);
  public static uint PidOf(IntPtr hWnd) { uint p; GetWindowThreadProcessId(hWnd, out p); return p; }
  public static string TitleOf(IntPtr hWnd) {
    int n = GetWindowTextLength(hWnd);
    if (n <= 0) return "";
    System.Text.StringBuilder s = new System.Text.StringBuilder(n + 1);
    GetWindowText(hWnd, s, n + 1);
    return s.ToString();
  }
}
'@
  } catch {
    $script:LoadError = "could not compile the Win32 shims: $($_.Exception.Message)"
  }
}

$script:GateOff = ''   # non-empty: the change gate is off, and this says why

# The change gate. UIA delivers events on its own thread; the handlers only
# bump a counter (no PowerShell runs there), and the JSON loop compares it.
if ($script:LoadError -eq '' -and -not ('NotesWatch' -as [type])) {
  try {
    $refs = @(
      [System.Windows.Automation.AutomationElement].Assembly.Location,
      [System.Windows.Automation.TreeScope].Assembly.Location,
      [System.Drawing.Bitmap].Assembly.Location
    )
    Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Threading;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public static class NotesWatch {
  static long _events;
  static AutomationElement _root;
  static StructureChangedEventHandler _sc;
  static AutomationPropertyChangedEventHandler _pc;
  static AutomationEventHandler _tc;
  public static long Events { get { return Interlocked.Read(ref _events); } }
  public static bool Attached { get { return _root != null; } }
  static void Bump() { Interlocked.Increment(ref _events); }
  static long _nS, _nP, _nT;
  public static string Kinds { get { return "structure " + Interlocked.Read(ref _nS) + ", name/value " + Interlocked.Read(ref _nP) + ", text " + Interlocked.Read(ref _nT); } }
  public static string Attach(AutomationElement root) {
    Detach();
    try {
      _sc = delegate(object s, StructureChangedEventArgs e) { Interlocked.Increment(ref _nS); Bump(); };
      _pc = delegate(object s, AutomationPropertyChangedEventArgs e) { Interlocked.Increment(ref _nP); Bump(); };
      _tc = delegate(object s, AutomationEventArgs e) { Interlocked.Increment(ref _nT); Bump(); };
      Automation.AddStructureChangedEventHandler(root, TreeScope.Subtree, _sc);
      Automation.AddAutomationPropertyChangedEventHandler(root, TreeScope.Subtree, _pc,
        AutomationElement.NameProperty, ValuePattern.ValueProperty);
      Automation.AddAutomationEventHandler(TextPattern.TextChangedEvent, root, TreeScope.Subtree, _tc);
      _root = root;
      return "";
    } catch (Exception ex) {
      Detach();
      return ex.Message;
    }
  }
  static void Unhook() {
    if (_sc == null && _pc == null && _tc == null) return;
    try { Automation.RemoveAllEventHandlers(); } catch { }
    _sc = null; _pc = null; _tc = null;
  }
  public static void Detach() { Unhook(); _root = null; }
  // Test hook: a provider that never raises events. The gate still believes it
  // is attached, so only the max-age walk can notice a change.
  public static void MuteForTest() { Unhook(); }
  // FNV-1a over every pixel: the OCR gate (same pixels => same OCR text).
  public static string HashBitmap(Bitmap bmp) {
    Rectangle r = new Rectangle(0, 0, bmp.Width, bmp.Height);
    BitmapData d = bmp.LockBits(r, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      int stride = Math.Abs(d.Stride);
      byte[] row = new byte[stride];
      ulong h = 14695981039346656037UL;
      for (int y = 0; y < bmp.Height; y++) {
        Marshal.Copy(new IntPtr(d.Scan0.ToInt64() + (long)y * d.Stride), row, 0, stride);
        for (int i = 0; i < stride; i++) { h ^= row[i]; h *= 1099511628211UL; }
      }
      return bmp.Width + "x" + bmp.Height + ":" + h.ToString("x16");
    } finally { bmp.UnlockBits(d); }
  }
}
'@
  } catch {
    # Not fatal: without the gate every read walks, as it always did.
    $script:GateOff = "could not compile the change gate: $($_.Exception.Message)"
  }
}

# WinRT awaiters. PowerShell 5.1 cannot await an IAsyncOperation directly, so we
# reflect out the generic AsTask() and block on the Task it hands back.
$script:AsTaskGeneric = $null
try {
  $script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
} catch { }

function Await-WinRt($operation, $resultType) {
  if ($null -eq $script:AsTaskGeneric) { throw 'WinRT await is unavailable on this PowerShell' }
  $asTask = $script:AsTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  [void]$task.Wait(20000)
  if ($task.IsFaulted) { throw $task.Exception.GetBaseException() }
  $task.Result
}

# ------------------------------------------------------------------ windows

function Get-TargetWindow([string]$procName) {
  $name = $procName -replace '\.exe$', ''
  $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
  if ($procs.Count -eq 0) { return $null }
  # Prefer the biggest visible window: helper/tooltip windows are tiny.
  $best = $null
  $bestArea = -1
  foreach ($p in $procs) {
    $r = New-Object NotesWin32+RECT
    if (-not [NotesWin32]::GetWindowRect($p.MainWindowHandle, [ref]$r)) { continue }
    if (-not [NotesWin32]::IsWindowVisible($p.MainWindowHandle)) { continue }
    $area = [Math]::Max(0, $r.Right - $r.Left) * [Math]::Max(0, $r.Bottom - $r.Top)
    if ($area -gt $bestArea) { $bestArea = $area; $best = $p }
  }
  if ($null -eq $best) { return $null }
  [pscustomobject]@{ Handle = $best.MainWindowHandle; Title = $best.MainWindowTitle; Pid = $best.Id }
}

# ------------------------------------------------------- UI Automation read

function Add-Line($sb, [string]$text, $seen) {
  if ([string]::IsNullOrWhiteSpace($text)) { return }
  $clean = ($text -replace '\s+', ' ').Trim()
  if ($clean.Length -eq 0) { return }
  if ($seen.Contains($clean)) { return }
  [void]$seen.Add($clean)
  if ($sb.Length -gt 0) { [void]$sb.Append("`n") }
  [void]$sb.Append($clean)
}

function Walk-Element($el, [int]$depth, $sb, $ctx) {
  if ($sb.Length -ge $script:TextCap) { return }
  if ($ctx.Nodes -ge $script:MaxNodes) { return }
  if ([DateTime]::UtcNow -gt $ctx.Deadline) { return }
  $ctx.Nodes++

  $name = ''
  $type = $null
  try { $name = $el.Cached.Name; $type = $el.Cached.ControlType } catch { return }

  # A Document node is a whole web page: TextPattern gives it to us in one hop,
  # in reading order, instead of thousands of Name properties.
  if ($null -ne $type -and $type.ProgrammaticName -like '*.Document') {
    $pattern = $null
    try {
      if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
        $doc = $pattern.DocumentRange.GetText($script:TextCap)
        if (-not [string]::IsNullOrWhiteSpace($doc)) {
          $ctx.Via = 'uia-text-pattern'
          $ctx.DocCount++
          if ($null -eq $ctx.Doc) { $ctx.Doc = $pattern; $ctx.DocText = $doc }
          foreach ($line in ($doc -split "`r?`n")) { Add-Line $sb $line $ctx.Seen }
          return
        }
      }
    } catch { }
  }

  if ($null -ne $type) {
    $short = $type.ProgrammaticName -replace '^ControlType\.', ''
    if ('Text','Edit','Button','Hyperlink','CheckBox','RadioButton','ListItem','ComboBox','Image','Header' -contains $short) {
      Add-Line $sb $name $ctx.Seen
    }
  }

  if ($depth -ge 40) { return }
  $child = $null
  try { $child = $ctx.Walker.GetFirstChild($el, $ctx.Cache) } catch { return }
  while ($null -ne $child) {
    Walk-Element $child ($depth + 1) $sb $ctx
    if ($sb.Length -ge $script:TextCap -or $ctx.Nodes -ge $script:MaxNodes -or [DateTime]::UtcNow -gt $ctx.Deadline) { return }
    try { $child = $ctx.Walker.GetNextSibling($child, $ctx.Cache) } catch { return }
  }
}

# Name and ControlType ride along with each navigation call (a CacheRequest),
# so a node costs one cross-process call instead of three.
$script:WalkCache = $null
function Get-WalkCache {
  if ($null -eq $script:WalkCache) {
    $cr = New-Object System.Windows.Automation.CacheRequest
    $cr.Add([System.Windows.Automation.AutomationElement]::NameProperty)
    $cr.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
    $script:WalkCache = $cr
  }
  $script:WalkCache
}

function Read-WindowText($root) {
  if ($null -eq $root) { return [pscustomobject]@{ Text = ''; Via = 'uia'; Nodes = 0 } }
  $cr = Get-WalkCache
  $sb = New-Object System.Text.StringBuilder
  $ctx = [pscustomobject]@{
    Walker   = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    Cache    = $cr
    Seen     = New-Object 'System.Collections.Generic.HashSet[string]'
    Nodes    = 0
    Deadline = [DateTime]::UtcNow.AddSeconds($script:WalkSeconds)
    Via      = 'uia-names'
    Doc      = $null    # the first Document's TextPattern: the next reads' probe
    DocText  = ''
    DocCount = 0
  }
  $start = $null
  try { $start = $root.GetUpdatedCache($cr) } catch { return [pscustomobject]@{ Text = ''; Via = 'uia'; Nodes = 0 } }
  Walk-Element $start 0 $sb $ctx
  # Only a single page can be probed by its text alone; two documents (an
  # iframe with its own tree) fall back to the change events.
  $doc = $null
  if ($ctx.DocCount -eq 1) { $doc = $ctx.Doc }
  [pscustomobject]@{ Text = $sb.ToString(); Via = $ctx.Via; Nodes = $ctx.Nodes; Doc = $doc; DocText = $ctx.DocText }
}

# --------------------------------------------------------------- OCR capture

function Capture-Window([IntPtr]$hwnd) {
  $rect = New-Object NotesWin32+RECT
  if (-not [NotesWin32]::GetWindowRect($hwnd, [ref]$rect)) { throw 'GetWindowRect failed' }
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { throw "the window has no size ($w x $h)" }

  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  # 2 = PW_RENDERFULLCONTENT: required for DirectComposition windows (WebView2),
  # and the reason this works while the window is covered by another one.
  $ok = [NotesWin32]::PrintWindow($hwnd, $hdc, 2)
  if (-not $ok) { $ok = [NotesWin32]::PrintWindow($hwnd, $hdc, 0) }
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  if (-not $ok) { $bmp.Dispose(); throw 'PrintWindow refused to draw the window' }

  # The OCR engine rejects anything over its max dimension, so shrink first.
  $max = 2600
  try { $max = [int][Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]::MaxImageDimension } catch { }
  $longest = [Math]::Max($w, $h)
  if ($longest -gt $max) {
    $scale = $max / [double]$longest
    $nw = [int][Math]::Max(1, [Math]::Floor($w * $scale))
    $nh = [int][Math]::Max(1, [Math]::Floor($h * $scale))
    $small = New-Object System.Drawing.Bitmap($nw, $nh)
    $sg = [System.Drawing.Graphics]::FromImage($small)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.DrawImage($bmp, 0, 0, $nw, $nh)
    $sg.Dispose()
    $bmp.Dispose()
    return $small
  }
  return $bmp
}

$script:OcrLast = $null   # @{ Hwnd; Hash; Text } of the last capture the engine read

function Ocr-Window([IntPtr]$hwnd) {
  $bmp = Capture-Window $hwnd
  $hash = ''
  if ('NotesWatch' -as [type]) {
    try { $hash = [NotesWatch]::HashBitmap($bmp) } catch { $hash = '' }
  }
  if ($hash -ne '' -and $null -ne $script:OcrLast -and $script:OcrLast.Hwnd -eq $hwnd -and $script:OcrLast.Hash -eq $hash) {
    $bmp.Dispose()
    return [pscustomobject]@{ Text = $script:OcrLast.Text; Cached = $true }
  }
  $text = Ocr-Bitmap $bmp
  if ($hash -ne '') { $script:OcrLast = @{ Hwnd = $hwnd; Hash = $hash; Text = $text } }
  [pscustomobject]@{ Text = $text; Cached = $false }
}

function Ocr-Bitmap($bmp) {
  $png = Join-Path $env:TEMP ("notes-ocr-" + [Guid]::NewGuid().ToString('N') + ".png")
  try {
    $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bmp.Dispose()
  }
  try {
    $engine = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) { throw 'no OCR language pack is installed for this user profile' }
    $file = Await-WinRt ([Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
    $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
      $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $soft = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      try {
        $result = Await-WinRt ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
        return $result.Text
      } finally { $soft.Dispose() }
    } finally { $stream.Dispose() }
  } finally {
    Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue
  }
}

# ----------------------------------------------------------- the change gate

$script:ReadCache = $null            # the last full walk (see Invoke-Command-Line)
$script:GateHwnd = [IntPtr]::Zero    # the window the events are subscribed on
$script:WalkWhy = 'first'            # why the current read walks the tree

function Get-GateEvents {
  if ('NotesWatch' -as [type]) { return [NotesWatch]::Events }
  0
}

$script:TestNoDoc = $false

function Reset-Events {
  if ($script:GateHwnd -ne [IntPtr]::Zero) { try { [NotesWatch]::Detach() } catch { } }
  $script:GateHwnd = [IntPtr]::Zero
}

function Reset-Gate {
  $script:ReadCache = $null
  Reset-Events
}

# The last walk's answer, as a ready JSON line, when nothing can have changed
# since; $null (and $script:WalkWhy says why) when this read has to walk. The
# line is pre-serialised at walk time: ConvertTo-Json of 4 KB of text on every
# 3 s read would cost more than the rest of a gated read put together.
function Read-FromGate([string]$procName, $msg, [int]$id) {
  $c = $script:ReadCache
  if ($null -eq $c) { $script:WalkWhy = 'first'; return $null }
  if ($msg.force -eq $true) { $script:WalkWhy = 'forced'; return $null }
  if ($c.Proc -ne $procName) { $script:WalkWhy = 'first'; return $null }
  $h = $c.Hwnd
  if (-not [NotesWin32]::IsWindow($h) -or -not [NotesWin32]::IsWindowVisible($h) -or [NotesWin32]::PidOf($h) -ne $c.Pid) {
    $script:WalkWhy = 'window-changed'; return $null
  }
  $maxAge = $script:MaxAgeMs
  if ($script:TestHooks -and $null -ne $msg.maxAgeMs) { $maxAge = [int]$msg.maxAgeMs }
  $age = ([DateTime]::UtcNow - $c.At).TotalMilliseconds
  if ($age -ge $maxAge) { $script:WalkWhy = 'max-age'; return $null }
  if ($c.Mode -eq 'doc') {
    # One cross-process call: the page's text, compared with the last walk's.
    $now = $null
    try { $now = $c.Doc.DocumentRange.GetText($script:TextCap) } catch { $script:WalkWhy = 'doc-gone'; return $null }
    if (-not [string]::Equals([string]$now, [string]$c.DocText, [StringComparison]::Ordinal)) { $script:WalkWhy = 'doc-changed'; return $null }
  } else {
    if ($script:GateOff -ne '') { $script:WalkWhy = 'gate-off'; return $null }
    if (-not [NotesWatch]::Attached) { $script:WalkWhy = 'first'; return $null }
    if ([NotesWatch]::Events -ne $c.Events) { $script:WalkWhy = 'events'; return $null }
  }
  '{"id":' + $id + ',"age":' + [int]$age + ',' + $c.Tail
}

# Events mode: subscribe on this window if not yet (first read, or the reader
# app swapped windows). Returns the event count the cache should remember: the
# count from before the walk when the handlers were already listening, or -1
# when they were only attached now (so the next read walks once more, this
# time with the handlers in place).
function Ensure-Events($root, $win, $eventsBefore) {
  if ($script:GateOff -ne '' -or $null -eq $root) { return $eventsBefore }
  if ($script:GateHwnd -eq $win.Handle -and [NotesWatch]::Attached) { return $eventsBefore }
  $err = [NotesWatch]::Attach($root)
  if ($err -ne '') {
    $script:GateOff = "could not subscribe to the window's change events ($err); every read walks the tree"
    $script:GateHwnd = [IntPtr]::Zero
  } else {
    $script:GateHwnd = $win.Handle
  }
  -1
}

# The safety walk found different text with no event in between: this window's
# events cannot be trusted, so stop trusting them (until the reader restarts).
function Check-GateMissed([string]$why, $win, [string]$text, $eventsBefore) {
  if ($why -ne 'max-age' -or $script:GateOff -ne '') { return }
  $c = $script:ReadCache
  if ($null -eq $c -or $c.Mode -ne 'events' -or $c.Hwnd -ne $win.Handle -or $c.Events -lt 0) { return }
  if ([string]::Equals([string]$c.Text, $text, [StringComparison]::Ordinal)) { return }
  if ((Get-GateEvents) -ne $c.Events) { return }   # an event did arrive, just late: not a miss
  $script:GateOff = 'the change events missed a new page (caught by the safety read at ' +
    (Get-Date -Format 'HH:mm:ss') + '); every read walks the tree now'
  try { [NotesWatch]::Detach() } catch { }
  $script:GateHwnd = [IntPtr]::Zero
}

# ------------------------------------------------------------- the JSON loop

function Write-Answer($obj) {
  $json = if ($obj -is [string]) { $obj } else { $obj | ConvertTo-Json -Compress -Depth 4 }
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Invoke-Command-Line($msg) {
  $id = 0
  if ($null -ne $msg.id) { $id = [int]$msg.id }
  $cmd = [string]$msg.cmd
  # The reader app's process name always comes from the caller (reader.exe in
  # notes-pane.json, passed through by notes-pane-main.js). There is no built-in
  # default: an empty one is answered below with a reason, never guessed at.
  $procName = ([string]$msg.process).Trim()

  if ($cmd -eq 'ping') {
    return [pscustomobject]@{ id = $id; ok = ($script:LoadError -eq ''); cmd = 'ping'; reason = $script:LoadError; pid = $PID; gate = $script:GateOff; events = $(if ('NotesWatch' -as [type]) { [NotesWatch]::Kinds } else { '' }) }
  }
  if ($script:LoadError -ne '') {
    return [pscustomobject]@{ id = $id; ok = $false; cmd = $cmd; reason = $script:LoadError }
  }
  if ($cmd -eq 'test-mute' -and $script:TestHooks) {
    [NotesWatch]::MuteForTest()
    return [pscustomobject]@{ id = $id; ok = $true; cmd = $cmd; reason = '' }
  }
  if ($cmd -eq 'test-nodoc' -and $script:TestHooks) {
    # Treat the page as if it had no TextPattern, so the events mode runs.
    $script:TestNoDoc = $true
    return [pscustomobject]@{ id = $id; ok = $true; cmd = $cmd; reason = '' }
  }

  # Every command from here on reads a window, so it needs to know whose.
  # ping and the test hooks above do not, so they still answer without one.
  if ($procName -eq '') {
    return [pscustomobject]@{ id = $id; ok = $false; cmd = $cmd; reason = 'no reader app configured (reader.exe in notes-pane.json)' }
  }

  # The cheap answer: nothing changed since the last walk of this same window.
  if ($cmd -eq 'read') {
    $cached = Read-FromGate $procName $msg $id
    if ($null -ne $cached) { return $cached }
  }

  $win = Get-TargetWindow $procName
  if ($null -eq $win) {
    Reset-Gate
    return [pscustomobject]@{ id = $id; ok = $false; cmd = $cmd; reason = "$procName has no visible top-level window" }
  }

  switch ($cmd) {
    'read' {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($win.Handle)
      $why = $script:WalkWhy
      if ($script:GateHwnd -ne [IntPtr]::Zero -and $script:GateHwnd -ne $win.Handle) { $why = 'window-changed' }
      # Snapshot BEFORE walking: an event that lands mid-walk makes the next read walk too.
      $eventsBefore = Get-GateEvents
      $read = Read-WindowText $root
      if ($read.Text.Trim().Length -lt 40) {
        # Chromium's accessibility tree is not built until something asks for
        # it; the first query is the ask, so give it a moment and try once more.
        Start-Sleep -Milliseconds 400
        $retry = Read-WindowText $root
        if ($retry.Text.Trim().Length -gt $read.Text.Trim().Length) { $read = $retry }
      }
      $text = $read.Text
      if ($text.Length -gt $script:TextCap) { $text = $text.Substring(0, $script:TextCap) }
      # How the next reads learn of a change. 'doc': the page has a TextPattern,
      # so a read re-asks for just its text (one call) and compares; no events,
      # which cost a constant trickle of CPU just by being subscribed (measured
      # 2026-10-16). 'events': no TextPattern, so the names walk is the only
      # reader, and UIA change events say when to walk it again.
      $mode = 'events'
      if ($null -ne $read.Doc -and -not $script:TestNoDoc) { $mode = 'doc' }
      $eventsKept = 0
      if ($mode -eq 'doc') {
        if ($script:GateHwnd -ne [IntPtr]::Zero) { Reset-Events }
      } else {
        Check-GateMissed $why $win $text $eventsBefore
        $eventsKept = Ensure-Events $root $win $eventsBefore
      }
      $script:ReadCache = @{
        Proc = $procName; Hwnd = $win.Handle; Pid = [uint32]$win.Pid; Text = $text; Via = $read.Via
        Nodes = $read.Nodes; At = [DateTime]::UtcNow; Events = $eventsKept
        Mode = $mode; Doc = $read.Doc; DocText = $read.DocText
        Tail = ([pscustomobject]@{
          ok = $true; cmd = 'read'; title = $win.Title; text = $text; chars = $text.Length
          via = $read.Via; nodes = $read.Nodes; reason = ''; cached = $true; walked = ''; gate = ''
        } | ConvertTo-Json -Compress -Depth 4).Substring(1)
      }
      return [pscustomobject]@{
        id = $id; ok = $true; cmd = 'read'; title = $win.Title; text = $text
        chars = $text.Length; via = $read.Via; nodes = $read.Nodes; reason = ''
        cached = $false; walked = $why; gate = $(if ($mode -eq 'events') { $script:GateOff } else { '' }); watch = $mode
      }
    }
    'ocr' {
      $got = Ocr-Window $win.Handle
      $text = $got.Text
      if ($null -eq $text) { $text = '' }
      $text = ($text -replace '\r\n', "`n").Trim()
      if ($text.Length -gt $script:TextCap) { $text = $text.Substring(0, $script:TextCap) }
      return [pscustomobject]@{
        id = $id; ok = $true; cmd = 'ocr'; title = $win.Title; text = $text
        chars = $text.Length; via = 'printwindow-ocr'; reason = ''; cached = $got.Cached
      }
    }
    default {
      return [pscustomobject]@{ id = $id; ok = $false; cmd = $cmd; reason = "unknown command `"$cmd`"" }
    }
  }
}

while ($true) {
  $line = $null
  try { $line = [Console]::In.ReadLine() } catch { break }
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }

  # notes-pane-main.js's every-3-s read is always this exact line (JSON.stringify keeps
  # the key order): answer it from the gate without ConvertFrom-Json at all.
  if ($line -match '^\{"id":(\d+),"cmd":"read","process":"([A-Za-z0-9_.\-]+)"\}$' -and $script:LoadError -eq '') {
    $fast = $null
    try { $fast = Read-FromGate $Matches[2] $null ([int]$Matches[1]) } catch { $fast = $null }
    if ($null -ne $fast) { Write-Answer $fast; continue }
  }

  $msg = $null
  try { $msg = $line | ConvertFrom-Json } catch {
    Write-Answer ([pscustomobject]@{ id = 0; ok = $false; cmd = ''; reason = "could not parse the command: $($_.Exception.Message)" })
    continue
  }
  if ([string]$msg.cmd -eq 'quit') { break }

  try {
    Write-Answer (Invoke-Command-Line $msg)
  } catch {
    $id = 0
    try { if ($null -ne $msg.id) { $id = [int]$msg.id } } catch { }
    Write-Answer ([pscustomobject]@{ id = $id; ok = $false; cmd = [string]$msg.cmd; reason = "$($_.Exception.Message)" })
  }
}

# Leave no UIA subscription behind when notes-pane-main.js says quit or closes stdin.
Reset-Gate
