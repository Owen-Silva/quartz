// notes-pane-harness.js - pure-node test for notes-pane-main.js: its config (notes-pane.json),
// what it asks of notes-reader.ps1 and what it does with the answers
// (run: node notes-pane-harness.js). No PowerShell, no reader app, no Claude, no Electron:
// the reader is a fake child that records every JSON line and answers "read" from a script,
// and any other spawn fails the test.
//
// 1. The 3 s timer's read never forces a walk (so the script's change gate can answer it);
//    "probe" always sends force:true. The process asked for is the configured reader.exe.
// 2. A gated (cached) answer with the same text is "the same question", and a new question still
//    needs a repeat to settle, exactly as before.
// 3. When the script reports its gate is off ("gate": reason), the pane's reason says so.
// 4. OFF BY DEFAULT: a fresh, empty userData = configured:false with a reason, nothing
//    scanned, watched, polled or spawned, and every command but set-dir refused.
// 5. The config: dir / reader / aliases / budgetDir read from notes-pane.json; the pane's own
//    keys are written back without dropping any other key; set-dir validates and restarts.
// 6. Subjects come from the notes folder: names and file stems match with no aliases;
//    configured aliases replace the stems.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const notesModule = require('./notes-pane-main');

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? '\n  ' + extra : '')); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-pane-harness-'));
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

/** A spawn that must never be called: records the attempt and fails it. */
function noSpawn() {
  const calls = [];
  const fn = (file, args) => { calls.push(file + ' ' + (args || []).join(' ')); throw new Error('no spawn allowed here: ' + file); };
  fn.calls = calls;
  return fn;
}

function freshDir(name) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function page(title, sections) {
  return '<html><head><title>' + title + ' Notebook</title></head><body>'
    + sections.map((s) => '<section id="' + s + '"><h2>' + s + ' heading</h2><p>About ' + s + '.</p></section>').join('')
    + '</body></html>';
}

