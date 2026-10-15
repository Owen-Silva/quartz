// uvboost-harness.js -- uvboost.js without Electron: the env switch, which thread it picks (and when
// it refuses), install()'s states and quartz.log lines, and the CPU guard, against a fake Win32
// thread table with the same calls the koffi bindings make.
//   node uvboost-harness.js          -> "uvboost: N passed, M failed"
'use strict';
const fs = require('fs');
const path = require('path');
const ub = require('./uvboost');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  // process.stdout, not console.log: one check below captures console.log.
  if (cond) { pass++; process.stdout.write('ok   ' + name + '\n'); } else { fail++; process.stdout.write('FAIL ' + name + (detail ? '  ' + detail : '') + '\n'); }
}

// The env switch.
for (const v of ['0', 'off', 'OFF', 'false', 'no']) ok('QUARTZ_UVBOOST=' + v + ' is off', ub.settingFrom(v) === 'off');
for (const [v, want] of [['abovenormal', 'abovenormal'], ['AboveNormal', 'abovenormal'], ['above-normal', 'abovenormal'], ['highest', 'highest'], ['TimeCritical', 'timecritical'], ['time_critical', 'timecritical']]) {
  ok('QUARTZ_UVBOOST=' + v + ' is ' + want, ub.settingFrom(v) === want);
}
for (const v of [undefined, '', '1', 'embed', 'yes', 'realtime']) ok('QUARTZ_UVBOOST=' + JSON.stringify(v) + ' is the default level', ub.settingFrom(v) === ub.DEFAULT_LEVEL);
ok('the default is a level, and one SetThreadPriority knows', Object.prototype.hasOwnProperty.call(ub.LEVELS, ub.DEFAULT_LEVEL));
ok('levels are the Win32 values', ub.LEVELS.abovenormal === 1 && ub.LEVELS.highest === 2 && ub.LEVELS.timecritical === 15);

// pickEmbed: the one unnamed thread at the start address of the threads Node names.
const S = '7ff6a0012340', X = '7ffb11112222';
const base = () => [
  { tid: 10, start: 'aaaa', name: 'CrBrowserMain' },
  { tid: 11, start: S, name: 'V8Worker' }, { tid: 12, start: S, name: 'V8Worker' },
  { tid: 13, start: S, name: 'DelayedTaskSchedulerWorker' },
  { tid: 14, start: S, name: 'libuv-worker' },
  { tid: 15, start: S, name: '' },                  // the embed thread
  { tid: 16, start: X, name: '' },                  // an unnamed thread elsewhere: ignored
  { tid: 17, start: 'bbbb', name: 'Chrome_IOThread' },
];
const p0 = ub.pickEmbed(base());
ok('picks the one unnamed thread at libuv\'s start address', p0.tid === 15 && p0.start === S && p0.named === 4, JSON.stringify(p0));
const two = base().concat([{ tid: 18, start: S, name: '' }]);
ok('two unnamed there: refuses, says how many', !ub.pickEmbed(two).tid && /2 unnamed threads/.test(ub.pickEmbed(two).why), JSON.stringify(ub.pickEmbed(two)));
const none = base().filter((r) => r.tid !== 15);
ok('none unnamed there: refuses, says 0', !ub.pickEmbed(none).tid && /^0 unnamed threads/.test(ub.pickEmbed(none).why));
const split = base().map((r) => (r.tid === 14 ? Object.assign({}, r, { start: 'cccc' }) : r));
ok('Node\'s named threads at two addresses: refuses', !ub.pickEmbed(split).tid && /2 different addresses/.test(ub.pickEmbed(split).why));
const nonamed = base().filter((r) => !ub.LIBUV_NAMES.includes(r.name));
ok('no named Node threads: refuses, names what it looked for', !ub.pickEmbed(nonamed).tid && /V8Worker/.test(ub.pickEmbed(nonamed).why));
const unread = base().concat([{ tid: 19, start: S, name: null }]);
ok('a thread there whose name cannot be read: refuses (it might be the other one)', !ub.pickEmbed(unread).tid && /could not be read/.test(ub.pickEmbed(unread).why));
const gone = base().concat([{ tid: 20, start: null, name: null }]);
ok('a thread that exited mid-walk (nothing readable) does not matter', ub.pickEmbed(gone).tid === 15);
ok('garbage in: refuses, no throw', !ub.pickEmbed(null).tid && !ub.pickEmbed([null, 5]).tid);

