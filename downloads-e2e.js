// downloads-e2e.js -- downloads, end to end, in a REAL Quartz test instance.
//
//   node downloads-e2e.js
//
// tests/e2e-kit.js launches it (--test-profile, off-screen, watched). A local server hands out
// attachments, and every download starts the way a user starts one: a click on a link in a page.
//   ok.bin      3 MB in 256 KB steps over ~3 s, with a length: the nav button appears, the panel
//               opens by itself, the ring and the row's bar move ("x MB of 3.0 MB"), then it lands:
//               "3.0 MB . 127.0.0.1", Open and Show in folder offered, the ring stops, the file on
//               disk is byte for byte what was sent, under the server's filename.
//   nolen.bin   no length: the ring is indeterminate ("so far"), then it completes.
//   slow.bin    cancelled from its row's Cancel button (a real click): "Cancelled", dimmed, a Retry
//               button, no partial file left; asking to open it says why not, in words.
//   broken.bin  the server drops the connection halfway: "Failed", dimmed, a Retry button; Retry
//               really asks the server again.
// The "Open folder" header button and the row actions are checked as offered (label and enabled);
// they are not clicked, because they open Explorer on whatever desktop runs the test.
// The files land in the real Downloads folder (main.js uses app.getPath('downloads') even for a
// test profile), under names carrying this run's pid, and are deleted at the end.
// One summary line: "downloads-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const { run, serve, html, sleep } = require('./tests/e2e-kit');

const CDP = 9434;
const KB = 1024, MB = 1024 * KB;
const TAG = 'quartz-dl-e2e-' + process.pid;
const pattern = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 255; return b; };

