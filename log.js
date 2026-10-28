'use strict';
/*
 * log.js -- Quartz's own log file: <userData>\quartz.log (%APPDATA%\Quartz\quartz.log
 * for the user; a test profile writes into its own temp folder).
 *
 * Before this, Quartz wrote no file at all: a tab crash showed a card and was
 * gone, a hang left nothing behind, and nobody could say how often either
 * happened. Every line here is one event, in plain words, so the file can be
 * read by a person AND counted by a grep:
 *
 *   Quartz 0.1.0 started ...                 / Quartz quit after 2 h 05 min ...
 *   A tab on example.com crashed: ...         (forwarded by the chrome, app.js)
 *   The Quartz window crashed: ...            (the chrome's own renderer)
 *   Chromium's GPU process stopped: ...       (child-process-gone)
 *   A tab on example.com stopped responding.  / ... is responding again after 18 s.
 *   A page failed to load: example.com: ...   (main frame only; also counted)
 *   The ad blocker is ready in 340 ms ...
 *   A tab on example.com went to sleep ...    / ... woke up after sleeping 2 h 10 min.
 *   Memory: 1,034 MB in use across 8 processes ...   (every 30 min)
 *
 * Every line starts with the full local date and time, so a grep of one line
 * still says when. Hosts only, never full addresses; the home folder and user
 * name in any message become %USERPROFILE% / <user>.
 *
 * The file is the same shape as Mantle's: at 5 MB it becomes quartz.log.1 (the
 * old .1 becomes .2, the old .2 goes), always between two whole lines. A
 * rotation that fails (a reader holding the file) keeps writing where it was,
 * says so IN the file, and tries again 1 MB later. A file that cannot be
 * written at all never takes Quartz down: the line goes to the terminal only.
 *
 * Pure parts (the writer, the words) are exported for log-harness.js; install()
 * is the Electron wiring main.js calls once, in whenReady.
 */
const path = require('path');

const MB = 1024 * 1024;
const LOG_NAME = 'quartz.log';
const MEMORY_EVERY_MS = 30 * 60 * 1000;
/** Per-failure lines per check window; past this they are only counted. */
const FAIL_LINES_PER_WINDOW = 30;
/** Node warnings per run (a warning that repeats is a counting job, not a log flood). */
const WARNING_LINES_PER_RUN = 20;
// The chrome's own failures (log:event kind 'ui-error'): the plain-words message is on screen,
// the raw error text comes here. Only these places may write one.
const UI_ERROR_WORDS = {
  theme: 'Settings could not change the theme',
  'mantle-wallpapers': 'Settings could not open Mantle\'s Wallpapers',
  'background-image': 'Settings could not use the picked picture as the background',
};
const UI_ERROR_LINES_PER_RUN = 20;
/** How long a guest's 'responsive' waits to see whether it was really a close (log.js watchGuest). */
const RESPONSIVE_SETTLE_MS = 1000;

/* ---- the writer ------------------------------------------------------------------------------ */

const two = (n) => String(n).padStart(2, '0');

/** "2026-10-14 17:40:02.123" in local time. */
function stampOf(d) {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} `
    + `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * One file that rotates. Writes are whole lines and synchronous: a log line is
 * rare (a handful a minute at worst), and a sync write is the only kind that
 * still lands when the next thing that happens is the process dying.
 */
