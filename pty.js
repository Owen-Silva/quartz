'use strict';

// pty.js — tiny PTY session manager.
//
// Owns a Map of id -> session record. Each session is one program from the
// PROGRAMS table below (claude.exe by default) running under a real Windows
// pseudo-console (ConPTY) via node-pty, so the CLI sees a proper TTY and
// renders its full interactive UI.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const nodePty = require('@homebridge/node-pty-prebuilt-multiarch');

// Absolute path to the Claude CLI: where its native installer puts it, under THIS user's home
// (it was pinned to one account's home folder, which broke the pane on any other account or machine).
const CLAUDE_BIN = path.join(os.homedir(), '.local', 'bin', 'claude.exe');

// Fallback cwd when the caller does not supply one (or supplies garbage): this user's home.
const DEFAULT_CWD = os.homedir();

// The ONLY flags a renderer may put on claude.exe's command line. Everything
// else is dropped silently (logged, never spawned): the renderer is the least
// trusted side of this bridge and argv is the one place a string it supplies
// would change how the CLI behaves.
//
// `--continue` resumes that folder's most recent conversation outright (a
// restored Claude pane). `--resume` is NOT on the list any more: it fed the
// "Resume a Claude conversation" picker, which went with Claude tabs, so it
// is dropped like any other token -- and a session id never had a way in.
// `--dangerously-skip-permissions` rides along only when the Settings switch
// "Skip permission prompts" is on (off on a new profile, so Claude asks
// before it runs a tool); the flag still has to be on this list for the
// renderer to be able to ask for it at all. Whatever the switch says, a
// chamber holding web page text never gets it: that is decided below, not by
// the renderer (see "Page-text chambers").
const ALLOWED_ARGS = new Set(['--continue', '--dangerously-skip-permissions']);

// Two ways to say "not a fresh session". Passing both is a CLI error, so the
// first one asked for wins and the other is dropped. Only `--continue` can
// pass the allowlist now; the guard stays so re-allowing `--resume` is safe.
const RESUME_ARGS = new Set(['--continue', '--resume']);

const SKIP_PERMISSIONS_ARG = '--dangerously-skip-permissions';

// ---------------------------------------------------------------------------
// Page-text chambers
//
// "Ask Claude about this page" and "Show Claude this page" put text a web page
// controls (its selection, title, address, a screenshot of it) into a Claude
// session's input. A page can hide instructions in that text, so the session
// that receives it must not be one that runs tools without asking. That is
// decided HERE, on the trusted side of the bridge, not in the renderer:
//
//   - the renderer marks such a spawn with PAGE_TEXT_ARG (a Quartz token, never
//     put on claude.exe's command line), and ALSO names a cwd inside the
//     scratch root below;
//   - any claude spawn that carries the mark OR whose cwd is inside the
//     scratch root is a page-text chamber: `--dangerously-skip-permissions` is
//     removed whatever the Settings switch says (preload.js adds it to every
//     spawn), and the session runs in a scratch folder under the profile, never
//     in the home folder;
//   - the cwd rule is what keeps it that way across an Enter-to-restart and a
//     restored session, which do not all carry the mark.
//
// The scratch folder is <userData>\claude-scratch\ask-<id>. The renderer picks
// the id (so the chip, the session file and a restart all know the folder); a
// cwd that is not exactly one such folder gets a fresh one made here instead.
// If no folder can be made the spawn FAILS, with a reason: falling back to the
// home folder is the one thing this must never do.
// ---------------------------------------------------------------------------
const PAGE_TEXT_ARG = '--quartz-page-text';
const SCRATCH_DIR = 'claude-scratch';
const SCRATCH_NAME = /^ask-[a-z0-9][a-z0-9-]{5,78}$/i;
// Empty scratch folders older than this are tidied away (see pruneScratch).
const SCRATCH_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

let scratchRootOverride = null; // harness seam
let scratchPruned = false;

/**
 * <userData>\claude-scratch, or '' when the profile folder cannot be named.
 * Read at spawn time, not at require time: main.js moves userData for a test
 * profile and for the one-time profile move after this module has loaded.
 */
