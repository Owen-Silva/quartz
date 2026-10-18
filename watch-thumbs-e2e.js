try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine: no cap needed */ }
// watch-thumbs-e2e.js -- YouTube art steps down from maxres to the sharpest still that exists, end to
// end: a REAL hidden Quartz test instance (e2e-kit: --test-profile, off-screen, watched by testwatch.js)
// reading the local mock of every service, then drawing tests/watch-snapshot.js dense() in place of what
// main pushes. Every picture request is answered from a LOCAL mock image server (127.0.0.1), never the
// real CDN: per video, maxres (webp + jpg) answers 404 with YouTube's 120x90 grey body, or 200 with
// that grey body, or a real 1280x720; sd 640x480 or 404; hq 480x360. Never a real account or profile.
//
//   node watch-thumbs-e2e.js [--cdp 9270] [--img-port 9271]
//
// Checks: each tile lands on the expected candidate (maxres / sd / hq) with that width; a 404'd maxres
// jpg is never asked for after its webp missed; a repaint asks for no maxres again; the hero shows
// maxres sharp, and an hq-only still softened (data-lowres + blur); no Cookie / Referer on the
// requests; no console errors. One line: "watch-thumbs-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');
const F = require('./tests/watch-snapshot');
const Shape = require('./watch/shape');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9270'));
const IMG_PORT = Number(opt('img-port', '9271'));
const TAG = 'quartz-watch-thumbs-' + process.pid;
const STUB = (n) => path.join(os.tmpdir(), TAG + '-' + n);

/* ---- a real raster (24-bit BMP) of w x h in one colour ---- */
const bmps = new Map();
function bmp(w, h, rgb, bars) {   // bars: black letterbox rows top and bottom (a fraction of h), as YouTube sd/hq have
  const k = w + "x" + h + ":" + rgb.join(",") + ":" + (bars || 0); const bh = Math.round(h * (bars || 0));
  if (bmps.has(k)) return bmps.get(k);
  const row = Math.ceil(w * 3 / 4) * 4;
  const b = Buffer.alloc(54 + row * h);
  b.write('BM', 0); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = 54 + y * row + x * 3; if (y < bh || y >= h - bh) continue; b[o] = rgb[2]; b[o + 1] = rgb[1]; b[o + 2] = rgb[0]; }
  bmps.set(k, b);
  return b;
}
const GREY = () => bmp(120, 90, [204, 204, 204]);   // what i.ytimg.com sends with a maxres 404

/* Per video: A maxres 404 -> sd; B maxres 404 + sd 404 -> hq; C maxres webp 200 grey -> sd; D maxres. */
const CASE = new Map();
const WANT = { A: 'sddefault.jpg', B: 'hqdefault.jpg', C: 'sddefault.jpg', D: 'maxresdefault.webp' };
const WANT_W = { A: 640, B: 480, C: 640, D: 1280 };
function answer(file, c) {
  if (/^maxresdefault\.webp$/.test(file)) {
    if (c === 'D') return [200, bmp(1280, 720, [40, 120, 200])];
    if (c === 'C') return [200, GREY()];
    return [404, GREY()];
  }
  if (/^maxresdefault\.jpg$/.test(file)) return c === 'D' ? [200, bmp(1280, 720, [40, 120, 200])] : [404, GREY()];
  if (/^sddefault\.jpg$/.test(file)) return c === 'B' ? [404, GREY()] : [200, bmp(640, 480, [60, 160, 90], 0.125)];
  if (/^hqdefault\.jpg$/.test(file)) return [200, bmp(480, 360, [180, 90, 60], 0.125)];
  return [404, GREY()];
}

function imageServer() {
  const srv = http.createServer((req, res) => {
    const m = /^\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})\/([A-Za-z0-9_.]+)$/.exec(req.url.split('?')[0]);
    let code = 200, body = bmp(320, 180, [90, 90, 110]);   // every other service's still
    if (m) [code, body] = answer(m[2], CASE.get(m[1]) || 'D');
    res.writeHead(code, { 'Content-Type': 'image/bmp', 'Content-Length': body.length, 'Cache-Control': 'max-age=3600' });
    res.end(body);
  });
  return new Promise((r) => srv.listen(IMG_PORT, '127.0.0.1', () => r(srv)));
}