function makeRotatingFile(fs, file, opts) {
  const o = Object.assign({
    maxBytes: 5 * MB, keep: 2, retryBytes: MB, reopenMs: 5000,
    now: () => new Date(), clock: () => Date.now(), say: (s) => { try { process.stderr.write(s); } catch (_) { /* none */ } },
  }, opts || {});
  let fd = null;
  let size = 0;
  let rotateAt = o.maxBytes;
  let lost = null; // { since, tried, writes, reason } while the file could not be opened
  let opened = false;

  function open() {
    fd = fs.openSync(file, 'a');
    size = fs.fstatSync(fd).size;
  }
  function raw(text) {
    const buf = Buffer.from(text, 'utf8');
    fs.writeSync(fd, buf);
    size += buf.length;
  }
  function stamped(text) {
    return String(text).split(/\r?\n/).filter((l) => l.length).map((l) => `${stampOf(o.now())} ${l}\n`).join('');
  }
  function rotate(why) {
    const was = size;
    try { fs.closeSync(fd); } catch (_) { /* reopened below either way */ }
    fd = null;
    let failed = null;
    for (let k = o.keep; k >= 1 && !failed; k--) {
      const from = k === 1 ? file : `${file}.${k - 1}`;
      try { if (fs.existsSync(from)) fs.renameSync(from, `${file}.${k}`); } catch (err) { failed = `${path.basename(from)} -> .${k}: ${(err && err.code) || (err && err.message)}`; }
    }
    try { open(); } catch (err) {
      fd = null;
      lost = { since: o.clock(), tried: o.clock(), writes: 0, reason: (err && err.code) || String(err && err.message) };
      o.say(`quartz: the log file could not be reopened after rotating it (${err && err.message}); logging to the terminal only, trying again every ${o.reopenMs / 1000} s\n`);
      return;
    }
    rotateAt = failed ? size + o.retryBytes : o.maxBytes;
    raw(stamped(failed
      ? `The log file could NOT be rotated at ${(was / MB).toFixed(1)} MB (${failed}); still writing to this file, next try at ${(rotateAt / MB).toFixed(1)} MB.`
      : `The log file ${why}: the previous ${(was / MB).toFixed(1)} MB is now ${path.basename(file)}.1 (${o.keep} old files kept).`));
  }
  function ensureOpen() {
    if (fd !== null) return true;
    if (!opened) {
      opened = true;
      try { open(); } catch (err) {
        lost = { since: o.clock(), tried: o.clock(), writes: 0, reason: (err && err.code) || String(err && err.message) };
        o.say(`quartz: the log file ${file} could not be opened (${err && err.message}); logging to the terminal only\n`);
        return false;
      }
      if (size >= o.maxBytes) rotate('was full at start');
      return fd !== null;
    }
    if (!lost) return false;
    const t = o.clock();
    if (t - lost.tried < o.reopenMs) { lost.writes++; return false; }
    lost.tried = t;
    try { open(); } catch (_) { fd = null; lost.writes++; return false; }
    const gone = lost;
    lost = null;
    raw(stamped(`The log file could not be opened for ${((t - gone.since) / 1000).toFixed(0)} s (${gone.reason}); ${gone.writes} lines were lost.`));
    return true;
  }
  return {
    /** One event: stamped, written, rotated after if the file is full. */
    write(text) {
      if (!ensureOpen()) { o.say(`quartz: ${text}\n`); return false; }
      try { raw(stamped(text)); } catch (err) { o.say(`quartz: log write failed (${err && err.message}): ${text}\n`); return false; }
      if (size >= rotateAt) rotate(`reached ${(o.maxBytes / MB).toFixed(0)} MB`);
      return true;
    },
    /** The last line already in the file, read before this run writes anything. */
    lastLine() {
      let rfd = null;
      try {
        rfd = fs.openSync(file, 'r');
        const total = fs.fstatSync(rfd).size;
        if (!total) return '';
        const len = Math.min(total, 8192);
        const buf = Buffer.alloc(len);
        fs.readSync(rfd, buf, 0, len, total - len);
        const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
        return lines.length ? lines[lines.length - 1] : '';
      } catch (_) {
        return null; // no file yet
      } finally {
        if (rfd !== null) { try { fs.closeSync(rfd); } catch (_) { /* read-only handle */ } }
      }
    },
    get size() { return size; },
    get file() { return file; },
  };
}

/* ---- the words ------------------------------------------------------------------------------- */

/** Why a process went away, as a sentence fragment ("its process crashed"). */
const GONE_WORDS = {
  'clean-exit': 'its process exited normally',
  'abnormal-exit': 'its process exited with an error',
  killed: 'its process was ended from outside Quartz (Task Manager, another program, or Windows)',
  crashed: 'its process crashed',
  oom: 'it ran out of memory',
  'launch-failed': 'its process could not start',
  'integrity-failure': 'Windows blocked its code (a code integrity check failed)',
  'memory-eviction': 'Chromium closed it to free memory',
};

