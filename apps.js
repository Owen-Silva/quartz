'use strict';

// apps.js — the installed-app index, main-process side.
//
// The user wants this browser to be "literally all I need to open when I use my
// computer", so the new tab page carries a dock of native apps and the command
// palette offers "Open <app>" rows. Both need one thing from main: a list of
// what is installed, with an icon and a way to start it.
//
// Windows has no single registry of "apps a person launches". Two sources
// together cover it:
//
//   1. START MENU SHORTCUTS -- every classic desktop app puts a .lnk in
//      %ProgramData%\...\Start Menu\Programs or the per-user one. A .lnk is
//      the BEST launch handle there is: it carries the target, its arguments
//      AND its working directory, so opening the .lnk starts the app exactly
//      the way the Start Menu would. Spotify, VS Code, Git Bash, PowerShell.
//
//   2. Get-StartApps -- the Start Menu's own list, which is the only place
//      packaged (Store/MSIX) apps appear: Notepad and Calculator on Windows 11
//      are Store apps with no .lnk anywhere. Those launch through
//      `explorer.exe shell:AppsFolder\<AppID>`.
//
// Three rules shape the code:
//
//   A. THE MAIN LOOP IS NEVER BLOCKED. Every directory walk is async, icons
//      are fetched in batches of ICON_BATCH with a yield between them, and
//      PowerShell is spawned EXACTLY ONCE per build (with a timeout), never
//      per entry. A build happens at most once a day.
//
//   B. A FAILURE MAKES THE INDEX SMALLER, NEVER ABSENT. Every source, every
//      shortcut read and every icon is wrapped on its own. An unreadable
//      folder costs its own entries and nothing else; a PowerShell that is
//      missing or slow costs the Store apps and keeps the shortcuts.
//
//   C. THE PURE PARTS ARE PURE. Filtering, id hashing, basenames, the
//      Get-StartApps JSON and the merge are plain functions with no Electron
//      and no disk, so the node harness can check them directly.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cache file under <userData>. */
const CACHE_NAME = 'apps-index.json';

/**
 * Bump when the entry shape changes so an old cache is rebuilt, not trusted.
 * 2: store entries carry the exe their package manifest names, and an x86 twin
 * carries `variant`.
 * 3: shortcut entries carry `cwd`, `aumid` and `runas`. This one is NOT
 * cosmetic: the last two decide whether launch() spawns the exe or hands the
 * .lnk to the shell, so a v2 cache (which has neither) would spawn apps that
 * must go through ShellExecute. Old caches are rebuilt, never trusted.
 */
const CACHE_VERSION = 3;

/** A day. Apps are installed rarely; a stale icon is cheaper than a rebuild. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * SLDF_RUNAS_USER, bit 13 of the LinkFlags field at offset 20 of a .lnk header:
 * the shortcut's "Run as administrator" tick. Nothing in Electron's
 * readShortcutLink reports it, and it is the one bit that makes a direct spawn
 * WRONG rather than merely different -- see lnkWantsElevation.
 */
const LNK_RUNAS_FLAG = 0x00002000;

/** Offset and minimum length of that header field. */
const LNK_FLAGS_OFFSET = 20;
const LNK_HEAD_BYTES = 24;

/** How many icons are fetched before yielding back to the loop. */
const ICON_BATCH = 20;

/** How deep the Start Menu walk goes. Real trees are 2-3 deep. */
const MAX_DEPTH = 6;

/** Hard cap on shortcuts considered, so a pathological tree cannot run away. */
const MAX_SHORTCUTS = 600;

/** Get-StartApps gets one run and this long to finish it. */
const STARTAPPS_TIMEOUT_MS = 15000;

/** AppActivate/SetForegroundWindow, Add-Type included. */
const FOCUS_TIMEOUT_MS = 10000;

/**
 * Past this, `apps:list` answers without icons and the page pulls them one at
 * a time from `apps:icon`. 32px PNGs run ~1-3 KB each, so ~150 apps land near
 * 300 KB and this never trips -- it exists so a machine with 800 apps cannot
 * push a 6 MB structured clone through IPC on every new tab.
 */
const ICON_BUDGET_BYTES = 2 * 1024 * 1024;

/**
 * Shortcuts that are not an app: the uninstaller, the manual, the "visit our
 * website" link. Matched against the shortcut's NAME (the .lnk basename),
 * which is what the Start Menu shows.
 */
const SKIP_NAME_RE = new RegExp([
  '\\buninstall',
  '\\bremove\\b',
  '\\bhelp\\b',
  '\\bread ?me\\b',
  '\\bmanual\\b',
  '\\bdocumentation\\b',
  '\\bdocs\\b',
  '\\b(release|installation|version|upgrade|setup) notes\\b',
  '\\bnotes\\.txt\\b',
  '\\bchangelog\\b',
  '\\blicen[sc]e\\b',
  '\\beula\\b',
  '\\bwebsite\\b',
  '\\bweb site\\b',
  '\\bhome ?page\\b',
  '\\bon the web\\b',
  '\\bsupport\\b',
  '\\bfaq\\b',
  '\\bwhat\'?s new\\b',
  '\\bgetting started\\b',
  '\\btutorial\\b',
  '\\bfeedback\\b',
  '\\bdonate\\b',
  '\\bmodify\\b',
  '\\brepair\\b'
].join('|'), 'i');

/** Only these targets are ours to open by shortcut. */
const TARGET_EXTS = ['.exe'];

/**
 * Documents and links dressed up as Start Menu entries: "Release Notes.lnk"
 * pointing at a .txt, a vendor's "Homepage.url", an .chm manual. The exe
 * allowlist above already rejects every one of these, but they are named
 * explicitly (and checked first) so the intent survives any later widening of
 * TARGET_EXTS -- a dock is for apps, never for a readme.
 */
const DOC_TARGET_EXTS = ['.txt', '.htm', '.html', '.url', '.pdf', '.chm', '.md', '.rtf'];

/** Targets nobody means to launch from a dock. */
const SKIP_TARGET_RE = /\\windows\\installer\\|\\unins\d*\.exe$|\\uninstall(er)?\.exe$|\\msiexec\.exe$|\\setup\.exe$/i;

// ---------------------------------------------------------------------------
// Pure helpers (no Electron, no disk -- the harness covers these)
// ---------------------------------------------------------------------------

/**
 * Is this shortcut name one of an app, rather than its uninstaller or its
 * website? Name is the .lnk basename WITHOUT the extension.
 */
function isAppShortcutName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) return false;
  return !SKIP_NAME_RE.test(n);
}

/** Lowercased basename of an exe path: 'spotify.exe', or null when unknown. */
function exeBaseName(target) {
  const t = typeof target === 'string' ? target.trim() : '';
  if (!t) return null;
  const base = path.win32.basename(t).toLowerCase();
  if (!base || base.indexOf('.exe') === -1) return null;
  return base;
}

/** True for a shortcut target this module is willing to launch. */
function isLaunchableTarget(target) {
  const t = typeof target === 'string' ? target.trim() : '';
  if (!t) return false;
  const ext = path.win32.extname(t).toLowerCase();
  if (DOC_TARGET_EXTS.indexOf(ext) !== -1) return false;
  if (TARGET_EXTS.indexOf(ext) === -1) return false;
  if (SKIP_TARGET_RE.test(t)) return false;
  return true;
}

/**
 * A stable id for an entry: kind + the launch handle, hashed. Stable across
 * rebuilds and across machines' path casing, so Settings can store pins as
 * ids and they survive a refresh.
 */
