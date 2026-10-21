require('./tools/lowcpu-optional.js');   // first: one capped browser at a time (2026-09-17)
// claudeanswer-e2e.js — the Claude answer end to end, against a REAL Quartz test instance and the
// MOCK Anthropic API (tests/anthropic-mock.js). Never the real API, never the user's profile.
//
//   node claudeanswer-e2e.js [--cdp 9250] [--keep]
//
// Quartz: --test-profile --profile-name=claude-answer, off-screen and never focused (testwatch.js
// OFFSCREEN_ARGS, whose watcher fails the run if the window ever touches the screen),
// QUARTZ_CLAUDE_API pointing at the mock (honoured for test profiles only). Not launched under
// 2.5 GB free RAM. Checks: the Settings > Search field (save, mask, never echoed, never in the
// page or localStorage, ENCRYPTED on disk with the real DPAPI), Check key, the mode / cap / model
// controls and their refusals, the usage line; then the search.html guest: an answer line printed by
// OUR page is answered through window.__applyAnswer (start / delta / done with citations), a stop
// line stops it, a fail state arrives with its reason, and the same line printed by a web page is
// ignored. Kills ONLY the process it started and deletes its temp profile. One summary line:
// "claudeanswer-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Cdp, serve, html } = require('./tests/e2e-kit');
const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher } = require('./testwatch');
const M = require('./tests/anthropic-mock');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9250'));
const KEEP = argv.includes('--keep');
const APP = __dirname;
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROFILE = 'claude-answer';
const PROFILE_DIR = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);
const KEY = M.GOOD_KEY_PREFIX + '-e2e-SECRET-0123456789';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
}
async function targets() { return (await fetch('http://127.0.0.1:' + CDP_PORT + '/json')).json(); }
async function waitTarget(pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 10000)) {
    try { const t = (await targets()).find(pred); if (t) return t; } catch (e) { /* not up yet */ }
    await sleep(120);
  }
  throw new Error('no such target');
}
function findStore(dir) {
  let out = '';
  (function walk(d, depth) {
    if (out || depth > 4) return;
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isFile() && n.name === 'claude-answer.json') { out = p; return; }
      if (n.isDirectory() && !/^(Cache|Code Cache|GPUCache|Service Worker|blob_storage|Partitions)$/i.test(n.name)) walk(p, depth + 1);
    }
  })(dir, 0);
  return out;
}

