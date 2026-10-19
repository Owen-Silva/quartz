'use strict';
// autopause-smtc.js - Node side of the SMTC helper (autopause-smtc.ps1).
//
// Owns one lazily spawned Windows PowerShell child that speaks JSON lines.
// Every call resolves (never rejects): failures come back as
// { ok:false, reason }. The child is ended after idleMs without use so it
// does not sit in RAM, respawned on the next request, and restarted with a
// backoff after crashes.
//
// API: createSmtc(opts) -> { state, last, control, stop, running, stats }

const path = require('path');
const { StringDecoder } = require('string_decoder');

const SCRIPT = path.join(__dirname, 'autopause-smtc.ps1');
const ACTIONS = new Set(['play', 'pause', 'toggle', 'next', 'previous']);
const ERR_CAP = 200;

function defaultSetTimer(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

function createSmtc(opts = {}) {
  const spawnFn = opts.spawn || require('child_process').spawn;
  const script = opts.script || SCRIPT;
  const test = !!opts.test;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const requestMs = opts.requestMs > 0 ? opts.requestMs : 4000;
  const idleMs = opts.idleMs > 0 ? opts.idleMs : 60000;
  const backoffMs = Array.isArray(opts.backoffMs) && opts.backoffMs.length ? opts.backoffMs : [1000, 3000, 10000, 30000];
  const setTimer = opts.setTimer || defaultSetTimer;
  const clearTimer = opts.clearTimer || clearTimeout;
  const now = opts.now || Date.now;

  let child = null;          // current child, or null
  let childGone = null;      // Promise resolved when the current child exits
  let buf = '';
  let decoder = null;
  let lastErr = '';
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, timer, map }
  let crashes = 0;           // consecutive crashes
  let restartAt = 0;
  let consecTimeouts = 0;
  let idleTimer = null;
  let lastState = null;
  const counts = { spawns: 0, crashes: 0, timeouts: 0, badLines: 0, requests: 0 };

  function safeLog(s) { try { log(s); } catch (_) { /* logging must never throw */ } }

  function failAll(reason, extra) {
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimer(p.timer);
      p.resolve(Object.assign({ ok: false, reason }, extra || {}));
    }
  }

  function clearIdle() { if (idleTimer) { clearTimer(idleTimer); idleTimer = null; } }

  function armIdle() {
    clearIdle();
    if (!child || pending.size) return;
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (!child || pending.size) return;
      safeLog('smtc idle exit');
      retire(child);
    }, idleMs);
  }

  // End a child on purpose (idle, stop, too many timeouts): not a crash.
  // Ends stdin so it exits on its own; kills it if still alive after killMs.
  function retire(c, killMs = 5000) {
    c.__quiet = true;
    if (child === c) child = null;
    if (killMs <= 0) { try { c.kill(); } catch (_) {} return; } // hung helper: no grace
    try { c.stdin && c.stdin.end && c.stdin.end(); } catch (_) {}
    if (!c.__exited) {
      const t = setTimer(() => { if (!c.__exited) { try { c.kill(); } catch (_) {} } }, killMs);
      c.__killTimer = t;
    }
  }

  function onLine(line) {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { counts.badLines++; return; }
    if (!msg || typeof msg !== 'object' || !pending.has(msg.id)) { counts.badLines++; return; }
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimer(p.timer);
    crashes = 0;          // a reply means the helper is healthy
    consecTimeouts = 0;
    p.resolve(p.map(msg));
    armIdle();
  }

  function onExit(c, how) {
    if (c.__exited) return;
    c.__exited = true;
    if (c.__killTimer) clearTimer(c.__killTimer);
    if (c.__done) c.__done();
    const wasCurrent = child === c;
    if (wasCurrent) { child = null; clearIdle(); }
    if (c.__quiet) return;
    crashes++;
    counts.crashes++;
    const wait = backoffMs[Math.min(crashes - 1, backoffMs.length - 1)];
    restartAt = now() + wait;
    safeLog('smtc helper exited (' + how + '), crash ' + crashes + ', retry in ' + wait + ' ms');
    if (wasCurrent) failAll('helper exited', lastErr ? { detail: lastErr } : undefined);
  }

  function start() {
    let c;
    try {
      c = spawnFn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      crashes++;
      counts.crashes++;
      restartAt = now() + backoffMs[Math.min(crashes - 1, backoffMs.length - 1)];
      lastErr = String((e && e.message) || e).slice(0, ERR_CAP);
      safeLog('smtc spawn failed');
      return null;
    }
    counts.spawns++;
    child = c;
    buf = '';
    lastErr = '';
    decoder = new StringDecoder('utf8');
    childGone = new Promise((res) => { c.__done = res; });
    safeLog('smtc spawn pid ' + c.pid);
    if (c.stdin && typeof c.stdin.on === 'function') c.stdin.on('error', () => {});
    if (c.stdout) {
      c.stdout.on('data', (chunk) => {
        if (child !== c) return;
        buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          onLine(line);
        }
        if (buf.length > 1 << 20) { counts.badLines++; buf = ''; } // runaway line guard
      });
    }
    if (c.stderr) {
      let ebuf = '';
      c.stderr.on('data', (chunk) => {
        ebuf = (ebuf + String(chunk)).slice(-4096);
        const lines = ebuf.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (lines.length) lastErr = lines[lines.length - 1].slice(0, ERR_CAP);
      });
    }
    c.on('exit', (code) => onExit(c, 'code ' + code));
    c.on('error', (e) => {
      lastErr = String((e && e.message) || e).slice(0, ERR_CAP);
      onExit(c, 'error');
    });
    return c;
  }

  // Send one request; resolves map(reply) or { ok:false, reason }.
  function request(body, map) {
    counts.requests++;
    clearIdle();
    return new Promise((resolve) => {
      if (!child) {
        if (now() < restartAt) { resolve({ ok: false, reason: 'helper restarting' }); return; }
        if (!start()) { resolve({ ok: false, reason: 'spawn failed', detail: lastErr }); return; }
      }
      const c = child;
      const id = nextId++;
      const timer = setTimer(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        counts.timeouts++;
        consecTimeouts++;
        safeLog('smtc timeout (' + consecTimeouts + ' in a row)');
        resolve({ ok: false, reason: 'timeout' });
        if (consecTimeouts >= 2 && child === c) {
          consecTimeouts = 0;
          safeLog('smtc helper unresponsive, restarting');
          retire(c, 0);
          failAll('helper exited');
        } else {
          armIdle();
        }
      }, requestMs);
      pending.set(id, { resolve, timer, map });
      try {
        c.stdin.write(JSON.stringify(Object.assign({ id }, body)) + '\n');
      } catch (e) {
        pending.delete(id);
        clearTimer(timer);
        resolve({ ok: false, reason: 'helper exited' });
      }
    });
  }

  function state() {
    return request({ op: 'state' }, (msg) => {
      if (!msg.ok) return { ok: false, reason: String(msg.reason || 'failed') };
      const s = {
        ok: true,
        current: typeof msg.current === 'string' ? msg.current : '',
        sessions: Array.isArray(msg.sessions) ? msg.sessions : [],
        at: now(),
      };
      lastState = s;
      return s;
    });
  }

  function control(action, aumid) {
    if (!ACTIONS.has(action)) return Promise.resolve({ ok: false, sent: false, reason: 'bad action' });
    if (typeof aumid !== 'string' || !aumid) return Promise.resolve({ ok: false, sent: false, reason: 'no session' });
    if (test) {
      safeLog('smtc dry run: ' + action);
      return Promise.resolve({ ok: true, sent: false, dryRun: true });
    }
    return request({ op: 'control', action, aumid }, (msg) => (msg.ok
      ? { ok: true, sent: !!msg.sent }
      : { ok: false, sent: false, reason: String(msg.reason || 'failed') }))
      .then((r) => ('sent' in r ? r : Object.assign({ sent: false }, r)));
  }

  // Ends the helper (kills it if still alive after ~1 s). Safe to call twice.
  // Not permanent: a later request spawns a fresh helper. Resolves once the
  // child has exited (or at once if there was none).
  function stop() {
    clearIdle();
    failAll('stopped');
    consecTimeouts = 0;
    const c = child;
    if (!c) return Promise.resolve();
    const gone = childGone;
    retire(c, 1000);
    return gone;
  }

  return {
    state,
    last: () => lastState,
    control,
    stop,
    running: () => !!child,
    stats: () => Object.assign({}, counts),
  };
}

module.exports = { createSmtc, SCRIPT };