function scratchRoot() {
  if (scratchRootOverride !== null) return scratchRootOverride;
  let userData = '';
  try {
    // Under plain node (the harness) require('electron') is a path string,
    // not the API, and this answers ''.
    const electron = require('electron');
    if (electron && typeof electron === 'object' && electron.app && typeof electron.app.getPath === 'function') {
      userData = electron.app.getPath('userData');
    }
  } catch {
    userData = '';
  }
  return userData ? path.join(userData, SCRATCH_DIR) : '';
}

function lowerResolved(p) {
  return path.resolve(p).toLowerCase(); // Windows paths compare case-insensitively
}

/** True when `target` is the root itself or anything below it. */
function isUnderRoot(target, root) {
  if (!root || typeof target !== 'string' || !target.trim()) return false;
  let t;
  try { t = lowerResolved(target.trim()); } catch { return false; }
  const r = lowerResolved(root);
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** The cwd when it is exactly <root>\ask-<id>; null for anything else. */
function namedScratchFolder(cwd, root) {
  if (!root || typeof cwd !== 'string' || !cwd.trim()) return null;
  let resolved;
  try { resolved = path.resolve(cwd.trim()); } catch { return null; }
  if (path.dirname(resolved).toLowerCase() !== lowerResolved(root)) return null;
  return SCRATCH_NAME.test(path.basename(resolved)) ? resolved : null;
}

function newScratchName() {
  return 'ask-' + Date.now().toString(36) + '-' + crypto.randomBytes(5).toString('hex');
}

function hasPageTextMark(args) {
  return Array.isArray(args) && args.some((a) => typeof a === 'string' && a.trim() === PAGE_TEXT_ARG);
}

/**
 * Decide, without touching the disk, whether a claude spawn is a page-text
 * chamber and what it then runs with. Pure, so the harness can check every
 * case. Throws when it IS one and there is no scratch root to put it in.
 *
 * @returns {{pageText:false, args:any} |
 *           {pageText:true, args:string[], dir:string, reused:boolean}}
 */
function planPageText(args, cwd, root) {
  const marked = hasPageTextMark(args);
  const named = namedScratchFolder(cwd, root);
  if (!marked && !named && !isUnderRoot(cwd, root)) return { pageText: false, args: args };
  if (!root) {
    throw new Error('no scratch folder for page text (the profile folder is unknown), so the session was not started');
  }
  // The mark is ours and the skip flag is exactly what this chamber may not
  // have; `--continue` stays, so a restored page-text pane resumes its own
  // conversation in its own scratch folder, still asking before it acts.
  const kept = Array.isArray(args)
    ? args.filter((a) => typeof a === 'string' && a.trim() !== PAGE_TEXT_ARG && a.trim() !== SKIP_PERMISSIONS_ARG)
    : [];
  return { pageText: true, args: kept, dir: named || path.join(root, newScratchName()), reused: !!named };
}

/**
 * Make (or find) the scratch folder and prove it is a real folder of its own:
 * a link there could point anywhere, the home folder included.
 * @returns {{dir:string, created:boolean}}
 */
function ensureScratchFolder(dir) {
  let created = false;
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created = true;
    }
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw Object.assign(new Error('not a plain folder'), { code: 'ENOTDIR' });
    }
  } catch (err) {
    const why = (err && (err.code || err.message)) || 'unknown error';
    throw new Error('could not make the scratch folder for page text (' + why + '), so the session was not started');
  }
  return { dir, created };
}

/**
 * Best-effort, once per run, after a new folder is made: remove EMPTY
 * ask-* folders untouched for a week. rmdirSync refuses a folder with
 * anything in it, so whatever a session wrote there is never deleted, and a
 * folder a live session is using is skipped by name.
 */
function pruneScratch(root, keep) {
  if (scratchPruned || !root) return 0;
  scratchPruned = true;
  const inUse = new Set([String(keep || '').toLowerCase()]);
  for (const rec of sessions.values()) if (rec.cwd) inUse.add(String(rec.cwd).toLowerCase());
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(root); } catch { return 0; }
  const cutoff = Date.now() - SCRATCH_PRUNE_MS;
  for (const name of names) {
    if (!SCRATCH_NAME.test(name)) continue;
    const full = path.join(root, name);
    if (inUse.has(full.toLowerCase())) continue;
    try {
      const st = fs.lstatSync(full);
      if (!st.isDirectory() || st.isSymbolicLink() || st.mtimeMs > cutoff) continue;
      fs.rmdirSync(full); // throws ENOTEMPTY on anything with content
      removed++;
    } catch { /* not empty, or in use: leave it */ }
  }
  return removed;
}

