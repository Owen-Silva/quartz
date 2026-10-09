'use strict';

/*
 * Autocorrect and spelling -- the MAIN-process half.
 *
 * The user: "quartz needs to have auto correct", both kinds, "preferably literally
 * everywhere". The typing engine is spell-preload.js. This module:
 *
 *   - registers it as a SESSION preload (session.registerPreloadScript, type
 *     'frame'). That is the one mechanism that reaches every frame of every
 *     guest AND the chrome's own document, without going near
 *     will-attach-webview -- which strips any preload a page asks for and must
 *     keep doing so. Ghostery's cosmetic filter rides the same mechanism. A
 *     session preload runs in the ISOLATED world, so the page never sees the
 *     engine, its config or its ipcRenderer.
 *   - answers "is this word misspelled, and what should it be" by asking the
 *     WINDOWS spellchecker through spellhost.exe (see below).
 *   - owns the preferences (spell.json in userData, same lazy best-effort style
 *     as adblock.json) and the personal dictionary, and pushes every change to
 *     every frame live ('spell:config') and to Settings ('spell:changed').
 *
 * Why a helper process. On Windows, Chromium spellchecks with the Windows
 * spellchecker from the BROWSER process; the renderer holds no dictionary, so
 * the only word APIs a page-side script has (webFrame.isWordMisspelled /
 * getWordSuggestions) answer "fine" and "[]" for every word. Measured
 * 2026-10-09 on a test copy: 'teh', 'becuase', 'dont' all came back clean
 * while the right-click menu still flagged them. The old switch back to
 * Hunspell (WinUseBrowserSpellChecker) is gone from this Chromium: disabling
 * it changed nothing. So we ask the same Windows engine ourselves, through its
 * COM interface (ISpellChecker), from a 7 KB console program compiled once
 * from spellhost.cs by the C# compiler that ships with Windows PowerShell. Its
 * verdicts match the red underline exactly, because it IS the same checker.
 * It starts the first time a word needs checking and exits after ten idle
 * minutes, so a browser nobody types in carries nothing.
 *
 * The page right-click menu items (suggestions, Add to dictionary, Ignore,
 * Off on this site) live in main.js's guestMenuTemplate; they call the
 * functions exported here so the menu and Settings can never disagree.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const PRELOAD_FILE = path.join(__dirname, 'spell-preload.js');
const HOST_SOURCE = path.join(__dirname, 'spellhost.cs');

/** Words longer than this are not words; a dictionary entry is never a paste. */
const MAX_WORD = 64;
/** A personal dictionary is a list a person maintains, not a corpus. */
const MAX_WORDS = 2000;
const MAX_SITES = 500;
/** The helper goes away after this long without a question. */
const HOST_IDLE_MS = 10 * 60 * 1000;
/** One answer's budget. A first start (compile + COM) is allowed longer. */
const CHECK_TIMEOUT_MS = 1500;
const START_TIMEOUT_MS = 20000;
const CACHE_MAX = 5000;

