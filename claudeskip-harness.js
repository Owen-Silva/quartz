'use strict';
// claudeskip-harness.js - the Claude "Skip permission prompts" default, pure node, no Electron.
//   node claudeskip-harness.js
//
// What it pins down:
//   1. settings.js: a NEW profile reads claudeSkipPermissions as false (Claude asks before tools);
//   2. the one-time migration: a profile that existed before the default changed and never set
//      the switch gets an explicit true; an explicit true or false is untouched; it runs once;
//      Settings reset keeps the marker, so a reset lands on off;
//   3. app.js: claudeStartArgs() only adds --dangerously-skip-permissions on an explicit true;
//   4. preload.js: pty.start() adds the flag only after setPrefs({ skipPermissions: true }), so
//      there is no moment between start and the renderer's push where a new profile skips.
//
// settings.js, app.js and preload.js are loaded as they ship, in vm sandboxes. The DOM is a
// permissive stub (every property is a callable no-op), because only the store is under test.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 400))); }
}

const SKIP = '--dangerously-skip-permissions';

/* A value that is every DOM thing at once: callable, any property, iterable, empty. */
function stub() {
  const fn = function () { return stub(); };
  return new Proxy(fn, {
    get(target, key) {
      if (key === Symbol.toPrimitive) return () => '';
      if (key === Symbol.iterator) return function* () {};
      if (key === 'length') return 0;
      if (key === 'then') return undefined; // never a thenable
      if (key === 'readyState') return 'loading'; // boot() waits for DOMContentLoaded, which never comes
      if (key === 'matches') return false;
      if (key === 'getItem') return () => null;
      return stub();
    },
    set() { return true; },
    apply() { return stub(); },
    construct() { return stub(); },
    has() { return true; }
  });
}

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] || null,
    get length() { return map.size; }
  };
}

const SETTINGS_SRC = fs.readFileSync(path.join(__dirname, 'settings.js'), 'utf8');

/** Boot settings.js once against `storage` (a fakeStorage); returns window.Settings. */
function bootSettings(storage) {
  const win = {
    localStorage: storage,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    setTimeout: () => 0,
    clearTimeout() {},
    requestAnimationFrame: () => 0,
    api: undefined,
    indexedDB: undefined
  };
  win.window = win;
  const ctx = vm.createContext(Object.assign(win, {
    document: stub(),
    navigator: { platform: 'Win32', userAgent: 'node' },
    console: { log() {}, warn() {}, error() {}, info() {} },
    URL, Date, Math, JSON, Promise, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set,
    isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    ResizeObserver: function () { return { observe() {}, disconnect() {} }; },
    CustomEvent: function () { return {}; },
    Event: function () { return {}; }
  }));
  vm.runInContext(SETTINGS_SRC, ctx, { filename: 'settings.js' });
  return win.Settings;
}

const stored = (storage) => JSON.parse(storage.getItem('settings') || '{}');

