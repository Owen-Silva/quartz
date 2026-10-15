// procfind-harness.js - pure-node test for procfind.js and school.js's "is LessonPlayer running?"
// check (run: node procfind-harness.js). No LessonPlayer, no tasklist, no Electron.
//
// 1. procfind.running() against a FAKE process list: a stand-in for the kernel32 binding with
//    the same shape (procfind.__test.use), so the Toolhelp walk, the exact-name match and every
//    "cannot tell" path run without Windows.
// 2. school.js's checkPresence() on top of it: procfind answers, tasklist is never spawned; when
//    procfind cannot answer (null), the tasklist fallback runs through an injected spawn.
// 3. Live, on Windows with koffi installed: the real snapshot finds this node.exe and does not
//    find a made-up name. Skipped (said so, not counted) where koffi is missing.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? '\n  ' + extra : '')); } }

// Real spawn must never run in parts 1-2: school.js captures childProcess.spawn at create().
const realSpawn = childProcess.spawn;
const realSpawns = [];
childProcess.spawn = (file, args) => { realSpawns.push(file + ' ' + (args || []).join(' ')); throw new Error('real spawn called in a fake-list test'); };

const procfind = require('./procfind');
const schoolModule = require('./school');

/* ---- the fake kernel32 binding ---------------------------------------------------------------- */
// PROCESSENTRY32W on x64: 568 bytes, szExeFile (260 WCHARs) at byte 44.
const SIZE = 568, NAME_AT = 44;
function fakeApi(names, o) {
  const opts = o || {};
  const f = { size: SIZE, nameAt: NAME_AT, snaps: 0, closes: 0, dwSizeSeen: [] };
  const write = (pe, name) => {
    f.dwSizeSeen.push(pe.readUInt32LE(0));
    const s = String(name).slice(0, 260);
    pe.fill(0x41, NAME_AT, SIZE);        // stale junk: only the terminator may end the name
    pe.write(s, NAME_AT, 'utf16le');
    if (s.length < 260) pe.writeUInt16LE(0, NAME_AT + s.length * 2);
  };
  f.snapshot = () => {
    f.snaps++;
    if (opts.snapshotNull) return null;
    return { h: f.snaps, cursor: 0 };
  };
  f.address = (h) => (opts.invalid ? BigInt.asUintN(64, -1n) : 0x1000 + h.h);
  f.first = (h, pe) => {
    if (opts.throwFirst) throw new Error('first exploded');
    h.cursor = 0;
    if (!names.length) return false;
    write(pe, names[0]); return true;
  };
  f.next = (h, pe) => {
    if (opts.throwAt !== undefined && h.cursor + 1 === opts.throwAt) throw new Error('next exploded');
    h.cursor++;
    if (h.cursor >= names.length) return false;
    write(pe, names[h.cursor]); return true;
  };
  f.close = () => { f.closes++; return true; };
  return f;
}

const LIST = ['[System Process]', 'System', 'svchost.exe', 'explorer.exe', 'LessonPlayerApp.exe', 'Quartz.exe'];

/* ---- 1. procfind against a fake list ---------------------------------------------------------- */
let f = fakeApi(LIST); procfind.__test.use(f);
eq('found, exact case', procfind.running('LessonPlayerApp.exe'), true);
eq('found, other case', procfind.running('lessonplayerapp.EXE'), true);
eq('first entry is checked too', procfind.running('[system process]'), true);
eq('last entry is checked too', procfind.running('quartz.exe'), true);
eq('absent name', procfind.running('chrome.exe'), false);
eq('prefix of a name is not a match', procfind.running('LessonPlayerApp'), false);
eq('longer than a name is not a match', procfind.running('LessonPlayerApp.exe.bak'), false);
eq('empty name', procfind.running(''), false);
eq('undefined name', procfind.running(undefined), false);
eq('one snapshot per call, every one closed', [f.snaps, f.closes], [9, 9]);
ok('dwSize is set before every read', f.dwSizeSeen.every((n) => n === SIZE), JSON.stringify(f.dwSizeSeen.slice(0, 5)));

