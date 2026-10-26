'use strict';

/*
 * adblock-hooks.js -- the ad blocker's hooks into the browser session.
 *
 * Ghostery's adapter offers enableBlockingInSession(session), which registers
 * listeners BOUND TO ONE ENGINE: its webRequest.onBeforeRequest and
 * onHeadersReceived, a frame preload for cosmetic filtering, and two IPC
 * handlers the preload calls. That shape is a problem twice over:
 *
 *   1. Swapping in a refreshed engine (adblock-refresh.js) would mean
 *      disableBlockingInSession(old) + enableBlockingInSession(new). Electron
 *      keeps ONE listener per webRequest event per session, so disable() can
 *      only clear the event outright (onBeforeRequest(null)), and the preload
 *      is unregistered and registered again around it. Correct on paper, but
 *      it is churn on the very path every request takes.
 *   2. Its onHeadersReceived is registered for <all_urls> with no type filter,
 *      yet it only ever acts on mainFrame/subFrame responses (to merge $csp
 *      filters into the page's Content-Security-Policy) and answers {} for
 *      everything else. Every image, script, XHR and media response of every
 *      tab was handed to a main-process JS callback for nothing.
 *
 * So the hooks are registered here ONCE, and each callback asks for the
 * engine in use at the moment it runs (getBlocker()). A refresh is then one
 * assignment in main.js -- no listener is ever missing or doubled -- and the
 * headers hook carries a `types: ['mainFrame', 'subFrame']` filter (Electron's
 * WebRequestFilter in Electron 44 has `types`; see electron.d.ts), which drops it to a
 * couple of calls per page with no change in what is blocked.
 *
 * onBeforeRequest keeps <all_urls> and every type: a `types` list would also
 * leave out requests Electron reports as 'other' (beacons, prefetches), and
 * those must still be blocked.
 *
 * The callbacks this file calls -- onBeforeRequest, onHeadersReceived,
 * onInjectCosmeticFilters, onIsMutationObserverEnabled -- are the public
 * methods of Ghostery's ElectronBlocker (2.x), the same ones its own
 * BlockingContext calls. Nothing of Ghostery's is patched.
 *
 * Other Quartz features use webRequest too: main.js's client-hints fix owns
 * onBeforeSendHeaders. Only onBeforeRequest and onHeadersReceived are ever
 * set or cleared here, so it is never touched.
 *
 * Counters. Every callback bumps a per-resource-type count (an object
 * increment, nothing else), so the saving above is measured rather than
 * assumed: stats() hands them out and summaryWords() says them in one line
 * for quartz.log.
 */

const INJECT_CHANNEL = '@ghostery/adblocker/inject-cosmetic-filters';
const MUTATION_CHANNEL = '@ghostery/adblocker/is-mutation-observer-enabled';
const FRAME_TYPES = ['mainFrame', 'subFrame'];

/**
 * d = {
 *   ipcMain,                 // Electron's
 *   preloadPath,             // Ghostery's PRELOAD_PATH
 *   getBlocker(): engine|null
 *   log(line)                // optional, quartz.log
 *   now()                    // optional, for the harness
 * }
 */
