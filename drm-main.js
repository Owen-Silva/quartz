'use strict';
/*
 * drm-main.js -- the MAIN-process half of "this video needs DRM Quartz does
 * not have; open it in Edge". The pieces:
 *
 *   drm-sites.js    which pages need it, and the words (shared, pure)
 *   drm-preload.js  a session preload in every frame: reports what a page did
 *                   with EME (a refused Widevine request, encrypted media)
 *   drm-main.js     this file: registers that preload, forwards its reports to
 *                   the chrome, launches Microsoft Edge, keeps the "always use
 *                   Edge for <site>" rules in <userData>/drm.json, and says in
 *                   plain words whether Widevine is in this build at all
 *   drm.js          the chrome: the bar over the tab, and what its buttons do
 *
 * Nothing here ever runs Edge with anything but a plain http(s) URL, as one
 * argument. A TEST profile can swap the launch for a file (QUARTZ_EDGE_STUB,
 * passed in by main.js only with --test-profile): the e2e reads the file and
 * Edge never starts.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const DrmSites = require('./drm-sites');

const PRELOAD_FILE = path.join(__dirname, 'drm-preload.js');
const STORE_FILE = 'drm.json';
const MAX_RULES = 200;
const LAUNCH_TIMEOUT_MS = 5000;

/**
 * @param {Object} o
 * @param {Object} o.app             electron app (userData)
 * @param {Object} o.ipcMain
 * @param {Object} [o.session]       electron session (the preload goes on defaultSession)
 * @param {Object} [o.shell]         electron shell (the microsoft-edge: fallback)
 * @param {Function} o.isChromeSender
 * @param {Function} o.send          (channel, payload) to the chrome
 * @param {string} [o.edgeStub]      TEST ONLY: append URLs here instead of launching Edge
 * @param {Array}  [o.extraSites]    TEST ONLY: more rows for siteForUrl()
 * @param {Object} [o.env]           process.env (tests pass their own)
 * @param {Function} [o.spawn]       child_process.spawn (tests pass their own)
 * @param {Function} [o.exists]      fs.existsSync (tests pass their own)
 * @param {Object} [o.electron]      the electron module, for the castlabs `components` API
 * @param {Function} [o.onChange]    called whenever state() may have changed (Watch re-labels)
 * @param {string} [o.cdmOverride]   TEST ONLY: 'missing' = report no Widevine; 'ready' = report it installed
 *                                  (a fresh test profile has no CDM, and must not download one)
 * @param {string} [o.vmpOverride]   TEST ONLY: 'signed' | 'development' | 'unsigned' | 'stale'
 * @param {string} [o.execPath]      process.execPath (tests pass their own)
 * @param {Function} [o.statSync]    fs.statSync (tests pass their own)
 * @param {Function} [o.readFile]    (path) => text (tests pass their own)
 */
