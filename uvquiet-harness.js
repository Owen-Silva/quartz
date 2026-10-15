// uvquiet-harness.js -- uvquiet.js's guard on process.activateUvLoop, in plain Node with a fake
// Electron process object (the real effect, wakeups/s, is measured by tools/efficiency/wake-bisect.js).
//   node uvquiet-harness.js      -> "uvquiet-test: N passed, M failed"
'use strict';
const uvquiet = require('./uvquiet');
const { executionAsyncId } = require('async_hooks');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name + (detail ? '  ' + detail : '')); }
}
function fakeProc(type) {
  const p = { type, real: 0 };
  p.activateUvLoop = function () { p.real++; };
  return p;
}
const tick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  // Only Electron's main process is touched.
  ok('plain node: no install', uvquiet.install() === null && typeof process.activateUvLoop === 'undefined');
  const rend = fakeProc('renderer');
  const rendFn = rend.activateUvLoop;
  ok('renderer: no install', uvquiet.install({ proc: rend }) === null && rend.activateUvLoop === rendFn);

  // The rule, with a stand-in async id.
  let id = 0;
  const p = fakeProc('browser');
  const counts = uvquiet.install({ proc: p, asyncId: () => id });
  ok('browser: installed', !!counts && p.activateUvLoop !== undefined && p.activateUvLoop.__uvquiet === counts);
  id = 0; p.activateUvLoop();
  ok('a Chromium task (async id 0) still activates', p.real === 1 && counts.passed === 1, JSON.stringify(counts));
  id = 1; p.activateUvLoop();
  ok('the main script (async id 1) still activates', p.real === 2);
  id = 7; p.activateUvLoop(); p.activateUvLoop();
  ok('inside a Node callback (async id > 1) it is skipped', p.real === 2 && counts.skipped === 2, JSON.stringify(counts));
  ok('a second install is a no-op that returns the same counters', uvquiet.install({ proc: p }) === counts);

  // The real executionAsyncId in each place the wrappers get called from.
  const q = fakeProc('browser');
  const c2 = uvquiet.install({ proc: q });
  q.activateUvLoop();
  ok('real id: top level activates', q.real === 1, 'id ' + executionAsyncId());
  await new Promise((r) => setTimeout(() => { q.activateUvLoop(); r(); }, 1));
  ok('real id: a timer callback is skipped', q.real === 1 && c2.skipped === 1, JSON.stringify(c2));
  await new Promise((r) => setImmediate(() => { q.activateUvLoop(); r(); }));
  ok('real id: an immediate is skipped', q.real === 1 && c2.skipped === 2);
  await new Promise((r) => process.nextTick(() => { q.activateUvLoop(); r(); }));
  ok('real id: a tick is skipped', q.real === 1 && c2.skipped === 3);
  await new Promise((r) => require('fs').stat(__filename, () => { q.activateUvLoop(); r(); }));
  ok('real id: an fs callback is skipped', q.real === 1 && c2.skipped === 4);
  await tick();
  const before = q.real;
  await Promise.resolve().then(() => q.activateUvLoop());
  ok('real id: a promise continuation still activates (Node gives it no id)', q.real === before + 1, JSON.stringify(c2));

  console.log(`uvquiet-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness threw: ' + (e && e.stack)); console.log(`uvquiet-test: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
