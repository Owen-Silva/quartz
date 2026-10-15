// uvquiet.js -- stop Electron's main process waking itself hundreds to thousands of times a second.
//
// In Electron's main (browser) process, process.nextTick, setImmediate, setTimeout and setInterval
// are wrapped so that every call first calls process.activateUvLoop(). That exists for one case:
// JS running in a CHROMIUM task (an IPC handler, a BrowserWindow event) queues Node work, and
// Node's loop -- which Electron polls on a separate thread with a timeout it computed earlier --
// has to be told to look again, or the work waits.
//
// When the call is made from INSIDE Node's loop (a timer, socket, pipe, child-process or fs
// callback) there is nothing to tell: Electron's UvRunOnce() re-arms the poll thread with a fresh
// timeout as soon as uv_run() returns. The extra activation there is not only useless, it is the
// cause of the idle wakeup storms measured in next-week/quartz-efficiency.md (2026-10-15): one
// activateUvLoop() from a timer callback every few seconds locks the main thread and the poll
// thread into waking each other 200-5,000 times a second, for seconds to minutes at a time
// (tools/efficiency/timer-repro.js --timers=unref3s-activate: 360/s with nothing else running).
// Stream I/O (a child's stdout, a loopback HTTP call) does it on every chunk, through nextTick.
//
// The guard: skip the activation only when Node says it is running a callback of its own
// (executionAsyncId() > 1: a timer, an immediate, a tick, or an I/O callback). Everything else
// -- Chromium tasks (async id 0), the main script (1), and promise continuations, which Node
// runs with no async id -- still activates exactly as before. So the only calls skipped are ones
// made while uv_run() is on the stack, and work queued from those is picked up when it returns.
'use strict';
const { executionAsyncId } = require('async_hooks');

/**
 * Install the guard on process.activateUvLoop (Electron's wrappers look it up on every call).
 * Main process only; a second install, a renderer, or plain Node is a no-op. Returns the
 * guard's counters ({ skipped, passed }) or null when nothing was installed.
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
  const real = proc.activateUvLoop;
  const counts = { skipped: 0, passed: 0 };
  const onPass = typeof o.onPass === 'function' ? o.onPass : null;
  const guarded = function activateUvLoop() {
    if (asyncId() > 1) { counts.skipped++; return undefined; }
    counts.passed++;
    if (onPass) { try { onPass(); } catch { /* diagnostics only */ } }
    return real.apply(proc, arguments);
  };
  guarded.__uvquiet = counts;
  proc.activateUvLoop = guarded;
  return counts;
}

module.exports = { install };
