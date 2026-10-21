require('./tools/lowcpu-optional.js');   // first: the CPU cap, when one is configured (tools/lowcpu-optional.js; none on a cloud runner)
// watch-profiles-e2e.js -- one click from a Lumen tile to the video playing, as the right profile, end to end in a
// REAL hidden Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen). LOCAL FIXTURES ONLY: the rows come
// from tests/watch-mock.js; every service origin is rebased to a local "front" here that serves Hulu's who's-watching
// picker, Disney+'s /select-profile, a fixture Hulu player at /watch/<uuid> (a 1280x720 canvas recorded to WebM, which
// plays a few seconds and ENDS) and a refusing /watch/ (HTTP 404). Never a real account, cookie or service; Edge is a
// stub file.
//
//   node watch-profiles-e2e.js [--cdp 9483] [--shots <dir>]
//
// Checks: the profile chip (avatar + name); Hulu's who's-watching state with Pick profile (chip, card, freshness line);
// Pick profile opens Hulu's own picker in the layer and the layer closing re-reads Hulu (now on Alex); Disney+'s
// Switch profile opens /select-profile in the layer and re-reads Disney+ on close; a Continue tile says "Resume S4 E3 ·
// 15 min left" and goes straight to /watch/<episode>; the quality note "720p, browser limit"; the More menu's Open in
// Edge reasons; Up next after the episode ends (main re-reads Hulu, the next episode, a 10 s countdown, it plays);
// Cancel stops the next one; a refusing player falls back to the title page with the reason; Open in Edge from the
// menu reaches the Edge stub. Shots at 1536x800 and 1920x1000.
// One summary line: "watch-profiles-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9483'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'quartz-profiles-shots'));
const TAG = 'quartz-profiles-e2e-' + process.pid;
const EDGE_STUB = path.join(os.tmpdir(), TAG + '-edge.txt');
const HULU_HOME = JSON.parse(fs.readFileSync(path.join(__dirname, 'tests', 'watch-fixtures', 'hulu-home.json'), 'utf8'));
const BEAR_EP = '60da223c-d2a0-411a-95c9-665a839371f9';   // The Bear S4 E3 in hulu-home.json
const X_MOVIE = '3fbf22c6-aa72-4f9d-a34e-618687012de4';   // X, a film in Keep Watching: its /watch/ refuses here
const epUuid = (n) => (n === 3 ? BEAR_EP : ('0' + n).slice(-2) + BEAR_EP.slice(2));
const PLAY_MS = 2600;                                     // each fixture episode is this long

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 2000;
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, origin: 'http://127.0.0.1:' + s.address().port }));
  });
}
function sendHtml(res, body, code) { res.writeHead(code || 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); }
function sendJson(res, obj) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
const PAGE = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;background:#101113;color:#ddd;font:15px/1.45 "Segoe UI",sans-serif}
main{padding:40px 48px} h1{font:600 22px "Segoe UI";margin:0 0 18px} button{font:inherit;padding:10px 18px;margin-right:12px;border-radius:8px;border:1px solid #444;background:#1c1d20;color:#eee}
video{display:block;width:100%;height:100vh;background:#000;object-fit:contain}</style></head><body>${body}</body></html>`;
// A player: a 1280x720 canvas recorded to WebM, then played as a file, so the <video> really ends.
const PLAYER = (label) => PAGE(label, `<video id="v" muted playsinline></video><script>
(() => {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const x = c.getContext('2d'); let n = 0;
  const draw = () => { x.fillStyle = '#1d2733'; x.fillRect(0, 0, 1280, 720); x.fillStyle = '#e6e6e6'; x.font = '600 56px Segoe UI'; x.fillText(${JSON.stringify(label)}, 80, 340); x.font = '28px Segoe UI'; x.fillText('fixture player, frame ' + (n++), 80, 400); };
  draw(); const t = setInterval(draw, 66);
  const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm;codecs=vp8' }); const parts = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.onstop = () => { clearInterval(t); const v = document.getElementById('v'); v.src = URL.createObjectURL(new Blob(parts, { type: 'video/webm' })); v.play().catch((e) => console.log('play: ' + e.name)); window.__playing = 1; };
  rec.start(250); setTimeout(() => rec.stop(), ${PLAY_MS});
})();
</script>`);

async function startServers(mock, st) {
  const fronts = {};
  for (const svc of Mock.SERVICES) {
    fronts[svc] = await listen((req, res) => {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      const p = u.pathname;
      if (svc === 'hulu') {
        if (st.huluPicker && (p === '/hub/home' || p === '/my-stuff')) { res.writeHead(302, { Location: '/profiles' }); res.end(); return; }
        if (p === '/profiles') {
          return sendHtml(res, PAGE("Who's watching? | Hulu", `<main><h1>Who's watching?</h1><button id="p-alex" onclick="fetch('/__pick?p=Alex').then(() => { location.href = '/hub/home'; })">Alex</button><button id="p-family">Family</button></main>`));
        }
        if (p === '/__pick') { st.huluPicker = false; st.picked = u.searchParams.get('p'); return sendJson(res, { ok: true }); }
        const m = /^\/watch\/([0-9a-f-]{36})$/.exec(p);
        if (m) {
          st.watched.push(m[1]);
          if (m[1] === X_MOVIE) return sendHtml(res, PAGE('Hulu: something went wrong', '<main><h1>This video is unavailable</h1></main>'), 404);
          for (let n = 3; n < 12; n++) if (epUuid(n) === m[1]) { st.playing = Math.max(st.playing, n); return sendHtml(res, PLAYER('The Bear S4 E' + n)); }
          return sendHtml(res, PAGE('Hulu', '<main>unknown episode</main>'), 404);
        }
        if (/^\/(series|movie)\//.test(p)) return sendHtml(res, PAGE('Hulu title page', '<main><h1 id="tp">Hulu title page ' + p + '</h1></main>'));
        // Keep Watching moves on: after episode N started, The Bear's tile is episode N + 1 (Hulu's own Continue).
        if (p === HULU_HOME.captures[0].path.split('?')[0]) {
          const ep = st.playing ? st.playing + 1 : 3;
          const text = JSON.stringify(HULU_HOME.captures[0].json).split(BEAR_EP).join(epUuid(ep))
            .replace('"episode_number":"3"', '"episode_number":"' + ep + '"').replace('"name":"Bears"', '"name":"Episode ' + ep + '"');
          return sendJson(res, JSON.parse(text));
        }
      }
      if (svc === 'disney' && p === '/select-profile') {
        return sendHtml(res, PAGE("Who's Watching? | Disney+", '<main><h1>Who’s watching?</h1><button id="d-alex">Alex</button></main>'));
      }
      const up = http.request({ host: '127.0.0.1', port: mock.ports[svc], path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + mock.ports[svc] }) }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('mock gone'); } });
      req.pipe(up);
    });
  }
  const rebase = [];
  for (const svc of Mock.SERVICES) for (const from of Mock.ORIGINS[svc]) rebase.push([from, fronts[svc].origin]);
  return { fronts, rebase, close: () => { for (const f of Object.values(fronts)) f.server.close(); } };
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
async function cdpTo(t) { const c = await new Cdp(t.webSocketDebuggerUrl).open(); await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => 0); return c; }
const ST = 'WatchPlayer._state()';
const XS = 'WatchPlayer._state().extras';

