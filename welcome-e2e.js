// welcome-e2e.js -- the first-run welcome, end to end, in real off-screen Quartz test instances.
//
//   node welcome-e2e.js
//
// Boots (all on this harness's own temp profile, wiped between the "fresh" ones):
//   A  fresh profile + --first-run: the welcome is the tab in front; walked by KEYBOARD (Enter, Tab,
//      arrows, Home/End): look (live: the chrome flips as the radios move), search engine (the Brave
//      key note), default browser (the REAL register-default-browser.ps1 when Quartz.exe exists, its
//      plain failure when it does not), the tour, Start browsing. Screenshots of every step in dark
//      and light, at the window's size and at a narrow width. The flag says finished.
//   B  the same profile again: no welcome; the look and the engine stuck. Settings > About > Show
//      welcome again opens it; Skip setup closes it; the flag stays done.
//   C  fresh again, with a stand-in registration script that fails: the default step says why, in
//      words; Skip setup (keyboard) sets the flag; a restart shows no welcome.
//   D  an EXISTING profile (a session.json from "before") + --first-run: the welcome never appears,
//      not even for a frame; the flag says existing-profile with the evidence.
//   E  fresh, WITHOUT --first-run: test profiles never see it (every other harness boots as before).
//
// Shots go to $WELCOME_SHOTS, else suite-out/shots/welcome on CI, else %TEMP%/quartz-welcome-shots.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { run, Cdp, KEYS, sleep, APP } = require('./tests/e2e-kit');

const PORT = 9447;
const SHOTS = process.env.WELCOME_SHOTS
  || (process.env.CI ? path.join(APP, 'suite-out', 'shots', 'welcome') : path.join(os.tmpdir(), 'quartz-welcome-shots'));
const NARROW = { width: 560, height: 860 };
const TAB = { code: 'Tab', vk: 9 };
const END = { code: 'End', vk: 35 };
const HOME = { code: 'Home', vk: 36 };
const LEFT = { code: 'ArrowLeft', vk: 37 };
const RIGHT = { code: 'ArrowRight', vk: 39 };
const HAS_QUARTZ_EXE = fs.existsSync(path.join(APP, 'node_modules', 'electron', 'dist', 'Quartz.exe'));

