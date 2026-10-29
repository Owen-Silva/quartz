'use strict';

/*
 * firstrun-main.js - main's half of the first-run welcome (welcome.html).
 *
 * Two jobs, nothing else:
 *
 *   1. THE FLAG. <userData>/first-run.json says whether this profile has been
 *      through the welcome. The welcome shows ONLY on a brand-new profile:
 *
 *        { state: 'pending' }                       shown, not finished yet
 *        { state: 'done', how: 'finished'|'skipped'|'existing-profile', at }
 *
 *      A profile with no flag is judged by what is ALREADY in it when this
 *      module loads (before the window exists, so before the chrome writes
 *      anything this run): session.json, window-state.json, permissions.json
 *      or a Local Storage folder (where bookmarks, history and settings live)
 *      means someone has used this profile, so it is marked done as
 *      'existing-profile' and the welcome never appears. A long-used profile has
 *      all four. A profile with none of them gets 'pending' and the welcome;
 *      'pending' survives a quit halfway, so the welcome comes back until it
 *      is finished or skipped.
 *
 *      Test runs (--test-profile) never see it unless they ask with
 *      --first-run, so every other harness boots exactly as before.
 *
 *   2. THE DEFAULT BROWSER. register-default-browser.ps1 (HKCU only, read back
 *      after writing) puts Quartz in Windows' list, then Windows Settings opens
 *      on Quartz's Default apps page, because Windows 11 only lets the USER
 *      press Set default. Every outcome comes back with a plain reason; nothing
 *      fails quietly.
 *
 * IPC (chrome window only; anyone else gets null):
 *   firstrun:state          -> { show, reason, flag, evidence, test }
 *   firstrun:done (how)     -> { ok, flag, reason? }
 *   firstrun:make-default   -> { state, ok, registered, settingsOpened, isDefault, reason, detail }
 *   firstrun:default-status -> { isDefault: true|false|null, app, reason }
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FLAG_FILE = 'first-run.json';
/** Files and folders that only exist once someone has used the profile. */
const EVIDENCE = ['session.json', 'window-state.json', 'permissions.json', 'Local Storage'];
const HOWS = ['finished', 'skipped', 'existing-profile'];
const SCRIPT_TIMEOUT_MS = 30000;
const SETTINGS_URI = 'ms-settings:defaultapps?registeredAppUser=Quartz';

