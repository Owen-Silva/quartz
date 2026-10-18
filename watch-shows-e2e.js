try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine: no cap needed */ }
// watch-shows-e2e.js -- Lumen's show and movie pages (watch/showpage.js + watch-shows-main.js), end to end in a REAL
// hidden Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen). LOCAL FIXTURES ONLY: the rows come from
// tests/watch-mock.js; every service origin is rebased to a local "front" that serves the show fixtures
// (tests/watch-show-fixtures/): Hulu /series/<uuid> and /movie/<uuid> (their content/v5 hubs), Disney+
// /browse/entity-<id> (explore v1.7), Prime Video /detail/<asin>/ (the hydration JSON), a fixture player at
// /watch/<uuid>, Prime's /search/; TMDB (api.themoviedb.org) is a local mock answering the fixture routes. The
// Lumen page's own requests go through CDP Fetch: local ones continue, art is a generated SVG, anything else is
// refused and counted. Never a real account, cookie, service or TMDB; Edge is a stub file.
//
//   node watch-shows-e2e.js [--cdp 9487] [--shots <dir>] [--prefix lumen-n-shows] [--size 1536x800]
//   (shots are taken only with --size: the test window really is that size)
//
// Checks: a Continue tile (The Bear) has Episodes for its page; the page's loading state; Hulu failing: TMDB's
// episodes with the reason and Retry; More like this (TMDB's, on the fallback) -> Severance, on none of his
// services: where it streams, and Watch on Prime Video in the layer; Back; Retry with Hulu answering: Resume S2 E3,
// a progress bar, the watched checks, the season tabs, S3 filled from TMDB; Resume and an episode play in the layer;
// Esc closes; Disney+ (Andor) and Prime Video (The Boys) pages; film pages (Palm Springs on Hulu, Air on Prime
// Video). Shots at 1536x800 and 1920x1000.
// One summary line: "watch-shows-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9487'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'quartz-shows-shots'));
const PREFIX = opt('prefix', 'lumen-n-shows');
// --size 1536x800: the test window's REAL size (QUARTZ_TEST_WINDOW_SIZE, as watch-multiview-e2e does), and the
// shots are taken at that size only, with no emulation. Emulating a size never reaches the <webview>'s guest
// for real: the run4/run5 shots under emulation came out as blank grey panels.
const SIZE = /^(\d{3,4})x(\d{3,4})$/.test(opt('size', '')) ? opt('size', '') : '';
const TAG = 'quartz-shows-e2e-' + process.pid;
const STUB = (n) => path.join(os.tmpdir(), TAG + '-' + n);
const EDGE_STUB = STUB('edge.txt');
const OPEN_STUB = STUB('open.txt');

