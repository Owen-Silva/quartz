require('C:/Users/you/tools/lowcpu.js');
'use strict';
/*
 * tools/watch-preview.js -- headless shots of watch.html with the fixtures in
 * tests/watch-snapshot.js, plus a few behaviour checks (keyboard, protocol lines,
 * nothing animating at rest). NOT part of the suite: a design/QA aid.
 *
 *   NODE_PATH=<a node_modules with playwright-core> node tools/watch-preview.js [outDir] [only]
 *
 * One headless Chromium (lowcpu.js caps it and holds the machine-wide browser lock),
 * Below Normal. The page is the real watch.html over file://; the services' https
 * images are answered by page.route: YouTube thumbnails and ESPN logos pass through
 * to their public CDNs, the Disney+/Prime/TMDB stills (fixture URLs) are drawn here
 * as simple title cards, and everything else is refused. Never Quartz, never a profile.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (err) { /* lowcpu.js already did */ }
const { chromium } = require('playwright-core');
const F = require('../tests/watch-snapshot');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || 'C:/Users/you/next-week/watch/shots');
const ONLY = process.argv[3] ? new RegExp(process.argv[3]) : null;
const PAGE = 'file:///' + path.join(ROOT, 'watch.html').replace(/\\/g, '/');
const PASS_HOSTS = ['i.ytimg.com', 'a.espncdn.com'];
const DRAW_HOSTS = ['disney.images.edge.bamgrid.com', 'm.media-amazon.com', 'image.tmdb.org'];

const riot = () => { try { return /valorant|riot/i.test(cp.execSync('tasklist /FO CSV /NH', { encoding: 'utf8' })); } catch (err) { return false; } };