function exitCodeWords(code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n === 0) return '';
  // Windows crash codes are NTSTATUS values (0xC0000005 = access violation); hex is how they are looked up.
  const hex = n < 0 || n > 0xffff ? '0x' + (n >>> 0).toString(16).toUpperCase() : String(n);
  const known = { '0xC0000005': ', an access violation', '0xC0000409': ', a stack buffer overrun', '0xE0000008': ', out of memory', '0x80000003': ', a deliberate break (chrome://crash style)' }[hex] || '';
  return ` (exit code ${hex}${known})`;
}

function goneWords(reason, exitCode) {
  const r = String(reason || '');
  return (GONE_WORDS[r] || (r ? `its process ended (${r})` : 'its process ended')) + exitCodeWords(exitCode);
}

/** Chromium net error -> what happened, in words. Keys are the codes. */
const LOAD_ERROR_WORDS = {
  '-2': 'it failed for an unknown reason',
  '-6': 'the file was not found',
  '-7': 'it took too long',
  '-10': 'access was denied',
  '-20': 'the ad blocker blocked it',
  '-21': 'the network changed while it loaded',
  '-27': 'the page blocked itself from loading here',
  '-100': 'the connection was closed',
  '-101': 'the connection was reset',
  '-102': 'the site refused the connection',
  '-104': 'the connection failed',
  '-105': "the site's address could not be found",
  '-106': 'there is no internet connection',
  '-109': 'the site cannot be reached',
  '-118': 'the site took too long to answer',
  '-130': 'the proxy failed',
  '-137': 'the address lookup failed',
  '-300': 'the address is not valid',
  '-301': 'the address uses a scheme Quartz cannot open',
  '-310': 'the site redirected too many times',
  '-312': 'Chromium refuses that port for safety',
  '-324': 'the site sent nothing back',
  '-501': 'the site answered insecurely',
};

function loadErrorWords(code, description) {
  const n = Number(code);
  if (LOAD_ERROR_WORDS[String(n)]) return LOAD_ERROR_WORDS[String(n)];
  if (n <= -200 && n > -300) return "the site's security certificate was not accepted";
  const d = String(description || '').replace(/[\r\n]+/g, ' ').slice(0, 80);
  return `Chromium error ${d || 'unknown'} (${Number.isFinite(n) ? n : '?'})`;
}

/** Where a page is, without the rest of its address. appDir marks Quartz's own pages. */
function placeOf(url, appDir) {
  const u = String(url || '');
  if (!u) return 'a page with no address yet';
  if (/^about:blank/i.test(u)) return 'a blank page';
  if (/^data:/i.test(u)) return 'a data: page';
  if (/^file:/i.test(u)) {
    let p = u;
    try { p = decodeURIComponent(new URL(u).pathname).replace(/^\/([A-Za-z]:)/, '$1'); } catch (_) { /* keep it */ }
    const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();
    if (appDir && norm(p).startsWith(norm(appDir) + '/')) return `Quartz's ${path.basename(p).replace(/\.html$/i, '')} page`;
    return 'a local file';
  }
  try {
    const x = new URL(u);
    if (x.protocol === 'http:' || x.protocol === 'https:') return x.hostname.replace(/^www\./i, '') + (x.port ? ':' + x.port : '');
    if (x.protocol === 'chrome:' || x.protocol === 'devtools:') return `${x.protocol}//${x.hostname}`;
    return `a ${x.protocol} page`;
  } catch (_) {
    return 'a page with an unreadable address';
  }
}

/** "2 h 05 min", "4 min", "18 s". */
function durationWords(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${two(m % 60)} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const mbWords = (kb) => `${Math.round(Number(kb) / 1024).toLocaleString('en-US')} MB`;

/** One line, no newlines, capped: anything that came from outside goes through this. */
function oneLine(s, max) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').slice(0, max || 300);
}

/** Home folder -> %USERPROFILE%, user name inside a path -> <user>. */
function makeScrubber(home, user) {
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = [];
  const h = typeof home === 'string' && home.length > 3 ? home.replace(/[\\/]+$/, '') : '';
  if (h) rules.push([new RegExp(h.split(/[\\/]+/).map(esc).join('(?:\\\\\\\\|\\\\|/)'), 'gi'), '%USERPROFILE%']);
  if (typeof user === 'string' && user.length >= 2) rules.push([new RegExp(`([\\\\/])${esc(user)}(?=[\\\\/"'\\s:;,)]|$)`, 'gi'), '$1<user>']);
  return (text) => rules.reduce((s, [re, to]) => s.replace(re, to), String(text));
}

