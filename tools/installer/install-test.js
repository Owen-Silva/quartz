#!/usr/bin/env node
'use strict';
/*
 * tools/installer/install-test.js -- install Quartz-Setup.exe for real, use it, uninstall it.
 *
 *   node tools/installer/install-test.js dist/Quartz-Setup.exe
 *
 * GitHub Actions only (it refuses anywhere else): it installs into this user's
 * %LOCALAPPDATA%\Programs\Quartz, launches the installed Quartz twice, makes it register as a
 * browser, and uninstalls it again. On a person's machine that would replace their Quartz.
 *
 *   1. silent install (/S); the files, the Start Menu shortcut and its app id, the uninstall entry;
 *      no test or developer files shipped
 *   2. native modules under the installed runtime (native-check.js): node-pty runs a real ConPTY
 *      session, koffi calls kernel32
 *   3. launch on a test profile (off-screen): the window boots, the chrome is there, a Command
 *      Prompt runs in a pty from the window's own bridge, the updater knows it is an installed copy
 *   4. launch on the real profile: no profile move ("installed"), the updater is ON and checks
 *      GitHub releases, and the default-browser registration writes this install's exe
 *   5. silent uninstall: files, shortcut and uninstall entry gone, the registration gone, and the
 *      profile kept
 * Last line: "install-test: N passed, M failed".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const SETUP = path.resolve(process.argv[2] || 'dist/Quartz-Setup.exe');
const ROOT = path.join(__dirname, '..', '..');
const LOCAL = process.env.LOCALAPPDATA;
const ROAMING = process.env.APPDATA;
const INST = path.join(LOCAL, 'Programs', 'Quartz');
const EXE = path.join(INST, 'Quartz.exe');
const APPDIR = path.join(INST, 'resources', 'app');
const SHORTCUT = path.join(ROAMING, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Quartz.lnk');
const PROFILE = path.join(ROAMING, 'Quartz');
const AUMID = 'com.owensilva.quartz';
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log('PASS ' + label + (detail !== undefined ? ' :: ' + short(detail) : '')); }
  else { fail++; console.log('FAIL ' + label + (detail !== undefined ? ' :: ' + short(detail) : '')); }
  return !!cond;
}
function info(line) { console.log('     ' + line); }
function short(v) { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 400 ? s.slice(0, 400) + '…' : s; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reg(key, name) {
  const args = ['query', key];
  if (name === '') args.push('/ve'); else if (name) args.push('/v', name);
  const r = spawnSync('reg.exe', args, { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const line = r.stdout.split(/\r?\n/).find((l) => /\sREG_\w+\s/.test(l));
  return line ? line.replace(/^.*?\sREG_\w+\s+/, '').trim() : '';
}
function regKeyExists(key) { return spawnSync('reg.exe', ['query', key], { encoding: 'utf8' }).status === 0; }
function uninstallEntry() {
  const r = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'Quartz', '/d'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const blocks = r.stdout.split(/\r?\n\r?\n/).filter((b) => /DisplayName\s+REG_SZ\s+Quartz/.test(b));
  return blocks.length ? blocks[0].trim() : null;
}
function ps(cmd) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
  return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}
function walk(dir, max) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < max) {
    const d = stack.pop();
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) stack.push(p); else out.push(p);
    }
  }
  return out;
}
function dirSize(dir) { let n = 0; for (const f of walk(dir, 200000)) { try { n += fs.statSync(f).size; } catch { /* gone */ } } return n; }

/* ---- CDP ---------------------------------------------------------------------------------- */

