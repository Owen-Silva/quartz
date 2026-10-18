try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine: no cap needed */ }
// search-page-e2e.js — the redesigned results page and its Claude answer panel, end to end, on a REAL
// Quartz test instance against a MOCK Brave API. Never the real Brave or Claude APIs, never the user's
// profile or keys: the Brave key is a fixture written into a temp test profile, and Claude's side is
// played by this file calling window.__applyAnswer over CDP with fixture events.
//
//   node search-page-e2e.js [--app <dir>] [--cdp 9255] [--profile search-redesign] [--shots <dir>]
//                           [--prefix search-after] [--before] [--cert <dir with cert.pem/key.pem>]
//
// --before: screenshots only (for an older build with no answer panel): the rich query at three
// sizes, dark and light. Otherwise: the rich layout follows Brave's `mixed` (modules between results,
// the infobox in the side column); the auto answer line goes out; the panel's skeleton, streaming,
// safe rendering of hostile model text, stale seq, citations, Show more, Copy, Deeper, Stop (main's
// answer and the local fallback), follow-up with history, every fail state, the three off states,
// no reply, cancel on leaving the page, keyboard navigation, light/dark; then the screenshots.
// --cert: an https server for the fixture's thumbnails and favicons (Electron gets
// --ignore-certificate-errors, a test-only flag); without it the images fail and show their wells.
// Kills ONLY the process it started, deletes its temp profile. One summary line:
// "search-page-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APP = path.resolve(opt('app', __dirname));
const CDP_PORT = Number(opt('cdp', '9255'));
const PROFILE = opt('profile', 'search-redesign');
const PROFILE_DIR = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);
const SHOTS = path.resolve(opt('shots', path.join(os.tmpdir(), 'quartz-search-page-shots')));
const PREFIX = opt('prefix', 'search-after');
const BEFORE = argv.includes('--before');
const CERT = opt('cert', '');
const KEEP = argv.includes('--keep');
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const WS = require(path.join(APP, 'node_modules', 'ws'));
const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher } = require(path.join(APP, 'testwatch'));
const F = require('./tests/brave-fixtures');
const GOOD = 'good-key-e2e-5e4d';
const Q = 'claude ai';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + String(detail).slice(0, 300) : ''));
}

/* ---- the mock Brave, and fixture images ------------------------------------------------- */
const apiLog = [];
let imgBase = 'https://127.0.0.1:9/img/';   // nothing listens: images fail fast without --cert
function localImages(obj) { return JSON.parse(JSON.stringify(obj).replace(/https:\/\/imgs\.search\.brave\.com\//g, imgBase)); }
const api = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const key = String(req.headers['x-subscription-token'] || '');
  const q = u.searchParams.get('q') || '';
  apiLog.push({ path: u.pathname, q, key });
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!key.startsWith('good-')) return send(422, F.ERRORS.badKey());
  if (u.pathname === '/res/v1/news/search') return send(200, localImages(F.news(q)));
  if (u.pathname === '/res/v1/videos/search') return send(200, localImages(F.videos(q)));
  if (u.pathname === '/res/v1/web/search') return send(200, localImages(/claude/i.test(q) ? F.richWeb(q) : F.web(q, 8)));
  return send(404, F.error(404, 'NOT_FOUND', 'No such endpoint'));
});
function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function fixtureSvg(p) {
  const name = path.basename(p).replace(/\.\w+$/, '');
  const h = hue(name);
  if (/\/fav\//.test(p)) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="hsl(' + h + ' 32% 46%)"/>' +
      '<text x="16" y="22" font-family="Segoe UI" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">' + name.charAt(0).toUpperCase() + '</text></svg>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="hsl(' + h + ' 28% 34%)"/><stop offset="1" stop-color="hsl(' + ((h + 40) % 360) + ' 30% 18%)"/></linearGradient></defs>' +
    '<rect width="480" height="270" fill="url(#g)"/><circle cx="' + (120 + h % 240) + '" cy="120" r="70" fill="hsl(' + ((h + 180) % 360) + ' 30% 70% / .25)"/>' +
    '<rect x="40" y="200" width="220" height="16" rx="8" fill="hsl(0 0% 100% / .22)"/></svg>';
}
const listen = (srv, port) => new Promise((r, j) => { srv.once('error', j); srv.listen(port, '127.0.0.1', () => r(srv.address().port)); });

/* ---- CDP ---------------------------------------------------------------------------------- */
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.events = []; }
  async open() {
    this.ws = new WS(this.wsUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { this.ws.on('open', r); this.ws.on('error', j); });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.method === 'Runtime.consoleAPICalled') {
        const a = (m.params.args || [])[0];
        if (a && typeof a.value === 'string') this.events.push(a.value);
      }
      const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m); }
    });
    return this;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
  async ev(expr) {
    const m = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (m.error) throw new Error(JSON.stringify(m.error));
    if (m.result.exceptionDetails) throw new Error('threw: ' + ((m.result.exceptionDetails.exception || {}).description || m.result.exceptionDetails.text));
    return m.result.result.value;
  }
  async waitFor(expr, ms) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < (ms || 10000)) { try { last = await this.ev(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(80); }
    throw new Error('timed out: ' + expr.slice(0, 160) + ' (last ' + JSON.stringify(last).slice(0, 200) + ')');
  }
  async key(key, text, code, vk) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: code || '', text: text || '', windowsVirtualKeyCode: vk || 0 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: code || '', windowsVirtualKeyCode: vk || 0 });
  }
  close() { try { this.ws.close(); } catch (e) { /* gone */ } }
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

