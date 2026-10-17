'use strict';
/*
 * powersaver.js -- is Windows' battery saver / energy saver on? One synchronous, free call
 * (kernel32 GetSystemPowerStatus through koffi, as procfind.js does): no child process, no
 * PowerShell. SYSTEM_POWER_STATUS.SystemStatusFlag is 1 while the saver is on.
 *
 *   on()     true (saver on) | false (off) | null (this machine cannot say: not Windows, or
 *            koffi failed to load -- whyNot() says why)
 *   whyNot() '' or the reason on() answers null
 *
 * Watch's background refresh (watch-main.js) skips a read while on() is true.
 */

let api;            // undefined = not loaded yet, null = cannot load
let whyNot = '';

function load() {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== 'win32') { whyNot = 'not Windows'; return api; }
  try {
    const koffi = require('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    // Prefixed name: koffi's type registry is per-process (see embed.js / procfind.js).
    const STATUS = koffi.struct('PowersaverSystemPowerStatus', {
      ACLineStatus: 'uint8_t',
      BatteryFlag: 'uint8_t',
      BatteryLifePercent: 'uint8_t',
      SystemStatusFlag: 'uint8_t',
      BatteryLifeTime: 'uint32_t',
      BatteryFullLifeTime: 'uint32_t',
    });
    api = { get: kernel32.func('bool __stdcall GetSystemPowerStatus(_Out_ PowersaverSystemPowerStatus *s)') };
    void STATUS;
  } catch (err) {
    api = null;
    whyNot = (err && err.message) || 'koffi failed to load';
  }
  return api;
}

function on() {
  const a = load();
  if (!a) return null;
  try {
    const s = {};
    if (!a.get(s)) { whyNot = 'GetSystemPowerStatus failed'; return null; }
    return s.SystemStatusFlag === 1;
  } catch (err) {
    whyNot = (err && err.message) || 'GetSystemPowerStatus threw';
    return null;
  }
}

module.exports = { on, whyNot: () => whyNot };