(async () => {
  /* ---- 1-3: the reader protocol ---------------------------------------- */
  let text = Q1, gate = '', cachedNext = false;
  const sp = fakeReader((msg) => {
    if (msg.cmd !== 'read') return { ok: false, reason: 'not in this test' };
    const cached = cachedNext && !msg.force;
    return { ok: true, title: 'Stand-in', text, chars: text.length, via: 'uia-text-pattern', cached, walked: cached ? '' : (msg.force ? 'forced' : 'events'), gate };
  });
  const s = notesModule.create({ autoStart: false, notesDir, userDataDir: tmp, spawn: sp, isRunning: () => true, reader: { exe: 'StandIn.exe' } });
  s.__test.setAppRunning(true);
  s.__test.state.helper.enabled = false;   // no helper calls in this test

  // 1. timer reads carry no force.
  await s.__test.readOnce();
  const r1 = sp.sent.filter((m) => m.cmd === 'read');
  ok('timer read: one read sent', r1.length === 1, JSON.stringify(sp.sent));
  ok('timer read: no force flag (the script may answer from its gate)', r1[0] && r1[0].force === undefined, JSON.stringify(r1[0]));
  ok('timer read: asks for the configured reader app by process name', r1[0] && r1[0].process === 'StandIn', JSON.stringify(r1[0]));

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

  /* ---- 4: off by default ----------------------------------------------- */
  {
    const empty = freshDir('empty-profile');
    const never = noSpawn();
    const sends = [];
    const off = notesModule.create({ userDataDir: empty, spawn: never, isRunning: () => { throw new Error('polled'); }, send: (ch) => sends.push(ch) });
    const st = off.describe();
    ok('off: configured is false', st.configured === false, JSON.stringify(st));
    ok('off: the reason says how to turn it on', /no notes folder is set: pick one in Settings > Notes pane/.test(st.reason), st.reason);
    ok('off: no subjects, no dir', st.subjects.length === 0 && st.dir === '', JSON.stringify(st.subjects));
    ok('off: configFile names notes-pane.json in userData', st.configFile === path.join(empty, 'notes-pane.json'), st.configFile);
    const run = off.__test.running();
    ok('off: nothing scans, watches, polls, reads or spawns', Object.keys(run).every((k) => run[k] === false), JSON.stringify(run));
    const refused = await off.command('probe', {});
    ok('off: a command is refused with the reason', refused && refused.ok === false && /the notes pane is off/.test(refused.reason), JSON.stringify(refused));
    await new Promise((r) => setTimeout(r, 150));
    ok('off: no spawn at all', never.calls.length === 0, JSON.stringify(never.calls));
    ok('off: no notes-pane.json was written', !fs.existsSync(path.join(empty, 'notes-pane.json')));
    off.stop();
  }

  /* ---- 5: the config file ---------------------------------------------- */
  {
    const prof = freshDir('profile-a');
    const dirA = freshDir('notes-a');
    fs.writeFileSync(path.join(dirA, 'alpha-topic.html'), page('Alpha Topic', ['a1', 'a2']));
    fs.writeFileSync(path.join(dirA, 'beta.html'), page('Beta Things', ['b1']));
    const cfg = {
      dir: dirA, helperEnabled: false, helperModel: 'some-model', pinned: false, manualSubjectId: null,
      claudeBin: path.join(tmp, 'fake-claude.exe'),
      reader: { exe: 'Reader.exe', name: 'The Reader', cdpPort: 9444, urlPatterns: ['/lesson/'], topicSelectors: ['.heading'] },
      myOwnKey: { kept: true }
    };
    fs.writeFileSync(path.join(prof, 'notes-pane.json'), JSON.stringify(cfg, null, 2));
    const never = noSpawn();
    const m = notesModule.create({ userDataDir: prof, spawn: never, autoStart: false });
    const st = m.describe();
    ok('config: configured with the dir', st.configured === true && st.dir === dirA, JSON.stringify({ c: st.configured, d: st.dir, r: st.reason }));
    ok('config: subjects come from the folder', st.subjects.map((r) => r.id + '=' + r.name).join(',') === 'alpha-topic=Alpha Topic,beta=Beta Things', JSON.stringify(st.subjects));
    ok('config: reader configured, named, on its port', st.reader.configured && st.reader.app === 'The Reader' && st.reader.port === 9444 && st.policy.port === 9444, JSON.stringify(st.reader));
    ok('config: helper switch and model from the file', st.helper.enabled === false && st.helper.model === 'some-model', JSON.stringify(st.helper));
    const c = m.__test.config();
    ok('config: reader details resolved', c.reader.proc === 'Reader' && c.reader.urlPatterns[0] === '/lesson/' && c.reader.topicSelectors[0] === '.heading', JSON.stringify(c.reader));
    ok('config: claudeBin from the file', c.claudeBin === cfg.claudeBin, c.claudeBin);
    const v = m.__test.budgetVerdict();
    ok('config: no budgetDir = the helper says no budget source is configured', !v.pause && /no budget source is configured \(budgetDir in notes-pane.json\)/.test(v.note), JSON.stringify(v));

    // 6. stems match with no aliases.
    m.__test.state.subjects = st.subjects;
    const hit = m.__test.matchTopicToSubject('Unit 3 - Alpha Topic review');
    ok('match: a subject name in the topic', hit && hit.id === 'alpha-topic', JSON.stringify(hit));
    const stem = m.__test.matchTopicToSubject('BETA quiz');
    ok('match: a file stem as words', stem && stem.id === 'beta', JSON.stringify(stem));

    // The pane's own keys go back without dropping the rest.
    const res = await m.command('pin', { on: true });
    const saved = JSON.parse(fs.readFileSync(path.join(prof, 'notes-pane.json'), 'utf8'));
    ok('save: pin stored', res && res.ok !== false && saved.pinned === true, JSON.stringify(saved));
    ok('save: every other key kept', saved.myOwnKey && saved.myOwnKey.kept === true && saved.reader.exe === 'Reader.exe' && saved.dir === dirA, JSON.stringify(saved));

    // set-dir: refuses a non-folder, accepts a folder, null turns it off.
    const bad = await m.command('set-dir', { dir: path.join(tmp, 'nope') });
    ok('set-dir: a missing folder is refused', bad && bad.ok === false && /not a folder/.test(bad.reason), JSON.stringify(bad));
    const dirB = freshDir('notes-b');
    fs.writeFileSync(path.join(dirB, 'gamma.html'), page('Gamma', ['g1']));
    const good = await m.command('set-dir', { dir: dirB });
    const st2 = m.describe();
    ok('set-dir: switches folder and rescans', good && good.ok && st2.dir === dirB && st2.subjects.length === 1 && st2.subjects[0].id === 'gamma', JSON.stringify({ good, d: st2.dir, s: st2.subjects }));
    const offRes = await m.command('set-dir', { dir: null });
    const st3 = m.describe();
    const after = JSON.parse(fs.readFileSync(path.join(prof, 'notes-pane.json'), 'utf8'));
    ok('set-dir null: off, dir removed, other keys kept', offRes.ok && st3.configured === false && !('dir' in after) && after.myOwnKey && after.myOwnKey.kept, JSON.stringify({ offRes, after }));
    const run = m.__test.running();
    ok('set-dir null: nothing left running', Object.keys(run).every((k) => run[k] === false), JSON.stringify(run));
    ok('config: nothing was spawned', never.calls.length === 0, JSON.stringify(never.calls));
    m.stop();
  }

  /* ---- 6b: aliases replace stems; no reader = says so, spawns nothing ---- */
  {
    const prof = freshDir('profile-b');
    const dirC = freshDir('notes-c');
    fs.writeFileSync(path.join(dirC, 'one.html'), page('First Book', ['x']));
    fs.writeFileSync(path.join(dirC, 'two.html'), page('Second Book', ['y']));
    fs.writeFileSync(path.join(prof, 'notes-pane.json'), JSON.stringify({ dir: dirC, subjectAliases: { two: ['deux', 'second'], missing: ['ghost'] } }));
    const never = noSpawn();
    const m = notesModule.create({ userDataDir: prof, spawn: never, autoStart: false });
    ok('aliases: an alias picks its subject', (m.__test.matchTopicToSubject('Chapter deux') || {}).id === 'two');
    ok('aliases: replace the stems (no stem match)', m.__test.matchTopicToSubject('one') === null);
    ok('aliases: an alias for a missing file is skipped', m.__test.matchTopicToSubject('ghost') === null);
    const read = await m.__test.readOnce();
    ok('no reader: the read says no reader app is configured', read.ok === false && /no reader app is configured/.test(read.reason), JSON.stringify(read));
    const pol = await m.command('install-policy', {});
    ok('no reader: install-policy refused with a reason', pol.ok === false && /no reader app is configured/.test(pol.reason), JSON.stringify(pol));
    ok('no reader: nothing spawned', never.calls.length === 0, JSON.stringify(never.calls));
    m.stop();
  }

  /* ---- a broken notes-pane.json is reported and never overwritten ------ */
  {
    const prof = freshDir('profile-c');
    fs.writeFileSync(path.join(prof, 'notes-pane.json'), '{ "dir": broken');
    const m = notesModule.create({ userDataDir: prof, spawn: noSpawn(), autoStart: false });
    const st = m.describe();
    ok('broken config: off, and the reason says the JSON is broken', st.configured === false && /not valid JSON/.test(st.reason), st.reason);
    const res = await m.command('set-dir', { dir: notesDir });
    ok('broken config: set-dir refuses to overwrite it', res.ok === false && fs.readFileSync(path.join(prof, 'notes-pane.json'), 'utf8') === '{ "dir": broken', JSON.stringify(res));
    m.stop();
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log('notes-pane-harness: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('notes-pane-harness crashed: ' + (e && e.stack || e)); console.log('notes-pane-harness: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
