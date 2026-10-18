try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine */ }
// watch-find-e2e.js -- Lumen's one search box end to end, in a REAL hidden Quartz test instance
// (tests/e2e-kit.js: --test-profile, off-screen, watched by testwatch.js). Every service origin and
// TMDB are rebased to LOCAL fixture servers here (tests/watch-find-fixtures.js): Disney+'s search page
// fetches its explore search JSON, hulu.com's fetches its discover search JSON, Prime Video's embeds its
// hydration, YouTube's results page is tests/watch-fixtures/youtube-search.html. The Watch page's own
// image requests to the services' image hosts are blocked over CDP, so nothing leaves the PC.
// Never a real account, cookie or profile.
//
//   node watch-find-e2e.js [--cdp 9483] [--shots <dir>]
//
// Checks: / focuses, Enter searches; one hidden read per service, one at a time, signed-in first;
// YouTube answers before the last reader; Best match (one tile, three chips, Resume from his Hulu
// row), the service rows, YouTube videos + a channel; the arrows move between tiles; Esc clears; the
// same query again within 5 min reads nothing (memory cache); one service failing (why + Retry), one
// signed out ("Sign in to search Hulu", opening in the layer); a tile click plays in the layer (no
// tab); TMDB's where-to-watch opens in the layer with its log line; recent searches and Clear; shots
// at 1536x800 and 1920x1000. One summary line: "watch-find-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');
const FX = require('./tests/watch-find-fixtures');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9483'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'quartz-find-shots'));
const YT_HTML = fs.readFileSync(path.join(__dirname, 'tests', 'watch-fixtures', 'youtube-search.html'), 'utf8');
const TMDB_KEY = '0123456789abcdef0123456789abcdef';

