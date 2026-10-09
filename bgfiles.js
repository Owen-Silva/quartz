'use strict';

/**
 * Quartz's background, on disk.
 *
 * Two kinds of file live in <userData>/backgrounds/, and they never touch:
 *
 *   newtab-bg.<ext>   the moving picture (a video or GIF) the user picked.
 *                     Settings stores the descriptor ({ kind: 'video',
 *                     fileUrl, fileName, ... }); the clip itself is copied in
 *                     so it keeps playing after the original is moved, renamed
 *                     or deleted. Exactly one clip lives here at a time --
 *                     picking a new one removes the old.
 *
 *   wallpaper.<ext>   a copy of the Windows wallpaper, the DEFAULT background
 *                     (Settings kind 'wallpaper'). Copied once, the first time
 *                     anything asks and no copy is there yet, plus whenever the
 *                     user presses "Copy again from Windows". It is a copy, not
 *                     a live link, for the same reason Helm keeps one: Windows
 *                     rewrites TranscodedWallpaper in place whenever the
 *                     wallpaper changes (or a slideshow ticks), and a
 *                     background that silently changes under the browser while
 *                     it runs is not one the user chose. Clearing the clip
 *                     (clearBackgroundFiles) never removes this file.
 *
 * Nothing in here touches Electron, so it can be required and tested on its
 * own: main.js only supplies the dialog, the userData path and %APPDATA%.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

/** What the picker offers, and the only extensions that may be copied. */
const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v', 'gif'];

/** A 1080p loop is a few tens of MB; anything past this is a mistake. */
const MAX_BYTES = 512 * 1024 * 1024;

/** The clip copy is always named this, so the folder never accumulates. */
const BASENAME = 'newtab-bg';

/** The wallpaper copy's name (plus the extension its bytes say it is). */
const WALLPAPER_BASENAME = 'wallpaper';

/** What a wallpaper copy may be: the three formats Windows transcodes to. */
const WALLPAPER_EXTS = ['png', 'jpg', 'webp'];

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
 *
 * Only the CLIP's files: the prefix test below is 'newtab-bg.', so the
 * wallpaper copy (wallpaper.<ext>) is never matched. Removing the moving
 * picture must not take the default background down with it.
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

/* ---------------------------------------------------------------------------
   The Windows wallpaper copy

   Ported from Helm's main/settings.js copyWallpaper(): Windows keeps the
   current wallpaper, already transcoded, at
     %APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper
   with no extension. Its bytes are a JPEG most of the time, sometimes a PNG
   or WebP, so the extension comes from the magic bytes, never from a guess.
   --------------------------------------------------------------------------- */

/**
 * What a buffer of image bytes is, by its first twelve bytes.
 * @returns {'png'|'jpg'|'webp'|null} null for anything else (or too short)
 */
function imageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Where Windows keeps the current wallpaper, or null without %APPDATA%. */
function transcodedWallpaperPath(appDataDir) {
  if (typeof appDataDir !== 'string' || !appDataDir) return null;
  return path.join(appDataDir, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
}

/**
 * The file:// URL a renderer should load for a copy. The ?v= stamp is the
 * copy's mtime: "Copy again" rewrites the SAME name, and without the stamp the
 * chrome and the new tab would both keep painting the old picture out of
 * their image cache. Chromium's file:// loader ignores the query when it maps
 * the URL back to a path, so the stamp costs nothing on disk.
 */
function stampedFileUrl(file, mtimeMs) {
  return pathToFileURL(file).href + '?v=' + Math.round(Number(mtimeMs) || 0);
}

/**
 * The wallpaper copy already in the folder, if there is one.
 * @returns {{path:string, fileName:string, mtimeMs:number}|null}
 */
function findWallpaperCopy(dir) {
  for (const ext of WALLPAPER_EXTS) {
    const file = path.join(dir, WALLPAPER_BASENAME + '.' + ext);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size > 0) {
        return { path: file, fileName: path.basename(file), mtimeMs: stat.mtimeMs };
      }
    } catch { /* not this extension */ }
  }
  return null;
}

