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
//   - sound: a page with two players (one pauses, which clears the media flag, the other keeps
//     playing) and a Web Audio oscillator page are never slept by the idle sweep, sleepTab, "sleep
//     other tabs" or the workspace rule; once quiet they are spared 2 more minutes, then sleep.
//   - a new tab page sent to the background of the workspace on screen sleeps after its 15 s grace,
//     wakes as a fresh Home with theme/settings/layout/Saved/apps/readout re-pushed and the stats
//     subscription back on it; one holding typed text is kept awake; workspace sleep "off" stands it down.
//   - lazy restore: after the restart only the tab in front of the workspace on screen (and the
//     pinned one) loads; every other Home tab comes back asleep with its crescent and title.
// One summary line: "sleep-e2e: N passed, M failed".
'use strict';
const { run, serve, html, sleep } = require('./tests/e2e-kit');

// E2E_CDP lets a parallel lane run this on a port of its own.
const CDP = Number(process.env.E2E_CDP) || 9432;

run('sleep-e2e', async ({ check, launch, say, profileDir }) => {
  // A 2 s 440 Hz tone (8 kHz, 16-bit mono WAV) for the sound checks, built here: no fixture file.
  const tone = (() => {
    const rate = 8000, n = rate * 2, data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 6000), i * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
    h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
  })();
  const srv = await serve((req, res, p) => {
    if (p === '/tone.wav') { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': tone.length }); res.end(tone); return true; }
    // Twitch's shape: two media elements; one keeps playing, the other plays then pauses (an ad, a
    // preview). The pause fires media-paused for the whole tab while sound is still coming out.
    if (p === '/twoel.html') return html(res, '<!doctype html><title>Two players</title><audio id="a" src="/tone.wav" loop autoplay></audio><audio id="b" src="/tone.wav" loop autoplay></audio><script>setTimeout(() => document.getElementById("b").pause(), 1500);</script>');
    // Web Audio only: no media element at all, so no media event ever fires.
    if (p === '/osc.html') return html(res, '<!doctype html><title>Oscillator</title><script>window.ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain(); g.gain.value = 0.05; o.connect(g).connect(ctx.destination); o.start();</script>');
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
  // Real pages only: a new tab page sent to the background now goes to sleep after a 15 s grace
  // (sleepBackgroundNewTab), so the boot tab's guest can leave #views in the middle of a count.
  const webviews = () => c.ev("Array.from(document.querySelectorAll('#views webview')).filter((w) => !isNewTabUrl(w.getAttribute('src') || '')).length");
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

  // ---- a tab making sound never sleeps (Chromium's audibility, not the media flag) ------------
  const audibleNow = (name) => c.ev(`${T(name)}.viewEl.isCurrentlyAudible()`).catch((e) => 'threw ' + e.message);
  await open('two', B + '/twoel.html');
  const twoSound = await c.waitFor(`${T('two')}.viewEl.isCurrentlyAudible() === true`, 10000).catch((e) => e.message);
  check(twoSound === true, 'sound: the two-player page is audible to Chromium (autoplay ran)', twoSound);
  await sleep(2500); // element b has paused by now: media-paused for the whole tab
  const twoFlag = await c.ev(`({ flag: !!${T('two')}.audible, chromium: ${T('two')}.viewEl.isCurrentlyAudible() })`);
  say('two players after one paused: media flag ' + twoFlag.flag + ', Chromium audible ' + twoFlag.chromium);
  check(twoFlag.chromium === true, 'sound: one element paused, the other still audible to Chromium', twoFlag);
  await open('osc', B + '/osc.html');
  const oscSound = await c.waitFor(`${T('osc')}.viewEl.isCurrentlyAudible() === true`, 10000).catch((e) => e.message);
  check(oscSound === true, 'sound: the Web Audio oscillator page is audible to Chromium', oscSound);
  check(await c.ev(`!!${T('osc')}.audible`) === false, 'sound: Web Audio never set the media flag (why the flag alone is not enough)');
  await c.ev(`activateTab(${T('front')}.id), 1`);
  await c.ev(`${T('two')}.lastActive = ${past}; ${T('osc')}.lastActive = ${past}; 1`);
  await c.ev("Settings.set({ tabSleepMinutes: 15 }), 1");
  for (let i = 0; i < 3; i++) { await c.ev('sleepIdleTabs()'); await sleep(300); }
  check(await c.ev(`${T('two')}.asleep`) === false, 'sound: idle sweep (idle 6 h) never sleeps the two-player tab while it plays');
  check(await c.ev(`${T('osc')}.asleep`) === false, 'sound: idle sweep never sleeps the Web Audio tab while it plays');
  check(await c.ev(`sleepTab(${T('osc')}, 'asked')`) === false, 'sound: sleepTab itself refuses it at the moment of sleeping');
  await c.ev('sleepOtherTabs(), 1');
  check(await c.ev(`!${T('two')}.asleep && !${T('osc')}.asleep`), 'sound: "sleep other tabs" spares both');
  check(await c.ev(`canSleepInWorkspace(${T('osc')}, 'all')`) === false, 'sound: the workspace "all" rule spares it too');
  check(await c.ev(`tabSoundReason(${T('osc')})`) === 'making sound', 'sound: the reason is "making sound" (the Sleep tab menu item shows it disabled)');
  // The sound stops: spared for the 2-minute window, then sleepable.
  await c.ev(`${T('osc')}.viewEl.executeJavaScript('window.ctx.close().then(() => 1)')`).catch(() => 0);
  const quiet = await c.waitFor(`${T('osc')}.viewEl.isCurrentlyAudible() === false`, 15000).catch((e) => e.message);
  check(quiet === true, 'sound: the oscillator stopped (Chromium no longer hears it)', quiet);
  await c.ev('sleepIdleTabs()');
  check(await c.ev(`${T('osc')}.asleep`) === false && await c.ev(`tabSoundReason(${T('osc')})`) === 'made sound in the last 2 minutes', 'sound: just stopped, still spared (2-minute window)');
  await c.ev(`${T('osc')}.lastAudibleAt = Date.now() - 4 * 60000; 1`);
  await c.ev('sleepIdleTabs()');
  check(await c.ev(`${T('osc')}.asleep`) === true, 'sound: quiet for longer than the window, the idle sweep sleeps it');
  check(await c.ev(`${T('two')}.asleep`) === false && await audibleNow('two') === true, 'sound: the two-player tab is still awake and playing');
  await c.ev(`closeTab(${T('two')}.id), 1`);

  // ---- a new tab page sent to the background, in the workspace on screen ---------------------
  // It sleeps after a 15 s grace (sleepBackgroundNewTab), wakes as a fresh Home with everything
  // the chrome pushes re-pushed, and the stats sampler only ever follows the page in front.
  const newHome = async (name) => {
    await c.ev(`(() => { const t = createTab(HOME_URL); window.__t[${JSON.stringify(name)}] = t; activateTab(t.id); return 1; })()`);
    await c.waitFor(`${T(name)}.ready === true`, 15000);
  };
  await newHome('home');
  const homeBack = Date.now();
  await c.ev(`activateTab(${T('front')}.id), 1`);
  check(await c.ev(`${T('home')}.asleep`) === false && await c.ev(`!!${T('home')}.newTabSleepTimer`), 'home: still awake right after going to the background, its grace clock running');
  const homeSlept = await c.waitFor(`${T('home')}.asleep === true`, 30000).then(() => Date.now() - homeBack, (e) => e.message);
  check(typeof homeSlept === 'number' && homeSlept >= 14000, 'home: asleep after the 15 s grace (ms)', homeSlept);
  const hb = await badge('home');
  check(hb.asleepClass && hb.display === 'flex', 'home: its chip wears the asleep badge', hb);
  check(await c.ev('statsSubscribed') === false, 'home asleep, a web page in front: the stats sampler is unsubscribed');
  const wakeAt = Date.now();
  await c.ev(`activateTab(${T('home')}.id), 1`);
  const homeWake = await c.waitFor(`${T('home')}.ready === true && !${T('home')}.asleep`, 15000).then(() => Date.now() - wakeAt, (e) => e.message);
  check(typeof homeWake === 'number', 'home: woke when raised (ms to dom-ready)', homeWake);
  check(await c.ev(`isNewTabUrl(readCurrentUrl(${T('home')}))`) === true, 'home: woke as a new tab page');
  const memo = await c.waitFor(`(() => { const m = pushMemo.get(${T('home')}.viewEl); const k = m ? Object.keys(m) : []; return ['theme', 'settings', 'home', 'saved', 'apps', 'readout'].every((x) => k.indexOf(x) !== -1) ? k : null; })()`, 5000).catch((e) => e.message);
  check(Array.isArray(memo), 'home: the woken page was pushed theme, settings, layout, Saved, apps and readout', memo);
  const guestTheme = await c.ev(`${T('home')}.viewEl.executeJavaScript("document.documentElement.getAttribute('data-theme')")`).catch((e) => e.message);
  check(guestTheme === await c.ev('getTheme()'), 'home: the woken page wears the chrome theme', guestTheme);
  const statsNow = await c.waitFor(`statsSubscribed === statsTabEligible(${T('home')}) ? 'ok' : null`, 5000).catch((e) => e.message);
  check(statsNow === 'ok', 'home: in front again, the stats subscription follows it', statsNow);
  // Typed text keeps a Home awake (a fresh page would lose it); cleared, it sleeps on the next try.
  await newHome('typed');
  const typedSet = await c.ev(`${T('typed')}.viewEl.executeJavaScript("(() => { const i = document.getElementById('saved-input') || document.querySelector('input[type=text]'); if (!i) return false; i.value = 'half typed'; return true; })()")`).catch((e) => e.message);
  check(typedSet === true, 'typed: text put into the Home', typedSet);
  await c.ev(`activateTab(${T('front')}.id), 1`);
  const typedVerdict = await c.ev(`sleepBackgroundNewTab(${T('typed')})`);
  await sleep(1500);
  check(typedVerdict === 'probe' && await c.ev(`${T('typed')}.asleep`) === false, 'typed: a Home holding typed text is kept awake', typedVerdict);
  check(await c.ev(`!!${T('typed')}.newTabSleepTimer`), 'typed: and asked again later');
  await c.ev(`${T('typed')}.viewEl.executeJavaScript("(() => { for (const i of document.querySelectorAll('input, textarea')) i.value = i.defaultValue; return 1; })()")`);
  await c.ev(`sleepBackgroundNewTab(${T('typed')})`);
  const typedSlept = await c.waitFor(`${T('typed')}.asleep === true`, 5000).catch((e) => e.message);
  check(typedSlept === true, 'typed: cleared, it sleeps on the next try', typedSlept);
  // A sleep setting off: the rule stands down.
  await newHome('offhome');
  await c.ev(`activateTab(${T('front')}.id), 1`);
  await c.ev("Settings.set({ workspaceSleep: 'off' }), 1");
  check(await c.ev(`sleepBackgroundNewTab(${T('offhome')})`) === 'skip' && await c.ev(`${T('offhome')}.asleep`) === false, 'workspace sleep off: a background Home is left awake');
  await c.ev("Settings.set({ workspaceSleep: 'newtab' }), 1");
  await c.ev(`activateTab(${T('front')}.id), 1`);

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

  // Lazy restore: at quit the Home workspace holds long, front (in front), idle and the boot new
  // tab page plus the Homes above (all plain), and the pinned tab. Only front and pinned may load.
  const homeAtQuit = await c.ev("(() => { const ts = tabs.filter((t) => t.kind === 'page' && tabWorkspace(t) === currentWorkspaceId); return { plain: ts.filter((t) => !t.pinned).length, pinned: ts.filter((t) => t.pinned).length, front: readCurrentUrl(getActiveTab()) }; })()");
  check(homeAtQuit.plain >= 5 && homeAtQuit.pinned === 1 && /front\.html/.test(homeAtQuit.front), 'lazy restore setup: >= 5 plain tabs + 1 pinned in Home, front.html in front', homeAtQuit);
  const hitsAtQuit = { long: srv.hits('/long.html'), idle: srv.hits('/idle.html'), front: srv.hits('/front.html'), pin: srv.hits('/pin.html') };
  check(await q.quit(), 'closing the window quit Quartz');
  const farHits = srv.hits('/far.html');
  const q2 = await launch({ cdp: CDP });
  c = q2.chrome;
  const FAR_TAB = "tabs.find((t) => t.kind === 'page' && /far.html/.test(String(t.url)))";
  const back = await c.waitFor(`(() => { const t = ${FAR_TAB}; return t ? { asleep: !!t.asleep, y: t.savedScroll ? t.savedScroll.y : null } : null; })()`, 10000).catch((e) => e.message);
  check(back && back.asleep === true && back.y === 3100, 'after the restart: the far tab came back asleep, holding scroll 3100', back);
  check(srv.hits('/far.html') === farHits, 'after the restart: an asleep tab was not fetched', srv.hits('/far.html') - farHits);
  // ---- lazy restore: only the tab in front of the workspace on screen (and a pinned one) loads --
  const lazy = await c.waitFor("(() => { const ts = tabs.filter((t) => t.kind === 'page' && tabWorkspace(t) === currentWorkspaceId); const front = getActiveTab(); if (!front || !front.ready) return null; return { plain: ts.filter((t) => !t.pinned).length, plainAwake: ts.filter((t) => !t.pinned && !t.asleep).map((t) => t.url), pinnedAwake: ts.filter((t) => t.pinned && !t.asleep).length, views: document.querySelectorAll('#views webview').length, front: readCurrentUrl(front) }; })()", 15000).catch((e) => e.message);
  check(lazy && lazy.plain >= 5 && lazy.plainAwake.length === 1 && /front\.html/.test(lazy.plainAwake[0]), 'after the restart: of ' + (lazy && lazy.plain) + ' plain Home tabs exactly 1 is awake, the one in front', lazy);
  check(lazy && lazy.pinnedAwake === 1, 'after the restart: the pinned tab came back awake', lazy);
  check(lazy && lazy.views === 2, 'after the restart: 2 <webview>s in the whole window (front + pinned)', lazy && lazy.views);
  const guests = (await q2.targets()).filter((x) => x.type === 'webview').map((x) => x.url);
  check(guests.length === 2, 'after the restart: 2 guest renderers (DevTools webview targets)', guests);
  check(srv.hits('/long.html') === hitsAtQuit.long && srv.hits('/idle.html') === hitsAtQuit.idle, 'after the restart: the background Home pages were not fetched', { long: srv.hits('/long.html') - hitsAtQuit.long, idle: srv.hits('/idle.html') - hitsAtQuit.idle });
  check(srv.hits('/front.html') === hitsAtQuit.front + 1 && srv.hits('/pin.html') === hitsAtQuit.pin + 1, 'after the restart: front and pinned were each fetched once', { front: srv.hits('/front.html') - hitsAtQuit.front, pin: srv.hits('/pin.html') - hitsAtQuit.pin });
  const LONG_TAB = "tabs.find((t) => t.kind === 'page' && /long.html/.test(String(t.url)))";
  const lb = await c.ev(`(() => { const chip = ${LONG_TAB}.chipEl; const b = chip.querySelector('.tab-fav > .tab-badge'); return { asleepClass: chip.classList.contains('asleep'), display: b ? getComputedStyle(b).display : 'missing', title: chip.title, name: ${LONG_TAB}.title }; })()`);
  check(lb.asleepClass && lb.display === 'flex' && /asleep, click to wake/.test(lb.title) && lb.name === 'Long page', 'after the restart: a born-asleep Home tab shows the crescent, its title and the asleep tooltip', lb);
  await c.ev(`activateTab(${LONG_TAB}.id), 1`);
  const longWoke = await c.waitFor(`${LONG_TAB}.ready === true && !${LONG_TAB}.asleep`, 15000).catch((e) => e.message);
  check(longWoke === true && srv.hits('/long.html') === hitsAtQuit.long + 1, 'after the restart: raising a born-asleep Home tab loads it', { longWoke, hits: srv.hits('/long.html') - hitsAtQuit.long });
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