// TEST ONLY: a test profile (--test-profile) may run a node script in place
// of claude.exe (QUARTZ_TEST_CLAUDE = absolute path to a .js file), so an e2e
// can watch exactly what reaches a Claude session's argv, cwd and input
// without ever starting the real CLI. A live Quartz ignores the variable.
function testClaudeStandin(prog) {
  if (!prog || prog.id !== 'claude') return null;
  if (!process.argv.includes('--test-profile')) return null;
  const script = process.env.QUARTZ_TEST_CLAUDE;
  if (!script || !path.isAbsolute(script) || !isFile(script)) return null;
  return { bin: process.execPath, pre: [script], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

// ---------------------------------------------------------------------------
// Programs
//
// Every terminal tab runs one of THESE and nothing else. The renderer names a
// program by `id`; a path it makes up is never spawned, which is why the table
// is static and lives on this side of the bridge.
//
// `args` are ours (fixed, always passed). `allowed` is the set of flags the
// renderer may ADD on top -- claude keeps today's list, and every shell takes
// none, because a shell's argv is a way to run an arbitrary command line.
// ---------------------------------------------------------------------------
const PROGRAMS = [
  { id: 'claude', title: 'Claude', bin: CLAUDE_BIN, args: [], allowed: ALLOWED_ARGS },
  { id: 'powershell', title: 'PowerShell', bin: 'powershell.exe', args: ['-NoLogo'], allowed: null },
  { id: 'pwsh', title: 'PowerShell 7', bin: 'pwsh.exe', args: ['-NoLogo'], allowed: null },
  { id: 'cmd', title: 'Command Prompt', bin: 'cmd.exe', args: [], allowed: null },
  { id: 'python', title: 'Python', bin: 'python.exe', args: [], allowed: null },
  { id: 'node', title: 'Node', bin: 'node.exe', args: [], allowed: null },
  { id: 'bash', title: 'Git Bash', bin: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'], allowed: null },
];

const PROGRAM_BY_ID = new Map(PROGRAMS.map((p) => [p.id, p]));

/** The default program, so an old caller that names none still gets Claude. */
const DEFAULT_PROGRAM = 'claude';

// System32 by absolute path: `where` itself is resolved off PATH otherwise,
// and PATH is exactly what we are asking it about.

/** id -> absolute path | null. Resolved at most ONCE per program per process. */
const binCache = new Map();

/**
 * Find a bare name on PATH the way where.exe does (each PATH folder in order, PATHEXT when the name
 * has no extension; first hit wins), IN PROCESS. It used to run where.exe once per program with
 * spawnSync: on this laptop that froze the main thread 0.8-1.0 s on the first pty:programs (process
 * creation under the scanner), long enough to hold back look-sync's watch events past its 1 s follow
 * target (looksync-e2e, main-process profiles, 2026-10-18). A few dozen stats cost milliseconds.
 * Swapped out by the harness.
 */
function runWhere(bin) {
  if (!bin || /[\\/]/.test(bin)) return null;
  const exts = path.extname(bin) ? [''] : String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = String(process.env.PATH || process.env.Path || '').split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

let whereRunner = runWhere;

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * A Store "app execution alias" — the 0-byte-looking stub Windows ships for
 * python.exe when Python is NOT installed. Spawning it opens the Store page
 * instead of a REPL, so it does not count as available.
 */
function isStoreStub(target) {
  if (!/[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(target)) return false;
  let real = target;
  try {
    real = fs.realpathSync(target);
  } catch {
    return false;
  }
  return /Redirector\.exe$/i.test(real);
}

/**
 * The absolute path this program will be spawned from, or null when it is not
 * installed. An absolute entry in the table is checked on disk; a bare name
 * goes through where.exe. Either way the answer is cached, including `null`:
 * installing something mid-session is not worth a syscall per tab.
 */
function resolveBin(program) {
  if (binCache.has(program.id)) return binCache.get(program.id);
  const bin = program.bin;
  let resolved = null;
  if (path.isAbsolute(bin) || bin.indexOf('\\') !== -1 || bin.indexOf('/') !== -1) {
    resolved = isFile(bin) ? bin : null;
  } else {
    const found = whereRunner(bin);
    resolved = found && isFile(found) && !isStoreStub(found) ? found : null;
  }
  binCache.set(program.id, resolved);
  return resolved;
}

/** The table entry for an id, or null. Anything not a known id is refused. */
function getProgram(id) {
  if (id === undefined || id === null || id === '') return PROGRAM_BY_ID.get(DEFAULT_PROGRAM);
  if (typeof id !== 'string') return null;
  return PROGRAM_BY_ID.get(id) || null;
}

/** True when this id names a table entry (or is absent, meaning claude). */
function hasProgram(id) {
  return !!getProgram(id);
}

/** What the chrome lists in the dock/palette: [{ id, title, available }]. */
function listPrograms() {
  return PROGRAMS.map((p) => ({ id: p.id, title: p.title, available: !!resolveBin(p) }));
}

/** @type {Map<string, {id: string, pty: any, alive: boolean}>} */
const sessions = new Map();

/**
 * xterm can report 0 (or NaN) while the DOM is mid-layout, and ConPTY rejects
 * those outright. Clamp everything to a sane integer >= 1.
 */
function sanitizeDim(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.max(1, Math.floor(n));
}

/**
 * Keep only the flags THIS program allowlists, in the order given, without
 * duplicates. A dropped argument is never an error: the session still starts,
 * plain. A program with no allowlist (every shell) takes nothing.
 */
function sanitizeArgs(args, program) {
  const allowed = (program && program.allowed) || null;
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args)) {
    console.warn('[pty] args must be an array; ignoring', typeof args);
    return [];
  }
  if (!allowed || allowed.size === 0) {
    if (args.length) {
      console.warn('[pty] program takes no renderer args; dropped', args.length,
        'for', program && program.id);
    }
    return [];
  }
  const out = [];
  for (const raw of args) {
    if (typeof raw !== 'string') {
      console.warn('[pty] dropped non-string arg:', typeof raw);
      continue;
    }
    const arg = raw.trim();
    if (!arg) continue;
    if (!allowed.has(arg)) {
      // This is also what swallows a value after `--resume`: an id is just a
      // token, and no token is on the allowlist.
      console.warn('[pty] dropped arg not on the allowlist:', arg);
      continue;
    }
    if (RESUME_ARGS.has(arg) && out.some((prev) => RESUME_ARGS.has(prev))) {
      console.warn('[pty] dropped second resume flag:', arg);
      continue;
    }
    if (out.indexOf(arg) === -1) out.push(arg);
  }
  return out;
}

/**
 * Resolve a caller-supplied cwd to a directory that actually exists.
 *
 * node-pty throws if the cwd is missing, which would surface as a failed tab
 * rather than a usable one -- so a folder that has been deleted, renamed, or
 * simply typed wrong falls back to the home directory instead.
 */
function resolveCwd(cwd) {
  const home = os.homedir() || DEFAULT_CWD;
  if (typeof cwd !== 'string' || !cwd.trim()) return home;

  let resolved;
  try {
    resolved = path.resolve(cwd.trim());
  } catch {
    return home;
  }
  try {
    if (fs.statSync(resolved).isDirectory()) return resolved;
  } catch {
    // missing / unreadable -- handled below
  }
  console.warn('[pty] cwd is not an existing directory, using home instead:', resolved);
  return home;
}

function newId() {
  // randomUUID exists on Node 24; the counter branch is only belt-and-braces.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  newId.counter = (newId.counter || 0) + 1;
  return `pty-${Date.now()}-${newId.counter}`;
}

// Env vars Claude Code injects into its own child processes to mark them as
// part of the parent session. If the browser is ever launched FROM a Claude
// Code session these leak down the chain, and the session we spawn decides it
// is a child: transcript saving switches off and /effort gets hard-pinned.
// We want a top-level session, identical to one started from a fresh terminal.
//
// Strip every CLAUDE* marker except the two the user genuinely persists at the
// user level, so any new marker added upstream is scrubbed automatically too.
const KEEP_CLAUDE_VARS = new Set([
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
]);

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^CLAUDE/i.test(key) && !KEEP_CLAUDE_VARS.has(key.toUpperCase())) {
      delete env[key];
    }
  }
  return env;
}

