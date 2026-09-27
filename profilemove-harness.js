'use strict';
// Pure-node harness for C:\Users\you\browser\profilemove.js. Temp folders only;
// never touches %APPDATA%. Run: node profilemove-harness.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const pm = require('C:/Users/you/browser/profilemove.js');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-id-harness-'));
let n = 0;
function pair(withOld, withNew) {
  const base = path.join(root, 'case' + (++n));
  fs.mkdirSync(base);
  const oldDir = path.join(base, 'browser');
  const newDir = path.join(base, 'Quartz');
  if (withOld) { fs.mkdirSync(path.join(oldDir, 'Local Storage'), { recursive: true }); fs.writeFileSync(path.join(oldDir, 'Cookies'), 'old-cookies'); }
  if (withNew) { fs.mkdirSync(newDir); fs.writeFileSync(path.join(newDir, 'Preferences'), 'new-prefs'); }
  return { base, oldDir, newDir };
}
const listing = (d) => fs.existsSync(d) ? fs.readdirSync(d).sort().join(',') : '<missing>';
const noSleep = () => {};
const shim = (over) => Object.assign({}, fs, over);

function holdLock(file, mode, holdMs) {
  // A child that opens `file` the way Chromium opens `lockfile`: write access,
  // FileShare.Read only (no FILE_SHARE_DELETE), delete-on-close. Or, for mode
  // 'cwd', a process whose working directory is inside the folder.
  const ps =
    mode === 'cwd'
      ? `Set-Location -LiteralPath '${path.dirname(file)}'; [Environment]::CurrentDirectory = (Get-Location).Path; 'LOCKED'; Start-Sleep -Milliseconds ${holdMs}`
      : `$f = New-Object IO.FileStream('${file}', 'Create', 'Write', 'Read', 4096, 'DeleteOnClose'); 'LOCKED'; Start-Sleep -Milliseconds ${holdMs}; $f.Close()`;
  const child = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  return new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; if (buf.includes('LOCKED')) resolve(child); });
    child.on('exit', (c) => reject(new Error('lock child exited early ' + c)));
    setTimeout(() => reject(new Error('lock child never locked')), 20000);
  });
}
const waitExit = (child) => new Promise((r) => { if (child.exitCode !== null) return r(); child.removeAllListeners('exit'); child.on('exit', () => r()); });