f = fakeApi(['System', 'xLessonPlayerApp.exe', 'LessonPlayerApp.ex']); procfind.__test.use(f);
eq('near-misses only', procfind.running('LessonPlayerApp.exe'), false);

const long = 'a'.repeat(250) + '.exe';                 // 254 chars, near the 260 limit
f = fakeApi(['System', long]); procfind.__test.use(f);
eq('a 254-char name', procfind.running(long), true);
f = fakeApi(['System', 'b'.repeat(260)]); procfind.__test.use(f);
eq('a name filling all 260 WCHARs (no terminator) does not run off the end', procfind.running('b.exe'), false);

f = fakeApi([]); procfind.__test.use(f);
eq('empty walk is "cannot tell", not "not running"', procfind.running('LessonPlayerApp.exe'), null);
eq('empty walk says why', procfind.reason(), 'the process snapshot was empty');
eq('empty walk still closes the snapshot', f.closes, 1);

f = fakeApi(LIST, { snapshotNull: true }); procfind.__test.use(f);
eq('no snapshot handle -> null', procfind.running('LessonPlayerApp.exe'), null);
eq('no snapshot handle says why', procfind.reason(), 'CreateToolhelp32Snapshot failed');
eq('nothing to close', f.closes, 0);

f = fakeApi(LIST, { invalid: true }); procfind.__test.use(f);
eq('INVALID_HANDLE_VALUE -> null', procfind.running('LessonPlayerApp.exe'), null);
eq('INVALID_HANDLE_VALUE is never closed', f.closes, 0);

f = fakeApi(LIST, { throwFirst: true }); procfind.__test.use(f);
eq('a throwing walk -> null, never throws', procfind.running('LessonPlayerApp.exe'), null);
eq('a throwing walk says why', procfind.reason(), 'first exploded');
eq('a throwing walk still closes the snapshot', f.closes, 1);

f = fakeApi(LIST, { throwAt: 2 }); procfind.__test.use(f);
eq('a throw mid-walk -> null', procfind.running('Quartz.exe'), null);
eq('a throw mid-walk closes the snapshot', f.closes, 1);

procfind.__test.use(null);
eq('no binding (koffi missing) -> null', procfind.running('explorer.exe'), null);

/* ---- 2. school.js's presence check on top of it ----------------------------------------------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'procfind-harness-'));
const notesDir = path.join(tmp, 'notes'); fs.mkdirSync(notesDir);

/** A child_process.spawn stand-in: answers `tasklist` with the given stdout and exit code. */
function fakeSpawn(answer) {
  const calls = [];
  const fn = (file, args) => {
    calls.push([file, args]);
    if (answer.throws) throw new Error(answer.throws);
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.kill = () => {};
    setImmediate(() => {
      if (file === 'tasklist' && answer.out) c.stdout.emit('data', Buffer.from(answer.out));
      c.emit('close', file === 'tasklist' ? (answer.code || 0) : 1);
    });
    return c;
  };
  fn.calls = calls;
  return fn;
}
const tasklistCalls = (sp) => sp.calls.filter((c) => c[0] === 'tasklist');
const TASKLIST_ARGS = ['/FI', 'IMAGENAME eq LessonPlayerApp.exe', '/FO', 'CSV', '/NH'];

