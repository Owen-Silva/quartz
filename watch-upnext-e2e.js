require('./tools/lowcpu-optional.js');   // first: the CPU cap, when one is configured (tools/lowcpu-optional.js; none on a cloud runner)
// watch-upnext-e2e.js -- Space with Lumen's Up next card up (watch-player-extras.js), end to end in a REAL hidden
// Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen). LOCAL FIXTURES ONLY: the play bar's fake
// service pages (tests/playerbar-fixtures/, the synthetic clip from tests/playerbar-clip.js) on local fronts, one per
// service; the next episode comes from the card's e2e seam (WatchPlayerExtras._fake), never from a real service,
// account, cookie or profile.
//
//   node watch-upnext-e2e.js [--cdp 9744] [--shots <dir>]
//
// The bug: the card focuses its Play now button, and Space on a focused button presses it, so Space
// started the next episode. Checks, on YouTube, Disney+, Hulu, Prime Video and ESPN (the same card on each):
//   - Space during the countdown while the video still plays: the video pauses, the countdown stops, the card says
//     so, and nothing plays on (YouTube and Hulu wait past the full 10 s countdown);
//   - a second Space plays this video again, still with no next episode;
//   - the video ended: Space stops the countdown and stays on this video, and the card says so;
//   - Enter (YouTube, Hulu, ESPN) or a click (Disney+, Prime Video) on the card's Play now still plays the next one;
//   - YouTube: the countdown running out untouched still plays the next one; a Space from inside the page (the
//     play bar's key bridge) stops the countdown too.
// One summary line: "watch-upnext-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9744'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'quartz-upnext-shots'));
const Clip = require('./tests/playerbar-clip');
const CLIP = process.env.QUARTZ_PLAYERBAR_CLIP || path.join(os.tmpdir(), 'lumen-playerbar-testclip.mp4');
const FIX = path.join(__dirname, 'tests', 'playerbar-fixtures');
// Each service's page: the play bar's fixture at that service's player URL shape where it has one (Prime Video and
// ESPN have no fixture of their own: they borrow Disney+'s and Hulu's page, which is all the card needs).
const PAGE = {
  youtube: ['youtube', '/watch?v=pbtest'], disney: ['disney', '/video/pbtest'], hulu: ['hulu', '/watch/pbtest'],
  prime: ['disney', '/__pb/disney'], espn: ['hulu', '/__pb/hulu']
};
const NAMES = { youtube: 'YouTube', disney: 'Disney+', hulu: 'Hulu', prime: 'Prime Video', espn: 'ESPN' };

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 2000;
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, origin: 'http://127.0.0.1:' + s.address().port }));
  });
}
function send(res, type, body) { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); }
function sendClip(req, res) {
  let st;
  try { st = fs.statSync(CLIP); } catch (e) { res.writeHead(404); res.end('no clip'); return; }
  const m = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range || ''));
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : Math.min(start + 4 * 1024 * 1024 - 1, st.size - 1);
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size, 'Content-Length': end - start + 1 });
    fs.createReadStream(CLIP, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
  fs.createReadStream(CLIP).pipe(res);
}
async function startServers(mock) {
  const fronts = {};
  for (const svc of Mock.SERVICES) {
    fronts[svc] = await listen((req, res) => {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      const p = u.pathname;
      if (p === '/__media/clip.mp4') return sendClip(req, res);
      if (p === '/__vtt/en.vtt' || p === '/__vtt/fr.vtt') return send(res, 'text/vtt', 'WEBVTT\n\n00:00.000 --> 59:00.000\nLumen test caption\n');
      const fx = PAGE[svc] && (p === PAGE[svc][1].split('?')[0] ? PAGE[svc][0] : null);
      const f = fx || ((/^\/__pb\/(youtube|disney|hulu)$/.exec(p) || [])[1]);
      if (f) return send(res, 'text/html; charset=utf-8', fs.readFileSync(path.join(FIX, f + '.html'), 'utf8'));
      const up = http.request({ host: '127.0.0.1', port: mock.ports[svc], path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + mock.ports[svc] }) }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('mock gone'); } });
      req.pipe(up);
    });
  }
  const tmdb = await listen((req, res) => { res.writeHead(404); res.end('none'); });
  const rebase = [['https://www.themoviedb.org', tmdb.origin], ['https://api.themoviedb.org', tmdb.origin]];
  for (const svc of Mock.SERVICES) for (const from of Mock.ORIGINS[svc]) rebase.push([from, fronts[svc].origin]);
  return { fronts, rebase, close: () => { tmdb.server.close(); for (const f of Object.values(fronts)) f.server.close(); } };
}

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
const KEYS = { ' ': [' ', 'Space', 32], Enter: ['Enter', 'Enter', 13] };
async function key(c, k) {
  const [kk, code, vk] = KEYS[k];
  const base = { key: kk, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 };
  const text = k === 'Enter' ? '\r' : kk;
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown', text }, base));
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}
async function click(c, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await c.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
}
function pngSize(file) { const b = fs.readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; }
const ST = 'WatchPlayer._state()';
const UP = 'WatchPlayer._state().extras';
// What the page's biggest video is doing.
const VID = '(() => { const v = [].slice.call(document.querySelectorAll("video")).sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0]; return v ? { paused: v.paused, ended: v.ended, t: Math.round(v.currentTime * 10) / 10, d: Math.round(v.duration), rs: v.readyState } : null; })()';
// The card's focused element and its Play now button's centre.
const FOCUS = '(() => { const a = document.activeElement; return a ? (a.className || a.tagName) : ""; })()';
const PLAYAT = '(() => { const b = document.querySelector(".wpx-up:not([hidden]) .wpx-up-play"); if (!b || !b.offsetParent) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()';