(async () => {
  console.log('1. same folder (the app is still called browser): inert');
  {
    const { oldDir } = pair(true, false);
    const before = listing(oldDir);
    const r = pm.runProfileMove(oldDir, oldDir, fs, { sleep: noSleep });
    ok(r.ok && r.action === 'same', 'identical paths -> same, ok');
    const r2 = pm.runProfileMove(oldDir, oldDir.toUpperCase() + path.sep, fs, { sleep: noSleep });
    ok(r2.action === 'same', 'case / trailing-slash variant of the same folder -> same (win32)');
    ok(listing(oldDir) === before, 'old folder untouched');
  }

  console.log('2. old only: rename');
  {
    const { oldDir, newDir } = pair(true, false);
    const r = pm.runProfileMove(oldDir, newDir, fs, { sleep: noSleep });
    ok(r.ok && r.action === 'moved' && r.attempts === 1, 'moved on attempt 1');
    ok(!fs.existsSync(oldDir), 'old folder gone');
    ok(fs.readFileSync(path.join(newDir, 'Cookies'), 'utf8') === 'old-cookies' && fs.existsSync(path.join(newDir, 'Local Storage')), 'contents arrived intact');
    ok(pm.writeMoveNote(newDir, r, fs) === '', 'note written');
    const note = pm.readMoveNote(newDir, fs);
    ok(note && note.from === path.resolve(oldDir) && note.to === path.resolve(newDir) && !!note.at, 'note reads back from/to/at');
    const again = pm.runProfileMove(oldDir, newDir, fs, { sleep: noSleep });
    ok(again.ok && again.action === 'normal' && !again.fresh, 'next start is a normal start');
  }

  console.log('3. new only: normal start');
  {
    const { oldDir, newDir } = pair(false, true);
    const r = pm.runProfileMove(oldDir, newDir, fs, { sleep: noSleep });
    ok(r.ok && r.action === 'normal' && !r.fresh, 'normal');
    ok(listing(newDir) === 'Preferences' && !fs.existsSync(oldDir), 'nothing created or changed');
    ok(pm.readMoveNote(newDir, fs) === null, 'no note -> null');
  }

  console.log('4. neither: genuine first run');
  {
    const { oldDir, newDir } = pair(false, false);
    const r = pm.runProfileMove(oldDir, newDir, fs, { sleep: noSleep });
    ok(r.ok && r.action === 'normal' && r.fresh === true, 'normal, fresh');
    ok(!fs.existsSync(oldDir) && !fs.existsSync(newDir), 'nothing created');
  }

  console.log('5. both exist: refuse, touch neither');
  {
    const { oldDir, newDir } = pair(true, true);
    const bo = listing(oldDir), bn = listing(newDir);
    const r = pm.runProfileMove(oldDir, newDir, fs, { sleep: noSleep });
    ok(!r.ok && r.action === 'refuse' && r.code === 'EEXIST', 'refuse EEXIST');
    ok(listing(oldDir) === bo && listing(newDir) === bn, 'both folders untouched');
    const t = pm.refusalText(r, oldDir, newDir);
    ok(t.body.includes(oldDir) && t.body.includes(newDir), 'box names both folders');
    ok(/BOTH folders exist/.test(t.body) && /close the other window/i.test(t.body) && /start Quartz again/.test(t.body), 'box says why and what to do');
  }

  console.log('6. LOCKED: a file held open inside the old folder the way Chromium holds lockfile');
  {
    const { oldDir, newDir } = pair(true, false);
    const bo = listing(oldDir);
    const child = await holdLock(path.join(oldDir, 'lockfile'), 'file', 30000);
    let sleeps = 0;
    const t0 = Date.now();
    const r = pm.runProfileMove(oldDir, newDir, fs, { retries: 3, delayMs: 100, sleep: (ms) => { sleeps++; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } });
    const ms = Date.now() - t0;
    ok(!r.ok && r.action === 'refuse' && r.stage === 'rename', 'refused at the rename (' + r.code + ', ' + ms + ' ms)');
    ok(['EPERM', 'EBUSY', 'EACCES'].includes(r.code), 'code is a lock code: ' + r.code);
    ok(r.attempts === 4 && sleeps === 3, 'retried 3 times before refusing (attempts=' + r.attempts + ')');
    ok(fs.existsSync(oldDir) && !fs.existsSync(newDir), 'old folder still there, NO new (empty) folder created');
    ok(listing(oldDir) === bo + ',lockfile' || listing(oldDir) === ['Cookies', 'Local Storage', 'lockfile'].sort().join(','), 'old contents intact');
    const t = pm.refusalText(r, oldDir, newDir);
    ok(t.body.includes(oldDir) && t.body.includes(newDir), 'box names the folder');
    ok(t.body.includes('Close the other window and start Quartz again') && t.body.includes(r.code), 'box says why (' + r.code + ') and "Close the other window and start Quartz again"');
    child.kill();
    await waitExit(child);
  }

  console.log('7. LOCKED by a process whose working directory is inside the old folder');
  {
    const { oldDir, newDir } = pair(true, false);
    const child = await holdLock(path.join(oldDir, 'Local Storage', 'x'), 'cwd', 30000);
    const r = pm.runProfileMove(oldDir, newDir, fs, { retries: 1, delayMs: 50 });
    ok(!r.ok && r.stage === 'rename' && ['EPERM', 'EBUSY', 'EACCES'].includes(r.code), 'refused (' + r.code + ')');
    ok(fs.existsSync(oldDir) && !fs.existsSync(newDir), 'old intact, no new folder');
    child.kill();
    await waitExit(child);
  }

  console.log('8. lock released while we retry (the Restart-browser path): moves on a later attempt');
  {
    const { oldDir, newDir } = pair(true, false);
    const child = await holdLock(path.join(oldDir, 'lockfile'), 'file', 700);
    const r = pm.runProfileMove(oldDir, newDir, fs, { retries: 8, delayMs: 300 });
    ok(r.ok && r.action === 'moved' && r.attempts > 1, 'moved after ' + r.attempts + ' attempts');
    ok(!fs.existsSync(oldDir) && fs.readFileSync(path.join(newDir, 'Cookies'), 'utf8') === 'old-cookies', 'contents arrived');
    await waitExit(child);
  }

  console.log('9. race: another copy renamed it first (our rename fails ENOENT)');
  {
    const { oldDir, newDir } = pair(true, false);
    const f = shim({ renameSync: (a, b) => { fs.renameSync(a, b); const e = new Error('ENOENT: gone'); e.code = 'ENOENT'; throw e; } });
    const r = pm.runProfileMove(oldDir, newDir, f, { sleep: noSleep });
    ok(r.ok && r.action === 'normal' && r.raced === true, 'normal start, raced');
  }

  console.log('10. a new folder appears between the decision and the rename');
  {
    const { oldDir, newDir } = pair(true, false);
    const f = shim({ renameSync: () => { fs.mkdirSync(newDir); const e = new Error('EPERM: op not permitted'); e.code = 'EPERM'; throw e; } });
    const r = pm.runProfileMove(oldDir, newDir, f, { sleep: noSleep });
    ok(!r.ok && r.code === 'EEXIST' && r.renameCode === 'EPERM', 'refuse EEXIST (rename said EPERM)');
    ok(fs.existsSync(path.join(oldDir, 'Cookies')), 'old untouched');
  }

  console.log('11. stat fails / wrong kind of thing on disk: refuse, never guess "missing"');
  {
    const { oldDir, newDir } = pair(true, false);
    const f = shim({ statSync: (p) => { if (p === oldDir) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } return fs.statSync(p); } });
    const r = pm.runProfileMove(oldDir, newDir, f, { sleep: noSleep });
    ok(!r.ok && r.code === 'EACCES' && r.stage === undefined, 'stat EACCES on old -> refuse');
    const t = pm.refusalText(r, oldDir, newDir);
    ok(!/something still has files open/.test(t.body) && /could not check the old profile folder/.test(t.body) && /start Quartz again/.test(t.body), 'box gives the stat reason, not the lock story');
    const g = pair(false, false);
    fs.writeFileSync(g.oldDir, 'not a folder');
    const r2 = pm.runProfileMove(g.oldDir, g.newDir, fs, { sleep: noSleep });
    ok(!r2.ok && r2.code === 'ENOTDIR' && !fs.existsSync(g.newDir), 'old path is a file -> refuse, nothing created');
    const h = pair(true, false);
    fs.writeFileSync(h.newDir, 'not a folder');
    const r3 = pm.runProfileMove(h.oldDir, h.newDir, fs, { sleep: noSleep });
    ok(!r3.ok && r3.code === 'ENOTDIR' && fs.existsSync(path.join(h.oldDir, 'Cookies')), 'new path is a file -> refuse, old untouched');
  }

  console.log('12. a rename error that is not a lock: no retries, refused');
  {
    const { oldDir, newDir } = pair(true, false);
    let calls = 0;
    const f = shim({ renameSync: () => { calls++; const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e; } });
    const r = pm.runProfileMove(oldDir, newDir, f, { sleep: noSleep });
    ok(!r.ok && r.code === 'EXDEV' && calls === 1, 'refused after one attempt');
    ok(/start Quartz again/.test(pm.refusalText(r, oldDir, newDir).body), 'box still says what to do');
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\nprofilemove harness: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log(`\nprofilemove harness: ${pass} passed, ${fail + 1} failed (crashed)`); process.exit(1); });