run('welcome-e2e', async (k) => {
  const { check, launch, say, profileDir } = k;
  const flagFile = path.join(profileDir, 'first-run.json');
  const readFlag = () => { try { return JSON.parse(fs.readFileSync(flagFile, 'utf8')); } catch (e) { return null; } };
  const wipe = async () => {
    for (let i = 0; i < 10; i++) { try { fs.rmSync(profileDir, { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
  };
  const shots = [];
  const shot = async (cdp, name) => {
    try { shots.push(await cdp.shot(path.join(SHOTS, name + '.png'))); } catch (e) { say('shot ' + name + ' failed: ' + e.message); }
  };

  /** The welcome guest's own CDP target, connected, focus-emulated, and answered by the chrome. */
  async function guest(inst) {
    let t = null;
    for (let i = 0; i < 100 && !t; i++) {
      try { t = (await inst.targets()).find((x) => /welcome\.html/.test(String(x.url)) && x.webSocketDebuggerUrl); } catch (e) { /* not yet */ }
      if (!t) await sleep(150);
    }
    if (!t) throw new Error('no welcome.html target');
    const g = await new Cdp(t.webSocketDebuggerUrl).open();
    await g.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await g.waitFor('!!(window.__welcome && window.__welcome.answered())', 15000);
    return g;
  }
  const welcomeCount = (c) => c.ev('window.FirstRun ? FirstRun._debug().welcomeTabs.length : -1');
  const activeIsWelcome = (c) => c.ev('!!(getActiveTab() && FirstRun.isWelcomeUrl(getActiveTab().url))');
  const step = (g) => g.ev('window.__welcome.step()');
  const focused = (g) => g.ev('(() => { const a = document.activeElement; return a ? (a.id || a.getAttribute("data-mode") || a.getAttribute("data-id") || a.getAttribute("data-go") || a.textContent.trim()).slice(0, 40) : ""; })()');
  /** Tab until `want` (a focused() value) has the keyboard; at most `max` presses. */
  async function tabTo(g, want, max) {
    for (let i = 0; i < (max || 8); i++) {
      if ((await focused(g)) === want) return true;
      await g.key('Tab', TAB);
      await sleep(60);
    }
    return (await focused(g)) === want;
  }
  /** Watch the chrome for `ms`: the most welcome tabs seen at once. */
  async function watchNoWelcome(c, ms) {
    let most = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { most = Math.max(most, await welcomeCount(c).catch(() => 0)); await sleep(150); }
    return most;
  }
  async function narrowShot(g, name) {
    await g.send('Emulation.setDeviceMetricsOverride', { width: NARROW.width, height: NARROW.height, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    await shot(g, name);
    await g.send('Emulation.clearDeviceMetricsOverride');
    await sleep(150);
  }

  /* ================= A: a brand-new profile ================================================== */
  await wipe();
  say('boot A: fresh profile, --first-run');
  let a = await launch({ cdp: PORT, args: ['--first-run'] });
  await a.chrome.waitFor('window.FirstRun && FirstRun._debug().welcomeTabs.length === 1', 15000).catch(() => null);
  let dbg = await a.chrome.ev('FirstRun._debug()');
  check(dbg.decision && dbg.decision.show === true && dbg.decision.reason === 'new-profile', 'A: fresh profile -> main says show (new-profile)', dbg.decision);
  check(dbg.welcomeTabs.length === 1, 'A: exactly one welcome tab opened', dbg.welcomeTabs);
  check(await a.chrome.waitFor('!!(getActiveTab() && FirstRun.isWelcomeUrl(getActiveTab().url))', 8000).catch(() => false), 'A: the welcome is the tab in front');
  let flag = readFlag();
  check(flag && flag.state === 'pending', 'A: flag is pending while the welcome is open', flag);
  check(await a.chrome.ev('(() => { const t = tabs.find((x) => FirstRun.isWelcomeUrl(x.url)); return !!t && /Welcome/.test(String(t.chipEl && t.chipEl.textContent)); })()').catch(() => false), 'A: the tab chip says Welcome');
  check(await a.chrome.ev('document.getElementById("omnibox") ? document.getElementById("omnibox").value === "" : true'), 'A: the address bar shows no file:// path');

  let g = await guest(a);
  check((await step(g)) === 'welcome', 'A: starts on the hello step');
  check((await focused(g)) === 'next' || (await focused(g)) === 'Get started', 'A: Get started has the keyboard', await focused(g));
  check((await a.chrome.ev('QuartzTheme.mode()')) === 'dark', 'A: a fresh profile starts dark (Quartz default)');
  await shot(a.chrome, 'A1-hello-dark');

  // Hello -> Look, by Enter.
  await g.key('Enter', KEYS.Enter);
  check(await g.waitFor('window.__welcome.step() === "look"', 4000).catch(() => false), 'A: Enter -> the Look step');
  check((await focused(g)) === 'dark', 'A: the keyboard lands on the current look (Dark)', await focused(g));
  await shot(a.chrome, 'A2-look-dark');

  // Arrows move AND pick, and the whole chrome follows at once (the live preview).
  await g.key('ArrowLeft', LEFT);
  check(await a.chrome.waitFor('QuartzTheme.mode() === "light" && document.documentElement.getAttribute("data-theme") === "light"', 4000).catch(() => false), 'A: ArrowLeft picks Light; the chrome turns light now');
  check(await g.waitFor('document.documentElement.getAttribute("data-theme") === "light"', 4000).catch(() => false), 'A: the welcome page turns light with it');
  check((await g.ev('document.querySelector(\'[data-mode="light"]\').getAttribute("aria-checked")')) === 'true', 'A: Light reads as checked (aria-checked)');
  await shot(a.chrome, 'A3-look-light');
  await g.key('ArrowLeft', LEFT);
  check(await a.chrome.waitFor('QuartzTheme.mode() === "system"', 4000).catch(() => false), 'A: ArrowLeft again picks Match Windows (mode system)');
  const sysSub = await g.waitFor('(() => { const t = document.getElementById("system-sub").textContent; return /Windows is using|didn.t say/.test(t) ? t : ""; })()', 5000).catch(() => '');
  check(!!sysSub, 'A: Match Windows says what Windows answered', sysSub);
  await shot(a.chrome, 'A4-look-system');
  await g.key('ArrowRight', RIGHT);
  check(await a.chrome.waitFor('QuartzTheme.mode() === "light"', 4000).catch(() => false), 'A: ArrowRight goes back to Light');
  check((await a.chrome.ev('localStorage.getItem("themeMode")')) === 'light', 'A: the look is stored where Settings > Look keeps it (themeMode)');

  // Look -> Search, by Tab to Continue + Enter.
  check(await tabTo(g, 'next'), 'A: Tab reaches Continue on the Look step');
  await g.key('Enter', KEYS.Enter);
  check(await g.waitFor('window.__welcome.step() === "search"', 4000).catch(() => false), 'A: -> the Search step');
  const engines = await g.ev('Array.from(document.querySelectorAll(".wc-engine")).map((b) => b.getAttribute("data-id"))');
  const settingsEngines = await a.chrome.ev('Settings.engines().map((e) => e.id)');
  check(JSON.stringify(engines) === JSON.stringify(settingsEngines), 'A: the engine list is exactly what Settings supports', engines);
  check((await focused(g)) === 'google', 'A: the keyboard lands on the current engine (Google)', await focused(g));
  await g.key('ArrowDown', KEYS.ArrowDown);
  check(await a.chrome.waitFor('Settings.get("searchEngine") === "duckduckgo"', 4000).catch(() => false), 'A: ArrowDown picks DuckDuckGo (Settings.searchEngine)');
  check((await g.ev('document.getElementById("brave-note").hidden')) === true, 'A: no Brave note for a keyless engine');
  await g.key('End', END);
  check(await a.chrome.waitFor('Settings.get("searchEngine") === "brave-api"', 4000).catch(() => false), 'A: End picks Quartz results (Brave)');
  const braveText = await g.waitFor('(() => { const n = document.getElementById("brave-note"); return n.hidden ? "" : document.getElementById("brave-text").textContent; })()', 4000).catch(() => '');
  check(/API key/.test(braveText) && /Settings/.test(braveText), 'A: Quartz results explains the Brave key in plain words', braveText);
  await shot(a.chrome, 'A5-search-brave-light');
  await g.key('Home', HOME);
  await g.key('ArrowDown', KEYS.ArrowDown);
  check(await a.chrome.waitFor('Settings.get("searchEngine") === "duckduckgo"', 4000).catch(() => false), 'A: Home then ArrowDown -> DuckDuckGo again');
  await shot(a.chrome, 'A6-search-light');

  // Search -> Default browser.
  check(await tabTo(g, 'next'), 'A: Tab reaches Continue on the Search step');
  await g.key('Enter', KEYS.Enter);
  check(await g.waitFor('window.__welcome.step() === "default"', 4000).catch(() => false), 'A: -> the Default browser step');
  check((await focused(g)) === 'make-default', 'A: the keyboard lands on "Make Quartz the default"', await focused(g));
  check((await g.ev('document.getElementById("default-next").textContent')) === 'Not now', 'A: the way past it says Not now');
  await shot(a.chrome, 'A7-default-idle-light');
  await g.key('Enter', KEYS.Enter);
  const dstate = await g.waitFor('(() => { const s = document.getElementById("default-card").getAttribute("data-state"); return /settings-opened|registered|failed|confirmed/.test(s) ? s : ""; })()', 40000).catch(() => '');
  const dtext = await g.ev('document.getElementById("default-title").textContent + " | " + document.getElementById("default-text").textContent');
  say('default browser answered: ' + dstate + ' -- ' + dtext);
  if (HAS_QUARTZ_EXE) {
    check(dstate === 'settings-opened', 'A: the real script registered Quartz; Windows Settings step shown', dstate + ' ' + dtext);
    check((await g.ev('!document.getElementById("default-steps").hidden && /Set default/.test(document.getElementById("default-steps").textContent)')), 'A: it says, in words, to press Set default in Windows Settings');
    let reg = '';
    try { reg = execFileSync('reg', ['query', 'HKCU\\Software\\RegisteredApplications', '/v', 'Quartz'], { encoding: 'utf8' }); } catch (e) { reg = String(e.message); }
    check(/StartMenuInternet\\Quartz\\Capabilities/.test(reg), 'A: Windows really lists Quartz (HKCU RegisteredApplications)', reg.trim().split(/\r?\n/).pop());
    check((await g.ev('document.getElementById("default-next").textContent')) === 'Continue', 'A: after the hand-off the way on says Continue');
  } else {
    check(dstate === 'failed' && /Quartz\.exe/.test(dtext), 'A: no Quartz.exe here -> the step says so, plainly (never silent)', dstate + ' ' + dtext);
  }
  await shot(a.chrome, 'A8-default-' + (dstate || 'none') + '-light');

  // Default -> Tour.
  await g.ev('document.getElementById("default-next").focus(), 1');
  await g.key('Enter', KEYS.Enter);
  check(await g.waitFor('window.__welcome.step() === "tour"', 4000).catch(() => false), 'A: -> the tour');
  const cards = await g.ev('Array.from(document.querySelectorAll(".wc-feature-h")).map((h) => h.textContent)');
  check(cards.length >= 3 && cards.length <= 4, 'A: the tour is 3-4 cards', cards);
  check((await g.ev('document.getElementById("skip").hidden')) === true, 'A: no Skip on the last step');
  check((await focused(g)) === 'finish', 'A: the keyboard lands on Start browsing', await focused(g));

  // Every step, dark and light, wide (the whole window) and narrow (the page at 560 px).
  for (const theme of ['dark', 'light']) {
    await a.chrome.ev('QuartzTheme.setMode(' + JSON.stringify(theme) + ').then(() => 1)');
    await g.waitFor('document.documentElement.getAttribute("data-theme") === ' + JSON.stringify(theme), 4000).catch(() => null);
    for (const name of ['welcome', 'look', 'search', 'default', 'tour']) {
      await g.ev('window.__welcome.go(' + JSON.stringify(name) + ')');
      await sleep(450);
      await shot(a.chrome, 'S-' + name + '-' + theme + '-wide');
      await narrowShot(g, 'S-' + name + '-' + theme + '-narrow');
    }
  }
  // The narrowest a window gets: nothing may scroll sideways.
  await g.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 760, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const w360 = await g.ev('window.innerWidth');
  const scrollW = [];
  for (const name of ['welcome', 'look', 'search', 'default', 'tour']) {
    await g.ev('window.__welcome.go(' + JSON.stringify(name) + ')');
    await sleep(250);
    scrollW.push(name + ':' + (await g.ev('document.documentElement.scrollWidth - document.documentElement.clientWidth')));
  }
  await g.send('Emulation.clearDeviceMetricsOverride');
  check(w360 === 360, 'A: the narrow override reached the page (innerWidth 360)', w360);
  check(scrollW.every((x) => /:0$/.test(x)), 'A: nothing scrolls sideways even at 360 px', scrollW);
  // Back to what the walk chose.
  await a.chrome.ev('QuartzTheme.setMode("light").then(() => 1)');
  await g.ev('window.__welcome.go("tour")');
  await sleep(300);
  await g.ev('document.getElementById("finish").focus(), 1');
  await g.key('Enter', KEYS.Enter);
  check(await a.chrome.waitFor('FirstRun._debug().welcomeTabs.length === 0', 6000).catch(() => false), 'A: Start browsing closes the welcome');
  check(await a.chrome.waitFor('!!(getActiveTab() && isNewTabUrl(getActiveTab().url))', 6000).catch(() => false), 'A: Home is the tab in front afterwards');
  flag = readFlag();
  check(flag && flag.state === 'done' && flag.how === 'finished', 'A: the flag says done / finished', flag);
  g.close();
  await a.quit();

  /* ================= B: the same profile again ============================================== */
  say('boot B: same profile, --first-run again');
  const b = await launch({ cdp: PORT, args: ['--first-run'] });
  const mostB = await watchNoWelcome(b.chrome, 4000);
  check(mostB === 0, 'B: a finished profile never shows the welcome again', mostB);
  dbg = await b.chrome.ev('FirstRun._debug()');
  check(dbg.decision && dbg.decision.reason === 'done' && dbg.decision.show === false, 'B: main says done', dbg.decision);
  check((await b.chrome.ev('QuartzTheme.mode()')) === 'light' && (await b.chrome.ev('document.documentElement.getAttribute("data-theme")')) === 'light', 'B: the look chosen in the welcome stuck (light)');
  check((await b.chrome.ev('Settings.get("searchEngine")')) === 'duckduckgo', 'B: the engine chosen in the welcome stuck (DuckDuckGo)');
  // Settings > About > Show welcome again.
  await b.chrome.ev('Settings.open("About"), 1');
  const btn = await b.chrome.waitFor('!!document.querySelector(\'[data-action="show-welcome"]\')', 5000).catch(() => false);
  check(btn, 'B: Settings > About has "Show welcome again"');
  await b.chrome.ev('document.querySelector(\'[data-action="show-welcome"]\').click(), 1');
  check(await b.chrome.waitFor('FirstRun._debug().welcomeTabs.length === 1 && !!(getActiveTab() && FirstRun.isWelcomeUrl(getActiveTab().url))', 6000).catch(() => false), 'B: it opens the welcome, in front');
  check((await b.chrome.ev('Settings.isOpen()')) === false, 'B: Settings steps aside for it');
  g = await guest(b);
  check((await g.ev('window.__welcome.state().reopened')) === true, 'B: the page knows it was re-opened');
  check((await g.ev('document.querySelector(\'[data-mode="light"]\').getAttribute("aria-checked")')) === 'true', 'B: it shows the current look (Light) as picked');
  await shot(b.chrome, 'B1-reopened-light');
  await g.ev('document.getElementById("skip").click(), 1');
  check(await b.chrome.waitFor('FirstRun._debug().welcomeTabs.length === 0', 6000).catch(() => false), 'B: Skip setup closes the re-opened welcome');
  flag = readFlag();
  check(flag && flag.state === 'done', 'B: the flag stays done', flag);
  g.close();
  await b.quit();

  /* ================= C: fresh, the registration fails, skip =================================== */
  await wipe();
  const failScript = path.join(os.tmpdir(), 'welcome-e2e-fail-' + process.pid + '.ps1');
  fs.writeFileSync(failScript, "Write-Output 'pretending to register'\r\n[Console]::Error.WriteLine('simulated: the registry refused the write')\r\nexit 1\r\n");
  say('boot C: fresh profile, a registration script that fails');
  const c = await launch({ cdp: PORT, args: ['--first-run'], env: { QUARTZ_TEST_DEFAULT_SCRIPT: failScript } });
  check(await c.chrome.waitFor('FirstRun._debug().welcomeTabs.length === 1', 15000).catch(() => false), 'C: a wiped profile shows the welcome again');
  g = await guest(c);
  await g.ev('window.__welcome.go("default")');
  await sleep(300);
  await g.ev('document.getElementById("make-default").focus(), 1');
  await g.key('Enter', KEYS.Enter);
  const cState = await g.waitFor('document.getElementById("default-card").getAttribute("data-state") === "failed"', 20000).catch(() => false);
  const cText = await g.ev('document.getElementById("default-text").textContent');
  check(cState && /simulated: the registry refused the write/.test(cText), 'C: a failed registration shows Windows\' own reason', cText);
  check((await g.ev('document.getElementById("make-default").textContent')) === 'Try again', 'C: and offers Try again');
  await shot(c.chrome, 'C1-default-failed-dark');
  await narrowShot(g, 'C1-default-failed-dark-narrow');
  // Skip setup by keyboard: Shift+Tab back up to it is long; focus it the way a Tab would land.
  await g.ev('document.getElementById("skip").focus(), 1');
  await g.key('Enter', KEYS.Enter);
  check(await c.chrome.waitFor('FirstRun._debug().welcomeTabs.length === 0', 6000).catch(() => false), 'C: Skip setup (Enter) closes the welcome');
  flag = readFlag();
  check(flag && flag.state === 'done' && flag.how === 'skipped', 'C: skip sets the flag (done / skipped)', flag);
  check((await c.chrome.ev('QuartzTheme.mode()')) === 'dark' && (await c.chrome.ev('Settings.get("searchEngine")')) === 'google', 'C: skipping changes nothing it did not ask about (dark, Google)');
  g.close();
  await c.quit();
  try { fs.rmSync(failScript, { force: true }); } catch (e) { /* tmp */ }
  say('boot C2: the skipped profile again');
  const c2 = await launch({ cdp: PORT, args: ['--first-run'] });
  check((await watchNoWelcome(c2.chrome, 4000)) === 0, 'C2: a skipped profile never shows the welcome again');
  await c2.quit();

  /* ================= D: an existing profile ================================================= */
  await wipe();
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'session.json'), JSON.stringify({ savedAt: Date.now(), active: 0, tabs: [{ url: 'http://127.0.0.1:9/existing-profile' }] }));
  say('boot D: an existing profile (session.json from before) + --first-run');
  const d = await launch({ cdp: PORT, args: ['--first-run'] });
  const mostD = await watchNoWelcome(d.chrome, 5000);
  check(mostD === 0, 'D: an existing profile NEVER shows the welcome (watched 5 s from the first frame)', mostD);
  dbg = await d.chrome.ev('FirstRun._debug()');
  check(dbg.decision && dbg.decision.reason === 'existing-profile' && dbg.decision.show === false, 'D: main says existing-profile', dbg.decision);
  flag = readFlag();
  check(flag && flag.state === 'done' && flag.how === 'existing-profile' && Array.isArray(flag.evidence) && flag.evidence.includes('session.json'), 'D: the flag is set for good, naming the evidence', flag);
  await d.quit();
  const d2 = await launch({ cdp: PORT, args: ['--first-run'] });
  check((await watchNoWelcome(d2.chrome, 3000)) === 0, 'D2: and on every later start');
  await d2.quit();

  /* ================= E: a test profile without --first-run ================================== */
  await wipe();
  say('boot E: fresh test profile, no --first-run');
  const e = await launch({ cdp: PORT });
  check((await watchNoWelcome(e.chrome, 4000)) === 0, 'E: other harnesses never see the welcome');
  dbg = await e.chrome.ev('FirstRun._debug()');
  check(dbg.decision && dbg.decision.reason === 'test-profile', 'E: main says test-profile', dbg.decision);
  check(readFlag() === null, 'E: and writes no flag');
  await e.quit();

  say('shots: ' + shots.length + ' in ' + SHOTS);
});
