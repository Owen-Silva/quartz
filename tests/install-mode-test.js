'use strict';
/*
 * install-mode-test.js -- the installed-copy paths, in plain node:
 *   1. install-mode.js installedCopy(): an installed copy is told apart from a folder copy, including
 *      a folder copy started through the stamped Quartz.exe (which Electron calls "packaged").
 *   2. updater.js with installed: true: a temp app folder with no .git, a fake releases API. The
 *      version decides; a newer release carries the installer link instead of an Update button;
 *      update() refuses with a reason; a folder copy's state never carries the link.
 *   3. The installer link is the same stable asset name in both files.
 * No git, no network, no Electron.
 *
 *   node tests/install-mode-test.js    -> "install-mode-test: N passed, M failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../install-mode');
const U = require('../updater');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log('PASS ' + label); }
  else { fail++; console.log('FAIL ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}

/* ---- 1. installedCopy() ------------------------------------------------------------------- */
const W = 'win32';
const inst = 'C:\\Users\\u\\AppData\\Local\\Programs\\Quartz';
check(M.installedCopy({ appPath: inst + '\\resources\\app', resourcesPath: inst + '\\resources', platform: W }) === true,
  'installed: app inside its own resources folder');
check(M.installedCopy({ appPath: inst + '\\resources\\app.asar', resourcesPath: inst + '\\resources', platform: W }) === true,
  'installed: an asar app counts too');
check(M.installedCopy({ appPath: inst.toUpperCase() + '\\RESOURCES\\APP', resourcesPath: inst + '\\resources', platform: W }) === true,
  'installed: Windows paths compare without case');
const clone = 'C:\\src\\quartz';
check(M.installedCopy({ defaultApp: true, appPath: clone, resourcesPath: clone + '\\node_modules\\electron\\dist\\resources', platform: W }) === false,
  'folder copy via the stamped Quartz.exe (default app): not installed');
check(M.installedCopy({ defaultApp: true, appPath: inst + '\\resources\\app', resourcesPath: inst + '\\resources', platform: W }) === false,
  'default app set: never installed, whatever the paths');
check(M.installedCopy({ appPath: clone, resourcesPath: clone + '\\node_modules\\electron\\dist\\resources', platform: W }) === false,
  'app folder outside resources: not installed');
check(M.installedCopy({ appPath: inst + '\\resources', resourcesPath: inst + '\\resources', platform: W }) === false,
  'app path equal to resources itself: not installed');
check(M.installedCopy({ appPath: inst + '\\resources-old\\app', resourcesPath: inst + '\\resources', platform: W }) === false,
  'a sibling folder that only shares the prefix: not installed');
check(M.installedCopy({}) === false && M.installedCopy(null) === false, 'nothing known: not installed');
check(M.installedCopy({ appPath: '/opt/Quartz/resources/app', resourcesPath: '/opt/Quartz/resources', platform: 'linux' }) === true,
  'posix paths work the same way');

/* ---- 3. one link ---------------------------------------------------------------------------- */
check(M.INSTALLER_URL === U.INSTALLER_URL && /\/releases\/latest\/download\/Quartz-Setup\.exe$/.test(M.INSTALLER_URL),
  'installer link: stable asset name, same in install-mode.js and updater.js', [M.INSTALLER_URL, U.INSTALLER_URL]);

/* ---- 2. the updater in installed mode -------------------------------------------------------- */
function fakeApi() {
  const api = { status: 200, body: null, calls: 0 };
  api.fetch = async () => {
    api.calls++;
    return { status: api.status, ok: api.status >= 200 && api.status < 300, statusText: '', headers: { get: () => null }, json: async () => api.body };
  };
  api.releaseOf = (tag) => { api.status = 200; api.body = { tag_name: tag, name: 'Quartz ' + tag, html_url: 'https://example.invalid/' + tag, body: 'notes' }; };
  return api;
}
const noTimers = { setTimeout: () => 0, clearTimeout: () => {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-install-mode-'));
function appFolder(name, version) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'browser', version }));
  const data = path.join(tmp, name + '-data');
  fs.mkdirSync(data, { recursive: true });
  return { dir, data };
}

(async () => {
  try {
    {
      const f = appFolder('installed', '0.1.1');
      const api = fakeApi();
      const up = U.createUpdater({ appDir: f.dir, dataDir: f.data, fetch: api.fetch, timers: noTimers, installed: true });
      let s = up.state();
      check(s.status === 'idle' && s.installed === true && !s.off, 'installed: not off, and the state says installed', s);

      api.releaseOf('v0.1.0');
      s = await up.check({ manual: true });
      check(s.status === 'current' && s.ahead === true && !s.download, 'installed: an older release is current (ahead), no link', s);

      api.releaseOf('v0.1.1');
      s = await up.check({ manual: true });
      check(s.status === 'current' && s.ahead === false && !s.download, 'installed: the same version is current, no link', s);

      api.releaseOf('v0.2.0');
      s = await up.check({ manual: true });
      check(s.status === 'available' && s.canUpdate === false && s.download === U.INSTALLER_URL,
        'installed: a newer release is available with the installer link', s);
      check(/installed with Quartz-Setup\.exe/.test(s.blocked) && Array.isArray(s.manual) && s.manual.length === 0,
        'installed: the reason names the installer, and there are no git commands to copy', s.blocked);
      const r = await up.update();
      check(r.ok === false && /installer/.test(r.reason), 'installed: update() refuses and says why', r);
      check(fs.readdirSync(f.dir).join(',') === 'package.json', 'installed: update() touched nothing in the app folder', fs.readdirSync(f.dir));

      api.status = 503; api.body = null;
      s = await up.check({ manual: true });
      check(s.status === 'error' && /503/.test(s.error), 'installed: a failed check says so, with the answer', s.error);
      up.stop();
    }
    {
      const f = appFolder('installed-optout', '0.1.1');
      fs.writeFileSync(path.join(f.dir, U.OPT_OUT_FILE), '');
      const up = U.createUpdater({ appDir: f.dir, dataDir: f.data, fetch: fakeApi().fetch, timers: noTimers, installed: true });
      const s = up.state();
      check(s.status === 'off' && /no-updates\.local/.test(s.off), 'installed: the opt-out file still turns it off, with the reason', s.off);
    }
    {
      // A folder that is not a clone and not installed (a zip): unchanged, git commands and no link.
      const f = appFolder('zip', '0.1.1');
      const api = fakeApi();
      const up = U.createUpdater({ appDir: f.dir, dataDir: f.data, fetch: api.fetch, timers: noTimers });
      api.releaseOf('v0.2.0');
      const s = await up.check({ manual: true });
      check(s.status === 'available' && !s.download && s.installed === false && s.manual.length > 0 && /not a git clone/.test(s.blocked),
        'folder copy (zip): as before, the git commands and no installer link', s);
      up.stop();
    }
  } catch (e) {
    fail++;
    console.log('FAIL harness error: ' + ((e && e.stack) || e));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
    console.log('install-mode-test: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
})();