/**
 * Stop node-pty from forking its console-list helper when a session is killed.
 *
 * On Windows, node-pty's ConPTY kill() forks `conpty_console_list_agent` — a
 * separate process, because only one console can be attached at a time — to ask
 * Windows which processes are attached to this pty's console, then kills them
 * too. Inside Electron that helper's AttachConsole() call fails, so the child
 * dies with an uncaught "AttachConsole failed" on our stderr, once per terminal
 * tab closed. node-pty then waits out its own 5s timeout and falls back to the
 * shell pid alone.
 *
 * So the helper never contributes anything here but a crash and a dangling
 * timer. Replace it with the SAME answer node-pty settles for -- the pty's own
 * process -- resolved immediately and without a fork. Everything else about
 * kill() (the ConPTY teardown, the conout worker, the pid it kills) is
 * untouched; if a future node-pty stops exposing these internals the patch
 * quietly does nothing and the old behaviour returns.
 *
 * @returns {boolean} true when the helper is out of the picture.
 */
function suppressConsoleListHelper(p) {
  try {
    const agent = p && p._agent;
    if (!agent || typeof agent._getConsoleProcessList !== 'function') return false;
    agent._getConsoleProcessList = function () {
      const pid = this._innerPid;
      return Promise.resolve(Number.isInteger(pid) && pid > 0 ? [pid] : []);
    };
    return true;
  } catch (err) {
    // Never fail a spawn over this: a helper crash is noise, a dead tab is not.
    console.warn('[pty] could not disable the console-list helper:', err && err.message);
    return false;
  }
}

