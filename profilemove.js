'use strict';

// profilemove.js — the one-time move of the profile when the app id changes.
//
// The app was called `browser` and is now called Quartz. Electron derives the
// profile folder from that name (%APPDATA%\<name>), so the day package.json
// says Quartz, the first start would otherwise open a brand-new, EMPTY
// %APPDATA%\Quartz -- no logins, no cookies, no history, no session -- while
// everything the user had sat untouched one folder over. That failure is silent
// (the browser starts fine, just logged out of everything), which is the one
// kind of failure this app does not allow.
//
// So main.js calls this before anything opens a file in userData, and it does
// exactly one of four things:
//
//   same     the old and the new folder are the same folder (the app is still
//            called `browser`): nothing to do. This is what makes the code
//            safe to land before package.json changes -- it is inert until the
//            name actually differs.
//   normal   only the new folder exists (every start after the move), or
//            neither does (a genuine first run, where Electron makes it).
//   move     only the old folder exists: RENAME it. Same volume, same parent,
//            so it is one atomic directory entry change -- instant, nothing
//            copied, and there is no half-moved state to recover from.
//   refuse   anything else: both folders exist, something that is not a folder
//            sits where one should be, the disk would not even answer a stat,
//            or the rename failed (an old copy still running holds files in the
//            old folder, which Windows will not let us move out from under it).
//            main.js shows the reason in an error box and quits. It never
//            starts on an empty profile, never merges, never deletes.
//
// Everything is pure node with the fs injected, so the whole decision --
// including a folder that is really locked -- runs in a plain node harness on
// temp folders without Electron and without going near the real profile.

const realFs = require('fs');
const path = require('path');

/** The note left in the new folder so Settings > About can say what happened. */
const MOVE_NOTE = 'profile-move.json';

/**
 * Same folder? NTFS is case-insensitive, so on Windows `...\browser` and
 * `...\Browser` are ONE folder and a rename between them would be a pointless
 * case change, not a move. Compared resolved, so a trailing slash or a `..`
 * cannot make one folder look like two.
 */