function create(o) {
  const opts = o || {};
  const env = opts.env || process.env;
  const spawn = opts.spawn || cp.spawn;
  const exists = opts.exists || ((p) => { try { return fs.existsSync(p); } catch (err) { return false; } });
  const extraSites = Array.isArray(opts.extraSites) ? opts.extraSites : [];
  let prefs = null;          // { alwaysEdge: string[] }
  let preloadId = '';
  let preloadTrouble = '';   // why the preload could not be added, '' when it was
  let hookTrouble = '';      // a page said the EME hook could not be installed
  let lastLaunch = null;     // { ok, how, reason, at } for Settings
  let cdmTrouble = '';       // components.whenReady() failed, and why

  // ---- the "always use Edge" rules ----------------------------------------

  function storePath() {
    try { return path.join(opts.app.getPath('userData'), STORE_FILE); } catch (err) { return ''; }
  }

  function load() {
    if (prefs) return prefs;
    prefs = { alwaysEdge: [] };
    const file = storePath();
    if (!file) return prefs;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = raw && Array.isArray(raw.alwaysEdge) ? raw.alwaysEdge : [];
      prefs.alwaysEdge = list.filter((k) => DrmSites.isRuleKey(k, extraSites)).slice(0, MAX_RULES);
    } catch (err) { /* first run, or a damaged file: no rules */ }
    return prefs;
  }

  /** Writes the rules. Returns '' or the reason it failed. */
  function save() {
    const file = storePath();
    if (!file) return 'Quartz could not find its settings folder';
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ alwaysEdge: prefs.alwaysEdge }, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return '';
    } catch (err) {
      return 'the settings file could not be written (' + (err.code || err.message) + ')';
    }
  }

  function setAlways(key, on) {
    load();
    if (!DrmSites.isRuleKey(key, extraSites)) return { ok: false, reason: 'that site key is not one Quartz knows', state: state() };
    const had = prefs.alwaysEdge.indexOf(key) !== -1;
    if (on && !had) {
      if (prefs.alwaysEdge.length >= MAX_RULES) return { ok: false, reason: 'there are already ' + MAX_RULES + ' sites on the list', state: state() };
      prefs.alwaysEdge.push(key);
    } else if (!on && had) {
      prefs.alwaysEdge = prefs.alwaysEdge.filter((k) => k !== key);
    } else {
      return { ok: true, reason: '', state: state() };
    }
    const why = save();
    if (why) {
      // Put memory back the way the file still is: the bar must not claim a
      // rule that will be gone on the next start.
      if (on) prefs.alwaysEdge = prefs.alwaysEdge.filter((k) => k !== key);
      else prefs.alwaysEdge.push(key);
      return { ok: false, reason: why, state: state() };
    }
    push();
    return { ok: true, reason: '', state: state() };
  }

  // ---- Widevine in this build? -------------------------------------------

  /*
   * Stock Electron has no Widevine CDM and no `components` API. A castlabs
   * ECS build has both; there the CDM is a component that is downloaded and
   * reports its status. Anything we cannot read counts as "not available",
   * with the reason, so the bar still shows rather than promising playback.
   */
  function cdm() {
    const electron = opts.electron || null;
    const components = electron && electron.components;
    if (opts.cdmOverride === 'missing') {
      return { available: false, reason: 'Widevine is switched off for this test run.', short: 'Widevine is switched off for this test run' };
    }
    if (opts.cdmOverride === 'ready') {
      return { available: true, reason: 'Widevine is reported installed for this test run (no CDM was downloaded).', short: '' };
    }
    if (!components || typeof components.status !== 'function') {
      return { available: false, reason: 'This Electron build has no Widevine module (stock Electron never ships one).', short: 'this build of Quartz has no Widevine' };
    }
    if (cdmTrouble) return { available: false, reason: 'Widevine could not be installed: ' + cdmTrouble, short: 'Widevine didn’t load (' + cdmTrouble.slice(0, 80) + ')' };
    try {
      const all = components.status() || {};
      for (const id of Object.keys(all)) {
        const c = all[id] || {};
        if (/widevine/i.test(String(c.title || id))) {
          const st = String(c.status || '');
          // 'not-installed' contains "installed": anything saying not/error/fail is NOT ready.
          const bad = /not|error|fail|downloading|checking|updating/i.test(st);
          const ok = !bad && (/^(updated|up-to-date|installed|ready|new)$/i.test(st) || /installed|updated/i.test(st));
          const waiting = /not|downloading|checking|updating/i.test(st) && !/error|fail/i.test(st);
          return ok
            ? { available: true, reason: 'Widevine ' + (c.version || '') + ' is installed (' + st + ').', short: '' }
            : { available: false, reason: 'The Widevine module is ' + (st || 'not ready') + '.', short: waiting ? 'Widevine hasn’t finished downloading yet' : 'Widevine is ' + (st || 'not ready') };
        }
      }
      return { available: false, reason: 'This build can load Widevine, but it has not been downloaded.', short: 'Widevine hasn’t downloaded yet' };
    } catch (err) {
      return { available: false, reason: 'Widevine status could not be read: ' + err.message, short: 'Widevine’s status couldn’t be read' };
    }
  }

  // ---- the streaming signature (VMP) ---------------------------------------

  /*
   * A castlabs build plays Widevine with castlabs' DEVELOPMENT signature, which
   * test streams accept and real services (Disney+, Prime Video, Netflix) refuse.
   * They need a production VMP signature from castlabs EVS, made for the exe that
   * actually runs: Quartz.exe, after rcedit. tools/drm-swap.ps1 makes it and, once
   * EVS verified it, writes node_modules/electron/quartz-vmp.json with the exe's and
   * the .sig's size and time. An Electron reinstall deletes that folder, and a
   * Quartz.exe rebuild changes the exe, so both show here as "sign it again".
   * Read once per run: the swap never runs while Quartz does.
   */
  const VMP_MARKER = 'quartz-vmp.json';
  let vmpCache = null;
  function vmp() {
    if (opts.vmpOverride) return vmpWords(opts.vmpOverride, 'Quartz.exe', '');
    if (vmpCache) return vmpCache;
    const execPath = opts.execPath || process.execPath;
    const exe = path.basename(execPath);
    const statOf = opts.statSync || ((p) => fs.statSync(p));
    const readText = opts.readFile || ((p) => fs.readFileSync(p, 'utf8'));
    const sigPath = execPath + '.sig';
    let state = 'unsigned';
    let when = '';
    try {
      const sig = statOf(sigPath);
      const self = statOf(execPath);
      let marker = null;
      try { marker = JSON.parse(readText(path.join(path.dirname(execPath), '..', VMP_MARKER))); } catch (err) { marker = null; }
      if (!marker || typeof marker !== 'object' || String(marker.exe || '').toLowerCase() !== exe.toLowerCase()) {
        state = 'development';
      } else {
        const same = (a, b) => Math.abs(Number(a) - Number(b)) < 2000;
        const fresh = Number(marker.exeSize) === self.size && same(marker.exeMtimeMs, self.mtimeMs) &&
          Number(marker.sigSize) === sig.size && same(marker.sigMtimeMs, sig.mtimeMs);
        state = fresh ? 'signed' : 'stale';
        when = typeof marker.signedAt === 'string' ? marker.signedAt.slice(0, 10) : '';
      }
    } catch (err) {
      state = 'unsigned';
    }
    vmpCache = vmpWords(state, exe, when);
    return vmpCache;
  }

  function vmpWords(state, exe, when) {
    if (state === 'signed') return { state, reason: 'Signed for streaming services (castlabs EVS' + (when ? ', ' + when : '') + ').', short: '' };
    if (state === 'stale') return { state, reason: exe + ' changed after it was signed for streaming (an Electron update or a rebuild), so services will refuse to play. Sign it again: tools\\drm-swap.ps1 -ResignOnly.', short: exe + ' changed after it was signed for streaming' };
    if (state === 'development') return { state, reason: 'Only castlabs’ development signature is here: test streams play, but Disney+, Prime Video and Netflix refuse it. tools\\drm-swap.ps1 signs Quartz with your castlabs EVS account.', short: 'this copy of Quartz isn’t signed for streaming services yet' };
    return { state: 'unsigned', reason: exe + ' has no streaming signature (' + exe + '.sig is missing), so services will refuse to play. tools\\drm-swap.ps1 signs it with your castlabs EVS account.', short: 'this copy of Quartz isn’t signed for streaming services yet' };
  }

  /*
   * What the bars, Watch and Settings go by:
   *   available  the Widevine CDM is installed (a test stream can play)
   *   services   AND the build is signed for real services (Disney+, Prime ...)
   *   reason     the whole story, for Settings
   *   short      why services cannot play, for a bar or a toast ('' when they can)
   */
  function widevine() {
    const c = cdm();
    if (!c.available) return { available: false, services: false, reason: c.reason, short: c.short, vmp: null };
    const v = vmp();
    const services = v.state === 'signed';
    return { available: true, services, reason: c.reason + ' ' + v.reason, short: services ? '' : v.short, vmp: v.state };
  }

  /*
   * Where a click on a protected-video page should go, for Watch:
   * { edge, rule, reason }. Edge when the person chose "Always use Edge" for the
   * site, or when services cannot play here (reason = why); Quartz otherwise.
   */
  function route(url) {
    load();
    const key = DrmSites.ruleKeyFor(url, extraSites);
    if (key && prefs.alwaysEdge.indexOf(key) !== -1) {
      return { edge: true, rule: key, reason: 'you chose to always watch ' + DrmSites.ruleKeyName(key, extraSites) + ' in Edge' };
    }
    const wv = widevine();
    if (!wv.services) return { edge: true, rule: '', reason: wv.short || 'Quartz can’t play protected video here' };
    return { edge: false, rule: '', reason: '' };
  }

  /*
   * castlabs ECS only (stock Electron: returns at once). Waits for the
   * Widevine CDM component before the first window, as castlabs requires, but
   * never longer than `ms`: a first run offline must still open Quartz. If the
   * CDM lands later, the chrome hears drm:changed and the bars go away.
   */
  async function whenCdmReady(ms) {
    const electron = opts.electron || null;
    const components = electron && electron.components;
    if (!components || typeof components.whenReady !== 'function' || opts.cdmOverride) return widevine();
    let timer = null;
    const ready = Promise.resolve()
      .then(() => components.whenReady())
      .then(() => { cdmTrouble = ''; return 'ready'; },
        (err) => { cdmTrouble = String((err && err.message) || err || 'no reason given').slice(0, 300); return 'failed'; });
    const outcome = await Promise.race([ready, new Promise((r) => { timer = setTimeout(() => r('timeout'), ms || 4000); })]);
    clearTimeout(timer);
    if (outcome === 'timeout') ready.then(() => push());
    return widevine();
  }

  // ---- Microsoft Edge -----------------------------------------------------

  function edgeCandidates() {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA].filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const r of roots) {
      const p = path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
      if (!seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); out.push(p); }
    }
    return out;
  }

  /** Where Edge is: { found, path, how: 'msedge' | 'protocol' | 'stub' }. */
  function edge() {
    if (opts.edgeStub) return { found: true, path: opts.edgeStub, how: 'stub' };
    for (const p of edgeCandidates()) if (exists(p)) return { found: true, path: p, how: 'msedge' };
    // No msedge.exe where Windows puts it. Windows 10/11 still registers the
    // microsoft-edge: protocol, which shell.openExternal can use.
    return { found: false, path: '', how: opts.shell ? 'protocol' : '' };
  }

  function record(result) {
    lastLaunch = Object.assign({ at: Date.now() }, result);
    return result;
  }

  /** Opens one URL in Edge. Resolves { ok, how, reason }; never rejects. */
  function openInEdge(url) {
    if (!DrmSites.edgeUrlOk(url)) {
      return Promise.resolve(record({ ok: false, how: '', reason: 'only web pages (http or https) can be sent to Edge' }));
    }
    const href = new URL(url).href; // normalised: always starts with http
    const where = edge();
    if (where.how === 'stub') {
      try {
        if (fs.existsSync(where.path + '.fail')) return Promise.resolve(record({ ok: false, how: 'stub', reason: 'Edge did not start (test failure)' }));
        fs.appendFileSync(where.path, href + '\n', 'utf8');
        return Promise.resolve(record({ ok: true, how: 'stub', reason: '' }));
      } catch (err) {
        return Promise.resolve(record({ ok: false, how: 'stub', reason: err.message }));
      }
    }
    if (where.how === 'msedge') {
      return new Promise((resolve) => {
        let done = false;
        const finish = (r) => { if (!done) { done = true; resolve(record(r)); } };
        let child;
        try {
          child = spawn(where.path, [href], { detached: true, stdio: 'ignore', windowsHide: false });
        } catch (err) {
          finish({ ok: false, how: 'msedge', reason: 'Edge could not be started (' + (err.code || err.message) + ')' });
          return;
        }
        child.once('error', (err) => finish({ ok: false, how: 'msedge', reason: 'Edge could not be started (' + (err.code || err.message) + ')' }));
        child.once('spawn', () => { try { child.unref(); } catch (err) { /* fine */ } finish({ ok: true, how: 'msedge', reason: '' }); });
        setTimeout(() => finish({ ok: false, how: 'msedge', reason: 'Edge did not start within ' + (LAUNCH_TIMEOUT_MS / 1000) + ' seconds' }), LAUNCH_TIMEOUT_MS).unref?.();
      });
    }
    if (where.how === 'protocol') {
      return Promise.resolve()
        .then(() => opts.shell.openExternal('microsoft-edge:' + href))
        .then(() => record({ ok: true, how: 'protocol', reason: '' }),
          (err) => record({ ok: false, how: 'protocol', reason: 'Microsoft Edge was not found on this PC (' + (err && err.message || 'no handler') + ')' }));
    }
    return Promise.resolve(record({ ok: false, how: '', reason: 'Microsoft Edge was not found on this PC' }));
  }

  // ---- state for the chrome and Settings ----------------------------------

  function state() {
    load();
    const wv = widevine();
    const where = edge();
    let detection = 'Pages that need DRM are spotted by address and by what their video does.';
    if (preloadTrouble) detection = 'Only the big streaming sites are spotted, by address: ' + preloadTrouble;
    else if (hookTrouble) detection = 'Only the big streaming sites are spotted, by address: the page watcher could not start (' + hookTrouble + ').';
    return {
      widevine: wv,
      edge: { found: where.found, how: where.how, path: where.how === 'stub' ? '' : where.path },
      alwaysEdge: prefs.alwaysEdge.map((key) => ({ key, name: DrmSites.ruleKeyName(key, extraSites) })),
      detection,
      extraSites,
      lastLaunch,
    };
  }

  function push() {
    try { opts.send('drm:changed', state()); } catch (err) { /* no window yet */ }
    // Watch labels its tiles "Opens in Edge" by the same state.
    if (typeof opts.onChange === 'function') { try { opts.onChange(); } catch (err) { /* listener gone */ } }
  }

  // ---- startup and IPC ----------------------------------------------------

  function start() {
    const s = opts.session && opts.session.defaultSession;
    if (!s) { preloadTrouble = 'the browser session was not ready.'; return; }
    if (typeof s.registerPreloadScript !== 'function') {
      preloadTrouble = 'this Electron cannot add a page watcher (no session preload support).';
      return;
    }
    try {
      preloadId = s.registerPreloadScript({ id: 'quartz-drm', type: 'frame', filePath: PRELOAD_FILE });
    } catch (err) {
      preloadTrouble = 'the page watcher could not be added (' + err.message + ').';
    }
  }

  const ipc = opts.ipcMain;
  if (ipc) {
    // From any frame of any guest: what the page did. Checked, then passed on
    // with the guest's webContents id, which is how the chrome finds the tab.
    ipc.on('drm:eme', (event, payload) => {
      if (!event || !event.sender || opts.isChromeSender(event)) return;
      const p = payload || {};
      let msg = null;
      if (p.kind === 'request' && DrmSites.isProtectedKeySystem(p.keySystem)) {
        msg = { kind: 'request', keySystem: p.keySystem, granted: p.granted === true };
      } else if (p.kind === 'encrypted') {
        msg = { kind: 'encrypted', initDataType: typeof p.initDataType === 'string' ? p.initDataType.slice(0, 20) : '' };
      } else if (p.kind === 'licence' && DrmSites.isLicenceOutcome(p.outcome)) {
        // A Widevine build: the key system was granted, but the service never
        // gave this page a working licence (refused, or a key it cannot use).
        msg = { kind: 'licence', outcome: p.outcome, detail: typeof p.detail === 'string' ? p.detail.replace(/[^\x20-\x7e]/g, '').slice(0, 80) : '' };
      }
      if (!msg) return;
      msg.wcId = event.sender.id;
      try { msg.url = String(event.sender.getURL() || '').slice(0, 2048); } catch (err) { msg.url = ''; }
      try { opts.send('drm:signal', msg); } catch (err) { /* no window */ }
    });
    ipc.on('drm:hook', (event, payload) => {
      if (!event || !event.sender || opts.isChromeSender(event)) return;
      const why = payload && typeof payload.result === 'string' ? payload.result.slice(0, 40) : 'unknown';
      if (hookTrouble) return;
      hookTrouble = why;
      push();
    });

    ipc.handle('drm:state', (event) => (opts.isChromeSender(event) ? state() : null));
    ipc.handle('drm:open-in-edge', (event, arg) => {
      if (!opts.isChromeSender(event)) return { ok: false, how: '', reason: 'refused' };
      return openInEdge(arg && typeof arg.url === 'string' ? arg.url : '');
    });
    ipc.handle('drm:set-always', (event, arg) => {
      if (!opts.isChromeSender(event)) return { ok: false, reason: 'refused', state: null };
      return setAlways(arg && arg.key, !!(arg && arg.on));
    });
  }

  return { start, state, openInEdge, setAlways, edge, widevine, route, vmp, whenCdmReady, _preloadId: () => preloadId };
}

/*
 * TEST ONLY: the CDM / signature overrides a test run may ask for (QUARTZ_TEST_CDM=missing|ready,
 * QUARTZ_TEST_VMP=signed|development|unsigned|stale). Both are '' unless Quartz runs with
 * --test-profile, so a live Quartz always routes by its real Widevine and its real signature.
 */
function testOverrides(argv, env) {
  const t = Array.isArray(argv) && argv.includes('--test-profile');
  const e = env || {};
  return {
    cdmOverride: t && /^(missing|ready)$/.test(e.QUARTZ_TEST_CDM || '') ? e.QUARTZ_TEST_CDM : '',
    vmpOverride: t && /^(signed|development|unsigned|stale)$/.test(e.QUARTZ_TEST_VMP || '') ? e.QUARTZ_TEST_VMP : '',
  };
}

module.exports = { create, PRELOAD_FILE, testOverrides };