// A fake Win32 thread table with the calls uvboost's koffi bindings make.
function fakeApi(rows, opts) {
  const o = opts || {};
  const th = new Map(rows.map((r) => [r.tid, Object.assign({ pid: 777, priority: 0, cpu: 0 }, r)]));
  const handles = new Map();
  let nextH = 1;
  const w = {
    calls: [], open: null, ptrSize: 8,
    koffi: { decode: (p) => p.name },
    address: (h) => BigInt.asUintN(64, BigInt(h)),
    snapshot: () => (o.snapFails ? -1 : 9999),
    first: (h, te) => { w.list = [...th.values()]; w.at = 0; return w.next(h, te); },
    next: (h, te) => { const r = w.list[w.at++]; if (!r) return false; te.writeUInt32LE(r.tid, 8); te.writeUInt32LE(r.pid, 12); return true; },
    close: (h) => { if (h !== 9999) handles.delete(h); return true; },
    describe: (h, d) => { const r = th.get(handles.get(h)); if (r.name == null) return -1; d[0] = { name: r.name }; return 0; },
    localFree: () => null,
    queryThread: (h, cls, b) => { const r = th.get(handles.get(h)); if (cls !== 9 || r.start == null) return -1; b.writeBigUInt64LE(BigInt('0x' + r.start), 0); return 0; },
    getPriority: (h) => th.get(handles.get(h)).priority,
    setPriority: (h, p) => { w.calls.push(['set', handles.get(h), p]); if (o.setFails) return false; th.get(handles.get(h)).priority = o.sticky ? 0 : p; return true; },
    times: (h, c, e, k, u) => { const r = th.get(handles.get(h)); k[0] = 0; u[0] = r.cpu; return true; },
    cycles: (h, c) => { c[0] = th.get(handles.get(h)).cpu * 3; return true; },
    th, handles,
  };
  w.open = (access, inherit, tid) => { const r = th.get(tid); if (!r || r.gone || o.openFails) return null; const h = nextH++; handles.set(h, tid); return h; };
  return w;
}

const w0 = fakeApi(base());
const f0 = ub.findEmbed(777, w0);
ok('findEmbed: walks the snapshot, reads names and start addresses, picks thread 15', f0.tid === 15 && f0.threads === 8, JSON.stringify(f0));
ok('findEmbed: every handle it opened is closed', w0.handles.size === 0, w0.handles.size + ' open');
const wOther = fakeApi(base().map((r) => Object.assign({}, r, { pid: r.tid === 15 ? 778 : 777 })));
ok('findEmbed: threads of other processes are not ours', !ub.findEmbed(777, wOther).tid);
const b0 = ub.boostProcess(777, 'highest', fakeApi(base()));
ok('boostProcess: thread 15 Normal -> Highest', b0.ok && b0.tid === 15 && b0.was === 0 && b0.now === 2, JSON.stringify(b0));
const wSet = fakeApi(base());
ub.boostProcess(777, 'timecritical', wSet);
ok('boostProcess: SetThreadPriority called once, on that thread only', wSet.calls.length === 1 && wSet.calls[0][1] === 15 && wSet.calls[0][2] === 15, JSON.stringify(wSet.calls));
ok('boostProcess: an unknown level changes nothing', !ub.boostProcess(777, 'realtime', fakeApi(base())).ok);
const bRef = ub.boostProcess(777, 'highest', fakeApi(base(), { setFails: true }));
ok('boostProcess: Windows refuses -> not ok, says so', !bRef.ok && /refused/.test(bRef.why), JSON.stringify(bRef));
const bSticky = ub.boostProcess(777, 'highest', fakeApi(base(), { sticky: true }));
ok('boostProcess: the level does not read back -> not ok, says what it reads', !bSticky.ok && /reads back as Normal/.test(bSticky.why), JSON.stringify(bSticky));
const bSnap = ub.boostProcess(777, 'highest', fakeApi(base(), { snapFails: true }));
ok('boostProcess: the snapshot fails -> not ok, no throw', !bSnap.ok && /snapshot failed/.test(bSnap.why), JSON.stringify(bSnap));
ok('cpuShare: 600 ms of CPU in 60 s is 1% of a core', Math.abs(ub.cpuShare({ cpu100ns: 0 }, { cpu100ns: 6e6 }, 60000) - 0.01) < 1e-9);
ok('cpuShare: no reading -> null', ub.cpuShare(null, { cpu100ns: 1 }, 1000) === null && ub.cpuShare({ cpu100ns: 0 }, { cpu100ns: 1 }, 0) === null);