run('watch-upnext-e2e', async ({ check, launch }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  check(await Clip.ensureClip(CLIP), 'the synthetic test clip is here (made locally, no recording)', CLIP);
  const mock = await Mock.start({ log: () => {} });
  const srv = await startServers(mock);
  const env = {
    QUARTZ_WATCH_BOOT_GRACE_MS: '0',
    QUARTZ_WATCH_REBASE: JSON.stringify(srv.rebase),
    QUARTZ_WATCH_MIN_FREE_GB: '0',
    QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1',
    QUARTZ_TEST_VMP: 'signed',
    QUARTZ_TEST_CDM: 'ready'
  };
  const q = await launch({ cdp: CDP_PORT, env });
  const chrome = q.chrome;
  try {
    await chrome.ev('window.__fsCalls = 0; window.toggleFullscreen = function () { window.__fsCalls++; }; 1');
    await chrome.ev('try { localStorage.removeItem("lumen.playbar"); } catch (e) {} 1');
    const seam = await chrome.ev('!!(window.WatchPlayerExtras && typeof WatchPlayerExtras._fake === "function" && typeof WatchPlayerExtras._ended === "function")');
    check(seam, 'the Up next card and its e2e seam are loaded');
    await chrome.ev('openWatchTab(), 1');
    await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 20000);
    await sleep(1500);
    await chrome.ev('window.api.watchPlayer.testCapture({ width: 1536, height: 800, wait: 600 })');

    const urlOf = (svc, ep) => {
      const u = srv.fronts[svc].origin + PAGE[svc][1];
      return ep > 1 ? u + (u.indexOf('?') === -1 ? '?' : '&') + 'ep=' + ep : u;
    };
    const next = (svc, ep) => ({ id: svc + ':lumen-e2e-ep' + ep, service: svc, title: 'Lumen test show', subtitle: 'S1 E' + ep + ' · Episode ' + ep, url: urlOf(svc, ep) });
    const guest = async (url) => { const t = await targetWhere(q, (x) => String(x.url).indexOf(url) === 0, 15000); return t ? cdpTo(t) : null; };
    const slotUrl = () => chrome.ev(ST + '.slots.length ? ' + ST + '.slots[0].url : ""');
    const up = () => chrome.ev(UP + ' && ' + UP + '.upnext');
    const counting = (ms) => chrome.waitFor('(() => { const u = ' + UP + ' && ' + UP + '.upnext; return u && u.phase === "counting" && ' + UP + '.upShown ? u : null; })()', ms || 10000).catch(() => null);
    const shoot = async (name) => {
      for (const [w, h] of [[1280, 800], [1536, 800]]) {
        await chrome.ev(`window.api.watchPlayer.testCapture({ width: ${w}, height: ${h}, wait: 900 })`);
        await sleep(300);
        const cap = await chrome.ev('window.api.watchPlayer.testCapture({ wait: 0 })');
        const file = path.join(SHOTS, 'upnext-' + name + '-' + w + 'x' + h + '.png');
        if (cap && cap.ok && cap.png) fs.writeFileSync(file, Buffer.from(cap.png, 'base64'));
        const sz = fs.existsSync(file) ? pngSize(file) : null;
        check(!!sz && sz[0] >= w && sz[1] >= h, 'shot ' + path.basename(file) + ' is ' + (sz ? sz.join('x') : 'missing'), sz);
      }
      await chrome.ev('window.api.watchPlayer.testCapture({ width: 1536, height: 800, wait: 600 })');
    };

    /* ---- 0. the real path, no seam: a Hulu episode ends, main re-reads Hulu (the local mock) and the card offers
       The Bear S4 E3 from its Continue row; Space with the focus on Play now. (Before the fix this played S4 E3.) ---- */
    {
      const u0 = urlOf('hulu', 1);
      await chrome.ev(`openInLumen(${JSON.stringify(u0)}, { service: "hulu", title: "The Bear · S4 E2", item: { id: "hulu:lumen-e2e-bear", service: "hulu", title: "The Bear", subtitle: "S4 E2" } }), 1`);
      const g0 = await guest(u0);
      const ok0 = g0 && await g0.waitFor('(() => { const v = document.querySelector("video"); return !!v && v.readyState >= 2 && v.duration > 30; })()', 20000).then(() => true, () => false);
      check(!!ok0, 'real path: the Hulu fixture plays in the layer');
      if (ok0) {
        await sleep(1200);
        await g0.ev('(() => { const v = document.querySelector("video"); v.loop = false; v.currentTime = Math.max(0, v.duration - 0.6); const p = v.play(); if (p && p.catch) p.catch(() => 0); return 1; })()');
        const c0 = await counting(60000);
        check(!!c0 && c0.next && /S4\s*E3/.test(c0.next.subtitle || ''), 'real path: the episode ended, main re-read Hulu and the card counts down to The Bear S4 E3', c0 || await up());
        if (c0) {
          check(/wpx-up-play/.test(await chrome.ev(FOCUS)), 'real path: the focus is on the card\'s Play now', await chrome.ev(FOCUS));
          await key(chrome, ' ');
          await sleep(1500);
          const r0 = await up();
          check(!!r0 && r0.phase === 'held' && (await slotUrl()) === u0, 'real path: Space stops the countdown and stays on the ended episode (it used to play S4 E3)', { phase: r0 && r0.phase, how: r0 && r0.how, url: await slotUrl() });
        }
      }
      if (g0) g0.close();
      await chrome.ev('WatchPlayer.close("e2e"), 1').catch(() => 0);
      await sleep(900);
    }
    if (!seam) throw new Error('no Up next e2e seam (WatchPlayerExtras._fake): the per-service checks need it');

    for (const svc of ['youtube', 'disney', 'hulu', 'prime', 'espn']) {
      const N = NAMES[svc];
      const long = svc === 'youtube' || svc === 'hulu';   // these two wait past the whole 10 s countdown
      const u1 = urlOf(svc, 1);
      await chrome.ev(`openInLumen(${JSON.stringify(u1)}, { service: ${JSON.stringify(svc)}, title: "Lumen test show · S1 E1", item: ${JSON.stringify({ id: svc + ':lumen-e2e-ep1', service: svc, title: 'Lumen test show', subtitle: 'S1 E1 · Episode 1' })} }), 1`);
      let g = await guest(u1);
      const plays = g && await g.waitFor('(() => { const v = document.querySelector("video"); return !!v && v.readyState >= 2 && !v.paused && v.duration > 30; })()', 20000).then(() => true, () => false);
      check(!!plays, N + ': the fixture video plays in the layer', g && await g.ev(VID).catch(() => null));
      if (!plays) { if (g) g.close(); await chrome.ev('WatchPlayer.close("e2e"), 1').catch(() => 0); await sleep(800); continue; }
      await sleep(1200);   // the page's media report and the play bar settle

      /* ---- 1. the video still plays (credits): Space pauses it and stops the countdown ---- */
      await chrome.ev(`WatchPlayerExtras._fake(${JSON.stringify(next(svc, 2))}), WatchPlayerExtras._ended(), 1`);
      const c1 = await counting();
      check(!!c1 && c1.next && c1.next.url === urlOf(svc, 2), N + ': Up next counts down to S1 E2 while the video still plays', c1);
      check(/wpx-up-play/.test(await chrome.ev(FOCUS)), N + ': the card puts the focus on its Play now (where Space used to press it)', await chrome.ev(FOCUS));
      await key(chrome, ' ');
      const h1 = await chrome.waitFor('(() => { const u = ' + UP + '.upnext; return u && u.phase !== "counting" && (u.how || u.phase === "played") ? u : null; })()', 4000).catch(() => null);
      const v1 = await g.ev(VID).catch(() => null);
      check(!!h1 && h1.phase === 'held' && h1.how === 'paused', N + ': Space stops the countdown (held), never plays the next one', h1 && { phase: h1.phase, how: h1.how });
      check(!!v1 && v1.paused && !v1.ended, N + ': Space paused the still-playing video', v1);
      check(!!h1 && /Countdown stopped and this video paused/.test(h1.text || ''), N + ': the card says the countdown stopped and the video paused', h1 && h1.text);
      if (svc === 'youtube') await shoot('held-paused');
      await sleep(long ? 11500 : 2500);
      const s1 = await up();
      const v1b = await g.ev(VID).catch(() => null);
      check((await slotUrl()) === u1 && s1 && s1.phase === 'held' && !!v1b && v1b.paused, N + ': ' + (long ? '11.5 s' : '2.5 s') + ' later: still S1 E1, still paused, the card still stopped (no advance)', { url: await slotUrl(), phase: s1 && s1.phase, left: s1 && s1.left, v: v1b });
      check(s1 && c1 && s1.left >= c1.left - 1, N + ': the countdown number stopped where Space caught it', { before: c1 && c1.left, after: s1 && s1.left });
      /* ---- 2. a second Space plays this video again ---- */
      check(/wpx-up-play/.test(await chrome.ev(FOCUS)), N + ': the focus stays on the card after the stop', await chrome.ev(FOCUS));
      await key(chrome, ' ');
      const back = await g.waitFor('(() => { const v = document.querySelector("video"); return v && !v.paused ? 1 : 0; })()', 4000).then(() => true, () => false);
      await sleep(600);
      const s2 = await up();
      check(back, N + ': a second Space plays S1 E1 again', await g.ev(VID).catch(() => null));
      check((await slotUrl()) === u1 && s2 && s2.phase !== 'played' && s2.phase !== 'counting', N + ': ...and still no next episode (the card stopped or stepped aside, never counting)', { url: await slotUrl(), phase: s2 && s2.phase, reason: s2 && s2.reason });
      await chrome.ev('(document.querySelector(".wpx-up:not([hidden]) .wpx-up-cancel") || { click: () => 0 }).click(), 1');

      /* ---- 3. the video ended: Space stops the countdown and stays on this video ---- */
      await g.ev('(() => { const v = document.querySelector("video"); v.loop = false; v.currentTime = Math.max(0, v.duration - 0.6); const p = v.play(); if (p && p.catch) p.catch(() => 0); return 1; })()');
      const c3 = await counting(10000);
      const v3 = await g.ev(VID).catch(() => null);
      check(!!c3 && !!v3 && v3.ended, N + ': the video ENDED for real and Up next counts down', { c: c3 && c3.phase, v: v3 });
      await key(chrome, ' ');
      const h3 = await chrome.waitFor('(() => { const u = ' + UP + '.upnext; return u && u.phase !== "counting" && (u.how || u.phase === "played") ? u : null; })()', 4000).catch(() => null);
      check(!!h3 && h3.phase === 'held' && h3.how === 'ended', N + ': Space after the end stops the countdown and stays (held, ended)', h3 && { phase: h3.phase, how: h3.how });
      check(!!h3 && /Countdown stopped\. Staying on this video/.test(h3.text || ''), N + ': the card says the countdown stopped and it stays on this video', h3 && h3.text);
      if (svc === 'youtube') await shoot('held-ended');
      await sleep(2500);
      const v3b = await g.ev(VID).catch(() => null);
      check((await slotUrl()) === u1 && !!v3b && v3b.ended, N + ': 2.5 s later still on S1 E1, still at its end (no replay, no advance)', { url: await slotUrl(), v: v3b });

      /* ---- 4. Enter or a click on Play now still plays the next one ---- */
      const byClick = svc === 'disney' || svc === 'prime';
      if (byClick) { const p = await chrome.ev(PLAYAT); if (p) await click(chrome, p[0], p[1]); } else await key(chrome, 'Enter');
      const p4 = await chrome.waitFor(`(() => { const u = ${UP}.upnext; return u && u.phase === "played" && ${ST}.slots[0].url.indexOf("ep=2") !== -1 ? u : null; })()`, 6000).catch(() => null);
      check(!!p4, N + ': ' + (byClick ? 'a click' : 'Enter') + ' on the card\'s Play now plays S1 E2', { up: await up(), url: await slotUrl() });
      g.close();
      g = p4 ? await guest(urlOf(svc, 2)) : null;

      if (svc === 'youtube' && g) {
        await g.waitFor('(() => { const v = document.querySelector("video"); return !!v && v.readyState >= 2 && !v.paused; })()', 20000).catch(() => 0);
        await sleep(1200);
        /* ---- 5. the countdown running out untouched still plays the next one ---- */
        await chrome.ev(`WatchPlayerExtras._fake(${JSON.stringify(next(svc, 3))}), WatchPlayerExtras._ended(), 1`);
        const c5 = await counting();
        check(!!c5, N + ': S1 E2 offers S1 E3, counting', c5);
        const p5 = await chrome.waitFor(`(() => { const u = ${UP}.upnext; return u && u.phase === "played" && ${ST}.slots[0].url.indexOf("ep=3") !== -1 ? u : null; })()`, 14000).catch(() => null);
        check(!!p5, N + ': left alone, the countdown runs out and S1 E3 plays', { up: await up(), url: await slotUrl() });
        g.close();
        g = p5 ? await guest(urlOf(svc, 3)) : null;
        /* ---- 6. Space from inside the page (the play bar's key bridge) stops the countdown too ---- */
        if (g) {
          await g.waitFor('(() => { const v = document.querySelector("video"); return !!v && v.readyState >= 2 && !v.paused; })()', 20000).catch(() => 0);
          await chrome.waitFor('LumenPlayerBar._state().slots[0] && LumenPlayerBar._state().slots[0].on', 10000).catch(() => 0);
          await sleep(1200);
          await chrome.ev(`WatchPlayerExtras._fake(${JSON.stringify(next(svc, 4))}), WatchPlayerExtras._ended(), 1`);
          const c6 = await counting();
          check(!!c6, N + ': S1 E3 offers S1 E4, counting', c6);
          await key(g, ' ');
          const h6 = await chrome.waitFor('(() => { const u = ' + UP + '.upnext; return u && u.phase !== "counting" && (u.how || u.phase === "played") ? u : null; })()', 4000).catch(() => null);
          const v6 = await g.ev(VID).catch(() => null);
          check(!!h6 && h6.phase === 'held' && h6.how === 'paused' && !!v6 && v6.paused, N + ': Space pressed inside the page stops the countdown and pauses (no advance)', { up: h6 && { phase: h6.phase, how: h6.how }, v: v6 });
          await sleep(2500);
          check((await slotUrl()).indexOf('ep=3') !== -1, N + ': 2.5 s later still on S1 E3', await slotUrl());
          g.close();
          g = null;
        }
      }
      if (g) g.close();
      await chrome.ev('WatchPlayerExtras._fake(null), WatchPlayer.close("e2e"), 1').catch(() => 0);
      await sleep(900);
    }
    check((await chrome.ev('window.__fsCalls')) === 0, 'no screen fullscreen all run');
  } finally {
    await q.quit().catch(() => 0);
    srv.close();
    try { await mock.close(); } catch (e) { /* gone */ }
  }
});