function create({ app, ipcMain, session, webContents, isChromeSender, send, normaliseHost }) {
  let prefs = { autocorrect: true, underline: true, sitesOff: [], words: [] };
  let loaded = false;
  let saveTimer = null;
  let preloadId = null;

  function prefsPath() {
    return path.join(app.getPath('userData'), 'spell.json');
  }

  function cleanWord(value) {
    if (typeof value !== 'string') return '';
    const w = value.trim();
    if (!w || w.length > MAX_WORD || /\s/.test(w)) return '';
    return w;
  }

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(prefsPath(), 'utf8'));
      if (raw && typeof raw === 'object') {
        if (typeof raw.autocorrect === 'boolean') prefs.autocorrect = raw.autocorrect;
        if (typeof raw.underline === 'boolean') prefs.underline = raw.underline;
        if (Array.isArray(raw.sitesOff)) {
          prefs.sitesOff = Array.from(new Set(raw.sitesOff.map(normaliseHost).filter(Boolean))).slice(0, MAX_SITES);
        }
        if (Array.isArray(raw.words)) {
          prefs.words = Array.from(new Set(raw.words.map(cleanWord).filter(Boolean))).slice(0, MAX_WORDS);
        }
      }
    } catch (err) {
      // No file is the normal first run; a corrupt one falls back to defaults
      // (autocorrect on, underlines on) rather than taking typing down.
      if (err && err.code !== 'ENOENT') console.warn('[spell] spell.json unreadable, using defaults:', err.message);
    }
  }

  // Written on the next tick and atomically (tmp + rename): a word added from
  // the menu must survive a quit that follows a second later. before-quit
  // calls flush() for the tick in between.
  function queueSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, 50);
  }

  function saveNow() {
    try {
      const file = prefsPath();
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('[spell] could not save spell.json:', err.message);
    }
  }

  function sess() {
    return session && session.defaultSession;
  }

  // ---- the Windows spellchecker helper -------------------------------------

  // state: 'idle' (not needed yet) | 'starting' | 'ready' | 'failed'
  const host = { state: 'idle', reason: '', proc: null, buf: '', seq: 0, pending: new Map(), idleTimer: null, startWaiters: [] };
  const cache = new Map(); // word -> answer

  function hostExePath() {
    let tag = 'x';
    try { tag = crypto.createHash('sha1').update(fs.readFileSync(HOST_SOURCE)).digest('hex').slice(0, 10); } catch (err) { /* compile will fail and say why */ }
    return path.join(app.getPath('userData'), 'spellhost-' + tag + '.exe');
  }

  /** Compile spellhost.cs once per source version. Resolves the exe path. */
  function compileHost(exe) {
    return new Promise((resolve, reject) => {
      if (fs.existsSync(exe)) return resolve(exe);
      const ps = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:QS_SRC)) -OutputAssembly $env:QS_EXE -OutputType ConsoleApplication";
      const child = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: Object.assign({}, process.env, { QS_SRC: HOST_SOURCE, QS_EXE: exe }),
      });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => reject(new Error('PowerShell could not start: ' + e.message)));
      child.on('exit', (code) => {
        if (code === 0 && fs.existsSync(exe)) resolve(exe);
        else reject(new Error('the spelling helper did not compile (' + (err.trim().split('\n')[0] || 'exit ' + code) + ')'));
      });
    });
  }

  function failHost(reason) {
    host.state = 'failed';
    host.reason = reason;
    console.warn('[spell] Windows spellchecker unavailable:', reason);
    for (const w of host.startWaiters.splice(0)) w(false);
    for (const p of host.pending.values()) p.resolve(null);
    host.pending.clear();
    send('spell:changed', state());
  }

  function ensureHost() {
    if (host.state === 'ready') return Promise.resolve(true);
    if (host.state === 'failed') return Promise.resolve(false);
    const waiter = new Promise((resolve) => host.startWaiters.push(resolve));
    if (host.state === 'starting') return waiter;
    host.state = 'starting';
    const timer = setTimeout(() => { if (host.state === 'starting') failHost('the spelling helper took too long to start'); }, START_TIMEOUT_MS);
    compileHost(hostExePath()).then((exe) => {
      const proc = cp.spawn(exe, ['en-US'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      host.proc = proc;
      host.buf = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => onHostData(chunk));
      proc.on('error', (e) => { clearTimeout(timer); failHost('the spelling helper could not run: ' + e.message); });
      proc.on('exit', () => {
        host.proc = null;
        // An idle exit (or a crash) returns to 'idle': the next word starts
        // it again. Only a helper that never said "ready" is a failure.
        if (host.state === 'ready') {
          host.state = 'idle';
          for (const p of host.pending.values()) p.resolve(null);
          host.pending.clear();
        } else if (host.state === 'starting') {
          clearTimeout(timer);
          failHost(host.reason || 'the spelling helper exited before it was ready');
        }
      });
      proc.stdin.on('error', () => { /* exit handler covers it */ });
      host.onReady = () => {
        clearTimeout(timer);
        host.state = 'ready';
        host.reason = '';
        for (const w of host.startWaiters.splice(0)) w(true);
        send('spell:changed', state());
      };
    }, (err) => { clearTimeout(timer); failHost(err.message); });
    return waiter;
  }

  function onHostData(chunk) {
    host.buf += chunk;
    let nl;
    while ((nl = host.buf.indexOf('\n')) >= 0) {
      const line = host.buf.slice(0, nl).replace(/\r$/, '');
      host.buf = host.buf.slice(nl + 1);
      const parts = line.split('\t');
      if (parts[0] === 'ready') { if (host.onReady) host.onReady(); continue; }
      if (parts[0] === 'error') { host.reason = 'Windows says: ' + (parts[1] || 'no spellchecker'); continue; }
      const p = host.pending.get(parts[0]);
      if (!p) continue;
      host.pending.delete(parts[0]);
      clearTimeout(p.timer);
      if (parts[1] !== '0' && parts[1] !== '1') { p.resolve(null); continue; }
      p.resolve({
        misspelled: parts[1] === '1',
        action: parts[2] || 'none',
        replacement: parts[3] || '',
        suggestions: parts[4] ? parts[4].split('|').filter(Boolean) : [],
      });
    }
  }

  function armIdle() {
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.idleTimer = setTimeout(() => {
      host.idleTimer = null;
      if (host.proc && !host.pending.size) {
        try { host.proc.stdin.end(); } catch (err) { /* already gone */ }
      }
    }, HOST_IDLE_MS);
  }

  /** { misspelled, action, replacement, suggestions } or null if unknown. */
  async function checkWord(word) {
    if (cache.has(word)) return cache.get(word);
    if (!(await ensureHost()) || !host.proc) return null;
    armIdle();
    const id = String(++host.seq);
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => { host.pending.delete(id); resolve(null); }, CHECK_TIMEOUT_MS);
      host.pending.set(id, { resolve, timer });
      try { host.proc.stdin.write(id + '\t' + word + '\n'); } catch (err) { clearTimeout(timer); host.pending.delete(id); resolve(null); }
    });
    if (answer) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(word, answer);
    }
    return answer;
  }

  function stopHost() {
    if (host.idleTimer) { clearTimeout(host.idleTimer); host.idleTimer = null; }
    if (host.proc) { try { host.proc.kill(); } catch (err) { /* gone */ } host.proc = null; }
  }

  // ---- state ----------------------------------------------------------------

  /** Why autocorrect cannot work, in words Settings can show; '' when it can. */
  function unavailableReason() {
    const s = sess();
    if (!s) return 'The browser session is not ready yet.';
    if (typeof s.registerPreloadScript !== 'function') {
      return 'This Electron build cannot add the typing helper to pages (no session preload support).';
    }
    if (!preloadId) return 'The typing helper could not be added to pages; see the log.';
    if (host.state === 'failed') return 'The Windows spellchecker could not be reached: ' + host.reason;
    return '';
  }

  function languages() {
    const s = sess();
    try { return s && typeof s.getSpellCheckerLanguages === 'function' ? s.getSpellCheckerLanguages() : []; }
    catch (err) { return []; }
  }

  function state() {
    load();
    const reason = unavailableReason();
    return {
      autocorrect: prefs.autocorrect,
      underline: prefs.underline,
      sitesOff: prefs.sitesOff.slice().sort(),
      words: prefs.words.slice().sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      available: !reason,
      reason,
      languages: languages(),
      checker: host.state,
    };
  }

  /** What every frame's engine needs, and nothing else. */
  function engineConfig() {
    load();
    return {
      autocorrect: prefs.autocorrect,
      underline: prefs.underline,
      sitesOff: prefs.sitesOff.slice(),
      words: prefs.words.map((w) => w.toLowerCase()),
    };
  }

  /**
   * Every frame of every webContents. webContents.send() only reaches the MAIN
   * frame, and an editor inside an iframe (a comment widget, an embedded form)
   * runs its own copy of the engine that must hear about changes too.
   */
  function eachFrame(fn) {
    let all = [];
    try { all = webContents.getAllWebContents(); } catch (err) { return; }
    for (const wc of all) {
      try {
        if (wc.isDestroyed() || !wc.mainFrame) continue;
        for (const frame of wc.mainFrame.framesInSubtree) {
          try { fn(frame); } catch (err) { /* a frame going away */ }
        }
      } catch (err) { /* a closing tab */ }
    }
  }

  // Underlines off is applied BY THE ENGINE in each frame (webFrame.insertCSS,
  // user origin, on the ::spelling-error highlight), not by switching the
  // session spellchecker off: that would also take the right-click
  // suggestions away, and the two switches are meant to be separate.
  function broadcast() {
    const cfg = engineConfig();
    eachFrame((frame) => frame.send('spell:config', cfg));
    send('spell:changed', state());
  }

  // ---- mutations (Settings and the page menu both land here) --------------

  function setPrefs(patch) {
    load();
    if (patch && typeof patch.autocorrect === 'boolean') prefs.autocorrect = patch.autocorrect;
    if (patch && typeof patch.underline === 'boolean') prefs.underline = patch.underline;
    queueSave();
    broadcast();
    return state();
  }

  function setSiteOff(siteHost, off) {
    load();
    const h = normaliseHost(siteHost);
    if (!h) return state();
    const set = new Set(prefs.sitesOff);
    if (off) set.add(h); else set.delete(h);
    prefs.sitesOff = Array.from(set).slice(0, MAX_SITES);
    queueSave();
    broadcast();
    return state();
  }

  function isSiteOff(siteHost) {
    load();
    const h = normaliseHost(siteHost);
    return !!h && prefs.sitesOff.includes(h);
  }

  function addWord(word) {
    load();
    const w = cleanWord(word);
    if (!w) return state();
    if (!prefs.words.some((x) => x.toLowerCase() === w.toLowerCase())) {
      prefs.words.push(w);
      if (prefs.words.length > MAX_WORDS) prefs.words.shift();
    }
    // Chromium's own dictionary too, so the squiggle and the menu agree.
    try { sess().addWordToSpellCheckerDictionary(w); } catch (err) { /* engine still honours prefs.words */ }
    queueSave();
    broadcast();
    return state();
  }

  function removeWord(word) {
    load();
    const w = cleanWord(word);
    if (!w) return state();
    prefs.words = prefs.words.filter((x) => x.toLowerCase() !== w.toLowerCase());
    try { sess().removeWordFromSpellCheckerDictionary(w); } catch (err) { /* nothing to undo */ }
    queueSave();
    broadcast();
    return state();
  }

  // ---- wiring --------------------------------------------------------------

  function start() {
    load();
    const s = sess();
    if (!s) return;
    try {
      // Spellcheck is on by default; say so explicitly, because the underline
      // and the menu are blind without it and a stray flag would be silent.
      if (typeof s.setSpellCheckerEnabled === 'function') s.setSpellCheckerEnabled(true);
    } catch (err) {
      console.warn('[spell] could not enable the spellchecker:', err.message);
    }
    // Our list is the source of truth (it is written the moment a word is
    // added); Chromium's own custom dictionary is brought in line with it.
    for (const w of prefs.words) {
      try { s.addWordToSpellCheckerDictionary(w); } catch (err) { break; }
    }
    // Anything in Chromium's list that is not in ours is a word "Ignore"d last
    // run (or one removed while the session was busy): taken back out.
    if (typeof s.listWordsInSpellCheckerDictionary === 'function') {
      const keep = new Set(prefs.words.map((w) => w.toLowerCase()));
      s.listWordsInSpellCheckerDictionary().then((list) => {
        for (const w of list || []) {
          if (keep.has(String(w).toLowerCase())) continue;
          try { s.removeWordFromSpellCheckerDictionary(w); } catch (err) { /* best effort */ }
        }
      }, () => {});
    }
    if (typeof s.registerPreloadScript === 'function') {
      try {
        preloadId = s.registerPreloadScript({ id: 'quartz-spell', type: 'frame', filePath: PRELOAD_FILE });
      } catch (err) {
        console.error('[spell] could not register the typing helper:', err.message);
      }
    }
  }

  // Engine side: config on demand, and word checks. Any frame may ask these
  // (that is the point), and neither changes anything.
  ipcMain.handle('spell:config-get', () => engineConfig());
  ipcMain.handle('spell:check', (_event, word) => {
    if (typeof word !== 'string' || !word || word.length > MAX_WORD || !/^[\p{L}']+$/u.test(word)) return null;
    return checkWord(word);
  });

  // Settings side: the chrome only, like every other preference channel.
  const refuse = () => state();
  ipcMain.handle('spell:state', () => {
    // Opening Settings is a fair moment to find out whether Windows will
    // answer, so the section can say so instead of guessing.
    if (host.state === 'idle') ensureHost();
    return state();
  });
  ipcMain.handle('spell:set', (event, patch) => (isChromeSender(event) ? setPrefs(patch || {}) : refuse()));
  ipcMain.handle('spell:site-off', (event, { host: h, off } = {}) => (isChromeSender(event) ? setSiteOff(h, !!off) : refuse()));
  ipcMain.handle('spell:add-word', (event, { word } = {}) => (isChromeSender(event) ? addWord(word) : refuse()));
  ipcMain.handle('spell:remove-word', (event, { word } = {}) => (isChromeSender(event) ? removeWord(word) : refuse()));

  return {
    start,
    state,
    setPrefs,
    setSiteOff,
    isSiteOff,
    addWord,
    removeWord,
    checkWord,
    flush() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveNow(); }
      stopHost();
    },
    /**
     * Ignore from the menu: for this run only. Chromium has no "ignore" of its
     * own, so the word goes into its dictionary (the squiggle goes) but NOT
     * into ours -- and start() takes it back out next launch, because our list
     * is the source of truth.
     */
    ignoreWord(word) {
      const w = cleanWord(word);
      if (!w) return;
      try { sess().addWordToSpellCheckerDictionary(w); } catch (err) { /* engine still ignores it */ }
      const lower = w.toLowerCase();
      eachFrame((frame) => frame.send('spell:ignore', lower));
    },
  };
}

module.exports = { create };