// ---- 1. defaults --------------------------------------------------------------------------
{
  let S = null, err = null;
  const st = fakeStorage();
  try { S = bootSettings(st); } catch (e) { err = e; }
  ok('settings.js loads in the sandbox', !!S && !err, err && String(err.stack || err).slice(0, 300));
  if (!S) { console.log('claudeskip: ' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
  ok('DEFAULTS.claudeSkipPermissions is false', S._defaults.claudeSkipPermissions === false, S._defaults.claudeSkipPermissions);
  ok('new profile: get() is false', S.get('claudeSkipPermissions') === false, S.get('claudeSkipPermissions'));
  ok('new profile: nothing written for the switch', !('claudeSkipPermissions' in stored(st)), stored(st));
  ok('new profile: marker written', stored(st).claudeSkipMigration === 1, stored(st));
  // second boot of the same (now used) profile: still off, the marker stops a re-run
  const S2 = bootSettings(st);
  ok('new profile, second boot: still false', S2.get('claudeSkipPermissions') === false, stored(st));
  // explicit choice from the switch
  S2.set({ claudeSkipPermissions: true });
  ok('new profile, switched on: true', bootSettings(st).get('claudeSkipPermissions') === true, stored(st));
}

// ---- 2. the migration through a real boot -----------------------------------------------
{
  // an existing profile that never touched the switch (any other key present)
  const st = fakeStorage({ settings: JSON.stringify({ bgMigration: 1, searchEngine: 'google' }) });
  const S = bootSettings(st);
  ok('existing unset -> true', S.get('claudeSkipPermissions') === true, stored(st));
  ok('existing unset -> stored explicitly', stored(st).claudeSkipPermissions === true, stored(st));
  ok('existing unset -> marker', stored(st).claudeSkipMigration === 1, stored(st));
  // the user then turns it off: the next boot must not turn it back on
  S.set({ claudeSkipPermissions: false });
  const S2 = bootSettings(st);
  ok('runs once: a later off survives the next boot', S2.get('claudeSkipPermissions') === false, stored(st));
}
{
  const st = fakeStorage({ settings: JSON.stringify({ bgMigration: 1, claudeSkipPermissions: false }) });
  const S = bootSettings(st);
  ok('existing explicit false -> unchanged', S.get('claudeSkipPermissions') === false && stored(st).claudeSkipPermissions === false, stored(st));
}
{
  const st = fakeStorage({ settings: JSON.stringify({ bgMigration: 1, claudeSkipPermissions: true }) });
  const S = bootSettings(st);
  ok('existing explicit true -> unchanged', S.get('claudeSkipPermissions') === true && stored(st).claudeSkipPermissions === true, stored(st));
}
{
  // an older profile with no settings object at all, but a saved tab session
  const st = fakeStorage({ session: JSON.stringify({ tabs: [] }) });
  const S = bootSettings(st);
  ok('existing (session only) unset -> true', S.get('claudeSkipPermissions') === true, stored(st));
}
{
  // an empty-but-present object (the store was blocked mid-write, say) and no session: new
  const st = fakeStorage({ settings: '{}' });
  const S = bootSettings(st);
  ok('empty object, no session -> new profile, false', S.get('claudeSkipPermissions') === false, stored(st));
}
{
  // corrupt JSON: load() runs on defaults; with no other evidence that is a new profile
  const st = fakeStorage({ settings: '{not json' });
  const S = bootSettings(st);
  ok('corrupt settings, no session -> false', S.get('claudeSkipPermissions') === false);
}
{
  // reset keeps the marker, so the next boot of a used profile does not turn skipping back on
  const st = fakeStorage({ settings: JSON.stringify({ bgMigration: 1, claudeSkipPermissions: true }), session: '{}' });
  const S = bootSettings(st);
  S.reset();
  ok('reset -> false now', S.get('claudeSkipPermissions') === false, stored(st));
  const S2 = bootSettings(st);
  ok('reset -> still false on the next boot', S2.get('claudeSkipPermissions') === false, stored(st));
}

// ---- 2b. the pure function ------------------------------------------------------------------
{
  const M = bootSettings(fakeStorage())._migrateClaudeSkip;
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok('pure: new profile -> marker only', eq(M({}, false), { claudeSkipMigration: 1 }), M({}, false));
  ok('pure: null stored, no session -> marker only', eq(M(null, false), { claudeSkipMigration: 1 }));
  ok('pure: existing unset -> true', eq(M({ palette: 'ocean' }, false), { claudeSkipMigration: 1, claudeSkipPermissions: true }));
  ok('pure: session only -> true', eq(M({}, true), { claudeSkipMigration: 1, claudeSkipPermissions: true }));
  ok('pure: explicit false kept', eq(M({ claudeSkipPermissions: false }, true), { claudeSkipMigration: 1 }));
  ok('pure: explicit true kept', eq(M({ claudeSkipPermissions: true }, true), { claudeSkipMigration: 1 }));
  ok('pure: non-boolean on existing -> true (old reading was on)', eq(M({ claudeSkipPermissions: null, a: 1 }, false), { claudeSkipMigration: 1, claudeSkipPermissions: true }));
  ok('pure: already ran -> null', M({ claudeSkipMigration: 1 }, true) === null);
}

// ---- 3. app.js claudeStartArgs ----------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const pick = (re) => { const m = src.match(re); return m ? m[0] : ''; };
  const code = [
    pick(/function settingGet\(key\) \{[\s\S]*?\n\}/),
    pick(/const CLAUDE_SKIP_ARG = [^\n]*/),
    pick(/function claudeSkipPermissions\(\) \{[\s\S]*?\n\}/),
    pick(/function claudeStartArgs\(resume\) \{[\s\S]*?\n\}/),
    'globalThis.claudeStartArgs = claudeStartArgs;'
  ].join('\n');
  ok('app.js: the four pieces were found', code.split('\n').length > 10 && code.indexOf('claudeStartArgs(resume)') > 0);
  const run = (settings, resume) => {
    const ctx = vm.createContext({ window: { Settings: settings } });
    vm.runInContext(code, ctx);
    return Array.from(ctx.claudeStartArgs(resume));
  };
  const store = (v) => ({ get: (k) => (k === 'claudeSkipPermissions' ? v : undefined) });
  ok('app.js: no Settings module -> no flag', run(undefined, false).indexOf(SKIP) === -1);
  ok('app.js: unset -> no flag', run(store(undefined), false).indexOf(SKIP) === -1);
  ok('app.js: false -> no flag', run(store(false), true).join(' ') === '--continue');
  ok('app.js: true -> flag first', run(store(true), true).join(' ') === SKIP + ' --continue');
}

// ---- 4. preload.js ----------------------------------------------------------------------------
function bootPreload() {
  const src = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const exposed = {};
  const invoked = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: (ch, arg) => { invoked.push({ ch, arg }); return Promise.resolve(null); },
      send() {}, on() {}, removeListener() {}, removeAllListeners() {}, once() {}, sendSync: () => null
    },
    webFrame: stub(), webUtils: stub(), clipboard: stub(), nativeImage: stub(), shell: stub()
  };
  const req = (id) => {
    if (id === 'electron') return electron;
    if (id === 'os') return require('os');
    if (id === 'path') return require('path');
    return stub(); // toprow-main.js, net, ...: not under test
  };
  const ctx = vm.createContext({
    require: req, process: { versions: process.versions, platform: 'win32', env: {}, argv: [] },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Buffer, URL, module: {}, exports: {}, __dirname, __filename: path.join(__dirname, 'preload.js'),
    window: stub(), document: stub()
  });
  vm.runInContext(src, ctx, { filename: 'preload.js' });
  return { api: exposed.api, invoked };
}
{
  let P = null, err = null;
  try { P = bootPreload(); } catch (e) { err = e; }
  ok('preload.js loads in the sandbox', !!(P && P.api && P.api.pty), err && String(err.stack || err).slice(0, 300));
  if (P && P.api && P.api.pty) {
    const last = () => P.invoked[P.invoked.length - 1].arg;
    const has = () => (last().args || []).indexOf(SKIP) !== -1;
    P.api.pty.start({ program: 'claude', args: [] });
    ok('preload: default (before any setPrefs) -> no flag', !has(), last());
    P.api.pty.setPrefs({});
    P.api.pty.start({ program: 'claude' });
    ok('preload: setPrefs without the key -> no flag', !has(), last());
    P.api.pty.setPrefs({ skipPermissions: true });
    P.api.pty.start({ program: 'claude', args: ['--continue'] });
    ok('preload: true -> flag prepended', (last().args || []).join(' ') === SKIP + ' --continue', last());
    P.api.pty.start({ program: 'powershell' });
    ok('preload: true, not claude -> no flag', !has(), last());
    P.api.pty.setPrefs({ skipPermissions: false });
    P.api.pty.start({ program: 'claude' });
    ok('preload: false -> no flag', !has(), last());
    P.api.pty.setPrefs({ skipPermissions: 'yes' });
    P.api.pty.start({ program: 'claude' });
    ok('preload: non-boolean -> no flag', !has(), last());
  }
}

console.log('claudeskip: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
