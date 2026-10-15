'use strict';
// sessionfile-harness.js - the session.json writer (sessionfile.js), pure node, no Quartz.
//   node sessionfile-harness.js
// The case that matters: a rename that fails for a moment (a scanner holding session.json) must
// not lose the snapshot. The last case makes a REAL Windows lock with PowerShell
// (FileShare.Read, no delete-sharing: what a scanner does) and writes through it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const SF = require('./sessionfile');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail))); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return !!fn(); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionfile-'));
const file = path.join(dir, 'session.json');
const read = () => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; } };
const tmpLeft = () => fs.existsSync(file + '.tmp');

/** Real fs, except rename fails `n` more times with `code`. */
function flaky() {
  const f = { fails: 0, code: 'EPERM', renames: 0 };
  f.fs = {
    promises: {
      writeFile: (...a) => fs.promises.writeFile(...a),
      rename: (a, b) => { f.renames++; if (f.fails > 0) { f.fails--; return Promise.reject(Object.assign(new Error(f.code + ': operation not permitted, rename'), { code: f.code })); } return fs.promises.rename(a, b); },
    },
    writeFileSync: (...a) => fs.writeFileSync(...a),
    renameSync: (a, b) => { f.renames++; if (f.fails > 0) { f.fails--; throw Object.assign(new Error(f.code), { code: f.code }); } return fs.renameSync(a, b); },
  };
  return f;
}

(async () => {
  try {
    // 1. the plain path
    let w = SF.create({ target: () => file });
    w.write('{"n":1}');
    ok('a write lands, no .tmp left', await until(() => read() === '{"n":1}' && !tmpLeft(), 2000), read());

    // 2. a burst collapses to the newest
    w.write('{"n":2}'); w.write('{"n":3}'); w.write('{"n":4}');
    ok('a burst ends on the newest snapshot', await until(() => read() === '{"n":4}' && !w.state().writing, 2000), read());

    // 3. rename refused twice (a scanner): the snapshot is kept and lands on a retry
    let f = flaky();
    w = SF.create({ target: () => file, fs: f.fs });
    f.fails = 2;
    w.write('{"n":5}');
    ok('refused rename: kept, not dropped', await until(() => w.state().failures === 1 && w.state().pending, 2000), w.state());
    ok('refused rename: lands on a retry, .tmp gone', await until(() => read() === '{"n":5}' && !tmpLeft(), 3000), { file: read(), state: w.state() });
    ok('after it lands: no failures, nothing pending', !w.state().pending && w.state().failures === 0, w.state());

    // 4. a newer snapshot during a failing write supersedes it
    f.fails = 1; f.code = 'EBUSY';
    w.write('{"n":6}');
    w.write('{"n":7}');
    ok('newer snapshot wins over the one that failed', await until(() => read() === '{"n":7}' && !w.state().pending, 3000), read());

    // 5. quit right after a failure: flushSync writes the kept snapshot (the old pump wrote nothing)
    f.fails = 1; f.code = 'EACCES';
    w.write('{"n":8}');
    await until(() => w.state().failures === 1, 2000);
    ok('quit after a failure: flushSync writes it', w.flushSync() === true && read() === '{"n":8}' && !w.state().pending, read());
    f.fails = 2;
    w.write('{"n":9}'); // async attempt fails once; flushSync retries through the second
    await until(() => w.state().failures === 1 && !w.state().writing, 2000);
    ok('flushSync retries a refused rename', w.flushSync() === true && read() === '{"n":9}', read());
    await sleep(2200); // let the queued async retry run: it must find nothing to do
    f.fails = 1;
    w.write('{"n":11}'); // quit while this write is still in flight (and about to be refused)
    ok('quit mid-write: flushSync writes the in-flight snapshot', w.state().writing && w.flushSync() === true && read() === '{"n":11}', read());
    ok('no stale write after the flush', read() === '{"n":11}', read());

    // 6. a REAL lock: hold session.json without delete-sharing, write through it
    if (process.platform === 'win32') {
      w = SF.create({ target: () => file });
      const ps = spawn('powershell', ['-NoProfile', '-Command',
        "$f = [System.IO.File]::Open('" + file.replace(/'/g, "''") + "', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 1500; $f.Close()"],
      { windowsHide: true });
      let out = '';
      ps.stdout.on('data', (d) => { out += d; });
      const gone = new Promise((r) => ps.on('close', r));
      const locked = await until(() => /locked/.test(out), 15000);
      ok('real lock: PowerShell holds session.json (share Read only)', locked, out);
      w.write('{"n":10}');
      ok('real lock: the rename is refused while held', await until(() => w.state().failures >= 1, 1400), w.state());
      await gone;
      ok('real lock: the snapshot lands after the lock goes, no .tmp left', await until(() => read() === '{"n":10}' && !tmpLeft(), 4000), { file: read(), state: w.state() });
    } else console.log('SKIP real lock: Windows only');
  } catch (e) {
    ok('HARNESS ERROR ' + (e && e.stack || e), false);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`sessionfile-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
