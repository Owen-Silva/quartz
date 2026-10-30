#!/usr/bin/env node
// tools/make-quartz-exe.js - give Quartz its own process name.
//
//   node tools/make-quartz-exe.js          (also runs as npm's postinstall)
//   node tools/make-quartz-exe.js --force  (rebuild even when up to date)
//
// WHY. Quartz runs unpackaged: node_modules\electron\dist\electron.exe with this
// folder as its argument. Task Manager names a process by its exe's version
// resource (FileDescription), so every Quartz process - main, GPU, renderers,
// utilities, all spawned from process.execPath - was listed as "Electron".
//
// WHAT. Copies electron.exe to Quartz.exe IN THE SAME FOLDER (it needs that
// folder's DLLs, .pak files, icudtl.dat and resources\default_app.asar) and
// stamps the copy's version strings and icon with rcedit (the npm package ships
// rcedit.exe; no compiler needed). electron.exe itself is never modified, so
// `npx electron .` test instances keep working exactly as before. Launched as
// `Quartz.exe "<this folder>"`, the app is the same: same package.json, same
// userData (%APPDATA%\Quartz), same AppUserModelId.
//
// IDEMPOTENT. Writes Quartz.exe.stamp.json next to it, recording what it was
// built from (electron.exe size/mtime/version, the icon's hash, the strings).
// When everything still matches and Quartz.exe reads back "Quartz", it does
// nothing. An Electron update replaces node_modules\electron wholesale, so
// Quartz.exe and the stamp vanish together and the next run rebuilds.
// NOTE: npm runs this postinstall on a bare `npm install` / `npm ci`. After
// `npm install electron@<x>` run `npm run quartz-exe` yourself to be sure.
//
// SAFE WHILE QUARTZ RUNS. The new copy is built as Quartz.exe.building and only
// swapped in once it reads back right. A running Quartz.exe cannot be
// overwritten or deleted, but it can be renamed, so the old one is moved aside
// to Quartz.exe.old-<time> and removed on a later run once it has exited.
//
// LOUD. Any failure prints "make-quartz-exe: FAILED - <plain reason>" and exits
// 1, which fails the npm install that ran it. Nothing is skipped silently.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RECIPE = 1;   // bump when what this script writes changes; forces a rebuild
const APP_DIR = path.resolve(__dirname, '..');
const DIST = path.join(APP_DIR, 'node_modules', 'electron', 'dist');
const SRC = path.join(DIST, 'electron.exe');
const OUT = path.join(DIST, 'Quartz.exe');
const TMP = path.join(DIST, 'Quartz.exe.building');
const STAMP = path.join(DIST, 'Quartz.exe.stamp.json');
const ICO = path.join(APP_DIR, 'assets', 'browser.ico');
const RCEDIT = path.join(APP_DIR, 'node_modules', 'rcedit', 'bin',
  process.arch === 'ia32' ? 'rcedit.exe' : 'rcedit-x64.exe');

// What Task Manager, Explorer's Details pane and the taskbar read.
const STRINGS = {
  FileDescription: 'Quartz',
  ProductName: 'Quartz',
  InternalName: 'Quartz',
  OriginalFilename: 'Quartz.exe',
  CompanyName: 'Atlas Studio',
};

class Fail extends Error {}
const say = (msg) => console.log('make-quartz-exe: ' + msg);