function entryId(kind, launchPath) {
  const key = String(kind || '') + '\u0000' + String(launchPath || '').toLowerCase();
  return crypto.createHash('sha1').update(key, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Parse `Get-StartApps | ConvertTo-Json -Compress`.
 *
 * ConvertTo-Json emits a bare OBJECT when the pipeline held exactly one item
 * and an ARRAY otherwise, so both shapes are accepted. Anything without both a
 * Name and an AppID is dropped rather than trusted.
 *
 * @returns {{name:string, appId:string}[]}
 */
function parseStartApps(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : [data];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.Name === 'string' ? item.Name.trim()
      : (typeof item.name === 'string' ? item.name.trim() : '');
    const appId = typeof item.AppID === 'string' ? item.AppID.trim()
      : (typeof item.AppId === 'string' ? item.AppId.trim()
        : (typeof item.appId === 'string' ? item.appId.trim() : ''));
    if (!name || !appId) continue;
    const key = appId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, appId });
  }
  return out;
}

/**
 * Split the store script's stdout into its two marked lines and parse each.
 * Either half may be missing (a killed run, an Appx module that is not there);
 * the other half still counts.
 *
 * @returns {{store:{name:string,appId:string}[], appx:{family:string,id:string,exe:string}[]}}
 */
function parsePsPayload(text) {
  const raw = typeof text === 'string' ? text : '';
  let storeLine = '';
  let appxLine = '';
  for (const line of raw.split(/\r?\n/)) {
    if (line.indexOf(APPS_MARKER) === 0) storeLine = line.slice(APPS_MARKER.length);
    else if (line.indexOf(APPX_MARKER) === 0) appxLine = line.slice(APPX_MARKER.length);
  }
  // An older cache-free path (or a plain Get-StartApps run) has no markers at
  // all: treat the whole thing as the store list.
  if (!storeLine && raw.indexOf(APPS_MARKER) === -1) storeLine = raw;
  return { store: parseStartApps(storeLine), appx: parseAppxApps(appxLine) };
}

/**
 * Parse the manifest rows: `[{Family,Id,Exe}]`, one per <Application>. Exe is
 * package-relative ('Notepad\Notepad.exe', 'CalculatorApp.exe'), so only its
 * lowercased basename is kept -- that is the shape a stats sample's process
 * key has, which is the whole point of collecting it.
 *
 * @returns {{family:string,id:string,exe:string}[]}
 */
function parseAppxApps(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return [];
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  const list = Array.isArray(data) ? data : [data];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const family = typeof item.Family === 'string' ? item.Family.trim() : '';
    const id = typeof item.Id === 'string' ? item.Id.trim() : '';
    const exe = exeBaseName(typeof item.Exe === 'string' ? item.Exe.trim() : '');
    if (!family || !id || !exe) continue;
    out.push({ family: family, id: id, exe: exe });
  }
  return out;
}

/**
 * Give each packaged store entry the exe its manifest names, matching
 * `<PackageFamilyName>!<AppId>` against Family + Id. Returns a NEW array and
 * the count that gained one, so the build can report it.
 *
 * @returns {{entries:object[], matched:number}}
 */
function applyStoreExes(storeEntries, appxRows) {
  const list = Array.isArray(storeEntries) ? storeEntries : [];
  const rows = Array.isArray(appxRows) ? appxRows : [];
  if (!rows.length) return { entries: list.slice(), matched: 0 };
  const byId = new Map();
  for (const row of rows) {
    const key = (row.family + '!' + row.id).toLowerCase();
    if (!byId.has(key)) byId.set(key, row.exe);
  }
  let matched = 0;
  const entries = list.map((item) => {
    if (!item || typeof item.appId !== 'string') return item;
    const exe = byId.get(item.appId.trim().toLowerCase());
    if (!exe) return item;
    matched += 1;
    return Object.assign({}, item, { exe: exe });
  });
  return { entries: entries, matched: matched };
}

/**
 * Get-StartApps AppIDs come in four flavours:
 *   'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App'  packaged app
 *   '{1AC14E77-...}\WindowsPowerShell\v1.0\powershell.exe'  known-folder exe
 *   'C:\Users\...\Spotify.exe'                     plain exe
 *   'Microsoft.Windows.ControlPanel'               a shell moniker
 * All four launch through shell:AppsFolder, but the exe-shaped ones are the
 * ones a .lnk may already cover, so their basename is what dedupe compares.
 *
 * @returns {string|null} 'powershell.exe' etc, or null when it is not a path
 */
function appIdExeBase(appId) {
  const id = typeof appId === 'string' ? appId.trim() : '';
  if (!id || id.indexOf('!') !== -1) return null;      // packaged: not a path
  if (!/\.exe$/i.test(id)) return null;
  // CapCut's AppID arrives dot-separated ('c:.users.owens...capcut.exe').
  const normalized = id.indexOf('\\') === -1 && id.indexOf('.') !== -1
    ? id.replace(/\./g, '\\').replace(/\\exe$/i, '.exe')
    : id;
  return exeBaseName(normalized);
}

/**
 * Is this AppID a DOCUMENT rather than a program? Get-StartApps lists every
 * Start Menu item, "Node.js website" (a .url) and "PostgreSQL release notes"
 * (a .txt) included, and those arrive as path-shaped AppIDs. The shortcut walk
 * has always dropped them; this is the same rule for the other source.
 */
function isDocAppId(appId) {
  const id = typeof appId === 'string' ? appId.trim() : '';
  if (!id || id.indexOf('!') !== -1) return false;          // packaged: not a path
  const ext = path.win32.extname(id).toLowerCase();
  return DOC_TARGET_EXTS.indexOf(ext) !== -1;
}

