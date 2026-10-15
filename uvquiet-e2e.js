// uvquiet-e2e.js -- uvquiet.js's default mode in a REAL Electron main process: with every
// process.activateUvLoop() skipped, Node work armed from a Chromium task, from a promise
// continuation, and from inside uv_run still runs on time (tests/uvquiet-e2e-main.js).
//   node uvquiet-e2e.js            -> "uvquiet-e2e: N passed, M failed"
// Launches one hidden Electron window (no Quartz, no profile of the user's); RAM-gated like every e2e.
'use strict';
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const MAIN = path.join(ROOT, 'tests', 'uvquiet-e2e-main.js');
/** How late a case may be, on top of its own timer, before it counts as missed. */
const SLACK_MS = 400;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('ok   ' + name + (detail ? '  (' + detail + ')' : '')); } else { fail++; console.log('FAIL ' + name + (detail ? '  ' + detail : '')); }
}

const { MIN_FREE_GB, freeRamGb } = require(path.join(ROOT, 'testwatch'));
const free = freeRamGb();
if (!(free >= MIN_FREE_GB)) { console.log('uvquiet-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }

const child = spawn(ELECTRON, [MAIN], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let text = '';
child.stdout.on('data', (d) => { text += d; });
child.stderr.on('data', () => { /* Chromium chatter */ });
const killer = setTimeout(() => { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (e) { child.kill(); } }, 90000);
child.on('close', (code) => {
  clearTimeout(killer);
  const cases = [];
  let doneLine = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('UVQ ')) { try { cases.push(JSON.parse(line.slice(4))); } catch (e) { /* torn */ } }
    else if (line.startsWith('UVQ-DONE ')) { try { doneLine = JSON.parse(line.slice(9)); } catch (e) { /* torn */ } }
  }
  ok('the Electron run finished (exit ' + code + ')', !!doneLine && !doneLine.error, doneLine && doneLine.error);
  ok('all 10 cases reported', cases.length === 10, cases.length + ' reported');
  const counts = doneLine && doneLine.counts;
  ok('default mode on Electron ' + (doneLine && doneLine.electron) + ' is "all"', !!counts && counts.mode === 'all', JSON.stringify(counts));
  ok('the wrappers were hit and every activation skipped', !!counts && counts.skipped > 0 && counts.passed === 0, JSON.stringify(counts));
  for (const c of cases) {
    const late = c.ms - (c.wait || 0);
    ok(c.name + ' runs on time', !c.error && late <= SLACK_MS, c.error ? c.error : c.ms + ' ms' + (c.wait ? ' for a ' + c.wait + ' ms timer' : ''));
  }
  console.log(`uvquiet-e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