run('downloads-e2e', async ({ check, launch, say }) => {
  const OK = pattern(3 * MB);
  const sockets = new Set();
  const attach = (res, name, len) => {
    const h = { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${TAG}-${name}"`, 'Cache-Control': 'no-store' };
    if (len) h['Content-Length'] = String(len);
    res.writeHead(200, h);
  };
  /** Write `buf` in `step`-byte pieces every `ms`; stop early (and drop the socket) at `dropAt`. */
  const drip = (res, buf, step, ms, dropAt) => {
    let at = 0;
    const tick = () => {
      if (res.destroyed) return;
      if (dropAt !== undefined && at >= dropAt) { res.socket && res.socket.destroy(); return; }
      if (at >= buf.length) { res.end(); return; }
      res.write(buf.subarray(at, at + step));
      at += step;
      // The drop comes 20 ms after the last bytes, inside main's 125 ms update throttle: the
      // timing that once left a failed download showing as still running (see the broken.bin
      // section). Made deterministic here so the check catches it every run.
      setTimeout(tick, dropAt !== undefined && at >= dropAt ? 20 : ms);
    };
    tick();
  };
  const srv = await serve((req, res, p) => {
    sockets.add(req.socket);
    if (p === '/dl.html') {
      return html(res, '<!doctype html><title>Downloads page</title>'
        + ['ok', 'nolen', 'slow', 'broken'].map((n) => `<p><a id="${n}" href="/file/${n}.bin">${n}</a></p>`).join(''));
    }
    if (p === '/file/ok.bin') { attach(res, 'ok.bin', OK.length); drip(res, OK, 256 * KB, 250); return true; }
    if (p === '/file/nolen.bin') { attach(res, 'nolen.bin', 0); drip(res, pattern(1 * MB), 128 * KB, 150); return true; }
    if (p === '/file/slow.bin') { attach(res, 'slow.bin', 20 * MB); drip(res, pattern(20 * MB), 64 * KB, 250); return true; }
    if (p === '/file/broken.bin') { attach(res, 'broken.bin', 2 * MB); drip(res, pattern(2 * MB), 256 * KB, 150, 1 * MB); return true; }
    return false;
  });
  const B = 'http://127.0.0.1:' + srv.port;
  const q = await launch({ cdp: CDP });
  const c = q.chrome;
  let listed = [];

  try {
    await c.ev(`(() => { const t = createTab(${JSON.stringify(B + '/dl.html')}); window.__dl = t; activateTab(t.id); return 1; })()`);
    await c.waitFor('window.__dl.ready === true', 15000);
    check(await c.ev("!!document.getElementById('downloads') && document.getElementById('downloads').hidden === true"), 'before any download, the nav button is hidden');

    const clickLink = (id) => c.ev(`window.__dl.viewEl.executeJavaScript(${JSON.stringify(`document.getElementById('${id}').click(), 1`)})`);
    const list = () => c.ev('window.api.downloads.list()');
    const byName = async (n) => (await list()).find((it) => it.filename === TAG + '-' + n);
    const waitItem = async (n, pred, ms) => {
      const t0 = Date.now(); let it;
      while (Date.now() - t0 < (ms || 15000)) { it = await byName(n); if (it && pred(it)) return it; await sleep(100); }
      return it || null;
    };
    const row = (id) => c.ev(`(() => { const r = document.querySelector('#downloads-panel .dl-row[data-id="${id}"]'); if (!r) return null;
      const q = (s) => r.querySelector(s); const btns = [...r.querySelectorAll('.dl-actions button')];
      return { name: (q('.dl-name') || {}).textContent || '', meta: (q('.dl-meta') || {}).textContent || '', dim: !!(q('.dl-meta') && q('.dl-meta').classList.contains('is-dim')),
        bar: !!q('.dl-bar'), fill: q('.dl-fill') ? q('.dl-fill').style.transform || q('.dl-fill').style.width || getComputedStyle(q('.dl-fill')).transform : null,
        actions: btns.map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim() + (b.disabled ? ' (disabled)' : '')) }; })()`);
    const button = () => c.ev(`(() => { const b = document.getElementById('downloads'); return { hidden: b.hidden, active: b.classList.contains('active'), indeterminate: b.classList.contains('indeterminate'), pulse: b.classList.contains('pulse'), progress: b.style.getPropertyValue('--progress') }; })()`);
    const ensurePanel = () => c.ev('window.Downloads.isOpen() || window.Downloads.open(), 1');

    // ---- ok.bin: progress, then done -------------------------------------------------------------
    await clickLink('ok');
    const first = await waitItem('ok.bin', (it) => it.state === 'progressing', 10000);
    check(first && first.state === 'progressing', 'a link click started a download', first);
    const b1 = await button();
    check(b1.hidden === false, 'the nav button appeared', b1);
    check(await c.ev('window.Downloads.isOpen() && !document.getElementById("downloads-panel").hidden') === true, 'the panel opened by itself when the download started');
    // Sample the ring and the row while it runs.
    const seen = { ring: [], meta: [], bar: false, fill: new Set() };
    let okItem = null;
    for (let i = 0; i < 120; i++) {
      okItem = await byName('ok.bin');
      if (!okItem || okItem.state !== 'progressing') break;
      const b = await button();
      const r = await row(okItem.id);
      if (b.active && b.progress) seen.ring.push(Number(b.progress));
      if (r) { seen.meta.push(r.meta); if (r.bar) seen.bar = true; if (r.fill) seen.fill.add(r.fill); }
      await sleep(100);
    }
    const mid = seen.ring.filter((p) => p > 0 && p < 1);
    check(mid.length >= 2, 'the ring filled part-way while it ran (--progress between 0 and 1)', seen.ring.slice(0, 12));
    check(mid.length >= 2 && mid[mid.length - 1] > mid[0], 'the ring moved forward', mid.length ? [mid[0], mid[mid.length - 1]] : mid);
    check(seen.meta.some((m) => /^\d+\.\d (KB|MB) of 3\.0 MB/.test(m)), 'the row said "x of 3.0 MB" while it ran', seen.meta.slice(0, 4));
    check(seen.bar && seen.fill.size >= 2, 'the row had a progress bar that moved', [...seen.fill].slice(0, 5));
    okItem = await waitItem('ok.bin', (it) => it.state === 'completed', 15000);
    check(okItem && okItem.state === 'completed', 'ok.bin completed', okItem && okItem.state);
    await ensurePanel();
    let r = okItem ? await row(okItem.id) : null;
    check(r && r.meta === '3.0 MB · 127.0.0.1', 'done: the row says the size and the site', r && r.meta);
    check(r && r.name === TAG + '-ok.bin', 'done: the row has the server\'s filename', r && r.name);
    check(r && !r.bar, 'done: no progress bar left on the row', r);
    check(r && r.actions.join('|') === 'Open|Show in folder', 'done: the row offers Open and Show in folder', r && r.actions);
    const b2 = await button();
    check(!b2.active && !b2.indeterminate, 'done: the ring stopped', b2);
    const folder = await c.ev(`(() => { const b = document.querySelector('#downloads-panel .dl-folder'); return b ? { text: b.textContent.replace(/[\\uE000-\\uF8FF]/g, '').trim(), disabled: b.disabled } : null; })()`);
    check(folder && folder.text === 'Open folder' && !folder.disabled, 'the panel offers "Open folder"', folder);
    let bytes = null;
    try { bytes = okItem && fs.readFileSync(okItem.savePath); } catch (e) { bytes = null; }
    check(!!bytes && bytes.length === OK.length && bytes.equals(OK), 'the file on disk is byte for byte what the server sent', okItem && { savePath: okItem.savePath, size: bytes ? bytes.length : null });

    // ---- nolen.bin: indeterminate ---------------------------------------------------------------------
    await clickLink('nolen');
    let ind = false, sofar = false;
    for (let i = 0; i < 60; i++) {
      const it = await byName('nolen.bin');
      if (it && it.state !== 'progressing') break;
      const b = await button();
      if (b.active && b.indeterminate) ind = true;
      if (it) { await ensurePanel(); const rr = await row(it.id); if (rr && / so far/.test(rr.meta)) sofar = true; }
      await sleep(100);
    }
    check(ind, 'no length: the ring is indeterminate while it runs');
    check(sofar, 'no length: the row says "x so far"');
    const nolen = await waitItem('nolen.bin', (it) => it.state === 'completed', 15000);
    await ensurePanel();
    r = nolen ? await row(nolen.id) : null;
    check(nolen && nolen.state === 'completed' && r && r.meta === '1.0 MB · 127.0.0.1', 'no length: it completes with its real size', r && r.meta);

    // ---- slow.bin: cancelled from the row -------------------------------------------------------------
    await clickLink('slow');
    const slow = await waitItem('slow.bin', (it) => it.state === 'progressing' && it.received > 0, 10000);
    check(slow && slow.state === 'progressing', 'slow.bin is running', slow && slow.state);
    await ensurePanel();
    r = slow ? await row(slow.id) : null;
    check(r && r.actions.join('|') === 'Pause|Cancel', 'running: the row offers Pause and Cancel', r && r.actions);
    if (slow) {
      const at = await c.ev(`(() => { const b = [...document.querySelectorAll('#downloads-panel .dl-row[data-id="${slow.id}"] .dl-actions button')].find((x) => x.getAttribute('aria-label') === 'Cancel'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      if (at) for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      else check(false, 'the Cancel button was there to click');
    }
    const cancelled = await waitItem('slow.bin', (it) => it.state === 'cancelled', 8000);
    check(cancelled && cancelled.state === 'cancelled', 'clicking Cancel cancelled it', cancelled && cancelled.state);
    await ensurePanel();
    r = cancelled ? await row(cancelled.id) : null;
    check(r && r.meta === 'Cancelled' && r.dim, 'cancelled: the row says "Cancelled", dimmed', r);
    check(r && r.actions.join('|') === 'Retry', 'cancelled: the row offers Retry', r && r.actions);
    await sleep(500);
    const leftovers = fs.readdirSync(require('path').dirname((cancelled || okItem).savePath || okItem.savePath)).filter((f) => f.indexOf(TAG + '-slow') === 0);
    check(leftovers.length === 0, 'cancelled: no partial file left in the folder', leftovers);
    const why = cancelled ? await c.ev(`window.api.downloads.open(${cancelled.id})`) : null;
    check(why === 'That download is not finished.', 'asking to open a cancelled file says why not, in words', why);

    // ---- broken.bin: the connection drops ----------------------------------------------------------------
    // Chromium resumes a dropped transfer by itself (up to 5 times, each one a new request here)
    // before it gives up, so the server sees several requests and only the LAST interruption is
    // the failure. What is judged is what the user is shown once main says it is interrupted.
    await clickLink('broken');
    const broken = await waitItem('broken.bin', (it) => it.state === 'interrupted', 20000);
    check(broken && broken.state === 'interrupted', 'a dropped connection ends the download as interrupted (after Chromium\'s own retries)', broken && { state: broken.state, received: broken.received, requests: srv.hits('/file/broken.bin') });
    await ensurePanel();
    let shown = null;
    for (let i = 0; i < 30; i++) { shown = broken ? await row(broken.id) : null; if (shown && shown.meta === 'Failed') break; await sleep(100); }
    r = shown;
    check(r && r.meta === 'Failed' && r.dim, 'failed: the row says "Failed", dimmed (within 3 s of main knowing)', r);
    check(r && r.actions.join('|') === 'Retry', 'failed: the row offers Retry, not Pause/Cancel', r && r.actions);
    const ring = await button();
    check(!ring.active, 'failed: the ring is not left spinning', ring);
    if (broken) {
      const before = srv.hits('/file/broken.bin');
      const clicked = await c.ev(`(() => { const b = [...document.querySelectorAll('#downloads-panel .dl-row[data-id="${broken.id}"] .dl-actions button')].find((x) => /Retry/.test(x.textContent)); b && b.click(); return !!b; })()`);
      const t0 = Date.now();
      while (srv.hits('/file/broken.bin') === before && Date.now() - t0 < 8000) await sleep(100);
      check(clicked && srv.hits('/file/broken.bin') > before, 'Retry asked the server for the file again', { clicked, requests: srv.hits('/file/broken.bin') - before });
      const again = (await list()).filter((it) => /broken/.test(it.filename));
      check(again.length === 2, 'Retry made a new row (the failed one stays as it was)', again.map((it) => it.filename + ':' + it.state));
      for (let i = 0; i < 200 && (await list()).some((it) => /broken/.test(it.filename) && it.state === 'progressing'); i++) await sleep(100);
    }

    // ---- the list, newest first -------------------------------------------------------------------------
    listed = await list();
    const order = listed.map((it) => it.filename.replace(TAG + '-', ''));
    check(order[order.length - 1] === 'ok.bin' && order.indexOf('slow.bin') < order.indexOf('nolen.bin'), 'the list is newest first', order);
    await ensurePanel();
    const rows = await c.ev("document.querySelectorAll('#downloads-panel .dl-row').length");
    check(rows === listed.length, 'one row per download', { rows, items: listed.length });
    check(await q.quit(), 'closing the window quit Quartz');
  } finally {
    // The real Downloads folder: delete exactly what this run put there.
    for (const it of listed) { if (it.savePath && require('path').basename(it.savePath).indexOf(TAG) === 0) { try { fs.unlinkSync(it.savePath); } catch (e) { /* not there */ } } }
    try {
      const dir = require('path').join(require('os').homedir(), 'Downloads');
      for (const f of fs.readdirSync(dir)) if (f.indexOf(TAG) === 0) { try { fs.unlinkSync(require('path').join(dir, f)); } catch (e) { /* busy */ } }
    } catch (e) { /* no folder */ }
    for (const s of sockets) { try { s.destroy(); } catch (e) { /* gone */ } }
    srv.close();
    say('cleaned up ' + TAG + '-* in Downloads');
  }
});