(async () => {
  let child = null, watcher = null, chrome = null, page = null, web = null, mock = null, site = null;
  try {
    const free = freeRamGb();
    if (!(free >= MIN_FREE_GB)) { console.log('claudeanswer-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    mock = await M.start();
    site = await serve((req, res, p) => (p === '/page.html' ? html(res, '<!doctype html><title>web page</title><p>a web page</p>') : false));
    watcher = startWatcher((l) => console.log('[e2e] ' + l));
    await watcher.ready;
    const env = Object.assign({}, process.env, { QUARTZ_CLAUDE_API: mock.base });
    child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + CDP_PORT, '--test-profile', '--profile-name=' + PROFILE, ...OFFSCREEN_ARGS], { cwd: APP, stdio: 'ignore', env });
    watcher.watch(child.pid);
    console.log('[e2e] quartz pid ' + child.pid + ', mock anthropic ' + mock.base);

    const ct = await waitTarget((x) => x.type === 'page' && /index\.html/.test(String(x.url)), 40000);
    chrome = await new Cdp(ct.webSocketDebuggerUrl).open();
    await chrome.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await chrome.waitFor('!!(window.Settings && window.api && typeof getActiveTab === "function" && Array.isArray(tabs) && tabs.length > 0)', 30000);
    const api = (expr) => chrome.ev('(async () => JSON.stringify(await window.api.claudeAnswer.' + expr + '))()').then((s) => JSON.parse(s));

    // ---- the bridge and a fresh profile ---------------------------------------------------------
    check(await chrome.ev('!!(window.api.claudeAnswer && typeof window.api.claudeAnswer.setConfig === "function")'), 'preload bridge: window.api.claudeAnswer');
    let desc = await api('describe()');
    check(desc && desc.hasKey === false && desc.mode === 'every' && desc.capUsd === 150 && desc.autoModel === 'claude-haiku-5-5' && desc.deepModel === 'claude-haiku-5-5' && desc.answerModel === 'claude-haiku-5-5', 'fresh profile: no key, defaults (Haiku for both)', desc);
    check(desc.canEncrypt === true, 'safeStorage (DPAPI) is available in the test instance', desc.canEncrypt);

    // ---- Settings > Search: the field --------------------------------------------------------------
    await chrome.ev("Settings.open('Search'), 1");
    await chrome.waitFor('Settings.isOpen() && !!document.querySelector("#set-claude-key")', 8000);
    const privacy = await chrome.ev("(document.querySelector('.set-claude-privacy') || {}).textContent || ''");
    check(/Without a key nothing is sent to Anthropic/.test(privacy) && /api\.anthropic\.com/.test(privacy) && /Brave still supplies the results list/.test(privacy), 'disclosure next to the field (no key)', privacy);
    check(/This month: \$0\.00 estimated · 0 answers \(cap \$150\.00\)\./.test(await chrome.ev("(document.querySelector('.set-claude-usage') || {}).textContent || ''")), 'usage line, fresh');
    check(/Quartz’s own estimate/.test(await chrome.ev("(document.querySelector('.set-claude-estimate') || {}).textContent || ''")) && /can’t see your real credit balance/.test(await chrome.ev("document.querySelector('.set-claude-estimate').textContent")), 'estimate labelled as Quartz’s own, no real balance');
    await chrome.ev(`(() => { const i = document.querySelector('#set-claude-key'); i.value = ${JSON.stringify(KEY)}; document.querySelector('.set-claude-save').click(); return 1; })()`);
    const ph = await chrome.waitFor(`(() => { const i = document.querySelector('#set-claude-key'); return i && i.placeholder.indexOf('••••') === 0 ? i.placeholder + '|' + i.value + '|' + i.type : null; })()`, 8000);
    check(ph === '••••6789||password', 'saved: the field shows only the mask, empty, password type', ph);
    check(/^With this key, each web search on Quartz results is sent to Anthropic/.test(await chrome.ev("document.querySelector('.set-claude-privacy').textContent")), 'disclosure says searches now go to Anthropic');
    check((await chrome.ev('JSON.stringify(localStorage) + document.documentElement.outerHTML')).indexOf('SECRET') < 0, 'the key is in neither localStorage nor the Settings DOM');
    desc = await api('describe()');
    check(desc.hasKey === true && JSON.stringify(desc).indexOf('SECRET') < 0, 'describe() over IPC: hasKey, never the key', desc.keyMask);
    const store = findStore(PROFILE_DIR);
    const raw = store ? fs.readFileSync(store, 'utf8') : '';
    let blob = '';
    try { blob = Buffer.from(JSON.parse(raw).keyEnc, 'base64').toString('latin1'); } catch (e) { blob = ''; }
    check(!!store && raw.indexOf('SECRET') < 0 && blob.length > 40 && blob.indexOf('SECRET') < 0, 'on disk: claude-answer.json holds only a DPAPI blob', store + ' blob ' + blob.length + ' bytes');

    // ---- Check key: GET /v1/models, free ---------------------------------------------------------------
    await chrome.ev("document.querySelector('.set-claude-check').click(), 1");
    const checked = await chrome.waitFor("(() => { const p = document.querySelector('.set-claude-status'); return p && /^Check/.test(p.textContent) ? p.textContent : null; })()", 8000);
    check(/^Checked: The key works\. Anthropic accepted it, and Claude Haiku 5\.5 is open to it\./.test(checked), 'Check key: works (needs only Haiku)', checked);
    const mreq = mock.requests.filter((r) => r.path.indexOf('/v1/models') === 0);
    check(mreq.length === 1 && mreq[0].method === 'GET' && mreq[0].key === KEY, 'Check key: one GET /v1/models with the key as x-api-key', mreq.length);

    // ---- mode, the one-model line, cap ---------------------------------------------------------------
    const pick = (sel, value) => chrome.ev(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
    await pick('#set-claude-mode', 'questions');
    await chrome.waitFor("(() => { const p = document.querySelector('.set-claude-privacy'); return p && /that reads as a question/.test(p.textContent); })()", 6000);
    check((await api('describe()')).mode === 'questions', 'mode select: saved in main, disclosure follows it');
    await pick('#set-claude-mode', 'every');
    await sleep(300);
    const modelLine = await chrome.ev("(document.querySelector('.set-claude-model') || {}).textContent || ''");
    check(/^Answers by Claude Haiku 5\.5 \(high effort\)/.test(modelLine) && /Deeper answer” searches more and writes more/.test(modelLine), 'one quiet read-only model line', modelLine);
    check(await chrome.ev("!document.querySelector('#set-claude-auto') && !document.querySelector('#set-claude-deep')"), 'no model selects any more');
    const noPick = await api('setConfig({ deepModel: "claude-sonnet-5-5" })');
    check(/only use Claude Haiku 5\.5/.test(noPick.error || '') && noPick.deepModel === 'claude-haiku-5-5', 'setConfig over IPC cannot pick another model', noPick.error);
    await chrome.ev("(() => { const i = document.querySelector('#set-claude-cap'); i.value = 'lots'; document.querySelector('.set-claude-capsave').click(); return 1; })()");
    const capErr = await chrome.waitFor("(() => { const p = document.querySelector('.set-claude-error'); return p ? p.textContent : null; })()", 6000);
    check(/^Not saved: the monthly cap must be a dollar amount/.test(capErr), 'cap: junk is refused out loud', capErr);
    await chrome.ev("(() => { const i = document.querySelector('#set-claude-cap'); i.value = '25'; document.querySelector('.set-claude-capsave').click(); return 1; })()");
    await chrome.waitFor("(() => { const p = document.querySelector('.set-claude-usage'); return p && /cap \\$25\\.00/.test(p.textContent); })()", 6000);
    check((await api('describe()')).capUsd === 25 && !(await chrome.ev("!!document.querySelector('.set-claude-error')")), 'cap: $25 saved, error gone');
    await chrome.ev('Settings.close(), 1');

    // ---- the search page guest ---------------------------------------------------------------------------
    await chrome.ev("Settings.set({ searchEngine: 'brave-api' }), 1");
    await chrome.ev(`(() => { const o = document.getElementById('omnibox'); o.focus(); o.value = 'quartz crystal';
      o.dispatchEvent(new Event('input', { bubbles: true }));
      o.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    const pt = await waitTarget((x) => x.type === 'webview' && /\/search\.html\?/.test(String(x.url)), 15000);
    page = await new Cdp(pt.webSocketDebuggerUrl).open();
    await page.waitFor('document.readyState === "complete"', 8000);
    // The redesigned page asks for its own answer on load (seq 1): let that finish first, then take over
    // __applyAnswer and speak with seqs from 101, so the page's own answer can never land in __ans.
    await page.waitFor("!!window.__answerState && ['done', 'fail', 'off', 'stopped'].includes(window.__answerState().view)", 15000).catch(() => 0);
    await page.ev("window.__ans = []; window.__applyAnswer = (o) => { if (o && o.seq >= 100) window.__ans.push(o); }; 1");
    const line = (o) => page.ev('console.log(' + JSON.stringify('quartz-search:answer ' + JSON.stringify(o)) + '), 1');
    const n0 = mock.requests.filter((r) => r.path === '/v1/messages').length;
    await line({ q: 'what is quartz', seq: 101, mode: 'auto' });
    const got = await page.waitFor("(() => { const d = window.__ans.find((o) => o.phase === 'done' || o.phase === 'fail'); return d ? JSON.stringify(window.__ans) : null; })()", 15000).then(JSON.parse);
    const done = got[got.length - 1];
    check(got[0].phase === 'start' && got[0].model === 'claude-haiku-5-5' && got[0].seq === 101, 'page: start with the quick model', got[0]);
    check(done.phase === 'done' && done.text === 'Quartz is a hard mineral made of silica [1], and it keeps time in watches [2][1] because it vibrates at a steady frequency.', 'page: done with [n] markers, lead-in dropped', done.text || done);
    check(got.filter((o) => o.phase === 'delta').map((o) => o.text).join('') === done.text, 'page: the deltas add up to the final text');
    check(Array.isArray(done.citations) && done.citations.length === 2 && done.citations[0].host === 'en.wikipedia.org' && done.costUsd > 0.01 && done.usage.searches === 1, 'page: citations, usage and cost', done.citations);
    check((await page.ev('document.documentElement.outerHTML + JSON.stringify(window.__ans)')).indexOf('SECRET') < 0, 'page: the key never reaches the guest');
    const r1 = mock.requests.filter((r) => r.path === '/v1/messages')[n0];
    check(r1 && r1.key === KEY && r1.body.model === 'claude-haiku-5-5' && r1.body.tools[0].type === 'web_search_20250305' && JSON.stringify(r1.body).indexOf('brave') < 0, 'wire: one Messages request, key only in x-api-key, no Brave results', r1 && r1.body && r1.body.tools);

    await page.ev('window.__ans = []; 1');
    await line({ q: 'mock:slow e2e', seq: 102, mode: 'ask' });
    await page.waitFor("window.__ans.some((o) => o.phase === 'delta')", 10000);
    await page.ev('console.log(' + JSON.stringify('quartz-search:answer-stop {"seq":102}') + '), 1');
    const stopped = await page.waitFor("(() => { const f = window.__ans.find((o) => o.phase === 'fail'); return f ? f : null; })()", 8000);
    check(stopped.state === 'stopped' && /You stopped this answer/.test(stopped.detail), 'page: the stop line stops it', stopped);
    await sleep(200);
    check(mock.requests.filter((r) => r.scenario === 'slow').every((r) => r.aborted), 'wire: the stopped fetch was aborted');

    await page.ev('window.__ans = []; 1');
    await line({ q: 'mock:credit e2e', seq: 103, mode: 'ask' });
    const cr = await page.waitFor("(() => { const f = window.__ans.find((o) => o.phase === 'fail'); return f ? f : null; })()", 8000);
    check(cr.state === 'no-credit' && /credit balance is too low/.test(cr.detail), 'page: no-credit arrives with Anthropic’s own message', cr.detail);
    await page.ev('window.__ans = []; 1');
    await line({ q: 'mock:nosearch deeper', seq: 104, mode: 'deep' });
    const dd = await page.waitFor("(() => { const f = window.__ans.find((o) => o.phase === 'done' || o.phase === 'fail'); return f ? f : null; })()", 8000);
    const rdeep = mock.requests.filter((r) => r.path === '/v1/messages').pop();
    check(dd.phase === 'done' && dd.model === 'claude-haiku-5-5' && rdeep.body.model === 'claude-haiku-5-5' && rdeep.body.max_tokens === 8192 && rdeep.body.tools[0].max_uses === 4 && rdeep.body.output_config.effort === 'high', 'page: "Deeper answer" is Haiku, 8192, 4 searches, high', dd.model);
    check(mock.requests.every((r) => r.beta === '' && !(r.body && 'fallbacks' in r.body)), 'no request carried fallbacks or the fallback beta header', mock.requests.length);

    // ---- a web page printing the same line is ignored ---------------------------------------------------
    const nBefore = mock.requests.length;
    await chrome.ev(`createTab(${JSON.stringify('http://127.0.0.1:' + site.port + '/page.html')}), 1`);
    const wt = await waitTarget((x) => x.type === 'webview' && /127\.0\.0\.1:\d+\/page\.html/.test(String(x.url)), 12000);
    web = await new Cdp(wt.webSocketDebuggerUrl).open();
    await web.waitFor('document.readyState === "complete"', 8000);
    await web.ev('console.log(' + JSON.stringify('quartz-search:answer ' + JSON.stringify({ q: 'mock:nosearch evil', seq: 1, mode: 'ask' })) + '), 1');
    await sleep(1200);
    check(mock.requests.length === nBefore, 'a web page printing the answer line spends nothing', mock.requests.length - nBefore);

    // ---- the month line in Settings after the answers ------------------------------------------------------
    await chrome.ev("Settings.open('Search'), 1");
    const usage = await chrome.waitFor("(() => { const p = document.querySelector('.set-claude-usage'); return p && /answers? \\(cap/.test(p.textContent) && !/· 0 answers/.test(p.textContent) ? p.textContent : null; })()", 8000);
    // 3: the page's own answer on load, 'what is quartz' and the deeper one (the stopped and the refused ones cost nothing).
    check(/^This month: \$0\.0\d estimated · 3 answers \(cap \$25\.00\)\./.test(usage), 'Settings: this month’s estimate and count', usage);
    const status = await chrome.ev("(document.querySelector('.set-claude-status') || {}).textContent || ''");
    check(/^Last answer: /.test(status), 'Settings: the last answer’s outcome is shown', status);
    // Remove the key: the guest is told "no key" without spending anything.
    await chrome.ev("document.querySelector('.set-claude-clear').click(), 1");
    await chrome.waitFor("(() => { const i = document.querySelector('#set-claude-key'); return i && i.placeholder === 'Paste your key (sk-ant-…)'; })()", 6000);
    await page.ev('window.__ans = []; 1');
    const nr = mock.requests.length;
    await line({ q: 'what is quartz again', seq: 105, mode: 'auto' });
    const off = await page.waitFor("window.__ans.length ? window.__ans[0] : null", 6000);
    check(off.phase === 'off' && off.reason === 'no-key' && mock.requests.length === nr, 'no key: the page gets "off: no-key", nothing sent', off);
    check(!/keyEnc/.test(fs.readFileSync(store, 'utf8')), 'Remove: the blob is gone from disk');
  } catch (e) {
    check(false, 'HARNESS ERROR ' + (e && e.stack || e));
  } finally {
    for (const c of [web, page, chrome]) { try { if (c) c.close(); } catch (e) { /* gone */ } }
    if (child && !KEEP) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ } }
    if (watcher) { await sleep(800); const v = watcher.verdict(); check(v.ok, v.line); watcher.stop(); }
    if (mock) await mock.close();
    if (site) site.close();
    if (!KEEP) { await sleep(1200); for (let i = 0; i < 10; i++) { try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); break; } catch (e) { await sleep(400); } } }
    console.log('claudeanswer-e2e: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
})();
