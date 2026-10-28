'use strict';
/*
 * updater-main.js -- updater.js inside Quartz's main process: the IPC the chrome talks to
 * (updater-chrome.js), the six-hourly timer, and the restart at the end of an update.
 *
 * WHO NEVER CHECKS. updater.js already turns itself fully off for the opt-out file
 * (no-updates.local in the app folder) and for a linked git worktree. On top of that:
 *   - a test profile (--test-profile) or any other --test run: off, unless an e2e hands it a fake
 *     release API (QUARTZ_TEST_UPDATER_API, honoured ONLY with --test-profile), and even then
 *     it never runs npm ci (allowNpm false);
 *   - a packaged build: there is no git folder to move.
 *
 * THE RESTART. A plain update (no new dependencies) asks the chrome to run window.restartBrowser():
 * the same path as Settings > About > Restart browser, which writes the session first and then
 * app.relaunch() + app.quit(). An update with new dependencies starts the swap helper (node from
 * PATH) and quits without relaunching: the helper waits for this process to end, merges, swaps
 * node_modules and starts Quartz again with this process's own command line. If the chrome does
 * not answer within a few seconds, main does the same itself.
 */
const path = require('path');
const { spawn } = require('child_process');
const U = require('./updater');

const CHROME_GRACE_MS = 6000;

function install(o) {
  const { app, ipcMain, send, isChromeSender } = o;
  const argv = process.argv;
  const testProfile = argv.includes('--test-profile');
  const testApi = testProfile ? String(process.env.QUARTZ_TEST_UPDATER_API || '') : '';
  let off = '';
  if (app.isPackaged) off = 'a packaged build never updates itself from git';
  else if (testProfile && !testApi) off = 'a test profile never checks for updates';
  else if (argv.some((a) => /^--test(?:$|[-=])/.test(a) && a !== '--test-profile')) off = 'a test run never checks for updates';

  const say = (line) => console.log('[updates] ' + line);
  const updater = U.createUpdater({
    appDir: app.getAppPath(),
    dataDir: app.getPath('userData'),
    apiBase: testApi || undefined,
    repoUrl: testApi ? (process.env.QUARTZ_TEST_UPDATER_REPO || undefined) : undefined,
    firstCheckMs: testApi ? (Number(process.env.QUARTZ_TEST_UPDATER_FIRST_MS) || 1500) : undefined,
    allowNpm: !testProfile,
    off,
    onState: (s) => { try { send('updates:state', s); } catch { /* no window yet */ } },
    log: (line) => { if (!/^ {2}npm: |^git /.test(line)) say(line); },
    // quartz.log (log.js): the release-signature outcome and failed updates, in addition to
    // updater.log and the card. main.js passes logLine once its log is up.
    record: (line) => { if (typeof o.logLine === 'function') { try { o.logLine(line); } catch { /* best effort */ } } },
  });

  let restarting = null;   // { mode, timer } once an update is ready to restart
  let quitting = false;

  function plainRestart() {
    if (quitting) return;
    quitting = true;
    app.relaunch();
    app.quit();
  }

  /** Start the swap helper, and quit only once it is really running. */
  function swapRestart() {
    if (quitting) return;
    quitting = true;
    let plan;
    try {
      plan = updater.swapPlan({ pid: process.pid, exe: process.execPath, args: argv.slice(1), cwd: process.cwd() });
    } catch (e) {
      quitting = false;
      updater.abandonSwap('the update helper\'s plan could not be written: ' + e.message);
      return;
    }
    let child;
    try {
      child = spawn('node', [plan.script, plan.planPath], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(plan.script) });
    } catch (e) {
      quitting = false;
      updater.abandonSwap('the update helper could not start: ' + e.message);
      return;
    }
    child.once('error', (e) => {
      quitting = false;
      updater.abandonSwap(e.code === 'ENOENT' ? 'node was not found on PATH, so the update helper could not start' : 'the update helper could not start: ' + e.message);
    });
    child.once('spawn', () => {
      child.unref();
      say('the swap helper is running (pid ' + child.pid + '); quitting');
      app.quit();
    });
  }

  function armRestart(mode) {
    if (restarting) clearTimeout(restarting.timer);
    restarting = { mode, timer: setTimeout(() => { say('the chrome did not restart Quartz; main does it'); go(mode); }, CHROME_GRACE_MS) };
    const asked = send('updates:restart', { mode });
    if (asked === false) { clearTimeout(restarting.timer); go(mode); }
  }
  function go(mode) { if (mode === 'swap') swapRestart(); else plainRestart(); }

  const guard = (fn) => (event, ...a) => {
    if (!isChromeSender(event)) throw new Error('updates: not the browser window');
    return fn(...a);
  };
  ipcMain.handle('updates:state', guard(() => updater.state()));
  ipcMain.handle('updates:check', guard(() => updater.check({ manual: true })));
  ipcMain.handle('updates:set', guard((on) => updater.setEnabled(!!on)));
  ipcMain.handle('updates:later', guard(() => updater.later()));
  ipcMain.handle('updates:update', guard(async () => {
    const r = await updater.update();
    if (r.ok) armRestart(r.relaunch);
    return Object.assign({}, r, { state: updater.state() });
  }));
  // The chrome has written its session; the restart can go (a plain one goes through app:restart).
  ipcMain.on('updates:restart-now', (event) => {
    if (!isChromeSender(event) || !restarting) return;
    clearTimeout(restarting.timer);
    go(restarting.mode);
  });
  ipcMain.handle('updates:open-log', guard(() => {
    const { shell } = require('electron');
    shell.showItemInFolder(updater.paths.logPath);
    return true;
  }));
  // Any quit that starts (the chrome's restartBrowser() -> app:restart, or the swap's quit) ends
  // the wait for the chrome: main's own fallback must not run a second restart over it.
  app.on('before-quit', () => {
    quitting = true;
    if (restarting) clearTimeout(restarting.timer);
    updater.stop();
  });
  return {
    start: () => updater.start(),
    state: () => updater.state(),
  };
}

module.exports = { install };
