'use strict';
/*
 * Quartz-Setup.exe: electron-builder, NSIS, per user. Built on GitHub Actions only
 * (.github/workflows/installer.yml):
 *
 *   node tools/installer/prepare.js
 *   npx electron-builder@26.18.0 --win nsis --x64 --config tools/installer/electron-builder.config.js --publish never
 *
 * prepare.js first (CI checkouts only): electron-builder refuses an `electron` entry under
 * "dependencies", where this repo keeps the castlabs build so `npm audit --omit=dev` audits it.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// The castlabs Electron (Widevine) that `node node_modules/electron/install.js` downloaded, not a
// stock one from electron-builder's mirror: its version without the +wvcus build tag.
function castlabsVersion() {
  const v = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version || '');
  const m = /^(\d+\.\d+\.\d+)(?:[+-].*)?$/.exec(v);
  if (!m) throw new Error('node_modules/electron has an unreadable version: "' + v + '"');
  return m[1];
}

module.exports = {
  appId: 'com.owensilva.quartz', // = main.js APP_USER_MODEL_ID: the Start Menu shortcut carries it
  productName: 'Quartz',
  copyright: 'Copyright the Quartz contributors. GPL-3.0-only.',

  directories: { output: 'dist', buildResources: 'tools/installer' },

  // A one-click per-user install folder is named after package.json `name`, which is `browser`
  // for npm. The packaged copy's package.json says Quartz instead, so it installs into
  // %LOCALAPPDATA%\Programs\Quartz. The app's own name (and so its profile folder) comes from
  // productName either way.
  extraMetadata: { name: 'Quartz' },

  electronDist: 'node_modules/electron/dist',
  electronVersion: castlabsVersion(),

  // No asar: Quartz starts PowerShell scripts, compiles its C# spell host and runs a worker file
  // from its own folder, and powershell.exe cannot read a file inside an asar archive.
  asar: false,

  // node-pty (@homebridge/node-pty-prebuilt-multiarch) and koffi ship Node-API binaries, which
  // load in any Electron: nothing to rebuild, and no compiler is needed.
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,

  files: [
    '**/*',
    // Tests, test tools and the developer's own scripts stay in the repository.
    '!**/*-e2e.js',
    '!**/*-harness.js',
    '!tests{,/**}',
    '!tools{,/**}',
    '!docs{,/**}',
    '!.github{,/**}',
    '!dist{,/**}',
    '!smoketest.js',
    '!cdp-eval.js',
    '!cdp-profile.js',
    '!toback.ps1',
    '!memprobe.ps1',
    '!relink-shortcut.ps1',
    '!CLAUDE.md',
    // node-pty's Linux prebuilds are not used on Windows (it loads build/Release).
    '!node_modules/@homebridge/node-pty-prebuilt-multiarch/prebuilds{,/**}',
  ],

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/browser.ico',
    // No code-signing certificate: unsigned. electron-builder still stamps the exe's icon and
    // version strings (rcedit), which is what Task Manager and the uninstall list show.
    signAndEditExecutable: true,
  },

  nsis: {
    oneClick: true,
    perMachine: false, // %LOCALAPPDATA%\Programs\Quartz, no admin prompt
    artifactName: 'Quartz-Setup.exe', // stable: pages link to releases/latest/download/Quartz-Setup.exe
    shortcutName: 'Quartz',
    createStartMenuShortcut: true,
    createDesktopShortcut: false,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false, // the profile (%APPDATA%\Quartz) stays: a clone may share it
    uninstallDisplayName: 'Quartz',
    include: 'tools/installer/installer.nsh',
  },

  // electronDist is copied whole, Electron's default app included. resources\app wins over it, so it
  // never runs, but nothing should ship that is never used.
  afterPack: async (ctx) => {
    const p = path.join(ctx.appOutDir, 'resources', 'default_app.asar');
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('  • removed resources/default_app.asar (Electron\'s default app)'); }
  },

  publish: null,
};
