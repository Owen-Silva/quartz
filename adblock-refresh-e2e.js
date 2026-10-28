require('./tools/lowcpu-optional.js');   // first: one capped browser at a time
// adblock-refresh-e2e.js -- the ad-block list refresh end to end, against a REAL hidden Quartz test
// instance (--test-profile --profile-name=zl-adblock, off-screen, never focused).
//
//   node adblock-refresh-e2e.js [--cdp=9451]
//
// A local server stands in for the list host (QUARTZ_ADBLOCK_LIST_BASE, honoured only under
// --test-profile). The profile is seeded with a tiny engine dated three days back, so the refresher
// finds it due. The server first answers 503: the shield must say "Couldn't update filter lists:
// the list server answered 503. Using lists from 3 days ago." and the old engine must still be the
// one blocking. Then the server serves the lists, the retry swaps the new engine in, the shield says
// "Filter lists updated just now", the cache file on disk is the new one (.prev kept), and a reload
// shows a request only the NEW lists block being blocked. The hook counters (test profiles only)
// give the request vs response-hook call counts for one page.
//
// Kills only the processes it started (command line carries --profile-name=zl-adblock), never /T.
// One summary line: "adblock-refresh-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { serve, Cdp, sleep, APP } = require('./tests/e2e-kit');
const { OFFSCREEN_ARGS, startWatcher } = require('./testwatch');
const { FiltersEngine } = require('@ghostery/adblocker');
const W = require('./adblock-build-worker');

// --profile=<name> lets a second worktree run it without sharing the profile (default zl-adblock).
const PROFILE = (process.argv.find((a) => a.startsWith('--profile=')) || '--profile=zl-adblock').slice(10);
const PROFILE_DIR = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);
const CDP = Number((process.argv.find((a) => a.startsWith('--cdp=')) || '--cdp=9451').slice(6));
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined ? '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
}
const say = (l) => console.log('[e2e] ' + l);

/** Only our own instance: its main process carries --profile-name=zl-adblock. By PID, no tree walk. */
function killOurs() {
  let out = '';
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*--profile-name=" + PROFILE + "*' } | ForEach-Object { $_.ProcessId }"],
    { encoding: 'utf8' });
  } catch (e) { out = ''; }
  const pids = out.split(/\s+/).map(Number).filter((n) => n > 0);
  for (const pid of pids) { try { process.kill(pid); } catch (e) { /* gone */ } }
  return pids;
}

const SEED = '||seed-only.example^\n##.seed-ad\n';
const NEW = SEED + '/quartz-refresh-marker.gif\n||new-only.example^\n##.new-ad\n';
const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

