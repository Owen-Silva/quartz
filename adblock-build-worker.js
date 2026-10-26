'use strict';

/*
 * adblock-build-worker.js -- builds a fresh ad-block engine off the main thread.
 *
 * Parsing the ads + tracking lists (~100k filters) is one synchronous run of
 * several seconds. On the main process that would freeze the window, every
 * tab's IPC and every webRequest callback for as long as it takes, so
 * main.js starts this file as a worker_thread instead and gets back only the
 * serialized engine (bytes, transferred rather than copied) and its filter
 * count. Deserializing those bytes is the same 50-95 ms the startup path
 * already pays.
 *
 * The lists themselves are whatever Ghostery's fromPrebuiltAdsAndTracking()
 * asks for, so a library upgrade that changes the list set changes it here
 * too. What this file adds is a stricter fetch than the library's own, which
 * reads any reply as a list:
 *   - a non-2xx status is a failure ("the list server answered 503"), not a
 *     list made of an error page;
 *   - a reply that is a web page (a hotel or airport sign-in page answers
 *     every URL with one) is a failure, not a list of garbage filters;
 *   - every download has a timeout.
 *
 * Test profiles can point the list host at a local server (listBase); main.js
 * only passes one under --test-profile.
 *
 * The same buildEngine() is exported so adblock-refresh-harness.js can run it
 * in-process with a fake fetch.
 */

const fs = require('fs');
const { FiltersEngine } = require('@ghostery/adblocker');
const { wordsError, failureWords, looksLikeHtml } = require('./adblock-refresh');

/** Where Ghostery 2.x fetches its lists from (fetch.js). Rewritten only when listBase is set. */
const GHOSTERY_PREFIX = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/';

function mapUrl(url, listBase) {
  const s = String(url);
  if (!listBase || !s.startsWith(GHOSTERY_PREFIX)) return s;
  return String(listBase).replace(/\/?$/, '/') + s.slice(GHOSTERY_PREFIX.length);
}

/** A fetch for Ghostery that refuses error statuses and web pages. */
function strictFetch(fetchImpl, { listBase = '', timeoutMs = 60000 } = {}) {
  return async (url) => {
    const target = mapUrl(url, listBase);
    const init = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? { signal: AbortSignal.timeout(timeoutMs) } : {};
    const res = await fetchImpl(target, init);
    if (!res || !res.ok) {
      throw wordsError('the list server answered ' + (res ? res.status : 'nothing'), 'HTTP_' + (res ? res.status : 0));
    }
    const text = await res.text();
    const type = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '';
    if (looksLikeHtml(text, type)) {
      throw wordsError('got a web page instead of a filter list (a network sign-in page?)');
    }
    // Ghostery only ever calls .text() on what fetch resolves to.
    return { ok: true, status: res.status, text: () => Promise.resolve(text) };
  };
}

function countFilters(engine) {
  const f = engine.getFilters();
  return f.networkFilters.length + f.cosmeticFilters.length;
}

/**
 * Build, count, serialize. With countPrev, also count the filters in the
 * cache file the main process is using, for the "suspicious shrink" check
 * (main.js remembers the count after the first refresh, so this runs once).
 */
async function buildEngine({ fetchImpl, listBase = '', cachePath = '', countPrev = false, timeoutMs = 60000, readFile } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  let engine = await FiltersEngine.fromPrebuiltAdsAndTracking(strictFetch(doFetch, { listBase, timeoutMs }));
  const filters = countFilters(engine);
  const bytes = engine.serialize();
  engine = null;
  let prevFilters = 0;
  if (countPrev && cachePath) {
    try {
      const read = readFile || fs.promises.readFile;
      prevFilters = countFilters(FiltersEngine.deserialize(new Uint8Array(await read(cachePath))));
    } catch {
      prevFilters = 0; // unreadable or an older format: the shrink check is skipped, the rest still applies
    }
  }
  return { bytes, filters, prevFilters };
}

module.exports = { GHOSTERY_PREFIX, mapUrl, strictFetch, countFilters, buildEngine };

/* --- worker entry ---------------------------------------------------- */
const wt = require('worker_threads');
if (!wt.isMainThread && wt.workerData && wt.workerData.kind === 'quartz-adblock-build') {
  const w = wt.workerData;
  buildEngine({ listBase: w.listBase, cachePath: w.cachePath, countPrev: !!w.countPrev, timeoutMs: w.timeoutMs })
    .then((r) => {
      wt.parentPort.postMessage({ ok: true, bytes: r.bytes, filters: r.filters, prevFilters: r.prevFilters }, [r.bytes.buffer]);
    })
    .catch((err) => {
      wt.parentPort.postMessage({ ok: false, words: failureWords(err) });
    });
}