/**
 * The memory line, from app.getAppMetrics(). privateBytes (Windows) is what
 * Task Manager's "Memory" column shows; workingSetSize is the fallback.
 */
function memoryWords(metrics, { windowPid, tabsAwake, upMs } = {}) {
  const kbOf = (m) => (m && m.memory && (m.memory.privateBytes || m.memory.workingSetSize)) || 0;
  const groups = { main: 0, window: 0, tabs: 0, gpu: 0, other: 0 };
  let tabProcs = 0;
  let total = 0;
  for (const m of metrics || []) {
    const kb = kbOf(m);
    total += kb;
    if (m.type === 'Browser') groups.main += kb;
    else if (m.type === 'GPU') groups.gpu += kb;
    else if (m.type === 'Tab' && windowPid && m.pid === windowPid) groups.window += kb;
    else if (m.type === 'Tab') { groups.tabs += kb; tabProcs++; }
    else groups.other += kb;
  }
  const parts = [`Quartz itself ${mbWords(groups.main)}`, `the window ${mbWords(groups.window)}`,
    `${plural(tabProcs, 'tab process', 'tab processes')} ${mbWords(groups.tabs)}`, `GPU ${mbWords(groups.gpu)}`, `other helpers ${mbWords(groups.other)}`];
  const awake = Number.isFinite(tabsAwake) ? ` ${plural(tabsAwake, 'tab', 'tabs')} awake.` : '';
  const up = Number.isFinite(upMs) ? ` Running for ${durationWords(upMs)}.` : '';
  return `Memory: ${mbWords(total)} in use across ${plural((metrics || []).length, 'process', 'processes')} (${parts.join(', ')}).${awake}${up}`;
}

/* ---- the event log --------------------------------------------------------------------------- */

/**
 * Everything that turns an event into a line, and the counts the quit line and
 * the 30-min check report. No Electron in here: log-harness.js drives it with a
 * fake clock and a temp folder.
 */