(async () => {
  // Default wiring (no spawn, no isRunning injected): school asks procfind.
  f = fakeApi(LIST); procfind.__test.use(f);
  let s = schoolModule.create({ autoStart: false, notesDir, userDataDir: tmp });
  await s.__test.checkPresence();
  eq('school, default wiring: LessonPlayer in the list -> running', s.__test.presence().running, true);
  ok('school, default wiring: asked procfind', f.snaps === 1, 'snapshots ' + f.snaps);
  f = fakeApi(LIST.filter((n) => !/lessonplayer/i.test(n))); procfind.__test.use(f);
  await s.__test.checkPresence();
  eq('school, default wiring: LessonPlayer gone -> not running', s.__test.presence().running, false);
  eq('school, default wiring: no reason when procfind answered', s.__test.presence().reason, '');
  eq('school, default wiring: no process was spawned', realSpawns, []);
  s.stop();

  // isRunning injected over procfind, plus a spawn that would record any tasklist call.
  let sp = fakeSpawn({ out: '"LessonPlayerApp.exe","4242","Console","1","90,000 K"\r\n' });
  f = fakeApi(LIST); procfind.__test.use(f);
  s = schoolModule.create({ autoStart: false, notesDir, userDataDir: tmp, spawn: sp, isRunning: (n) => procfind.running(n) });
  await s.__test.checkPresence();
  eq('school + procfind: running', s.__test.presence().running, true);
  eq('school + procfind: tasklist never spawned', tasklistCalls(sp).length, 0);
  // procfind cannot answer -> the tasklist fallback, with the exact old command.
  procfind.__test.use(null);
  s.__test.setLessonPlayer(false);
  await s.__test.checkPresence();
  eq('fallback: tasklist says running', s.__test.presence().running, true);
  eq('fallback: the same tasklist command as before', tasklistCalls(sp).map((c) => c[1]), [TASKLIST_ARGS]);
  s.stop();

  sp = fakeSpawn({ out: 'INFO: No tasks are running which match the specified criteria.\r\n' });
  s = schoolModule.create({ autoStart: false, notesDir, userDataDir: tmp, spawn: sp, isRunning: () => null });
  s.__test.setLessonPlayer(true);
  await s.__test.checkPresence();
  eq('fallback: tasklist says not running', s.__test.presence().running, false);
  eq('fallback: one tasklist call', tasklistCalls(sp).length, 1);
  s.stop();

  sp = fakeSpawn({ throws: 'spawn tasklist ENOENT' });
  s = schoolModule.create({ autoStart: false, notesDir, userDataDir: tmp, spawn: sp, isRunning: () => null });
  await s.__test.checkPresence();
  const p = s.__test.presence();
  ok('fallback: tasklist failing is an error with its reason, not "not running"',
    /cannot tell whether LessonPlayer is running: spawn tasklist ENOENT/.test(p.reason) && p.reader.state === 'error', JSON.stringify(p));
  s.stop();

  // A harness that injects only spawn keeps the tasklist call it always got.
  sp = fakeSpawn({ out: '"LessonPlayerApp.exe","1","Console","1","1 K"\r\n' });
  f = fakeApi(LIST); procfind.__test.use(f);
  s = schoolModule.create({ autoStart: false, notesDir, userDataDir: tmp, spawn: sp });
  await s.__test.checkPresence();
  eq('spawn-only harness: still tasklist', [tasklistCalls(sp).length, f.snaps], [1, 0]);
  eq('spawn-only harness: running', s.__test.presence().running, true);
  s.stop();

  // The push to the chrome (school.js schedulePush): a check that changes nothing arms no timer
  // (the idle wakeup fix, 2026-10-15); a change still goes out once, after the debounce.
  const sends = [];
  let reasonNow = 'spawn tasklist ENOENT';
  sp = (file, args) => { if (file === 'tasklist') throw new Error(reasonNow); return fakeSpawn({})(file, args); };
  s = schoolModule.create({ autoStart: false, notesDir, userDataDir: tmp, spawn: sp, isRunning: () => null, send: (ch, st) => sends.push([ch, st.reader.reason]) });
  const realSetTimeout = global.setTimeout;
  let pushTimers = 0;
  global.setTimeout = function countPush(fn, ms, ...rest) { if (ms === 100) pushTimers++; return realSetTimeout.call(this, fn, ms, ...rest); };
  const settle = () => new Promise((r) => realSetTimeout(r, 250));
  try {
    await s.__test.checkPresence(); await settle();
    const first = sends.length;
    ok('push: a new reader state is sent', first >= 1 && /spawn tasklist ENOENT/.test(sends[sends.length - 1][1]), JSON.stringify(sends));
    pushTimers = 0;
    await s.__test.checkPresence(); await settle();
    await s.__test.checkPresence(); await settle();
    eq('push: the same state twice arms no timer and sends nothing', [pushTimers, sends.length], [0, first]);
    reasonNow = 'tasklist exploded';
    await s.__test.checkPresence(); await settle();
    eq('push: a changed state arms one timer and sends once', [pushTimers, sends.length], [1, first + 1]);
    ok('push: the sent state is the new one', /tasklist exploded/.test(sends[sends.length - 1][1]), JSON.stringify(sends[sends.length - 1]));
  } finally { global.setTimeout = realSetTimeout; s.stop(); }

  // The 3 s reader runs only while LessonPlayer does (lane idle2, 2026-10-15): started on the "running"
  // edge with one read at once, stopped on the "closed" edge; while closed, one read says so.
  let lessonplayerUp = false;
  const noChildren = () => { throw new Error('harness: no child processes'); };
  const realSetInterval = global.setInterval;
  let readIntervals = 0;
  global.setInterval = function countRead(fn, ms, ...rest) { if (ms === 3000) readIntervals++; return realSetInterval.call(this, fn, ms, ...rest); };
  try {
    s = schoolModule.create({ notesDir, userDataDir: tmp, spawn: noChildren, isRunning: () => lessonplayerUp });
    await settle();
    eq('reader gate: LessonPlayer closed at start -> no 3 s reader', [s.__test.readerTimer(), readIntervals], [false, 0]);
    eq('reader gate: the pane is told it is not running', s.__test.state.reader.reason, 'LessonPlayer is not running');
    lessonplayerUp = true;
    await s.__test.checkPresence(); await settle();
    eq('reader gate: LessonPlayer opens -> the 3 s reader starts', [s.__test.readerTimer(), readIntervals], [true, 1]);
    ok('reader gate: and reads at once', s.__test.state.reader.reason !== 'LessonPlayer is not running', s.__test.state.reader.reason);
    await s.__test.checkPresence(); await settle();
    eq('reader gate: still running -> the same reader, no second one', [s.__test.readerTimer(), readIntervals], [true, 1]);
    lessonplayerUp = false;
    await s.__test.checkPresence(); await settle();
    eq('reader gate: LessonPlayer closes -> the reader stops', s.__test.readerTimer(), false);
    eq('reader gate: and the pane says so', s.__test.state.reader.reason, 'LessonPlayer is not running');
    lessonplayerUp = true;
    await s.__test.checkPresence(); await settle();
    eq('reader gate: LessonPlayer opens again -> one new reader', [s.__test.readerTimer(), readIntervals], [true, 2]);
  } finally { global.setInterval = realSetInterval; s.stop(); }
  eq('reader gate: stop() clears the reader', s.__test.readerTimer(), false);

  /* ---- 3. live: the real snapshot, where koffi is installed ---------------------------------- */
  childProcess.spawn = realSpawn;
  procfind.__test.use(undefined);
  let haveKoffi = false;
  try { require.resolve('koffi'); haveKoffi = true; } catch (e) { /* not installed here */ }
  if (process.platform === 'win32' && haveKoffi) {
    const me = path.basename(process.execPath);
    eq('live: this process (' + me + ') is running', procfind.running(me), true);
    eq('live: a made-up name is not', procfind.running('procfind-no-such-' + process.pid + '.exe'), false);
    eq('live: no reason recorded', procfind.reason(), '');
  } else {
    console.log('live: skipped (' + (process.platform !== 'win32' ? 'not Windows' : 'koffi not installed here') + ')');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`procfind-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness threw: ' + (e && e.stack)); console.log(`procfind-test: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