/** An AppID we are willing to hand to explorer.exe. */
function isSafeAppId(appId) {
  const id = typeof appId === 'string' ? appId.trim() : '';
  if (!id || id.length > 400) return false;
  if (/["'\r\n\t<>|&%]/.test(id)) return false;
  return true;
}

/** Case-insensitive name key, punctuation and spacing squeezed out. */
function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\((x86|32-bit|64-bit)\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Merge the two sources into one list.
 *
 * Shortcuts win: a .lnk carries args, a working directory and an icon, so
 * where both sources describe the same app the shortcut entry is the one kept.
 * A Get-StartApps entry is dropped when a shortcut already has
 *   - the same squeezed name ('Windows PowerShell', 'Spotify'), or
 *   - the same exe basename as its exe-shaped AppID.
 * Shortcuts are deduped against each other by target+args, so 'Git Bash' and
 * 'Git CMD' both survive while two copies of the same shortcut do not.
 *
 * The result is sorted by name so the palette and the picker are stable.
 *
 * @param {object[]} exeEntries   entries already shaped by buildShortcutEntry
 * @param {{name:string, appId:string}[]} storeEntries  parseStartApps output
 */
function mergeApps(exeEntries, storeEntries) {
  const out = [];
  const byHandle = new Set();
  const byName = new Set();
  const byExe = new Set();

  for (const entry of Array.isArray(exeEntries) ? exeEntries : []) {
    if (!entry || !entry.path) continue;
    const handle = String(entry.path).toLowerCase() + '\u0000' + String(entry.args || '').toLowerCase();
    if (byHandle.has(handle)) continue;
    byHandle.add(handle);
    byName.add(nameKey(entry.name));
    if (entry.exe) byExe.add(entry.exe);
    out.push(entry);
  }

  for (const item of Array.isArray(storeEntries) ? storeEntries : []) {
    if (!item || !item.appId || !isSafeAppId(item.appId)) continue;
    // The SAME noise filter the shortcut walk uses: Get-StartApps is a view of
    // the Start Menu, so "Git Release Notes" and "Uninstall Node.js" are in it
    // too, and a dock is for apps.
    if (!isAppShortcutName(item.name) || isDocAppId(item.appId)) continue;
    const key = nameKey(item.name);
    if (key && byName.has(key)) continue;
    // DEDUPE still compares only the exe a path-shaped AppID names. The exe a
    // packaged app's manifest names (item.exe, from applyStoreExes) is for
    // lighting the running dot, NOT for dedupe: 'wt.exe' appearing in both
    // sources must not silently delete a tile that used to be listed.
    const dedupeExe = appIdExeBase(item.appId);
    if (dedupeExe && byExe.has(dedupeExe)) continue;
    if (key) byName.add(key);
    if (dedupeExe) byExe.add(dedupeExe);
    out.push({
      id: entryId('store', item.appId),
      name: item.name,
      kind: 'store',
      path: item.appId,
      args: '',
      exe: dedupeExe || (typeof item.exe === 'string' && item.exe ? item.exe : null),
      lnk: null,
      iconDataUrl: null
    });
  }

  return finalizeOrder(out);
}

/** Does this entry look like the 32-bit twin: SysWOW64, Program Files (x86)? */
function looksX86(entry) {
  const p = String((entry && entry.path) || '');
  const n = String((entry && entry.name) || '');
  return /\\syswow64\\|\\program files \(x86\)\\|\(x86\)|\b32-bit\b/i.test(p + ' ' + n);
}

/**
 * Mark the x86 half of an x64/x86 pair and put it second.
 *
 * Windows ships both 'Windows PowerShell' (System32) and 'Windows PowerShell
 * (x86)' (SysWOW64): two shortcuts, two ids, the same squeezed name and the
 * same exe BASENAME. Both are kept -- they really are two different programs --
 * but the 32-bit one is flagged `variant: 'x86'` so it reads as the twin and
 * sorts after its sibling. The chrome does not have to change for this.
 *
 * NOTE: because a running dot is matched by exe BASENAME, the pair inevitably
 * SHARES a pid: powershell.exe is powershell.exe whichever folder it came
 * from, so starting the 64-bit one lights both dots. Telling them apart would
 * mean comparing full image paths in the stats sampler, which costs a
 * QueryFullProcessImageName per process per sample; a duplicated dot on a pair
 * of twins is the cheaper wrong.
 */
function finalizeOrder(entries) {
  const out = Array.isArray(entries) ? entries : [];
  const groups = new Map();
  for (const entry of out) {
    if (!entry) continue;
    const key = nameKey(entry.name) + '\u0000' + (entry.exe || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const x86 = group.filter(looksX86);
    if (!x86.length || x86.length === group.length) continue;   // no pair to split
    for (const entry of x86) entry.variant = 'x86';
  }
  out.sort((a, b) => {
    const byName = String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' });
    if (byName !== 0) return byName;
    return (a.variant === 'x86' ? 1 : 0) - (b.variant === 'x86' ? 1 : 0);
  });
  return out;
}

/**
 * Shape one resolved shortcut into an entry, or null when it is not an app.
 * @param {string} lnkPath  full path to the .lnk
 * @param {{target?:string, args?:string, icon?:string, cwd?:string}} link  readShortcutLink result
 */
function buildShortcutEntry(lnkPath, link) {
  const file = typeof lnkPath === 'string' ? lnkPath : '';
  const name = path.win32.basename(file).replace(/\.lnk$/i, '').trim();
  if (!name || !isAppShortcutName(name)) return null;
  const target = link && typeof link.target === 'string' ? link.target.trim() : '';
  if (!isLaunchableTarget(target)) return null;
  return {
    id: entryId('exe', target + (link && link.args ? ' ' + link.args : '')),
    name: name,
    kind: 'exe',
    path: target,
    args: link && typeof link.args === 'string' ? link.args.trim() : '',
    // The shortcut's "Start in" folder. Only launch() reads it -- some apps
    // resolve their own files relative to it -- and it never leaves over IPC.
    cwd: link && typeof link.cwd === 'string' && link.cwd.trim() ? link.cwd.trim() : null,
    // The shortcut's explicit AppUserModelID, when it has one. 19 of the 68
    // Start Menu shortcuts on this machine do (Discord, Cursor, Edge, Opera
    // GX, Obsidian...). It is the app's TASKBAR IDENTITY: ShellExecute stamps
    // it on the process it starts, a direct spawn does not, and the app then
    // gets its own second taskbar button instead of grouping under the pinned
    // one. launch() sends these through the shell for that reason alone.
    aumid: link && typeof link.appUserModelId === 'string' && link.appUserModelId.trim()
      ? link.appUserModelId.trim()
      : null,
    // "Run as administrator" -- read from the .lnk header by the caller.
    runas: !!(link && link.runas),
    exe: exeBaseName(target),
    lnk: file,
    iconDataUrl: null,
    iconPath: link && typeof link.icon === 'string' && link.icon.trim() ? link.icon.trim() : null
  };
}

/** The two Start Menu roots, from the environment (never hardcoded). */
function startMenuRoots(env) {
  const e = env || process.env;
  const roots = [];
  const programData = e.ProgramData || e.ALLUSERSPROFILE;
  const appData = e.APPDATA;
  if (programData) roots.push(path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  if (appData) roots.push(path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  return roots;
}

/** Marker lines in the store script's output. */
const APPS_MARKER = '##APPS##';
const APPX_MARKER = '##APPX##';

/**
 * The PowerShell that produces the Store list -- still ONE run, now two lines.
 *
 * Line 1 is Get-StartApps, exactly as before. Line 2 answers "which exe does
 * this packaged app actually run?", which Get-StartApps never says: a Store
 * entry's launch handle is an AppID, so those tiles had `exe: null` and could
 * never match a running process, which is why Notepad's dot never lit. The
 * package manifest has it (Applications/Application: Id + Executable), so the
 * families of the packaged start entries are looked up once and their
 * manifests read in the same spawn -- ~0.7s on this machine for 47 families.
 *
 * Get-StartApps prints FIRST so that a slow or missing Appx module costs the
 * executables and nothing else (rule B) -- readStartApps parses whatever
 * arrived, even from a run it had to kill.
 */
const STARTAPPS_SCRIPT = [
  '$ErrorActionPreference = \'SilentlyContinue\'',
  '$s = @(Get-StartApps)',
  '\'' + APPS_MARKER + '\' + ($s | ConvertTo-Json -Compress)',
  '$fams = @{}',
  'foreach ($a in $s) {',
  '  $id = [string]$a.AppID',
  '  $k = $id.IndexOf(\'!\')',
  '  if ($k -gt 0) { $fams[$id.Substring(0, $k).ToLower()] = $true }',
  '}',
  '$rows = New-Object System.Collections.ArrayList',
  'if ($fams.Count -gt 0) {',
  '  foreach ($p in Get-AppxPackage) {',
  '    if (-not $fams.ContainsKey($p.PackageFamilyName.ToLower())) { continue }',
  '    $m = $null',
  '    try { $m = (Get-AppxPackageManifest $p.PackageFullName).Package.Applications.Application } catch { $m = $null }',
  '    foreach ($app in @($m)) {',
  '      if (-not $app) { continue }',
  '      $null = $rows.Add([pscustomobject]@{ Family = [string]$p.PackageFamilyName; Id = [string]$app.Id; Exe = [string]$app.Executable })',
  '    }',
  '  }',
  '}',
  '\'' + APPX_MARKER + '\' + ($rows | ConvertTo-Json -Compress)'
].join('\n');

/**
 * One run, handed over as -EncodedCommand: the script is multi-line now, and a
 * multi-line -Command argument is at the mercy of Windows command-line quoting.
 */
const STARTAPPS_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand',
  encodeCommand(STARTAPPS_SCRIPT)
];

/**
 * The pids a single focus request may carry. A dock tile hands over every pid
 * of its exe name (an Electron app is a dozen), and nothing sane is longer.
 */
const FOCUS_PID_MAX = 64;

/** The rules focusScript can match a window with, as reported back in `via`. */
const FOCUS_VIA = ['own', 'console', 'child'];

/**
 * One pid, or a list of them, into the clean list the script interpolates:
 * integers > 0 only, duplicates dropped, order kept (the caller puts its best
 * guess first), capped at FOCUS_PID_MAX.
 */
function normalizePids(pidOrPids) {
  const raw = Array.isArray(pidOrPids) ? pidOrPids : [pidOrPids];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const n = Number(item);
    if (!Number.isInteger(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= FOCUS_PID_MAX) break;
  }
  return out;
}

/**
 * The focus script, as PowerShell source. Handed over as -EncodedCommand
 * (base64 UTF-16LE) so no amount of quoting can go wrong, and so the pids are
 * the only thing interpolated -- after a Number.isInteger check each.
 *
 * WHY A LIST AND NOT ONE PID: the dock's running dot comes from the stats
 * sample, which groups processes by EXE BASENAME and sorts each group's pids
 * ASCENDING (stats.js groupProcesses). pids[0] is therefore the lowest pid of
 * that name, not the one with the window -- and for anything multi-process
 * (Electron and Chromium apps, launchers, a tray helper that outlives a
 * restart) that pid is usually a GPU/utility child or a hidden background
 * process. Asking about it alone answered 'no-window' while the app sat there
 * with a perfectly good window under a sibling pid. So the whole group comes
 * over and the first pid that can answer wins.
 *
 * WHY NOT MainWindowHandle: it is 0 for every console app. powershell.exe,
 * cmd.exe and Git Bash do not own their window -- their console host does
 * (conhost.exe, spawned as a CHILD of the console process), so .NET reports no
 * main window at all. An early version fell back to "another process with the
 * same NAME that does have a window", which raised a DIFFERENT PowerShell than
 * the one that was clicked -- the wrong window is worse than none. The list
 * fixes that honestly: every pid in it was in the same name group as the tile
 * the user pressed, so nothing outside the click is ever raised.
 *
 * So, in order, each rule tied to the pids handed over and nothing else:
 *
 *   1. Enumerate every top-level window (EnumWindows +
 *      GetWindowThreadProcessId, visible, non-empty title, NOT cloaked) and
 *      take the first whose pid IS one of the targets, targets in the order
 *      they arrived. That is every GUI app. -> via 'own'
 *   2. Ask WINDOWS which window shows a target's console: FreeConsole,
 *      AttachConsole(target), GetConsoleWindow. On Windows 11 the default
 *      terminal is Windows Terminal, so a dock-launched powershell.exe gets a
 *      HIDDEN, TITLE-LESS pseudo console window of its own (rule 1 cannot see
 *      it) whose GA_ROOTOWNER is the terminal window drawing it. Measured on
 *      this machine: the root owner was the WT window that VANISHED when that
 *      pid was killed -- the right one, and not the WT window of another
 *      session that was also open. The candidate is accepted only when the
 *      console window's pid is that target (or its own console host) and the
 *      frame is a visible terminal window. Then: the first visible titled
 *      window whose pid is a console host (conhost/WindowsTerminal/
 *      OpenConsole) whose PARENT is a target -- the classic conhost case.
 *      -> via 'console'
 *   3. The first visible titled window owned by a CHILD of a target. That is
 *      the launcher shape: Update.exe stays alive as the parent of the real
 *      Discord.exe, and the tile's own name group is only the stub.
 *      -> via 'child'
 *
 * Never any other pid: if nothing matches, the honest answer is 'no-window',
 * and 'no-process' only when NONE of the pids is still alive.
 *
 * WHY THE CLOAK TEST: a UWP/packaged app leaves ghost frames that are visible
 * and titled by every user32 measure but painted nowhere (DWM cloaks them),
 * and a window hidden by cloak rather than by ShowWindow looks identical to a
 * real one here. Raising one is a click that does nothing, so they are skipped
 * and the next candidate gets its turn.
 *
 * Then SW_RESTORE if minimised, SetForegroundWindow, and if Windows refuses it
 * (a background process has no foreground right) the
 * AttachThreadInput/AllowSetForegroundWindow dance and SwitchToThisWindow.
 *
 * The last line out is 'ok <via>' / 'ok-partial <via>', or one bare word.
 */
function focusScript(pidOrPids) {
  const list = normalizePids(pidOrPids);
  if (!list.length) return '\'no-process\'';
  return [
    '$ErrorActionPreference = \'SilentlyContinue\'',
    '$targets = @(' + list.join(',') + ')',
    '$alive = @()',
    'foreach ($t in $targets) { if (Get-Process -Id $t) { $alive += [int]$t } }',
    'if ($alive.Count -eq 0) { \'no-process\'; exit 0 }',
    'Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Collections.Generic;',
    'using System.Runtime.InteropServices;',
    'public class BrWin {',
    '  delegate bool EnumProc(IntPtr h, IntPtr lp);',
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);',
    '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);',
    '  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);',
    '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
    '  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(uint pid);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '  [DllImport("kernel32.dll")] static extern bool FreeConsole();',
    '  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);',
    '  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();',
    '  public static uint PidOf(IntPtr h) { uint p = 0; GetWindowThreadProcessId(h, out p); return p; }',
    '  // DWMWA_CLOAKED = 14: painted nowhere even though user32 calls it visible.',
    '  public static bool Cloaked(IntPtr h) {',
    '    int v = 0;',
    '    try { if (DwmGetWindowAttribute(h, 14, out v, 4) != 0) return false; } catch { return false; }',
    '    return v != 0;',
    '  }',
    '  public static bool Showable(IntPtr h) {',
    '    return IsWindowVisible(h) && GetWindowTextLength(h) > 0 && !Cloaked(h);',
    '  }',
    '  // { the target\'s own console window, the frame that draws it }',
    '  public static IntPtr[] ConsoleOf(uint pid) {',
    '    IntPtr[] none = new IntPtr[] { IntPtr.Zero, IntPtr.Zero };',
    '    FreeConsole();',
    '    if (!AttachConsole(pid)) return none;',
    '    IntPtr h = GetConsoleWindow();',
    '    IntPtr root = (h == IntPtr.Zero) ? IntPtr.Zero : GetAncestor(h, 3);',
    '    FreeConsole();',
    '    return new IntPtr[] { h, root };',
    '  }',
    '  public static uint ThreadOf(IntPtr h) { uint p = 0; return GetWindowThreadProcessId(h, out p); }',
    '  public static IntPtr[] Top() {',
    '    List<IntPtr> found = new List<IntPtr>();',
    '    EnumWindows(delegate(IntPtr h, IntPtr lp) {',
    '      if (Showable(h)) found.Add(h);',
    '      return true;',
    '    }, IntPtr.Zero);',
    '    return found.ToArray();',
    '  }',
    '}',
    '\'@',
    'if (-not (\'BrWin\' -as [type])) {',
    '  $sh = New-Object -ComObject WScript.Shell',
    '  foreach ($t in $alive) { if ($sh.AppActivate($t)) { \'ok-partial own\'; exit 0 } }',
    '  \'no-window\'; exit 0',
    '}',
    '$wins = [BrWin]::Top()',
    '$h = [IntPtr]::Zero',
    '$via = \'\'',
    '# 1. a window of one of the targets itself, targets in the order they came.',
    'foreach ($t in $alive) {',
    '  foreach ($w in $wins) { if ([int][BrWin]::PidOf($w) -eq $t) { $h = $w; $via = \'own\'; break } }',
    '  if ($h -ne [IntPtr]::Zero) { break }',
    '}',
    '# The children of every target, read ONCE and only when rule 1 came back',
    '# empty: console hosts keyed by parent for rule 2, everything for rule 3.',
    '$hosts = @{}',
    '$kids = @{}',
    'if ($h -eq [IntPtr]::Zero) {',
    '  try {',
    '    $filter = ($alive | ForEach-Object { "ParentProcessId=$_" }) -join \' OR \'',
    '    foreach ($p in @(Get-CimInstance Win32_Process -Filter $filter)) {',
    '      $par = [int]$p.ParentProcessId',
    '      $cid = [int]$p.ProcessId',
    '      if (-not $kids.ContainsKey($par)) { $kids[$par] = @() }',
    '      $kids[$par] += $cid',
    '      if ($p.Name -match \'^(conhost|WindowsTerminal|OpenConsole)\\.exe$\') {',
    '        if (-not $hosts.ContainsKey($par)) { $hosts[$par] = @() }',
    '        $hosts[$par] += $cid',
    '      }',
    '    }',
    '  } catch { $hosts = @{}; $kids = @{} }',
    '}',
    '# 2a. the console Windows itself says belongs to a target.',
    'if ($h -eq [IntPtr]::Zero) {',
    '  foreach ($t in $alive) {',
    '    $mine = @()',
    '    if ($hosts.ContainsKey($t)) { $mine = @($hosts[$t]) }',
    '    $c = [BrWin]::ConsoleOf([uint32]$t)',
    '    if ($c[0] -ne [IntPtr]::Zero) {',
    '      $cwPid = [int][BrWin]::PidOf($c[0])',
    '      if ($cwPid -eq $t -or $mine -contains $cwPid) {',
    '        $cand = $c[0]',
    '        if ($c[1] -ne [IntPtr]::Zero) { $cand = $c[1] }',
    '        $candPid = [int][BrWin]::PidOf($cand)',
    '        $candName = (Get-Process -Id $candPid).ProcessName',
    '        $isHost = $candPid -eq $t -or $mine -contains $candPid -or',
    '          $candName -match \'^(conhost|WindowsTerminal|OpenConsole)$\'',
    '        if ([BrWin]::IsWindowVisible($cand) -and -not [BrWin]::Cloaked($cand) -and $isHost) {',
    '          $h = $cand; $via = \'console\'',
    '        }',
    '      }',
    '    }',
    '    if ($h -ne [IntPtr]::Zero) { break }',
    '  }',
    '}',
    '# 2b. the classic conhost case: a console host CHILD that owns a window.',
    'if ($h -eq [IntPtr]::Zero) {',
    '  foreach ($t in $alive) {',
    '    $mine = @()',
    '    if ($hosts.ContainsKey($t)) { $mine = @($hosts[$t]) }',
    '    if ($mine.Count -gt 0) {',
    '      foreach ($w in $wins) { if ($mine -contains [int][BrWin]::PidOf($w)) { $h = $w; $via = \'console\'; break } }',
    '    }',
    '    if ($h -ne [IntPtr]::Zero) { break }',
    '  }',
    '}',
    '# 3. a child process draws the window: Update.exe -> Discord.exe.',
    'if ($h -eq [IntPtr]::Zero) {',
    '  foreach ($t in $alive) {',
    '    $mine = @()',
    '    if ($kids.ContainsKey($t)) { $mine = @($kids[$t]) }',
    '    if ($mine.Count -gt 0) {',
    '      foreach ($w in $wins) { if ($mine -contains [int][BrWin]::PidOf($w)) { $h = $w; $via = \'child\'; break } }',
    '    }',
    '    if ($h -ne [IntPtr]::Zero) { break }',
    '  }',
    '}',
    'if ($h -eq [IntPtr]::Zero) { \'no-window\'; exit 0 }',
    'if ([BrWin]::IsIconic($h)) { [BrWin]::ShowWindow($h, 9) | Out-Null }',
    '[BrWin]::SetForegroundWindow($h) | Out-Null',
    'if ([BrWin]::GetForegroundWindow() -ne $h) {',
    '  $me = [BrWin]::GetCurrentThreadId()',
    '  $them = [BrWin]::ThreadOf($h)',
    '  [BrWin]::AllowSetForegroundWindow([uint32][BrWin]::PidOf($h)) | Out-Null',
    '  [BrWin]::AttachThreadInput($me, $them, $true) | Out-Null',
    '  [BrWin]::SetForegroundWindow($h) | Out-Null',
    '  [BrWin]::AttachThreadInput($me, $them, $false) | Out-Null',
    '}',
    'if ([BrWin]::GetForegroundWindow() -ne $h) { [BrWin]::SwitchToThisWindow($h, $true) }',
    'if ([BrWin]::GetForegroundWindow() -eq $h) { \'ok \' + $via } else { \'ok-partial \' + $via }'
  ].join('\n');
}

/** PowerShell's -EncodedCommand wants base64 of UTF-16LE. */
function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * A shortcut's argument STRING into the argv ARRAY child_process.spawn wants.
 *
 * A .lnk stores its arguments as one command line ('--cd-to-home', '/name
 * Microsoft.AdministrativeTools', '"C:\\a path\\x.pyw"'), and ShellExecute hands
 * that string to the target untouched. spawn() takes an array instead, so the
 * string is split on whitespace with double quotes grouping -- exactly the part
 * of CommandLineToArgvW that Start Menu shortcuts actually use. Backslashes are
 * left alone: they are path separators here, not escapes.
 *
 * @returns {string[]}
 */
function splitArgs(line) {
  const s = typeof line === 'string' ? line : '';
  const out = [];
  let cur = '';
  let started = false;                                   // '' is a real argument
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n')) {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/**
 * Does this .lnk say "Run as administrator"?
 *
 * The bit lives in the shortcut's own header (LinkFlags, offset 20), not in
 * anything readShortcutLink returns, so the first 24 bytes of the file are the
 * only way to see it. It matters because a direct spawn of an elevated
 * shortcut is not "the same launch without a pid": it either fails outright
 * (UAC cannot be raised from CreateProcess) or, when the exe has no
 * requireAdministrator manifest of its own, quietly starts the app UNELEVATED
 * -- the one thing the shortcut was ticked to prevent. Those go to the shell.
 *
 * @param {Buffer|null} head  the first bytes of the .lnk
 */
function lnkWantsElevation(head) {
  if (!head || typeof head.readUInt32LE !== 'function' || head.length < LNK_HEAD_BYTES) return false;
  let flags = 0;
  try { flags = head.readUInt32LE(LNK_FLAGS_OFFSET); } catch { return false; }
  return (flags & LNK_RUNAS_FLAG) !== 0;
}

/**
 * '%APPDATA%\Foo' -> 'C:\Users\you\AppData\Roaming\Foo'.
 *
 * ShellExecute expands a shortcut's target, arguments and Start-in folder
 * before it uses them; spawn() does not, so an unexpanded '%...%' would just
 * be a path that does not exist (ENOENT, then the shell fallback, then no
 * pid). Names are matched case-insensitively, the way Windows does it, and an
 * unknown variable is left exactly as written rather than blanked -- an app
 * whose args mention a literal per-cent still gets them verbatim.
 */
function expandEnv(value, env) {
  const s = typeof value === 'string' ? value : '';
  if (s.indexOf('%') === -1) return s;
  const src = env && typeof env === 'object' ? env : {};
  const lower = new Map();
  for (const k of Object.keys(src)) {
    if (typeof src[k] === 'string') lower.set(k.toLowerCase(), src[k]);
  }
  return s.replace(/%([^%\r\n]+)%/g, (all, name) => {
    const hit = lower.get(String(name).toLowerCase());
    return hit === undefined ? all : hit;
  });
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

/**
 * @param {{app?:object, shell?:object, env?:object, userDataPath?:string,
 *          spawn?:function}} deps
 *   `app` and `shell` are Electron's; they are injected rather than required
 *   here so the pure half of this file loads under plain node. `spawn` is an
 *   injection point for the harness only: nothing real passes it.
 */
function create(deps = {}) {
  const electronApp = deps.app || null;
  const electronShell = deps.shell || null;
  const env = deps.env || process.env;
  const spawnFn = typeof deps.spawn === 'function' ? deps.spawn : spawn;

  /** { builtAt, apps, payloadBytes, iconsOmitted } or null before the first build. */
  let index = null;
  /** In-flight build, so ten new tabs at once cost one build. */
  let building = null;
  /** id -> data URL, kept even when the list answers without icons. */
  const icons = new Map();
  /** Children we started and would have to clean up on quit. */
  const children = new Set();
  let stopped = false;

  function cachePath() {
    const dir = deps.userDataPath
      || (electronApp && typeof electronApp.getPath === 'function' ? electronApp.getPath('userData') : os.tmpdir());
    return path.join(dir, CACHE_NAME);
  }

  // -- Source 1: Start Menu shortcuts ---------------------------------------

  /**
   * Every .lnk under one root, async and depth-capped. A folder that cannot be
   * read costs its own subtree and nothing else.
   */
  async function collectShortcuts(root, found, depth = 0) {
    if (found.length >= MAX_SHORTCUTS || depth > MAX_DEPTH) return;
    let entries = [];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = [];
    for (const ent of entries) {
      if (found.length >= MAX_SHORTCUTS) return;
      let isDir = false;
      try { isDir = ent.isDirectory(); } catch { isDir = false; }
      if (isDir) { dirs.push(path.join(root, ent.name)); continue; }
      if (!/\.lnk$/i.test(ent.name)) continue;           // .url, .ini, .txt: not ours
      if (!isAppShortcutName(ent.name.replace(/\.lnk$/i, ''))) continue;
      found.push(path.join(root, ent.name));
    }
    for (const dir of dirs) await collectShortcuts(dir, found, depth + 1);
  }

  /** The first bytes of a .lnk, or null when it cannot be read. */
  async function readLnkHead(file) {
    let handle = null;
    try {
      handle = await fsp.open(file, 'r');
      const buf = Buffer.alloc(LNK_HEAD_BYTES);
      const got = await handle.read(buf, 0, LNK_HEAD_BYTES, 0);
      return (got && got.bytesRead >= LNK_HEAD_BYTES) ? buf : null;
    } catch {
      return null;                                        // locked or truncated
    } finally {
      if (handle) { try { await handle.close(); } catch { /* fine */ } }
    }
  }

  /** Resolve the .lnk files into entries. readShortcutLink is sync but fast. */
  async function readShortcutEntries() {
    const files = [];
    for (const root of startMenuRoots(env)) {
      try { await collectShortcuts(root, files); } catch { /* keep the rest */ }
    }
    const out = [];
    let i = 0;
    for (const file of files) {
      let link = null;
      try {
        link = electronShell && typeof electronShell.readShortcutLink === 'function'
          ? electronShell.readShortcutLink(file)
          : null;
      } catch {
        link = null;                                      // broken or dangling .lnk
      }
      if (link) {
        // 24 bytes of header: the "run as administrator" bit that
        // readShortcutLink does not report. One tiny read per shortcut.
        let runas = false;
        try { runas = lnkWantsElevation(await readLnkHead(file)); } catch { runas = false; }
        let entry = null;
        try {
          entry = buildShortcutEntry(file, Object.assign({}, link, { runas: runas }));
        } catch { entry = null; }
        if (entry) out.push(entry);
      }
      // readShortcutLink is a COM call per file; yield on the same cadence as
      // the icon batches so ~100 of them cannot hold the loop.
      if (++i % ICON_BATCH === 0) await new Promise((r) => setImmediate(r));
    }
    return out;
  }

  // -- Source 2: Get-StartApps ---------------------------------------------

  /**
   * One PowerShell, one timeout. Resolves `{ store, appx }` -- and on a timeout
   * it parses the output that DID arrive, because Get-StartApps prints its line
   * first and the manifest pass is the slow half.
   */
  function readStartApps() {
    return new Promise((resolve) => {
      let child = null;
      try {
        child = spawn('powershell.exe', STARTAPPS_ARGS, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve({ store: [], appx: [] });
        return;
      }
      children.add(child);
      let out = '';
      let done = false;
      const parse = () => {
        try { return parsePsPayload(out); } catch { return { store: [], appx: [] }; }
      };
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        children.delete(child);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish(parse());                                   // keep the first line
      }, STARTAPPS_TIMEOUT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
      try {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { if (out.length < 4 * 1024 * 1024) out += chunk; });
      } catch { /* no stdout: the close handler still fires */ }
      child.on('error', () => finish(parse()));
      child.on('close', () => finish(parse()));
    });
  }

  // -- Icons ----------------------------------------------------------------

  /** One 32px PNG data URL, or null. Never throws. */
  async function iconFor(entry) {
    if (!electronApp || typeof electronApp.getFileIcon !== 'function') return null;
    const candidates = [];
    if (entry.kind === 'exe') {
      candidates.push(entry.path);
      if (entry.lnk) candidates.push(entry.lnk);          // the .lnk's own icon
    } else if (entry.iconPath) {
      candidates.push(entry.iconPath);
    }
    for (const file of candidates) {
      try {
        let img = await electronApp.getFileIcon(file, { size: 'normal' });
        if (!img || img.isEmpty()) continue;
        const size = img.getSize();
        if (size && (size.width !== 32 || size.height !== 32)) {
          img = img.resize({ width: 32, height: 32, quality: 'good' });
        }
        const url = img.toDataURL();
        if (url && url.length > 64) return url;
      } catch {
        // A deleted target, a locked file, an icon-less exe: try the next one.
      }
    }
    return null;
  }

  /** Icons in batches of ICON_BATCH, yielding between them. */
  async function attachIcons(entries) {
    for (let i = 0; i < entries.length; i += ICON_BATCH) {
      const batch = entries.slice(i, i + ICON_BATCH);
      const urls = await Promise.all(batch.map((e) => iconFor(e).catch(() => null)));
      for (let k = 0; k < batch.length; k += 1) {
        batch[k].iconDataUrl = urls[k] || null;
        if (urls[k]) icons.set(batch[k].id, urls[k]);
      }
      await new Promise((r) => setImmediate(r));           // let the loop breathe
    }
  }

  // -- Build / cache --------------------------------------------------------

  /** Strip the fields only main needs before anything leaves over IPC. */
  function publicEntry(entry, withIcon) {
    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      path: entry.path,
      args: entry.args || '',
      exe: entry.exe || null,
      variant: entry.variant || null,
      iconDataUrl: withIcon ? (entry.iconDataUrl || null) : null
    };
  }

  async function buildIndex() {
    const t0 = Date.now();
    let shortcuts = [];
    let store = [];
    let appx = [];
    // Both sources at once: the PowerShell spawn is dead time otherwise.
    try {
      const [a, b] = await Promise.all([
        readShortcutEntries().catch(() => []),
        readStartApps().catch(() => ({ store: [], appx: [] }))
      ]);
      shortcuts = Array.isArray(a) ? a : [];
      store = b && Array.isArray(b.store) ? b.store : [];
      appx = b && Array.isArray(b.appx) ? b.appx : [];
    } catch {
      shortcuts = [];
      store = [];
      appx = [];
    }

    // The exe each packaged app runs, so a Store tile can light a running dot.
    let storeExes = 0;
    try {
      const applied = applyStoreExes(store, appx);
      store = applied.entries;
      storeExes = applied.matched;
    } catch { /* the AppID still launches; only the dot is lost */ }

    let apps = [];
    try { apps = mergeApps(shortcuts, store); } catch { apps = shortcuts; }
    try { await attachIcons(apps); } catch { /* icon-less entries are fine */ }

    const iconBytes = apps.reduce((sum, a) => sum + (a.iconDataUrl ? a.iconDataUrl.length : 0), 0);
    const iconsOmitted = iconBytes > ICON_BUDGET_BYTES;

    index = {
      builtAt: Date.now(),
      buildMs: Date.now() - t0,
      apps: apps,
      iconBytes: iconBytes,
      iconsOmitted: iconsOmitted,
      counts: {
        shortcuts: shortcuts.length,
        store: store.length,
        total: apps.length,
        storeExes: storeExes,
        appxRows: appx.length,
        variants: apps.filter((a) => a && a.variant === 'x86').length
      }
    };
    void writeCache(index);
    return index;
  }

  async function writeCache(idx) {
    const file = cachePath();
    const tmp = file + '.tmp';
    const payload = {
      v: CACHE_VERSION,
      builtAt: idx.builtAt,
      buildMs: idx.buildMs,
      counts: idx.counts,
      apps: idx.apps.map((a) => ({
        id: a.id, name: a.name, kind: a.kind, path: a.path, args: a.args || '',
        exe: a.exe || null, variant: a.variant || null,
        lnk: a.lnk || null, cwd: a.cwd || null,
        // Both decide the launch route, so both have to survive the cache.
        aumid: a.aumid || null, runas: !!a.runas,
        iconPath: a.iconPath || null,
        iconDataUrl: a.iconDataUrl || null
      }))
    };
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8');
      await fsp.rename(tmp, file);                         // atomic: no half file
    } catch {
      try { await fsp.unlink(tmp); } catch { /* nothing to clean */ }
    }
  }

  /** The cache, or null when it is missing, corrupt, old or a stale shape. */
  async function readCache() {
    let text = '';
    try {
      text = await fsp.readFile(cachePath(), 'utf8');
    } catch {
      return null;
    }
    let data = null;
    try { data = JSON.parse(text); } catch { return null; }
    if (!data || data.v !== CACHE_VERSION || !Array.isArray(data.apps)) return null;
    const builtAt = Number(data.builtAt);
    if (!Number.isFinite(builtAt) || Date.now() - builtAt > MAX_AGE_MS) return null;
    const apps = data.apps.filter((a) => a && a.id && a.name && a.path);
    if (!apps.length) return null;
    let iconBytes = 0;
    for (const a of apps) {
      if (a.iconDataUrl) {
        icons.set(a.id, a.iconDataUrl);
        iconBytes += a.iconDataUrl.length;
      }
    }
    return {
      builtAt: builtAt,
      buildMs: Number(data.buildMs) || 0,
      apps: apps,
      iconBytes: iconBytes,
      iconsOmitted: iconBytes > ICON_BUDGET_BYTES,
      counts: data.counts || { shortcuts: 0, store: 0, total: apps.length },
      fromCache: true
    };
  }

  /** The index, built or loaded exactly once even under a burst of callers. */
  function ensureIndex() {
    if (index && Date.now() - index.builtAt <= MAX_AGE_MS) return Promise.resolve(index);
    if (building) return building;
    building = (async () => {
      const cached = await readCache();
      if (cached) { index = cached; return index; }
      return buildIndex();
    })()
      .catch(() => (index || { builtAt: 0, buildMs: 0, apps: [], iconBytes: 0, iconsOmitted: false, counts: { shortcuts: 0, store: 0, total: 0 } }))
      .then((result) => { index = result; building = null; return result; });
    return building;
  }

  // -- Public surface -------------------------------------------------------

  /** `{ builtAt, apps, iconsOmitted, buildMs, counts }` -- icons unless huge. */
  async function list() {
    const idx = await ensureIndex();
    const withIcon = !idx.iconsOmitted;
    return {
      builtAt: idx.builtAt,
      buildMs: idx.buildMs || 0,
      fromCache: !!idx.fromCache,
      iconsOmitted: !!idx.iconsOmitted,
      counts: idx.counts || { total: idx.apps.length },
      apps: idx.apps.map((a) => publicEntry(a, withIcon))
    };
  }

  /** Rebuild from source, ignoring the cache's age. */
  async function refresh() {
    if (building) { try { await building; } catch { /* fall through */ } }
    icons.clear();
    building = buildIndex()
      .catch(() => (index || { builtAt: 0, buildMs: 0, apps: [], iconBytes: 0, iconsOmitted: false, counts: { shortcuts: 0, store: 0, total: 0 } }))
      .then((result) => { index = result; building = null; return result; });
    await building;
    return list();
  }

  /** One icon by id, for when the list had to answer without them. */
  async function icon(id) {
    const key = String(id || '');
    if (icons.has(key)) return icons.get(key);
    const idx = await ensureIndex();
    const entry = idx.apps.find((a) => a.id === key);
    if (!entry) return null;
    const url = await iconFor(entry).catch(() => null);
    if (url) icons.set(key, url);
    return url || null;
  }

  /**
   * The folder to start the exe in: the shortcut's "Start in" when it still
   * exists, else the exe's own folder. A Start-in folder that has been deleted
   * or renamed is not a detail -- spawn fails outright on it (pid undefined),
   * which would cost the pid on an app that starts perfectly well.
   */
  function spawnCwd(entry, target) {
    const want = expandEnv(entry && entry.cwd ? String(entry.cwd).trim() : '', env);
    if (want) {
      try { if (fs.statSync(want).isDirectory()) return want; } catch { /* gone */ }
    }
    return path.win32.dirname(target);
  }

  /**
   * Start the target exe OURSELVES, so the caller gets a pid.
   *
   * ShellExecute (shell.openPath) is the friendlier launcher -- it honours a
   * shortcut's "run as administrator" bit and its AppUserModelID -- but it
   * answers nothing about WHICH process it started, and native app tabs need
   * that: "host the window this launch produced" is unanswerable from an exe
   * name alone when two copies of the app are running. So a plain .exe target
   * is spawned here, detached, with the shortcut's own arguments and working
   * directory, and the pid is handed back.
   *
   * Returns null when this path cannot be used (no target, spawn refused, or
   * Windows gave us no pid) -- the caller then falls back to the shell.
   *
   * @returns {{ok:true, reason:'', pid:number}|null}
   */
  function spawnEntry(entry) {
    const raw = entry && typeof entry.path === 'string' ? entry.path.trim() : '';
    const target = expandEnv(raw, env);                    // %ProgramFiles%\...
    // .exe only: a .bat/.cmd/.msc needs a shell, and this is not the place for
    // one. (isLaunchableTarget already keeps the index to .exe targets.)
    if (!target || path.win32.extname(target).toLowerCase() !== '.exe') return null;
    let child = null;
    try {
      child = spawnFn(target, splitArgs(expandEnv(entry.args, env)), {
        // The shortcut's "Start in", else the exe's own folder -- never the
        // browser's cwd, which some apps would treat as their data directory.
        cwd: spawnCwd(entry, target),
        detached: true,                                    // its life is not ours
        stdio: 'ignore',
        windowsHide: false                                 // we WANT its window
      });
    } catch {
      return null;                                         // bad path, EACCES: use the shell
    }
    if (!child) return null;
    // A failed spawn (ENOENT, elevation required) reports its error on the next
    // tick and leaves pid undefined, so pid is the only reliable "it started".
    try { if (typeof child.on === 'function') child.on('error', () => {}); } catch { /* fine */ }
    const pid = Number(child.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try { if (typeof child.unref === 'function') child.unref(); } catch { /* fine */ }
    return { ok: true, reason: '', pid: pid };
  }

  /**
   * Start an app. Detached and never awaited past the handoff: the point is
   * that the click feels instant, and Windows owns the process from there.
   *   exe   -> spawn the target (pid), else ShellExecute the .lnk (no pid)
   *   store -> explorer.exe shell:AppsFolder\<AppID> (no pid: explorer's own
   *            pid says nothing about the packaged process it activates)
   *
   * `pid` is the one new thing: a NUMBER when we started the process ourselves
   * and know which one it is, null when the shell did the starting. Callers
   * that only care whether the click worked (the dock, the palette) read `ok`
   * and ignore it.
   *
   * @returns {Promise<{ok:boolean, reason:string, pid:number|null}>}
   */
  async function launch(id) {
    const key = String(id || '');
    if (!key) return { ok: false, reason: 'no app id', pid: null };
    const idx = await ensureIndex();
    const entry = idx.apps.find((a) => a.id === key);
    if (!entry) return { ok: false, reason: 'that app is not in the index', pid: null };

    if (entry.kind === 'exe') {
      // Two kinds of shortcut MUST keep the shell, pid or no pid:
      //   * one carrying an AppUserModelID -- ShellExecute stamps that identity
      //     on the process, a spawn cannot, and the app would open a second
      //     taskbar button beside its own pinned one;
      //   * one ticked "run as administrator" -- a spawn either fails or starts
      //     it unelevated, which is worse than failing.
      // main.js still finds the window: with pid null it ranks by start time.
      const viaShell = !!(entry.lnk && (entry.aumid || entry.runas));
      const direct = viaShell ? null : spawnEntry(entry);
      if (direct) return direct;
      const target = entry.lnk || expandEnv(entry.path, env);
      if (!electronShell || typeof electronShell.openPath !== 'function') {
        return { ok: false, reason: 'unavailable', pid: null };
      }
      try {
        const err = await electronShell.openPath(target);
        return err ? { ok: false, reason: String(err), pid: null } : { ok: true, reason: '', pid: null };
      } catch (e) {
        return { ok: false, reason: (e && e.message) || 'failed', pid: null };
      }
    }

    if (!isSafeAppId(entry.path)) return { ok: false, reason: 'bad app id', pid: null };
    try {
      const child = spawnFn('explorer.exe', ['shell:AppsFolder\\' + entry.path], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      if (child && typeof child.on === 'function') {
        child.on('error', () => { /* explorer is always there; never throw at the page */ });
      }
      if (child && typeof child.unref === 'function') child.unref();  // its life is not ours
      return { ok: true, reason: '', pid: null };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || 'failed', pid: null };
    }
  }

  /**
   * Bring a running app's main window forward. This one is ALLOWED to steal
   * focus: it only ever runs because the user clicked a tile whose dot was lit.
   *
   * Takes ONE pid or a LIST of them -- a dock tile knows its app by exe name,
   * so it hands over every pid of that name and the script picks the one that
   * actually has a window (see focusScript). A list is not "try some other
   * program": every pid in it is the app whose tile was pressed.
   *
   * Answers { ok, reason }, plus `via` ('own' | 'console' | 'child') on
   * success for the chrome to log. Callers that only read ok/reason are
   * unaffected.
   */
  function focus(pidOrPids) {
    const list = normalizePids(pidOrPids);
    if (!list.length) return Promise.resolve({ ok: false, reason: 'bad pid' });
    return new Promise((resolve) => {
      let child = null;
      try {
        child = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-EncodedCommand', encodeCommand(focusScript(list))
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (e) {
        resolve({ ok: false, reason: (e && e.message) || 'failed' });
        return;
      }
      children.add(child);
      let out = '';
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        children.delete(child);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ ok: false, reason: 'timed out' });
      }, FOCUS_TIMEOUT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
      try {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { if (out.length < 4096) out += chunk; });
      } catch { /* the close handler still answers */ }
      child.on('error', (e) => finish({ ok: false, reason: (e && e.message) || 'failed' }));
      child.on('close', () => {
        // 'ok <via>' / 'ok-partial <via>', or one bare word. The via is a note
        // for the log, so an unknown one is dropped rather than passed on.
        const line = out.trim().split(/\r?\n/).pop() || '';
        const word = line.split(/\s+/);
        const status = word[0] || '';
        const via = FOCUS_VIA.indexOf(word[1]) >= 0 ? word[1] : '';
        if (status === 'ok' || status === 'ok-partial') {
          return finish({ ok: true, reason: status === 'ok' ? '' : 'partial', via });
        }
        if (line === 'no-window') return finish({ ok: false, reason: 'that app has no window to show' });
        if (line === 'no-process') return finish({ ok: false, reason: 'that app is no longer running' });
        finish({ ok: false, reason: 'could not bring it forward' });
      });
    });
  }

  /** Quit: nothing long-lived here, but a PowerShell mid-flight is ours. */
  function stop() {
    stopped = true;
    for (const child of Array.from(children)) {
      try { child.kill(); } catch { /* already gone */ }
      children.delete(child);
    }
  }

  /** Test/diagnostic view: what the last build cost. */
  function stats() {
    return index
      ? { builtAt: index.builtAt, buildMs: index.buildMs, counts: index.counts, iconBytes: index.iconBytes, iconsOmitted: index.iconsOmitted, fromCache: !!index.fromCache, stopped }
      : { builtAt: 0, buildMs: 0, counts: null, iconBytes: 0, iconsOmitted: false, fromCache: false, stopped };
  }

  /**
   * The target path of an installed exe-backed app by the basename of its
   * executable WITHOUT `.exe` ('spotify', 'valorant-win64-shipping') -- the
   * shape a stats sample's process key has. For the icon lookup, which wants
   * "where does this running process live?" and must never pay for a build:
   * this reads the index ALREADY in memory and answers null when there is
   * none, so the first call of a session can miss and the next one hit.
   * Store entries are skipped -- their `path` is an AppID, not a file.
   *
   * @param {string} base exe basename without the extension, any case
   * @returns {string|null} a full path, or null
   */
  function pathForExe(base) {
    const want = String(base == null ? '' : base).trim().toLowerCase();
    if (!want || want.indexOf('\\') !== -1 || want.indexOf('/') !== -1) return null;
    const file = want.slice(-4) === '.exe' ? want : want + '.exe';
    const list = (index && Array.isArray(index.apps)) ? index.apps : null;
    if (!list) return null;
    for (const entry of list) {
      if (!entry || entry.kind !== 'exe') continue;
      if ((entry.exe || '') !== file) continue;
      if (typeof entry.path === 'string' && entry.path) return entry.path;
    }
    return null;
  }

  return { list, refresh, launch, focus, icon, stop, stats, cachePath, pathForExe };
}

module.exports = {
  create,
  // pure parts, for the harness
  isAppShortcutName,
  isLaunchableTarget,
  exeBaseName,
  entryId,
  parseStartApps,
  parsePsPayload,
  parseAppxApps,
  applyStoreExes,
  finalizeOrder,
  looksX86,
  appIdExeBase,
  isSafeAppId,
  isDocAppId,
  nameKey,
  mergeApps,
  buildShortcutEntry,
  startMenuRoots,
  focusScript,
  normalizePids,
  encodeCommand,
  splitArgs,
  lnkWantsElevation,
  expandEnv,
  LNK_RUNAS_FLAG,
  SKIP_NAME_RE,
  TARGET_EXTS,
  CACHE_NAME,
  CACHE_VERSION,
  MAX_AGE_MS,
  ICON_BATCH,
  MAX_DEPTH,
  MAX_SHORTCUTS,
  DOC_TARGET_EXTS,
  STARTAPPS_ARGS,
  STARTAPPS_SCRIPT,
  APPS_MARKER,
  APPX_MARKER,
  STARTAPPS_TIMEOUT_MS,
  FOCUS_TIMEOUT_MS,
  FOCUS_PID_MAX,
  FOCUS_VIA,
  ICON_BUDGET_BYTES
};
