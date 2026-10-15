// sleep-e2e.js -- tab sleep and wake, end to end, in a REAL Quartz test instance.
//
//   node sleep-e2e.js
//
// tests/e2e-kit.js launches it (--test-profile, off-screen, watched). Local pages only. Checks:
//   - the rules: the tab in front never sleeps; a pinned tab and the front tab are spared by the
//     idle sweep; "never" (tabSleepMinutes 0) sleeps nothing;
//   - sleeping a scrolled background tab: its guest is really gone (the <webview> leaves #views
//     and its DevTools target goes), the chip keeps its title, wears the asleep class, and the
//     crescent badge is SHOWN (display, size, the mask painted), the tooltip says "asleep";
//   - waking it by clicking its chip (a real mouse click over CDP): the badge goes, the page is
//     fetched again from the server, on the SAME url (query and hash included), with its title;
//   - the idle sweep (sleepIdleTabs, what the 60 s timer runs) sleeps a tab idle past the limit.
//   - scroll is kept: the woken page is back at 2400 (wakeTab puts back the scroll
//     rememberTabScroll read when the tab went into the background).
//   - and across a RESTART: a scrolled tab asleep in another workspace is written to session.json
//     with its scroll, comes back asleep (not fetched), and wakes at that scroll.
// One summary line: "sleep-e2e: N passed, M failed".
'use strict';
const { run, serve, html, sleep } = require('./tests/e2e-kit');

const CDP = 9432;