async function chromeTarget(port, ms) {
  const until = Date.now() + ms;
  let last = '';
  while (Date.now() < until) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const t = list.find((x) => x.type === 'page' && /\/index\.html(\?|#|$)/.test(x.url));
      if (t) return t;
      last = list.map((x) => x.type + ' ' + x.url).join(', ');
    } catch (e) { last = e.message; }
    await sleep(500);
  }
  throw new Error('no chrome page target on port ' + port + ' within ' + (ms / 1000) + ' s (last: ' + last + ')');
}
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    };
    ws.onerror = () => reject(new Error('CDP socket error'));
    ws.onopen = () => resolve({
      send: (method, params) => new Promise((res, rej) => {
        const n = ++id;
        const t = setTimeout(() => { waiting.delete(n); rej(new Error(method + ' timed out')); }, 60000);
        waiting.set(n, (msg) => { clearTimeout(t); res(msg); });
        ws.send(JSON.stringify({ id: n, method, params: params || {} }));
      }),
      close: () => { try { ws.close(); } catch { /* closed */ } },
    });
  });
}
async function evaluate(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.error) throw new Error(r.error.message);
  if (r.result && r.result.exceptionDetails) throw new Error('page threw: ' + short(r.result.exceptionDetails.exception ? r.result.exceptionDetails.exception.description : r.result.exceptionDetails.text));
  return r.result && r.result.result ? r.result.result.value : undefined;
}

function launch(args, label) {
  const child = spawn(EXE, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  const logPath = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'quartz-install-test-' + label + '.log');
  const log = fs.createWriteStream(logPath);
  child.stdout.pipe(log); child.stderr.pipe(log);
  info('launched ' + label + ': pid ' + child.pid + ' (' + args.join(' ') + '), log ' + logPath);
  return { child, logPath };
}
async function stop(run, c) {
  // Ask nicely first (Browser.close quits the app the normal way), then this one pid tree only.
  if (c) { try { await c.send('Browser.close'); } catch { /* the socket closes as the app quits */ } c.close(); }
  const until = Date.now() + 15000;
  while (run.child.exitCode === null && Date.now() < until) await sleep(250);
  if (run.child.exitCode === null) {
    info('pid ' + run.child.pid + ' still running after Browser.close: ending its process tree');
    spawnSync('taskkill.exe', ['/PID', String(run.child.pid), '/T', '/F']);
    await sleep(1500);
  }
  // Anything still running from the install folder would hold its files open.
  const left = ps("Get-CimInstance Win32_Process | ? { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('" + INST.replace(/'/g, "''") + "\\', 'CurrentCultureIgnoreCase') } | % { $_.ProcessId }").out;
  if (left) { info('still running from the install folder: ' + left.replace(/\s+/g, ' ') + ': ending them'); for (const pid of left.split(/\s+/)) spawnSync('taskkill.exe', ['/PID', pid, '/T', '/F']); await sleep(1500); }
}
function logTail(run) { try { return fs.readFileSync(run.logPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-12).join(' | '); } catch { return '(no log)'; } }

