try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine: no cap needed */ }
// watch-design-e2e.js -- Watch's top (the hero and the slim bar) and the design pass, end to end:
// a REAL hidden Quartz test instance (e2e-kit: --test-profile, off-screen, watched by testwatch.js)
// reading the local mock of every service, then drawing tests/watch-snapshot.js dense() (The user's real
// counts) in place of what main pushes. Never a real account, cookie or profile. The services'
// stills are answered here (Fetch) as plain title cards; real YouTube thumbnails and ESPN logos pass.
//
//   node watch-design-e2e.js [--cdp 9466] [--shots <dir>] [--prefix watch-design-after] [--shots-only]
//
// Shots: 1920x1000, 1280x800, 900x800, each at the top and two rows down (dark), plus 1280 light.
// Checks (not with --shots-only, which is for the BEFORE shots on the old code):
//   the top: the hero shown, the same after a trip down and back; past the first row the hero is
//   gone and the bar is 48-56 px and opaque; the rows in view (px) top vs scrolled; nothing overlaps
//   the bar (row titles, row controls, a focused card's ring) or anything else in the bar; "/" and a
//   service in both states; reduced motion; the merged tile; the rows by intent; frames over 20 ms
//   while stepping and hovering; no console errors. One line: "watch-design-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');
const F = require('./tests/watch-snapshot');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9466'));
const SHOTS = opt('shots', 'C:/Users/you/next-week/morning-shots');
const PREFIX = opt('prefix', 'watch-design-after');
const SHOTS_ONLY = argv.includes('--shots-only');
const ALSO = opt('also-prefix', '');   // a second name for the same files (watch-compact-*)
const TAG = 'quartz-watch-design-' + process.pid;
const STUB = (n) => path.join(os.tmpdir(), TAG + '-' + n);
const SIZES = [[1920, 1000], [1280, 800], [900, 800]];
const KNOWN_YT = new Set(['R6MlUcmOul8', 'PVGeM40dABA', 'mN0zPOpADL4', 'aqz-KE-bpKQ', 'h6fcK_fRYaI', 'wbSwFU6tY1c', 'WhWc3b3KhnY', 'UXqq0ZvbOnk', 'eRsGyueVLvQ', 'SkVqJ1SGeL0', 'TLkA0RELQ1g', 'UF8uR6Z6KLc']);