/** A plain-words reason for a failed read of TranscodedWallpaper. */
function wallpaperReadReason(err) {
  const code = err && err.code;
  if (code === 'ENOENT') {
    return 'Windows has no wallpaper file to copy (TranscodedWallpaper is missing)';
  }
  if (code === 'EACCES' || code === 'EPERM') return 'Windows would not let the browser read the wallpaper file';
  if (code === 'EBUSY') return 'the wallpaper file was busy (Windows was changing it); try again in a moment';
  return (err && err.message) || 'the wallpaper file could not be read';
}

/**
 * Make sure a copy of the Windows wallpaper is in `dir`.
 *
 * Without `force`, an existing copy is kept and returned as it is: the copy
 * happens ONCE, the first time a background is asked for, and after that the
 * picture only changes when the user presses "Copy again from Windows"
 * (force: true), which re-reads TranscodedWallpaper over the old copy.
 *
 * The write goes to a temporary name and is renamed into place, so a crash
 * mid-copy never leaves a half picture where a whole one was. A copy in a
 * different format (the wallpaper went from JPEG to PNG) is removed once the
 * new one has landed, so only one wallpaper.* is ever there.
 *
 * A failed forced copy leaves the previous copy where it was: the caller gets
 * ok:false with the reason AND the old copy's url, so it can say what went
 * wrong while still showing the picture it had.
 *
 * @param {{appDataDir?:string, dir:string, force?:boolean, now?:number}} opts
 * @returns {{ok:boolean, fileUrl:string|null, fileName:string|null,
 *            copiedAt:number|null, reason:string|null, copied:boolean,
 *            path:string|null}}
 *   copied: true when bytes were written this call. copiedAt is the copy's
 *   mtime in ms (when it was taken from Windows).
 */
function copyWallpaper(opts) {
  const o = opts || {};
  const dir = String(o.dir || '');
  const existing = dir ? findWallpaperCopy(dir) : null;
  const describe = (copy, extra) => Object.assign({
    ok: !!copy,
    fileUrl: copy ? stampedFileUrl(copy.path, copy.mtimeMs) : null,
    fileName: copy ? copy.fileName : null,
    copiedAt: copy ? Math.round(copy.mtimeMs) : null,
    reason: null,
    copied: false,
    path: copy ? copy.path : null
  }, extra || {});

  if (!dir) return describe(null, { ok: false, reason: 'the browser has no backgrounds folder' });
  if (existing && !o.force) return describe(existing);

  // Either there is no copy yet, or the user asked for a fresh one. A failure
  // from here on keeps whatever copy there was (describe(existing, ...)).
  const src = transcodedWallpaperPath(o.appDataDir);
  if (!src) {
    return describe(existing, { ok: false, reason: 'Windows did not say where its themes folder is (%APPDATA% is not set)' });
  }

  let buf;
  try {
    buf = fs.readFileSync(src);
  } catch (err) {
    return describe(existing, { ok: false, reason: wallpaperReadReason(err) });
  }
  const ext = imageExt(buf);
  if (!ext) {
    return describe(existing, { ok: false, reason: 'the Windows wallpaper file is not a PNG, JPEG or WebP picture' });
  }

  const target = path.join(dir, WALLPAPER_BASENAME + '.' + ext);
  const tmp = target + '.tmp-' + process.pid;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    return describe(existing, { ok: false, reason: (err && err.message) || 'the copy could not be written' });
  }
  // A copy in another format would otherwise win findWallpaperCopy's order.
  for (const other of WALLPAPER_EXTS) {
    if (other === ext) continue;
    try { fs.unlinkSync(path.join(dir, WALLPAPER_BASENAME + '.' + other)); } catch { /* not there */ }
  }
  // Stamp the mtime explicitly: on some file systems a rename keeps the tmp
  // file's time to the second, and the ?v= stamp must change on every copy.
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  try { fs.utimesSync(target, now / 1000, now / 1000); } catch { /* the stat below still answers */ }
  const fresh = findWallpaperCopy(dir);
  return describe(fresh, fresh
    ? { copied: true }
    : { ok: false, reason: 'the copy was written but cannot be found again' });
}

module.exports = {
  VIDEO_EXTS,
  MAX_BYTES,
  BASENAME,
  WALLPAPER_BASENAME,
  WALLPAPER_EXTS,
  DIR_NAME,
  REJECT_EXT,
  extOf,
  isAllowedExt,
  backgroundsDir,
  clearBackgroundFiles,
  installBackgroundVideo,
  imageExt,
  transcodedWallpaperPath,
  findWallpaperCopy,
  copyWallpaper
};
