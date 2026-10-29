#!/usr/bin/env node
'use strict';
/*
 * tools/installer/prepare.js -- get a CI checkout ready for electron-builder.
 *
 *   node tools/installer/prepare.js                    move electron to devDependencies (CI only)
 *   node tools/installer/prepare.js --electron-version print the Electron version to package
 *
 * Why the move: electron-builder refuses to build while `electron` sits under "dependencies"
 * ("only allowed in devDependencies"). This repository keeps it there on purpose: the ci workflow's
 * `npm audit --omit=dev` must audit the castlabs build. So the move happens only in a throwaway
 * GitHub Actions checkout, AFTER `npm ci` has installed from the untouched lockfile, and is never
 * committed. Outside GitHub Actions it refuses, so a clone's package.json is never rewritten.
 *
 * --electron-version: node_modules/electron's version without the castlabs build tag
 * (44.9.3+wvcus -> 44.9.3), for electron-builder's electronVersion with electronDist.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PKG = path.join(ROOT, 'package.json');

function electronVersion() {
  const p = path.join(ROOT, 'node_modules', 'electron', 'package.json');
  let v = '';
  try { v = String(JSON.parse(fs.readFileSync(p, 'utf8')).version || ''); } catch (e) {
    throw new Error('node_modules/electron is not installed (' + e.message + '); run npm ci and node node_modules/electron/install.js first');
  }
  const m = /^(\d+\.\d+\.\d+)(?:[+-].*)?$/.exec(v);
  if (!m) throw new Error('node_modules/electron has an unreadable version: "' + v + '"');
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(dist)) throw new Error('the castlabs Electron is not downloaded (' + dist + ' is missing); run node node_modules/electron/install.js');
  return m[1];
}

function moveElectron() {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('refusing: this rewrites package.json and runs only in a GitHub Actions checkout');
  }
  const raw = fs.readFileSync(PKG, 'utf8');
  const pkg = JSON.parse(raw);
  const spec = pkg.dependencies && pkg.dependencies.electron;
  if (!spec) {
    if (pkg.devDependencies && pkg.devDependencies.electron) return 'electron is already a devDependency (' + pkg.devDependencies.electron + ')';
    throw new Error('package.json has no electron dependency');
  }
  delete pkg.dependencies.electron;
  pkg.devDependencies = Object.assign({}, pkg.devDependencies, { electron: spec });
  fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
  return 'moved electron (' + spec + ') to devDependencies in this checkout only';
}

try {
  if (process.argv.includes('--electron-version')) {
    process.stdout.write(electronVersion() + '\n');
  } else {
    const v = electronVersion();
    console.log('installer-prepare: ' + moveElectron() + '; Electron ' + v + ' from node_modules/electron/dist');
  }
} catch (e) {
  console.error('installer-prepare: FAILED: ' + e.message);
  process.exit(1);
}