function createQuartzLog(opts) {
  const o = Object.assign({ fs: require('fs'), now: () => new Date(), clock: () => Date.now(), appDir: '', home: '', user: '' }, opts || {});
  const writer = makeRotatingFile(o.fs, o.file, { maxBytes: o.maxBytes, keep: o.keep, now: o.now, clock: o.clock, say: o.say });
  const scrub = makeScrubber(o.home, o.user);
  const startedAt = o.clock();
  const run = { tabCrashes: 0, windowCrashes: 0, childGone: 0, hangs: 0, failedLoads: 0, slept: 0, woke: 0, warnings: 0, errors: 0, uiErrors: 0 };
  let windowFails = new Map(); // words -> count since the last check
  let windowFailLines = 0;
  let windowFailExtra = 0;
  const hangs = new Map();     // key -> { since, place }
  let quitWritten = false;

  // Nothing after the quit line: the next start reads the last line to tell a
  // clean quit from a crash, and a helper stopping during teardown is not news.
  const line = (text) => (quitWritten ? false : writer.write(scrub(text)));
  const place = (url) => placeOf(url, o.appDir);

  return {
    line,
    run,
    writer,
    place,

    /** First line of a run; says how the LAST run ended. */
    start(info) {
      const i = info || {};
      const prev = writer.lastLine();
      let last;
      if (prev === null || prev === '') last = 'This is the first run with a log file.';
      else if (/ Quartz quit /.test(prev) || / Quartz quit$/.test(prev)) last = `The last run quit normally (${prev.slice(0, 19)}).`;
      else last = `The last run did NOT quit normally: its last line was written at ${prev.slice(0, 19)} (Quartz crashed, was ended from outside, or the PC lost power or restarted).`;
      const bits = [`Electron ${i.electron || '?'}`, `Chromium ${i.chrome || '?'}`, `Windows ${i.os || '?'}`, `process ${i.pid || '?'}`];
      if (i.profile) bits.push(`test profile "${oneLine(i.profile, 60)}"`);
      line(`Quartz ${i.version || '?'} started (${bits.join(', ')}). ${last}`);
    },

    /** The last line of a run. Written once, however many quit paths fire. */
    quit(why) {
      if (quitWritten) return;
      const r = run;
      const lead = why === 'session-end' ? 'Windows is signing out or shutting down: Quartz quit with it' : 'Quartz quit';
      line(`${lead} after ${durationWords(o.clock() - startedAt)}. This run: ${plural(r.tabCrashes, 'tab crash', 'tab crashes')}, `
        + `${plural(r.windowCrashes, 'window crash', 'window crashes')}, ${plural(r.childGone, 'helper process stop', 'helper process stops')}, `
        + `${plural(r.hangs, 'hang')}, ${plural(r.failedLoads, 'failed page load')}, ${plural(r.slept, 'tab put to sleep', 'tabs put to sleep')}, `
        + `${plural(r.errors, 'unhandled error')}.`);
      quitWritten = true;
    },

    tabCrashed({ url, reason, exitCode }) {
      run.tabCrashes++;
      line(`A tab on ${place(url)} crashed: ${goneWords(reason, exitCode)}. Its "This page crashed" card is showing.`);
    },

    windowCrashed({ reason, exitCode }) {
      run.windowCrashes++;
      line(`The Quartz window crashed (tabs, address bar and all): ${goneWords(reason, exitCode)}. Apps embedded in tabs were handed back to the desktop.`);
    },

    childGone({ type, name, serviceName, reason, exitCode }) {
      if (reason === 'clean-exit') return;
      run.childGone++;
      const what = oneLine(name || serviceName || type || 'helper', 80);
      const kind = type === 'GPU' ? "Chromium's GPU process" : `Chromium's ${what} helper process`;
      line(`${kind} stopped: ${goneWords(reason, exitCode).replace(/^its process /, 'it ')}. Chromium starts a new one when it is needed.`);
    },

    unresponsive(key, url, isWindow) {
      if (hangs.has(key)) return;
      run.hangs++;
      const where = isWindow ? 'The Quartz window' : `A tab on ${place(url)}`;
      hangs.set(key, { since: o.clock(), where: isWindow ? 'The Quartz window' : `The tab on ${place(url)}` });
      line(`${where} stopped responding (its page is busy or stuck).`);
    },

    responsive(key, at) {
      const h = hangs.get(key);
      if (!h) return;
      hangs.delete(key);
      line(`${h.where} is responding again after ${durationWords((Number.isFinite(at) ? at : o.clock()) - h.since)}.`);
    },

    /** A hung page that went away (closed, crashed) never comes back: forget it quietly. */
    forget(key) { hangs.delete(key); },

    loadFailed({ url, errorCode, errorDescription }) {
      run.failedLoads++;
      const words = loadErrorWords(errorCode, errorDescription);
      windowFails.set(words, (windowFails.get(words) || 0) + 1);
      if (windowFailLines < FAIL_LINES_PER_WINDOW) {
        windowFailLines++;
        line(`A page failed to load: ${place(url)}: ${words}.`);
      } else windowFailExtra++;
    },

    adblock({ ok, ms, fromCache, enabled, reason }) {
      if (!ok) {
        line(`The ad blocker could not load (${oneLine(reason, 160) || 'no reason given'}); pages load with no blocking until Quartz starts again.`);
        return;
      }
      line(`The ad blocker is ready in ${Math.round(ms)} ms, ${fromCache ? 'from its saved filter lists' : 'with freshly downloaded filter lists'}; blocking is ${enabled ? 'on' : 'OFF (turned off in Settings)'}.`);
    },

    tabSlept({ url, why, sound, note }) {
      run.slept++;
      // memory / heavy: sooner than the user's timer (app.js earlySleepPlan); note says why in figures.
      const cause = {
        idle: 'after it went unused', workspace: 'with its workspace',
        'newtab-left': 'after it sat in the background', restore: 'at startup',
        memory: 'early, because ' + (note || 'memory was low'),
        heavy: 'early, because ' + (note || 'it was using a lot of memory')
      }[why] || 'because you asked';
      // The sound state it was judged on, so "my stream went to sleep" can be read off the log.
      line(`A tab on ${place(url)} went to sleep ${cause}, to free its memory${sound ? ' (' + sound + ')' : ''}.`);
    },

    tabSleepSkipped({ url, reason }) {
      line(`A tab on ${place(url)} was kept awake: ${reason}.`);
    },

    tabWoke({ url, sleptMs }) {
      run.woke++;
      const long = Number.isFinite(sleptMs) && sleptMs > 0 ? ` after sleeping ${durationWords(sleptMs)}` : '';
      line(`A sleeping tab on ${place(url)} woke up${long}.`);
    },

    /** The 30-min check: memory, plus failed loads since the last one. */
    check(metrics, extra) {
      line(memoryWords(metrics, Object.assign({ upMs: o.clock() - startedAt }, extra || {})));
      if (windowFails.size) {
        const n = Array.from(windowFails.values()).reduce((a, b) => a + b, 0);
        const parts = Array.from(windowFails.entries()).sort((a, b) => b[1] - a[1]).map(([w, c]) => `${c} x ${w}`);
        line(`Since the last check, ${plural(n, 'page', 'pages')} failed to load: ${parts.join('; ')}.`
          + (windowFailExtra ? ` (${windowFailExtra} of them had no line of their own.)` : ''));
      }
      windowFails = new Map();
      windowFailLines = 0;
      windowFailExtra = 0;
    },

    warning(w) {
      // Electron warns once per failed loadURL(); the page failure already has its own line.
      if (/^Failed to load URL:/.test(String(w && w.message))) return;
      run.warnings++;
      if (run.warnings > WARNING_LINES_PER_RUN) return;
      const name = oneLine(w && w.name, 60) || 'Warning';
      line(`Node.js warned (not a crash): ${name}: ${oneLine(w && w.message, 240)}`
        + (run.warnings === WARNING_LINES_PER_RUN ? ' (Further warnings this run are not written.)' : ''));
    },

    uncaught(err, origin) {
      run.errors++;
      const msg = oneLine((err && err.message) || err, 240);
      const at = oneLine(((err && err.stack) || '').split('\n').slice(1, 2).join('').trim(), 160);
      line(`Quartz's main process hit an error nothing handled${origin === 'unhandledRejection' ? ' (a promise)' : ''}: ${msg}${at ? ' ' + at : ''}`);
    },

    power(what) {
      line(what === 'suspend' ? 'The PC went to sleep.' : 'The PC woke up.');
    },

    /**
     * A failure the chrome told the user about in plain words; the raw error text lives HERE, not
     * on screen. `where` must be one of UI_ERROR_WORDS (anything else writes nothing); `detail` is
     * the raw text, one line. Capped per run like warnings, so a stuck button can't fill the file.
     */
    uiError({ where, detail }) {
      const what = Object.prototype.hasOwnProperty.call(UI_ERROR_WORDS, where) ? UI_ERROR_WORDS[where] : '';
      if (!what) return false;
      run.uiErrors++;
      if (run.uiErrors > UI_ERROR_LINES_PER_RUN) return false;
      return line(`${what}. The error was: ${oneLine(String(detail == null ? '' : detail).replace(/\s+/g, ' ').trim(), 240) || 'no error text was given'}`
        + (run.uiErrors === UI_ERROR_LINES_PER_RUN ? ' (Further errors like this one this run are not written.)' : ''));
    },
  };
}