async function guest(q, errors, log) {
  let t = null;
  for (let i = 0; i < 250 && !t; i++) {
    try { t = (await q.targets()).find((x) => /\/watch\.html(\?|#|$)/.test(String(x.url)) && x.webSocketDebuggerUrl); } catch (e) { t = null; }
    if (!t) await sleep(60);
  }
  if (!t) throw new Error('the Watch page never appeared as a CDP target');
  const g = await new Cdp(t.webSocketDebuggerUrl).open();
  g.ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).slice(0, 300));
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + (m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ').slice(0, 300));
    else if (m.method === 'Fetch.requestPaused') {
      const u = m.params.request.url;
      const hdr = Object.keys(m.params.request.headers || {}).map((h) => h.toLowerCase());
      let p = '/other';
      try { const x = new URL(u); if (/^i\d?\.ytimg\.com$/.test(x.hostname)) p = x.pathname; } catch (e) { /* other */ }
      log.push({ u, p, cookie: hdr.includes('cookie'), referer: hdr.includes('referer') });
      try {
        const r = await fetch('http://127.0.0.1:' + IMG_PORT + p);
        const body = Buffer.from(await r.arrayBuffer());
        g.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: r.status, responseHeaders: [{ name: 'Content-Type', value: 'image/bmp' }, { name: 'Cache-Control', value: 'max-age=3600' }], body: body.toString('base64') });
      } catch (e) { g.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'Failed' }); }
    }
  });
  await g.send('Runtime.enable');
  await g.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Image', requestStage: 'Request' }] });
  await g.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return g;
}

/* Every YouTube tile's picture: its case, src, natural width, done or not. */
const TILES = `(() => [...document.querySelectorAll('#stack .card')].filter((c) => c._item && c._item.service === 'youtube').map((c) => {
  const i = c.querySelector('img'); const id = (/v=([A-Za-z0-9_-]{11})/.exec(c._item.url) || [])[1] || '';
  const b = i ? i.getBoundingClientRect() : { width: 0, height: 0 };
  return { id, src: i ? i.src : '', w: i ? i.naturalWidth : 0, done: !!(i && i.complete && i.naturalWidth), noart: !!c.querySelector('.noart'),
    cssW: Math.round(b.width), cssH: Math.round(b.height), crop: i ? i.dataset.crop || '' : '', ovb: i ? getComputedStyle(i).objectViewBox : '', fit: i ? getComputedStyle(i).objectFit : '' };
}))()`;