/* A title card for a fixture still: a quiet gradient and the title, 1280 x 720. */
const titles = new Map();
function learn(snap) { for (const it of (snap.items || [])) if (it.image) titles.set(it.image, it.title); }
[F.full(), F.mixedFailures()].forEach(learn);
for (const r of F.searchAnswerTmdb('andor', 1).tmdb.results || []) if (r.image) titles.set(r.image, r.title);
function hue(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function still(url) {
  const t = titles.get(url) || 'Untitled';
  const h1 = hue(t), h2 = (h1 + 40) % 360;
  const size = t.length > 24 ? 64 : 92;
  return '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
    '<defs><radialGradient id="a" cx="22%" cy="18%" r="90%"><stop offset="0" stop-color="hsl(' + h1 + ',38%,46%)"/><stop offset="1" stop-color="hsl(' + h2 + ',30%,12%)"/></radialGradient>' +
    '<linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset=".45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></linearGradient></defs>' +
    '<rect width="1280" height="720" fill="url(#a)"/><circle cx="1010" cy="250" r="260" fill="hsl(' + h2 + ',40%,60%)" opacity=".18"/><rect width="1280" height="720" fill="url(#b)"/>' +
    '<text x="80" y="620" font-family="Segoe UI Variable Display, Segoe UI, sans-serif" font-weight="700" font-size="' + size + '" fill="#f4f3ef" letter-spacing="-2">' + esc(t) + '</text></svg>';
}

const log = [];
function note(s) { log.push(s); console.log(s); }

(async () => {
  if (riot()) { console.log('RIOT/VALORANT running: no browser. Abort.'); process.exit(4); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--allow-file-access-from-files'] });
  const guard = setInterval(() => { if (riot()) { console.log('RIOT appeared: closing the browser'); browser.close().catch(() => {}); process.exit(5); } }, 5000);
  let failures = 0;
  try {
    const sizes = { s: [1280, 800], l: [1920, 1080] };

    async function open(theme, size, opts) {
      opts = opts || {};
      const [w, h] = sizes[size];
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
      const page = await ctx.newPage();
      page._lines = [];
      page._errors = [];
      page.on('console', (m) => { const t = m.text(); if (t.indexOf('quartz-watch:') === 0) page._lines.push(t); else if (m.type() === 'error') page._errors.push(t); });
      page.on('pageerror', (e) => page._errors.push('pageerror: ' + e.message));
      await page.route('**/*', (route) => {
        const u = route.request().url();
        if (u.startsWith('file:')) return route.continue();
        let host = '';
        try { host = new URL(u).hostname; } catch (err) { host = ''; }
        if (PASS_HOSTS.includes(host)) return route.continue();
        if (DRAW_HOSTS.includes(host)) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: still(u) });
        return route.abort();
      });
      await page.goto(PAGE + '?theme=' + theme, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);
      return { ctx, page };
    }
    async function apply(page, snap) { await page.evaluate((s) => window.__applyWatch(s), snap); }
    async function settle(page, ms) { await page.waitForTimeout(ms || 900); }
    async function shot(page, name) {
      if (ONLY && !ONLY.test(name)) return;
      const file = path.join(OUT, 'impl-' + name + '.png');
      await page.screenshot({ path: file });
      note('shot ' + path.basename(file));
    }
    async function lastSeq(page) {
      for (let i = page._lines.length - 1; i >= 0; i--) {
        const m = /^quartz-watch:search (.*)$/.exec(page._lines[i]);
        if (m) return JSON.parse(m[1]).seq;
      }
      return -1;
    }
    async function report(page, label) {
      if (page._errors.length) { failures++; note('ERRORS ' + label + ': ' + page._errors.join(' | ')); }
    }
    async function idleAnimations(page) {
      await page.waitForTimeout(1600);
      return page.evaluate(() => document.getAnimations().map((a) => (a.effect && a.effect.target ? a.effect.target.className : '') + ':' + a.playState));
    }

    // 1. Boot (no snapshot yet), then the full set, both themes, both sizes.
    for (const theme of ['dark', 'light']) {
      for (const size of ['s', 'l']) {
        const tag = (size === 's' ? '1280' : '1920') + '-' + theme;
        const { ctx, page } = await open(theme, size);
        if (size === 's') { await settle(page, 300); await shot(page, tag + '-boot'); }
        const now = Date.now();
        await apply(page, F.full(now));
        await settle(page, 1100);
        await shot(page, tag);
        if (size === 's' && theme === 'dark') {
          note('lines after load: ' + page._lines.join(' ; '));
          const anim = await idleAnimations(page);
          note('animations at rest: ' + (anim.length ? anim.join(', ') : 'none'));
          if (anim.length) failures++;
          // keyboard: focus the lens card, Right, Down, Down
          await page.keyboard.press('ArrowRight');
          await settle(page, 600);
          const k0 = await page.evaluate(() => { const a = document.activeElement; return a && a.className + ' ' + (a.dataset.key || ''); });
          await page.keyboard.press('ArrowRight');
          await settle(page, 600);
          const k1 = await page.evaluate(() => { const a = document.activeElement; return [...a.parentNode.children].indexOf(a); });
          await shot(page, tag + '-focus');
          await page.keyboard.press('ArrowDown');
          await settle(page, 900);
          const k2 = await page.evaluate(() => { const a = document.activeElement; const r = a.closest('.lrow'); return (r && r.dataset.key) + ' d=' + (r && r.dataset.d) + ' ' + a.className; });
          await shot(page, tag + '-sports');
          await page.keyboard.press('ArrowDown');
          await settle(page, 900);
          const k3 = await page.evaluate(() => { const a = document.activeElement; const r = a.closest('.lrow'); return (r && r.dataset.key) + ' ' + document.getElementById('lpos').textContent; });
          await page.keyboard.press('End');
          await settle(page, 900);
          const k4 = await page.evaluate(() => { const a = document.activeElement; return [...a.parentNode.children].indexOf(a) + '/' + a.parentNode.children.length; });
          await shot(page, tag + '-end');
          note('keys: first=' + k0 + ' | right->index ' + k1 + ' | down->' + k2 + ' | down->' + k3 + ' | End->' + k4);
          // hover an Edge card in the current row
          await page.keyboard.press('Home');
          await settle(page, 700);
          const box = await page.evaluate(() => { const c = document.querySelector('.lrow[data-d="0"] .card:nth-child(2)'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 60 }; });
          if (box) { await page.mouse.move(box.x, box.y); await settle(page, 700); await shot(page, tag + '-hover'); await page.mouse.move(5, 790); }
          // the toasts
          await page.evaluate(() => { window.__applyWatchResult({ action: 'open', ok: true, how: 'edge', reason: '' }); window.__applyWatchResult({ action: 'open', ok: false, how: 'edge', reason: 'Microsoft Edge is not installed on this PC' }); });
          await settle(page, 600);
          await shot(page, tag + '-toast');
          // search: local + YouTube answer
          await page.keyboard.press('/');
          await page.keyboard.type('blender');
          await settle(page, 450);
          const seq = await lastSeq(page);
          note('search line seq=' + seq + ' lines=' + page._lines.filter((l) => l.indexOf('search') !== -1).join(' ; '));
          await shot(page, tag + '-search-pending');
          await page.evaluate((a) => window.__applyWatchSearch(a), F.searchAnswer('blender', seq));
          await settle(page, 500);
          await shot(page, tag + '-search');
          // stale seq is ignored
          await page.evaluate((a) => window.__applyWatchSearch(a), F.searchAnswerFailed('blender', seq - 1));
          await settle(page, 200);
          const still2 = await page.evaluate(() => !!document.querySelector('.res-note.err'));
          note('stale search answer ignored: ' + (!still2));
          if (still2) failures++;
          // grid keyboard
          await page.keyboard.press('Tab');
          await page.keyboard.press('Tab');
          const g0 = await page.evaluate(() => { const a = document.activeElement; return a.className + ' r=' + a.dataset.r + ' c=' + a.dataset.c; });
          await page.keyboard.press('ArrowDown');
          const g1 = await page.evaluate(() => { const a = document.activeElement; return a.className + ' r=' + a.dataset.r + ' c=' + a.dataset.c; });
          note('grid keys: tab->' + g0 + ' | down->' + g1);
          await shot(page, tag + '-search-focus');
          // Esc back to the field, Esc clears
          await page.keyboard.press('Escape');
          await page.keyboard.press('Escape');
          await settle(page, 600);
          const back = await page.evaluate(() => document.body.classList.contains('searching') + ' q="' + document.getElementById('q').value + '"');
          note('after Esc Esc: searching=' + back);
          await report(page, tag);
        }
        await ctx.close();
      }
    }

    // 2. Failures, mixed: both themes; the Disney+ popover; a failed YouTube search.
    for (const theme of ['dark', 'light']) {
      const tag = '1280-' + theme;
      const { ctx, page } = await open(theme, 's');
      await apply(page, F.mixedFailures(Date.now()));
      await settle(page, 1100);
      await shot(page, tag + '-mixed');
      if (theme === 'dark') {
        const strip = await page.evaluate(() => [...document.querySelectorAll('.sp')].map((p) => p.textContent.replace(/\s+/g, ' ').trim()).join(' | ') + ' || ' + document.getElementById('fresh').textContent);
        note('strip (mixed): ' + strip);
        await page.click('.sp[data-svc="disney"] .sp-main');
        await settle(page, 500);
        await shot(page, tag + '-mixed-pop');
        await page.keyboard.press('Escape');
        // move the lens to the Disney+ row (stale)
        const idx = await page.evaluate(() => [...document.querySelectorAll('.lrow')].findIndex((r) => /svc-disney/.test(r.dataset.key)));
        for (let i = 0; i < idx; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(450); }
        await settle(page, 900);
        await shot(page, tag + '-mixed-stale-row');
        await page.click('#q');
        await page.keyboard.type('andor');
        await settle(page, 450);
        const seq = await lastSeq(page);
        await page.evaluate((a) => window.__applyWatchSearch(a), F.searchAnswerFailed('andor', seq));
        await settle(page, 500);
        await shot(page, tag + '-search-failed');
      } else {
        await page.click('#q');
        await page.keyboard.type('andor');
        await settle(page, 450);
        const seq = await lastSeq(page);
        await page.evaluate((a) => window.__applyWatchSearch(a), F.searchAnswerTmdb('andor', seq));
        await settle(page, 500);
        await shot(page, tag + '-search-tmdb');
      }
      await report(page, tag + ' mixed');
      await ctx.close();
    }

    // 3. First run, nothing read, all paused, reduced motion.
    const states = [['firstrun', F.firstRun], ['empty', F.empty], ['paused', F.allPaused]];
    for (const [name, make] of states) {
      const { ctx, page } = await open('dark', 's');
      await apply(page, make(Date.now()));
      await settle(page, 900);
      await shot(page, '1280-dark-' + name);
      await report(page, name);
      await ctx.close();
    }
    {
      const { ctx, page } = await open('light', 'l', { reduced: true });
      await apply(page, F.full(Date.now()));
      await settle(page, 600);
      await page.keyboard.press('ArrowDown');
      await settle(page, 400);
      const tr = await page.evaluate(() => getComputedStyle(document.getElementById('stack')).transitionDuration);
      note('reduced motion: stack transition-duration=' + tr);
      await shot(page, '1920-light-firstrun-reduced');
      await apply(page, F.firstRun(Date.now()));
      await settle(page, 400);
      await shot(page, '1920-light-firstrun');
      await report(page, 'reduced');
      await ctx.close();
    }
    // 4. An odd snapshot never throws.
    {
      const { ctx, page } = await open('dark', 's');
      await page.evaluate(() => {
        window.__applyWatch(null);
        window.__applyWatch({});
        window.__applyWatch({ services: [{ id: 'youtube', state: 'weird' }, null, 7], rows: [{ id: 'x', title: 'X', items: [{ title: 'No url' }, { title: 'Bad', url: 'javascript:alert(1)' }, { title: '<b>ok</b>', url: 'https://www.youtube.com/watch?v=1', image: 'http://insecure/x.jpg' }] }], sports: { live: [{}] } });
        window.__applyWatchSearch({ seq: 'x' });
        window.__applyWatchResult(null);
      });
      await settle(page, 600);
      const body = await page.evaluate(() => ({ cards: document.querySelectorAll('.lrow .card').length, html: /<b>ok<\/b>/.test(document.querySelector('.card .m b') ? document.querySelector('.card .m b').textContent : ''), insecure: [...document.images].some((i) => i.src.startsWith('http:')) }));
      note('odd snapshot: cards=' + body.cards + ' textIsLiteral=' + body.html + ' insecureImg=' + body.insecure);
      await shot(page, '1280-dark-odd');
      await report(page, 'odd');
      await ctx.close();
    }
  } catch (err) {
    failures++;
    note('PREVIEW FAILED: ' + (err && err.stack || err));
  } finally {
    clearInterval(guard);
    await browser.close().catch(() => {});
  }
  note('SUMMARY: ' + (failures ? failures + ' problem(s)' : 'no page errors, nothing animating at rest'));
  fs.writeFileSync(path.join(OUT, 'impl-preview.log'), log.join('\n') + '\n');
  process.exit(failures ? 1 : 0);
})();
