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

/** Bump when the entry shape changes so an old cache is rebuilt, not trusted. */
const CACHE_VERSION = 1;

/** A day. Apps are installed rarely; a stale icon is cheaper than a rebuild. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  '\\brelease notes\\b',
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
    const key = nameKey(item.name);
    if (key && byName.has(key)) continue;
    const exe = appIdExeBase(item.appId);
    if (exe && byExe.has(exe)) continue;
    if (key) byName.add(key);
    if (exe) byExe.add(exe);
    out.push({
      id: entryId('store', item.appId),
      name: item.name,
      kind: 'store',
      path: item.appId,
      args: '',
      exe: exe,
      lnk: null,
      iconDataUrl: null
    });
  }

  out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));
  return out;
}

/**
 * Shape one resolved shortcut into an entry, or null when it is not an app.
 * @param {string} lnkPath  full path to the .lnk
 * @param {{target?:string, args?:string, icon?:string}} link  readShortcutLink result
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

/** The PowerShell that produces the Store list. One run, one line. */
const STARTAPPS_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-Command',
  'Get-StartApps | ConvertTo-Json -Compress'
];

/**
 * The focus script, as PowerShell source. Handed over as -EncodedCommand
 * (base64 UTF-16LE) so no amount of quoting can go wrong, and so the pid is
 * the only thing interpolated -- after a Number.isInteger check.
 *
 * MainWindowHandle is 0 for some multi-process apps (the Store Notepad among
 * them: the pid that owns the window is not always the pid the stats sampler
 * reported first), so a sibling of the same name that DOES have a window is
 * the fallback. Minimised windows are restored; SetForegroundWindow is allowed
 * to fail and SwitchToThisWindow finishes the job.
 */
function focusScript(pid) {
  return [
    '$ErrorActionPreference = \'SilentlyContinue\'',
    'Add-Type -Namespace Br -Name Fg -MemberDefinition @\'',
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);',
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '\'@',
    '$p = Get-Process -Id ' + pid,
    'if (-not $p) { \'no-process\'; exit 0 }',
    '$h = $p.MainWindowHandle',
    'if ($h -eq 0) {',
    '  $sib = Get-Process -Name $p.ProcessName | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    '  if ($sib) { $h = $sib.MainWindowHandle }',
    '}',
    'if ($h -eq 0) { \'no-window\'; exit 0 }',
    'if ([Br.Fg]::IsIconic($h)) { [Br.Fg]::ShowWindow($h, 9) | Out-Null }',
    '[Br.Fg]::SetForegroundWindow($h) | Out-Null',
    'if ([Br.Fg]::GetForegroundWindow() -ne $h) { [Br.Fg]::SwitchToThisWindow($h, $true) }',
    'if ([Br.Fg]::GetForegroundWindow() -eq $h) { \'ok\' } else { \'ok-partial\' }'
  ].join('\n');
}

/** PowerShell's -EncodedCommand wants base64 of UTF-16LE. */
function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

/**
 * @param {{app?:object, shell?:object, env?:object, userDataPath?:string}} deps
 *   `app` and `shell` are Electron's; they are injected rather than required
 *   here so the pure half of this file loads under plain node.
 */
