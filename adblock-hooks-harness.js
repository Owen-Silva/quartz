'use strict';

/*
 * adblock-hooks-harness.js -- proves the narrowed ad blocker hooks
 * (adblock-hooks.js) block, redirect and rewrite headers exactly as the
 * library's own registration did, and that the narrowed response hook is
 * never invoked for anything but pages and frames.
 *
 * Pure node, no Electron. A fake session stands in for Electron's webRequest:
 * it records each registration's filter and handler and dispatches a request
 * the way Electron does -- a handler runs only when the filter's `urls` and
 * (if given) `types` match; otherwise the request goes on untouched ({}).
 *
 * Two sessions are driven with the same table of requests (every resource
 * type Electron reports, including 'other', times a blocked URL, a
 * redirected URL, a host with a $csp filter and a clean URL):
 *   - BEFORE: what Ghostery's BlockingContext.enable() registers -- both
 *     hooks on { urls: ['<all_urls>'] } calling the engine directly.
 *   - AFTER: adblock-hooks.js's enable().
 * Both use the same REAL Ghostery engine (ElectronBlocker.parse), so the
 * answers compared are the engine's, not a stub's.
 *
 * A third run uses a session whose webRequest refuses `types` (an older
 * Electron): the handler's own gate must still give identical answers and
 * keep non-document responses away from the engine.
 */

const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const H = require('./adblock-hooks');

