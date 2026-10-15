// sessions-e2e.js -- tabs open, close and come back across a restart (session.json), end to end.
//
//   node sessions-e2e.js
//
// Three boots of a REAL Quartz test instance on ONE temp profile (tests/e2e-kit.js: --test-profile,
// off-screen, watched on every boot), against local pages:
//   boot 1  open four tabs, pin one, navigate one, close one; Ctrl+Shift+T brings the closed one
//           back and it is closed again; the durable copy (session.json) says exactly that; the
//           window is closed the way a user closes it.
//   boot 2  the strip comes back: same tabs, same order, the pin, the navigated url (not the old
//           one), the closed tab NOT back, the tab that was in front in front and loaded, the
//           background tab loads when raised. Then a fifth tab is opened and Quartz is KILLED
//           (taskkill /F) once session.json has it: no clean shutdown, no beforeunload.
//   boot 3  the killed run's strip comes back, the fifth tab included.
// One summary line: "sessions-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const { run, serve, html, sleep } = require('./tests/e2e-kit');

const CDP = 9431;

run('sessions-e2e', async ({ check, launch, say, profileDir }) => {
  const srv = await serve((req, res, p) => {
    const m = /^\/([a-z0-9]+)\.html$/.exec(p);
    if (!m) return false;
    return html(res, `<!doctype html><title>Page ${m[1].toUpperCase()}</title><p>${m[1]}</p>`);
  });
  const B = 'http://127.0.0.1:' + srv.port;
  const SESSION = path.join(profileDir, 'session.json');
  const ours = (u) => typeof u === 'string' && u.indexOf(B + '/') === 0;
  const short = (u) => String(u).slice(B.length);
  const readFile = () => { try { return JSON.parse(fs.readFileSync(SESSION, 'utf8')); } catch (e) { return null; } };
  /** session.json's own-origin entries, as short paths with flags, plus the url of its active entry. */
  const fileView = () => {
    const s = readFile();
    if (!s || !Array.isArray(s.tabs)) return null;
    const entries = s.tabs.filter((t) => ours(t.url)).map((t) => short(t.url) + (t.pinned ? ' [pinned]' : ''));
    const act = s.tabs[s.active];
    return { entries: entries.join(', '), active: act && ours(act.url) ? short(act.url) : String(act && act.url) };
  };
  async function waitFile(pred, ms) {
    const t0 = Date.now(); let v = null;
    while (Date.now() - t0 < ms) { v = fileView(); if (v && pred(v)) return v; await sleep(200); }
    return v;
  }
  /** The strip as the chrome holds it: own-origin page tabs in strip order. */
  const STRIP = `tabs.filter((t) => t.kind === 'page' && String(readCurrentUrl(t) || t.url).indexOf(${JSON.stringify(B + '/')}) === 0)
    .map((t) => ({ id: t.id, url: String(readCurrentUrl(t) || t.url).slice(${B.length}), pinned: !!t.pinned, asleep: !!t.asleep, title: t.title || '', active: t.id === activeTabId }))`;

  // ---- boot 1 -------------------------------------------------------------------------------
  // reg.exe (the Windows apps-mode read) answers 5 s late, as on a runner busy at boot: Look Sync's
  // hello must not wait for it (the window gives up after 4 s and says 'the browser did not answer').
  let q = await launch({ cdp: CDP, env: { QUARTZ_TEST_APPS_MODE_DELAY_MS: '5000' } });
  let c = q.chrome;
  check(fileView() === null || fileView().entries === '', 'a fresh profile has no stored tabs of ours', fileView());
  // A fresh profile has no Mantle record, so the background falls back to Windows' wallpaper and
  // says why, in one sentence. It used to repeat itself: "...Mantle hasn't shared one (Mantle
  // hasn't shared a desktop wallpaper yet)".
  const WANT_WHY = "Following Windows' wallpaper: Mantle hasn't shared one yet";
  const why = await c.waitFor("(() => { const d = window.LookSync && window.LookSync.desktop(); return d && d.state === 'fallback' ? String(d.reason) : ''; })()", 10000).catch((e) => e.message);
  check(why === WANT_WHY, 'fresh profile: the wallpaper fallback reason is one plain sentence', why);
  const toast = await c.waitFor("(() => { for (const n of document.querySelectorAll('body *')) { if (getComputedStyle(n).position === 'fixed' && /^Following Windows/.test(n.textContent || '')) return n.textContent.trim(); } return ''; })()", 6000).catch(() => '');
  if (toast) check(toast.replace(/[.\s]+$/, '') === WANT_WHY && !/\(.*\)/.test(toast), 'fresh profile: the toast says it once, no reason repeated in brackets', toast);
  else say('no wallpaper toast seen within 6 s (only the reason was checked)');
  // A fresh profile's look-sync folder is new, not removed: never a "Problem". On a runner (TEMP is
  // an 8.3 short path) the watcher read Quartz's own first write as "folder was removed".
  const lsFirst = await c.waitFor("(() => { const s = window.LookSync && window.LookSync.status(); return s && s.state !== 'starting' ? s.state + ': ' + s.reason : ''; })()", 10000).catch((e) => e.message);
  let lsProblem = /^error/.test(lsFirst) ? lsFirst : '';
  for (const t0 = Date.now(); !lsProblem && Date.now() - t0 < 3000;) {
    lsProblem = await c.ev("(() => { const s = window.LookSync.status(); return s.state === 'error' ? s.reason : ''; })()");
    if (!lsProblem) await sleep(100);
  }
  check(!lsProblem, 'fresh profile: Look Sync is never a Problem (3 s after it settles)', lsProblem || lsFirst);
  const open = async (name, file) => {
    const id = await c.ev(`(() => { window.__t = window.__t || {}; const t = createTab(${JSON.stringify(B + '/' + file)}); window.__t[${JSON.stringify(name)}] = t; activateTab(t.id); return t.id; })()`);
    await c.waitFor(`window.__t[${JSON.stringify(name)}].ready === true`, 15000);
    return id;
  };
  const T = (name) => `window.__t[${JSON.stringify(name)}]`;
  await open('a', 'a.html');
  await open('b', 'b.html');
  await open('c', 'c.html');
  await open('d', 'd.html');
  await c.ev(`setTabPinned(${T('a')}, true), 1`);
  await c.ev(`(activateTab(${T('b')}.id), ${T('b')}.viewEl.loadURL(${JSON.stringify(B + '/b2.html')}).catch(() => 0), 1)`);
  await c.waitFor(`/\\/b2\\.html$/.test(readCurrentUrl(${T('b')}) || '') && ${T('b')}.title === 'Page B2'`, 10000);
  await c.ev(`closeTab(${T('c')}.id), 1`);
  let strip = await c.ev(STRIP);
  check(strip.map((t) => t.url).join(' ') === '/a.html /b2.html /d.html', 'boot 1: the strip after pin, navigate and close', strip.map((t) => t.url));
  check(strip[0] && strip[0].pinned === true, 'boot 1: the pinned tab sits first', strip[0]);

  // Ctrl+Shift+T: the closed tab comes back, in front, on its url.
  await c.ev('reopenClosedTab(), 1');
  const reopened = await c.waitFor(`(() => { const t = getActiveTab(); return t && /\\/c\\.html$/.test(readCurrentUrl(t) || t.url) && t.ready ? t.id : 0; })()`, 10000).catch((e) => e.message);
  check(typeof reopened === 'number' && reopened > 0, 'reopen closed tab: c.html is back, in front, loaded', reopened);
  if (typeof reopened === 'number') await c.ev(`closeTab(${reopened}), 1`);
  await c.ev(`activateTab(${T('b')}.id), 1`);

  let fv = await waitFile((v) => v.entries === '/a.html [pinned], /b2.html, /d.html' && v.active === '/b2.html', 6000);
  check(fv && fv.entries === '/a.html [pinned], /b2.html, /d.html', 'session.json (written while running): a pinned, b at its NEW url, d; c is gone', fv);
  check(fv && fv.active === '/b2.html', 'session.json: the tab in front is the active entry', fv);
  check(!fs.existsSync(SESSION + '.tmp'), 'no half-written session.json.tmp left behind');

  check(await q.quit(), 'boot 1: closing the window quit Quartz');
  fv = fileView();
  check(fv && fv.entries === '/a.html [pinned], /b2.html, /d.html' && fv.active === '/b2.html', 'session.json after a clean quit: unchanged', fv);

  // ---- boot 2 -------------------------------------------------------------------------------
  const b2Hits = srv.hits('/b2.html');
  q = await launch({ cdp: CDP });
  c = q.chrome;
  strip = await c.waitFor(`(() => { const s = ${STRIP}; return s.length >= 3 ? s : null; })()`, 15000).catch(() => null);
  strip = strip || await c.ev(STRIP);
  check(strip.map((t) => t.url).join(' ') === '/a.html /b2.html /d.html', 'boot 2: the same tabs, in the same order (b at its new url, c not back)', strip.map((t) => t.url));
  check(strip[0] && strip[0].pinned, 'boot 2: the pin came back', strip[0]);
  const front = strip.find((t) => t.active);
  check(front && front.url === '/b2.html', 'boot 2: the tab in front is the one that was in front', front || strip);
  const loaded = await c.waitFor(`(() => { const t = getActiveTab(); return t && t.ready && t.title === 'Page B2'; })()`, 15000).catch((e) => e.message);
  check(loaded === true, 'boot 2: the front tab loaded its page (title "Page B2")', loaded);
  check(srv.hits('/b2.html') > b2Hits, 'boot 2: the front tab really fetched its page again', srv.hits('/b2.html') - b2Hits);
  const titleA = strip[0] ? strip[0].title : '';
  check(titleA === 'Page A', 'boot 2: a background tab carries its title (stored or loaded)', titleA);
  const d = strip.find((t) => t.url === '/d.html');
  await c.ev(`activateTab(${d ? d.id : -1}), 1`);
  const dOk = await c.waitFor(`(() => { const t = getActiveTab(); return t && t.id === ${d ? d.id : -1} && t.ready && !t.asleep && /\\/d\\.html$/.test(readCurrentUrl(t) || '') && t.title === 'Page D'; })()`, 15000).catch((e) => e.message);
  check(dOk === true, 'boot 2: a background tab loads its page when raised', dOk);

  // A kill, not a quit: only what is already on disk survives.
  await c.ev(`(() => { const t = createTab(${JSON.stringify(B + '/e.html')}); activateTab(t.id); return 1; })()`);
  await c.waitFor(`(() => { const t = getActiveTab(); return t && t.ready && t.title === 'Page E'; })()`, 15000);
  fv = await waitFile((v) => /\/e\.html/.test(v.entries), 6000);
  check(fv && fv.entries === '/a.html [pinned], /b2.html, /d.html, /e.html', 'boot 2: the new tab reached session.json within seconds', fv);
  check(await q.kill(), 'boot 2: killed (taskkill /F, no clean shutdown)');

  // ---- boot 3 -------------------------------------------------------------------------------
  // main answers the session read 1 s late, as a main busy at boot does (seen on a runner after a
  // kill): boot must still wait for session.json, the copy that survived the kill.
  q = await launch({ cdp: CDP, env: { QUARTZ_TEST_SESSION_READ_DELAY_MS: '1000' } });
  c = q.chrome;
  strip = await c.waitFor(`(() => { const s = ${STRIP}; return s.length >= 4 ? s : null; })()`, 15000).catch(() => null);
  strip = strip || await c.ev(STRIP);
  check(strip.map((t) => t.url).join(' ') === '/a.html /b2.html /d.html /e.html', 'boot 3 (after a kill): every tab came back, the last one opened included', strip.map((t) => t.url));
  const front3 = strip.find((t) => t.active);
  check(front3 && front3.url === '/e.html', 'boot 3: the tab in front at the kill is in front', front3 || strip);
  check(strip[0] && strip[0].pinned, 'boot 3: the pin survived the kill too', strip[0]);
  const e3 = await c.waitFor(`(() => { const t = getActiveTab(); return t && t.ready && t.title === 'Page E'; })()`, 15000).catch((e) => e.message);
  check(e3 === true, 'boot 3: the front tab loaded', e3);
  check(await q.quit(), 'boot 3: closing the window quit Quartz');
  say('session.json at the end: ' + JSON.stringify(fileView()));
  srv.close();
});