// install() with a fake process, fake api, fake timers and clock.
const winProc = (env, extra) => Object.assign({ platform: 'win32', type: 'browser', pid: 777, env: env || {} }, extra || {});
function fakeTimers() {
  const t = { timeouts: [], intervals: [], cleared: [] };
  t.setTimeout = (fn, ms) => { const h = { fn, ms, unref() { h.unrefd = true; } }; t.timeouts.push(h); return h; };
  t.setInterval = (fn, ms) => { const h = { fn, ms, unref() { h.unrefd = true; } }; t.intervals.push(h); return h; };
  t.clearInterval = (h) => { t.cleared.push(h); };
  return t;
}
let now = 1000;
const clock = () => now;
const logs = [];
const log = (l) => logs.push(l);

ok('not Windows: skipped', ub.install({ proc: winProc({}, { platform: 'linux' }), log }).state === 'skipped');
ok('a renderer: skipped', ub.install({ proc: winProc({}, { type: 'renderer' }), log }).state === 'skipped');
ok('plain Node (no process.type): skipped', ub.install({ proc: winProc({}, { type: undefined }), log }).state === 'skipped');
logs.length = 0;
const wOff = fakeApi(base());
const sOff = ub.install({ proc: winProc({ QUARTZ_UVBOOST: '0' }), api: wOff, delayMs: 0, log });
ok('QUARTZ_UVBOOST=0: state off, nothing set', sOff.state === 'off' && wOff.calls.length === 0, JSON.stringify(sOff));
ok('QUARTZ_UVBOOST=0: one quartz.log line says it is off', logs.length === 1 && /^Idle wakeup-storm fix: off \(QUARTZ_UVBOOST=0\)/.test(logs[0]), logs.join(' | '));

logs.length = 0;
const tm = fakeTimers();
const wOk = fakeApi(base());
const sOk = ub.install({ proc: winProc({}), api: wOk, timers: tm, clock, log });
ok('default: pending behind an unref\'d timer of DEFAULT_DELAY_MS', sOk.state === 'pending' && tm.timeouts.length === 1 && tm.timeouts[0].ms === ub.DEFAULT_DELAY_MS && tm.timeouts[0].unrefd && wOk.calls.length === 0);
tm.timeouts[0].fn();
ok('default: applied to thread 15 at the default level', sOk.state === 'applied' && sOk.tid === 15 && sOk.level === ub.DEFAULT_LEVEL && wOk.th.get(15).priority === ub.LEVELS[ub.DEFAULT_LEVEL] && sOk.was === 0, JSON.stringify(sOk));
ok('default: no other thread touched', [...wOk.th.values()].filter((r) => r.priority !== 0).length === 1);
ok('default: one plain-words line names the thread, the level and what it was', logs.length === 1 && /^Idle wakeup-storm fix on: .*thread 15.* now runs at (Highest|AboveNormal|TimeCritical) priority, up from Normal/.test(logs[0]), logs.join(' | '));
ok('the guard: one unref\'d interval of GUARD_EVERY_MS', tm.intervals.length === 1 && tm.intervals[0].ms === ub.GUARD_EVERY_MS && tm.intervals[0].unrefd);
// a quiet minute: 0.6 s of CPU in 60 s
now += 60000; wOk.th.get(15).cpu += 6e6; tm.intervals[0].fn();
ok('the guard: a quiet minute (1% of a core) leaves it raised', sOk.state === 'applied' && Math.abs(sOk.share - 0.01) < 1e-9 && wOk.th.get(15).priority === ub.LEVELS[ub.DEFAULT_LEVEL] && tm.cleared.length === 0, JSON.stringify(sOk));
// a spinning minute: 30 s of CPU in 60 s
now += 60000; wOk.th.get(15).cpu += 3e8; tm.intervals[0].fn();
ok('the guard: half a core for a minute puts the old priority back and stops', sOk.state === 'undone' && wOk.th.get(15).priority === 0 && tm.cleared.length === 1, JSON.stringify(sOk));
ok('the guard: says so in words, with the share and the level', logs.length === 2 && /^Idle wakeup-storm fix undone: .*thread 15.* used 50% of a CPU core over the last 60 s .* is back at Normal/.test(logs[1]), logs.join(' | '));
// the thread exits: the guard stops without a word
const tm2 = fakeTimers(); const w2 = fakeApi(base());
const s2 = ub.install({ proc: winProc({}), api: w2, timers: tm2, clock, log, delayMs: 0 });
w2.th.get(15).gone = true; now += 60000; tm2.intervals[0].fn();
ok('the guard: a gone thread stops it, state stays applied', s2.state === 'applied' && tm2.cleared.length === 1);

