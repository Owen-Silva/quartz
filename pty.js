'use strict';

// pty.js — tiny PTY session manager.
//
// Owns a Map of id -> session record. Each session is one `claude.exe` running
// under a real Windows pseudo-console (ConPTY) via node-pty, so the CLI sees a
// proper TTY and renders its full interactive UI.

const path = require('path');
const os = require('os');
const crypto = require('crypto');
const nodePty = require('@homebridge/node-pty-prebuilt-multiarch');

// Absolute path to the Claude CLI. Spawned with no arguments per the contract.
const CLAUDE_BIN = 'C:\\Users\\you\\.local\\bin\\claude.exe';

// Fallback cwd when the caller does not supply one (or supplies garbage).
const DEFAULT_CWD = 'C:\\Users\\you';

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
 * @param {(data: string) => void} [opts.onData]
 * @param {(exitCode: number) => void} [opts.onExit]
 * @returns {{ id: string, write: (d: string) => void, resize: (c: number, r: number) => void, kill: () => void }}
 */
function createSession({ cwd, cols, rows, onData, onExit } = {}) {
  const id = newId();
  const safeCols = sanitizeDim(cols, 80);
  const safeRows = sanitizeDim(rows, 24);

  // A non-string / non-existent cwd makes node-pty throw, so normalize first.
  // (see cleanEnv below for why the environment is scrubbed before spawning)
  let safeCwd = DEFAULT_CWD;
  if (typeof cwd === 'string' && cwd.trim()) {
    safeCwd = path.resolve(cwd.trim());
  } else if (os.homedir()) {
    safeCwd = DEFAULT_CWD;
  }

  const p = nodePty.spawn(CLAUDE_BIN, [], {
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