function create(deps = {}) {
  const electronApp = deps.app || null;
  const electronShell = deps.shell || null;
  const env = deps.env || process.env;

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
        let entry = null;
        try { entry = buildShortcutEntry(file, link); } catch { entry = null; }
        if (entry) out.push(entry);
      }
      // readShortcutLink is a COM call per file; yield on the same cadence as
      // the icon batches so ~100 of them cannot hold the loop.
      if (++i % ICON_BATCH === 0) await new Promise((r) => setImmediate(r));
    }
    return out;
  }

  // -- Source 2: Get-StartApps ---------------------------------------------

  /** One PowerShell, one timeout, [] on any trouble. */
  function readStartApps() {
    return new Promise((resolve) => {
      let child = null;
      try {
        child = spawn('powershell.exe', STARTAPPS_ARGS, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve([]);
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
        finish([]);
      }, STARTAPPS_TIMEOUT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
      try {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { if (out.length < 4 * 1024 * 1024) out += chunk; });
      } catch { /* no stdout: the close handler still fires */ }
      child.on('error', () => finish([]));
      child.on('close', () => {
        let parsed = [];
        try { parsed = parseStartApps(out); } catch { parsed = []; }
        finish(parsed);
      });
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
      iconDataUrl: withIcon ? (entry.iconDataUrl || null) : null
    };
  }

  async function buildIndex() {
    const t0 = Date.now();
    let shortcuts = [];
    let store = [];
    // Both sources at once: the PowerShell spawn is dead time otherwise.
    try {
      const [a, b] = await Promise.all([
        readShortcutEntries().catch(() => []),
        readStartApps().catch(() => [])
      ]);
      shortcuts = Array.isArray(a) ? a : [];
      store = Array.isArray(b) ? b : [];
    } catch {
      shortcuts = [];
      store = [];
    }

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
      counts: { shortcuts: shortcuts.length, store: store.length, total: apps.length }
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
        exe: a.exe || null, lnk: a.lnk || null, iconPath: a.iconPath || null,
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
   * Start an app. Detached and never awaited past the handoff: the point is
   * that the click feels instant, and Windows owns the process from there.
   *   exe   -> ShellExecute on the .lnk, which keeps its args AND working dir
   *   store -> explorer.exe shell:AppsFolder\<AppID>
   */
  async function launch(id) {
    const key = String(id || '');
    if (!key) return { ok: false, reason: 'no app id' };
    const idx = await ensureIndex();
    const entry = idx.apps.find((a) => a.id === key);
    if (!entry) return { ok: false, reason: 'that app is not in the index' };

    if (entry.kind === 'exe') {
      const target = entry.lnk || entry.path;
      if (!electronShell || typeof electronShell.openPath !== 'function') {
        return { ok: false, reason: 'unavailable' };
      }
      try {
        const err = await electronShell.openPath(target);
        return err ? { ok: false, reason: String(err) } : { ok: true, reason: '' };
      } catch (e) {
        return { ok: false, reason: (e && e.message) || 'failed' };
      }
    }

    if (!isSafeAppId(entry.path)) return { ok: false, reason: 'bad app id' };
    try {
      const child = spawn('explorer.exe', ['shell:AppsFolder\\' + entry.path], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.on('error', () => { /* explorer is always there; never throw at the page */ });
      child.unref();                                       // its life is not ours
      return { ok: true, reason: '' };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || 'failed' };
    }
  }

  /**
   * Bring a running app's main window forward. This one is ALLOWED to steal
   * focus: it only ever runs because the user clicked a tile whose dot was lit.
   */
  function focus(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return Promise.resolve({ ok: false, reason: 'bad pid' });
    return new Promise((resolve) => {
      let child = null;
      try {
        child = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-EncodedCommand', encodeCommand(focusScript(n))
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
        const line = out.trim().split(/\r?\n/).pop() || '';
        if (line === 'ok' || line === 'ok-partial') return finish({ ok: true, reason: line === 'ok' ? '' : 'partial' });
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
  appIdExeBase,
  isSafeAppId,
  nameKey,
  mergeApps,
  buildShortcutEntry,
  startMenuRoots,
  focusScript,
  encodeCommand,
  SKIP_NAME_RE,
  TARGET_EXTS,
  CACHE_NAME,
  CACHE_VERSION,
  MAX_AGE_MS,
  ICON_BATCH,
  MAX_DEPTH,
  MAX_SHORTCUTS,
  STARTAPPS_ARGS,
  STARTAPPS_TIMEOUT_MS,
  FOCUS_TIMEOUT_MS,
  ICON_BUDGET_BYTES
};
