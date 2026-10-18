try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine (a cloud runner): no cap needed */ }   // first: one capped browser at a time (The user, 2026-09-17)
// lumen-btn-e2e.js -- the toolbar's Lumen button (#lumen, index.html + app.js updateLumenBtn) end to
// end, against a REAL hidden Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen,
// watched from before launch). Lumen reads a LOCAL mock of every service (tests/watch-mock.js) and
// every other host name resolves to nothing, so the run makes no real network call at all.
//
//   node lumen-btn-e2e.js [--cdp 9811] [--shots <dir>]
//
// Checks: the button is in the nav row, directly left of the shield, the same 32 px box and gap as
// its neighbours, its tooltip and label; a real click opens Lumen; a second click from another tab
// brings the SAME Lumen tab to the front (the tab count is unchanged, one Lumen tab); the lit state
// follows the tab in front (class, aria-current, the accent) and goes out off Lumen; Tab reaches it
// with a focus ring; Enter and Space open Lumen; light and dark, every Look palette: grey at rest
// like the shield, the accent only when lit. --shots writes toolbar-lumen-<w>x<h>-<theme>-<state>.png
// (the toolbar's right end at 1x) for 1280x800, 1536x800 and 1920x1000.
// Kills ONLY the process it started and deletes its temp profile. One summary line:
// "lumen-btn-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9811'));
const SHOTS = opt('shots', '');
const TAG = 'quartz-lumenbtn-e2e-' + process.pid;
// Nothing but this machine resolves: the mock's 127.0.0.1 servers are all Lumen can reach.
const NO_NET = ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'];
const PALETTES = ['aurora', 'ember', 'forest', 'ocean', 'midnight', 'mono'];
const SIZES = [{ w: 1280, h: 800 }, { w: 1536, h: 800 }, { w: 1920, h: 1000 }];

function mockEnv(mock) {
  return {
    QUARTZ_WATCH_BOOT_GRACE_MS: '0',
    QUARTZ_WATCH_REBASE: JSON.stringify(mock.rebase),
    QUARTZ_WATCH_OPEN_STUB: path.join(os.tmpdir(), TAG + '-open.txt'),
    QUARTZ_EDGE_STUB: path.join(os.tmpdir(), TAG + '-edge.txt'),
    QUARTZ_WATCH_MIN_FREE_GB: '0',
    QUARTZ_WATCH_GAME_FILE: path.join(os.tmpdir(), TAG + '-game.flag'),
    QUARTZ_TEST_MIN_FREE_GB: '0',
  };
}

// The chrome's view of the button and the tabs, in one evaluate.
const STATE = `(() => {
  const b = document.getElementById('lumen');
  const front = getActiveTab();
  const lumenTabs = tabs.filter((t) => t && t.kind === 'page' && isWatchUrl(t.url));
  return {
    exists: !!b, tabCount: tabs.length, lumenTabs: lumenTabs.map((t) => t.id),
    frontId: front ? front.id : null, frontIsLumen: !!(front && isWatchUrl(front.url)),
    active: !!(b && b.classList.contains('is-active')), current: b ? b.getAttribute('aria-current') : null,
    focused: !!(b && document.activeElement === b), focusVisible: !!(b && b.matches(':focus-visible')),
  };
})()`;

/** A real key press on the focused element: keyDown carries the text, so a button's Enter fires. */
async function press(chrome, key, code, vk, text) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 };
  await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: text ? 'keyDown' : 'rawKeyDown' }, text ? { text, unmodifiedText: text } : {}, base));
  await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}

