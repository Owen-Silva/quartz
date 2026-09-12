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
const childProcess = require('child_process');
const nodePty = require('@homebridge/node-pty-prebuilt-multiarch');

// Absolute path to the Claude CLI.
const CLAUDE_BIN = 'C:\\Users\\you\\.local\\bin\\claude.exe';

// Fallback cwd when the caller does not supply one (or supplies garbage).
const DEFAULT_CWD = 'C:\\Users\\you';

// The ONLY flags a renderer may put on claude.exe's command line. Everything
// else is dropped silently (logged, never spawned): the renderer is the least
// trusted side of this bridge and argv is the one place a string it supplies
// would change how the CLI behaves.
//
// `--continue` resumes that folder's most recent conversation outright.
// `--resume` is allowed BARE only: with no id after it the CLI draws its own
// picker of past conversations, which is the whole point here. A session id
// (or any other token) is not on this list, so it is dropped like anything
// else -- there is no way to spell `--resume <id>` through this bridge.
// `--dangerously-skip-permissions` is how every chamber is meant to start:
// the tab is the user's own machine, and a session that stops to ask for a
// confirmation is a session nobody is watching. The Settings switch
// "Skip permission prompts" turns it off; the flag still has to be on this
// list for the renderer to be able to ask for it at all.
const ALLOWED_ARGS = new Set(['--continue', '--resume', '--dangerously-skip-permissions']);

// Two ways to say "not a fresh session". Passing both is a CLI error, so the
// first one asked for wins and the other is dropped.
const RESUME_ARGS = new Set(['--continue', '--resume']);

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
const WHERE_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');

/** id -> absolute path | null. Resolved at most ONCE per program per process. */
const binCache = new Map();

/** Ask where.exe for a bare name; first hit wins. Swapped out by the harness. */
function runWhere(bin) {
  let res;
  try {
    res = childProcess.spawnSync(WHERE_EXE, [bin], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
  } catch (err) {
    console.warn('[pty] where.exe failed for', bin, err && err.message);
    return null;
  }
  if (!res || res.status !== 0 || typeof res.stdout !== 'string') return null;
  const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first || null;
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
 * Spawn a new PTY session for one program from the table.
 *
 * @param {object} opts
 * @param {string} [opts.program] program id; defaults to 'claude'. An id that
 *                                is not in the table (a path included) throws.
 * @param {string} [opts.cwd]     working directory for the shell
 * @param {number} [opts.cols]    initial column count
 * @param {number} [opts.rows]    initial row count
 * @param {string[]} [opts.args]  extra flags; claude keeps a bare `--continue`
 *                                / `--resume` / skip-permissions, the shells
 *                                take none
 * @param {(data: string) => void} [opts.onData]
 * @param {(exitCode: number) => void} [opts.onExit]
 * @returns {{ id: string, program: string, cwd: string, args: string[], write: (d: string) => void, resize: (c: number, r: number) => void, kill: () => void }}
 */
function createSession({ program, cwd, cols, rows, args, onData, onExit } = {}) {
  const prog = getProgram(program);
  if (!prog) throw new Error(`unknown program: ${String(program).slice(0, 60)}`);
  const bin = resolveBin(prog);
  if (!bin) throw new Error(`${prog.title} is not installed (${prog.bin} not found)`);

  const id = newId();
  const safeCols = sanitizeDim(cols, 80);
  const safeRows = sanitizeDim(rows, 24);

  // A non-string / non-existent cwd makes node-pty throw, so normalize first.
  // (see cleanEnv below for why the environment is scrubbed before spawning)
  const safeCwd = resolveCwd(cwd);
  // Our fixed flags first, then whatever the renderer was allowed to add.
  const safeArgs = prog.args.concat(sanitizeArgs(args, prog));

  const p = nodePty.spawn(bin, safeArgs, {
    name: 'xterm-256color',
    cols: safeCols,
    rows: safeRows,
    cwd: safeCwd,
    env: cleanEnv(),
  });

  const record = { id, pty: p, alive: true };
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
    setWhereRunner(fn) {
      whereRunner = typeof fn === 'function' ? fn : runWhere;
    },
    clearBinCache() {
      binCache.clear();
    },
  },
};