/* ---- a title card for a fixture still (as tools/watch-preview.js draws them) ---- */
const titles = new Map();
function hue(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function still(url) {
  const t = titles.get(url) || 'Untitled';
  const h1 = hue(t), h2 = (h1 + 40) % 360, size = t.length > 24 ? 64 : 92;
  return '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
    '<defs><radialGradient id="a" cx="22%" cy="18%" r="90%"><stop offset="0" stop-color="hsl(' + h1 + ',38%,46%)"/><stop offset="1" stop-color="hsl(' + h2 + ',30%,12%)"/></radialGradient>' +
    '<linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset=".45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></linearGradient></defs>' +
    '<rect width="1280" height="720" fill="url(#a)"/><circle cx="1010" cy="250" r="260" fill="hsl(' + h2 + ',40%,60%)" opacity=".18"/><rect width="1280" height="720" fill="url(#b)"/>' +
    '<text x="80" y="620" font-family="Segoe UI Variable Display, Segoe UI, sans-serif" font-weight="700" font-size="' + size + '" fill="#f4f3ef" letter-spacing="-2">' + esc(t) + '</text></svg>';
}

async function guest(q, errors) {
  let t = null;
  for (let i = 0; i < 250 && !t; i++) {
    try { t = (await q.targets()).find((x) => /\/watch\.html(\?|#|$)/.test(String(x.url)) && x.webSocketDebuggerUrl); } catch (e) { t = null; }
    if (!t) await sleep(60);
  }
  if (!t) throw new Error('the Watch page never appeared as a CDP target');
  const g = await new Cdp(t.webSocketDebuggerUrl).open();
  g.ws.on('message', (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).slice(0, 300));
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + (m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ').slice(0, 300));
    else if (m.method === 'Fetch.requestPaused') {
      const u = m.params.request.url;
      let host = ''; try { host = new URL(u).hostname; } catch (e) { host = ''; }
      const yt = /i\.ytimg\.com\/vi\/([^/]+)\//.exec(u);
      if (host === 'a.espncdn.com' || (yt && KNOWN_YT.has(yt[1]))) g.send('Fetch.continueRequest', { requestId: m.params.requestId });
      else g.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/svg+xml' }], body: Buffer.from(still(u)).toString('base64') });
    }
  });
  await g.send('Runtime.enable');
  await g.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*', resourceType: 'Image', requestStage: 'Request' }] });
  await g.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return g;
}

/* What the top and the rows look like right now (all from the page's own boxes). */
const STATE = `(() => {
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
  const cs = (e) => e ? getComputedStyle(e) : null;
  const top = document.querySelector('.top'), stage = document.getElementById('stage'), H = innerHeight;
  const bar = r(top);
  const rows = [...document.querySelectorAll('#stack .lrow')].map((x) => { const op = +cs(x).opacity; const h2 = x.querySelector('.lr-h h2'); const nav = [...x.querySelectorAll('.row-nav button')].filter((b) => cs(b).visibility !== 'hidden');
    return { key: x.dataset.key, d: x.dataset.d, title: h2 ? h2.textContent : '', op, box: r(x), head: r(h2), nav: nav.map(r) }; });
  const seen = rows.filter((x) => x.op > 0.05 && x.box.b > bar.b && x.box.t < H);
  const px = seen.reduce((n, x) => n + Math.max(0, Math.min(H, x.box.b) - Math.max(bar.b, x.box.t)), 0);
  return { compact: document.body.classList.contains('is-compact'), w: innerWidth, h: H, bar, barFill: +getComputedStyle(top, '::before').opacity,
    stageOp: +cs(stage).opacity, stageVis: cs(stage).visibility, stageBox: r(stage), h1: (stage.querySelector('h1') || {}).textContent || '',
    txt: r(stage.querySelector('.txt')), strip: r(document.getElementById('strip')), find: r(document.querySelector('.find')), settings: r(document.getElementById('settings')),
    brand: r(document.querySelector('.brand')), lensCtl: [...document.querySelectorAll('#lens-ctl .icon-btn')].filter((b) => cs(b).visibility !== 'hidden').map(r),
    rows, seenRows: seen.length, rowPx: Math.round(px), cur: rows.findIndex((x) => x.d === '0') };
})()`;

if (require.main === module) {
  run('watch-design-e2e', async (k) => {
    const { launch, say, check } = k;
    const dog = setTimeout(() => { console.log('FAIL HARNESS TIMEOUT: watch-design-e2e did not finish in 9 min'); process.exit(1); }, 9 * 60 * 1000);
    dog.unref();
    fs.mkdirSync(SHOTS, { recursive: true });
    const mock = await Mock.start({ log: () => {} });
    const env = { QUARTZ_WATCH_BOOT_GRACE_MS: '0', QUARTZ_WATCH_REBASE: JSON.stringify(mock.rebase), QUARTZ_WATCH_OPEN_STUB: STUB('open.txt'), QUARTZ_EDGE_STUB: STUB('edge.txt'),
      QUARTZ_WATCH_MIN_FREE_GB: '0', QUARTZ_WATCH_GAME_FILE: STUB('game.flag'), QUARTZ_TEST_MIN_FREE_GB: process.env.QUARTZ_TEST_MIN_FREE_GB || '1.5' };
    const errors = [];
    const q = await launch({ cdp: CDP_PORT, env });
    const chrome = q.chrome;
    try {
      await chrome.ev('setTheme("dark"), 1').catch(() => 0);
      await chrome.ev('(() => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); return 1; })()');
      const W = { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, modifiers: 3 };
      await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, W));
      await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, W));
      const g = await guest(q, errors);
      // the mock's reads first (so nothing main pushes later replaces the dense page), then dense, frozen
      await g.waitFor('document.querySelectorAll("#stack .lrow .rt > .card").length > 3 || null', 120000).catch(() => 0);
      await g.waitFor('(() => { const p = document.querySelectorAll("#pills .sp.st-busy"); return p.length === 0 || null; })()', 90000).catch(() => 0);
      const snap = F.dense(Date.now());
      for (const it of snap.items) if (it.image) titles.set(it.image, it.title);
      await g.ev('(() => { window.__designApply = window.__applyWatch; window.__applyWatch = function () { window.__designHeld = (window.__designHeld || 0) + 1; }; window.__designApply(' + JSON.stringify(snap) + '); return 1; })()');
      await sleep(1500);
      await chrome.ev('(() => { const w = findWatchTab(); if (w && w.viewEl) w.viewEl.focus(); return 1; })()').catch(() => 0);

      const grow = async (w, h) => {
        const r = await chrome.ev('(() => { const v = findWatchTab().viewEl; const b = v.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })()');
        if (r.w >= w && r.h >= h) return false;
        await chrome.ev('(() => { const v = findWatchTab().viewEl; v.dataset.e2eStyle = v.getAttribute("style") || ""; const s = v.style; s.setProperty("position", "fixed", "important"); s.setProperty("left", "0px", "important"); s.setProperty("top", "0px", "important"); s.setProperty("width", "' + w + 'px", "important"); s.setProperty("height", "' + h + 'px", "important"); s.setProperty("z-index", "2147483647", "important"); return 1; })()');
        await sleep(500);
        return true;
      };
      const ungrow = () => chrome.ev('(() => { const v = findWatchTab().viewEl; v.setAttribute("style", v.dataset.e2eStyle || ""); delete v.dataset.e2eStyle; return 1; })()').catch(() => 0);
      const size = async (w, h) => { await g.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(700); };
      const settle = async () => { await g.ev("new Promise((r) => { const imgs = [...document.images].filter((i) => !i.complete); if (!imgs.length) return r(1); let n = imgs.length; const done = () => { if (--n <= 0) r(1); }; imgs.forEach((i) => { i.addEventListener('load', done, { once: true }); i.addEventListener('error', done, { once: true }); }); setTimeout(() => r(0), 3000); })").catch(() => 0); await sleep(900); };
      const go = async (i) => { await g.ev('(() => { const r = document.querySelectorAll("#stack .lrow")[' + i + ']; const c = r && (r.querySelector(".rt [tabindex=\\"0\\"]") || r.querySelector(".card, .gc")); if (c) c.focus({ preventScroll: true }); return !!c; })()'); await sleep(900); };
      const wheel = async (dy, x, y) => { await g.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x || 400, y: y || 500, deltaX: 0, deltaY: dy }); await sleep(450); };
      const save = async (name) => {
        const file = path.join(SHOTS, PREFIX + '-' + name + '.png');
        try { await g.shot(file); if (ALSO) fs.copyFileSync(file, path.join(SHOTS, ALSO + '-' + name + '.png')); return true; } catch (e) { say('shot ' + name + ' failed: ' + e.message); return false; }
      };
      const st = () => g.ev(STATE);
      const blurAll = () => g.ev('(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return 1; })()');
      const measured = {};

      for (const [w, h] of SIZES) {
        const grown = await grow(w, h);
        await size(w, h);
        await go(0); await blurAll(); await settle();
        const top = await st();
        await save(w + 'x' + h + '-top');
        await go(2); await blurAll(); await settle();
        const down = await st();
        await save(w + 'x' + h + '-scrolled');
        measured[w + 'x' + h] = { top: top.rowPx, scrolled: down.rowPx, rowsTop: top.seenRows, rowsDown: down.seenRows, bar: down.bar.h };
        say(w + 'x' + h + ': rows in view ' + top.rowPx + ' px (' + top.seenRows + ' rows) at the top, ' + down.rowPx + ' px (' + down.seenRows + ' rows) two rows down; bar ' + down.bar.h + ' px, fill ' + down.barFill);
        if (!SHOTS_ONLY) {
          check(!top.compact && top.stageOp > 0.99 && top.stageVis === 'visible' && !!top.h1, w + 'x' + h + ': at the top the hero is shown (' + top.h1 + ')', { op: top.stageOp, vis: top.stageVis });
          check(down.compact && down.stageOp < 0.01 && down.stageVis === 'hidden', w + 'x' + h + ': two rows down the hero is gone', { op: down.stageOp, vis: down.stageVis });
          check(down.bar.h >= 48 && down.bar.h <= 56 && down.barFill > 0.99, w + 'x' + h + ': the slim bar is ' + down.bar.h + ' px and opaque (fill ' + down.barFill + ')');
          check(down.rowPx > top.rowPx, w + 'x' + h + ': more of the window is rows once scrolled (' + top.rowPx + ' -> ' + down.rowPx + ' px)');
          for (const s of [top, down]) {
            const where = w + 'x' + h + (s.compact ? ' scrolled' : ' top');
            const live = s.rows.filter((x) => x.op > 0.05 && x.box.t < s.h);
            const under = [];
            for (const x of live) {
              if (x.head && x.head.t < s.bar.b) under.push(x.title + ' title at ' + x.head.t);
              for (const n of x.nav) if (n.t < s.bar.b) under.push(x.title + ' arrow at ' + n.t);
            }
            for (const c of s.lensCtl) if (c.t < s.bar.b) under.push('lens control at ' + c.t);
            check(!under.length, where + ': nothing in view sits under the bar', under);
            check(s.strip.l >= s.find.r + 8 && s.strip.r <= s.settings.l && s.find.l >= s.brand.r, where + ': brand, search, services and Settings do not overlap', { brand: s.brand, find: s.find, strip: s.strip, settings: s.settings });
            if (!s.compact && s.txt) {
              const r0 = s.rows.find((x) => x.d === '0');
              check(r0 && r0.head && s.txt.b <= r0.head.t, where + ': the hero ends above the first row title', { txt: s.txt, head: r0 && r0.head });
            }
          }
          // the hero is the same after a trip down and back
          await go(0); await blurAll(); await sleep(900);
          const back = await st();
          check(JSON.stringify(back.stageBox) === JSON.stringify(top.stageBox) && back.h1 === top.h1 && JSON.stringify(back.txt) === JSON.stringify(top.txt), w + 'x' + h + ': back at the top, the hero is exactly where it was', { before: top.txt, after: back.txt });
        }
        await g.send('Emulation.clearDeviceMetricsOverride');
        if (grown) { await ungrow(); await sleep(400); }
      }

      // light, 1280: the same two states
      await chrome.ev('setTheme("light"), 1').catch(() => 0);
      await sleep(900);
      { const grown = await grow(1280, 800); await size(1280, 800); await go(0); await blurAll(); await settle(); await save('1280x800-light-top'); await go(2); await blurAll(); await settle(); await save('1280x800-light-scrolled');
        await g.send('Emulation.clearDeviceMetricsOverride'); if (grown) await ungrow(); }
      await chrome.ev('setTheme("dark"), 1').catch(() => 0);
      await sleep(600);
      fs.writeFileSync(path.join(SHOTS, PREFIX + '-measure.json'), JSON.stringify(measured, null, 1));
      if (SHOTS_ONLY) return;

      /* ---- behaviour at the e2e's own window size ---- */
      await go(0); await blurAll(); await sleep(700);
      const order = (await st()).rows.map((x) => x.title);
      say('rows: ' + order.join(' | '));
      check(order[0] === 'Continue watching' && order[1] === 'Live now' && order[2] === 'Your list' && order[3] === 'For you' && order.indexOf('Upcoming games') === 4 && order.indexOf('Recent games') === 5, 'rows by intent: Continue watching, Live now, Your list, For you, Upcoming games, Recent games, then the services\' shelves', order.slice(0, 7));
      const martian = await g.ev('(() => { const c = [...document.querySelectorAll("#stack .rt > .card")].find((x) => x._item && x._item.title === "The Martian"); if (!c) return null; return { marks: [...c.querySelectorAll(".chips .mk")].map((m) => m.dataset.svc), url: c._item.url, label: c.getAttribute("aria-label") }; })()');
      check(martian && martian.marks.join(',') === 'prime,disney' && /primevideo\.com/.test(martian.url) && /Also on Disney\+/.test(martian.label), 'merge: The Martian is one tile with both marks, opening Prime (where he is watching it)', martian);
      const games = await g.ev('[...document.querySelectorAll("#stack .lrow[data-key=sports] .gc")].length');
      check(games === 2, 'Live now: the 2 live games as tiles (' + games + ')');

      for (const compact of [false, true]) {
        const where = compact ? 'scrolled' : 'top';
        await go(compact ? 1 : 0); await sleep(700);
        // "/" from a focused card goes to the search field
        await g.key('/', { code: 'Slash', vk: 191 });
        await sleep(250);
        const inQ = await g.ev('document.activeElement && document.activeElement.id === "q"');
        check(inQ, where + ': "/" puts the cursor in search');
        await g.key('Escape', { code: 'Escape', vk: 27 });
        await sleep(300);
        // a service, clicked where it is drawn, opens its card; nothing covers it
        const at = await g.ev('(() => { const b = document.querySelector("#pills .sp[data-svc=\\"disney\\"] .sp-main").getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, hit: !!hit && !!hit.closest(".sp[data-svc=\\"disney\\"]") }; })()');
        check(at.hit, where + ': the Disney+ status is on top where it is drawn', at);
        await g.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        await g.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        await sleep(500);
        const pop = await g.ev('(() => { const p = document.getElementById("pop"); return !p.hidden ? (p.textContent || "").slice(0, 60) : null; })()');
        check(!!pop, where + ': clicking it opens Disney+\'s card (' + pop + ')');
        await g.key('Escape', { code: 'Escape', vk: 27 });
        await sleep(400);
        const still = await g.ev('document.body.classList.contains("is-compact")');
        check(still === compact, where + ': the top stays ' + (compact ? 'slim' : 'full') + ' through all that');
        // a focused card's ring is fully below the bar
        await go(compact ? 1 : 0);
        const ring = await g.ev('(() => { const a = document.activeElement; const b = a.getBoundingClientRect(); return { t: Math.round(b.top), bar: Math.round(document.querySelector(".top").getBoundingClientRect().bottom) }; })()');
        check(ring.t >= ring.bar, where + ': the focused card (and its ring) is below the bar', ring);
      }

      // frames: wheel down through the top's change and back, then hover across a row's tiles
      await go(0); await blurAll(); await sleep(800);
      await g.ev('(() => { window.__fr = { d: [], on: true }; let last = performance.now(); const f = (t) => { const x = window.__fr; if (!x.on) return; x.d.push(t - last); last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); return 1; })()');
      await sleep(400);
      for (let i = 0; i < 4; i++) await wheel(120);
      for (let i = 0; i < 4; i++) await wheel(-120);
      await wheel(120);
      const cards = await g.ev('[...document.querySelectorAll("#stack .lrow[data-d=\\"0\\"] .rt > .card")].slice(0, 5).map((c) => { const b = c.getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 3)]; })');
      for (let pass = 0; pass < 2; pass++) for (const [x, y] of cards) { for (let s = 0; s < 4; s++) { await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 30 + s * 20, y }); await sleep(60); } await sleep(200); }
      const fr = await g.ev('(() => { const x = window.__fr; x.on = false; const d = x.d.slice(3); return { n: d.length, over: d.filter((v) => v > 20).map((v) => Math.round(v * 10) / 10), max: Math.round(Math.max.apply(null, d) * 10) / 10 }; })()');
      say('frames: ' + fr.n + ', over 20 ms: ' + fr.over.length + ' ' + JSON.stringify(fr.over) + ', max ' + fr.max + ' ms');
      check(fr.n > 150, 'frames: the page rendered while stepping and hovering (' + fr.n + ')');
      check(fr.over.length === 0, 'frames over 20 ms while stepping through the top change and hovering tiles: ' + fr.over.length + ' (max ' + fr.max + ' ms)', fr.over);

      // reduced motion: the change is a short fade only
      await g.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await go(0); await sleep(300); await go(1); await sleep(400);
      const rm = await g.ev('(() => { const c = getComputedStyle(document.getElementById("stage")); return { tp: c.transitionProperty, tf: c.transform, compact: document.body.classList.contains("is-compact") }; })()');
      check(rm.compact && !/transform/.test(rm.tp) && rm.tf === 'none', 'reduced motion: the hero only fades (' + rm.tp + ', ' + rm.tf + ')', rm);
      await g.send('Emulation.setEmulatedMedia', { features: [] });

      check(!errors.length, 'no console errors or exceptions on the Watch page', errors.slice(0, 5));
      g.close();
    } finally {
      try { await mock.close(); } catch (e) { /* gone */ }
      for (const n of ['open.txt', 'edge.txt', 'game.flag']) { try { fs.rmSync(STUB(n), { force: true }); } catch (e) { /* none */ } }
    }
  });
}