let pass = 0;
let fail = 0;
function check(ok, name, extra) {
  if (ok) { pass++; return; }
  fail++;
  console.log('FAIL ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400)));
}

// Every resourceType Electron 44 reports (electron.d.ts OnBeforeRequestListenerDetails), plus 'other'.
const TYPES = ['mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'object', 'xhr',
  'ping', 'cspReport', 'media', 'webSocket', 'other'];

const LISTS = [
  '||ads.example^',
  '||trk.example/p.gif$image,redirect=1x1.gif',
  '||trk.example/t.js$script,redirect=noopjs',
  "||csp.example^$csp=script-src 'none'",
  '||frames.example^$subdocument,csp=img-src https:',
].join('\n');

const URLS = [
  'https://ads.example/banner',
  'https://trk.example/p.gif',
  'https://trk.example/t.js',
  'https://csp.example/page',
  'https://frames.example/embed',
  'https://clean.example/index.html',
];

/* ---- a fake Electron session ------------------------------------------------------------- */

function fakeSession(opts) {
  const o = opts || {};
  const reg = { headers: null, request: null, sendHeaders: 0, filters: [] };
  const matches = (filter, details) => {
    if (!filter) return false;
    if (!Array.isArray(filter.urls) || !filter.urls.includes('<all_urls>')) return false;
    if (Array.isArray(filter.types) && !filter.types.includes(details.resourceType)) return false;
    return true;
  };
  const session = {
    webRequest: {
      onHeadersReceived: (filter, fn) => {
        if (filter && filter.types && o.refuseTypes) throw new Error("Invalid type 'mainFrame'");
        reg.filters.push({ event: 'headers', filter });
        reg.headers = filter === null ? null : { filter, fn };
      },
      onBeforeRequest: (filter, fn) => {
        reg.filters.push({ event: 'request', filter });
        reg.request = filter === null ? null : { filter, fn };
      },
      onBeforeSendHeaders: () => { reg.sendHeaders++; },
    },
    registerPreloadScript: () => 'pre-1',
    unregisterPreloadScript: () => {},
  };
  // Electron's dispatch: the handler if its filter matches, else the request goes on as is.
  function dispatch(event, details) {
    const r = event === 'headers' ? reg.headers : reg.request;
    if (!r || !matches(r.filter, details)) return { invoked: false, answer: {} };
    const answers = [];
    r.fn(details, (a) => answers.push(a));
    return { invoked: true, answer: answers[0], answers: answers.length };
  }
  return { session, reg, dispatch };
}

/* ---- the engine, and a spy on its response hook -------------------------------------------- */

function makeEngine() {
  const engine = ElectronBlocker.parse(LISTS, { loadNetworkFilters: true, loadCSPFilters: true, loadCosmeticFilters: true });
  const spy = { headers: Object.create(null), request: Object.create(null) };
  const innerH = engine.onHeadersReceived;
  const innerR = engine.onBeforeRequest;
  engine.onHeadersReceived = (d, cb) => { spy.headers[d.resourceType] = (spy.headers[d.resourceType] || 0) + 1; return innerH(d, cb); };
  engine.onBeforeRequest = (d, cb) => { spy.request[d.resourceType] = (spy.request[d.resourceType] || 0) + 1; return innerR(d, cb); };
  return { engine, spy };
}

// A fresh details object per call: the engine edits responseHeaders in place.
let nextId = 1;
function details(url, type) {
  return {
    id: nextId++,
    url,
    method: 'GET',
    resourceType: type,
    referrer: 'https://site.example/',
    webContentsId: 7,
    timestamp: 0,
    statusCode: 200,
    responseHeaders: {
      'Content-Type': ['text/html'],
      'Content-Security-Policy': ["default-src 'self'"],
    },
  };
}

function runTable(fake) {
  const out = [];
  for (const type of TYPES) {
    for (const url of URLS) {
      const req = fake.dispatch('request', details(url, type));
      const hdr = fake.dispatch('headers', details(url, type));
      out.push({ type, url, req, hdr });
    }
  }
  return out;
}

const ipcFake = () => ({ handle() {}, removeHandler() {} });
const stable = (v) => JSON.stringify(v === undefined ? null : v);

try {
  /* ---- 1. BEFORE: Ghostery's own registration (BlockingContext, index.js) ---- */
  const before = fakeSession();
  const eb = makeEngine();
  before.session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => eb.engine.onHeadersReceived(d, cb));
  before.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => eb.engine.onBeforeRequest(d, cb));
  const rowsBefore = runTable(before);

  /* ---- 2. AFTER: adblock-hooks.js ---- */
  const after = fakeSession();
  const ea = makeEngine();
  let tick = 0;
  const hooks = H.createAdblockHooks({ ipcMain: ipcFake(), preloadPath: '/p.cjs', getBlocker: () => ea.engine, clock: () => (tick += 0.5) });
  hooks.enable(after.session);
  const rowsAfter = runTable(after);

  // The registrations themselves.
  const hf = after.reg.headers.filter;
  const rf = after.reg.request.filter;
  check(stable(hf.types) === '["mainFrame","subFrame"]' && stable(hf.urls) === '["<all_urls>"]', 'filters: the response hook asks for pages and frames only', hf);
  check(!rf.types && stable(rf.urls) === '["<all_urls>"]', 'filters: the request hook keeps every type and URL', rf);
  check(after.reg.sendHeaders === 0, 'filters: onBeforeSendHeaders (not ours) is never touched');

  // The table had something to prove: blocks, redirects and CSP rewrites all happen.
  const kinds = { cancel: 0, redirect: 0, csp: 0 };
  for (const r of rowsBefore) {
    if (r.req.answer && r.req.answer.cancel) kinds.cancel++;
    if (r.req.answer && r.req.answer.redirectURL) kinds.redirect++;
    if (r.hdr.answer && r.hdr.answer.responseHeaders) kinds.csp++;
  }
  check(kinds.cancel >= 10 && kinds.redirect >= 2 && kinds.csp >= 1, 'table: the baseline blocks, redirects and rewrites CSP', kinds);
  check(rowsBefore.length === TYPES.length * URLS.length && rowsAfter.length === rowsBefore.length, 'table: every type x every URL ran', rowsAfter.length);

  // Equivalence, row by row.
  let reqSame = 0;
  let hdrSame = 0;
  const diffs = [];
  for (let i = 0; i < rowsBefore.length; i++) {
    const b = rowsBefore[i];
    const a = rowsAfter[i];
    if (stable(b.req.answer) === stable(a.req.answer)) reqSame++;
    else diffs.push({ hook: 'request', type: b.type, url: b.url, before: b.req.answer, after: a.req.answer });
    if (stable(b.hdr.answer) === stable(a.hdr.answer)) hdrSame++;
    else diffs.push({ hook: 'headers', type: b.type, url: b.url, before: b.hdr.answer, after: a.hdr.answer });
    if (a.req.invoked && a.req.answers !== 1) diffs.push({ hook: 'request', type: a.type, url: a.url, answers: a.req.answers });
    if (a.hdr.invoked && a.hdr.answers !== 1) diffs.push({ hook: 'headers', type: a.type, url: a.url, answers: a.hdr.answers });
  }
  check(reqSame === rowsBefore.length, 'equivalence: every block / redirect / pass decision is unchanged (' + reqSame + '/' + rowsBefore.length + ')', diffs.filter((d) => d.hook === 'request'));
  check(hdrSame === rowsBefore.length, 'equivalence: every response-header rewrite is unchanged (' + hdrSame + '/' + rowsBefore.length + ')', diffs.filter((d) => d.hook === 'headers'));
  check(diffs.length === 0, 'equivalence: every invoked hook answered exactly once', diffs.slice(0, 3));

  // The CSP rewrites specifically (the only thing the response hook does).
  const csp = rowsAfter.find((r) => r.type === 'mainFrame' && r.url.startsWith('https://csp.example'));
  const cspHeader = csp && csp.hdr.answer && csp.hdr.answer.responseHeaders && csp.hdr.answer.responseHeaders['content-security-policy'];
  check(Array.isArray(cspHeader) && /script-src 'none'/.test(cspHeader[0]) && /default-src 'self'/.test(cspHeader[0]), 'equivalence: a $csp page still gets the merged policy', cspHeader);
  // Ghostery 2.18 applies $csp to top pages only (engine getCSPDirectives: isMainFrame), but frames
  // must still reach it, so a later version that serves frames too keeps working.
  check(ea.spy.headers.subFrame === URLS.length && ea.spy.headers.mainFrame === URLS.length, 'equivalence: every page and frame response still reaches the engine', ea.spy.headers);

  // The narrowed hook never ran for a non-document type; the request hook ran for all of them.
  const hdrInvokedTypes = new Set(rowsAfter.filter((r) => r.hdr.invoked).map((r) => r.type));
  check([...hdrInvokedTypes].sort().join() === 'mainFrame,subFrame', 'narrowed: the response hook was invoked for pages and frames only', [...hdrInvokedTypes]);
  const reqInvokedTypes = new Set(rowsAfter.filter((r) => r.req.invoked).map((r) => r.type));
  check(reqInvokedTypes.size === TYPES.length, 'unchanged: the request hook was invoked for every type, "other" included', [...reqInvokedTypes]);
  check(Object.keys(ea.spy.headers).sort().join() === 'mainFrame,subFrame', 'narrowed: the engine saw responses of pages and frames only', ea.spy.headers);
  check(Object.keys(eb.spy.headers).length === TYPES.length, 'baseline: the library alone sent every response type to the engine', Object.keys(eb.spy.headers).length);

  // The counters.
  const st = hooks.stats();
  check(st.requestTotal === TYPES.length * URLS.length && st.request.image === URLS.length && st.request.other === URLS.length, 'counters: request calls per type', st.request);
  check(st.headersTotal === 2 * URLS.length && st.headers.mainFrame === URLS.length && st.headers.subFrame === URLS.length && !st.headers.image, 'counters: response-hook calls per type (pages and frames only)', st.headers);
  check(st.headersFiltered === true && st.headersGated === 0, 'counters: filtered, nothing reached the in-handler gate', { f: st.headersFiltered, g: st.headersGated });
  // The fake clock moves 0.5 ms per read, two reads per call: 0.5 ms per call.
  check(st.requestMs === st.requestTotal * 0.5 && st.headersMs === st.headersTotal * 0.5 && st.requestMaxMs === 0.5, 'counters: time per hook summed from the clock', { r: st.requestMs, h: st.headersMs, m: st.requestMaxMs });
  const words = hooks.summaryWords();
  check(/^Ad blocker hooks since .*: 78 requests checked \(.*\); the response hook ran 12 times \(pages and frames only, about 66 calls saved\); 45 ms in the hooks in all \(request hook 39 ms, slowest call 0\.5 ms; response hook 6\.0 ms\)\.$/.test(words), 'counters: the quartz.log line', words);

  /* ---- 3. an Electron that refuses `types`: the in-handler gate ---- */
  const old = fakeSession({ refuseTypes: true });
  const eo = makeEngine();
  const logs = [];
  const hooksOld = H.createAdblockHooks({ ipcMain: ipcFake(), preloadPath: '/p.cjs', getBlocker: () => eo.engine, log: (l) => logs.push(l) });
  hooksOld.enable(old.session);
  check(old.reg.headers && !old.reg.headers.filter.types, 'fallback: the response hook registered without types', old.reg.headers && old.reg.headers.filter);
  check(logs.length === 1 && /could not limit its response hook/.test(logs[0]), 'fallback: says so in quartz.log, with the reason', logs);
  const rowsOld = runTable(old);
  let oldSame = 0;
  for (let i = 0; i < rowsBefore.length; i++) {
    if (stable(rowsBefore[i].req.answer) === stable(rowsOld[i].req.answer)
        && stable(rowsBefore[i].hdr.answer) === stable(rowsOld[i].hdr.answer)) oldSame++;
  }
  check(oldSame === rowsBefore.length, 'fallback: every answer still matches the baseline (' + oldSame + '/' + rowsBefore.length + ')');
  check(Object.keys(eo.spy.headers).sort().join() === 'mainFrame,subFrame', 'fallback: the gate keeps non-document responses away from the engine', eo.spy.headers);
  const so = hooksOld.stats();
  check(so.headersFiltered === false && so.headersTotal === rowsBefore.length && so.headersGated === rowsBefore.length - 2 * URLS.length, 'fallback: every response counted, the gated ones too', { t: so.headersTotal, g: so.headersGated });
  check(/\(unfiltered, 66 answered without the engine\)/.test(hooksOld.summaryWords()), 'fallback: the log line says unfiltered', hooksOld.summaryWords());

  /* ---- 4. disable clears exactly what it set ---- */
  hooks.disable();
  check(after.reg.headers === null && after.reg.request === null, 'disable: both events cleared');
  check(!after.dispatch('request', details('https://ads.example/banner', 'script')).invoked, 'disable: nothing is invoked afterwards');
} catch (err) {
  check(false, 'harness crashed', (err && err.stack) || String(err));
} finally {
  console.log(`adblock-hooks-harness: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