function createAdblockHooks(d) {
  const now = d.now || Date.now;
  let sess = null;
  let preloadId;
  let headersFiltered = false;
  const counts = { request: Object.create(null), headers: Object.create(null), since: now() };

  function bump(table, details) {
    const t = (details && details.resourceType) || 'other';
    table[t] = (table[t] || 0) + 1;
  }

  /**
   * Calls the engine, and guarantees the request is answered exactly once:
   * a throw before the engine answered lets the request through untouched
   * (an ad shown beats a page that never loads), a throw after it is ignored.
   */
  function relay(method, details, callback) {
    const blocker = d.getBlocker();
    if (!blocker) { callback({}); return; }
    let answered = false;
    const once = (response) => { if (answered) return; answered = true; callback(response); };
    try {
      blocker[method](details, once);
    } catch {
      once({});
    }
  }

  function onBeforeRequest(details, callback) {
    bump(counts.request, details);
    relay('onBeforeRequest', details, callback);
  }

  function onHeadersReceived(details, callback) {
    bump(counts.headers, details);
    relay('onHeadersReceived', details, callback);
  }

  /*
   * The library's cosmetic handler answers any frame in the session --
   * including our own chrome, which is a file:// page and would get the
   * generic "hide anything that looks like an ad" stylesheet injected into the
   * UI. Only real web pages are served.
   */
  function onInjectCosmeticFilters(event, url, msg) {
    let scheme = '';
    try { scheme = new URL(url).protocol; } catch { return undefined; }
    if (scheme !== 'http:' && scheme !== 'https:') return undefined;
    const blocker = d.getBlocker();
    if (!blocker) return undefined;
    return blocker.onInjectCosmeticFilters(event, url, msg);
  }

  function onIsMutationObserverEnabled(event) {
    const blocker = d.getBlocker();
    if (!blocker) return false;
    return blocker.onIsMutationObserverEnabled(event);
  }

  function enable(session) {
    if (sess) return;
    sess = session;
    preloadId = session.registerPreloadScript({ type: 'frame', filePath: d.preloadPath });
    d.ipcMain.removeHandler(INJECT_CHANNEL);
    d.ipcMain.handle(INJECT_CHANNEL, onInjectCosmeticFilters);
    d.ipcMain.removeHandler(MUTATION_CHANNEL);
    d.ipcMain.handle(MUTATION_CHANNEL, onIsMutationObserverEnabled);
    try {
      session.webRequest.onHeadersReceived({ urls: ['<all_urls>'], types: FRAME_TYPES }, onHeadersReceived);
      headersFiltered = true;
    } catch (err) {
      // An Electron without `types` on the filter: the unfiltered hook still blocks correctly.
      session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, onHeadersReceived);
      headersFiltered = false;
      if (d.log) d.log('The ad blocker could not limit its response hook to pages and frames ('
        + ((err && err.message) || err) + '); every response goes through it.');
    }
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, onBeforeRequest);
  }

  function disable() {
    if (!sess) return;
    const s = sess;
    sess = null;
    // One listener per event per session: null clears ours, and only ours,
    // since nothing else in the app registers on these two events.
    try { s.webRequest.onHeadersReceived(null); } catch { /* session gone */ }
    try { s.webRequest.onBeforeRequest(null); } catch { /* session gone */ }
    if (preloadId !== undefined) {
      try { s.unregisterPreloadScript(preloadId); } catch { /* session gone */ }
      preloadId = undefined;
    }
    d.ipcMain.removeHandler(INJECT_CHANNEL);
    d.ipcMain.removeHandler(MUTATION_CHANNEL);
  }

  function isEnabled() { return !!sess; }

  function stats() {
    const sum = (t) => Object.values(t).reduce((a, b) => a + b, 0);
    return {
      since: counts.since,
      headersFiltered,
      request: Object.assign({}, counts.request),
      headers: Object.assign({}, counts.headers),
      requestTotal: sum(counts.request),
      headersTotal: sum(counts.headers),
    };
  }

  /** "the response hook ran 12 times for 840 requests (828 calls saved) ..." */
  function summaryWords() {
    const s = stats();
    if (!s.requestTotal) return '';
    const top = Object.entries(s.request).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([k, v]) => k + ' ' + v).join(', ');
    const saved = headersFiltered ? Math.max(0, s.requestTotal - s.headersTotal) : 0;
    return 'Ad blocker hooks since ' + new Date(s.since).toISOString().slice(0, 16).replace('T', ' ')
      + ': ' + s.requestTotal + ' requests checked (' + top + '); the response hook ran '
      + s.headersTotal + (s.headersTotal === 1 ? ' time' : ' times') + (headersFiltered ? ' (pages and frames only, about ' + saved + ' calls saved).' : ' (unfiltered).');
  }

  return { enable, disable, isEnabled, stats, summaryWords,
    // for the harness
    _handlers: { onBeforeRequest, onHeadersReceived, onInjectCosmeticFilters, onIsMutationObserverEnabled } };
}

module.exports = { createAdblockHooks, FRAME_TYPES, INJECT_CHANNEL, MUTATION_CHANNEL };
