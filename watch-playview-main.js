'use strict';
/*
 * watch-playview-main.js -- main's half of Lumen's playback view (watch-playview.js).
 *
 * The chrome draws the view; this file only owns its one setting and a test seam:
 *   - Settings > Lumen, "When a video plays": 'lumen' (the default: the service's own
 *     player on top, Lumen's info below) or 'page' (the service's full page, as before),
 *     in <userData>/watch-playview.json;
 *   - TEST ONLY (--test-profile): the window's real state (OS fullscreen or not, its
 *     bounds), and a guard that takes the window straight back out of OS fullscreen and
 *     counts it, so a test can prove the window never left its off-screen spot.
 *
 * Nothing here reads, plays or touches a stream: the services' own pages do, in their
 * own players.
 */
const fs = require('fs');
const path = require('path');

const PREFS_FILE = 'watch-playview.json';
const VIEWS = ['lumen', 'page'];

function cleanView(v) { return VIEWS.indexOf(String(v)) >= 0 ? String(v) : 'lumen'; }

function create(deps) {
  const d = deps || {};
  const ipcMain = d.ipcMain;
  const electronApp = d.app || null;
  const getWindow = typeof d.getWindow === 'function' ? d.getWindow : () => null;
  const isChromeSender = typeof d.isChromeSender === 'function' ? d.isChromeSender : () => false;
  const log = typeof d.log === 'function' ? d.log : (line) => console.log('[watch-playview] ' + line);
  const isTest = !!d.test;
  let prefs = null;
  let fsEntered = 0;          // TEST: times the OS window went fullscreen (each one undone at once)
  let guarded = null;

  function prefsFile() {
    const dir = d.userData || (electronApp && typeof electronApp.getPath === 'function' ? electronApp.getPath('userData') : '');
    return dir ? path.join(dir, PREFS_FILE) : '';
  }
  function load() {
    if (prefs) return prefs;
    prefs = { view: 'lumen' };
    const f = prefsFile();
    if (!f) return prefs;
    try { const raw = JSON.parse(fs.readFileSync(f, 'utf8')); prefs.view = cleanView(raw && raw.view); } catch { /* none yet: the default */ }
    return prefs;
  }
  function save() {
    const f = prefsFile();
    if (!f) return false;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2));
      fs.renameSync(tmp, f);
      return true;
    } catch (e) { log('could not save ' + PREFS_FILE + ': ' + ((e && e.message) || e)); return false; }
  }
  function view() { return load().view; }
  function setView(v) {
    load();
    const next = cleanView(v);
    if (next !== prefs.view) { prefs.view = next; save(); log('When a video plays: ' + (next === 'lumen' ? 'Lumen view' : 'the service’s full page')); }
    return prefs.view;
  }

  /** TEST: undo any OS fullscreen at once, and count it (the e2e fails on a count above 0). */
  function guardWindow() {
    if (!isTest) return;
    const w = getWindow();
    if (!w || w.isDestroyed() || guarded === w) return;
    guarded = w;
    w.on('enter-full-screen', () => {
      fsEntered++;
      log('TEST: the window went OS-fullscreen; taken back out at once');
      try { w.setFullScreen(false); } catch { /* gone */ }
    });
  }

  function registerIpc() {
    if (!ipcMain) return;
    const on = (ch, fn) => ipcMain.handle(ch, (event, payload) => {
      if (!isChromeSender(event)) throw new Error('not the chrome');
      return fn(payload && typeof payload === 'object' ? payload : {});
    });
    on('watch-playview:get', () => { guardWindow(); return { view: view() }; });
    on('watch-playview:set-view', (p) => ({ view: setView(p.view) }));
    if (isTest) {
      on('watch-playview:test-win', () => {
        guardWindow();
        const w = getWindow();
        if (!w || w.isDestroyed()) return { ok: false };
        const b = w.getContentBounds();
        return { ok: true, fullScreen: w.isFullScreen(), simpleFullScreen: typeof w.isSimpleFullScreen === 'function' ? w.isSimpleFullScreen() : false,
          maximized: w.isMaximized(), entered: fsEntered, content: { x: b.x, y: b.y, width: b.width, height: b.height } };
      });
    }
  }

  return { registerIpc, view, setView, guardWindow, state: () => ({ view: view(), fsEntered }) };
}

module.exports = { create, cleanView, VIEWS, PREFS_FILE };
