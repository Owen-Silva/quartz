'use strict';

// pty.js — tiny PTY session manager.
//
// Owns a Map of id -> session record. Each session is one `claude.exe` running
// under a real Windows pseudo-console (ConPTY) via node-pty, so the CLI sees a
// proper TTY and renders its full interactive UI.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const nodePty = require('@homebridge/node-pty-prebuilt-multiarch');

// Absolute path to the Claude CLI.
const CLAUDE_BIN = 'C:\\Users\\you\\.local\\bin\\claude.exe';

// Fallback cwd when the caller does not supply one (or supplies garbage).
const DEFAULT_CWD = 'C:\\Users\\you';

// The ONLY flags a renderer may put on claude.exe's command line. Everything
// else is dropped silently (logged, never spawned): the renderer is the least
// trusted side of this bridge and argv is the one place a string it supplies
// would change how the CLI behaves.
const ALLOWED_ARGS = new Set(['--continue']);

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
 * Keep only allowlisted flags, in the order given, without duplicates.
 * A dropped argument is never an error: the session still starts, plain.
 */
function sanitizeArgs(args) {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args)) {
    console.warn('[pty] args must be an array; ignoring', typeof args);
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
    if (!ALLOWED_ARGS.has(arg)) {
      console.warn('[pty] dropped arg not on the allowlist:', arg);
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
 * Spawn a new claude.exe PTY session.
 *
 * @param {object} opts
 * @param {string} [opts.cwd]     working directory for the shell
 * @param {number} [opts.cols]    initial column count
 * @param {number} [opts.rows]    initial row count
 * @param {string[]} [opts.args]  extra claude.exe flags; only `--continue` survives
 * @param {(data: string) => void} [opts.onData]
 * @param {(exitCode: number) => void} [opts.onExit]
 * @returns {{ id: string, cwd: string, args: string[], write: (d: string) => void, resize: (c: number, r: number) => void, kill: () => void }}
 */
function createSession({ cwd, cols, rows, args, onData, onExit } = {}) {
  const id = newId();
  const safeCols = sanitizeDim(cols, 80);
  const safeRows = sanitizeDim(rows, 24);

  // A non-string / non-existent cwd makes node-pty throw, so normalize first.
  // (see cleanEnv below for why the environment is scrubbed before spawning)
  const safeCwd = resolveCwd(cwd);
  const safeArgs = sanitizeArgs(args);

  const p = nodePty.spawn(CLAUDE_BIN, safeArgs, {
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

module.exports = { createSession, killAll };