function samePath(a, b, platform = process.platform) {
  const ra = path.resolve(String(a));
  const rb = path.resolve(String(b));
  return platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * What is at `dir`: 'missing', 'dir', 'other' (a file, or anything that is not
 * a folder), or 'error' with the code. statSync, not lstatSync: a junction to a
 * real profile folder is still a profile folder.
 */
function probe(dir, fs) {
  try {
    return fs.statSync(dir).isDirectory() ? { kind: 'dir' } : { kind: 'other' };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error', code: (err && err.code) || 'UNKNOWN', message: String((err && err.message) || err) };
  }
}

/**
 * The decision, and nothing else: reads the disk, never writes it.
 *
 * @param {string} oldDir  %APPDATA%\browser
 * @param {string} newDir  %APPDATA%\Quartz (app.getPath('userData'))
 * @param {object} [fs]    injected for the harness; defaults to node's fs
 * @returns {{action:'same'|'normal'|'move'|'refuse', why:string, code?:string}}
 */
function decideProfileMove(oldDir, newDir, fs = realFs) {
  if (samePath(oldDir, newDir)) {
    return { action: 'same', why: 'the app still uses its old profile folder; nothing to move' };
  }
  const o = probe(oldDir, fs);
  const n = probe(newDir, fs);

  // A stat that failed for any reason but "not there" means we cannot tell
  // what is on disk. Guessing "not there" is exactly how a real profile gets
  // skipped and an empty one opened, so it is a refusal, not a default.
  if (o.kind === 'error') {
    return { action: 'refuse', why: 'could not check the old profile folder (' + o.code + ')', code: o.code };
  }
  if (n.kind === 'error') {
    return { action: 'refuse', why: 'could not check the new profile folder (' + n.code + ')', code: n.code };
  }
  if (o.kind === 'other') {
    return { action: 'refuse', why: 'the old profile path is a file, not a folder', code: 'ENOTDIR' };
  }
  if (n.kind === 'other') {
    return { action: 'refuse', why: 'the new profile path is a file, not a folder', code: 'ENOTDIR' };
  }

  if (o.kind === 'dir' && n.kind === 'dir') {
    return { action: 'refuse', why: 'both profile folders exist', code: 'EEXIST' };
  }
  if (o.kind === 'dir') {
    return { action: 'move', why: 'only the old profile folder exists' };
  }
  if (n.kind === 'dir') {
    return { action: 'normal', why: 'the profile is already in the new folder' };
  }
  return { action: 'normal', why: 'no profile yet in either folder: a first run starts a new one', fresh: true };
}

/** A synchronous pause for the retry loop: main.js runs this before `ready`, where nothing is async yet. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/*
 * Rename errors worth waiting out. "Restart browser" relaunches a new copy the
 * moment the old main process exits, and its GPU / network-service children
 * can take a beat longer to let go of Cookies, the LevelDBs and `lockfile`.
 * Windows answers a rename of a folder with a file still open inside it with
 * EPERM / EBUSY / EACCES, so those get a few short retries (~2.4 s in all)
 * before we give up. A copy that is genuinely still running holds them for
 * good, and the retries end in the same refusal, just 2.4 s later.
 */
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Decide, and do the move if that is the decision.
 *
 * @param {string} oldDir
 * @param {string} newDir
 * @param {object} [fs]
 * @param {{retries?:number, delayMs?:number, sleep?:(ms:number)=>void, now?:()=>Date}} [opts]
 * @returns {{ok:boolean, action:'same'|'normal'|'moved'|'refuse', why:string,
 *            code?:string, attempts?:number, raced?:boolean, fresh?:boolean,
 *            from?:string, to?:string, at?:string}}
 */
function runProfileMove(oldDir, newDir, fs = realFs, opts = {}) {
  const retries = Number.isInteger(opts.retries) ? opts.retries : 8;
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 300;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : sleepSync;
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();

  const d = decideProfileMove(oldDir, newDir, fs);
  if (d.action === 'refuse') return Object.assign({ ok: false }, d);
  if (d.action !== 'move') return Object.assign({ ok: true }, d);

  let lastErr = null;
  let attempts = 0;
  for (let i = 0; i <= retries; i++) {
    attempts++;
    try {
      // renameSync is MoveFileExW underneath: one directory entry changes, the
      // contents never move. It refuses to land on an existing folder, so even
      // a folder that appeared since the decision above cannot be merged into.
      fs.renameSync(oldDir, newDir);
      return {
        ok: true,
        action: 'moved',
        why: 'moved the profile folder to its new name',
        from: path.resolve(oldDir),
        to: path.resolve(newDir),
        at: now().toISOString(),
        attempts,
      };
    } catch (err) {
      lastErr = err;
      // Re-read the disk rather than trusting the error code. Two copies
      // started at the same instant (a link click during startup) both decide
      // "move"; one wins, and the loser's rename fails with ENOENT. If the
      // folder is now exactly where it belongs, the loser starts normally and
      // the single-instance lock hands its URL to the winner.
      const again = decideProfileMove(oldDir, newDir, fs);
      if (again.action === 'normal' && !again.fresh) {
        return { ok: true, action: 'normal', why: 'another copy moved the profile at the same moment', raced: true, attempts };
      }
      // Something else changed under us (a new folder appeared, the old one
      // turned into a file): report THAT, it is the more useful reason.
      if (again.action === 'refuse') return Object.assign({ ok: false, attempts, renameCode: err && err.code }, again);
      if (again.action !== 'move' || !RETRY_CODES.has(err && err.code) || i === retries) break;
      sleep(delayMs);
    }
  }
  const code = (lastErr && lastErr.code) || 'UNKNOWN';
  return {
    ok: false,
    action: 'refuse',
    stage: 'rename',
    why: RETRY_CODES.has(code)
      ? 'the old profile folder is in use -- an old copy of the browser is probably still running'
      : 'renaming the old profile folder failed',
    code,
    message: String((lastErr && lastErr.message) || lastErr),
    attempts,
  };
}

/**
 * The error box for a refusal: which folder, why, and what to do. Returned as
 * data so the harness can hold the wording to its promises.
 */
function refusalText(result, oldDir, newDir) {
  const title = 'Quartz did not start: your profile could not be moved';
  const where =
    'Your logins, cookies, history, session and settings are in:\n' +
    '    ' + oldDir + '\n' +
    'Quartz keeps them in:\n' +
    '    ' + newDir + '\n\n';
  const safe =
    '\n\nNothing was moved, merged or deleted. Quartz stopped instead of opening an empty ' +
    'profile, so nothing is lost.';
  let body;
  if (result.code === 'EEXIST') {
    body =
      where +
      'BOTH folders exist, so Quartz will not pick one, merge them or delete either.\n\n' +
      'If an old copy of the browser is open, close the other window first. Then move the folder ' +
      'you do NOT want out of ' + path.dirname(newDir) + ' (keep it somewhere safe) and start Quartz again.' +
      safe;
  } else if (result.stage === 'rename' && RETRY_CODES.has(result.code)) {
    body =
      where +
      'Moving the folder failed (' + result.code + '): something still has files open inside ' +
      oldDir + '. That is almost always an old copy of the browser that is still running ' +
      '(check the tray and Task Manager for electron.exe).\n\n' +
      'Close the other window and start Quartz again.' +
      safe;
  } else {
    body =
      where +
      'The move was refused: ' + result.why + ' (' + (result.code || 'UNKNOWN') + ').' +
      (result.message ? '\n' + result.message : '') + '\n\n' +
      'Close the other window if an old copy of the browser is open, fix the folder above, ' +
      'and start Quartz again.' +
      safe;
  }
  return { title, body };
}

/** Leave the note in the new folder. Returns '' or the reason it could not be written. */
function writeMoveNote(newDir, result, fs = realFs) {
  try {
    const note = { from: result.from, to: result.to, at: result.at, attempts: result.attempts };
    fs.writeFileSync(path.join(newDir, MOVE_NOTE), JSON.stringify(note, null, 2) + '\n');
    return '';
  } catch (err) {
    return (err && err.code) || String(err);
  }
}

/** The note, or null when there is none (a profile that was never moved) or it is unreadable. */
function readMoveNote(userDataDir, fs = realFs) {
  try {
    const note = JSON.parse(fs.readFileSync(path.join(userDataDir, MOVE_NOTE), 'utf8'));
    return note && typeof note.from === 'string' && typeof note.at === 'string' ? note : null;
  } catch {
    return null;
  }
}

module.exports = {
  MOVE_NOTE,
  samePath,
  decideProfileMove,
  runProfileMove,
  refusalText,
  writeMoveNote,
  readMoveNote,
};
