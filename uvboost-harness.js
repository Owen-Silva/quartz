// uvboost-harness.js -- uvboost.js without Electron or PowerShell: the env switch, the script it
// would run, the output parser, and install()'s states with a fake process and execFile.
//   node uvboost-harness.js          -> "uvboost: N passed, M failed"
'use strict';
const fs = require('fs');
const path = require('path');
const ub = require('./uvboost');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name + (detail ? '  ' + detail : '')); }
}

// The env switch.
for (const v of ['0', 'off', 'OFF', 'false', 'no']) ok('QUARTZ_UVBOOST=' + v + ' is off', ub.scopeFrom(v) === 'off');
for (const v of ['process', 'proc']) ok('QUARTZ_UVBOOST=' + v + ' is the whole process', ub.scopeFrom(v) === 'process');
for (const v of ['main', 'boost', 'level']) ok('QUARTZ_UVBOOST=' + v + ' is that main-thread variant', ub.scopeFrom(v) === v);
for (const v of [undefined, '', '1', 'embed', 'yes']) ok('QUARTZ_UVBOOST=' + JSON.stringify(v) + ' is the embed thread (default)', ub.scopeFrom(v) === 'embed');

// The scripts.
const sEmb = ub.script(4321, 'embed');
ok('embed script targets the pid and stops on errors', sEmb.includes('Get-Process -Id 4321') && sEmb.startsWith("$ErrorActionPreference = 'Stop'"));
ok('embed script reads thread names and start addresses (GetThreadDescription, NtQueryInformationThread 9)', sEmb.includes('GetThreadDescription') && sEmb.includes('NtQueryInformationThread(h, 9,'));
const cs = /Add-Type -TypeDefinition '([^']*)'/.exec(sEmb);
ok('the C# is one single-quoted PowerShell string (no quote inside it)', !!cs && cs[1].includes('public static class QuartzUvThreads') && cs[1].endsWith('} }'));
ok('embed script takes the start address of the threads Node and libuv name', sEmb.includes("'libuv-worker'") && sEmb.includes("'V8Worker'") && sEmb.includes("'DelayedTaskSchedulerWorker'"));
ok('embed script needs exactly one start address and exactly one unnamed thread there', sEmb.includes('if ($uv.Count -ne 1) { throw') && sEmb.includes('if ($e.Count -ne 1) { throw'));
ok('embed script sets that thread to TimeCritical and nothing else', sEmb.includes("$t.PriorityLevel = 'TimeCritical'") && !sEmb.includes('PriorityBoostEnabled') && !sEmb.includes("'Normal'"));
const sMain = ub.script(4321, 'main');
ok('main script picks the earliest-started thread', /Sort-Object \{ try \{ \$_\.StartTime \}/.test(sMain) && sMain.includes('Select-Object -First 1'));
ok('main script: that thread Normal and boost off', sMain.includes('$t.PriorityBoostEnabled = $false') && sMain.includes("$t.PriorityLevel = 'Normal'"));
ok('main script leaves the process setting alone', !sMain.includes('$p.PriorityBoostEnabled = $false'));
const sBoost = ub.script(4321, 'boost'), sLevel = ub.script(4321, 'level');
ok('boost script: boost off only', sBoost.includes('$t.PriorityBoostEnabled = $false') && !sBoost.includes("PriorityLevel = 'Normal'"));
ok('level script: Normal only', !sLevel.includes('$t.PriorityBoostEnabled = $false') && sLevel.includes("$t.PriorityLevel = 'Normal'"));
const sProc = ub.script(4321, 'process');
ok('process script turns the process boost off', sProc.includes('$p.PriorityBoostEnabled = $false') && !sProc.includes('$t.'));
let threw = 0;
for (const bad of [0, -1, 'x', '12; Remove-Item C:\\', null, NaN]) { try { ub.script(bad, 'embed'); } catch (e) { threw++; } }
ok('a pid that is not a positive number throws (nothing is spliced into PowerShell)', threw === 6, threw + ' of 6 threw');

// The parser.
const p0 = ub.parse('\r\nuvboost ok scope=embed tid=19832 was=Normal\r\n');
ok('parse: embed line', p0.ok && p0.scope === 'embed' && p0.tid === 19832 && p0.was === 'Normal', JSON.stringify(p0));
const p1 = ub.parse('uvboost ok scope=main tid=17812 was=True/AboveNormal');
ok('parse: main line', p1.ok && p1.scope === 'main' && p1.tid === 17812 && p1.was === 'True/AboveNormal', JSON.stringify(p1));
const p2 = ub.parse('uvboost ok scope=process pid=99 was=False');
ok('parse: process line', p2.ok && p2.scope === 'process' && p2.tid === null && p2.was === 'False', JSON.stringify(p2));
ok('parse: anything else is not ok', !ub.parse('').ok && !ub.parse('Get-Process : Cannot find a process').ok && !ub.parse(null).ok);

// install() with a fake process.
const winProc = (env, extra) => Object.assign({ platform: 'win32', type: 'browser', pid: 777, env: env || {} }, extra || {});
function fakeExec(reply) {
  const calls = [];
  const fn = (file, args, opts, cb) => { calls.push({ file, args, opts }); if (reply.throws) throw new Error(reply.throws); setImmediate(() => cb(reply.err || null, reply.stdout || '', reply.stderr || '')); return {}; };
  fn.calls = calls;
  return fn;
}
const logs = [];
const log = (l) => logs.push(l);

ok('not Windows: skipped', ub.install({ proc: winProc({}, { platform: 'linux' }), log }).state === 'skipped');
ok('a renderer: skipped', ub.install({ proc: winProc({}, { type: 'renderer' }), log }).state === 'skipped');
ok('plain Node (no process.type): skipped', ub.install({ proc: winProc({}, { type: undefined }), log }).state === 'skipped');
const exOff = fakeExec({ stdout: 'uvboost ok scope=embed tid=1 was=Normal' });
const sOff = ub.install({ proc: winProc({ QUARTZ_UVBOOST: '0' }), execFile: exOff, delayMs: 0, log });
ok('QUARTZ_UVBOOST=0: state off, no PowerShell', sOff.state === 'off' && exOff.calls.length === 0, JSON.stringify(sOff));

(async () => {
  const tick = () => new Promise((r) => setTimeout(r, 30));

  const exOk = fakeExec({ stdout: 'uvboost ok scope=embed tid=4242 was=Normal\r\n' });
  const sOk = ub.install({ proc: winProc({}), execFile: exOk, delayMs: 0, log });
  ok('applied: PowerShell started at once with delayMs 0', exOk.calls.length === 1);
  const c = exOk.calls[0] || { args: [], opts: {} };
  ok('runs powershell.exe hidden, non-interactive, with a timeout', c.file === 'powershell.exe' && c.args.includes('-NoProfile') && c.args.includes('-NonInteractive') && c.opts.windowsHide === true && c.opts.timeout > 0);
  ok('the -Command is the embed-thread script for this pid', c.args[c.args.indexOf('-Command') + 1] === ub.script(777, 'embed'));
  await tick();
  ok('applied: state, thread id and reason', sOk.state === 'applied' && sOk.tid === 4242 && /was Normal/.test(sOk.reason) && sOk.ms >= 0, JSON.stringify(sOk));
  ok('applied: one log line names the thread', logs.some((l) => /\[uvboost\] priority TimeCritical \(libuv embed thread 4242, was Normal\)/.test(l)), logs.join(' | '));

  const exProc = fakeExec({ stdout: 'uvboost ok scope=process pid=777 was=True' });
  const sProc2 = ub.install({ proc: winProc({ QUARTZ_UVBOOST: 'process' }), execFile: exProc, delayMs: 0, log });
  await tick();
  ok('QUARTZ_UVBOOST=process: the process script, applied', sProc2.scope === 'process' && sProc2.state === 'applied' && exProc.calls[0].args.includes(ub.script(777, 'process')), JSON.stringify(sProc2));

  const exErr = fakeExec({ err: new Error('Command failed: unnamed libuv threads: 2'), stderr: 'unnamed libuv threads: 2' });
  const sErr = ub.install({ proc: winProc({}), execFile: exErr, delayMs: 0, log });
  await tick();
  ok('PowerShell fails: state failed with the reason, logged', sErr.state === 'failed' && /unnamed libuv threads: 2/.test(sErr.reason) && logs.some((l) => /could not turn the priority boost off/.test(l)), JSON.stringify(sErr));

  const exNoLine = fakeExec({ stdout: 'something else\r\n' });
  const sNo = ub.install({ proc: winProc({}), execFile: exNoLine, delayMs: 0, log });
  await tick();
  ok('no "uvboost ok" line: failed, not applied', sNo.state === 'failed' && /something else/.test(sNo.reason), JSON.stringify(sNo));

  const exThrow = fakeExec({ throws: 'spawn powershell.exe ENOENT' });
  const sThrow = ub.install({ proc: winProc({}), execFile: exThrow, delayMs: 0, log });
  ok('PowerShell cannot start: failed, no throw out of install()', sThrow.state === 'failed' && /ENOENT/.test(sThrow.reason), JSON.stringify(sThrow));

  const exLate = fakeExec({ stdout: 'uvboost ok scope=main tid=5 was=True' });
  const sLate = ub.install({ proc: winProc({}), execFile: exLate, delayMs: 60, log });
  ok('with a delay: pending, nothing started yet', sLate.state === 'pending' && exLate.calls.length === 0);
  await new Promise((r) => setTimeout(r, 150));
  ok('with a delay: applied after it', sLate.state === 'applied' && exLate.calls.length === 1, JSON.stringify(sLate));
  ok('default delay keeps it off the boot path (>= 1 s)', ub.DEFAULT_DELAY_MS >= 1000);

  // main.js installs it at the very top, right after uvquiet, before the first electron require.
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const iQuiet = main.indexOf("require('./uvquiet').install()"), iBoost = main.indexOf("require('./uvboost').install()"), iElectron = main.search(/require\('electron'\)/);
  ok('main.js installs uvboost right after uvquiet, before electron loads', iQuiet >= 0 && iBoost > iQuiet && (iElectron < 0 || iBoost < iElectron), [iQuiet, iBoost, iElectron].join(','));
  ok('the real process: status() is null until install() runs here', ub.status() === null);

  console.log(`uvboost: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