/* ---- the answer Claude "gives", as fixture events --------------------------------------- */
const ANSWER = [
  '**Claude** is an AI assistant made by Anthropic [1]. You can use it on the web, in desktop and phone apps, and through an API [2].\n\n',
  'What it is good at:\n- Writing and editing, from emails to long reports [1]\n- Reading files you upload: PDFs, images and spreadsheets [3]\n',
  '- Code: explaining, writing and fixing it, including in your terminal with `claude` [2]\n\n',
  'There is a free plan with daily limits, and paid plans with higher limits [1][3].',
];
const CITES = [
  { n: 1, url: 'https://claude.ai/', title: 'Claude', host: 'claude.ai' },
  { n: 2, url: 'https://www.anthropic.com/claude', title: 'Meet Claude \\ Anthropic', host: 'anthropic.com' },
  { n: 3, url: 'https://en.wikipedia.org/wiki/Claude_(language_model)', title: 'Claude (language model) - Wikipedia', host: 'en.wikipedia.org' },
  { n: 4, url: 'javascript:alert(1)', title: 'hostile', host: 'x' },
];
const FAILS = [
  ['no-key', 'No Claude API key', 'Add one in Settings.', true, true],
  ['bad-key', 'Anthropic rejected the saved key', '401 authentication_error: invalid x-api-key (key ••••9f2c).', true, true],
  ['rate-limited', 'Too many answers at once', '429 rate_limit_error: try again in 20 seconds.', true, false],
  ['overloaded', 'Claude is busy right now', '529 overloaded_error: Anthropic is overloaded.', true, false],
  ['no-credit', 'Your Anthropic credit has run out', '400 invalid_request_error: credit balance is too low.', false, true],
  ['cap-reached', 'Today\'s answer budget is spent', 'You set $1.00 a day in Settings; $1.00 used.', false, true],
  ['offline', 'Can\'t reach Anthropic', 'The connection was refused (ECONNREFUSED).', true, false],
  ['server', 'Anthropic had a problem', '500 api_error: Internal server error.', true, false],
  ['bad-answer', 'The answer could not be read', 'The stream ended without a message_stop event.', true, false],
];

