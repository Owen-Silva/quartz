require('./tools/lowcpu-optional.js');   // first: the CPU cap, when one is configured (tools/lowcpu-optional.js; none on a cloud runner)
// watch-comments-e2e.js -- Lumen's own YouTube comments (watch-comments.js) under the video in Lumen's playback view,
// end to end, in a REAL hidden Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen), on LOCAL FIXTURES
// ONLY (tests/comments-fixtures.js): a fake youtube.com/watch page with ytInitialData's comments section, YouTube's own
// (lazily drawn) comments in its DOM with counted presses, and the page's own continuation requests answered locally.
// Every service origin is rebased to a local front; every other host resolves nowhere. Never a real account or cookie.
// The playing video is the synthetic clip (tests/fixture-clip.js).
//
//   node watch-comments-e2e.js [--cdp 9774] [--shots <dir>]
//
// Checks: the count, Top/Newest, each comment (avatar, author, time, text, links, likes, replies); the data comes from
// the page's own same-origin POST /youtubei/v1/next; the next page loads as he scrolls, to the end; Newest and back;
// "N replies" expands and "Show more replies"; Like = exactly one press of YouTube's own Like for that comment (its
// section stays invisible); a comment YouTube hasn't drawn says why; typing in the comment box never reaches the player
// (K, J, L, F, M, Space); Comment and Reply press YouTube's own Comment once each; a timestamp seeks; "Open comments on
// YouTube" shows YouTube's own comments (Full page); the states: loading, turned off, none, none yet, failed (+ Try
// again), signed out, offline. Shots at 1280x800 and 1920x1000.
// One summary line: "watch-comments-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');
const X = require('./tests/comments-fixtures');
const { sendClip } = require('./tests/fixture-clip');

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* stays normal */ }
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9774'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'quartz-comments-shots'));
const VID = 'pvTest00001';

/* ---- local servers --------------------------------------------------------------------------- */
function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 2000;
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, origin: 'http://127.0.0.1:' + s.address().port }));
  });
}
const reqs = [];          // the page's own continuation requests
const ctl = { failing: true };
async function startServers(mock) {
  const fronts = {};
  for (const svc of Mock.SERVICES) {
    fronts[svc] = await listen((req, res) => {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      const p = u.pathname;
      if (p === '/__media/clip.mp4') return sendClip(req, res);
      if (svc === 'youtube' && p === '/watch') {
        const q = { signedout: u.searchParams.has('signedout'), cm: u.searchParams.get('cm') || '', vid: u.searchParams.get('v') || VID };
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(X.watch(q));
      }
      if (svc === 'youtube' && p === '/youtubei/v1/next' && req.method === 'POST') {
        let raw = '';
        req.on('data', (d) => { raw += d; });
        req.on('end', () => {
          let body = {};
          try { body = JSON.parse(raw); } catch (e) { body = {}; }
          let ref = null;
          try { ref = new URL(String(req.headers.referer || '')); } catch (e) { ref = null; }
          const cm = ref ? ref.searchParams.get('cm') || '' : '';
          const vid = ref ? ref.searchParams.get('v') || VID : VID;
          reqs.push({ token: body.continuation || '', videoId: body.videoId || '', cm, vid, ctype: req.headers['content-type'] || '', site: req.headers['sec-fetch-site'] || '',
            client: body.context && body.context.client && body.context.client.clientName, key: u.searchParams.has('key') });
          const variant = cm === 'fail' && !ctl.failing ? '' : cm;
          const out = X.next(body, variant, vid);
          const send = () => { res.writeHead(out.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out.json)); };
          if (cm === 'slow') setTimeout(send, 3500); else send();
        });
        return;
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
function pngSize(file) { try { const b = fs.readFileSync(file); return b.readUInt32BE(16) + 'x' + b.readUInt32BE(20); } catch (e) { return 'unreadable'; } }

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
async function cdpTo(t) { const c = await new Cdp(t.webSocketDebuggerUrl).open(); await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => 0); return c; }
const KEY = { k: ['KeyK', 75], j: ['KeyJ', 74], l: ['KeyL', 76], f: ['KeyF', 70], m: ['KeyM', 77], ' ': ['Space', 32],
  ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40] };
async function keyIn(c, key) {
  const [code, vk] = KEY[key] || ['Key' + key.toUpperCase(), key.toUpperCase().charCodeAt(0)];
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 };
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  if (key.length === 1) await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'char', text: key }, base));
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}
const PS = 'LumenPlayview._state()';
const CS = 'LumenComments._current()';