logs.length = 0;
const s3 = ub.install({ proc: winProc({ QUARTZ_UVBOOST: 'timecritical' }), api: fakeApi(base()), timers: fakeTimers(), clock, log, delayMs: 0 });
ok('QUARTZ_UVBOOST=timecritical: that level', s3.state === 'applied' && s3.level === 'timecritical' && /TimeCritical priority/.test(logs[0]), JSON.stringify(s3));

logs.length = 0;
const wTwo = fakeApi(base().concat([{ tid: 18, start: S, name: '' }]));
const sTwo = ub.install({ proc: winProc({}), api: wTwo, timers: fakeTimers(), clock, log, delayMs: 0 });
ok('two candidates: failed, nothing set', sTwo.state === 'failed' && wTwo.calls.length === 0 && /2 unnamed threads/.test(sTwo.reason), JSON.stringify(sTwo));
ok('two candidates: the line says NOT on, why, and that nothing changed', logs.length === 1 && /^Idle wakeup-storm fix NOT on: 2 unnamed threads .*Nothing was changed/.test(logs[0]), logs.join(' | '));
logs.length = 0;
const sZero = ub.install({ proc: winProc({}), api: fakeApi(base().filter((r) => r.tid !== 15)), timers: fakeTimers(), clock, log, delayMs: 0 });
ok('zero candidates: failed and logged', sZero.state === 'failed' && /^Idle wakeup-storm fix NOT on: 0 unnamed/.test(logs[0]), logs.join(' | '));
logs.length = 0;
const wBoom = fakeApi(base()); wBoom.snapshot = () => { throw new Error('boom'); };
const sBoom = ub.install({ proc: winProc({}), api: wBoom, timers: fakeTimers(), clock, log, delayMs: 0 });
ok('a throwing Win32 call: failed with the reason, no throw out of install()', sBoom.state === 'failed' && /boom/.test(sBoom.reason) && /NOT on/.test(logs[0]), JSON.stringify(sBoom));

// onLine: lines before and after subscribing (main.js subscribes once quartz.log is open).
const got = [], printed = [];
const realLog = console.log; console.log = (l) => printed.push(String(l));
try {
  const sReal = ub.install({ proc: winProc({ QUARTZ_UVBOOST: 'off' }), delayMs: 0 });
  ok('harness proc: not the module\'s own status', ub.status() === null && sReal.state === 'off');
  ok('a line with no log of its own is printed, tagged [uvboost]', printed.length === 1 && /^\[uvboost\] Idle wakeup-storm fix: off/.test(printed[0]), printed.join(' | '));
  ub.onLine((l) => got.push(l));
  ok('onLine: replays the lines from before it subscribed', got.length === 1 && /fix: off/.test(got[0]), got.join(' | '));
  ub.install({ proc: winProc({}), api: fakeApi(base()), timers: fakeTimers(), clock, delayMs: 0 });
  ok('onLine: and gets the later ones', got.length === 2 && /^Idle wakeup-storm fix on:/.test(got[1]), got.join(' | '));
  ub.onLine(() => { throw new Error('broken sink'); });
  ub.install({ proc: winProc({ QUARTZ_UVBOOST: '0' }), delayMs: 0 });
  ok('onLine: a throwing subscriber does not stop the others', got.length === 3);
} finally { console.log = realLog; }

// main.js installs it at the very top, right after uvquiet, and pipes its lines into quartz.log.
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const iQuiet = main.indexOf("require('./uvquiet').install()"), iBoost = main.indexOf("require('./uvboost').install()"), iElectron = main.search(/require\('electron'\)/);
ok('main.js installs uvboost right after uvquiet, before electron loads', iQuiet >= 0 && iBoost > iQuiet && (iElectron < 0 || iBoost < iElectron), [iQuiet, iBoost, iElectron].join(','));
const iLog = main.indexOf('qlog = quartzLog.install('), iOn = main.indexOf("require('./uvboost').onLine(");
ok('main.js sends uvboost\'s lines to quartz.log once it is open', iLog > 0 && iOn > iLog && /onLine\(\(t\) => \{ if \(qlog\) qlog\.log\.line\(t\); \}\)/.test(main), [iLog, iOn].join(','));
ok('the real process: status() is null until install() runs here', ub.status() === null);
ok('default delay keeps it off the boot path (>= 1 s)', ub.DEFAULT_DELAY_MS >= 1000);
ok('the guard limit is a fraction of one core', ub.GUARD_MAX_SHARE > 0 && ub.GUARD_MAX_SHARE < 1);

console.log(`uvboost: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