/* ---- the Electron wiring ---------------------------------------------------------------------- */

/**
 * Called once from main.js, in whenReady (userData is final by then, test
 * profile included). Returns the log plus the hooks main.js calls from the
 * places only it can see: watchWindow(win), watchGuest(contents), adblock(...).
 *
 * deps: { app, ipcMain, isChromeSender, webContents, powerMonitor, appDir,
 *         profile (test profile name or ''), memoryEveryMs }
 */
function install(deps) {
  const d = deps;
  const os = require('os');
  const log = createQuartzLog({
    file: path.join(d.app.getPath('userData'), LOG_NAME),
    appDir: d.appDir,
    home: os.homedir(),
    user: (() => { try { return os.userInfo().username; } catch (_) { return ''; } })(),
  });
  log.start({
    version: d.app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    os: os.release(), pid: process.pid, profile: d.profile,
  });

  let windowContents = null;

  // The chrome forwards what only it knows (a crash card it decided to show,
  // a tab it put to sleep). Words are made here, from plain data.
  d.ipcMain.on('log:event', (event, payload) => {
    if (!d.isChromeSender(event)) return;
    const p = payload && typeof payload === 'object' ? payload : {};
    const url = typeof p.url === 'string' ? p.url.slice(0, 2048) : '';
    if (p.kind === 'tab-crashed') log.tabCrashed({ url, reason: oneLine(p.reason, 40), exitCode: Number(p.exitCode) });
    else if (p.kind === 'tab-slept') log.tabSlept({ url, why: oneLine(p.why, 20), sound: oneLine(p.sound, 60), note: oneLine(p.note, 80) });
    else if (p.kind === 'tab-sleep-skipped') log.tabSleepSkipped({ url, reason: oneLine(p.reason, 120) });
    else if (p.kind === 'tab-woke') log.tabWoke({ url, sleptMs: Number(p.sleptMs) });
    else if (p.kind === 'ui-error') log.uiError({ where: String(p.where || ''), detail: oneLine(p.detail, 240) });
  });

  d.app.on('child-process-gone', (_e, details) => log.childGone(details || {}));
  d.app.on('quit', () => log.quit('quit'));
  // Windows ends the process right after this on a sign-out or shutdown; 'quit' may never come.
  d.app.on('session-end', () => log.quit('session-end'));
  if (d.powerMonitor) {
    d.powerMonitor.on('suspend', () => log.power('suspend'));
    d.powerMonitor.on('resume', () => log.power('resume'));
  }
  // Both only OBSERVE: adding them changes nothing about what Node does with
  // the warning or the error (uncaughtExceptionMonitor runs before the default).
  process.on('warning', (w) => log.warning(w));
  process.on('uncaughtExceptionMonitor', (err, origin) => log.uncaught(err, origin));

  const check = () => {
    let metrics = [];
    try { metrics = d.app.getAppMetrics(); } catch (_) { /* none */ }
    let tabsAwake;
    try { tabsAwake = d.webContents.getAllWebContents().filter((c) => !c.isDestroyed() && c.getType() === 'webview').length; } catch (_) { /* unknown */ }
    let windowPid = 0;
    try { windowPid = windowContents && !windowContents.isDestroyed() ? windowContents.getOSProcessId() : 0; } catch (_) { /* none */ }
    log.check(metrics, { tabsAwake, windowPid });
  };
  const timer = setInterval(check, d.memoryEveryMs || MEMORY_EVERY_MS);
  if (timer.unref) timer.unref();

  return {
    log,
    check,

    /** The chrome window: its renderer crashing, or hanging. */
    watchWindow(win) {
      const wc = win.webContents;
      windowContents = wc;
      const key = 'window:' + wc.id;
      wc.on('render-process-gone', (_e, details) => {
        log.forget(key);
        if (details && details.reason === 'clean-exit') return;
        log.windowCrashed(details || {});
      });
      wc.on('unresponsive', () => log.unresponsive(key, '', true));
      wc.on('responsive', () => log.responsive(key));
    },

    /** Every <webview> guest: hangs and main-frame load failures. Crashes come from app.js. */
    watchGuest(contents) {
      const key = 'guest:' + contents.id;
      const urlOf = () => { try { return contents.getURL(); } catch (_) { return ''; } };
      contents.on('unresponsive', () => log.unresponsive(key, urlOf(), false));
      // Closing a hung tab ALSO fires 'responsive' (its widget goes away), just before
      // 'destroyed'. So the recovery line waits a second: a tab that was destroyed meanwhile
      // has been forgotten, and says nothing. The time is the moment it fired.
      contents.on('responsive', () => {
        const at = Date.now();
        const t = setTimeout(() => { if (!contents.isDestroyed()) log.responsive(key, at); }, RESPONSIVE_SETTLE_MS);
        if (t.unref) t.unref();
      });
      contents.on('render-process-gone', () => log.forget(key));
      contents.on('destroyed', () => log.forget(key));
      contents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;                         // a dead image is not a dead page
        if (errorCode === -3 || errorCode === 0) return;  // ERR_ABORTED: a navigation replaced by another
        log.loadFailed({ url: validatedURL, errorCode, errorDescription });
      });
    },

    adblock(info) { log.adblock(info); },
  };
}

module.exports = {
  LOG_NAME, MEMORY_EVERY_MS,
  makeRotatingFile, createQuartzLog, install,
  goneWords, loadErrorWords, placeOf, durationWords, memoryWords, makeScrubber, stampOf,
};