/* ---- the local servers ---- */
const hits = [];            // { svc, path, q, t }
const mode = { disney: 'ok', hulu: 'ok', prime: 'ok' };
function listen(svc, handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      hits.push({ svc, path: u.pathname, q: u.searchParams.get('q') || u.searchParams.get('phrase') || u.searchParams.get('query') || u.searchParams.get('search_query') || '', t: Date.now() });
      handler(u, req, res);
    });
    s.keepAliveTimeout = 1500;
    s.listen(0, '127.0.0.1', () => resolve({ server: s, origin: 'http://127.0.0.1:' + s.address().port }));
  });
}
const html = (res, body, code) => { res.writeHead(code || 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
const json = (res, body, code) => { res.writeHead(code || 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); };
const page = (title, body) => '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title></head><body style="font:14px sans-serif;background:#111;color:#ddd;padding:20px">' + (body || '<h1>' + title + '</h1>') + '</body></html>';
const fetchPage = (title, paths) => page(title, '<h1>' + title + '</h1><script>' + paths.map((p) => 'fetch(' + JSON.stringify(p) + ').then(r=>r.text()).catch(()=>0);').join('') + '</script>');

async function startServers() {
  const S = {};
  S.disney = await listen('disney', (u, req, res) => {
    if (u.pathname === '/search') {
      if (mode.disney === 'signed-out') { res.writeHead(302, { Location: '/login' }); return res.end(); }
      const q = u.searchParams.get('q') || '';
      return html(res, fetchPage('Search | Disney+', ['/explore/v1.7/search', '/explore/v1.7/search?query=' + encodeURIComponent(q)]));
    }
    if (u.pathname === '/explore/v1.7/search') return json(res, u.searchParams.get('query') ? FX.disney(u.searchParams.get('query')) : FX.disneyLanding());
    if (u.pathname === '/login') return html(res, page('Log in | Disney+', '<a href="/login">Log in</a>'));
    return html(res, page('Disney+ ' + u.pathname));
  });
  S.hulu = await listen('hulu', (u, req, res) => {
    if (u.pathname === '/search') {
      if (mode.hulu === 'signed-out') { res.writeHead(302, { Location: '/welcome' }); return res.end(); }
      const q = u.searchParams.get('q') || '';
      return html(res, fetchPage('Search | Hulu', ['/content/v5/search/entity?language=en&search_query=' + encodeURIComponent(q) + '&limit=64']));
    }
    if (u.pathname === '/content/v5/search/entity') return json(res, FX.hulu(u.searchParams.get('search_query')));
    if (u.pathname === '/welcome') return html(res, page('Welcome to Hulu', '<a href="/login">Log in</a>'));
    return html(res, page('Hulu ' + u.pathname));
  });
  S.prime = await listen('prime', (u, req, res) => {
    if (/^\/search\//.test(u.pathname)) {
      if (mode.prime === 'fail') return html(res, page('Prime Video', '<p>Something went wrong</p>'), 500);
      const pr = FX.prime(u.searchParams.get('phrase') || '');
      return html(res, '<!doctype html><html><head><title>Prime Video: Search</title></head><body><script id="dv-web-page-hydration-data" type="application/json">' + JSON.stringify(pr.hydration).replace(/</g, '\\u003c') + '</script><script id="dv-web-global-store-data" type="application/json">' + JSON.stringify(pr.store) + '</script></body></html>');
    }
    return html(res, page('Prime Video ' + u.pathname));
  });
  S.youtube = await listen('youtube', (u, req, res) => (u.pathname === '/results' ? html(res, YT_HTML) : html(res, page('YouTube ' + u.pathname))));
  S.espn = await listen('espn', (u, req, res) => json(res, {}, 404));
  S.tmdbApi = await listen('tmdb', (u, req, res) => {
    if (/\/search\/multi$/.test(u.pathname)) return json(res, FX.tmdbSearch(u.searchParams.get('query')));
    const m = /\/(movie|tv)\/(\d+)\/watch\/providers$/.exec(u.pathname);
    if (m) return json(res, FX.tmdbProviders(m[1], m[2]));
    return json(res, { status_message: 'not here' }, 404);
  });
  S.tmdbWww = await listen('tmdb-www', (u, req, res) => html(res, page('Where to watch | TMDB', '<h1 id="tw">Where to watch</h1>')));
  const rebase = [];
  for (const svc of Mock.SERVICES) for (const from of Mock.ORIGINS[svc]) rebase.push([from, S[svc].origin]);
  rebase.push(['https://api.themoviedb.org', S.tmdbApi.origin], ['https://www.themoviedb.org', S.tmdbWww.origin]);
  S.rebase = rebase;
  S.close = () => { for (const k of Object.keys(S)) if (S[k] && S[k].server) S[k].server.close(); };
  return S;
}

/* ---- CDP helpers ---- */
async function targetWhere(q, pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    let list = [];
    try { list = await q.targets(); } catch (e) { list = []; }
    const t = list.find((x) => x.webSocketDebuggerUrl && pred(x));
    if (t) return t;
    await sleep(100);
  }
  return null;
}
async function key(c, k, code, vk) {
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base, k.length === 1 ? { text: k } : {}));
  if (k.length === 1) await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'char', text: k }, base));
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}
const ENTER = ['Enter', 'Enter', 13], ESC = ['Escape', 'Escape', 27], DOWN = ['ArrowDown', 'ArrowDown', 40], RIGHT = ['ArrowRight', 'ArrowRight', 39], SLASH = ['/', 'Slash', 191];
const FS = 'WatchFindPage._state()';
const ST = 'WatchPlayer._state()';
const searchHits = (svc, q) => hits.filter((h) => h.svc === svc && (h.path === '/search' || /^\/search\//.test(h.path)) && (!q || h.q.toLowerCase() === q)).length;

run('watch-find-e2e', async ({ check, launch, say, profileDir }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const S = await startServers();
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'watch-cache.json'), JSON.stringify(FX.cache(Date.now())));
  fs.writeFileSync(path.join(profileDir, 'watch.json'), JSON.stringify({ background: false, tmdbKey: TMDB_KEY }));
  const LOG = path.join(profileDir, 'quartz.log');
  const logHas = (re) => { try { return re.test(fs.readFileSync(LOG, 'utf8')); } catch (e) { return false; } };
  try {
    const q = await launch({ cdp: CDP_PORT, env: { QUARTZ_WATCH_BOOT_GRACE_MS: '0', QUARTZ_WATCH_REBASE: JSON.stringify(S.rebase), QUARTZ_WATCH_MIN_FREE_GB: '0', QUARTZ_WATCH_PREVIEW_MOCK: '0' } });
    const chrome = q.chrome;
    await chrome.ev('openWatchTab(), 1');
    const gt = await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 15000);
    const g = await new Cdp(gt.webSocketDebuggerUrl).open();
    await g.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => 0);
    await g.send('Network.enable');
    await g.send('Network.setBlockedURLs', { urls: ['*bamgrid.com*', '*hulu.com*', '*media-amazon.com*', '*tmdb.org*', '*ytimg.com*', '*ggpht.com*', '*googleusercontent.com*', '*espncdn.com*'] });
    await g.waitFor('!!window.WatchFindPage && !document.body.classList.contains("is-boot")', 30000);
    await g.ev('(() => { window.__parts = []; const f = window.__applyWatchFind; window.__applyWatchFind = function (p) { window.__parts.push(p.kind + (p.service ? ":" + p.service + ":" + (p.answer && p.answer.state) : "")); return f.apply(this, arguments); }; return 1; })()');

    // 1. / focuses the box, Enter searches every service.
    await g.ev('document.activeElement && document.activeElement.blur(), 1');
    await key(g, ...SLASH);
    check(await g.ev('document.activeElement && document.activeElement.id === "q"'), '/ focuses the search box');
    await g.send('Input.insertText', { text: 'the bear' });
    await sleep(800);
    check(searchHits('disney') + searchHits('hulu') + searchHits('prime') === 0, 'typing alone reads no service (only Enter does)', hits.map((h) => h.svc + h.path));
    await key(g, ...ENTER);
    const done1 = await g.waitFor(FS + '.done && ' + FS, 30000).catch(() => null);
    check(!!done1 && done1.services.join() === 'disney:ok,hulu:ok,prime:ok' && done1.youtube === 'ok', 'Enter: Disney+, Hulu, Prime Video and YouTube all answered', done1);
    const order = hits.filter((h) => h.path === '/search' || /^\/search\//.test(h.path)).map((h) => h.svc);
    check(order.join() === 'disney,hulu,prime', "one read of each service's own search page, one at a time, in order", order);
    const parts = await g.ev('window.__parts');
    check(parts.indexOf('youtube') !== -1 && parts.indexOf('youtube') < parts.indexOf('service:prime:ok'), 'speed: YouTube was on the page before the last service answered', parts);
    const view = await g.ev(`(() => { const r = document.getElementById('results'); const best = r.querySelector('[data-sec="best"] .fd-tile'); const sec = (k) => r.querySelector('[data-sec="' + k + '"]');
      return { best: best && best.querySelector('.fd-t b').textContent, chips: best ? [...best.querySelectorAll('.fd-chip[data-svc]')].map((c) => c.dataset.svc + ':' + c.textContent) : [], resume: !!(best && best.querySelector('.fd-resume')), prog: !!(best && best.querySelector('.fd-prog')),
        rows: ['disney', 'hulu', 'prime'].map((k) => sec(k) ? sec(k).querySelectorAll('.fd-tile').length : -1), yt: sec('youtube') ? sec('youtube').querySelectorAll('.fd-tile:not(.fd-chan)').length : 0, chan: sec('youtube') ? sec('youtube').querySelectorAll('.fd-chan').length : 0,
        attrib: /JustWatch/.test(r.textContent), wtw: !!r.querySelector('.fd-chip.look') }; })()`);
    check(view.best === 'The Bear' && view.chips.length === 3 && /^hulu/.test(view.chips[0]), 'Best match: The Bear first, one tile, a chip per service, his Hulu (with progress) leading', view.chips);
    check(view.chips.some((c) => /^prime:.*Rent or buy/.test(c)) && view.chips.some((c) => /^disney:.*Included/.test(c)), 'chips say Included or Rent or buy', view.chips);
    check(view.resume && view.prog, 'the tile shows Resume and his progress', view);
    check(view.rows.join() === '4,3,3' && view.yt >= 3 && view.chan === 1, 'service rows (4, 3, 3 results) and a YouTube row of videos and a channel', view);
    check(view.attrib && view.wtw, "TMDB merged in: JustWatch attribution, a 'Where to watch' link for a title his services lack");
    const shot = async (name, w, h) => {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(900);
      const file = path.join(SHOTS, 'lumen-n-search-' + name + '.png');
      try { await chrome.shot(file); say('shot ' + file); } catch (e) { say('shot ' + name + ' failed: ' + e.message); }
    };
    await shot('results-1536x800', 1536, 800);
    await shot('results-1920x1000', 1920, 1000);
    await chrome.send('Emulation.clearDeviceMetricsOverride');
    await sleep(400);

    // 2. The arrows move between tiles.
    await g.ev('document.getElementById("q").focus(), 1');
    await key(g, ...DOWN);
    const a0 = await g.ev('document.activeElement.dataset.nav || ""');
    await key(g, ...RIGHT);
    const a1 = await g.ev('document.activeElement.dataset.nav || ""');
    await key(g, ...DOWN);
    const a2 = await g.ev('(() => { const a = document.activeElement; return (a.dataset.nav || "") + "|" + (a.closest("[data-sec]") || {}).dataset.sec; })()');
    check(/^b:/.test(a0) && /^b:/.test(a1) && a1 !== a0 && !!a2 && a2.split('|')[0] !== a1, 'arrows: Down into the tiles, Right to the next, Down to the tile below', [a0, a1, a2]);

    // 3. Esc clears; the same search again within 5 min reads nothing.
    await key(g, ...ESC);
    const cleared = await g.ev('document.getElementById("q").value === "" && document.getElementById("results").hidden && !' + FS + '.open');
    check(cleared, 'Esc clears the search');
    const before = hits.length;
    await g.ev('document.activeElement && document.activeElement.blur(), 1');
    await key(g, ...SLASH);
    await g.send('Input.insertText', { text: 'the bear' });
    await key(g, ...ENTER);
    const done2 = await g.waitFor(FS + '.done && ' + FS, 15000).catch(() => null);
    const newHits = hits.slice(before).filter((h) => h.path === '/search' || /^\/search\//.test(h.path) || h.path === '/results');
    check(!!done2 && newHits.length === 0, 'the same search again within 5 min reads no service (memory cache)', newHits.map((h) => h.svc + h.path));
    check(await g.ev('/from your search a moment ago/.test(document.getElementById("results").textContent)'), 'the rows say they come from the search a moment ago');

    // 4. A tile click plays in the layer, never a tab.
    const tabs0 = await chrome.ev('tabs.length');
    await g.ev('document.querySelector(\'[data-sec="best"] .fd-hit\').click(), 1');
    const p1 = await chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.slots[0] ? s.slots[0].url : null; })()`, 15000).catch(() => null);
    check(!!p1 && p1.indexOf(S.hulu.origin + '/series/' + FX.UUID(1)) === 0 && (await chrome.ev('tabs.length')) === tabs0, 'a Best match click resumes his Hulu episode in the Lumen layer (no new tab)', p1);
    await chrome.ev('WatchPlayer.close(), 1');
    await chrome.waitFor('!' + ST + '.open', 8000).catch(() => 0);
    // TMDB's where-to-watch link opens in the layer too.
    await g.ev('document.querySelector(".fd-chip.look").click(), 1');
    const p2 = await chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.slots[0] ? s.slots[0].url : null; })()`, 15000).catch(() => null);
    check(!!p2 && p2.indexOf(S.tmdbWww.origin + '/movie/346648/watch') === 0 && (await chrome.ev('tabs.length')) === tabs0, "TMDB's where-to-watch page opens in the layer, not a tab", p2);
    await sleep(500);
    check(logHas(/TMDB where-to-watch page opened in the player layer/), 'quartz.log: the TMDB open has its line');
    await chrome.ev('WatchPlayer.close(), 1');
    await chrome.waitFor('!' + ST + '.open', 8000).catch(() => 0);

    // 5. One service failing, one signed out; the others still show.
    mode.hulu = 'signed-out'; mode.prime = 'fail';
    await g.ev('(() => { const i = document.getElementById("q"); i.focus(); i.select(); return 1; })()');
    await g.send('Input.insertText', { text: 'cocaine bear' });
    await key(g, ...ENTER);
    const done3 = await g.waitFor(FS + '.done && ' + FS, 30000).catch(() => null);
    check(!!done3 && done3.services.join() === 'disney:ok,hulu:signed-out,prime:error' && done3.youtube === 'ok', 'cocaine bear: Disney+ ok, Hulu signed out, Prime Video failed, YouTube ok', done3);
    const fv = await g.ev(`(() => { const r = document.getElementById('results'); const sec = (k) => r.querySelector('[data-sec="' + k + '"]'); return { sign: (sec('hulu').querySelector('.fd-sign') || {}).textContent || '', err: (sec('prime').querySelector('.fd-note') || {}).textContent || '', retry: !!sec('prime').querySelector('.fd-note .btn'), disney: sec('disney').querySelectorAll('.fd-tile').length, yt: sec('youtube').querySelectorAll('.fd-tile').length }; })()`);
    check(fv.sign === 'Sign in to search Hulu', 'signed out: "Sign in to search Hulu"', fv.sign);
    check(/Prime Video search didn.t work\..*(page data was missing|HTTP)/.test(fv.err) && fv.retry, 'failed: Prime Video says why, with Retry', fv.err);
    check(fv.disney === 1 && fv.yt >= 3, 'the others still show', fv);
    await shot('states-1536x800', 1536, 800);
    await chrome.send('Emulation.clearDeviceMetricsOverride');
    await g.ev('document.querySelector(".fd-sign").click(), 1');
    const p3 = await chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.slots[0] ? s.slots[0].url : null; })()`, 15000).catch(() => null);
    check(!!p3 && p3.indexOf(S.hulu.origin + '/login') === 0, 'Sign in to search Hulu opens the sign-in page in the layer', p3);
    await chrome.ev('WatchPlayer.close(), 1');
    await chrome.waitFor('!' + ST + '.open', 8000).catch(() => 0);
    mode.prime = 'ok';
    const pBefore = searchHits('prime', 'cocaine bear');
    await g.ev('document.querySelector(\'[data-sec="prime"] .fd-note .btn\').click(), 1');
    await g.waitFor(`/prime:ok/.test(${FS}.services.join())`, 20000).catch(() => 0);
    check(searchHits('prime', 'cocaine bear') === pBefore + 1 && /prime:ok/.test((await g.ev(FS)).services.join()), 'Retry reads Prime Video once more and its row fills in');

    // 6. Recent searches, and Clear.
    await key(g, ...ESC);
    await g.ev('document.getElementById("q").blur(), document.getElementById("q").focus(), 1');
    const rec = await g.ev('(() => { const p = document.getElementById("fd-recent"); return p && !p.hidden ? [...p.querySelectorAll(".fd-ri")].map((b) => b.textContent) : null; })()');
    check(Array.isArray(rec) && rec[0] === 'cocaine bear' && rec[1] === 'the bear' && rec.length === 2, 'recent searches: newest first, no repeats', rec);
    await g.ev('document.querySelector(".fd-rclear").click(), 1');
    check(await g.ev('document.getElementById("fd-recent").hidden && ' + FS + '.recent.length === 0'), 'Clear empties the recent searches');
  } finally {
    S.close();
  }
});