if (require.main === module) {
  run('yt-thumbs', async (k) => {
    const { launch, say, check } = k;
    const dog = setTimeout(() => { console.log('FAIL HARNESS TIMEOUT: watch-thumbs-e2e did not finish in 6 min'); process.exit(1); }, 6 * 60 * 1000);
    dog.unref();
    const mock = await Mock.start({ log: () => {} });
    const imgs = await imageServer();
    const env = { QUARTZ_WATCH_BOOT_GRACE_MS: '0', QUARTZ_WATCH_REBASE: JSON.stringify(mock.rebase), QUARTZ_WATCH_OPEN_STUB: STUB('open.txt'), QUARTZ_EDGE_STUB: STUB('edge.txt'),
      QUARTZ_WATCH_MIN_FREE_GB: '0', QUARTZ_WATCH_GAME_FILE: STUB('game.flag'), QUARTZ_TEST_MIN_FREE_GB: process.env.QUARTZ_TEST_MIN_FREE_GB || '1.5' };
    const errors = [];
    const log = [];
    const q = await launch({ cdp: CDP_PORT, env });
    const chrome = q.chrome;
    try {
      await chrome.ev('(() => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); return 1; })()');
      const W = { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, modifiers: 3 };
      await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, W));
      await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, W));
      const g = await guest(q, errors, log);
      await g.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1000, deviceScaleFactor: 1, mobile: false });
      await g.waitFor('document.querySelectorAll("#stack .lrow .rt > .card").length > 3 || null', 120000).catch(() => 0);
      await g.waitFor('(() => { const p = document.querySelectorAll("#pills .sp.st-busy"); return p.length === 0 || null; })()', 90000).catch(() => 0);

      // dense, with every YouTube video given a case; A and C carry the adapter's images list, B and D
      // only the page's hqdefault (an older cache), so both paths are covered
      const snap = F.dense(Date.now());
      const ids = [...new Set(snap.items.filter((it) => it.service === 'youtube').map((it) => (/v=([A-Za-z0-9_-]{11})/.exec(it.url) || [])[1]).filter(Boolean))];
      ids.forEach((id, n) => CASE.set(id, 'ABCD'[n % 4]));
      for (const it of snap.items) {
        if (it.service !== 'youtube') continue;
        const id = (/v=([A-Za-z0-9_-]{11})/.exec(it.url) || [])[1];
        const c = CASE.get(id);
        if (c === 'A' || c === 'C') { const l = Shape.ytThumbs(it.image, id); it.image = l[0]; it.images = l; }
      }
      say(ids.length + ' YouTube videos: ' + ['A', 'B', 'C', 'D'].map((c) => c + '=' + ids.filter((i) => CASE.get(i) === c).length).join(' '));
      await g.ev('(() => { window.__thumbsApply = window.__applyWatch; window.__applyWatch = function () {}; window.__thumbsApply(' + JSON.stringify(snap) + '); return 1; })()');

      // let every tile in the first rows finish its chain
      await g.waitFor('(() => { const t = ' + TILES + '; return t.length && t.filter((x) => x.done).length >= Math.min(8, t.length) || null; })()', 30000).catch(() => 0);
      await sleep(2500);
      const tiles = await g.ev(TILES);
      const done = tiles.filter((t) => t.done);
      say(tiles.length + ' YouTube tiles, ' + done.length + ' loaded');
      for (const c of ['A', 'B', 'C', 'D']) {
        const mine = done.filter((t) => CASE.get(t.id) === c);
        const bad = mine.filter((t) => !t.src.endsWith('/' + t.id + '/' + WANT[c]) || t.w !== WANT_W[c]);
        check(mine.length > 0 && !bad.length, 'case ' + c + ': ' + mine.length + ' tile(s) land on ' + WANT[c] + ' (' + WANT_W[c] + ' wide)', bad.slice(0, 3));
      }
      const dTiles = done.filter((t) => CASE.get(t.id) === 'D' && t.cssW > 0);
      const thin = dTiles.filter((t) => t.w < 1.25 * t.cssW);
      check(dTiles.length > 0 && !thin.length, 'maxres tiles: the still is >= 1.25x the tile width (' + dTiles.map((t) => t.w + '/' + t.cssW).slice(0, 3).join(', ') + ')', thin.slice(0, 3));
      const boxed = done.filter((t) => /[ABC]/.test(CASE.get(t.id)));
      const barred = boxed.filter((t) => t.crop !== '16:9' || !/inset\(12\.5%/.test(t.ovb) || t.fit !== 'cover');
      check(boxed.length > 0 && !barred.length, 'sd/hq tiles: the 4:3 letterbox is cropped to the 16:9 picture (object-view-box ' + (boxed[0] && boxed[0].ovb) + ', cover)', barred.slice(0, 3));
      const maxNoCrop = dTiles.filter((t) => t.crop || (t.ovb && t.ovb !== 'none'));
      check(!maxNoCrop.length, 'maxres tiles are not cropped', maxNoCrop.slice(0, 2));
      check(!tiles.some((t) => t.noart),'no YouTube tile fell back to a title card', tiles.filter((t) => t.noart).slice(0, 3));

      const yt = log.filter((r) => r.p !== '/other');
      const count = (re) => yt.filter((r) => re.test(r.p)).length;
      const jpgMaxABC = yt.filter((r) => /maxresdefault\.jpg$/.test(r.p) && /[ABC]/.test(CASE.get(r.p.split('/')[2]) || ''));
      check(jpgMaxABC.length === 0, 'after a webp maxres miss the jpg maxres is never asked for', jpgMaxABC.slice(0, 3).map((r) => r.p));
      const dupes = {}; for (const r of yt) dupes[r.p] = (dupes[r.p] || 0) + 1;
      const twice = Object.keys(dupes).filter((p) => dupes[p] > 1 && /maxres/.test(p));
      check(!twice.length, 'no maxres URL asked for twice', twice.slice(0, 3));
      check(!log.some((r) => r.cookie) && !log.some((r) => r.referer), 'no Cookie and no Referer on any picture request (' + log.length + ' requests)', log.filter((r) => r.cookie || r.referer).slice(0, 2));
      check(!log.some((r) => /^https?:\/\/(?!i\d?\.ytimg\.com|a\.espncdn\.com)/.test(r.u) && /ytimg/.test(r.u)), 'only i.ytimg.com hosts for YouTube art');

      // a repaint (every YouTube subtitle changes, so the rows are redrawn): no maxres asked for again
      const before = count(/maxres/);
      const snap2 = JSON.parse(JSON.stringify(snap));
      for (const it of snap2.items) if (it.service === 'youtube') it.subtitle = (it.subtitle || '') + ' ';
      await g.ev('(() => { window.__thumbsApply(' + JSON.stringify(snap2) + '); return 1; })()');
      await sleep(2500);
      const tiles2 = await g.ev(TILES);
      const after = count(/maxres/) - before;
      const firstSrc = tiles2.filter((t) => t.done && /[ABC]/.test(CASE.get(t.id)) && !t.src.endsWith(WANT[CASE.get(t.id)]));
      check(after === 0, 'repaint: no maxres request again (' + after + ' new)', log.slice(-5).map((r) => r.p));
      check(tiles2.filter((t) => t.done).length > 0 && !firstSrc.length, 'repaint: tiles go straight to the still that exists', firstSrc.slice(0, 3));

      // the hero: a maxres video is sharp; an hq-only one is softened, not blown up blocky
      const HERO = (c) => `(async () => {
        const card = [...document.querySelectorAll('#stack .card')].find((x) => x._item && x._item.service === 'youtube' && ${JSON.stringify(ids.filter((i) => CASE.get(i) === c))}.some((id) => x._item.url.indexOf(id) !== -1));
        if (!card) return { none: 1 };
        card.focus();
        for (let n = 0; n < 60; n++) {
          await new Promise((r) => setTimeout(r, 100));
          const i = document.querySelector('#stage .pic .w img');
          if (i && i.complete && i.naturalWidth > 120 && card._item.url.indexOf((/\\/vi(?:_webp)?\\/([^/]+)\\//.exec(i.src) || [])[1]) !== -1) {
            const b = i.getBoundingClientRect();
            return { src: i.src, w: i.naturalWidth, boxW: Math.round(b.width), lowres: i.dataset.lowres || '', filter: i.style.filter, crop: i.dataset.crop || '', ovb: getComputedStyle(i).objectViewBox };
          }
        }
        return { timeout: 1, src: (document.querySelector('#stage .pic .w img') || {}).src || '' };
      })()`;
      const hd = await g.ev(HERO('D'));
      check(hd && /maxresdefault\.webp$/.test(hd.src) && hd.w === 1280 && !hd.lowres && !hd.filter, 'hero: a maxres video shows the 1280 still, unsoftened', hd);
      const hb = await g.ev(HERO('B'));
      check(hb && /hqdefault\.jpg$/.test(hb.src) && hb.w === 480 && hb.lowres === '1' && /blur\(/.test(hb.filter) && hb.crop === '16:9' && /inset/.test(hb.ovb), 'hero: an hq-only video is bar-cropped and softened (data-lowres, ' + (hb && hb.filter) + ') at ' + (hb && hb.boxW) + ' px wide', hb);
      const ha = await g.ev(HERO('A'));
      check(ha && /sddefault\.jpg$/.test(ha.src) && ha.w === 640, 'hero: a no-maxres video shows sd (' + (ha && ha.lowres ? 'softened ' + ha.filter : 'unsoftened') + ')', ha);

      const electron = errors.filter((e) => /sandboxed_renderer\.bundle\.js|binding\.startupData|preloadScripts/.test(e));
      const mine = errors.filter((e) => electron.indexOf(e) === -1);
      check(!mine.length, 'no console errors or exceptions on the Watch page', mine.slice(0, 5));
      g.close();
    } finally {
      try { await mock.close(); } catch (e) { /* gone */ }
      try { imgs.close(); } catch (e) { /* gone */ }
      for (const n of ['open.txt', 'edge.txt', 'game.flag']) { try { fs.rmSync(STUB(n), { force: true }); } catch (e) { /* none */ } }
    }
  });
}