(async () => {
  let child = null, watcher = null, chrome = null, page = null, imgSrv = null;
  try {
    const free = freeRamGb();
    if (!(free >= MIN_FREE_GB)) { console.log('search-page-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }
    const apiPort = await listen(api, 0);
    if (CERT && fs.existsSync(path.join(CERT, 'cert.pem'))) {
      imgSrv = https.createServer({ cert: fs.readFileSync(path.join(CERT, 'cert.pem')), key: fs.readFileSync(path.join(CERT, 'key.pem')) }, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=600' }); res.end(fixtureSvg(req.url));
      });
      imgBase = 'https://127.0.0.1:' + (await listen(imgSrv, 0)) + '/img/';
    }
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROFILE_DIR, 'brave-search.json'), JSON.stringify({ key: GOOD }));   // a fixture key in a temp profile
    watcher = startWatcher((l) => console.log('[e2e] ' + l));
    await watcher.ready;
    const env = Object.assign({}, process.env, { QUARTZ_BRAVE_API: 'http://127.0.0.1:' + apiPort + '/res/v1' });
    const args = ['.', '--remote-debugging-port=' + CDP_PORT, '--test-profile', '--profile-name=' + PROFILE, ...OFFSCREEN_ARGS];
    if (imgSrv) args.push('--ignore-certificate-errors');
    child = spawn(ELECTRON, args, { cwd: APP, stdio: 'ignore', env });
    watcher.watch(child.pid);
    console.log('[e2e] quartz pid ' + child.pid + ' (' + APP + '), mock api :' + apiPort + (imgSrv ? ', images ' + imgBase : ', no images'));

    const ct = await waitTarget((x) => x.type === 'page' && /index\.html/.test(String(x.url)), 30000);
    chrome = await new Cdp(ct.webSocketDebuggerUrl).open();
    await chrome.waitFor('!!(window.Settings && typeof getActiveTab === "function" && typeof setThemeMode === "function")', 20000);
    await chrome.ev("Settings.set({ searchEngine: 'brave-api' }), 1");
    const SEARCH_RE = /\/search\.html\?/;
    const search = async (text) => {
      await chrome.ev(`(() => { const o = document.getElementById('omnibox'); o.focus(); o.value = ${JSON.stringify(text)};
        o.dispatchEvent(new Event('input', { bubbles: true }));
        o.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
      await chrome.ev('document.getElementById("omnibox").blur(), window.History && window.History.close && window.History.close(), 1').catch(() => 0);
    };
    await search(Q);
    const t = await waitTarget((x) => x.type === 'webview' && SEARCH_RE.test(String(x.url)), 15000);
    page = await new Cdp(t.webSocketDebuggerUrl).open();
    await page.send('Runtime.enable');
    const settle = (pred) => page.waitFor(`(() => { const s = window.__searchState && window.__searchState(); return s && s.phase !== 'loading' && (${pred}) ? s : null; })()`, 12000);
    let s = await settle("s.phase === 'ok'");

    const theme = async (mode) => {
      await chrome.ev(`setThemeMode('${mode}'), 1`);
      await page.waitFor(`document.documentElement.getAttribute('data-theme') === '${mode}'`, 5000);
      await sleep(200);
    };
    const shot = async (name, w, h) => {
      await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await page.ev('window.scrollTo(0, 0), 1');
      await sleep(500);
      const m = await page.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOTS, PREFIX + '-' + name + '.png');
      if (m.result && m.result.data) fs.writeFileSync(file, Buffer.from(m.result.data, 'base64'));
      return m.result && m.result.data ? file : 'NO DATA ' + JSON.stringify(m.error || {}).slice(0, 120);
    };
    const SIZES = [[1536, 800], [1920, 1000], [1280, 800]];

    if (BEFORE) {
      for (const mode of ['dark', 'light']) {
        await theme(mode);
        for (const [w, h] of SIZES) console.log('[e2e] shot ' + await shot(w + 'x' + h + '-' + mode, w, h));
      }
      check(s.results >= 10, 'before: the old page rendered the rich query', s.results);
      return;
    }

    // ---- the rich layout ------------------------------------------------------------------
    check(s.results === 10 && s.sitelinks === 5, 'rich query: 10 results, 5 sitelinks (the javascript: one dropped)', JSON.stringify(s).slice(0, 200));
    check(JSON.stringify(s.modules) === '["news","faq","videos","discussions"]' && JSON.stringify(s.side) === '["infobox"]', 'Brave\'s modules where mixed puts them; infobox in the side', s.modules + ' | ' + s.side);
    const order = await page.ev(`[...document.querySelectorAll('#sr-results > li')].map((li) => li.classList.contains('sr-module') ? li.dataset.module : li.querySelector('.sr-host').textContent).join(',')`);
    check(order === 'claude.ai,anthropic.com,news,en.wikipedia.org,docs.anthropic.com,faq,theverge.com,videos,github.com,reddit.com,discussions,apps.apple.com,play.google.com,zdnet.com', 'DOM order is Brave\'s mixed.main order', order);
    const safe = await page.ev(`({ scripts: document.querySelectorAll('script').length, js: [...document.querySelectorAll('a')].some((a) => /^javascript:/i.test(a.getAttribute('href') || '')),
      attrib: [...document.querySelectorAll('.sr-attrib')].filter((a) => a.getBoundingClientRect().height > 0 && /Powered by Brave/.test(a.textContent)).length,
      markup: [...document.querySelectorAll('.sr-ib-fact dd')].map((d) => d.textContent).find((t) => t.includes('stays')) || '' })`);
    check(safe.scripts === 3 && !safe.js && safe.attrib === 2 && safe.markup === '<b>stays</b> text', 'no injected script or javascript: link; both POWERED BY BRAVE shown; infobox markup stays text', JSON.stringify(safe));
    const geo = async (w) => {
      await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
      await sleep(250);
      return page.ev(`(() => { const c = document.getElementById('sr-col').getBoundingClientRect(), d = document.getElementById('sr-side').getBoundingClientRect(), q = document.getElementById('qa').getBoundingClientRect();
        return { colL: Math.round(c.left), colW: Math.round(c.width), sideL: Math.round(d.left), sideW: Math.round(d.width), sideTop: Math.round(d.top), qaW: Math.round(q.width), qaBottom: Math.round(q.bottom), sx: document.documentElement.scrollWidth }; })()`);
    };
    for (const w of [1536, 1920, 1280]) {
      const g = await geo(w);
      check(g.sideL >= g.colL + g.colW + 40 && g.colW >= 700 && g.sideW >= 360 && g.sx <= w, w + ' px: two columns, results at reading width, the panel beside them, no sideways scroll', JSON.stringify(g));
    }
    const g1000 = await geo(1000);
    check(g1000.sideL === g1000.colL && g1000.sideTop >= g1000.qaBottom && g1000.sx <= 1000, '1000 px: one column, the panel between the answer and the results', JSON.stringify(g1000));
    await page.send('Emulation.clearDeviceMetricsOverride');

    // ---- the answer: the auto line, skeleton, streaming --------------------------------------
    const A = () => page.ev('window.__answerState()');
    const apply = (o) => page.ev('window.__applyAnswer(' + JSON.stringify(o) + ')');
    let a = await A();
    const first = JSON.parse((a.sent[0] || '').replace('quartz-search:answer ', '') || '{}');
    check(first.q === Q && first.mode === 'auto' && first.seq === 1 && Array.isArray(first.history) && first.history.length === 0, 'a web search sends quartz-search:answer mode "auto"', a.sent[0]);
    check(a.view === 'pending' && a.skeleton === 1 && a.controls.stop && /Thinking/.test(a.status), 'pending: skeleton, Stop, "Thinking"', JSON.stringify(a).slice(0, 220));
    check(await apply({ seq: 1, phase: 'start', model: 'claude-haiku-5-5', mode: 'auto' }), 'start accepted');
    a = await A();
    check(a.modelLabel === 'Haiku 5.5' && a.view === 'streaming' && a.skeleton === 1, 'start: the model label, still the skeleton until text', a.modelLabel + ' / ' + a.view);
    await apply({ seq: 1, phase: 'delta', text: ANSWER[0] });
    await apply({ seq: 1, phase: 'delta', text: ANSWER[1] });
    await apply({ seq: 1, phase: 'delta', text: 'Hostile: <img src=x onerror="window.__pwned=3"><script>window.__pwned=4</script> **unclosed bold' });
    await sleep(120);
    a = await A();
    const dom = await page.ev(`({ pwned: window.__pwned || null, imgs: document.querySelectorAll('#qa img').length, scripts: document.querySelectorAll('script').length,
      strong: document.querySelectorAll('#qa .qa-body strong').length, li: document.querySelectorAll('#qa .qa-list li').length })`);
    check(!dom.pwned && dom.imgs === 0 && dom.scripts === 3 && /<img src=x onerror/.test(a.bodyText) && dom.strong >= 2 && dom.li === 2, 'streaming: markdown subset rendered, hostile text stays text', JSON.stringify(dom));
    check(a.pendingCites >= 3 && a.cites === 0 && a.skeleton === 0, 'streaming: [n] markers are numbered chips until the sources arrive', a.pendingCites + ' pending, ' + a.cites + ' linked');
    console.log('[e2e] shot ' + await shot('1536x800-dark-streaming', 1536, 800));
    await theme('light');
    console.log('[e2e] shot ' + await shot('1536x800-light-streaming', 1536, 800));
    await theme('dark');
    check(await apply({ seq: 0, phase: 'delta', text: 'STALE' }) === false && await apply({ seq: 7, phase: 'delta', text: 'FUTURE' }) === false && !(await A()).text.includes('STALE'), 'a stale or unknown seq is ignored');
    const full = ANSWER.join('');
    await apply({ seq: 1, phase: 'done', text: full + '\n\n' + 'More detail. '.repeat(60), citations: CITES, usage: { input_tokens: 1840, output_tokens: 212 }, costUsd: 0.0087 });
    await sleep(120);
    a = await A();
    const links = await page.ev(`[...document.querySelectorAll('#qa a.qa-cite')].map((x) => x.getAttribute('href') + '|' + x.textContent)`);
    check(a.view === 'done' && a.cites === 7 && links[0] === 'https://claude.ai/|1claude.ai' && a.sources === 3, 'done: citation chips link to their sources and show the host; the javascript: one is not linked', links.slice(0, 3).join(' ; ') + ' / sources ' + a.sources);
    check(a.controls.copy && a.controls.deeper && !a.controls.stop && a.controls.follow && a.controls.more, 'done: Copy, Deeper answer, follow-up, Show more; no Stop', JSON.stringify(a.controls));
    check(/\$0\.009 · 1,840 in · 212 out/.test(await page.ev("document.querySelector('.qa-cost').textContent")), 'done: cost and tokens shown');
    const hBefore = await page.ev("document.querySelector('.qa-clip').getBoundingClientRect().height");
    await page.ev("document.querySelector('.qa-more').click(), 1");
    await sleep(80);
    const hAfter = await page.ev("document.querySelector('.qa-clip').getBoundingClientRect().height");
    check(hAfter > hBefore + 100 && (await page.ev("document.querySelector('.qa-more').textContent")) === 'Show less', 'Show more opens the long answer', hBefore + ' -> ' + hAfter);
    await page.ev("document.querySelector('.qa-more').click(), 1");
    await page.ev("document.querySelector('.qa-copy').click(), 1");
    const copied = await page.waitFor("(() => { const t = document.querySelector('.qa-copy').textContent; return t !== 'Copy' ? t : null; })()", 3000).catch(() => 'Copy');
    check(copied === 'Copied' || /^Copy failed/.test(copied), 'Copy says what happened', copied);
    // The done screenshots (rich page + answer) at every size, both themes.
    await apply({ seq: 1, phase: 'done', text: full, citations: CITES, usage: { input_tokens: 1840, output_tokens: 212 }, costUsd: 0.0087 });
    for (const mode of ['dark', 'light']) {
      await theme(mode);
      for (const [w, h] of SIZES) console.log('[e2e] shot ' + await shot(w + 'x' + h + '-' + mode + '-done', w, h));
    }
    await theme('dark');
    await page.send('Emulation.clearDeviceMetricsOverride');
    // (The second done above was ignored: seq 1 was already done. The panel kept the long text.)

    // ---- main's extras: a second start restarts, done carries cached / truncated / searchErrors --
    await page.ev(`window.QuartzAnswer.begin(${JSON.stringify(Q)}), 1`);
    let xs = (await A()).seq;
    await apply({ seq: xs, phase: 'start', model: 'claude-sonnet-4-5', modelLabel: 'Sonnet 4.5', mode: 'auto' });
    await apply({ seq: xs, phase: 'delta', text: 'From the first model, half way' });
    await apply({ seq: xs, phase: 'start', model: 'claude-haiku-4-5', modelLabel: 'Haiku 4.5 (fallback)', mode: 'auto', fallback: true });
    a = await A();
    check(a.seq === xs && a.text === '' && a.skeleton === 1 && a.modelLabel === 'Haiku 4.5 (fallback)', 'a second start for the same seq clears and restarts (skeleton, new model label)', a.text + ' / ' + a.modelLabel);
    await apply({ seq: xs, phase: 'delta', text: 'Deltas that the final text replaces' });
    await apply({ seq: xs, phase: 'done', text: 'The final answer [1].', citations: CITES.slice(0, 1), usage: { input: 900, output: 40, searches: 2 }, costUsd: 0.004, truncated: true, searchErrors: ['max_uses_exceeded'] });
    a = await A();
    const extras = await page.ev("({ t: (document.querySelector('.qa-truncated') || {}).textContent || '', e: (document.querySelector('.qa-search-errors') || {}).textContent || '', c: document.querySelector('.qa-cost').textContent, label: document.querySelector('.qa-label').textContent })");
    check(a.text === 'The final answer [1].' && /^The final answer/.test(a.bodyText) && !/Deltas/.test(a.bodyText), 'done.text replaces the deltas', a.bodyText);
    check(/^Answer cut short/.test(extras.t) && /max_uses_exceeded/.test(extras.e) && /\$0\.004 · 900 in · 40 out · 2 web searches/.test(extras.c) && extras.label === 'Answer by Claude',
      'truncated and searchErrors are shown quietly; usage with searches; "Answer by Claude" label', JSON.stringify(extras));
    await page.ev(`window.QuartzAnswer.begin(${JSON.stringify(Q)}), 1`);
    xs = (await A()).seq;
    await apply({ seq: xs, phase: 'start', model: 'claude-sonnet-4-5', mode: 'auto' });
    await apply({ seq: xs, phase: 'done', text: 'Remembered answer.', citations: [], cached: true, costUsd: 0 });
    check(/From memory, nothing spent/.test(await page.ev("document.querySelector('.qa-cost').textContent")), 'a cached answer says it cost nothing');
    await page.ev(`window.QuartzAnswer.begin(${JSON.stringify(Q)}), 1`);
    xs = (await A()).seq;
    await apply({ seq: xs, phase: 'fail', state: 'server', title: 'Anthropic had a problem', detail: '500 api_error', retry: true, settings: false, costUsd: 0.0021 });
    check(/\$0\.002 spent before it failed/.test(await page.ev("document.querySelector('.qa-cost').textContent")), 'a fail that cost money says so');
    // Back to a finished answer for the follow-up.
    await page.ev(`window.QuartzAnswer.begin(${JSON.stringify(Q)}), 1`);
    xs = (await A()).seq;
    await apply({ seq: xs, phase: 'start', model: 'claude-haiku-5-5', mode: 'auto' });
    await apply({ seq: xs, phase: 'done', text: full, citations: CITES, usage: { input_tokens: 1840, output_tokens: 212 }, costUsd: 0.0087 });

    // ---- follow-up ---------------------------------------------------------------------------
    await page.ev(`(() => { const i = document.querySelector('.qa-input'); i.focus(); i.value = 'Is there a free plan?'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
    a = await A();
    const fu = JSON.parse(a.sent[a.sent.length - 1].replace('quartz-search:answer ', ''));
    check(fu.mode === 'ask' && fu.q === 'Is there a free plan?' && fu.seq === xs + 1 && fu.history.length === 2 && fu.history[0].role === 'user' && fu.history[0].text === Q && fu.history[1].role === 'assistant' && fu.history[1].text.startsWith('**Claude**'), 'follow-up: mode "ask" with the conversation as history', JSON.stringify(fu).slice(0, 200));
    await apply({ seq: xs + 1, phase: 'start', model: 'claude-sonnet-4-5', mode: 'ask' });
    await apply({ seq: xs + 1, phase: 'delta', text: 'Yes: the free plan has daily limits [1].' });
    await apply({ seq: xs + 1, phase: 'done', text: 'Yes: the free plan has daily limits [1].', citations: CITES.slice(0, 1) });
    a = await A();
    check(a.turns === 2 && a.view === 'done' && /You asked/.test(await page.ev("document.querySelector('.qa-turn:last-child .qa-asked').textContent")), 'follow-up answers in place, under "You asked"', a.turns + ' turns');

    // ---- Deeper answer, Stop (main answers it, and the local fallback) --------------------------
    await page.ev("document.querySelector('.qa-deeper').click(), 1");
    a = await A();
    const deep = JSON.parse(a.sent[a.sent.length - 1].replace('quartz-search:answer ', ''));
    check(deep.mode === 'deep' && deep.seq === xs + 2 && deep.q === 'Is there a free plan?' && a.view === 'pending', 'Deeper answer re-asks the latest question in mode "deep"', JSON.stringify(deep).slice(0, 160));
    await apply({ seq: xs + 2, phase: 'start', model: 'claude-opus-4-1', mode: 'deep' });
    await apply({ seq: xs + 2, phase: 'delta', text: 'Partly written' });
    await page.ev("document.querySelector('.qa-stop').click(), 1");
    a = await A();
    check(a.sent[a.sent.length - 1] === 'quartz-search:answer-stop {"seq":' + (xs + 2) + '}' && a.turnState === 'stopping', 'Stop sends answer-stop for the seq in flight', a.sent[a.sent.length - 1]);
    await apply({ seq: xs + 2, phase: 'fail', state: 'stopped', title: 'Stopped', detail: '', retry: true, settings: false });
    a = await A();
    check(a.view === 'stopped' && a.text === 'Partly written' && a.controls.retry && a.controls.follow, 'stopped: what arrived stays, with Retry', a.view + ' / ' + a.text);
    await page.ev('window.__answerConfig({ stopGraceMs: 300, noReplyMs: 700 }), 1');
    await page.ev("document.querySelector('.qa-act-retry').click(), 1");
    a = await A();
    await apply({ seq: a.seq, phase: 'start', model: 'claude-opus-4-1', mode: 'deep' });
    await page.ev("document.querySelector('.qa-stop').click(), 1");
    await page.waitFor("window.__answerState().view === 'stopped'", 4000).catch(() => 0);
    a = await A();
    check(a.view === 'stopped', 'Stop with no reply from main: the page stops on its own', a.view);

    // ---- every fail state ---------------------------------------------------------------------
    for (const [state, title, detail, retry, settings] of FAILS) {
      await page.ev(`window.QuartzAnswer.begin(${JSON.stringify(Q)}), 1`);
      const sq = (await A()).seq;
      await apply({ seq: sq, phase: 'start', model: 'claude-sonnet-4-5', mode: 'auto' });
      await apply({ seq: sq, phase: 'fail', state, title, detail, retry, settings });
      a = await A();
      check(a.view === 'fail' && a.fail.state === state && a.fail.title === title && a.fail.detail === detail && a.controls.retry === retry && a.controls.settings === settings,
        'fail ' + state + ': title, detail' + (retry ? ', Retry' : '') + (settings ? ', Open Settings' : ''), JSON.stringify(a.fail) + ' ' + JSON.stringify(a.controls));
      if (state === 'rate-limited') {
        console.log('[e2e] shot ' + await shot('1536x800-dark-fail', 1536, 800));
        await theme('light');
        console.log('[e2e] shot ' + await shot('1536x800-light-fail', 1536, 800));
        await theme('dark');
        await page.send('Emulation.clearDeviceMetricsOverride');
      }
    }
    await page.ev(`window.QuartzAnswer.begin(${JSON.stringify(Q)}), 1`);
    xs = (await A()).seq;
    await apply({ seq: xs, phase: 'start', model: 'claude-haiku-5-5', modelLabel: 'Claude Haiku 5.5', mode: 'auto' });
    await apply({ seq: xs, phase: 'delta', text: 'Text from a stream that is then refused' });
    await apply({ seq: xs, phase: 'fail', state: 'bad-answer', title: 'The answer was refused', detail: 'Not a Haiku stream.', retry: true, settings: false });
    a = await A();
    check(a.view === 'fail' && a.text === '' && !/refused/.test(await page.ev("document.querySelector('#qa .qa-thread').textContent.replace('The answer was refused', '')")) && a.modelLabel === 'Haiku 5.5',
      'bad-answer after text: the streamed text is replaced by the failure; chip reads "Haiku 5.5" beside "Answer by Claude"', a.text + ' / ' + a.modelLabel);
    await page.ev(`window.QuartzAnswer.begin(${JSON.stringify(Q)}), 1`);
    await apply({ seq: (await A()).seq, phase: 'fail', state: 'stopped', title: 'Stopped', detail: '', retry: true, settings: false });
    check((await A()).view === 'stopped', 'fail stopped: shown as stopped, not as an error');
    await page.ev("document.querySelector('.qa-act-retry').click(), 1");
    await page.waitFor("window.__answerState().view === 'fail'", 5000).catch(() => 0);
    a = await A();
    check(a.view === 'fail' && a.fail.state === 'no-reply' && /did not answer/.test(a.fail.title) && a.controls.retry, 'no reply from main: says so, with Retry (never a blank panel)', JSON.stringify(a.fail));

    // ---- off states ----------------------------------------------------------------------------
    await page.ev(`window.QuartzAnswer.begin(${JSON.stringify(Q)}), 1`);
    await apply({ seq: (await A()).seq, phase: 'off', reason: 'no-key' });
    a = await A();
    check(a.view === 'off' && a.offText.includes('Add a Claude API key in Settings for answers') && a.controls.settings, 'off no-key: "Add a Claude API key in Settings for answers"', a.offText);
    console.log('[e2e] shot ' + await shot('1536x800-dark-off-nokey', 1536, 800));
    await page.send('Emulation.clearDeviceMetricsOverride');
    await page.ev("document.querySelector('.qa-act-settings').click(), 1");
    const opened = await chrome.waitFor('Settings.isOpen() ? 1 : 0', 5000).catch(() => 0);
    check(opened === 1, 'Open Settings opens Settings (the same line as Brave\'s no-key panel)');
    await chrome.ev('Settings.close && Settings.close(), 1').catch(() => 0);
    for (const reason of ['manual', 'not-question']) {
      await page.ev(`window.QuartzAnswer.begin(${JSON.stringify(Q)}), 1`);
      await apply({ seq: (await A()).seq, phase: 'off', reason });
      a = await A();
      check(a.view === 'off' && a.controls.ask && !a.controls.copy, 'off ' + reason + ': a quiet "Ask Claude" button', a.offText);
    }
    await page.ev("document.querySelector('.qa-act-ask').click(), 1");
    a = await A();
    check(/"mode":"ask"/.test(a.sent[a.sent.length - 1]) && a.view === 'pending', '"Ask Claude" sends mode "ask"', a.sent[a.sent.length - 1]);
    await apply({ seq: a.seq, phase: 'off', reason: 'not-question' });
    a = await A();
    check(a.view === 'fail' && a.fail.state === 'off' && a.controls.retry, 'an "ask" that is turned away says why, never silently', JSON.stringify(a.fail));

    // ---- keys ----------------------------------------------------------------------------------
    await page.ev(`(() => { window.__clicked = []; document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a'); if (a) { window.__clicked.push(a.href); e.preventDefault(); } }, true); document.activeElement && document.activeElement.blur(); return 1; })()`);
    await page.key('j', 'j', 'KeyJ', 74);
    await page.key('j', 'j', 'KeyJ', 74);
    let sel = await page.ev("({ s: __searchState().selected, f: document.activeElement && document.activeElement.href })");
    await page.key('k', 'k', 'KeyK', 75);
    const sel2 = await page.ev("({ s: __searchState().selected, f: document.activeElement && document.activeElement.href })");
    check(sel.s === 1 && sel.f === 'https://www.anthropic.com/claude' && sel2.s === 0 && sel2.f === 'https://claude.ai/', 'j / k move the selection through the results', JSON.stringify([sel, sel2]));
    await page.key('ArrowDown', '', 'ArrowDown', 40);
    sel = await page.ev("__searchState().selected");
    await page.key('Enter', '\r', 'Enter', 13);
    const clicked = await page.ev('window.__clicked.slice()');
    check(sel === 1 && clicked[clicked.length - 1] === 'https://www.anthropic.com/claude', 'arrow keys move too; Enter opens the selected result', sel + ' / ' + clicked.join(','));
    await page.key('/', '/', 'Slash', 191);
    check(await page.ev("document.activeElement === document.getElementById('sr-q')"), '/ focuses the search box');

    // ---- light theme, then leaving the page cancels the answer ----------------------------------
    await theme('light');
    const look = await page.ev("({ bg: getComputedStyle(document.body).backgroundColor, qa: getComputedStyle(document.getElementById('qa')).backgroundColor })");
    check(look.bg === 'rgb(233, 233, 231)' && look.qa !== look.bg, 'light: the page wears --bg #e9e9e7 and the answer card is its own surface', JSON.stringify(look));
    await theme('dark');
    await page.ev(`window.QuartzAnswer.begin(${JSON.stringify(Q)}), 1`);
    const leaving = (await A()).seq;
    page.events.length = 0;
    await page.ev(`(() => { const q = document.getElementById('sr-q'); q.focus(); q.value = 'quartz crystal'; q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
    s = await settle("s.phase === 'ok' && s.query === 'quartz crystal'");
    check(page.events.includes('quartz-search:answer-stop {"seq":' + leaving + '}'), 'a new search from the box stops the answer in flight (answer-stop on pagehide)', page.events.filter((e) => /answer/.test(e)).join(' | '));
    check(s.results === 9 && apiLog.some((x) => x.q === 'quartz crystal'), 'the new search ran', s.results);
    page.events.length = 0;
    await page.ev('history.back(), 1');
    s = await settle(`s.query === ${JSON.stringify(Q)}`);
    a = await A();
    check(page.events.some((e) => /^quartz-search:answer-stop/.test(e)) && (a.view === 'pending' || a.view === 'stopped'), 'Back: the old answer is stopped, the restored page asks again or says it stopped', a.view + ' | ' + page.events.join(' | '));
    await page.ev('history.forward(), 1');
    await settle("s.query === 'quartz crystal'");
    await page.ev("document.querySelector('.sr-tab[data-kind=news]').click(), 1");
    s = await settle("s.kind === 'news' && s.phase === 'ok'");
    a = await A();
    check(s.results === 6 && a.hidden === true && a.view === 'idle', 'News tab: no answer panel, news results', s.results + ' / ' + a.view);
  } catch (e) {
    check(false, 'HARNESS ERROR ' + (e && e.stack || e));
  } finally {
    if (watcher) { const v = watcher.verdict(); check(v.ok, v.line); watcher.stop(); }
    for (const c of [page, chrome]) if (c) c.close();
    if (child && !KEEP) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ }
      await sleep(1200);
      for (let i = 0; i < 10; i++) { try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
    }
    try { api.close(); } catch (e) { /* closed */ }
    try { if (imgSrv) imgSrv.close(); } catch (e) { /* closed */ }
    console.log(`search-page-e2e: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