function create(opts) {
  const o = opts || {};
  const app = o.app;
  const ipcMain = o.ipcMain;
  const shell = o.shell;
  const isChromeSender = typeof o.isChromeSender === 'function' ? o.isChromeSender : () => false;
  const appDir = o.appDir || __dirname;
  const argv = Array.isArray(o.argv) ? o.argv : process.argv;
  const env = o.env || process.env;
  const test = argv.includes('--test-profile');
  const optIn = argv.includes('--first-run');
  // An installed copy (install-mode.js): its exe is the one Windows should start, with no app
  // folder on the command line. A folder copy registers the stamped Quartz.exe and its folder.
  const installed = o.installed === true;
  const execPath = String(o.execPath || process.execPath);

  const dir = () => app.getPath('userData');
  const flagPath = () => path.join(dir(), FLAG_FILE);

  function readFlag() {
    try {
      const raw = JSON.parse(fs.readFileSync(flagPath(), 'utf8'));
      return raw && typeof raw === 'object' ? raw : null;
    } catch (err) {
      return null;
    }
  }

  function writeFlag(value) {
    const file = flagPath();
    const tmp = file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
      fs.renameSync(tmp, file);
      return { ok: true };
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch (e) { /* nothing to tidy */ }
      return { ok: false, reason: 'could not write ' + FLAG_FILE + ': ' + ((err && err.message) || err) };
    }
  }

  // What the profile held BEFORE this run touched it. Taken now, at module
  // load: the chrome writes session.json seconds after the window opens.
  const evidence = [];
  try {
    for (const name of EVIDENCE) {
      if (fs.existsSync(path.join(dir(), name))) evidence.push(name);
    }
  } catch (err) { /* an unreadable profile is judged below as having no flag */ }

  let decided = null;

  /** The one decision, made once per run (the first time the chrome asks). */
  function decide() {
    if (decided) return decided;
    const flag = readFlag();
    if (flag && flag.state === 'done') {
      decided = { show: false, reason: 'done', flag, evidence, test };
    } else if (flag && flag.state === 'pending') {
      decided = { show: true, reason: 'pending', flag, evidence, test };
    } else if (evidence.length) {
      // Someone already lives here: set up, for good, without asking.
      const value = { state: 'done', how: 'existing-profile', evidence, at: new Date().toISOString() };
      const w = writeFlag(value);
      decided = { show: false, reason: 'existing-profile', flag: value, evidence, test, writeError: w.ok ? undefined : w.reason };
    } else if (test && !optIn) {
      decided = { show: false, reason: 'test-profile', flag: null, evidence, test };
    } else {
      const value = { state: 'pending', at: new Date().toISOString() };
      const w = writeFlag(value);
      decided = { show: true, reason: 'new-profile', flag: value, evidence, test, writeError: w.ok ? undefined : w.reason };
    }
    return decided;
  }

  function markDone(how) {
    const h = HOWS.indexOf(how) >= 0 ? how : 'finished';
    const value = { state: 'done', how: h, at: new Date().toISOString() };
    const before = readFlag();
    if (before && before.how && before.state === 'done') value.first = before.first || { how: before.how, at: before.at };
    const w = writeFlag(value);
    if (w.ok) decided = { show: false, reason: 'done', flag: value, evidence, test };
    return w.ok ? { ok: true, flag: value } : { ok: false, flag: before, reason: w.reason };
  }

  /* ---- the default browser ---------------------------------------------------------------- */

  const quartzExe = installed ? execPath : path.join(appDir, 'node_modules', 'electron', 'dist', 'Quartz.exe');

  /** Is Quartz what Windows opens https links with right now? Asked of Windows itself. */
  async function defaultStatus() {
    // Test profiles never read the machine's real default browser: the answer comes from
    // QUARTZ_TEST_DEFAULT_STATUS ('default' = Quartz is it; anything else = it is not), so a
    // harness passes the same whatever the person running it has picked in Windows.
    if (test) {
      return String(env.QUARTZ_TEST_DEFAULT_STATUS || '') === 'default'
        ? { isDefault: true, app: 'Quartz', path: quartzExe, reason: '', simulated: true }
        : { isDefault: false, app: 'Test stand-in browser', path: '', reason: '', simulated: true };
    }
    if (process.platform !== 'win32') return { isDefault: null, app: '', reason: 'only Windows has a default-browser setting Quartz can read' };
    if (!app || typeof app.getApplicationInfoForProtocol !== 'function') {
      return { isDefault: null, app: '', reason: 'this Electron cannot ask Windows which app opens links' };
    }
    try {
      const info = await app.getApplicationInfoForProtocol('https://example.com/');
      const exe = String((info && info.path) || '');
      const name = String((info && info.name) || '');
      const norm = (p) => path.resolve(p).toLowerCase();
      const ours = !!exe && (norm(exe) === norm(quartzExe) || norm(exe) === norm(process.execPath));
      return { isDefault: ours, app: name || path.basename(exe) || '', path: exe, reason: '' };
    } catch (err) {
      // No handler at all is an answer too: it is not Quartz.
      const msg = String((err && err.message) || err || '');
      return { isDefault: false, app: '', reason: msg ? 'Windows said: ' + msg : '' };
    }
  }

  /** The script's last useful line from stderr (PowerShell wraps a throw in position noise). */
  function errorLine(stderr, stdout, code) {
    // PowerShell wraps a long message over several lines, then adds "At <file>:<line>" and
    // "+ ..." position noise: keep the message lines, joined, and drop the rest.
    const msg = [];
    for (const l of String(stderr || '').split(/\r?\n/).map((x) => x.trim())) {
      if (/^(At |\+ |\+$|CategoryInfo|FullyQualifiedErrorId)/.test(l)) break;
      if (l) msg.push(l);
    }
    // "C:\...\register-default-browser.ps1 : <message>" -> "<message>"
    if (msg.length) return msg.join(' ').replace(/^\S.*?\.ps1\s*:\s*/i, '').slice(0, 300);
    const bad = String(stdout || '').split(/\r?\n/).filter((l) => /BAD|NOT registered/i.test(l));
    if (bad.length) return bad[bad.length - 1].trim().slice(0, 300);
    return 'the registration script stopped with exit code ' + code;
  }

  function runScript() {
    let script = path.join(appDir, 'register-default-browser.ps1');
    // Tests only: a stand-in script (a failure on purpose, say). A test profile NEVER runs the
    // real one: it writes HKCU and points Quartz's registration at whatever folder it runs from,
    // so a test from a worktree once re-pointed the machine's real default browser at it.
    if (test) {
      if (!env.QUARTZ_TEST_DEFAULT_SCRIPT) {
        const reason = 'test profiles never run the real registration script (set QUARTZ_TEST_DEFAULT_SCRIPT to a stand-in)';
        console.error('[firstrun] REFUSED: ' + reason);
        return Promise.resolve({ ok: false, refused: true, reason });
      }
      script = String(env.QUARTZ_TEST_DEFAULT_SCRIPT);
    }
    return new Promise((resolve) => {
      if (!fs.existsSync(script)) {
        resolve({ ok: false, reason: 'the registration script is missing (' + path.basename(script) + ')', detail: script });
        return;
      }
      let out = '';
      let err = '';
      let done = false;
      let child;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      try {
        const scriptArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
        if (installed) scriptArgs.push('-InstalledExe', execPath);
        child = spawn('powershell.exe', scriptArgs, {
          windowsHide: true, cwd: appDir,
        });
      } catch (e) {
        finish({ ok: false, reason: 'PowerShell could not start: ' + ((e && e.message) || e) });
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch (e) { /* already gone */ }
        finish({ ok: false, reason: 'Windows took longer than ' + (SCRIPT_TIMEOUT_MS / 1000) + ' seconds to answer', detail: out.slice(-800) });
      }, SCRIPT_TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, reason: 'PowerShell could not start: ' + ((e && e.message) || e) }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const registered = code === 0 && /Registered\./.test(out);
        if (registered) finish({ ok: true, detail: out.slice(-1200) });
        else finish({ ok: false, reason: errorLine(err, out, code), detail: (out + '\n' + err).slice(-1200) });
      });
    });
  }

  async function openSettings() {
    // Tests: never open a real Settings window on the runner; say what would have happened.
    if (test) {
      const mode = String(env.QUARTZ_TEST_SETTINGS || 'open');
      if (mode === 'fail') return { ok: false, reason: 'Windows Settings did not open (test stand-in)' };
      return { ok: true, simulated: true };
    }
    if (!shell || typeof shell.openExternal !== 'function') return { ok: false, reason: 'this Electron cannot open Windows Settings' };
    try {
      await shell.openExternal(SETTINGS_URI);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'Windows Settings did not open: ' + ((err && err.message) || err) };
    }
  }

  let busy = null;
  async function makeDefault() {
    if (busy) return busy;
    busy = (async () => {
      if (process.platform !== 'win32') return { state: 'failed', ok: false, reason: 'only Windows is supported here' };
      const before = await defaultStatus();
      if (before.isDefault === true) return { state: 'confirmed', ok: true, registered: true, settingsOpened: false, isDefault: true, reason: '' };
      const reg = await runScript();
      if (!reg.ok) return { state: 'failed', ok: false, registered: false, settingsOpened: false, isDefault: false, reason: reg.reason, detail: reg.detail };
      const open = await openSettings();
      return {
        state: open.ok ? 'settings-opened' : 'registered',
        ok: true,
        registered: true,
        settingsOpened: !!open.ok,
        simulated: !!open.simulated,
        isDefault: false,
        reason: open.ok ? '' : open.reason,
      };
    })();
    try { return await busy; } finally { busy = null; }
  }

  /* ---- IPC ------------------------------------------------------------------------------------ */

  if (ipcMain) {
    ipcMain.handle('firstrun:state', (event) => (isChromeSender(event) ? decide() : null));
    ipcMain.handle('firstrun:done', (event, how) => (isChromeSender(event) ? markDone(String(how || '')) : null));
    ipcMain.handle('firstrun:make-default', (event) => (isChromeSender(event) ? makeDefault() : null));
    ipcMain.handle('firstrun:default-status', (event) => (isChromeSender(event) ? defaultStatus() : null));
  }

  return { decide, markDone, defaultStatus, makeDefault, evidence: () => evidence.slice(), _flagPath: flagPath };
}

module.exports = { create, FLAG_FILE, EVIDENCE };
