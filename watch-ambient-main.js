'use strict';
/*
 * watch-ambient-main.js -- main's half of Lumen's ambient field (watch-ambient.js).
 *
 * The chrome paints the field and refreshes its colours from the playing video every few
 * seconds; it asks here only whether it may refresh at all: battery saver (powersaver.js, one
 * free kernel32 call) stops the refresh, and the field keeps the video's still. The answer is
 * { ok: true, saver: true | false | null, why } (null = this machine cannot say, and why says
 * so). Only the chrome may ask. Nothing here reads, plays or touches a stream.
 */
function create(deps) {
  const d = deps || {};
  const ipcMain = d.ipcMain;
  const isChromeSender = typeof d.isChromeSender === 'function' ? d.isChromeSender : () => false;
  const saverOn = typeof d.saverOn === 'function' ? d.saverOn
    : () => { try { return require('./powersaver').on(); } catch (e) { return null; } };
  const saverWhy = () => { try { return require('./powersaver').whyNot() || ''; } catch (e) { return 'powersaver.js did not load'; } };

  function gate() {
    let saver = null;
    try { saver = saverOn(); } catch (e) { saver = null; }
    return { ok: true, saver: saver === true ? true : saver === false ? false : null, why: saver === null ? saverWhy() : '' };
  }

  function registerIpc() {
    if (!ipcMain) return;
    ipcMain.handle('lumen-ambient:gate', (event) => {
      if (!isChromeSender(event)) return { ok: false, reason: 'not the chrome' };
      return gate();
    });
  }

  return { registerIpc, gate };
}

module.exports = { create };
