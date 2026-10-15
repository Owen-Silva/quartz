'use strict';
/*
 * sessionfile.js - the durable session.json writer main.js uses.
 *
 * Write-then-rename: a kill mid-write can only ever destroy the .tmp, so session.json is either
 * the previous snapshot or the new one, never half. The write is ASYNC and only one is ever in
 * flight; a burst of snapshots collapses into one write per completed write, because only the
 * NEWEST snapshot has ever been worth keeping (measured in main.js: sync writes stalled the UI).
 *
 * A failed write KEEPS its snapshot and tries again. On Windows a rename over session.json fails
 * for a moment (EPERM / EACCES / EBUSY) whenever another process holds the file without
 * delete-sharing: a virus scanner or the search indexer looking at the file we just wrote. The
 * old pump dropped the snapshot on that error, so session.json stayed stale (with a .tmp left
 * beside it) until some later tab change happened to write again, and a quit right after wrote
 * nothing at all. Seen on a cloud runner: sessions-e2e, 5 session.json checks red in one run.
 *
 *   const w = create({ target: () => file });
 *   w.write(json)      queue the newest snapshot; written soon, off the event loop
 *   w.flushSync()      quitting: write whatever is not on disk yet, now
 *   w.state()          { pending, writing, failures, lastError } for tests
 */
const nodeFs = require('fs');

const RETRY_MS = [100, 250, 500, 1000, 2000]; // then every 2 s while the snapshot is still unsaved

function create(opts) {
  const fs = (opts && opts.fs) || nodeFs;
  const target = opts.target;
  const later = (opts && opts.setTimeout) || setTimeout;
  const pause = (opts && opts.pauseSync) || ((ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* no pause */ } });

  let pending = null;   // newest snapshot json not yet on disk
  let inflight = null;  // the one being written now
  let writing = false;  // a write is in flight
  let failures = 0;     // writes failed in a row
  let lastError = null;
  let timer = null;     // a retry waiting

  function drain() {
    if (writing || pending === null) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const json = pending;
    pending = null;
    inflight = json;
    writing = true;
    const file = target();
    const tmp = file + '.tmp';
    fs.promises
      .writeFile(tmp, json, 'utf8')
      .then(() => fs.promises.rename(tmp, file))
      .then(() => { failures = 0; lastError = null; return true; },
        (err) => {
          // keep it, unless a newer one arrived meanwhile (that one supersedes it)
          if (pending === null) pending = json;
          failures++;
          lastError = (err && (err.code || err.message)) || 'error';
          return false;
        })
      .then((ok) => {
        writing = false;
        inflight = null;
        if (ok) { drain(); return; } // whatever arrived while that one was in flight
        const ms = RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)];
        timer = later(() => { timer = null; drain(); }, ms);
        if (timer && typeof timer.unref === 'function') timer.unref();
      });
  }

  function write(json) {
    pending = json;
    drain();
  }

  /** The last moment anything can be written: the process is about to go. */
  function flushSync() {
    // a write still in flight may yet fail: it is the newest, so it goes now too
    const json = pending !== null ? pending : inflight;
    if (json === null) return true;
    const file = target();
    const tmp = file + '.tmp';
    for (let i = 0; i < 5; i++) {
      try {
        fs.writeFileSync(tmp, json, 'utf8');
        fs.renameSync(tmp, file);
        pending = null;
        failures = 0;
        return true;
      } catch (err) {
        lastError = (err && (err.code || err.message)) || 'error';
        pause(50 * (i + 1)); // a scanner lets go within moments
      }
    }
    return false;
  }

  function state() { return { pending: pending !== null, writing, failures, lastError }; }

  return { write, flushSync, state };
}

module.exports = { create, RETRY_MS };
