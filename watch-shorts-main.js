'use strict';
/*
 * watch-shorts-main.js -- main's half of Lumen's Shorts view (watch-shorts.js).
 *
 * The chrome draws the view and drives YouTube's own Shorts page; this file only writes the
 * view's lines to quartz.log, so a Short that could not be shown is never a silent failure:
 *   "[lumen shorts] opened: short | feed | channel | subs"
 *   "[lumen shorts] the Shorts page failed: <reason>"
 *   "[lumen shorts] no Shorts player found on the page"
 *   "[lumen shorts] no Shorts to open: grid | feed"
 * Only the chrome may write; a line is one short, printable string, and a repeat of the last
 * line within a few seconds is dropped. Nothing here reads, plays or touches a stream.
 */
const LINE_MAX = 200;
const REPEAT_MS = 5000;

function cleanLine(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, LINE_MAX);
}

function create(deps) {
  const d = deps || {};
  const ipcMain = d.ipcMain;
  const isChromeSender = typeof d.isChromeSender === 'function' ? d.isChromeSender : () => false;
  const log = typeof d.log === 'function' ? d.log : (line) => console.log('[lumen shorts] ' + line);
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  let last = { line: '', at: 0 };
  let written = 0;

  function write(raw) {
    const line = cleanLine(raw);
    if (!line) return false;
    const t = now();
    if (line === last.line && t - last.at < REPEAT_MS) return false;
    last = { line, at: t };
    written++;
    log(line);
    return true;
  }

  function registerIpc() {
    if (!ipcMain) return;
    ipcMain.handle('watch-shorts:log', (event, payload) => {
      if (!isChromeSender(event)) throw new Error('not the chrome');
      return { ok: write(payload && typeof payload === 'object' ? payload.line : payload) };
    });
  }

  return { registerIpc, write, state: () => ({ written, last: last.line }) };
}

module.exports = { create, cleanLine, LINE_MAX, REPEAT_MS };