async function clickAt(chrome, x, y) {
  await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

run('lumen-btn-e2e', async ({ check, launch, say }) => {
  const mock = await Mock.start({ log: () => {} });
  try {
    const q = await launch({ cdp: CDP_PORT, args: NO_NET, env: mockEnv(mock) });
    const chrome = q.chrome;
    const st = () => chrome.ev(STATE);
    const rect = async (id) => chrome.ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; })()`);
    const centre = async (id) => { const r = await rect(id); return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) }; };
    const homeId = await chrome.ev('getActiveTab().id');
    await chrome.waitFor('!!document.getElementById("shield") && !!document.getElementById("settings")', 15000);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(300);

    /* ---- the button, in its place ---- */
    const s0 = await st();
    check(s0.exists, 'the Lumen button (#lumen) is in the chrome');
    const place = await chrome.ev(`(() => { const b = document.getElementById('lumen'); const nav = document.querySelector('.navrow');
      return { inNav: !!b && b.parentNode === nav, next: b && b.nextElementSibling ? b.nextElementSibling.id : null,
        order: Array.from(nav.children).filter((e) => !e.hidden && e.getBoundingClientRect().width > 0).map((e) => e.id || e.tagName),
        title: b.title, aria: b.getAttribute('aria-label'), type: b.type, tag: b.tagName, cls: b.className,
        svg: !!b.querySelector('svg.lumen-mark'), img: !!b.querySelector('img') }; })()`);
    check(place.inNav && place.next === 'shield', 'it sits in the nav row, directly left of the shield', place.order.join(' '));
    check(place.title === 'Lumen (Ctrl+Alt+W)' && place.aria === 'Lumen (Ctrl+Alt+W)', 'tooltip and aria-label: "Lumen (Ctrl+Alt+W)"', place.title + ' | ' + place.aria);
    check(place.tag === 'BUTTON' && place.type === 'button' && /\biconbtn\b/.test(place.cls), 'a native button with the .iconbtn recipe (shape, hover, press, ring)', place.cls);
    check(place.svg && !place.img, 'the glyph is the line SVG mark, not the full-colour logo');
    const rl = await rect('lumen'), rs = await rect('shield'), rt = await rect('theme'), rg = await rect('settings');
    check(rl && rs && rl.w === rs.w && rl.h === rs.h && rl.w === 32 && rl.h === 32 && rl.y === rs.y, 'same 32x32 box and baseline as the shield', JSON.stringify({ rl, rs }));
    const gapL = Math.round((rs.x - rl.r) * 100) / 100, gapN = Math.round((rg.x - rt.r) * 100) / 100;
    check(gapL === gapN, 'same spacing to the shield as the theme has to the gear (' + gapL + ' px)', gapL + ' vs ' + gapN);
    const ink = await chrome.ev(`(() => { const r = document.querySelector('#lumen .lumen-mark').getBoundingClientRect(); const b = document.getElementById('lumen').getBoundingClientRect(); return { w: r.width, h: r.height, dx: (r.left + r.width / 2) - (b.left + b.width / 2), dy: (r.top + r.height / 2) - (b.top + b.height / 2) }; })()`);
    check(ink.w === 12 && ink.h === 12 && Math.abs(ink.dx) < 0.51 && Math.abs(ink.dy) < 0.51, 'the mark is 12 px (the font glyphs\' size) and centred in the box', ink);
    check(!s0.active && s0.current === null && !s0.frontIsLumen, 'at rest on Home: not lit, no aria-current', s0);

    /* ---- click opens Lumen ---- */
    const n0 = s0.tabCount;
    let c = await centre('lumen');
    await clickAt(chrome, c.x, c.y);
    await chrome.waitFor('(() => { const t = getActiveTab(); return !!(t && isWatchUrl(t.url)); })()', 15000).catch(() => null);
    const s1 = await st();
    check(s1.frontIsLumen && s1.tabCount === n0 + 1 && s1.lumenTabs.length === 1, 'a click opens Lumen in a new tab, in front (' + n0 + ' -> ' + s1.tabCount + ' tabs)', s1);
    await sleep(150);
    const s1b = await st();
    check(s1b.active && s1b.current === 'true', 'lit while Lumen is the tab in front (.is-active, aria-current="true")', s1b);
    const lumenId = s1.lumenTabs[0];

    /* ---- off Lumen, the light goes out ---- */
    await chrome.ev('activateTab(' + JSON.stringify(homeId) + '), 1');
    await sleep(250);
    const s2 = await st();
    check(!s2.frontIsLumen && !s2.active && s2.current === null, 'another tab in front: not lit', s2);

    /* ---- a second click focuses the SAME Lumen tab ---- */
    c = await centre('lumen');
    await clickAt(chrome, c.x, c.y);
    await sleep(500);
    const s3 = await st();
    check(s3.frontId === lumenId && s3.tabCount === s1.tabCount && s3.lumenTabs.length === 1, 'a second click from another tab brings the SAME Lumen tab to the front (still ' + s3.tabCount + ' tabs, one Lumen)', s3);
    check(s3.active, 'lit again', s3);
    // clicking it while Lumen is already in front changes nothing
    await clickAt(chrome, c.x, c.y);
    await sleep(400);
    const s3b = await st();
    check(s3b.frontId === lumenId && s3b.tabCount === s1.tabCount && s3b.active, 'a click while Lumen is in front: same tab, no new one', s3b);

    /* ---- the light follows the tab in front: a second ordinary tab, and navigating in place ---- */
    await chrome.ev('createTab(HOME_URL), 1');
    await sleep(400);
    const s4 = await st();
    check(!s4.active && !s4.frontIsLumen, 'a new tab in front: not lit', s4);
    await chrome.ev('activateTab(' + JSON.stringify(lumenId) + '), 1');
    await sleep(250);
    check((await st()).active, 'switched back to Lumen (not by the button): lit');
    await chrome.ev('activateTab(' + JSON.stringify(homeId) + '), 1');
    await sleep(250);

    /* ---- keyboard: Tab reaches it with a ring; Enter and Space open the same tab ---- */
    const before = await st();
    await chrome.ev('document.getElementById("omnibox").focus(), 1');
    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      await press(chrome, 'Tab', 'Tab', 9);
      await sleep(80);
      reached = (await st()).focused;
    }
    const sk = await st();
    check(reached && sk.focusVisible, 'Tab from the address bar reaches the button, with the focus ring (:focus-visible)', sk);
    const ring = await chrome.ev('getComputedStyle(document.getElementById("lumen")).boxShadow');
    check(ring && ring !== 'none', 'the focus ring is drawn (box-shadow)', ring);
    if (!reached) await chrome.ev('document.getElementById("lumen").focus(), 1');
    await press(chrome, 'Enter', 'Enter', 13, '\r');
    await sleep(500);
    const s5 = await st();
    check(s5.frontId === lumenId && s5.tabCount === before.tabCount, 'Enter on the focused button: the same Lumen tab in front, no new tab', s5);
    await chrome.ev('activateTab(' + JSON.stringify(homeId) + '), 1');
    await sleep(250);
    await chrome.ev('document.getElementById("lumen").focus(), 1');
    await press(chrome, ' ', 'Space', 32, ' ');
    await sleep(500);
    const s6 = await st();
    check(s6.frontId === lumenId && s6.tabCount === before.tabCount && s6.active, 'Space on the focused button: the same Lumen tab in front, lit', s6);

    /* ---- Ctrl+Alt+W and the button agree: still one Lumen tab ---- */
    await chrome.ev('activateTab(' + JSON.stringify(homeId) + '), 1');
    await sleep(200);
    await chrome.ev('document.body.focus(), 1');
    await chrome.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, modifiers: 3 });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, modifiers: 3 });
    await sleep(500);
    const s7 = await st();
    check(s7.frontId === lumenId && s7.lumenTabs.length === 1 && s7.active, 'Ctrl+Alt+W lands on the same tab and the button lights', s7);

    /* ---- colours: grey like the shield at rest, the accent only when lit; every theme and palette ---- */
    await chrome.ev('document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1');
    // the pointer parked on the address bar (a chrome element, so the button's :hover really ends), and
    // no colour transition while reading: the computed colour is the state's own, not a frame of the fade
    const park = async () => { const o = await centre('omnibox'); await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: o.x, y: o.y }); };
    await park();
    await chrome.ev('(() => { const st = document.createElement("style"); st.id = "e2e-notrans"; st.textContent = "#lumen, #lumen * { transition: none !important; }"; document.head.appendChild(st); return 1; })()');
    const colours = `(() => { const cs = (id) => getComputedStyle(document.getElementById(id)).color;
      const probe = document.createElement('span'); probe.style.color = 'var(--accent)'; document.body.appendChild(probe);
      const accent = getComputedStyle(probe).color; probe.remove();
      return { lumen: cs('lumen'), shield: cs('shield'), theme: cs('theme'), accent, stroke: getComputedStyle(document.querySelector('#lumen .lumen-mark circle')).stroke }; })()`;
    const looks = [];
    for (const theme of ['light', 'dark']) {
      for (const palette of PALETTES) {
        await chrome.ev('setTheme(' + JSON.stringify(theme) + '), Settings.set({ palette: ' + JSON.stringify(palette) + ' }), 1');
        await sleep(200);
        await chrome.ev('activateTab(' + JSON.stringify(lumenId) + '), 1');
        await sleep(200);
        await chrome.waitFor('document.getElementById("lumen").classList.contains("is-active")', 3000).catch(() => 0);
        const lit = await chrome.ev(colours);
        await chrome.ev('activateTab(' + JSON.stringify(homeId) + '), 1');
        await sleep(200);
        await chrome.waitFor('!document.getElementById("lumen").classList.contains("is-active")', 3000).catch(() => 0);
        const rest = await chrome.ev(colours);
        const ok = lit.lumen === lit.accent && lit.stroke === lit.accent && rest.lumen === rest.theme && rest.lumen !== rest.accent;
        looks.push(theme + '/' + palette + (ok ? '' : ' BAD ' + JSON.stringify({ lit, rest })));
        check(ok, theme + ' / ' + palette + ': grey at rest like the moon (' + rest.lumen + '), the accent when lit (' + lit.lumen + ')', ok ? undefined : { lit, rest });
      }
    }
    await chrome.ev('Settings.set({ palette: "aurora" }), document.getElementById("e2e-notrans").remove(), 1');

    /* ---- shots: the toolbar's right end, 1x ---- */
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      for (const size of SIZES) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false });
        await sleep(300);
        for (const theme of ['light', 'dark']) {
          await chrome.ev('setTheme(' + JSON.stringify(theme) + '), 1');
          for (const state of ['idle', 'active']) {
            await chrome.ev('activateTab(' + JSON.stringify(state === 'active' ? lumenId : homeId) + '), 1');
            await chrome.ev('document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1');
            await park();
            await sleep(450);
            const nav = await chrome.ev('(() => { const r = document.querySelector(".navrow").getBoundingClientRect(); const l = document.getElementById("lumen").getBoundingClientRect(); return { x: Math.max(0, Math.floor(l.left - 200)), y: Math.floor(r.top), w: Math.ceil(r.right - Math.max(0, Math.floor(l.left - 200))), h: Math.ceil(r.height) }; })()');
            const m = await chrome.send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { x: nav.x, y: nav.y, width: nav.w, height: nav.h, scale: 1 } });
            const file = path.join(SHOTS, 'toolbar-lumen-' + size.w + 'x' + size.h + '-' + theme + '-' + state + '.png');
            if (m && m.result && m.result.data) { fs.writeFileSync(file, Buffer.from(m.result.data, 'base64')); say('shot ' + file + ' (' + nav.w + 'x' + nav.h + ')'); }
            else check(false, 'shot ' + file, m && m.error);
          }
        }
      }
      // the mark up close, for judging the line weight against the shield, moon and gear (4x)
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      for (const theme of ['light', 'dark']) for (const state of ['idle', 'active']) {
        await chrome.ev('setTheme(' + JSON.stringify(theme) + '), activateTab(' + JSON.stringify(state === 'active' ? lumenId : homeId) + '), 1');
        await park();
        await sleep(400);
        const l = await rect('lumen'), g = await rect('settings');
        const m = await chrome.send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { x: l.x - 4, y: l.y - 4, width: g.r - l.x + 8, height: l.h + 8, scale: 4 } });
        if (m && m.result && m.result.data) fs.writeFileSync(path.join(SHOTS, 'toolbar-lumen-zoom4x-' + theme + '-' + state + '.png'), Buffer.from(m.result.data, 'base64'));
      }
    }
    await q.quit();
  } finally { await mock.close(); }
});