run('watch-profiles-e2e', async ({ check, launch, say }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  try { fs.unlinkSync(EDGE_STUB); } catch (e) { /* none */ }
  const st = { huluPicker: true, picked: '', watched: [], playing: 0 };
  const mock = await Mock.start({ log: () => {} });
  const srv = await startServers(mock, st);
  const FH = srv.fronts.hulu.origin, FD = srv.fronts.disney.origin;
  try {
    const q = await launch({ cdp: CDP_PORT, env: {
      QUARTZ_WATCH_BOOT_GRACE_MS: '0', QUARTZ_WATCH_REBASE: JSON.stringify(srv.rebase), QUARTZ_EDGE_STUB: EDGE_STUB,
      QUARTZ_WATCH_MIN_FREE_GB: '0', QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1', QUARTZ_TEST_VMP: 'signed',
    } });
    const chrome = q.chrome;
    await chrome.ev('window.toggleFullscreen = function () {}; 1');
    const wv = await chrome.waitFor('(() => { const s = window.Drm && window.Drm.state(); return s && s.widevine && s.widevine.available ? s.widevine : null; })()', 120000).catch(() => null);
    check(!!wv, 'Widevine available (test-signed): Hulu titles play in the layer', wv && { available: wv.available });
    check(await chrome.ev('!!window.WatchPlayerExtras && !!window.LumenPlay'), 'the layer has its extras (watch-player-extras.js, watch/playurl.js)');

    const shoot = async (name, w, h) => {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(1000);
      try { await chrome.shot(path.join(SHOTS, 'n-profiles-' + name + '-' + w + 'x' + h + '.png')); } catch (e) { say('shot ' + name + ' failed: ' + e.message); }
      await chrome.send('Emulation.clearDeviceMetricsOverride');
      await sleep(300);
    };

    await chrome.ev('openWatchTab(), 1');
    const gt = await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 15000);
    const g = await cdpTo(gt);
    const pill = (svc) => `document.querySelector('.sp[data-svc="${svc}"]')`;

    /* ---- 1. the chip: the active profile, and the who's-watching state ---- */
    const dChip = await g.waitFor(`(() => { const p = ${pill('disney')}; const a = p && p.querySelector('.lp-av'); const n = p && p.querySelector('.sp-prof'); return a && n ? { av: a.textContent, name: n.textContent } : null; })()`, 90000).catch(() => null);
    check(dChip && dChip.av === 'A' && dChip.name === 'Alex', 'the Disney+ chip shows its active profile: the avatar and the name', dChip);
    const hPick = await g.waitFor(`(() => { const p = ${pill('hulu')}; const a = p && p.querySelector('.sp-act'); return p && p.classList.contains('st-picker') && a ? a.textContent : null; })()`, 120000).catch(() => null);
    check(hPick === 'Pick profile', 'Hulu on its who’s-watching page: the chip says so, with Pick profile', hPick || await g.ev(`(() => { const p = ${pill('hulu')}; return p ? p.className + ' | ' + (p.querySelector('.sp-main') || {}).title : 'no hulu pill'; })()`));
    await g.ev(`((${pill('hulu')} || document).querySelector('.sp-main') || { click: () => 0 }).click(), 1`);
    const pop = await g.waitFor(`(() => { const p = document.querySelector('.pop'); const b = p && p.querySelector('.lp-pick'); return b && !p.hidden ? { pick: b.textContent, primary: b.classList.contains('primary'), text: p.textContent } : null; })()`, 5000).catch(() => null);
    check(pop && pop.pick === 'Pick profile' && pop.primary && /asking who’s watching/.test(pop.text), 'the Hulu card: who’s watching, in words, with Pick profile first', pop && { pick: pop.pick, text: pop.text.slice(0, 160) });
    await shoot('picker-card', 1536, 800);
    await shoot('picker-card', 1920, 1000);

    /* ---- 2. Pick profile: Hulu's own picker, in the layer; closing re-reads Hulu ---- */
    await g.ev(`(document.querySelector('.pop .lp-pick') || { click: () => 0 }).click(), 1`);
    const lp = await chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.slots[0] && /\\/profiles/.test(s.slots[0].url) ? s : null; })()`, 15000).catch(() => null);
    check(!!lp && lp.slots[0].url.indexOf(FH + '/profiles') === 0, 'Pick profile opens Hulu’s own “Who’s watching?” in the layer (no tab)', lp && lp.slots[0].url);
    check(lp && lp.extras && lp.extras.purpose === 'profile' && /reads Hulu again when you close/.test(lp.note), 'the layer says Lumen reads Hulu again on close', lp && { note: lp.note, purpose: lp.extras && lp.extras.purpose });
    await shoot('picker-layer', 1536, 800);
    const pt = await targetWhere(q, (x) => String(x.url).indexOf(FH + '/profiles') === 0, 10000);
    const pg = pt && await cdpTo(pt);
    if (pg) { await pg.waitFor('!!document.getElementById("p-alex")', 10000).catch(() => 0); await pg.ev('(document.getElementById("p-alex") || { click: () => 0 }).click(), 1').catch(() => 0); pg.close(); }
    await chrome.waitFor(`(() => { const s = ${ST}; return s.slots[0] && /\\/hub\\/home/.test(s.slots[0].url); })()`, 10000).catch(() => 0);
    check(st.picked === 'Alex', 'the pick is Hulu’s own page answering (fixture), in the layer', st.picked);
    await chrome.ev('WatchPlayer.close("Close"), 1');
    const asked = await chrome.waitFor(`(() => { const c = ${ST}.lastClosed; return c && c.asked ? c.asked : null; })()`, 5000).catch(() => null);
    check(Array.isArray(asked) && asked.indexOf('hulu') !== -1, 'closing the picker re-reads Hulu', asked);
    const hOk = await g.waitFor(`(() => { const p = ${pill('hulu')}; const n = p && p.querySelector('.sp-prof'); return p && !p.classList.contains('st-picker') && n ? n.textContent : null; })()`, 60000).catch(() => null);
    check(hOk === 'Alex', 'Hulu reads again, now as Alex: the chip shows the profile', hOk);

    /* ---- 3. Switch profile (Disney+): the picker in the layer, re-read on close ---- */
    await g.ev(`((${pill('disney')} || document).querySelector('.sp-main') || { click: () => 0 }).click(), 1`);
    const sw = await g.waitFor(`(() => { const b = document.querySelector('.pop .lp-switch'); return b ? b.textContent : null; })()`, 5000).catch(() => null);
    check(sw === 'Switch profile', 'the Disney+ card has Switch profile', sw);
    await g.ev(`(document.querySelector('.pop .lp-switch') || { click: () => 0 }).click(), 1`);
    const ds = await chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.slots[0] && /select-profile/.test(s.slots[0].url) ? s.slots[0].url : null; })()`, 15000).catch(() => null);
    check(ds && ds.indexOf(FD + '/select-profile') === 0, 'Switch profile opens Disney+’s /select-profile in the layer', ds);
    await sleep(800);
    await chrome.ev('WatchPlayer.close("Close"), 1');
    const asked2 = await chrome.waitFor(`(() => { const c = ${ST}.lastClosed; return c && c.asked && c.services.indexOf('disney') !== -1 ? c.asked : null; })()`, 5000).catch(() => null);
    check(Array.isArray(asked2) && asked2.indexOf('disney') !== -1, 'closing it re-reads Disney+ (even inside Read now’s 30 s gap)', asked2);
    await shoot('chips', 1536, 800);
    await shoot('chips', 1920, 1000);

    // A real click, the way he does it (as watch-leak-e2e): when the card's row is not the one in the
    // lens (the re-reads above can leave another row there), the first click brings that row up
    // (watch.js onStackClick) and the second opens the title.
    const clickCard = async (sel) => {
      const at = await g.ev(`(() => { const c = ${sel}; if (!c) return null; const r = c.closest('.lrow'); const at = { key: r ? r.dataset.key : null, d: r ? r.dataset.d : null }; c.scrollIntoView({ block: 'nearest' }); c.click(); return at; })()`);
      if (at && at.key && at.d !== '0') {
        await g.waitFor(`(() => { const r = [...document.querySelectorAll('#stack > .lrow')].find((x) => x.dataset.key === ${JSON.stringify(at.key)}); return !!r && r.dataset.d === '0'; })()`, 4000).catch(() => 0);
        await sleep(500);
        await g.ev(`(() => { const c = ${sel}; if (!c) return 0; c.scrollIntoView({ block: 'nearest' }); c.click(); return 1; })()`);
      }
      return at;
    };

    /* ---- 4. Resume straight to the player ---- */
    const bearCard = `[...document.querySelectorAll('.card')].find((n) => n._item && n._item.service === 'hulu' && n._item.kind === 'resume' && n._item.title === 'The Bear')`;
    const sub = await g.waitFor(`(() => { const c = ${bearCard}; return c ? c.querySelector('.m span').textContent : null; })()`, 30000).catch(() => null);
    check(sub === 'Resume S4 E3 \u00b7 15 min left', 'the Continue tile: "Resume S4 E3 · 15 min left"', sub);
    await clickCard(bearCard);
    const s1 =await chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.slots[0] && s.slots[0].url.indexOf('/watch/') !== -1 ? s : null; })()`, 15000).catch(() => null);
    check(s1 && s1.slots[0].url === FH + '/watch/' + BEAR_EP, 'a click goes straight to Hulu’s player: /watch/<episode>, not the series page', s1 && s1.slots[0].url);
    const q1 = await chrome.waitFor(`(() => { const x = ${XS}; return x && x.quality ? x : null; })()`, 20000).catch(() => null);
    check(q1 && q1.quality === '720p, browser limit' && q1.height === 720 && /720p/.test(q1.qualityWhy), 'the quality note: the video’s real height, "720p, browser limit", with its reason', q1 && { q: q1.quality, h: q1.height, why: q1.qualityWhy });

    /* ---- 5. the menu: Open in Edge, and why ---- */
    await chrome.ev('(document.querySelector(".wpx-more") || { click: () => 0 }).click(), 1');
    const menu = await chrome.waitFor(`(() => { const x = ${XS}; return x && x.menu ? x.menu : null; })()`, 3000).catch(() => null);
    check(menu && menu.items.indexOf('Open in Edge to cast to a TV') !== -1 && menu.items.indexOf('Open in Edge for a sharper picture') !== -1 && menu.items.indexOf('Open in Edge: licence refused') === -1,
      'More: Open in Edge to cast, for a sharper picture (no licence item: none was refused)', menu);
    check(menu && menu.info.some((t) => /^Picture: 720p, browser limit/.test(t)), 'More says the picture’s limit in one line', menu && menu.info);
    await shoot('menu', 1536, 800);
    await shoot('menu', 1920, 1000);
    await chrome.ev('(document.querySelector(".wpx-more") || { click: () => 0 }).click(), 1');

    /* ---- 6. Up next: the episode ends, Hulu is read again, the next one counts down and plays ---- */
    const ask = await chrome.waitFor(`(() => { const x = ${XS}; return x && x.upnext && (x.upnext.phase === 'asking' || x.upnext.phase === 'counting') ? x.upnext : null; })()`, 20000).catch(() => null);
    check(!!ask, 'the episode ended: Up next asks Hulu for what follows', ask);
    const cnt = await chrome.waitFor(`(() => { const x = ${XS}; return x && x.upnext && x.upnext.phase === 'counting' ? x.upnext : null; })()`, 60000).catch(() => null);
    check(cnt && cnt.next && /S4 E4/.test(cnt.next.subtitle) && cnt.next.url === FH + "/watch/" + epUuid(4) && cnt.left >= 1 && cnt.left <= 10, 'Up next: The Bear S4 E4 from Hulu’s fresh Continue watching, counting down from 10', cnt);
    await shoot('upnext', 1536, 800);
    await shoot('upnext', 1920, 1000);
    const played = await chrome.waitFor(`(() => { const x = ${XS}; const s = ${ST}; return x && x.upnext && x.upnext.phase === 'played' && s.slots[0].url.indexOf('${epUuid(4)}') !== -1 ? s.slots[0].url : null; })()`, 16000).catch(() => null);
    check(!!played, 'at 0 the next episode plays in the layer (in place)', played);

    /* ---- 7. Cancel ---- */
    const cnt2 = await chrome.waitFor(`(() => { const x = ${XS}; return x && x.upnext && x.upnext.phase === 'counting' && x.upnext.next && /S4 E5/.test(x.upnext.next.subtitle) ? x.upnext : null; })()`, 70000).catch(() => null);
    check(!!cnt2, 'S4 E4 ended too: Up next offers S4 E5', cnt2);
    await chrome.ev('(document.querySelector(".wpx-up-cancel") || { click: () => 0 }).click(), 1');
    const can = await chrome.ev(`(() => { const x = ${XS}; return x.upnext; })()`);
    check(can && can.phase === 'cancelled' && !(await chrome.ev(`${XS}.upShown`)), 'Cancel: the card goes, nothing plays', can);
    await sleep(11500);
    const stay = await chrome.ev(`${ST}.slots[0].url`);
    check(stay.indexOf(epUuid(4)) !== -1 && st.watched.indexOf(epUuid(5)) === -1, '11 s later the layer is still on S4 E4 (S5 never loaded)', { stay, watched: st.watched.slice(-3) });

    /* ---- 8. the player refuses: the title page, and why ---- */
    await chrome.ev('WatchPlayer.close("Close"), 1');
    await sleep(800);
    const xCard = `[...document.querySelectorAll('.card')].find((n) => n._item && n._item.service === 'hulu' && n._item.kind === 'resume' && n._item.title === 'X')`;
    const xs = await g.waitFor(`(() => { const c = ${xCard}; return c ? c._item.playUrl || '' : null; })()`, 20000).catch(() => null);
    check(xs === 'https://www.hulu.com/watch/' + X_MOVIE, 'the film X in Keep Watching goes to /watch/ too', xs);
    await clickCard(xCard);
    const fb = await chrome.waitFor(`(() => { const x = ${XS}; const s = ${ST}; return x && x.fell && s.slots[0] && s.slots[0].url.indexOf('/movie/') !== -1 ? { fell: x.fell, url: s.slots[0].url, note: s.note } : null; })()`, 15000).catch(() => null);
    check(fb && /HTTP 404/.test(fb.fell) && fb.url === FH + '/movie/' + X_MOVIE && /opened the .*page instead/.test(fb.note), 'Hulu’s player refused (HTTP 404): the layer opened X’s title page and said why', fb);
    check(st.watched.indexOf(X_MOVIE) !== -1, 'the player URL was really tried first', st.watched.slice(-2));
    await shoot('fallback', 1536, 800);

    /* ---- 9. Open in Edge from the menu ---- */
    await chrome.ev('(document.querySelector(".wpx-more") || { click: () => 0 }).click(), 1');
    await chrome.waitFor(`!!${XS}.menu`, 3000).catch(() => 0);
    await chrome.ev(`([...document.querySelectorAll('.wpx-item')].find((b) => /cast/.test(b.textContent)) || { click: () => 0 }).click(), 1`);
    const edged = await chrome.waitFor(`(() => { const s = ${ST}; return !s.open ? 1 : 0; })()`, 8000).catch(() => 0);
    let stub = '';
    try { stub = fs.readFileSync(EDGE_STUB, 'utf8'); } catch (e) { stub = ''; }
    check(edged && /\/movie\//.test(stub), 'Open in Edge to cast: Edge (the stub) gets the page and the layer closes', stub.slice(0, 160));
  } finally {
    srv.close();
    try { await mock.close(); } catch (e) { /* gone */ }
  }
});
