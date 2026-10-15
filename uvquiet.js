// uvquiet.js -- stop Electron's main process waking itself hundreds to thousands of times a second.
//
// In Electron's main (browser) process, process.nextTick, setImmediate, setTimeout and setInterval
// are wrapped so that every call first calls process.activateUvLoop() (lib/common/init.ts), a
// uv_async_send(). That exists for one case: JS running in a CHROMIUM task (an IPC handler, a
// BrowserWindow event) queues Node work, and Node's loop -- which Electron polls on a separate
// "embed" thread with a timeout it computed earlier -- has to be told to look again.
//
// The activation is also the trigger of the wakeup storms measured in
// next-week/quartz-efficiency.md (2026-10-15): one activateUvLoop() made while uv_run() is on the
// main thread's stack, every few seconds, locks the main thread and the embed thread into waking
// each other 200-5,000 times a second for seconds to minutes at a time
// (tools/efficiency/timer-repro.js --timers=unref3s-activate: 360/s with nothing else running).
// Stream I/O and loopback HTTP do it on every chunk, through nextTick.
//
// Two modes:
//
// 'all' (the default on Electron 44 and later): skip every activation. Electron 44.3's own
// sources make it redundant in the main process:
//   - timers and immediates: Electron configures its loop with UV_LOOP_INTERRUPT_ON_IO_CHANGE
//     (shell/common/node_bindings.cc; patches/node/feat_add_uv_loop_interrupt_on_io_change_...),
//     so libuv itself posts a wakeup to the embed thread's IOCP whenever a handle STARTS outside
//     UvRunOnce. A setTimeout that moves the next expiry earlier restarts Node's one uv timer, and
//     the first ref'd setImmediate starts Node's idle handle: both wake the poller on their own.
//     Inside UvRunOnce the embed thread is parked and re-reads uv_backend_timeout() before it
//     polls again, so nothing is needed there either.
//   - process.nextTick (and promise continuations): MicrotasksRunner::DidProcessTask
//     (shell/browser/microtasks_runner.cc) opens and closes a node::CallbackScope after EVERY
//     Chromium task on the main thread, which drains the tick queue and the microtasks; inside
//     uv_run, Node's own callback scopes do the same.
//   An unref'd setImmediate armed from a Chromium task is the one thing left waiting for the next
//   loop turn; Quartz has none (every setImmediate in the main process is ref'd).
//   uvquiet-e2e.js proves it in a real Electron: callbacks armed from Chromium tasks, from promise
//   continuations and from inside uv_run all still run on time with every activation skipped.
//
// 'asyncid' (older Electron, or on request): skip only when Node says it is running a callback of
// its own (executionAsyncId() > 1: a timer, an immediate, a tick, or an I/O callback). Chromium
// tasks (async id 0), the main script (1) and promise continuations, which Node runs with no async
// id, still activate. That stops the timer-callback trigger but not the ones made after an
// `await` inside uv_run (the stats card and the now-playing poll kept focused Home at 1,400-1,900
// wakeups/s with it), because those are indistinguishable from a Chromium task by async id.
'use strict';
const { executionAsyncId } = require('async_hooks');

/** First Electron major whose main process is verified not to need the activation. */
const ALL_FROM_MAJOR = 44;

/** 'all' on Electron >= ALL_FROM_MAJOR, 'asyncid' on anything older or unknown. */
function defaultMode(proc) {
  const v = proc && proc.versions ? proc.versions.electron : null;
  const major = parseInt(String(v || ''), 10);
  return Number.isFinite(major) && major >= ALL_FROM_MAJOR ? 'all' : 'asyncid';
}

/**
 * Install the guard on process.activateUvLoop (Electron's wrappers look it up on every call).
 * Main process only; a second install, a renderer, or plain Node is a no-op. Returns the
 * guard's counters ({ mode, skipped, passed }) or null when nothing was installed.
 *   opts.mode    'all' | 'asyncid'; default defaultMode(proc)
 *   opts.proc    the process object (harness)
 *   opts.asyncId executionAsyncId stand-in (harness)
 *   opts.onPass  diagnostics: called on every activation that goes through
 */
function install(opts) {
  const o = opts || {};
  const proc = o.proc || process;
  const asyncId = o.asyncId || executionAsyncId;
  if (proc.type !== 'browser' || typeof proc.activateUvLoop !== 'function') return null;
  if (proc.activateUvLoop.__uvquiet) return proc.activateUvLoop.__uvquiet;
  const mode = o.mode === 'all' || o.mode === 'asyncid' ? o.mode : defaultMode(proc);
  const real = proc.activateUvLoop;
  const counts = { mode, skipped: 0, passed: 0 };
  const onPass = typeof o.onPass === 'function' ? o.onPass : null;
  const guarded = mode === 'all'
    ? function activateUvLoop() { counts.skipped++; return undefined; }
    : function activateUvLoop() {
      if (asyncId() > 1) { counts.skipped++; return undefined; }
      counts.passed++;
      if (onPass) { try { onPass(); } catch { /* diagnostics only */ } }
      return real.apply(proc, arguments);
    };
  guarded.__uvquiet = counts;
  proc.activateUvLoop = guarded;
  return counts;
}

module.exports = { install, defaultMode, ALL_FROM_MAJOR };