/**
 * Spawn a new PTY session for one program from the table.
 *
 * @param {object} opts
 * @param {string} [opts.program] program id; defaults to 'claude'. An id that
 *                                is not in the table (a path included) throws.
 * @param {string} [opts.cwd]     working directory for the shell
 * @param {number} [opts.cols]    initial column count
 * @param {number} [opts.rows]    initial row count
 * @param {string[]} [opts.args]  extra flags; claude keeps a bare `--continue`
 *                                / skip-permissions, the shells
 *                                take none
 * @param {(data: string) => void} [opts.onData]
 * @param {(exitCode: number) => void} [opts.onExit]
 * @returns {{ id: string, program: string, cwd: string, args: string[], write: (d: string) => void, resize: (c: number, r: number) => void, kill: () => void }}
 */
/**
 * What one spawn will actually run with, decided before anything is spawned:
 * the cwd, the argv after the allowlist, and whether it is a page-text
 * chamber (see "Page-text chambers" above). Separate from createSession so
 * the harness can check the argv for every kind of chamber without a PTY.
 * Throws for a page-text chamber whose scratch folder cannot be made.
 *
 * @returns {{cwd:string, args:string[], pageText:boolean, scratchCreated:boolean}}
 */
function planLaunch(prog, args, cwd) {
  let argsIn = args;
  let pageText = false;
  let scratch = null;
  if (prog.id === 'claude') {
    const root = scratchRoot();
    const plan = planPageText(args, cwd, root);
    if (plan.pageText) {
      pageText = true;
      argsIn = plan.args;
      scratch = ensureScratchFolder(plan.dir);
      if (scratch.created) pruneScratch(root, scratch.dir);
    }
  }
  return {
    // A page-text chamber runs in its scratch folder and nowhere else; every
    // other spawn's cwd is normalized (node-pty throws on a missing one).
    cwd: scratch ? scratch.dir : resolveCwd(cwd),
    // Our fixed flags first, then whatever the renderer was allowed to add.
    args: prog.args.concat(sanitizeArgs(argsIn, prog)),
    pageText: pageText,
    scratchCreated: !!(scratch && scratch.created),
  };
}

