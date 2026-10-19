'use strict';
/*
 * tools/lowcpu-optional.js -- an OPTIONAL CPU cap for the test harnesses, required on line 1 of every
 * e2e/harness file (and smoketest.js, tools/run-suite.js) so the cap is in force before any browser starts.
 *
 * Quartz's tests drive real Chromium/Electron instances, and on a small laptop several of them at once can
 * pin every core. Some machines carry a local module that caps that (pins the process to a few cores, one
 * headless browser at a time); most machines, and every cloud runner, carry none. This file loads the cap
 * when one is configured and does nothing otherwise:
 *
 *   1. env QUARTZ_LOWCPU = path of a module  -> require it. Set but missing is an ERROR, never a quiet skip:
 *      someone asked for a cap, and a test run without it would lag their machine with no word why.
 *   2. else ~/.config/quartz/lowcpu.js exists -> require it (a one-line shim that points at your own cap;
 *      it lives outside the repo, so nothing personal is tracked).
 *   3. else nothing: no cap is configured, and none is needed.
 *
 * An error thrown INSIDE a configured cap module is not swallowed either: it propagates, and the test
 * stops before it can start a browser uncapped.
 *
 * What was loaded (or why nothing was) is left in process.env.QUARTZ_LOWCPU_LOADED for any harness that
 * wants to print it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function pick(env, home) {
  const named = env.QUARTZ_LOWCPU;
  if (named) {
    const p = path.resolve(named);
    if (!fs.existsSync(p)) {
      throw new Error('QUARTZ_LOWCPU is set to "' + named + '", but no file is there. Fix the path, or unset it to run without a CPU cap.');
    }
    return { file: p, why: 'QUARTZ_LOWCPU' };
  }
  const shim = path.join(home, '.config', 'quartz', 'lowcpu.js');
  if (fs.existsSync(shim)) return { file: shim, why: '~/.config/quartz/lowcpu.js' };
  return { file: null, why: 'none configured' };
}

const choice = pick(process.env, os.homedir());
if (choice.file) require(choice.file);
process.env.QUARTZ_LOWCPU_LOADED = choice.file ? choice.why + ': ' + choice.file : 'none configured';

module.exports = { pick };