function rcedit(args, what) {
  try {
    return execFileSync(RCEDIT, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
  } catch (e) {
    const out = [e.stdout, e.stderr].filter(Boolean).join(' ').trim();
    throw new Fail('rcedit could not ' + what + ' (' + (out || e.code || e.message) + ').');
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function electronVersion() {
  try { return fs.readFileSync(path.join(DIST, 'version'), 'utf8').trim(); } catch { return 'unknown'; }
}

/** What Quartz.exe is built from; any change means a rebuild. */
function inputs() {
  const st = fs.statSync(SRC);
  return {
    recipe: RECIPE,
    electronVersion: electronVersion(),
    electronSize: st.size,
    electronMtimeMs: Math.round(st.mtimeMs),
    icoSha256: sha256(ICO),
    strings: STRINGS,
  };
}

/** The version strings rcedit reads back off an exe, compared to STRINGS. */
function readBackProblems(exe) {
  const bad = [];
  for (const [key, want] of Object.entries(STRINGS)) {
    const got = rcedit([exe, '--get-version-string', key], 'read ' + key + ' back from ' + path.basename(exe));
    if (got !== want) bad.push(key + ' is "' + got + '", wanted "' + want + '"');
  }
  return bad;
}

function upToDate(want) {
  if (!fs.existsSync(OUT) || !fs.existsSync(STAMP)) return 'Quartz.exe or its stamp is missing';
  let stamp;
  try { stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch { return 'the stamp is unreadable'; }
  if (JSON.stringify(stamp.inputs) !== JSON.stringify(want)) return 'electron.exe, the icon or the recipe changed';
  const st = fs.statSync(OUT);
  if (stamp.outSize !== st.size || stamp.outMtimeMs !== Math.round(st.mtimeMs)) return 'Quartz.exe was changed after it was built';
  const bad = readBackProblems(OUT);
  if (bad.length) return 'Quartz.exe reads back wrong: ' + bad.join('; ');
  return null;
}

/** Old copies moved aside while they were running; gone once they have exited. */
function sweepOld() {
  for (const name of fs.readdirSync(DIST)) {
    if (!/^Quartz\.exe\.old-\d+$/.test(name)) continue;
    try { fs.unlinkSync(path.join(DIST, name)); say('removed old ' + name); }
    catch (e) { say('kept ' + name + ' (' + e.code + ': still running; removed on a later run)'); }
  }
}

function swapIn() {
  try {
    fs.renameSync(TMP, OUT);   // replaces OUT when it is not running
    return;
  } catch (e) {
    if (!fs.existsSync(OUT) || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
      throw new Fail('could not move ' + path.basename(TMP) + ' to Quartz.exe (' + e.code + ': ' + e.message + ').');
    }
  }
  // Quartz.exe is running: Windows refuses to replace it but allows a rename.
  const aside = OUT + '.old-' + Date.now();
  try { fs.renameSync(OUT, aside); }
  catch (e) { throw new Fail('Quartz.exe is in use and could not be moved aside (' + e.code + '). Close Quartz and run this again.'); }
  try { fs.renameSync(TMP, OUT); }
  catch (e) {
    try { fs.renameSync(aside, OUT); } catch { /* reported below */ }
    throw new Fail('could not move the new copy into place (' + e.code + '); the old Quartz.exe was put back.');
  }
  say('the running Quartz.exe was moved aside to ' + path.basename(aside) + '; it is removed on a later run');
}

function main() {
  const force = process.argv.includes('--force');
  if (process.platform !== 'win32') { say('skipped - Quartz.exe is a Windows-only rename (platform ' + process.platform + ').'); return; }
  if (!fs.existsSync(SRC)) throw new Fail('electron.exe not found at ' + SRC + ' - Electron\'s own install did not finish. Run npm install in ' + APP_DIR + '.');
  if (!fs.existsSync(RCEDIT)) throw new Fail('rcedit not found at ' + RCEDIT + ' - it is a devDependency; run npm install in ' + APP_DIR + ' (not with --omit=dev).');
  if (!fs.existsSync(ICO)) throw new Fail('icon not found at ' + ICO + ' - Quartz.exe would carry Electron\'s icon. Restore assets\\browser.ico.');

  sweepOld();
  const want = inputs();
  const why = force ? '--force' : upToDate(want);
  if (!why) { say('up to date - ' + OUT + ' (Electron ' + want.electronVersion + '), nothing to do.'); return; }
  say('building Quartz.exe (' + why + ')');

  try { fs.rmSync(TMP, { force: true }); } catch (e) { throw new Fail('a stale ' + path.basename(TMP) + ' could not be removed (' + e.code + ').'); }
  try {
    fs.copyFileSync(SRC, TMP);
    const args = [TMP];
    for (const [k, v] of Object.entries(STRINGS)) args.push('--set-version-string', k, v);
    args.push('--set-icon', ICO);
    rcedit(args, 'stamp ' + path.basename(TMP));
    const bad = readBackProblems(TMP);
    if (bad.length) throw new Fail('the new copy reads back wrong: ' + bad.join('; ') + '.');
    swapIn();
  } finally {
    try { fs.rmSync(TMP, { force: true }); } catch { /* only left behind on a failure already reported */ }
  }

  const st = fs.statSync(OUT);
  fs.writeFileSync(STAMP, JSON.stringify({
    builtAt: new Date().toISOString(),
    inputs: want,
    outSize: st.size,
    outMtimeMs: Math.round(st.mtimeMs),
  }, null, 2) + '\n');
  const final = readBackProblems(OUT);
  if (final.length) throw new Fail('Quartz.exe reads back wrong after the swap: ' + final.join('; ') + '.');
  say('built ' + OUT + ' (Electron ' + want.electronVersion + ', FileDescription "Quartz", icon assets\\browser.ico)');
}

try {
  main();
} catch (e) {
  const reason = e instanceof Fail ? e.message : (e && e.stack) || String(e);
  console.error('make-quartz-exe: FAILED - ' + reason);
  process.exit(1);
}
