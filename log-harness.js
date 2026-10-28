// log-harness.js -- quartz.log (log.js) without Electron: the rotating writer, the words, the
// start/quit verdict, the failed-load counting, the scrubber, the memory line, and install() wired
// to fake app / ipcMain / webContents objects. Writes only into a temp folder it deletes.
//
//   node log-harness.js
//
// One summary line: "log-test: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const L = require('./log');

let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-log-harness-'));
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
const lines = (f) => read(f).split('\n').filter(Boolean);
const STAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} /;

(async () => { try {
  /* ---- 1. the writer: stamps, rotation, keep 2 ------------------------------------------------ */
  {
    const file = path.join(DIR, 'rot.log');
    const w = L.makeRotatingFile(fs, file, { maxBytes: 1000, keep: 2, say: () => {} });
    check(w.lastLine() === null, 'no file yet: lastLine() is null');
    w.write('first line');
    check(STAMP.test(lines(file)[0]) && lines(file)[0].endsWith(' first line'), 'every line starts with the full local date and time', lines(file)[0]);
    w.write('two\nlines');
    check(lines(file).length === 3 && lines(file).every((l) => STAMP.test(l)), 'a multi-line text becomes stamped lines, never a bare one', lines(file));
    for (let i = 0; i < 40; i++) w.write('x'.repeat(60) + ' ' + i);
    check(fs.existsSync(file + '.1') && fs.existsSync(file + '.2'), 'rotated: .1 and .2 exist');
    check(!fs.existsSync(file + '.3'), 'keep 2: no .3');
    check(fs.statSync(file).size < 1000 + 200, 'the live file stays near the cap', fs.statSync(file).size);
    check(/The log file reached 0 MB: the previous 0\.0 MB is now rot\.log\.1 \(2 old files kept\)\./.test(read(file)), 'a rotation says so, in the new file', read(file).slice(0, 200));
    const all = [file, file + '.1', file + '.2'].map(read).join('');
    check(all.split('\n').filter(Boolean).every((l) => STAMP.test(l)), 'no line was split across files (every line in all three is whole)');
    check(/ x+ 39$/.test(lines(file).pop()), 'the newest line is in the live file');
  }

  /* ---- 2. a rotation that cannot rename keeps writing and says so ---------------------------- */
  {
    const file = path.join(DIR, 'held.log');
    const fsHeld = Object.assign({}, fs, { renameSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } });
    const w = L.makeRotatingFile(fsHeld, file, { maxBytes: 500, keep: 2, retryBytes: 400, say: () => {} });
    for (let i = 0; i < 12; i++) w.write('y'.repeat(60));
    const txt = read(file);
    check(/could NOT be rotated at 0\.\d MB \(held\.log -> \.1: EBUSY\); still writing to this file/.test(txt), 'a failed rotation is written into the file with its reason', txt.slice(-300));
    check(lines(file).filter((l) => /y{60}$/.test(l)).length === 12, 'no line lost while rotation is blocked');
  }

  /* ---- 3. an unwritable file: Quartz goes on, the line goes to the terminal ------------------- */
  {
    const said = [];
    const w = L.makeRotatingFile(fs, path.join(DIR, 'no-such-dir', 'x.log'), { say: (s) => said.push(s) });
    let threw = false;
    try { w.write('hello'); w.write('again'); } catch (e) { threw = true; }
    check(!threw, 'an unopenable log never throws');
    check(said.some((s) => /could not be opened/.test(s)) && said.some((s) => /quartz: again/.test(s)), 'it says why, and each line still reaches the terminal', said);
  }

  /* ---- 4. the words ---------------------------------------------------------------------------- */
  check(L.goneWords('crashed', -2147483645) === 'its process crashed (exit code 0x80000003, a deliberate break (chrome://crash style))', 'goneWords: crashed + a hex exit code', L.goneWords('crashed', -2147483645));
  check(L.goneWords('oom') === 'it ran out of memory', 'goneWords: oom');
  check(L.goneWords('killed', 1) === 'its process was ended from outside Quartz (Task Manager, another program, or Windows) (exit code 1)', 'goneWords: killed with a small exit code', L.goneWords('killed', 1));
  check(L.goneWords('weird-new-reason') === 'its process ended (weird-new-reason)', 'goneWords: an unknown reason is shown as-is');
  check(L.loadErrorWords(-105) === "the site's address could not be found", 'loadErrorWords: -105');
  check(L.loadErrorWords(-202, 'ERR_CERT_AUTHORITY_INVALID') === "the site's security certificate was not accepted", 'loadErrorWords: certificate range');
  check(L.loadErrorWords(-999, 'ERR_SOMETHING\nNEW') === 'Chromium error ERR_SOMETHING NEW (-999)', 'loadErrorWords: unknown code keeps its name, one line');
  check(L.placeOf('https://www.youtube.com/watch?v=secret') === 'youtube.com', 'placeOf: host only, never the path or query');
  check(L.placeOf('http://127.0.0.1:8080/a') === '127.0.0.1:8080', 'placeOf: a port is kept');
  check(L.placeOf('file:///C:/Users/you/quartz/newtab.html?theme=dark', 'C:\\Users\\you\\quartz') === "Quartz's newtab page", 'placeOf: Quartz\'s own page by name');
  check(L.placeOf('file:///C:/Users/you/Documents/tax.pdf', 'C:\\Users\\you\\quartz') === 'a local file', 'placeOf: a local file is never named');
  check(L.placeOf('chrome://crash') === 'chrome://crash', 'placeOf: chrome:// pages');
  check(L.placeOf('') === 'a page with no address yet' && L.placeOf('about:blank') === 'a blank page', 'placeOf: empty and blank');
  check(L.durationWords(18000) === '18 s' && L.durationWords(4 * 60000) === '4 min' && L.durationWords(125 * 60000) === '2 h 05 min', 'durationWords', [L.durationWords(18000), L.durationWords(240000), L.durationWords(7500000)]);
  const scrub = L.makeScrubber('C:\\Users\\you', 'you');
  check(scrub('could not read C:\\Users\\you\\AppData\\x and C:/Users/you/y') === 'could not read %USERPROFILE%\\AppData\\x and %USERPROFILE%/y', 'scrubber: the home folder in both slash styles', scrub('could not read C:\\Users\\you\\AppData\\x and C:/Users/you/y'));
  const mem = L.memoryWords([
    { pid: 1, type: 'Browser', memory: { privateBytes: 120 * 1024 } },
    { pid: 2, type: 'Tab', memory: { privateBytes: 200 * 1024 } },
    { pid: 3, type: 'Tab', memory: { privateBytes: 300 * 1024 } },
    { pid: 4, type: 'Tab', memory: { privateBytes: 100 * 1024 } },
    { pid: 5, type: 'GPU', memory: { privateBytes: 80 * 1024 } },
    { pid: 6, type: 'Utility', memory: { workingSetSize: 40 * 1024 } },
  ], { windowPid: 2, tabsAwake: 2, upMs: 150 * 60000 });
  check(mem === 'Memory: 840 MB in use across 6 processes (Quartz itself 120 MB, the window 200 MB, 2 tab processes 400 MB, GPU 80 MB, other helpers 40 MB). 2 tabs awake. Running for 2 h 30 min.', 'memoryWords: the line', mem);

  /* ---- 5. the event log: start / quit verdicts, events, counts ---------------------------------- */
  {
    const file = path.join(DIR, 'q.log');
    let t = 1000000;
    const mk = () => L.createQuartzLog({ file, clock: () => t, appDir: 'C:\\app', home: 'C:\\Users\\you', user: 'you', say: () => {} });
    const a = mk();
    a.start({ version: '0.1.0', electron: '44.3.0', chrome: '140', os: '10.0.26300', pid: 42 });
    check(/ Quartz 0\.1\.0 started \(Electron 44\.3\.0, Chromium 140, Windows 10\.0\.26300, process 42\)\. This is the first run with a log file\.$/.test(lines(file)[0]), 'first start: says it is the first run', lines(file)[0]);
    a.tabCrashed({ url: 'https://news.example.com/a?b', reason: 'crashed', exitCode: -2147483645 });
    check(/ A tab on news\.example\.com crashed: its process crashed \(exit code 0x80000003, a deliberate break \(chrome:\/\/crash style\)\)\. Its "This page crashed" card is showing\.$/.test(lines(file).pop()), 'tab crash: one plain line', lines(file).pop());
    a.unresponsive('g:1', 'https://slow.example.com/', false);
    a.unresponsive('g:1', 'https://slow.example.com/', false);
    check(lines(file).filter((l) => /stopped responding/.test(l)).length === 1, 'a hang is ONE line, however often unresponsive fires');
    check(/ A tab on slow\.example\.com stopped responding \(its page is busy or stuck\)\.$/.test(lines(file).pop()), 'hang: the words', lines(file).pop());
    t += 18000;
    a.responsive('g:1');
    check(/ The tab on slow\.example\.com is responding again after 18 s\.$/.test(lines(file).pop()), 'recovery: says how long', lines(file).pop());
    a.responsive('g:1');
    check(!/responding again/.test(lines(file).slice(-1)[0]) || lines(file).filter((l) => /responding again/.test(l)).length === 1, 'a second responsive with no hang writes nothing');
    a.windowCrashed({ reason: 'oom' });
    check(/ The Quartz window crashed \(tabs, address bar and all\): it ran out of memory\./.test(lines(file).pop()), 'window crash: the words', lines(file).pop());
    a.childGone({ type: 'GPU', reason: 'crashed', exitCode: 5 });
    check(/ Chromium's GPU process stopped: it crashed \(exit code 5\)\. Chromium starts a new one when it is needed\.$/.test(lines(file).pop()), 'GPU process gone: the words', lines(file).pop());
    const before = lines(file).length;
    a.childGone({ type: 'Utility', name: 'Network Service', reason: 'clean-exit' });
    check(lines(file).length === before, 'a helper that exited cleanly is not news');
    a.childGone({ type: 'Utility', name: 'Network Service', reason: 'killed' });
    check(/ Chromium's Network Service helper process stopped: it was ended from outside Quartz/.test(lines(file).pop()), 'a named utility process', lines(file).pop());
    a.adblock({ ok: true, ms: 341.6, fromCache: true, enabled: true });
    check(/ The ad blocker is ready in 342 ms, from its saved filter lists; blocking is on\.$/.test(lines(file).pop()), 'adblock ready', lines(file).pop());
    a.adblock({ ok: false, reason: 'fetch failed' });
    check(/ The ad blocker could not load \(fetch failed\); pages load with no blocking until Quartz starts again\.$/.test(lines(file).pop()), 'adblock failed: says why and what it means', lines(file).pop());
    a.tabSlept({ url: 'https://docs.example.com/x', why: 'idle' });
    check(/ A tab on docs\.example\.com went to sleep after it went unused, to free its memory\.$/.test(lines(file).pop()), 'tab sleep', lines(file).pop());
    a.tabWoke({ url: 'https://docs.example.com/x', sleptMs: 2 * 3600000 + 10 * 60000 });
    check(/ A sleeping tab on docs\.example\.com woke up after sleeping 2 h 10 min\.$/.test(lines(file).pop()), 'tab wake', lines(file).pop());
    // Failed loads: one line each up to the cap, then counted; the check sums them.
    for (let i = 0; i < 33; i++) a.loadFailed({ url: 'https://down.example.com/' + i, errorCode: i % 3 ? -106 : -105 });
    check(lines(file).filter((l) => / A page failed to load: down\.example\.com: /.test(l)).length === 30, 'failed loads: 30 lines per check window, then only counted');
    a.check([{ pid: 1, type: 'Browser', memory: { privateBytes: 102400 } }], { tabsAwake: 0 });
    const sum = lines(file).pop();
    check(/ Since the last check, 33 pages failed to load: 22 x there is no internet connection; 11 x the site's address could not be found\. \(3 of them had no line of their own\.\)$/.test(sum), 'the check counts failed loads by cause', sum);
    check(/ Memory: 100 MB in use across 1 process /.test(lines(file).slice(-2)[0]), 'the check writes the memory line first', lines(file).slice(-2)[0]);
    a.check([], {});
    check(!/failed to load/.test(lines(file).pop()), 'a check with no failures since the last one writes no failure line');
    a.warning({ name: 'MaxListenersExceededWarning', message: 'Possible EventEmitter memory leak detected.\n11 did-stop-loading listeners' });
    check(/ Node\.js warned \(not a crash\): MaxListenersExceededWarning: Possible EventEmitter memory leak detected\. 11 did-stop-loading listeners$/.test(lines(file).pop()), 'a Node warning: one line', lines(file).pop());
    const nW = lines(file).length;
    a.warning({ name: 'electron', message: 'Failed to load URL: http://x.example/ with error: ERR_UNSAFE_PORT' });
    check(lines(file).length === nW, "Electron's per-loadURL warning is not a second line for one failed load");
    check(L.loadErrorWords(-312) === 'Chromium refuses that port for safety', 'loadErrorWords: -312 unsafe port');
    const e = new Error('boom at C:\\Users\\you\\secret');
    a.uncaught(e, 'uncaughtException');
    check(/ Quartz's main process hit an error nothing handled: boom at %USERPROFILE%\\secret/.test(lines(file).pop()), 'an uncaught error, scrubbed', lines(file).pop());
    t += 125 * 60000;
    a.quit('quit');
    a.quit('quit');
    a.tabCrashed({ url: 'https://after.example.com', reason: 'crashed' });
    const q = lines(file).filter((l) => / Quartz quit /.test(l));
    check(q.length === 1, 'the quit line is written once', q.length);
    check(/ Quartz quit after 2 h 05 min\. This run: 1 tab crash, 1 window crash, 2 helper process stops, 1 hang, 33 failed page loads, 1 tab put to sleep, 1 unhandled error\.$/.test(q[0]), 'the quit line sums the run', q[0]);
    check(!/after\.example\.com/.test(read(file)), 'nothing is written after the quit line');

    const b = mk();
    b.start({ version: '0.1.0' });
    check(/ The last run quit normally \(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\)\.$/.test(lines(file).pop()), 'next start: the last run quit normally', lines(file).pop());
    b.line('then the power went out');
    const c = mk();
    c.start({ version: '0.1.0', profile: 'logtest' });
    check(/ test profile "logtest"\)\. The last run did NOT quit normally: its last line was written at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \(Quartz crashed, was ended from outside, or the PC lost power or restarted\)\.$/.test(lines(file).pop()), 'a start after an unclean end says so', lines(file).pop());
    c.quit('session-end');
    check(/ Windows is signing out or shutting down: Quartz quit with it after /.test(lines(file).pop()), 'session end: its own quit line', lines(file).pop());
    const d2 = mk();
    d2.start({});
    check(/The last run quit normally/.test(lines(file).pop()), 'a session-end quit counts as a clean quit next start');
  }

  /* ---- 6. install(): the Electron wiring, with fakes ------------------------------------------- */
  {
    const ud = path.join(DIR, 'userData');
    fs.mkdirSync(ud);
    const app = new EventEmitter();
    app.getPath = () => ud;
    app.getVersion = () => '9.9.9';
    app.getAppMetrics = () => [{ pid: 1, type: 'Browser', memory: { privateBytes: 51200 } }, { pid: 7, type: 'Tab', memory: { privateBytes: 102400 } }];
    const ipc = new EventEmitter();
    const chrome = { id: 'chrome' };
    const guests = [];
    const webContents = { getAllWebContents: () => guests };
    const power = new EventEmitter();
    const warnBefore = process.listenerCount('warning');
    const h = L.install({ app, ipcMain: ipc, isChromeSender: (ev) => ev && ev.sender === chrome, webContents, powerMonitor: power, appDir: __dirname, profile: 'fake', memoryEveryMs: 60000 });
    const file = path.join(ud, 'quartz.log');
    check(/ Quartz 9\.9\.9 started \(.*test profile "fake"\)\. This is the first run with a log file\.$/.test(lines(file)[0]), 'install: start line in <userData>/quartz.log', lines(file)[0]);
    check(process.listenerCount('warning') === warnBefore + 1, 'install: observes Node warnings');
    ipc.emit('log:event', { sender: chrome }, { kind: 'tab-crashed', url: 'https://a.example.org/p', reason: 'crashed', exitCode: -1073741819 });
    check(/ A tab on a\.example\.org crashed: its process crashed \(exit code 0xC0000005, an access violation\)\./.test(lines(file).pop()), 'IPC tab-crashed from the chrome: one line', lines(file).pop());
    const n0 = lines(file).length;
    ipc.emit('log:event', { sender: { id: 'a page' } }, { kind: 'tab-crashed', url: 'https://evil.example/', reason: 'crashed' });
    ipc.emit('log:event', { sender: chrome }, { kind: 'made-up', url: 'x' });
    ipc.emit('log:event', { sender: chrome }, null);
    check(lines(file).length === n0, 'IPC from anything but the chrome, an unknown kind, or junk writes nothing');
    ipc.emit('log:event', { sender: chrome }, { kind: 'tab-slept', url: 'https://b.example.org/', why: 'workspace' });
    check(/ A tab on b\.example\.org went to sleep with its workspace, to free its memory\.$/.test(lines(file).pop()), 'IPC tab-slept', lines(file).pop());
    // Early sleeps (app.js earlySleepPlan) carry their reason in plain words.
    ipc.emit('log:event', { sender: chrome }, { kind: 'tab-slept', url: 'https://b.example.org/', why: 'memory', note: 'memory was low (1.6 GB of 12.0 GB free)', sound: 'was not making sound' });
    check(/ went to sleep early, because memory was low \(1\.6 GB of 12\.0 GB free\), to free its memory \(was not making sound\)\.$/.test(lines(file).pop()), 'IPC tab-slept early: memory', lines(file).pop());
    ipc.emit('log:event', { sender: chrome }, { kind: 'tab-sleep-skipped', url: 'https://b.example.org/', reason: 'could not check it for unsaved work (the page did not answer within 1.5 s)' });
    check(/ was kept awake: could not check it for unsaved work \(the page did not answer within 1\.5 s\)\.$/.test(lines(file).pop()), 'IPC kept awake: a long reason is not cut', lines(file).pop());
    ipc.emit('log:event', { sender: chrome }, { kind: 'tab-woke', url: 'https://b.example.org/', sleptMs: null });
    check(/ A sleeping tab on b\.example\.org woke up\.$/.test(lines(file).pop()), 'IPC tab-woke without a known sleep time', lines(file).pop());
    // ui-error: the chrome showed plain words; the raw text lands here, one line, known places only.
    ipc.emit('log:event', { sender: chrome }, { kind: 'ui-error', where: 'theme', detail: 'TypeError: x is not a function\n    at setMode (app.js:1:2)' });
    check(/ Settings could not change the theme\. The error was: TypeError: x is not a function at setMode \(app\.js:1:2\)$/.test(lines(file).pop()), 'IPC ui-error: plain lead, then the raw error on one line', lines(file).pop());
    ipc.emit('log:event', { sender: chrome }, { kind: 'ui-error', where: 'mantle-wallpapers', detail: '' });
    check(/ Settings could not open Mantle's Wallpapers\. The error was: no error text was given$/.test(lines(file).pop()), 'IPC ui-error with no text says so', lines(file).pop());
    const nUi = lines(file).length;
    ipc.emit('log:event', { sender: chrome }, { kind: 'ui-error', where: 'constructor', detail: 'x' });
    ipc.emit('log:event', { sender: chrome }, { kind: 'ui-error', where: 'made-up', detail: 'x' });
    ipc.emit('log:event', { sender: { id: 'a page' } }, { kind: 'ui-error', where: 'theme', detail: 'from a page' });
    check(lines(file).length === nUi, 'ui-error from an unknown place (even "constructor") or from a page writes nothing');
    for (let i = 0; i < 25; i++) ipc.emit('log:event', { sender: chrome }, { kind: 'ui-error', where: 'background-image', detail: 'EncodingError ' + i });
    const uiLines = lines(file).filter((l) => / Settings could not /.test(l));
    check(uiLines.length === 20 && / Settings could not use the picked picture as the background\. The error was: EncodingError 17 \(Further errors like this one this run are not written\.\)$/.test(uiLines[19]),
      'ui-error: 20 lines a run at most, the last one says so', uiLines.length + ' | ' + uiLines[19]);
    // A guest: hang, recovery, failed loads (main frame only, not aborted).
    const g = new EventEmitter();
    g.id = 5; g.getURL = () => 'https://hang.example.net/x'; g.isDestroyed = () => false; g.getType = () => 'webview';
    guests.push(g);
    h.watchGuest(g);
    g.emit('unresponsive');
    check(/ A tab on hang\.example\.net stopped responding/.test(lines(file).pop()), 'guest unresponsive -> one line', lines(file).pop());
    g.emit('responsive');
    check(!/responding again/.test(lines(file).pop()), 'guest responsive: no line until it has settled (a close fires it too)');
    await new Promise((r) => setTimeout(r, 1150));
    check(/ The tab on hang\.example\.net is responding again after \d+ s\.$/.test(lines(file).pop()), 'guest responsive -> recovery line, a second later', lines(file).pop());
    // A hung tab that is CLOSED: Chromium fires 'responsive', then the guest is destroyed. No line.
    const gc = new EventEmitter();
    let gcDead = false;
    gc.id = 6; gc.getURL = () => 'https://closed.example.net/'; gc.isDestroyed = () => gcDead; gc.getType = () => 'webview';
    h.watchGuest(gc);
    gc.emit('unresponsive');
    gc.emit('responsive');
    gcDead = true; gc.emit('destroyed');
    await new Promise((r) => setTimeout(r, 1150));
    check(lines(file).filter((l) => /closed\.example\.net is responding again/.test(l)).length === 0, 'closing a hung tab is not written as a recovery');
    const n1 = lines(file).length;
    g.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://hang.example.net/y', true);
    g.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://img.example.net/a.png', false);
    check(lines(file).length === n1, 'aborted loads and sub-frame failures are not page failures');
    g.emit('did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', 'https://hang.example.net/z', true);
    check(/ A page failed to load: hang\.example\.net: there is no internet connection\.$/.test(lines(file).pop()), 'guest main-frame failure -> line', lines(file).pop());
    // The window.
    const wc = new EventEmitter(); wc.id = 1; wc.isDestroyed = () => false; wc.getOSProcessId = () => 7;
    h.watchWindow({ webContents: wc });
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 3 });
    check(/ The Quartz window crashed \(tabs, address bar and all\): its process crashed \(exit code 3\)\./.test(lines(file).pop()), 'window render-process-gone -> line', lines(file).pop());
    wc.emit('unresponsive');
    check(/ The Quartz window stopped responding/.test(lines(file).pop()), 'window unresponsive -> line', lines(file).pop());
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
    check(/ Chromium's GPU process stopped/.test(lines(file).pop()), 'app child-process-gone -> line');
    power.emit('suspend'); power.emit('resume');
    check(/ The PC went to sleep\.$/.test(lines(file).slice(-2)[0]) && / The PC woke up\.$/.test(lines(file).pop()), 'PC sleep and wake lines');
    h.check();
    check(/ Memory: 150 MB in use across 2 processes \(Quartz itself 50 MB, the window 100 MB, 0 tab processes 0 MB, GPU 0 MB, other helpers 0 MB\)\. 1 tab awake\. Running for \d+ s\.$/.test(lines(file).slice(-2)[0]), 'check(): memory line from getAppMetrics, the window by pid', lines(file).slice(-2)[0]);
    h.adblock({ ok: true, ms: 12, fromCache: false, enabled: false });
    check(/ freshly downloaded filter lists; blocking is OFF \(turned off in Settings\)\.$/.test(lines(file).pop()), 'adblock via the hook', lines(file).pop());
    app.emit('quit');
    // (two tab-slept events above: the workspace one and the early "memory" one)
    check(/ Quartz quit after \d+ s\. This run: 1 tab crash, 1 window crash, 1 helper process stop, 3 hangs, 1 failed page load, 2 tabs put to sleep, 0 unhandled errors\.$/.test(lines(file).pop()), 'app quit -> the quit line', lines(file).pop());
    check(read(file).split('\n').filter(Boolean).every((l) => STAMP.test(l) && !/[\x00-\x08]/.test(l)), 'every line of the installed log is one stamped line');
  }
} catch (e) {
  check(false, 'HARNESS ERROR ' + (e && e.stack || e));
} finally {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* temp */ }
  console.log(`log-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} })();