const FIX = path.join(__dirname, 'tests', 'watch-show-fixtures');
const sfx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n + '.json'), 'utf8'));
const HS = sfx('hulu-series'), HM = sfx('hulu-movie'), DE = sfx('disney-entity'), PD = sfx('prime-detail'), PM = sfx('prime-movie');
const TM = sfx('tmdb-shows').routes;
const BEAR = 'c3b4c2e2-3f1a-4b8e-9d0c-7a1e2b3c4d5e';        // The Bear in hulu-series.json
const PALM = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';        // Palm Springs in hulu-movie.json
const EP = (s, e) => 'e' + s + '0' + e + 'aaaa-1111-4222-8333-44445555' + String(s * 100 + e).padStart(4, '0');
const KEY = 'lumenE2eFixtureKey0123';                       // a made-up key: only the local TMDB mock ever sees it

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 2000;
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, origin: 'http://127.0.0.1:' + s.address().port }));
  });
}
function send(res, code, type, body) { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); }
const sendHtml = (res, body, code) => send(res, code || 200, 'text/html; charset=utf-8', body);
const sendJson = (res, obj, code) => send(res, code || 200, 'application/json; charset=utf-8', JSON.stringify(obj));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BS = String.fromCharCode(92);
const inScript = (v) => JSON.stringify(v).split('<').join(BS + 'u003c');
const PAGE = (title, head, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{margin:0;background:#101113;color:#ddd;font:15px/1.45 "Segoe UI",sans-serif}
main{padding:40px 48px} h1{font:600 22px "Segoe UI";margin:0 0 18px} video{display:block;width:100%;height:100vh;background:#000;object-fit:contain}</style>${head || ''}</head><body>${body || ''}</body></html>`;
/** The service page: its script fetch()es every capture path, as the real page's app does (the reader captures them). */
const fetchAll = (paths) => '<script>(function(){var p=' + inScript(paths) + ';Promise.all(p.map(function(u){return fetch(u,{cache:"no-store"}).then(function(r){return r.text();},function(){return "";});})).then(function(){document.body.setAttribute("data-loaded",String(p.length));});})();</script>';
// A player: a canvas recorded to WebM, then looped as a file (it never ends here, so Up next stays out of it).
const PLAYER = (label) => PAGE(label, '', `<video id="v" muted playsinline loop></video><script>
(() => {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const x = c.getContext('2d'); let n = 0;
  const draw = () => { x.fillStyle = '#1d2733'; x.fillRect(0, 0, 1280, 720); x.fillStyle = '#e6e6e6'; x.font = '600 52px Segoe UI'; x.fillText(${JSON.stringify(label)}, 80, 340); x.font = '28px Segoe UI'; x.fillText('fixture player, frame ' + (n++), 80, 400); };
  draw(); const t = setInterval(draw, 66);
  const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm;codecs=vp8' }); const parts = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.onstop = () => { clearInterval(t); const v = document.getElementById('v'); v.src = URL.createObjectURL(new Blob(parts, { type: 'video/webm' })); v.play().catch(() => 0); };
  rec.start(250); setTimeout(() => rec.stop(), 1500);
})();
</script>`);
/** Art for any image the Lumen page asks for: a quiet two-tone gradient, its hue from the URL (never the network). */
function art(u) {
  let h = 0;
  for (let i = 0; i < u.length; i++) h = (h * 31 + u.charCodeAt(i)) >>> 0;
  const a = h % 360, b = (a + 40) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${a},22%,34%)"/><stop offset="1" stop-color="hsl(${b},18%,18%)"/></linearGradient></defs><rect width="960" height="540" fill="url(#g)"/><circle cx="${300 + (h % 360)}" cy="${170 + (h % 160)}" r="150" fill="hsl(${a},25%,46%)" opacity="0.35"/></svg>`;
}

/** The Hulu series fixture for any series id (a Continue tile's own id), so a real tile reaches The Bear's hub. */
const bearFor = (id) => JSON.parse(JSON.stringify(HS).split(BEAR).join(id));

async function startServers(mock, st) {
  const fronts = {};
  for (const svc of Mock.SERVICES) {
    fronts[svc] = await listen((req, res) => {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      const p = u.pathname;
      st.hits.push(svc + ' ' + p);
      if (svc === 'hulu') {
        let m = /^\/series\/([0-9a-f-]{36})$/.exec(p);
        if (m) { const f = bearFor(m[1]); return sendHtml(res, PAGE(f.title, fetchAll(f.captures.map((c) => c.path)), '<main id="app">fixture Hulu series</main>')); }
        m = /^\/content\/v5\/hubs\/series\/([0-9a-f-]{36})(\/collections\/[^/]+)?$/.exec(p);
        if (m) {
          if (st.huluFail) return sendJson(res, { message: 'Service Unavailable' }, 503);
          const c = bearFor(m[1]).captures.find((x) => x.path.split('?')[0] === p);
          if (c) return sendJson(res, c.json);
        }
        if (p === HM.finalPath) return sendHtml(res, PAGE(HM.title, fetchAll(HM.captures.map((c) => c.path)), '<main id="app">fixture Hulu movie</main>'));
        const mc = HM.captures.find((x) => x.path.split('?')[0] === p);
        if (mc) return sendJson(res, mc.json);
        m = /^\/watch\/([0-9a-f-]{36})$/.exec(p);
        if (m) { st.played.push(m[1]); return sendHtml(res, PLAYER('Hulu ' + m[1].slice(0, 8))); }
      }
      if (svc === 'disney') {
        if (p === DE.finalPath) return sendHtml(res, PAGE(DE.title, fetchAll(DE.captures.map((c) => c.path)), '<main id="app">fixture Disney+ entity</main>'));
        const c = DE.captures.find((x) => x.path.split('?')[0] === p);
        if (c) return sendJson(res, c.json);
      }
      if (svc === 'prime') {
        for (const f of [PD, PM]) {
          if (p !== f.finalPath) continue;
          let head = '';
          if (f.hydration) head += '<script id="dv-web-page-hydration-data" type="application/json">' + inScript(f.hydration) + '</script>';
          if (f.store) head += '<script id="dv-web-global-store-data" type="application/json">' + inScript(f.store) + '</script>';
          return sendHtml(res, PAGE(f.title, head, '<main id="pv">fixture Prime Video detail</main>'));
        }
        if (/^\/search\//.test(p)) { st.searched.push(u.searchParams.get('phrase') || ''); return sendHtml(res, PAGE('Prime Video: search', '', '<main><h1 id="srch">Prime Video search: ' + esc(u.searchParams.get('phrase')) + '</h1></main>')); }
      }
      const up = http.request({ host: '127.0.0.1', port: mock.ports[svc], path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + mock.ports[svc] }) }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('mock gone'); } });
      req.pipe(up);
    });
  }
  // TMDB: the fixture routes by path (the /3 prefix, the key and the year dropped); anything else is a 404.
  const tmdb = await listen((req, res) => {
    const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
    const p = u.pathname.replace(/^\/3/, '');
    const qy = u.searchParams.get('query');
    const k = qy !== null ? p + '?query=' + encodeURIComponent(qy) : p;
    st.tmdb.push(k);
    if (TM[k]) return sendJson(res, TM[k]);
    return sendJson(res, { status_code: 34, status_message: 'The resource you requested could not be found.' }, 404);
  });
  const rebase = [['https://api.themoviedb.org', tmdb.origin]];
  for (const svc of Mock.SERVICES) for (const from of Mock.ORIGINS[svc]) rebase.push([from, fronts[svc].origin]);
  return { fronts, tmdb, rebase, close: () => { for (const f of Object.values(fronts)) f.server.close(); tmdb.server.close(); } };
}

