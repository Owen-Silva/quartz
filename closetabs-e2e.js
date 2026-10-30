// closetabs-e2e.js -- `--close-tabs` / `--keep` from a second launch, end to end.
//
//   node closetabs-e2e.js
//
// One REAL Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen, watched) and, per
// step, a SECOND launch on the same test profile carrying only the switches, the way a tool runs
// it. The single-instance lock hands that line to the running copy through 'second-instance':
//   step 1  every tab under the local server's prefix closes except the --keep one and a pinned
//           one; a tab on another port stays; the toast says what closed and what stayed;
//           quartz.log gets the sentence; the second launch prints the hand-over and exits by
//           itself; no second window appears and no tab opens.
//   step 2  a refused pattern ("*") closes nothing; the toast and quartz.log say why.
//   step 3  a prefix covering every tab left on screen: the tab in front stays (never the
//           window's last tab), and nothing new is opened in its place.
// One summary line: "closetabs-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run, serve, html, sleep, APP } = require('./tests/e2e-kit');

// E2E_CDP lets a parallel lane run this on a port of its own.
const CDP = Number(process.env.E2E_CDP) || 9461;
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');

run('closetabs-e2e', async ({ check, launch, say, profileDir }) => {
  const page = (req, res, p) => {
    const m = /^\/([a-z0-9-]+)\/$/.exec(p);
    if (!m) return false;
    return html(res, `<!doctype html><title>${m[1]}</title><p>${m[1]}</p>`);
  };
  const srv = await serve(page);
  const elsewhere = await serve(page);
  const B = 'http://127.0.0.1:' + srv.port;
  const O = 'http://127.0.0.1:' + elsewhere.port;
  const profile = path.basename(profileDir).replace(/^browser-test-profile-/, '');
  const LOG = path.join(profileDir, 'quartz.log');

  /** A second launch on this profile: never a window of its own, so it only has to exit. */
  const secondLaunch = (args) => new Promise((resolve) => {
    const child = spawn(ELECTRON, ['.', '--test-profile', '--profile-name=' + profile, '--offscreen', '--show-inactive', ...args],
      { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } resolve({ code: null, out, timedOut: true }); }, 30000);
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, out, timedOut: false }); });
  });
  const logText = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch (e) { return ''; } };
  const waitLog = async (re, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = logText().match(re); if (m) return m[0]; await sleep(200); }
    return '';
  };

  const q = await launch({ cdp: CDP });
  const c = q.chrome;
  const chromePages = async () => (await q.targets()).filter((x) => x.type === 'page' && /index\.html/.test(String(x.url))).length;
  const urls = () => c.ev('tabs.map((t) => t.kind + " " + (t.url || "") + (t.pinned ? " [pinned]" : ""))');
  const toast = () => c.ev('(document.getElementById("settings-toast") || {}).textContent || ""');

  // ---- the strip: five tabs on the server, one of them pinned, and one on another port ----
  await c.ev(`(() => {
    for (const p of ['a', 'b', 'c', 'keep-me', 'pin']) createTab(${JSON.stringify(B)} + '/' + p + '/', { background: true });
    createTab(${JSON.stringify(O)} + '/other/', { background: true });
    setTabPinned(tabs.find((t) => t.url === ${JSON.stringify(B + '/pin/')}), true);
    return tabs.length;
  })()`);
  await c.waitFor(`tabs.filter((t) => t.kind === 'page' && String(t.url).startsWith(${JSON.stringify(B + '/')})).length === 5`, 15000);
  const before = await c.ev('tabs.length');
  say('strip before: ' + JSON.stringify(await urls()));

  // ---- step 1: close the server's tabs, keep one ----
  const r1 = await secondLaunch(['--close-tabs=' + B + '/', '--keep=' + B + '/keep-me/']);
  check(!r1.timedOut && r1.code === 0, 'step 1: the second launch exits by itself', r1);
  check(/\[close-tabs\] handed to the Quartz already running: close /.test(r1.out), 'step 1: the second launch prints the hand-over', r1.out);
  try {
    await c.waitFor(`tabs.length === ${before - 3}`, 10000);
  } catch (e) { /* judged below */ }
  const after1 = await urls();
  say('strip after step 1: ' + JSON.stringify(after1));
  // Sorted: pinning moved the pinned tab to the front of the strip.
  const left1 = after1.filter((u) => u.includes(B + '/')).sort();
  check(JSON.stringify(left1) === JSON.stringify(['page ' + B + '/keep-me/', 'page ' + B + '/pin/ [pinned]']),
    'step 1: a, b and c closed; the --keep tab and the pinned tab stayed', left1);
  check(after1.some((u) => u.includes(O + '/other/')), 'step 1: the tab on another port stayed', after1);
  check(after1.length === before - 3, 'step 1: exactly three tabs went and none was opened', { before, after: after1.length });
  check(await chromePages() === 1, 'step 1: still one window', await chromePages());
  const t1 = await c.waitFor('((document.getElementById("settings-toast") || {}).textContent || "").startsWith("Closed")', 5000).catch(() => false);
  check(/^Closed 3 tabs \(1 kept by --keep, 1 pinned\)$/.test(await toast()), 'step 1: the toast says what closed and what stayed', t1 ? await toast() : 'no toast');
  const l1 = await waitLog(/Closed 3 tabs starting with http:\/\/127\.0\.0\.1:\d+\/, asked for on the command line; left open: 1 kept by --keep, 1 pinned\./, 8000);
  check(!!l1, 'step 1: quartz.log has the sentence', l1 || logText().split('\n').slice(-5).join(' | '));

  // ---- step 2: a refused pattern ----
  const n2 = await c.ev('tabs.length');
  const r2 = await secondLaunch(['--close-tabs=*']);
  check(!r2.timedOut && r2.code === 0, 'step 2: the refused launch exits by itself', r2);
  check(/\[close-tabs\] refused: --close-tabs=\* is refused: wildcards are not supported/.test(r2.out), 'step 2: the second launch prints why', r2.out);
  const t2 = await c.waitFor('((document.getElementById("settings-toast") || {}).textContent || "").includes("wildcards")', 8000).catch(() => false);
  check(!!t2, 'step 2: the toast says why', await toast());
  check(await c.ev('tabs.length') === n2, 'step 2: nothing closed', { before: n2, after: await c.ev('tabs.length') });
  const l2 = await waitLog(/Refused to close tabs from the command line: --close-tabs=\* is refused: wildcards are not supported[^\n]*\./, 8000);
  check(!!l2, 'step 2: quartz.log says why', l2 || logText().split('\n').slice(-5).join(' | '));

  // ---- step 3: every tab on screen matches: the one in front stays ----
  // Leave only server tabs in the workspace, unpinned, with one in front.
  await c.ev(`(() => {
    for (const t of tabs.slice()) if (t.pinned) setTabPinned(t, false);
    for (const t of visibleTabs().slice()) if (!String(t.url).startsWith(${JSON.stringify(B + '/')})) closeTab(t.id);
    const front = tabs.find((t) => t.url === ${JSON.stringify(B + '/keep-me/')});
    if (front) activateTab(front.id);
    return visibleTabs().map((t) => t.url);
  })()`);
  const strip3 = await c.ev('visibleTabs().map((t) => t.url)');
  const front3 = await c.ev('(getActiveTab() || {}).url');
  say('strip before step 3: ' + JSON.stringify(strip3) + ' front ' + front3);
  const r3 = await secondLaunch(['--close-tabs=' + B + '/']);
  check(!r3.timedOut && r3.code === 0, 'step 3: the second launch exits by itself', r3);
  try { await c.waitFor('visibleTabs().length === 1', 10000); } catch (e) { /* judged below */ }
  const after3 = await c.ev('visibleTabs().map((t) => t.url)');
  check(after3.length === 1 && after3[0] === front3, 'step 3: the tab in front stayed as the last tab', { strip3, after3 });
  check(!after3.some((u) => !String(u).startsWith(B + '/')), 'step 3: no tab was opened in its place', after3);
  const t3 = await c.waitFor('((document.getElementById("settings-toast") || {}).textContent || "").includes("left as the last tab")', 5000).catch(() => false);
  check(!!t3, 'step 3: the toast says one was left as the last tab', await toast());
  check(await chromePages() === 1, 'step 3: still one window', await chromePages());

  await q.quit();
  srv.close();
  elsewhere.close();
});
