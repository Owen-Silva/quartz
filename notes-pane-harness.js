// school-harness.js - pure-node test for what school.js asks of school-reader.ps1 and what it
// does with the answers (run: node school-harness.js). No PowerShell, no LessonPlayer, no Electron:
// the reader is a fake child that records every JSON line and answers "read" from a script.
//
// 1. The 3 s timer's read never forces a walk (so the script's change gate can answer it);
//    "probe" always sends force:true.
// 2. A gated (cached) answer with the same text is "the same question", and a new question still
//    needs a repeat to settle, exactly as before.
// 3. When the script reports its gate is off ("gate": reason), the pane's reason says so.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const schoolModule = require('./school');

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? '\n  ' + extra : '')); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'school-harness-'));
const notesDir = path.join(tmp, 'notes'); fs.mkdirSync(notesDir);

const Q1 = 'Question 1: A gas occupies 4.0 L at 300 K. What volume at 450 K?\n2.7 L\n4.0 L\n6.0 L\n8.0 L';
const Q2 = 'Question 2: Which law relates pressure and volume at constant temperature?\nBoyle\nCharles';

/** A fake powershell child: answer(msg) returns the reply object for each command line. */
function fakeReader(answer) {
  const sent = [];
  const fn = (file, args) => {
    if (file !== 'powershell.exe') throw new Error('unexpected spawn ' + file);
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {};
    c.stderr = new EventEmitter(); c.stderr.setEncoding = () => {};
    c.kill = () => {};
    c.stdin = {
      write(line) {
        const msg = JSON.parse(line);
        sent.push(msg);
        if (msg.cmd === 'quit') return true;
        const reply = Object.assign({ id: msg.id, cmd: msg.cmd }, answer(msg));
        setImmediate(() => c.stdout.emit('data', JSON.stringify(reply) + '\n'));
        return true;
      },
    };
    return c;
  };
  fn.sent = sent;
  return fn;
}

(async () => {
  let text = Q1, gate = '', cachedNext = false;
  const sp = fakeReader((msg) => {
    if (msg.cmd !== 'read') return { ok: false, reason: 'not in this test' };
    const cached = cachedNext && !msg.force;
    return { ok: true, title: 'LessonPlayer', text, chars: text.length, via: 'uia-text-pattern', cached, walked: cached ? '' : (msg.force ? 'forced' : 'events'), gate };
  });
  const s = schoolModule.create({ autoStart: false, notesDir, userDataDir: tmp, spawn: sp, isRunning: () => true });
  s.__test.setLessonPlayer(true);
  s.__test.state.helper.enabled = false;   // no helper calls in this test

  // 1. timer reads carry no force.
  await s.__test.readOnce();
  const r1 = sp.sent.filter((m) => m.cmd === 'read');
  ok('timer read: one read sent', r1.length === 1, JSON.stringify(sp.sent));
  ok('timer read: no force flag (the script may answer from its gate)', r1[0] && r1[0].force === undefined, JSON.stringify(r1[0]));
  ok('timer read: asks for LessonPlayer by process name', r1[0] && r1[0].process === 'LessonPlayerApp', JSON.stringify(r1[0]));

  // 2. settle: Q1 seen once, then a cached repeat settles it.
  cachedNext = true;
  await s.__test.readOnce();
  const q = s.__test.state.reader.question;
  ok('a cached repeat of the same text settles the question', q && q.text === Q1, JSON.stringify(q));
  await s.__test.readOnce();
  ok('another cached answer is "the same question"', /same question as the last read/.test(s.__test.state.reader.reason), s.__test.state.reader.reason);

  // A new question still needs two equal reads before it replaces the old one.
  text = Q2; cachedNext = false;
  await s.__test.readOnce();
  ok('a new question is not taken on its first read', s.__test.state.reader.question.text === Q1, s.__test.state.reader.reason);
  cachedNext = true;
  await s.__test.readOnce();
  ok('it is taken on the repeat (cached is fine)', s.__test.state.reader.question.text === Q2, s.__test.state.reader.reason);

  // 1b. probe forces a walk.
  const before = sp.sent.length;
  const out = await s.command('probe', {});
  const probeReads = sp.sent.slice(before).filter((m) => m.cmd === 'read');
  ok('probe: one read, with force:true', probeReads.length === 1 && probeReads[0].force === true, JSON.stringify(probeReads));
  ok('probe: answers ok in uia mode', out && out.ok && out.mode === 'uia', JSON.stringify(out));

  // 3. the gate is off: the reason says why, in words.
  gate = 'the change events missed a new page (caught by the safety read at 12:00:00); every read walks the tree now';
  await s.__test.readOnce();
  ok('gate off: the pane reason says reads re-walk, and why', /re-reading every time: the change events missed a new page/.test(s.__test.state.reader.reason), s.__test.state.reader.reason);
  gate = '';
  await s.__test.readOnce();
  ok('gate on: no such note', !/re-reading every time/.test(s.__test.state.reader.reason), s.__test.state.reader.reason);

  s.stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log('school-harness: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('school-harness crashed: ' + (e && e.stack || e)); console.log('school-harness: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