async function targetWhere(q, pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    let list = [];
    try { list = await q.targets(); } catch (e) { list = []; }
    const t = list.find((x) => x.webSocketDebuggerUrl && pred(x));
    if (t) return t;
    await sleep(150);
  }
  return null;
}
const ST = 'WatchPlayer._state()';
const LS = 'LumenShows._state()';
// what the show page shows, in one read
const PAGE_NOW = `(() => {
  const r = document.querySelector('.shw'); if (!r || r.hidden) return null;
  const tx = (sel) => { const n = r.querySelector(sel); return n ? n.textContent : ''; };
  const eps = [...r.querySelectorAll('.shw-eps .shw-ep')].map((b) => ({ t: (b.querySelector('.shw-ep-h b') || {}).textContent || '', m: (b.querySelector('.shw-ep-m') || {}).textContent || '',
    done: b.classList.contains('done'), next: b.classList.contains('next'), dis: b.disabled, check: !!b.querySelector('.shw-check'), prog: (() => { const i = b.querySelector('.shw-prog i'); return i ? Number(i.style.getPropertyValue('--p')) : null; })() }));
  return { s: ${LS}, h1: tx('.shw-h1'), meta: tx('.shw-meta'), play: tx('.shw-play'), left: tx('.shw-left'), why: tx('.shw-why'), chip: tx('.shw-svc-n'), wl: tx('.shw-wl'),
    note: tx('.shw-note .shw-note-t'), noteKind: (r.querySelector('.shw-note') || { className: '' }).className, noteBtns: [...r.querySelectorAll('.shw-note .btn')].map((b) => b.textContent),
    fine: [...r.querySelectorAll('.shw-fine')].map((n) => n.textContent), tabs: [...r.querySelectorAll('.shw-tab')].map((b) => b.firstChild.textContent + (b.querySelector('.shw-tab-src') ? '(TMDB)' : '') + (b.classList.contains('on') ? '*' : '')),
    eps, more: [...r.querySelectorAll('.shw-more .shw-card b')].map((n) => n.textContent), prov: [...r.querySelectorAll('.shw-prov-r')].map((n) => n.textContent),
    hasEps: !!r.querySelector('.shw-eps-wrap'), sk: !!r.querySelector('.shw-sk-lines, .shw-sk-btn'), attr: tx('.shw-attr') };
})()`;