/* ---- the test ------------------------------------------------------------------------------- */

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('refusing: this installs and uninstalls Quartz for the current user; it runs only on GitHub Actions');
  if (process.platform !== 'win32') throw new Error('Windows only');
  check(fs.existsSync(SETUP), 'installer exists: ' + SETUP);
  check(!fs.existsSync(INST), 'nothing installed before the test', INST);
  info('installer: ' + (fs.statSync(SETUP).size / 1048576).toFixed(1) + ' MB');

  /* 1. install */
  let t0 = Date.now();
  const inst = spawnSync(SETUP, ['/S'], { timeout: 600000 });
  check(inst.status === 0, 'silent install exits 0', { status: inst.status, error: inst.error && inst.error.message, seconds: ((Date.now() - t0) / 1000).toFixed(1) });
  for (let i = 0; i < 60 && !fs.existsSync(EXE); i++) await sleep(1000);
  if (!check(fs.existsSync(EXE), 'Quartz.exe installed', EXE)) {
    let where = [];
    try { where = fs.readdirSync(path.join(LOCAL, 'Programs')); } catch { /* none */ }
    info('%LOCALAPPDATA%\\Programs holds: ' + (where.join(', ') || '(nothing)'));
    throw new Error('the installer did not put Quartz.exe where the test expects it; nothing else can be checked');
  }
  info('installed size: ' + (dirSize(INST) / 1048576).toFixed(1) + ' MB in ' + walk(INST, 200000).length + ' files');
  let installedPkg = {};
  try { installedPkg = JSON.parse(fs.readFileSync(path.join(APPDIR, 'package.json'), 'utf8')); } catch { /* checked below */ }
  check(installedPkg.version === VERSION && installedPkg.main === 'main.js', 'resources/app/package.json: version ' + VERSION + ', main main.js', { version: installedPkg.version, main: installedPkg.main });
  for (const rel of ['main.js', 'preload.js', 'index.html', 'install-mode.js', 'updater.js', 'register-default-browser.ps1', 'spellhost.cs', 'adblock-build-worker.js', 'LICENSE',
    'node_modules/@homebridge/node-pty-prebuilt-multiarch/build/Release/conpty.node',
    'node_modules/@homebridge/node-pty-prebuilt-multiarch/build/Release/pty.node',
    'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',
    'node_modules/ws/package.json', 'node_modules/@xterm/xterm/package.json']) {
    check(fs.existsSync(path.join(APPDIR, rel)), 'shipped: ' + rel);
  }
  check(!fs.existsSync(path.join(APPDIR, 'node_modules', 'electron')), 'not shipped: node_modules/electron (the runtime is Quartz.exe itself)');
  check(fs.existsSync(path.join(INST, 'resources', 'default_app.asar')) === false, 'not shipped: Electron\'s default app');
  const devFiles = fs.readdirSync(APPDIR).filter((n) => /-e2e\.js$|-harness\.js$|^smoketest\.js$|^CLAUDE\.md$|^relink-shortcut\.ps1$/.test(n) || ['tests', 'tools', 'docs', '.github'].includes(n));
  check(devFiles.length === 0, 'no test or developer files shipped', devFiles.slice(0, 10));
  const uninstaller = path.join(INST, 'Uninstall Quartz.exe');
  check(fs.existsSync(uninstaller), 'uninstaller installed', uninstaller);
  check(fs.existsSync(SHORTCUT), 'Start Menu shortcut', SHORTCUT);
  const apps = ps("Get-StartApps | ? { $_.Name -eq 'Quartz' } | % { $_.AppID }");
  check(apps.out.split(/\r?\n/).map((s) => s.trim()).includes(AUMID), 'Start Menu entry carries the app id ' + AUMID + ' (toasts, taskbar grouping)', apps.out || apps.err);
  const entry = uninstallEntry();
  check(!!entry, 'listed in Settings > Apps (HKCU uninstall entry, DisplayName Quartz)', entry ? entry.split(/\r?\n/).filter((l) => /DisplayName|DisplayVersion|InstallLocation|QuietUninstallString/.test(l)).map((l) => l.trim()).join('; ') : 'missing');
  check(!!entry && new RegExp('DisplayVersion\\s+REG_SZ\\s+' + VERSION.replace(/\./g, '\\.')).test(entry), 'uninstall entry version ' + VERSION);
  const runningAfter = ps("Get-CimInstance Win32_Process | ? { $_.ExecutablePath -like '" + INST.replace(/'/g, "''") + "\\*' } | Measure-Object | % Count").out;
  info('processes from the install folder right after /S: ' + runningAfter + ' (a silent install does not start the app)');

  /* 2. native modules under the installed runtime */
  const nativeOut = path.join(os.tmpdir(), 'quartz-native-check.json');
  try { fs.unlinkSync(nativeOut); } catch { /* none */ }
  spawnSync(EXE, [path.join(__dirname, 'native-check.js'), APPDIR, nativeOut], { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), timeout: 60000 });
  let native = null;
  try { native = JSON.parse(fs.readFileSync(nativeOut, 'utf8')); } catch (e) { native = null; }
  check(!!native, 'native check ran under the installed Quartz.exe', native ? 'Electron ' + native.electron + ', Node ' + native.node + ', ABI ' + native.modules : 'no result file');
  if (native) {
    check(native.pty.ok, 'node-pty loads from the install and runs a ConPTY session', native.pty.why);
    check(native.koffi.ok, 'koffi loads from the install and calls kernel32', native.koffi.why);
  }

  /* 3. launch: test profile, off-screen */
  {
    const run = launch(['--test-profile', '--profile-name=installer-smoke', '--offscreen', '--show-inactive', '--remote-debugging-port=9555'], 'test-profile');
    let c = null;
    try {
      const target = await chromeTarget(9555, 90000);
      check(true, 'installed Quartz started and its window is up (CDP target)', target.url.replace(/^.*\/resources\/app\//i, 'resources/app/'));
      c = await cdp(target.webSocketDebuggerUrl);
      let booted = false;
      for (let i = 0; i < 120 && !booted; i++) { booted = await evaluate(c, "document.body.classList.contains('booted')"); if (!booted) await sleep(250); }
      check(booted, 'the chrome booted (body.booted)');
      const missing = await evaluate(c, "JSON.stringify(['tabstrip','newtab','omnibox','views','win-min','win-max','win-close'].filter((id) => !document.getElementById(id)))");
      check(missing === '[]', 'the chrome\'s controls are in the DOM', missing);
      const progs = await evaluate(c, 'window.api.pty.programs().then((p) => JSON.stringify(p))');
      info('pty programs: ' + progs);
      const ptyRun = await evaluate(c, `new Promise(async (resolve) => {
        let text = '';
        let id = null;
        const t = setTimeout(() => resolve({ ok: false, why: 'no output in 25 s', text: text.slice(-300) }), 25000);
        const off = window.api.pty.onData((p) => {
          if (!p || p.id !== id) return;
          text += p.data;
          if (/quartz-Windows_NT-ok/.test(text)) { clearTimeout(t); off(); window.api.pty.kill(id); resolve({ ok: true, id }); }
        });
        try { id = await window.api.pty.start({ program: 'cmd', cols: 100, rows: 30 }); } catch (e) { clearTimeout(t); resolve({ ok: false, why: 'start threw: ' + e.message }); return; }
        if (!id) { clearTimeout(t); resolve({ ok: false, why: 'pty:start refused (null)' }); return; }
        setTimeout(() => window.api.pty.write(id, 'echo quartz-%OS%-ok\\r'), 800);
      })`);
      check(ptyRun && ptyRun.ok, 'a Command Prompt runs in a pty from the installed app\'s own window (pty:start, main process)', ptyRun);
      const us = await evaluate(c, 'window.api.updates.state()');
      check(us && us.installed === true && us.status === 'off' && /test profile/.test(us.off), 'updater: knows it is an installed copy; a test profile stays off, saying why', us && { installed: us.installed, status: us.status, off: us.off });
    } catch (e) {
      check(false, 'test-profile launch', e.message + ' | log: ' + logTail(run));
    } finally {
      await stop(run, c);
    }
  }

  /* 4. launch: the real profile (this runner user's), where the installed-only paths run */
  const profileBefore = fs.existsSync(PROFILE);
  info('profile ' + PROFILE + ' before the real launch: ' + (profileBefore ? 'exists' : 'absent'));
  {
    const run = launch(['--remote-debugging-port=9556'], 'real-profile');
    let c = null;
    try {
      const target = await chromeTarget(9556, 90000);
      c = await cdp(target.webSocketDebuggerUrl);
      check(true, 'installed Quartz started on the real profile');
      const prof = await evaluate(c, 'window.api.app.profile()');
      check(prof && /\\Quartz$/i.test(prof.userData) && prof.thisStart && prof.thisStart.action === 'installed',
        'profile: %APPDATA%\\Quartz, and the one-time move from %APPDATA%\\browser is skipped for an installed copy', prof && { userData: prof.userData, action: prof.thisStart && prof.thisStart.action, why: prof.thisStart && prof.thisStart.why });
      let us = await evaluate(c, 'window.api.updates.state()');
      check(us && us.installed === true && us.status !== 'off', 'updater: ON in an installed copy', us && { status: us.status, off: us.off, enabled: us.enabled, current: us.current });
      us = await evaluate(c, 'window.api.updates.check()');
      const said = us && (us.status === 'current' || us.status === 'available' || us.status === 'none' || us.status === 'error');
      check(said && !(us.status === 'available' && !us.download), 'updater: a check of GitHub releases ends in a stated result (current / available with the installer link / none / error with its reason)',
        us && { status: us.status, release: us.release && us.release.tag, ahead: us.ahead, download: us.download, error: us.error, blocked: us.blocked });
      const before = reg('HKCU\\Software\\Classes\\QuartzURL\\shell\\open\\command', '');
      info('QuartzURL command before registering: ' + (before === null ? 'absent' : before));
      const made = await evaluate(c, 'window.api.firstrun.makeDefault()');
      info('makeDefault: ' + short(made));
      const want = '"' + EXE + '" "%1"';
      const gotUrl = reg('HKCU\\Software\\Classes\\QuartzURL\\shell\\open\\command', '');
      const gotHtml = reg('HKCU\\Software\\Classes\\QuartzHTML\\shell\\open\\command', '');
      const gotClient = reg('HKCU\\Software\\Clients\\StartMenuInternet\\Quartz\\shell\\open\\command', '');
      const gotApp = reg('HKCU\\Software\\RegisteredApplications', 'Quartz');
      check(made && made.registered !== false && gotUrl !== null && gotUrl.toLowerCase() === want.toLowerCase(), 'default-browser registration: links open the installed exe, no app folder argument', { want, got: gotUrl, state: made && made.state, reason: made && made.reason });
      check(gotHtml !== null && gotHtml.toLowerCase() === want.toLowerCase(), 'default-browser registration: .html files too', gotHtml);
      check(gotClient !== null && gotClient.toLowerCase() === ('"' + EXE + '"').toLowerCase() && !!gotApp, 'default-browser registration: the browser entry Settings lists', { client: gotClient, registeredApp: gotApp });
    } catch (e) {
      check(false, 'real-profile launch', e.message + ' | log: ' + logTail(run));
    } finally {
      await stop(run, c);
    }
  }
  const profileExists = fs.existsSync(PROFILE);
  check(profileExists, 'the real launch made the profile at %APPDATA%\\Quartz', PROFILE);
  check(!fs.existsSync(path.join(ROAMING, 'browser')), 'no %APPDATA%\\browser was created');

  /* 5. uninstall */
  t0 = Date.now();
  const un = spawnSync(uninstaller, ['/S'], { timeout: 300000 });
  info('uninstaller exit ' + un.status + ' after ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s (NSIS re-runs itself from TEMP; waiting for the folder to go)');
  for (let i = 0; i < 120 && (fs.existsSync(EXE) || uninstallEntry()); i++) await sleep(1000);
  check(!fs.existsSync(EXE), 'uninstall: Quartz.exe removed');
  const leftFiles = fs.existsSync(INST) ? walk(INST, 50) : [];
  check(leftFiles.length === 0, 'uninstall: nothing left in ' + INST, leftFiles.slice(0, 10));
  check(!fs.existsSync(SHORTCUT), 'uninstall: Start Menu shortcut removed');
  check(!uninstallEntry(), 'uninstall: gone from Settings > Apps');
  check(!regKeyExists('HKCU\\Software\\Classes\\QuartzURL') && !regKeyExists('HKCU\\Software\\Classes\\QuartzHTML'), 'uninstall: its link and .html handlers removed');
  check(!regKeyExists('HKCU\\Software\\Clients\\StartMenuInternet\\Quartz') && reg('HKCU\\Software\\RegisteredApplications', 'Quartz') === null, 'uninstall: its browser entry removed');
  check(fs.existsSync(PROFILE), 'uninstall: the profile (%APPDATA%\\Quartz) is kept');
}

main().catch((e) => { fail++; console.log('FAIL harness error: ' + ((e && e.stack) || e)); }).finally(() => {
  console.log('install-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