(async () => {
  let child = null, chrome = null, watcher = null, server = null;
  try {
    /* ---- the list server and the test pages ---- */
    let mode = 'fail';
    server = await serve((req, res, p) => {
      if (p.startsWith('/lists/')) {
        if (mode === 'fail') { res.writeHead(503); res.end('busy'); return true; }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(p.endsWith('.json') ? '[]' : (p.endsWith('/easylist/easylist.txt') ? NEW : '! empty\n'));
        return true;
      }
      if (p === '/page.html') {
        let imgs = '';
        for (let i = 0; i < 20; i++) imgs += '<img src="/img' + i + '.gif" width=1 height=1>';
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end('<!doctype html><title>t</title><p>page</p>' + imgs + '<img src="/quartz-refresh-marker.gif" width=1 height=1>'
          + '<script src="/a.js"></script><iframe src="/frame.html"></iframe>');
        return true;
      }
      if (p === '/frame.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end('<p>frame</p>'); return true; }
      if (p === '/a.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); res.end('void 0;'); return true; }
      if (p.endsWith('.gif')) { res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }); res.end(GIF); return true; }
      return false;
    });
    const BASE = 'http://127.0.0.1:' + server.port;
    say('list server ' + BASE);

    /* ---- seed the profile with a tiny engine, three days old ---- */
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (e) { /* first run */ }
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROFILE_DIR, 'watch.json'), '{}');
    const seed = await W.buildEngine({ fetchImpl: async (u) => ({ ok: true, status: 200, headers: { get: () => 'text/plain' },
      text: async () => (u.endsWith('.json') ? '[]' : (u.endsWith('/easylist/easylist.txt') ? SEED : '! empty\n')) }) });
    const bin = path.join(PROFILE_DIR, 'adblock-engine.bin');
    fs.writeFileSync(bin, Buffer.from(seed.bytes));
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000 - 60000);
    fs.utimesSync(bin, old, old);
    say('seeded ' + seed.filters + ' filters, ' + seed.bytes.length + ' bytes, dated ' + old.toISOString());

    /* ---- launch ---- */
    watcher = startWatcher((l) => say(l));
    await watcher.ready;
    const env = Object.assign({}, process.env, {
      QUARTZ_ADBLOCK_LIST_BASE: BASE + '/lists/',
      QUARTZ_ADBLOCK_REFRESH_DELAY: '1500',
      QUARTZ_ADBLOCK_RETRY_MS: '4000',
    });
    child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + CDP, '--test-profile', '--profile-name=' + PROFILE, ...OFFSCREEN_ARGS],
      { cwd: APP, stdio: 'ignore', env });
    let gone = false;
    const exitP = new Promise((r) => child.on('exit', () => { gone = true; r(); }));
    watcher.watch(child.pid);
    say('quartz pid ' + child.pid + ' on :' + CDP);
    let ct = null;
    for (let i = 0; i < 200 && !ct && !gone; i++) {
      try { ct = (await (await fetch('http://127.0.0.1:' + CDP + '/json')).json()).find((x) => x.type === 'page' && /index\.html/.test(String(x.url))); } catch (e) { /* not up */ }
      if (!ct) await sleep(150);
    }
    if (!ct) throw new Error('the chrome page never came up' + (gone ? ' (the process exited)' : ''));
    chrome = await new Cdp(ct.webSocketDebuggerUrl).open();
    await chrome.waitFor('typeof createTab === "function" && Array.isArray(tabs) && tabs.length > 0 && !restoring && !!window.Shield', 30000);

    const state = () => chrome.ev('window.api.adblock.state()');
    const s0 = await chrome.waitFor('window.api.adblock.state().then((s) => s.ready ? s : null)', 20000);
    check(s0.ready === true, 'the seeded engine loads at startup (no network on the startup path)', s0.lists);

    /* ---- a page while the old engine is in use ---- */
    await chrome.ev(`(() => { createTab(${JSON.stringify(BASE + '/page.html')}); return 1; })()`);
    const wcIdExpr = '(() => { const t = tabs.find((x) => x.id === activeTabId); try { return t.viewEl.getWebContentsId(); } catch (e) { return null; } })()';
    await chrome.waitFor(wcIdExpr, 15000);
    await sleep(1500);
    const markerBefore = server.hits('/quartz-refresh-marker.gif');
    check(markerBefore >= 1, 'with the old lists the marker request goes through', markerBefore);

    /* ---- the refresh fails: the shield says why, the old engine stays ---- */
    const sFail = await chrome.waitFor('window.api.adblock.state().then((s) => s.lists && s.lists.error ? s : null)', 20000);
    check(sFail.lists.error === 'the list server answered 503', 'a failed refresh carries the plain reason', sFail.lists);
    check(sFail.ready === true, 'blocking stays on after a failed refresh', sFail.ready);
    await chrome.ev('window.Shield.open(), 1');
    const failText = await chrome.waitFor('(() => { const el = document.querySelector("#shield-panel .sh-status"); return el && /Couldn/.test(el.textContent) ? { text: el.textContent, warn: el.classList.contains("is-warn") } : null; })()', 5000);
    check(failText.text === 'Couldn’t update filter lists: the list server answered 503. Using lists from 3 days ago.', 'the shield says the failure and the age of the lists in use', failText.text);
    check(failText.warn === true, 'the failed status is tinted (is-warn)');
    check(fs.statSync(bin).mtimeMs < Date.now() - 2 * 24 * 3600 * 1000, 'a failed refresh leaves the cache file alone');

    /* ---- the server recovers: the retry swaps the new engine in ---- */
    mode = 'ok';
    const sOk = await chrome.waitFor('window.api.adblock.state().then((s) => s.lists && !s.lists.error && !s.lists.refreshing && s.lists.updatedAt > Date.now() - 60000 ? s : null)', 30000);
    check(!!sOk && sOk.ready, 'the retry succeeds and blocking is on', sOk && sOk.lists);
    const okText = await chrome.waitFor('(() => { const el = document.querySelector("#shield-panel .sh-status"); return el && /updated/.test(el.textContent) ? { text: el.textContent, warn: el.classList.contains("is-warn") } : null; })()', 5000);
    check(okText.text === 'Filter lists updated just now' && !okText.warn, 'the open shield updates in place to "Filter lists updated just now"', okText);
    const st = fs.statSync(bin);
    check(st.mtimeMs > Date.now() - 120000, 'the cache file on disk is the new one', new Date(st.mtimeMs).toISOString());
    let diskFilters = 0;
    try { const f = FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(bin))).getFilters(); diskFilters = f.networkFilters.length + f.cosmeticFilters.length; } catch (e) { diskFilters = -1; }
    check(diskFilters === 5, 'the new cache deserializes with the new lists (5 filters, raw: no unbreak/allow rules baked in)', diskFilters);
    check(fs.existsSync(bin + '.prev') && !fs.existsSync(bin + '.tmp'), '.prev kept, no temp file left');
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'adblock-engine.json'), 'utf8')); } catch (e) { meta = null; }
    check(meta && meta.filters === 5, 'the new filter count is saved for the next shrink check', meta);

    /* ---- the new engine is the one blocking ---- */
    const statsBefore = (await state()).hooks;
    await chrome.ev('(() => { const t = tabs.find((x) => x.id === activeTabId); t.viewEl.reloadIgnoringCache(); return 1; })()');
    await sleep(2500);
    const markerAfter = server.hits('/quartz-refresh-marker.gif');
    check(markerAfter === markerBefore, 'after the swap the marker request (new lists only) is blocked', { markerBefore, markerAfter });
    const wcId = await chrome.ev(wcIdExpr);
    const count = await chrome.ev('window.api.adblock.count(' + wcId + ')');
    check(count && count.blocked >= 1, 'the shield count sees the block', count);

    /* ---- the hook counters for one page load ---- */
    const statsAfter = (await state()).hooks;
    const delta = (a, b) => { const o = {}; for (const k of Object.keys(b || {})) { const d = (b[k] || 0) - ((a || {})[k] || 0); if (d) o[k] = d; } return o; };
    const req = delta(statsBefore.request, statsAfter.request);
    const hdr = delta(statsBefore.headers, statsAfter.headers);
    const reqN = Object.values(req).reduce((a, b) => a + b, 0);
    const hdrN = Object.values(hdr).reduce((a, b) => a + b, 0);
    const msOf = (a, b, k) => Math.round(((b && b[k]) || 0) * 100 - ((a && a[k]) || 0) * 100) / 100;
    say('one reload of a 24-subresource page: request hook ' + reqN + ' ' + JSON.stringify(req) + ' in ' + msOf(statsBefore, statsAfter, 'requestMs')
      + ' ms; headers hook ' + hdrN + ' ' + JSON.stringify(hdr) + ' in ' + msOf(statsBefore, statsAfter, 'headersMs') + ' ms');
    check(typeof statsAfter.requestMs === 'number' && statsAfter.requestMs >= 0 && (statsAfter.headersGated || 0) === 0, 'the hooks time themselves, and nothing needed the in-handler gate', { ms: statsAfter.requestMs, gated: statsAfter.headersGated });
    check(statsAfter.headersFiltered === true, 'the headers hook took the types filter in Electron 44');
    check(Object.keys(hdr).every((k) => k === 'mainFrame' || k === 'subFrame') && hdrN >= 1, 'the headers hook only ever sees pages and frames', hdr);
    check(reqN > hdrN + 15, 'the request hook still sees every subresource (blocking unchanged)', { reqN, hdrN });

    /* ---- quartz.log ---- */
    let qlog = '';
    try { qlog = fs.readFileSync(path.join(PROFILE_DIR, 'quartz.log'), 'utf8'); } catch (e) { qlog = ''; }
    check(/could not update its filter lists \(the list server answered 503\); still using lists from 3 days ago/.test(qlog), 'quartz.log records the failure with its reason');
    check(/filter lists were updated \(5 filters, was 2;/.test(qlog), 'quartz.log records the update', (qlog.match(/.*filter lists were.*/) || [''])[0]);

    /* ---- quit ---- */
    await chrome.ev('setTimeout(() => window.close(), 50), 1').catch(() => 0);
    chrome.close(); chrome = null;
    await Promise.race([exitP, sleep(20000)]);
    check(gone, 'Quartz quit cleanly');
    const v = watcher.verdict(); check(v.ok, v.line); watcher.stop(); watcher = null;
  } catch (e) {
    check(false, 'HARNESS ERROR ' + ((e && e.stack) || e));
  } finally {
    if (chrome) try { chrome.close(); } catch (e) { /* closed */ }
    const killed = killOurs();
    if (killed.length) say('killed leftover pids ' + killed.join(','));
    if (watcher) { const v = watcher.verdict(); check(v.ok, v.line); watcher.stop(); }
    if (server) server.close();
    await sleep(1200);
    for (let i = 0; i < 10; i++) { try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
    console.log(`adblock-refresh-e2e: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