run('watch-shows-e2e', async ({ check, launch, say }) => {
  const dog = setTimeout(() => { console.log('FAIL HARNESS TIMEOUT: watch-shows-e2e did not finish in 8 min'); process.exit(1); }, 8 * 60 * 1000);
  dog.unref();
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of [EDGE_STUB, OPEN_STUB]) { try { fs.unlinkSync(f); } catch (e) { /* none */ } }
  const st = { huluFail: true, hits: [], played: [], searched: [], tmdb: [] };
  const net = { local: 0, art: 0, real: [] };
  const errors = [];
  const mock = await Mock.start({ log: () => {} });
  const srv = await startServers(mock, st);
  const FH = srv.fronts.hulu.origin, FP = srv.fronts.prime.origin;
  try {
    const q = await launch({ cdp: CDP_PORT, env: {
      QUARTZ_WATCH_BOOT_GRACE_MS: '0', QUARTZ_WATCH_REBASE: JSON.stringify(srv.rebase), QUARTZ_EDGE_STUB: EDGE_STUB, QUARTZ_WATCH_OPEN_STUB: OPEN_STUB,
      QUARTZ_WATCH_MIN_FREE_GB: '0', QUARTZ_WATCH_GAME_FILE: STUB('game.flag'), QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1', QUARTZ_TEST_VMP: 'signed',
      ...(SIZE ? { QUARTZ_TEST_WINDOW_SIZE: SIZE } : {}),
    }, // At Windows' 125% scale a 1920x1000 window is 2400x1250 device pixels, which Windows clips to the
    // screen; scale 1 keeps the window, the page and the shot all SIZE.
    args: SIZE ? ['--force-device-scale-factor=1'] : [] });
    const chrome = q.chrome;
    await chrome.ev('window.toggleFullscreen = function () {}; 1');
    const wv = await chrome.waitFor('(() => { const s = window.Drm && window.Drm.state(); return s && s.widevine && s.widevine.available ? s.widevine : null; })()', 120000).catch(() => null);
    check(!!wv, 'Widevine available (test-signed): Hulu titles play in the layer', wv && { available: wv.available });
    const keyed = await chrome.ev(`window.api.watch.setTmdbKey(${JSON.stringify(KEY)}).then((d) => !!(d && d.tmdb && d.tmdb.hasKey), () => false)`);
    check(keyed === true, 'a TMDB key is saved in the test profile (only the local TMDB mock ever sees it)');

    await chrome.ev('openWatchTab(), 1');
    const gt = await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 15000);
    if (!gt) throw new Error('the Lumen page never appeared as a CDP target');
    const g = await new Cdp(gt.webSocketDebuggerUrl).open();
    g.ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
      if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).slice(0, 240));
      else if (m.method === 'Fetch.requestPaused') {
        const p = m.params;
        const u = String(p.request.url);
        if (/^https?:\/\/127\.0\.0\.1[:/]/.test(u)) { net.local++; g.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => 0); }
        else if (p.resourceType === 'Image') {
          net.art++;
          g.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/svg+xml' }], body: Buffer.from(art(u)).toString('base64') }).catch(() => 0);
        } else { net.real.push(p.resourceType + ' ' + u.slice(0, 120)); g.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => 0); }
      }
    });
    await g.send('Fetch.enable', { patterns: [{ urlPattern: 'http*', requestStage: 'Request' }] });
    await g.send('Runtime.enable');
    await g.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => 0);

    // A shot: the whole Quartz window captured as it is, at its REAL size (--size). Emulated sizes were dropped:
    // under emulation the guest's pixels came back as blank grey panels (run4 and run5: right DOM, empty pixels).
    // One size per launch, so the shot sizes are two runs. SHOWS_PROBE=1 logs the page's size at each shot.
    const barH = Math.round(await chrome.ev('(() => { const w = findWatchTab(); const v = w && w.viewEl; return v ? v.getBoundingClientRect().top : 85; })()')) || 85;
    const shoot = async (name, sizes) => {
      if (SIZE) {
        // The window is really SIZE: the page draws at its own size, captured from the window as it is.
        await sleep(1200);
        if (process.env.SHOWS_PROBE) {
          const top = (x, y) => `(() => { const out = []; for (let e = document.elementFromPoint(${x}, ${y}); e && out.length < 4; e = e.parentElement) out.push(e.tagName + '.' + String(e.className).slice(0, 30) + (e.id ? '#' + e.id : '')); return out.join(' < '); })()`;
          say('probe ' + name + ' ' + SIZE + ': ' + JSON.stringify({ guest: await g.ev('[innerWidth, innerHeight, document.visibilityState]').catch(() => null),
            guestTop: await g.ev(top(400, 300)).catch(() => null), chromeTop: await chrome.ev(top(400, 400)).catch(() => null),
            chromeView: await chrome.ev('[innerWidth, innerHeight]').catch(() => null),
            box: await g.ev(`(() => { const out = []; for (let e = document.elementFromPoint(400, 300); e && out.length < 6; e = e.parentElement) { const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
              out.push(String(e.className).slice(0, 24) + ' ' + [b.left, b.top, b.width, b.height].map(Math.round).join(',') + ' ' + cs.position + ' ' + cs.transform.slice(0, 40) + ' ' + cs.aspectRatio); } return out; })()`).catch((e) => 'err ' + e.message) }));
        }
        try { await chrome.shot(path.join(SHOTS, PREFIX + '-' + name + '-' + SIZE + '.png')); } catch (e) { say('shot ' + name + ' failed: ' + e.message); }
        return;
      }
      // No --size: no shots (an emulated size draws blank panels; see SIZE above).
      void sizes; void barH;
    };
    const now = () => g.ev(PAGE_NOW);
    const until = (cond, ms) => g.waitFor(`(() => { const v = ${PAGE_NOW}; return v && (${cond}) ? v : null; })()`, ms || 30000).catch(() => null);
    const clickText = (sel, text) => g.ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((n) => (n.firstChild ? n.firstChild.textContent : n.textContent).trim() === ${JSON.stringify(text)}); if (!b) return 0; b.scrollIntoView({ block: 'nearest' }); b.click(); return 1; })()`);
    const layerAt = (prefix, ms) => chrome.waitFor(`(() => { const s = ${ST}; return s && s.open && s.slots[0] && String(s.slots[0].url).indexOf(${JSON.stringify(prefix)}) === 0 ? s.slots[0].url : null; })()`, ms || 15000).catch(() => null);
    const closeLayer = async () => { await chrome.ev('(() => { if (window.WatchPlayer && WatchPlayer.isOpen()) WatchPlayer.close("Close"); return 1; })()'); await chrome.waitFor(`!${ST}.open`, 5000).catch(() => 0); await sleep(400); };
    const openItem = (it) => g.ev(`LumenShows.open(${JSON.stringify(it)})`);

    /* ---- 1. a Continue tile: still plays straight away, and its stage has Episodes ---- */
    const bearCard = `[...document.querySelectorAll('.card')].find((n) => n._item && n._item.service === 'hulu' && n._item.kind === 'resume' && n._item.title === 'The Bear')`;
    const bearUrl = await g.waitFor(`(() => { const c = ${bearCard}; return c ? c._item.url : null; })()`, 90000).catch(() => null);
    check(!!bearUrl && /\/series\/[0-9a-f-]{36}$/.test(bearUrl), 'The Bear is on Hulu’s Keep Watching (mock), its title page a /series/ address', bearUrl);
    const eps = await g.ev(`(() => { const c = ${bearCard}; const b = c && LumenShows.stageButton(c._item); if (!b) return null; window.__e2eEps = b; return b.textContent; })()`);
    check(eps === 'Episodes', 'a Continue tile’s stage gets Episodes (the tile itself still resumes in one click)', eps);

    /* ---- 2. open it while Hulu fails: loading, then TMDB's episodes with the reason ---- */
    const t0 = Date.now();
    await g.ev('window.__e2eEps.click(), 1');
    const ld = await until(`v.s && v.s.state === 'loading'`, 8000);
    check(ld && ld.h1 === 'The Bear' && /^Reading Hulu/.test(ld.note) && /busy/.test(ld.noteKind), 'the page opens at once: the title, and "Reading Hulu…" while it reads', ld && { h1: ld.h1, note: ld.note });
    const part = await until(`v.s && v.s.partial && v.eps.length`, 15000);
    check(part && /TMDB until it answers/.test(part.note) && part.eps.length >= 3, 'TMDB lands first: its episodes are drawn while Hulu is still being read, and the page says so', part && { note: part.note, eps: part.eps.length });
    if (part) await shoot('loading');
    const fb = await until(`v.s && v.s.state === 'fallback'`, 45000);
    check(!!fb, 'Hulu’s hub answered 503: the page settles on its fallback (' + Math.round((Date.now() - t0) / 1000) + ' s)', fb && fb.s);
    check(fb && fb.note === 'Couldn’t read Hulu: Hulu’s servers answered HTTP 503 for this title’s data. Episodes are from TMDB; your progress isn’t shown.' && /warn/.test(fb.noteKind), 'the reason, in words: "Couldn’t read Hulu: Hulu’s servers answered HTTP 503…", and that the episodes are TMDB’s', fb && fb.note);
    check(fb && fb.noteBtns.indexOf('Retry') !== -1 && fb.noteBtns.indexOf('Open on Hulu') !== -1, 'the fallback offers Retry and Open on Hulu', fb && fb.noteBtns);
    check(fb && fb.eps.length === 3 && fb.eps[0].t === '1. System' && fb.eps.every((e) => !e.check && e.prog === null), 'TMDB’s season 1 (System, Hands, Brigade), with no progress drawn (none was read)', fb && fb.eps);
    check(fb && fb.tabs.length >= 3 && fb.more.indexOf('Severance') !== -1, 'TMDB’s seasons as tabs, and its More like this: Severance', fb && { tabs: fb.tabs, more: fb.more });
    check(fb && fb.tabs.every((t) => t.indexOf('(TMDB)') === -1) && !fb.fine.some((t) => /This season’s episodes are from TMDB/.test(t)), 'the fallback is all TMDB’s and its banner says so: no per-season TMDB marks or notes repeating it', fb && { tabs: fb.tabs, fine: fb.fine });
    await shoot('fallback');

    /* ---- 3. More like this -> Severance: on none of his services ---- */
    await g.ev(`(() => { const c = [...document.querySelectorAll('.shw-more .shw-card')].find((n) => (n.querySelector('b') || {}).textContent === 'Severance'); if (!c) return 0; c.scrollIntoView({ block: 'nearest' }); c.click(); return 1; })()`);
    const sev = await until(`v.s && v.s.state === 'elsewhere' && v.h1 === 'Severance'`, 20000);
    check(sev && sev.s.depth === 1 && sev.chip === 'Not on your services' && !sev.play, 'Severance opens on top: "Not on your services", no play button', sev && { depth: sev.s.depth, chip: sev.chip, play: sev.play });
    check(sev && sev.prov.some((t) => /Apple TV Plus/.test(t) && /See where to watch/.test(t)) && sev.prov.some((t) => /Amazon Video/.test(t) && /Buy/.test(t) && /Watch on Prime Video/.test(t)), 'Where it streams: Apple TV Plus (See where to watch), Amazon Video to buy (Watch on Prime Video)', sev && sev.prov);
    check(sev && /JustWatch/.test(sev.attr) && sev.hasEps && sev.eps.length === 2, 'its TMDB episodes and the JustWatch attribution are shown', sev && { attr: sev.attr, eps: sev.eps.length });
    check(sev && sev.eps.every((e) => e.dis && !e.next) && sev.tabs.every((t) => t.indexOf('(TMDB)') === -1), 'nothing plays from his services here: no episode is marked next, the rows are not buttons that do nothing, no TMDB marks', sev && { eps: sev.eps, tabs: sev.tabs });
    await shoot('elsewhere');
    await clickText('.shw-prov-r .btn', 'Watch on Prime Video');
    const pv = await layerAt(FP + '/search/');
    // The slot has the URL before its page asks the fixture for it: give the request a moment to land.
    for (let i = 0; pv && i < 50 && st.searched.indexOf('Severance') === -1; i++) await sleep(100);
    check(!!pv && st.searched.indexOf('Severance') !== -1, '"Watch on Prime Video" opens Prime Video’s search for Severance in the layer (no tab, no Edge)', pv);
    await closeLayer();
    check(await g.ev('LumenShows.isOpen()'), 'closing the layer leaves the Severance page where it was');

    /* ---- 4. Back, then Retry with Hulu answering ---- */
    await g.ev(`document.querySelector('.shw-back').click(), 1`);
    const back = await until(`v.h1 === 'The Bear' && v.s.depth === 0`, 5000);
    check(back && back.s.state === 'fallback', 'Back returns to The Bear as it was (no new read)', back && back.s);
    st.huluFail = false;
    await clickText('.shw-note .btn', 'Retry');
    const ok = await until(`v.s && v.s.state === 'ok' && v.play`, 45000);
    check(ok && ok.play === 'Resume S2 E3' && /min left/.test(ok.left), 'Retry, Hulu answers: the big button is Resume S2 E3, with the time left', ok && { play: ok.play, left: ok.left });
    check(ok && ok.wl === 'In My Stuff' && /2022/.test(ok.meta) && /TV-MA/.test(ok.meta) && /3 seasons/.test(ok.meta) && !ok.note, 'the hero: In My Stuff (read-only), 2022 · TV-MA · 3 seasons, no warning', ok && { wl: ok.wl, meta: ok.meta, note: ok.note });
    const e3 = ok && ok.eps.find((e) => e.next);
    check(ok && ok.tabs.indexOf('Season 2*') !== -1 && e3 && /^3\. /.test(e3.t) && e3.prog > 0 && e3.prog < 1 && /% watched/.test(e3.m), 'season 2 is open on its own; S2 E3 is marked next, with a progress bar and "% watched"', ok && { tabs: ok.tabs, e3 });
    await shoot('show', [[1280, 800], [1536, 800], [1920, 1000]]);
    // A box with no art (none sent, or its image failed) stays in its place: watch.css's .noart (absolute, inset 0)
    // once won and covered the whole page with one grey panel.
    const noart = await g.ev(`(() => { const host = document.querySelector('.shw .shw-body'); if (!host) return null; const out = {};
      for (const cls of ['shw-art', 'shw-thumb', 'shw-card-a']) { const n = document.createElement('span'); n.className = cls + ' noart'; host.appendChild(n);
        const cs = getComputedStyle(n); const b = n.getBoundingClientRect(); out[cls] = cs.position + ' ' + Math.round(b.width) + 'x' + Math.round(b.height); n.remove(); }
      out.page = innerWidth + 'x' + innerHeight; return out; })()`).catch(() => null);
    check(!!noart && ['shw-art', 'shw-thumb', 'shw-card-a'].every((k) => /^relative /.test(noart[k])), 'a show page box with no art stays in the flow (not watch.css’s absolute .noart over the page)', noart);
    await clickText('.shw-tab', 'Season 1');
    const s1 = await until(`v.tabs.indexOf('Season 1*') !== -1 && v.eps.length`, 5000);
    check(s1 && s1.eps.length === 3 && s1.eps.every((e) => e.done && e.check && /Watched/.test(e.m)), 'the Season 1 tab: every episode has its watched check', s1 && s1.eps);
    await shoot('watched');
    const tm0 = st.tmdb.length;
    await clickText('.shw-tab', 'Season 3');
    const s3 = await until(`v.tabs.indexOf('Season 3(TMDB)*') !== -1 && v.eps.length`, 15000);
    check(s3 && s3.eps.map((e) => e.t).join('|') === '1. Tomorrow|2. Next' && s3.fine.some((t) => /from TMDB: Hulu didn’t send them/.test(t)), 'the Season 3 tab (Hulu sent none): filled from TMDB, its tab marked TMDB, and it says so', s3 && { eps: s3.eps.map((e) => e.t), fine: s3.fine });
    check(st.tmdb.slice(tm0).indexOf('/tv/136315/season/3') !== -1, 'S3 came from TMDB’s /tv/136315/season/3 (the local mock)', st.tmdb.slice(tm0));
    await shoot('s3-tmdb');

    /* ---- 5. Resume and an episode play in the layer ---- */
    await g.ev(`document.querySelector('.shw-play').click(), 1`);
    const rs = await layerAt(FH + '/watch/');
    check(rs === FH + '/watch/' + EP(2, 3), 'Resume S2 E3 plays Hulu’s /watch/<S2 E3> in the layer', rs);
    await closeLayer();
    await clickText('.shw-tab', 'Season 1');
    await g.ev(`(() => { const b = document.querySelector('.shw-eps .shw-ep'); b.scrollIntoView({ block: 'nearest' }); b.click(); return 1; })()`);
    const e11 = await layerAt(FH + '/watch/' + EP(1, 1));
    for (let i = 0; i < 50 && st.played.indexOf(EP(1, 1)) === -1; i++) await sleep(100);   // the layer's page request lands just after its slot is set
    check(!!e11 && st.played.indexOf(EP(1, 1)) !== -1, 'an episode row (S1 E1) plays its own /watch/ in the layer', e11);
    await closeLayer();
    check(await g.ev('LumenShows.isOpen()'), 'the show page is still there after the layer closes');

    /* ---- 6. Esc closes the page ---- */
    await g.ev(`document.querySelector('.shw-back').focus(), 1`);
    await g.key('Escape', { code: 'Escape', vk: 27 });
    const shut = await g.waitFor('!LumenShows.isOpen() && document.querySelector(".shw").hidden', 3000).catch(() => false);
    check(!!shut, 'Esc closes the page (back to Lumen)');

    /* ---- 7. Disney+ and Prime Video show pages ---- */
    check(await openItem({ service: 'disney', kind: 'rec', type: 'show', title: 'Andor', url: 'https://www.disneyplus.com/browse/entity-aB3dE5fG7hJ9' }), 'a Disney+ title opens its page');
    const an = await until(`v.s && v.s.state === 'ok' && v.play`, 40000);
    check(an && an.h1 === 'Andor' && an.play === 'Resume S2 E1' && /isn’t proven/.test(an.why) && an.chip === 'On Disney+', 'Disney+ (Andor): Resume S2 E1, and why it opens the title page', an && { h1: an.h1, play: an.play, why: an.why, chip: an.chip });
    await shoot('disney');
    check(await openItem({ service: 'prime', kind: 'rec', type: 'show', title: 'The Boys', url: 'https://www.primevideo.com/detail/B07FMHTRFA/' }), 'a Prime Video title opens its page');
    const by = await until(`v.s && v.s.state === 'ok' && v.play`, 40000);
    check(by && by.play === 'Resume S1 E2' && by.chip === 'On Prime Video' && by.eps.some((e) => e.done) && by.eps.some((e) => e.prog > 0), 'Prime Video (The Boys): Resume S1 E2, E1 watched, E2 part-way', by && { play: by.play, eps: by.eps });
    await shoot('prime');

    /* ---- 8. film pages ---- */
    check(await openItem({ service: 'hulu', kind: 'rec', type: 'movie', title: 'Palm Springs', url: 'https://www.hulu.com/movie/palm-springs-' + PALM }), 'a Hulu film opens its page');
    const pm = await until(`v.s && v.s.state === 'ok' && v.play`, 40000);
    check(pm && pm.h1 === 'Palm Springs' && pm.play === 'Resume' && !pm.hasEps && /min/.test(pm.meta), 'a film page (Palm Springs): Resume, its runtime, no episode list', pm && { h1: pm.h1, play: pm.play, meta: pm.meta, eps: pm.hasEps });
    await shoot('film');
    await g.ev(`document.querySelector('.shw-play').click(), 1`);
    const fp = await layerAt(FH + '/watch/');
    check(fp === FH + '/watch/' + PALM, 'the film’s Resume plays Hulu’s /watch/<film> in the layer', fp);
    await closeLayer();
    check(await openItem({ service: 'prime', kind: 'rec', type: 'movie', title: 'Air', url: 'https://www.primevideo.com/detail/0AIRMOVIE0001/' }), 'a Prime Video film opens its page');
    const air = await until(`v.s && v.s.state === 'ok' && v.play`, 40000);
    check(air && air.play === 'Play' && /1 h 52 min/.test(air.meta) && air.wl === 'On your Watchlist', 'a Prime film (Air): Play, 1 h 52 min, On your Watchlist', air && { play: air.play, meta: air.meta, wl: air.wl });
    await shoot('film-prime');
    await g.ev('LumenShows.close(), 1');

    /* ---- 9. nothing left the machine ---- */
    check(net.real.length === 0, 'the Lumen page made no real network request (' + net.local + ' local, ' + net.art + ' art answered locally)', net.real.slice(0, 5));
    check(st.tmdb.indexOf('/tv/136315') !== -1 && st.tmdb.indexOf('/tv/95396') !== -1, 'TMDB was only ever the local mock (' + st.tmdb.length + ' requests, The Bear and Severance among them)', st.tmdb.slice(0, 8));
    let edge = '';
    try { edge = fs.readFileSync(EDGE_STUB, 'utf8'); } catch (e) { edge = ''; }
    check(!edge, 'nothing went to Edge', edge.slice(0, 160));
    check(errors.length === 0, 'no exceptions on the Lumen page', errors.slice(0, 3));
  } finally {
    srv.close();
    try { await mock.close(); } catch (e) { /* gone */ }
  }
});
