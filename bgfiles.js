'use strict';

/**
 * The new tab's moving background, on disk.
 *
 * Settings stores the descriptor ({ kind: 'video', fileUrl, fileName, ... });
 * the clip itself is copied into <userData>/backgrounds/ so the new tab keeps
 * playing after the original is moved, renamed or deleted. Exactly one clip
 * lives there at a time -- picking a new one removes the old.
 *
 * Nothing in here touches Electron, so it can be required and tested on its
 * own: main.js only supplies the dialog and the userData path.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

/** What the picker offers, and the only extensions that may be copied. */
const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v', 'gif'];

/** A 1080p loop is a few tens of MB; anything past this is a mistake. */
const MAX_BYTES = 512 * 1024 * 1024;

/** The copy is always named this, so the folder never accumulates. */
const BASENAME = 'newtab-bg';

/** The folder name under userData. */
const DIR_NAME = 'backgrounds';

const REJECT_EXT = 'Pick an MP4, WebM, MOV, M4V or GIF';

/** Lowercase extension without the dot ('' when there is none). */
function extOf(file) {
  const ext = path.extname(String(file == null ? '' : file));
  return ext ? ext.slice(1).toLowerCase() : '';
}

function isAllowedExt(ext) {
  return VIDEO_EXTS.indexOf(String(ext || '').toLowerCase()) >= 0;
}

/** <userData>/backgrounds — the caller owns the userData half. */
function backgroundsDir(userDataPath) {
  return path.join(String(userDataPath), DIR_NAME);
}

/**
 * Remove every newtab-bg.* in the folder. Never throws: a folder that was
 * never created, or a file already gone, is the state we wanted anyway.
 * @returns {number} how many files were actually removed
 */
function clearBackgroundFiles(dir) {
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // no folder yet
  }
  for (const name of names) {
    if (name.indexOf(BASENAME + '.') !== 0) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch { /* locked or already gone: leave it */ }
  }
  return removed;
}

/**
 * Copy a chosen clip in as the one background video.
 *
 * @param {string} sourcePath absolute path the user picked
 * @param {string} dir        the backgrounds folder (created if missing)
 * @returns {{ok:true, fileUrl:string, fileName:string, bytes:number, path:string}
 *          |{ok:false, reason:string}}
 *          reason is 'too-large' past 512 MB, otherwise a message to show.
 */
function installBackgroundVideo(sourcePath, dir) {
  const src = typeof sourcePath === 'string' ? sourcePath.trim() : '';
  if (!src) return { ok: false, reason: 'cancelled' };

  const ext = extOf(src);
  if (!isAllowedExt(ext)) return { ok: false, reason: REJECT_EXT };

  let bytes = 0;
  try {
    const stat = fs.statSync(src);
    if (!stat.isFile()) return { ok: false, reason: REJECT_EXT };
    bytes = stat.size;
  } catch (err) {
    return { ok: false, reason: (err && err.message) || 'That file could not be read' };
  }
  if (bytes > MAX_BYTES) return { ok: false, reason: 'too-large' };

  const target = path.join(dir, BASENAME + '.' + ext);
  try {
    fs.mkdirSync(dir, { recursive: true });
    clearBackgroundFiles(dir);            // the old clip goes before the new lands
    fs.copyFileSync(src, target);
  } catch (err) {
    return { ok: false, reason: (err && err.message) || 'That file could not be copied' };
  }

  return {
    ok: true,
    fileUrl: pathToFileURL(target).href,
    fileName: path.basename(src),
    bytes: bytes,
    path: target
  };
}

module.exports = {
  VIDEO_EXTS,
  MAX_BYTES,
  BASENAME,
  DIR_NAME,
  REJECT_EXT,
  extOf,
  isAllowedExt,
  backgroundsDir,
  clearBackgroundFiles,
  installBackgroundVideo
};