run('sleep-e2e', async ({ check, launch, say, profileDir }) => {
  const srv = await serve((req, res, p) => {
    if (p === '/long.html' || p === '/far.html') return html(res, '<!doctype html><title>Long page</title><style>body{margin:0}</style><div style="height:9000px;background:linear-gradient(#eee,#999)">top</div>');
    const m = /^\/([a-z0-9]+)\.html$/.exec(p);
    if (!m) return false;
    return html(res, `<!doctype html><title>Page ${m[1].toUpperCase()}</title><p>${m[1]}</p>`);
  });
  const B = 'http://127.0.0.1:' + srv.port;
  const LONG = B + '/long.html?keep=1#part-2';
  const FAR = B + '/far.html';
  const q = await launch({ cdp: CDP });
  let c = q.chrome;

  const open = async (name, url) => {
    await c.ev(`(() => { window.__t = window.__t || {}; const t = createTab(${JSON.stringify(url)}); window.__t[${JSON.stringify(name)}] = t; activateTab(t.id); return t.id; })()`);
    await c.waitFor(`window.__t[${JSON.stringify(name)}].ready === true`, 15000);
  };
  const T = (name) => `window.__t[${JSON.stringify(name)}]`;
  const badge = (name) => c.ev(`(() => { const chip = ${T(name)}.chipEl; const b = chip && chip.querySelector('.tab-fav > .tab-badge'); if (!b) return { missing: true };
    const cs = getComputedStyle(b); const bf = getComputedStyle(b, '::before'); const r = b.getBoundingClientRect();
    return { asleepClass: chip.classList.contains('asleep'), display: cs.display, w: Math.round(r.width), h: Math.round(r.height),
      mask: String(bf.webkitMaskImage || bf.maskImage || ''), before: bf.content, title: chip.title || '' }; })()`);
  const webviews = () => c.ev("document.querySelectorAll('#views webview').length");
  const guestTarget = async (re) => (await q.targets()).filter((x) => x.type === 'webview' && re.test(String(x.url))).length;

  // ---- the rules ---------------------------------------------------------------------------
  await open('long', LONG);
  const scrolled = await c.ev(`${T('long')}.viewEl.executeJavaScript('window.scrollTo(0, 2400); new Promise((r) => requestAnimationFrame(() => r(Math.round(window.scrollY))))')`);
  check(scrolled === 2400, 'the long page scrolled to 2400 before sleeping', scrolled);
  check(await c.ev(`sleepTab(${T('long')}, 'asked')`) === false, 'the tab in front refuses to sleep');
  check(await c.ev(`canSleepTab(${T('long')})`) === false, 'canSleepTab: the tab in front is never a candidate');
  await open('front', B + '/front.html');
  await open('pinned', B + '/pin.html');
  await c.ev(`setTabPinned(${T('pinned')}, true), activateTab(${T('front')}.id), 1`);
  check(await c.ev(`canSleepTab(${T('pinned')})`) === false, 'canSleepTab: a pinned tab is spared');
  check(await c.ev(`canSleepTab(${T('long')})`) === true, 'canSleepTab: a plain background tab is a candidate');

  // ---- sleep -------------------------------------------------------------------------------
  const before = { views: await webviews(), targets: await guestTarget(/\/long\.html/) };
  check(before.targets === 1, 'awake: the long page has its own guest (a DevTools webview target)', before.targets);
  const longHits = srv.hits('/long.html');
  check(await c.ev(`sleepTab(${T('long')}, 'asked')`) === true, 'sleepTab put the background tab to sleep');
  check(await c.ev(`${T('long')}.asleep === true && ${T('long')}.viewEl.classList.contains('sleeping-view') && ${T('long')}.viewEl.isConnected`), 'the tab holds a sleeping placeholder, not a webview');
  check(await webviews() === before.views - 1, 'its <webview> left #views', { before: before.views, after: await webviews() });
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) { gone = (await guestTarget(/\/long\.html/)) === 0; if (!gone) await sleep(100); }
  check(gone, 'its guest is really gone (no DevTools target for it within 3 s)');
  let bd = await badge('long');
  check(bd.asleepClass === true, 'the chip wears .asleep', bd);
  check(bd.display === 'flex' && bd.w >= 6 && bd.h >= 6, 'the sleep badge is SHOWN on the chip (display flex, a real size)', bd);
  check(/svg/.test(bd.mask), 'the badge paints the crescent (its mask is the svg)', bd.mask.slice(0, 80));
  check(/asleep, click to wake/.test(bd.title), 'the chip tooltip says it is asleep and how to wake it', bd.title);
  check(await c.ev(`${T('long')}.title`) === 'Long page', 'the chip keeps the page title while asleep', await c.ev(`${T('long')}.title`));
  const pb = await badge('front');
  check(pb.display === 'none' && pb.asleepClass === false, 'an awake chip shows no badge', pb);

  // ---- wake, by clicking the chip ---------------------------------------------------------
  const rect = await c.ev(`(() => { const r = ${T('long')}.chipEl.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width * 0.35, 40)), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await c.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
  const woke = await c.waitFor(`${T('long')}.asleep === false && activeTabId === ${T('long')}.id && ${T('long')}.ready === true`, 15000).catch((e) => e.message);
  check(woke === true, 'clicking the sleeping chip raised and woke it', woke);
  bd = await badge('long');
  check(bd.asleepClass === false && bd.display === 'none', 'awake again: the badge is gone', bd);
  const url = await c.ev(`readCurrentUrl(${T('long')})`);
  check(url === LONG, 'it woke on the SAME url, query and hash included', url);
  check(srv.hits('/long.html') === longHits + 1, 'the page was fetched again from the server (a real reload)', srv.hits('/long.html') - longHits);
  const title = await c.waitFor(`${T('long')}.title === 'Long page'`, 5000).catch((e) => e.message);
  check(title === true, 'the woken page has its title', title);
  check(await guestTarget(/\/long\.html/) === 1, 'a guest of its own again');
  // What the user sees: the page back where they left it. Polled, because it is put back when the
  // woken guest stops loading, a moment after ready.
  let after = null;
  for (let i = 0; i < 50 && after !== 2400; i++) {
    after = await c.ev(`${T('long')}.viewEl.executeJavaScript('Math.round(window.scrollY)')`).catch(() => null);
    if (after !== 2400) await sleep(100);
  }
  check(after === 2400, 'scroll kept across sleep and wake (back at 2400 within 5 s)', after);

  // ---- the idle sweep ----------------------------------------------------------------------
  await open('idle', B + '/idle.html');
  await c.ev(`activateTab(${T('front')}.id), 1`);
  const past = 'Date.now() - 6 * 3600 * 1000';
  await c.ev(`${T('idle')}.lastActive = ${past}; ${T('pinned')}.lastActive = ${past}; ${T('front')}.lastActive = ${past}; 1`);
  await c.ev("Settings.set({ tabSleepMinutes: 0 }), 1");
  check(await c.ev('sleepIdleTabs()') === 0, 'sweep with "never" (0 minutes): nothing sleeps');
  check(await c.ev(`${T('idle')}.asleep`) === false, 'sweep with "never": the idle tab is still awake');
  await c.ev("Settings.set({ tabSleepMinutes: 30 }), 1");
  const n = await c.ev('sleepIdleTabs()');
  check(n >= 1 && await c.ev(`${T('idle')}.asleep`) === true, 'sweep at 30 min: a tab idle for 6 h went to sleep', n);
  check(await c.ev(`${T('pinned')}.asleep`) === false, 'sweep: the pinned tab, idle as long, stayed awake');
  check(await c.ev(`${T('front')}.asleep`) === false, 'sweep: the tab in front stayed awake');
  check((await badge('idle')).display === 'flex', 'the swept tab shows the badge too');
  await c.ev(`activateTab(${T('idle')}.id), 1`);
  const idleOk = await c.waitFor(`${T('idle')}.ready === true && !${T('idle')}.asleep && ${T('idle')}.title === 'Page IDLE'`, 15000).catch((e) => e.message);
  check(idleOk === true, 'the swept tab wakes and loads when raised', idleOk);

  // ---- across a restart --------------------------------------------------------------------
  // A tab in another workspace, scrolled, then asleep: what a restart brings back asleep.
  const W2 = await c.ev("createWorkspace('Far', null)");
  await c.ev(`switchWorkspace(${JSON.stringify(W2)}), 1`);
  await open('far', FAR);
  const farAt = await c.ev(`${T('far')}.viewEl.executeJavaScript('window.scrollTo(0, 3100); new Promise((r) => requestAnimationFrame(() => r(Math.round(window.scrollY))))')`);
  check(farAt === 3100, 'restart case: the far tab scrolled to 3100', farAt);
  await c.ev('switchWorkspace(DEFAULT_WORKSPACE_ID), 1');
  if (!(await c.ev(`${T('far')}.asleep`))) await c.ev(`sleepTab(${T('far')}, 'asked')`);
  const slept = await c.waitFor(`${T('far')}.asleep === true && ${T('far')}.savedScroll && ${T('far')}.savedScroll.y === 3100`, 5000).catch((e) => e.message);
  check(slept === true, 'restart case: the far tab is asleep holding its scroll (3100)', slept);
  const SESSION = require('path').join(profileDir, 'session.json');
  const stored = () => { try { const j = JSON.parse(require('fs').readFileSync(SESSION, 'utf8')); return (j.tabs || []).find((e) => e && /far.html/.test(e.url || '')) || null; } catch (e) { return null; } };
  await c.ev('saveSession(), 1');
  let farEntry = null;
  for (let i = 0; i < 60 && !(farEntry && farEntry.scroll); i++) { farEntry = stored(); if (!(farEntry && farEntry.scroll)) await sleep(100); }
  check(!!(farEntry && Array.isArray(farEntry.scroll) && farEntry.scroll[1] === 3100), 'session.json: the asleep tab is stored with its scroll [0, 3100]', farEntry);

  check(await q.quit(), 'closing the window quit Quartz');
  const farHits = srv.hits('/far.html');
  const q2 = await launch({ cdp: CDP });
  c = q2.chrome;
  const FAR_TAB = "tabs.find((t) => t.kind === 'page' && /far.html/.test(String(t.url)))";
  const back = await c.waitFor(`(() => { const t = ${FAR_TAB}; return t ? { asleep: !!t.asleep, y: t.savedScroll ? t.savedScroll.y : null } : null; })()`, 10000).catch((e) => e.message);
  check(back && back.asleep === true && back.y === 3100, 'after the restart: the far tab came back asleep, holding scroll 3100', back);
  check(srv.hits('/far.html') === farHits, 'after the restart: an asleep tab was not fetched', srv.hits('/far.html') - farHits);
  await c.ev(`switchWorkspace(${JSON.stringify(W2)}), 1`);
  const woke2 = await c.waitFor(`(() => { const t = ${FAR_TAB}; return !!(t && !t.asleep && t.ready && t.id === activeTabId); })()`, 15000).catch((e) => e.message);
  check(woke2 === true, 'after the restart: switching to its workspace wakes it', woke2);
  let y2 = null;
  for (let i = 0; i < 50 && y2 !== 3100; i++) {
    y2 = await c.ev(`${FAR_TAB}.viewEl.executeJavaScript('Math.round(window.scrollY)')`).catch(() => null);
    if (y2 !== 3100) await sleep(100);
  }
  check(y2 === 3100, 'after the restart: the woken tab is back at 3100 (it used to come back at the top)', y2);
  check(await q2.quit(), 'closing the window quit Quartz (boot 2)');
  say('server hits: long ' + srv.hits('/long.html') + ', idle ' + srv.hits('/idle.html'));
  srv.close();
});