run('watch-comments-e2e', async ({ check, launch, say }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const mock = await Mock.start({ log: () => {} });
  const srv = await startServers(mock);
  const FY = srv.fronts.youtube.origin;
  const env = {
    QUARTZ_WATCH_BOOT_GRACE_MS: '0', QUARTZ_WATCH_REBASE: JSON.stringify(srv.rebase), QUARTZ_WATCH_MIN_FREE_GB: '0',
    QUARTZ_PLAYER_FLOOR_GB: '0', QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1', QUARTZ_TEST_WINDOW_SIZE: '1280x800',
    QUARTZ_EDGE_STUB: path.join(os.tmpdir(), 'quartz-comments-edge-' + process.pid + '.txt'),
  };
  const args = ['--force-device-scale-factor=1', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'];
  try {
    const q = await launch({ cdp: CDP_PORT, env, args });
    const chrome = q.chrome;
    await chrome.ev('window.__fsCalls = 0; window.toggleFullscreen = function () { window.__fsCalls++; }; 1');
    check(await chrome.ev('typeof window.LumenComments === "object" && typeof LumenComments._current === "function"'), 'watch-comments.js is loaded in the chrome');

    const cs = () => chrome.ev(CS);
    const csWait = (cond, ms) => chrome.waitFor(`(() => { const x = ${CS}; return x && (${cond}) ? x : null; })()`, ms || 15000).catch(() => null);
    const pvWait = (cond, ms) => chrome.waitFor(`(() => { const s = ${PS}; const x = s.slots.find((y) => y.boxed) || s.slots[s.slots.length - 1]; return x && (${cond}) ? x : null; })()`, ms || 15000).catch(() => null);
    const guestFor = async (prefix) => { const t = await targetWhere(q, (x) => String(x.url).indexOf(prefix) === 0, 15000); return t ? cdpTo(t) : null; };
    const clickAt = async (sel, label, mid) => {
      const r = await chrome.ev(`(async () => { const q = () => document.querySelector(${JSON.stringify(sel)}); if (!q()) return null; q().scrollIntoView({ block: 'center' });
        await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
        const n = q(); if (!n) return null; const b = n.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const h = document.elementFromPoint(x, y);
        return { x, y, dis: !!n.disabled, hit: !!h && n.contains(h), at: h ? h.tagName + '.' + String(h.className).slice(0, 60) : null }; })()`);
      if (!r) { say('click: no ' + (label || sel)); return false; }
      if (!r.hit) say('click: ' + (label || sel) + ' is not under its own centre: ' + JSON.stringify(r));
      await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      if (mid) await mid();
      await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      return true;
    };
    const win = () => chrome.ev('window.api.lumenPlayview.testWin()');
    let req = [1280, 800];
    const resize = async (w, h) => {
      let rw = w, rh = h;
      for (let i = 0; i < 4; i++) {
        await chrome.ev(`window.api.watchPlayer.testCapture({ width: ${rw}, height: ${rh}, wait: 700 }).then(() => 1)`);
        const c = (await win()).content;
        if (c.width === w && c.height === h) { req = [rw, rh]; break; }
        rw += w - c.width; rh += h - c.height;
      }
      await sleep(500);
    };
    // Scroll Lumen's view so the comments (or a node in them) sit near the top, then capture.
    const toComments = (sel) => chrome.ev(`(() => { const t = document.querySelector('.wp-layer .wp-tile.pv'); const n = document.querySelector(${JSON.stringify(sel || '#lumen-pv-comments')});
      if (!t || !n) return 0; t.scrollTop += n.getBoundingClientRect().top - t.getBoundingClientRect().top - 60; return t.scrollTop; })()`);
    const shot = async (name, w, h) => {
      const r = await chrome.ev(`window.api.watchPlayer.testCapture({ width: ${req[0]}, height: ${req[1]}, wait: 1200 })`).catch((e) => ({ ok: false, err: String(e && e.message) }));
      if (!r || !r.ok || !r.png) { check(false, 'shot ' + name + ' at ' + w + 'x' + h, r && r.err); return ''; }
      const f = path.join(SHOTS, 'comments-' + name + '-' + w + 'x' + h + '.png');
      fs.writeFileSync(f, Buffer.from(r.png, 'base64'));
      check(pngSize(f) === w + 'x' + h, 'shot ' + path.basename(f) + ' is really ' + w + 'x' + h, pngSize(f));
      return f;
    };
    const play = async (qs, title) => {
      await chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=' + qs)}, { service: 'youtube', title: ${JSON.stringify(title || 'Comments test')} }), 1`);
    };

    /* ============================ 1. the comments under the video ============================ */
    await chrome.ev('openWatchTab(), 1');
    await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 15000);
    await sleep(1500);
    await play(VID);
    const ready = await pvWait('x.boxed && x.applied && x.phase === "ready"', 20000);
    check(!!ready, 'the video plays in Lumen’s view (boxed, trimmed, read)', ready && { phase: ready.phase, why: ready.why });
    let c = await csWait('x.phase === "ready" && x.n === 20', 15000);
    check(!!c && c.attached && c.videoId === VID, 'Lumen’s comments are in the view’s mount (#lumen-pv-comments), for this video', c && { phase: c.phase, why: c.why, n: c.n });
    if (!c) c = await cs();
    check(c && c.count === '1,234 Comments' && c.sorts.join('|') === 'Top|Newest' && c.sort === 'Top', 'the count, and Top / Newest with Top on', c && { count: c.count, sorts: c.sorts, sort: c.sort });
    const first = c && c.items[0];
    check(!!first && first.id === 'UgxTop001' && first.author === '@quietglyph' && first.text === X.C1_TEXT && first.likes === '2.4K' && first.replies === 3 && first.pinned && first.hearted,
      'comment 1: author, text, likes, 3 replies, pinned, hearted', first);
    await chrome.waitFor('document.querySelector(\'#lumen-pv-comments .cm-item[data-id="UgxTop001"] .cm-av img\') ? 1 : 0', 4000).catch(() => 0);
    const dom = await chrome.ev(`(() => { const r = document.querySelector('#lumen-pv-comments .cm-item[data-id="UgxTop001"]'); if (!r) return null;
      return { author: r.querySelector('.cm-author').textContent, time: r.querySelector('.cm-time').textContent, text: r.querySelector('.cm-text').textContent,
        links: [...r.querySelector('.cm-text').querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href'), a.className]), tags: r.querySelector('.cm-text').querySelectorAll('img, script').length,
        av: !!r.querySelector('.cm-av img'), like: r.querySelector('.cm-like').textContent, replies: (r.querySelector('.cm-replies') || {}).textContent || '', pin: (r.querySelector('.cm-pin') || {}).textContent || '',
        xss: window.__xss === 1, count: document.querySelector('#lumen-pv-comments .cm-count').textContent }; })()`);
    check(!!dom && dom.author === '@quietglyph' && /days ago/.test(dom.time) && dom.text === X.C1_TEXT && dom.like === '2.4K' && /3 replies/.test(dom.replies) && /Pinned/.test(dom.pin) && dom.count === '1,234 Comments',
      'drawn: author, time, the text, likes, “3 replies”, Pinned, the count', dom);
    check(!!dom && dom.av, 'the avatar is drawn (the page’s own image URL)');
    check(!!dom && dom.links.length === 3 && dom.links[1][1] === 'https://example.com/notes' && /cm-link-time/.test(dom.links[0][2]) && /cm-link-yt/.test(dom.links[2][2]),
      'links are anchors: a timestamp, the unwrapped site, the mention', dom && dom.links);
    check(!!dom && dom.tags === 0 && !dom.xss, 'markup in a comment stays text: no tag, nothing ran', dom && { tags: dom.tags, xss: dom.xss });
    const r0 = reqs.filter((r) => r.vid === VID);
    check(r0.length === 1 && r0[0].token === X.FIRST && r0[0].client === 'WEB' && /application\/json/.test(r0[0].ctype) && (r0[0].site === 'same-origin' || r0[0].site === '') && !r0[0].key,
      'the data: one request, the page’s own same-origin POST /youtubei/v1/next with ytInitialData’s token and the page’s context, no API key', r0);
    await toComments();
    await shot('list', 1280, 800);

    /* ============================ 2. the next page as he scrolls ============================ */
    const scrollEnd = () => chrome.ev('(() => { const t = document.querySelector(".wp-layer .wp-tile.pv"); t.scrollTop = t.scrollHeight; return t.scrollTop; })()');
    await scrollEnd();
    c = await csWait('x.n === 40 && !x.loading', 10000);
    check(!!c && c.items[20].id === 'UgxTop021', 'scrolling to the end loads the next 20 (page 2)', c && { n: c.n });
    await scrollEnd();
    c = await csWait('x.n === 50 && !x.loading && !x.next', 10000);
    check(!!c && c.items[40].text.indexOf('Top comment 41') === 0, 'and the last 10 (page 3, YouTube’s older shape); no more after it', c && { n: c.n, next: c.next });
    await scrollEnd();
    await sleep(800);
    const endTxt = await chrome.ev('(document.querySelector("#lumen-pv-comments .cm-end") || {}).textContent || ""');
    check(/all the comments/.test(endTxt) && reqs.filter((r) => r.vid === VID).length === 3, 'the end says so, and nothing more is asked for (3 requests)', { endTxt, n: reqs.length });

    /* ============================ 3. Newest and back ============================ */
    await chrome.ev('(() => { const t = document.querySelector(".wp-layer .wp-tile.pv"); t.scrollTop = 0; return 1; })()');
    await clickAt('#lumen-pv-comments .cm-sort[aria-checked="false"]', 'Newest');
    c = await csWait('x.sort === "Newest" && x.n === 20 && !x.loading', 10000);
    check(!!c && c.items[0].text.indexOf('Newest comment 1') === 0 && reqs[reqs.length - 1].token === X.T.new1, 'Newest: the list is YouTube’s newest, from its own Newest token', c && { sort: c.sort, first: c.items[0] });
    await toComments();
    await shot('newest', 1280, 800);
    await clickAt('#lumen-pv-comments .cm-sort[aria-checked="false"]', 'Top');
    c = await csWait('x.sort === "Top" && x.n === 20 && !x.loading', 10000);
    check(!!c && c.items[0].id === 'UgxTop001', 'and back to Top');

    /* ============================ 4. replies ============================ */
    const repMark = reqs.length;
    await clickAt('#lumen-pv-comments .cm-item[data-id="UgxTop001"] .cm-replies', '3 replies');
    c = await csWait('x.replies.UgxTop001 && x.replies.UgxTop001.n === 2 && !x.replies.UgxTop001.loading', 8000);
    const repDom = await chrome.ev('document.querySelectorAll("#lumen-pv-comments .cm-item[data-id=\\"UgxTop001\\"] .cm-replylist > .cm-item").length');
    // (Scrolling may also ask for the next page of comments meanwhile: the replies request is looked for, not assumed last.)
    const repReqs = reqs.slice(repMark).map((r) => r.token);
    check(!!c && repDom === 2 && repReqs.filter((t) => t === 'CM-REP-UgxTop001').length === 1, '“3 replies” expands: two replies, from the page’s own replies request (once)', { repDom, repReqs });
    await clickAt('#lumen-pv-comments .cm-item[data-id="UgxTop001"] .cm-morereplies', 'Show more replies');
    c = await csWait('x.replies.UgxTop001 && x.replies.UgxTop001.n === 3 && !x.replies.UgxTop001.next', 8000);
    check(!!c, '“Show more replies” loads the third, and no more');
    await toComments('#lumen-pv-comments .cm-item[data-id="UgxTop001"]');
    await shot('replies', 1280, 800);
    await clickAt('#lumen-pv-comments .cm-item[data-id="UgxTop001"] .cm-replies', 'Hide replies');
    c = await csWait('x.expanded.indexOf("UgxTop001") < 0', 4000);
    check(!!c && (await chrome.ev('document.querySelectorAll("#lumen-pv-comments .cm-replylist").length')) === 0, 'Hide replies folds them');

    /* ============================ 5. Like: one press of YouTube's own ============================ */
    const p = await guestFor(FY + '/watch?v=' + VID);
    check(!!p, 'the hosted page is reachable for the checks');
    const own = () => p.ev('JSON.stringify({ like: window.__presses.cmLike, post: window.__presses.cmPost, reply: window.__presses.cmReply, drawn: window.__presses.cmDrawn })').then(JSON.parse);
    let o0 = await own();
    check(o0.drawn === 0 && Object.keys(o0.like).length === 0, 'before his click, YouTube’s own section isn’t even drawn (nothing pressed)', o0);
    const pressesBefore = (await chrome.ev('LumenComments._state().presses.length'));
    await clickAt('#lumen-pv-comments .cm-item[data-id="UgxTop001"] .cm-like', 'Like');
    c = await csWait('x.items[0].liked === true', 12000);
    let o1 = await own();
    const lg = (await chrome.ev('LumenComments._state().presses')).slice(pressesBefore);
    check(!!c && o1.like.UgxTop001 === 1 && lg.length === 1 && lg[0].kind === 'like' && lg[0].ok, 'one click on Lumen’s Like = exactly one press of YouTube’s own Like for that comment, and Lumen shows it liked', { own: o1, log: lg });
    check(await p.ev('document.querySelector("ytd-comment-view-model a[href*=\\"lc=UgxTop001\\"]").closest("ytd-comment-view-model").querySelector("#like-button button").getAttribute("aria-pressed")') === 'true', 'YouTube’s own comment Like is pressed');
    const hidden = await p.ev(`(() => { const s = document.querySelector('ytd-comments'); const cs = getComputedStyle(s); const mp = document.querySelector('[data-lumen-pv-root]');
      const h = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return { vis: cs.visibility, pe: cs.pointerEvents, onlyPlayer: !!mp && !!h && mp.contains(h) }; })()`);
    check(hidden.vis === 'hidden' && hidden.pe === 'none' && hidden.onlyPlayer, 'YouTube’s own section stays invisible and unclickable; only the player shows', hidden);
    await sleep(600);
    // While his button is held, a redraw comes (a page answer, the layer's class, as in use): the click must
    // still land, once (a rebuild between press and release would swallow it).
    let midDraws = -1;
    await clickAt('#lumen-pv-comments .cm-item[data-id="UgxTop001"] .cm-like', 'Unlike', async () => {
      midDraws = await chrome.ev('(() => { const l = document.querySelector(".wp-layer"); l.classList.add("cm-e2e-poke"); const n = LumenComments._redraw(); return n; })()');
      await sleep(60);
      await chrome.ev('(() => { document.querySelector(".wp-layer").classList.remove("cm-e2e-poke"); return 1; })()');
      await sleep(60);
    });
    check(midDraws === 0, 'a redraw while his button is down waits for the release', midDraws);
    c = await csWait('x.items[0].liked === false', 8000);
    o1 = await own();
    check(!!c && o1.like.UgxTop001 === 2, 'a second click = a second press (unliked), never more', o1.like);
    // A comment YouTube's own section hasn't drawn (its page 2): it says why, and nothing is pressed.
    await scrollEnd();
    await csWait('x.n === 40 && !x.loading', 10000);
    await clickAt('#lumen-pv-comments .cm-item[data-id="UgxTop025"] .cm-like', 'Like (not drawn by YouTube)');
    c = await csWait('x.notes.UgxTop025', 12000);
    o1 = await own();
    check(!!c && /hasn’t loaded this comment/.test(c.notes.UgxTop025.text) && c.notes.UgxTop025.open && !o1.like.UgxTop025, 'a comment YouTube’s page hasn’t drawn: the reason, “Open comments on YouTube”, and no press', c && c.notes);
    check((await chrome.ev('!!document.querySelector("#lumen-pv-comments .cm-item[data-id=\\"UgxTop025\\"] .cm-open-inline")')), 'the reason carries the “Open comments on YouTube” button');

    /* ============================ 6. typing never reaches the player ============================ */
    await chrome.ev('(() => { const t = document.querySelector(".wp-layer .wp-tile.pv"); t.scrollTop = 0; return 1; })()');
    await clickAt('#lumen-pv-comments .cm-compose .cm-input', 'the comment box');
    const focused = await chrome.ev('document.activeElement && document.activeElement.classList.contains("cm-input")');
    check(focused, 'a click in “Add a comment…” focuses Lumen’s box');
    const vs = () => p.ev('(() => { const v = document.getElementById("v"); return { paused: v.paused, t: v.currentTime, muted: v.muted, fs: !!document.fullscreenElement, keys: window.__keys.length }; })()');
    const before = await vs();
    const typed = 'kjlfm k';
    for (const ch of typed) await keyIn(chrome, ch);
    for (const a of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) await keyIn(chrome, a);
    await sleep(700);
    const after = await vs();
    const val = await chrome.ev('document.activeElement.value');
    check(val === typed, 'what he types is in the box', val);
    check(after.paused === before.paused && after.muted === before.muted && after.fs === before.fs && after.keys === before.keys && after.t - before.t > -1 && after.t - before.t < 5,
      'K, J, L, F, M, Space and the arrows typed in the box never reach the player (no pause, seek, mute or fullscreen)', { before, after });
    check(await chrome.ev('window.__fsCalls') === 0 && (await win()).fullScreen === false, 'and the window didn’t go fullscreen');

    /* ============================ 7. Comment and Reply: YouTube's own, once each ============================ */
    await clickAt('#lumen-pv-comments .cm-post', 'Comment');
    c = await csWait('x.items[0].mine && x.items[0].text === ' + JSON.stringify(typed), 12000);
    let o2 = await own();
    check(!!c && o2.post === 1, 'Comment = one press of YouTube’s own Comment; Lumen shows it at the top, read back from the page', { own: o2, top: c && c.items[0] });
    check(await p.ev(`[...document.querySelectorAll('ytd-comments #content-text')].some((n) => n.textContent === ${JSON.stringify(typed)})`), 'YouTube’s page has the new comment');
    check(await chrome.ev('(document.querySelector("#lumen-pv-comments .cm-compose:not(.cm-replybox) .cm-input") || {}).value') === '', 'and Lumen’s comment box is empty again');
    await clickAt('#lumen-pv-comments .cm-item[data-id="UgxTop002"] .cm-replybtn', 'Reply');
    await chrome.waitFor('document.activeElement && document.activeElement.closest && !!document.activeElement.closest(".cm-replybox")', 4000).catch(() => 0);
    await chrome.send('Input.insertText', { text: 'Thanks, gjpqy' });
    await sleep(300);
    await clickAt('#lumen-pv-comments .cm-replysend', 'Reply send');
    c = await csWait('x.replies.UgxTop002 && x.replies.UgxTop002.items[0] && x.replies.UgxTop002.items[0].mine', 12000);
    o2 = await own();
    check(!!c && o2.reply === 1 && c.replies.UgxTop002.items[0].text === 'Thanks, gjpqy', 'Reply = one press of YouTube’s own Comment in that thread; the reply shows under it', { own: o2, r: c && c.replies.UgxTop002 });
    check(o2.post === 1 && Object.values(o2.like).reduce((a, b) => a + b, 0) === 2, 'nothing else was pressed in the whole run', o2);

    /* ============================ 8. a timestamp seeks the video ============================ */
    await p.ev('document.getElementById("movie_player").seekTo = function (t) { window.__seek = t; }; 1');
    await clickAt('#lumen-pv-comments .cm-item[data-id="UgxTop001"] .cm-link-time', '1:05');
    check(await p.waitFor('window.__seek === 65 ? 1 : 0', 4000).catch(() => 0) === 1, 'a timestamp in a comment seeks YouTube’s own player (65 s), no reload');
    await shot('list-after', 1280, 800);

    /* ============================ 9. 1920x1000 ============================ */
    await resize(1920, 1000);
    await toComments();
    await shot('list', 1920, 1000);
    const wide = await chrome.ev(`(() => { const r = document.querySelector('#lumen-pv-comments').getBoundingClientRect(); const v = document.querySelector('.wp-layer webview').getBoundingClientRect(); return { cw: Math.round(r.width), vw: Math.round(v.width) }; })()`);
    check(Math.abs(wide.cw - wide.vw) <= 2, 'the comments are as wide as the video', wide);
    await resize(1280, 800);

    /* ============================ 10. the states ============================ */
    const stateOf = async (qs, phase, label, shotName) => {
      await play(qs, label);
      const x = await csWait(`x.videoId === ${JSON.stringify(qs.split('&')[0])} && x.phase === ${JSON.stringify(phase)}`, 15000);
      return x;
    };
    await play('cmSlow00001&cm=slow', 'Slow');
    let x = await csWait('x.videoId === "cmSlow00001" && x.phase === "loading"', 10000);
    const skel = await chrome.ev('!!document.querySelector("#lumen-pv-comments .cm-skel") && (document.querySelector("#lumen-pv-comments .cm-state-title") || {}).textContent');
    check(!!x && skel === 'Loading comments…', 'loading: “Loading comments…” and its reason, with a skeleton', { x: x && x.phase, skel });
    await toComments();
    await shot('loading', 1280, 800);
    x = await csWait('x.videoId === "cmSlow00001" && x.phase === "ready"', 10000);
    check(!!x, 'then the comments come');

    x = await stateOf('cmOff000001&cm=off', 'off', 'Off');
    check(!!x && x.shown === 'Comments are turned off' && x.whyShown.some((w) => /turned off/.test(w)), 'turned off: “Comments are turned off” and YouTube’s own words', x && { shown: x.shown, why: x.whyShown });
    check(reqs.filter((r) => r.vid === 'cmOff000001').length === 0, 'and nothing is requested');
    await toComments();
    await shot('off', 1280, 800);

    x = await stateOf('cmNone00001&cm=none', 'none', 'None');
    check(!!x && x.shown === 'No comments here' && x.whyShown.some((w) => /doesn’t offer comments/.test(w)), 'no section at all: “No comments here” and why', x && { shown: x.shown, why: x.whyShown });

    x = await stateOf('cmEmpty0001&cm=empty', 'empty', 'Empty');
    check(!!x && x.shown === 'No comments yet' && (await chrome.ev('!!document.querySelector("#lumen-pv-comments .cm-compose")')), 'none yet: “No comments yet”, and the box to be first', x && { shown: x.shown });

    ctl.failing = true;
    x = await stateOf('cmFail00001&cm=fail', 'failed', 'Fail');
    check(!!x && x.shown === 'Comments didn’t load' && x.whyShown.some((w) => /YouTube answered 500/.test(w)), 'failed: “Comments didn’t load” and the reason (YouTube answered 500)', x && { shown: x.shown, why: x.whyShown });
    await toComments();
    await shot('failed', 1280, 800);
    ctl.failing = false;
    await clickAt('#lumen-pv-comments .cm-state .cm-retry', 'Try again');
    x = await csWait('x.videoId === "cmFail00001" && x.phase === "ready" && x.n === 20', 10000);
    check(!!x, 'Try again loads them once YouTube answers');

    x = await stateOf('cmSignOut01&signedout=1', 'ready', 'Signed out');
    const so = await chrome.ev(`(() => { const r = document.querySelector('#lumen-pv-comments'); const l = r.querySelector('.cm-like');
      return { note: [...r.querySelectorAll('.cm-why-txt')].map((n) => n.textContent).join(' | '), compose: !!r.querySelector('.cm-compose'), likeOff: !!l && l.disabled, why: l && l.getAttribute('data-why'),
        replyOff: !!r.querySelector('.cm-replybtn') && r.querySelector('.cm-replybtn').disabled }; })()`);
    check(!!x && x.signedIn === false && /signed out of YouTube/.test(so.note) && !so.compose && so.likeOff && /Sign in/.test(so.why) && so.replyOff,
      'signed out: the comments read; the line says why; Like and Reply are off with “Sign in…”; no comment box', so);
    await toComments();
    await shot('signedout', 1280, 800);

    await chrome.send('Network.enable').catch(() => 0);
    // Offline while the comments load (the chrome goes offline; the page's answer is slow): it says so, then recovers.
    await play('cmOffline01&cm=slow', 'Offline');
    await csWait('x.videoId === "cmOffline01" && x.phase === "loading"', 15000);
    await chrome.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    x = await csWait('x.videoId === "cmOffline01" && x.phase === "offline"', 8000);
    await toComments();
    await shot('offline', 1280, 800);
    check(!!x && x.shown === 'You’re offline' && x.whyShown.some((w) => /back online/.test(w)), 'offline: “You’re offline” and when they load', x && { shown: x.shown, phase: x.phase });
    await chrome.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    x = await csWait('x.videoId === "cmOffline01" && x.phase === "ready"', 15000);
    check(!!x, 'back online: they load by themselves');

    /* ============================ 11. Open comments on YouTube ============================ */
    await clickAt('#lumen-pv-comments .cm-open', 'Open comments on YouTube');
    const fp = await pvWait('!x.boxed && x.mode === "page"', 6000);
    const p2 = await guestFor(FY + '/watch?v=cmOffline01');
    const ownShown = p2 ? await p2.waitFor('(() => { const s = document.querySelector("ytd-comments"); return !document.documentElement.hasAttribute("data-lumen-pv") && s && getComputedStyle(s).display !== "none" && getComputedStyle(s).visibility !== "hidden" ? 1 : 0; })()', 6000).catch(() => 0) : 0;
    check(!!fp && ownShown === 1, '“Open comments on YouTube”: YouTube’s whole page in Lumen (Full page), its own comments shown', { mode: fp && fp.mode, ownShown });
    await shot('open-youtube', 1280, 800);
    if (p2) p2.close();
    if (p) p.close();

    const wEnd = await win();
    check(wEnd.fullScreen === false, 'the OS window never went fullscreen', wEnd);
    say('requests: ' + reqs.length + '; tokens: ' + reqs.map((r) => r.token || ('video:' + r.videoId)).join(', '));
    await chrome.ev('(() => { if (WatchPlayer.isOpen()) WatchPlayer.close("Close"); return 1; })()');
    await q.quit();
  } finally {
    srv.close();
    try { if (mock.close) await mock.close(); } catch (e) { /* gone */ }
  }
});
