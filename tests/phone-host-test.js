'use strict';
/*
 * tests/phone-host-test.js -- the Phone tab's address has no built-in default, and an empty one is
 * never silent. Pure node: phone.js's create() runs against a fake Electron app whose userData is a
 * temp folder, with no tools downloaded, so nothing is spawned (no adb, no scrcpy, no Electron).
 *
 *   node tests/phone-host-test.js [--profile <folder holding a phone.json to COPY>]
 *
 * --profile proves an existing install keeps its stored address: the phone.json is COPIED into a temp
 * folder (the original is only read) and the loaded host is compared to the stored one. The value is
 * never printed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const phone = require('../phone.js');

let pass = 0, fail = 0;
function check(ok, what) { if (ok) pass++; else { fail++; console.log('FAIL ' + what); } }

/* create() against a temp userData; returns the state the Settings page and Phone tab read. */
async function boot(userData) {
  const handlers = {};
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  const inst = phone.create({ app: { getPath: () => userData }, ipcMain, isChromeSender: () => true });
  const state = JSON.parse(JSON.stringify(handlers['phone:describe']({})));
  if (inst && typeof inst.stop === 'function') await inst.stop();
  return state;
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-phone-host-')); }

(async () => {
  /* 1. A fresh profile: no address, and both readers say what to do about it. */
  {
    const dir = tmp();
    const s = await boot(dir);
    check(s.settings.host === '', 'fresh profile: settings.host is empty');
    check(s.device.host === '', 'fresh profile: device.host is empty');
    check(/set your phone's address/.test(s.device.reason), "fresh profile: Settings > Phone's Device readout says to set the address");
    check(!/^\s*$/.test(s.reason), 'fresh profile: the Phone tab has a reason');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* 2. A stored address is kept, and the no-address line is gone. */
  {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'phone.json'), JSON.stringify({
      settings: { enabled: true, host: '192.0.2.10', port: 5555 }, paired: true, tcpipPinned: true
    }));
    const s = await boot(dir);
    check(s.settings.host === '192.0.2.10', 'stored host: settings.host loaded');
    check(s.device.host === '192.0.2.10', 'stored host: device.host loaded');
    check(!/set your phone's address/.test(s.device.reason + ' ' + s.reason), 'stored host: no "set your address" line');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* 3. Optional: a COPY of a real profile's phone.json keeps its host exactly. */
  const at = process.argv.indexOf('--profile');
  if (at > 0 && process.argv[at + 1]) {
    const src = path.join(process.argv[at + 1], 'phone.json');
    const stored = JSON.parse(fs.readFileSync(src, 'utf8'));
    const dir = tmp();
    fs.copyFileSync(src, path.join(dir, 'phone.json'));
    const s = await boot(dir);
    const want = String((stored.settings && stored.settings.host) || '').trim();
    check(want !== '', 'profile copy: the stored phone.json has a host');
    check(s.settings.host === want, 'profile copy: settings.host equals the stored host');
    check(s.device.host === want, 'profile copy: device.host equals the stored host');
    check(s.device.paired === (stored.paired === true), 'profile copy: paired flag kept');
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('profile copy checked (host compared, not printed)');
  }

  console.log('phone-host-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.log('phone-host-test: crashed: ' + (err && err.stack || err)); process.exit(1); });