function createSession({ program, cwd, cols, rows, args, onData, onExit } = {}) {
  const prog = getProgram(program);
  if (!prog) throw new Error(`unknown program: ${String(program).slice(0, 60)}`);
  const standin = testClaudeStandin(prog);
  const bin = standin ? standin.bin : resolveBin(prog);
  if (!bin) throw new Error(`${prog.title} is not installed (${prog.bin} not found)`);

  const id = newId();
  const safeCols = sanitizeDim(cols, 80);
  const safeRows = sanitizeDim(rows, 24);

  // (see cleanEnv below for why the environment is scrubbed before spawning)
  const launch = planLaunch(prog, args, cwd);
  const safeCwd = launch.cwd;
  const safeArgs = launch.args;
  if (launch.pageText) {
    console.log('[pty] page-text chamber: permission prompts on, in', safeCwd,
      launch.scratchCreated ? '(new)' : '(existing)');
  }

  const p = nodePty.spawn(bin, standin ? standin.pre.concat(safeArgs) : safeArgs, {
    name: 'xterm-256color',
    cols: safeCols,
    rows: safeRows,
    cwd: safeCwd,
    env: standin ? Object.assign(cleanEnv(), standin.env) : cleanEnv(),
  });

  // Before anything can kill this session (see the note on the helper above).
  suppressConsoleListHelper(p);

  const record = { id, pty: p, alive: true, cwd: safeCwd };
  sessions.set(id, record);

  p.onData((data) => {
    if (typeof onData === 'function') {
      try {
        onData(data);
      } catch (err) {
        // A throwing consumer must never take down the PTY pump.
        console.error('[pty] onData handler threw:', err);
      }
    }
  });

  p.onExit(({ exitCode }) => {
    record.alive = false;
    sessions.delete(id);
    if (typeof onExit === 'function') {
      try {
        onExit(typeof exitCode === 'number' ? exitCode : 0);
      } catch (err) {
        console.error('[pty] onExit handler threw:', err);
      }
    }
  });

  return {
    id,
    program: prog.id,
    // What the process actually got, after validation -- not what was asked for.
    cwd: safeCwd,
    args: safeArgs.slice(),
    // A page-text chamber: no skip-permissions, scratch folder (see above).
    pageText: launch.pageText,

    write(data) {
      if (!record.alive || typeof data !== 'string') return;
      try {
        p.write(data);
      } catch (err) {
        // Writing to a pty that died between the check and the call.
        console.error('[pty] write failed:', err && err.message);
      }
    },

    resize(nextCols, nextRows) {
      if (!record.alive) return;
      const c = sanitizeDim(nextCols, null);
      const r = sanitizeDim(nextRows, null);
      if (c === null || r === null) return; // ignore bogus layout ticks
      try {
        p.resize(c, r);
      } catch (err) {
        // Resizing a dead ConPTY throws on Windows; nothing useful to do.
        console.error('[pty] resize failed:', err && err.message);
      }
    },

    kill() {
      // Idempotent: the map delete + alive flag make a second call a no-op.
      if (!record.alive) return;
      record.alive = false;
      sessions.delete(id);
      try {
        p.kill();
      } catch (err) {
        console.error('[pty] kill failed:', err && err.message);
      }
    },
  };
}

/** Kill every live session. Safe to call repeatedly (e.g. quit + close). */
function killAll() {
  for (const record of Array.from(sessions.values())) {
    sessions.delete(record.id);
    if (!record.alive) continue;
    record.alive = false;
    try {
      record.pty.kill();
    } catch (err) {
      console.error('[pty] killAll failed for', record.id, err && err.message);
    }
  }
  sessions.clear();
}

module.exports = {
  createSession,
  killAll,
  listPrograms,
  hasProgram,
  // Test seams only: swap where.exe for a fake and forget what it answered.
  // Nothing in the app calls these.
  __test: {
    PROGRAMS,
    getProgram,
    resolveBin,
    resolveCwd,
    sanitizeArgs,
    isStoreStub,
    suppressConsoleListHelper,
    planLaunch,
    planPageText,
    namedScratchFolder,
    isUnderRoot,
    ensureScratchFolder,
    pruneScratch,
    scratchRoot,
    testClaudeStandin,
    PAGE_TEXT_ARG,
    SCRATCH_DIR,
    setWhereRunner(fn) {
      whereRunner = typeof fn === 'function' ? fn : runWhere;
    },
    clearBinCache() {
      binCache.clear();
    },
    // Point the scratch root somewhere (a temp folder); null restores the
    // real <userData>\claude-scratch. Also re-arms the once-per-run prune.
    setScratchRoot(dir) {
      scratchRootOverride = (typeof dir === 'string') ? dir : null;
      scratchPruned = false;
    },
  },
};
