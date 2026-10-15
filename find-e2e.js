// find-e2e.js -- find in page, end to end, in a REAL Quartz test instance.
//
//   node find-e2e.js
//
// tests/e2e-kit.js launches it (--test-profile, off-screen, watched). A local page holds "quartz"
// five times, in three cases, spread down a tall page. Everything is driven with REAL input over
// CDP (Ctrl+F, typed text, Enter, Shift+Enter, Escape, button clicks), and read back off the bar:
//   - Ctrl+F (from the address bar) opens the bar with the input focused;
//   - typing counts the matches, case-insensitively: "1 of 5";
//   - Enter steps forward, Shift+Enter back, both wrap at the ends; the chevrons do the same;
//   - a word that is not there says "No matches" (in words, flagged); clearing the box clears it;
//   - switching tabs with the bar open re-runs the search on the new page;
//   - Escape closes the bar, hands focus back to the page, and leaves the last hit selected;
//   - Ctrl+F again, this time with the PAGE focused (the guest's before-input-event route), brings
//     the same text back and counts again.
// The findNext flag is the trap here (memory: reference_electron-findinpage): inverted, Electron
// fires no found-in-page at all and the count stays empty. Every count check would catch that.
// One summary line: "find-e2e: N passed, M failed".
'use strict';
const { run, serve, html, KEYS, SHIFT, sleep } = require('./tests/e2e-kit');

const CDP = 9433;
const CTRL = 2;

run('find-e2e', async ({ check, launch }) => {
  const filler = '<p>' + 'lorem ipsum dolor sit amet '.repeat(40) + '</p>';
  const srv = await serve((req, res, p) => {
    if (p === '/find.html') {
      return html(res, '<!doctype html><title>Find page</title><body style="font:16px sans-serif">'
        + '<p>one quartz here</p>' + filler.repeat(6) + '<p>Quartz two</p>' + filler.repeat(6)
        + '<p>three QUARTZ and four quartz</p>' + filler.repeat(6) + '<p>last: quartz.</p></body>');
    }
    if (p === '/other.html') return html(res, '<!doctype html><title>Other</title><p>nothing to see</p>');
    return false;
  });
  const B = 'http://127.0.0.1:' + srv.port;
  const q = await launch({ cdp: CDP });
  const c = q.chrome;

  const tabId = await c.ev(`(() => { const t = createTab(${JSON.stringify(B + '/find.html')}); window.__find = t; activateTab(t.id); return t.id; })()`);
  await c.waitFor('window.__find.ready === true', 15000);
  await c.ev(`(() => { const t = createTab(${JSON.stringify(B + '/other.html')}); window.__other = t; return 1; })()`);
  await c.waitFor('window.__other.ready === true', 15000);
  await c.ev(`activateTab(${tabId}), 1`);
  await sleep(300);

  const state = () => c.ev(`(() => { const bar = document.getElementById('findbar'); const n = document.getElementById('find-count'); const i = document.getElementById('find-input');
    return { open: !!(bar && !bar.hidden && window.FindBar.isOpen()), count: n ? n.textContent : null, none: !!(n && n.classList.contains('none')),
      value: i ? i.value : null, focused: !!(i && document.activeElement === i) }; })()`);
  const waitCount = async (want, ms) => {
    const t0 = Date.now(); let s;
    while (Date.now() - t0 < (ms || 4000)) { s = await state(); if (s.count === want) return s; await sleep(60); }
    return s;
  };
  const click = async (id) => {
    const r = await c.ev(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    }
  };

  // ---- open (from the chrome: the address bar has the keyboard) -------------------------------
  await c.ev('document.getElementById("omnibox").focus(), 1');
  await c.key('f', { code: 'KeyF', vk: 70, mods: CTRL });
  let s = await c.waitFor('window.FindBar && window.FindBar.isOpen()', 3000).then(() => state()).catch(() => state());
  check(s.open, 'Ctrl+F opens the find bar', s);
  if (!s.open) { await c.ev('window.FindBar.open(), 1'); s = await state(); }
  check(s.focused, 'the find box has the keyboard', s);

  // ---- count -----------------------------------------------------------------------------------
  await c.type('quartz');
  s = await waitCount('1 of 5');
  check(s.count === '1 of 5', 'typing "quartz": "1 of 5" (all three cases counted)', s.count);
  check(s.none === false, 'a hit is not flagged as none', s);

  // ---- next / prev, by key and by button -------------------------------------------------------
  await c.key('Enter', KEYS.Enter);
  s = await waitCount('2 of 5');
  check(s.count === '2 of 5', 'Enter: next match, "2 of 5"', s.count);
  await c.key('Enter', KEYS.Enter);
  await c.key('Enter', KEYS.Enter);
  await c.key('Enter', KEYS.Enter);
  s = await waitCount('5 of 5');
  check(s.count === '5 of 5', 'Enter x3 more: "5 of 5"', s.count);
  await c.key('Enter', KEYS.Enter);
  s = await waitCount('1 of 5');
  check(s.count === '1 of 5', 'Enter at the last match wraps to "1 of 5"', s.count);
  await c.key('Enter', Object.assign({ mods: SHIFT }, KEYS.Enter));
  s = await waitCount('5 of 5');
  check(s.count === '5 of 5', 'Shift+Enter at the first match wraps back to "5 of 5"', s.count);
  await c.key('Enter', Object.assign({ mods: SHIFT }, KEYS.Enter));
  s = await waitCount('4 of 5');
  check(s.count === '4 of 5', 'Shift+Enter: previous match, "4 of 5"', s.count);
  await click('find-next');
  s = await waitCount('5 of 5');
  check(s.count === '5 of 5', 'the down chevron: next, "5 of 5"', s.count);
  await click('find-prev');
  await click('find-prev');
  s = await waitCount('3 of 5');
  check(s.count === '3 of 5', 'the up chevron x2: "3 of 5"', s.count);

  // ---- no match, and clearing --------------------------------------------------------------------
  await c.ev("(() => { const i = document.getElementById('find-input'); i.focus(); i.select(); return 1; })()");
  await c.type('zzqx');
  s = await waitCount('No matches');
  check(s.count === 'No matches' && s.none === true, 'a word that is not there: "No matches", flagged', s);
  check(await c.ev("document.getElementById('find-next').disabled") === false, 'the chevrons stay usable while there is text');
  await c.ev("(() => { const i = document.getElementById('find-input'); i.focus(); i.select(); return 1; })()");
  await c.key('Backspace', { code: 'Backspace', vk: 8 });
  s = await waitCount('');
  check(s.value === '' && s.count === '' && s.none === false, 'clearing the box clears the count', s);
  check(await c.ev("document.getElementById('find-next').disabled && document.getElementById('find-prev').disabled") === true, 'an empty box disables the chevrons');
  await c.type('quartz');
  s = await waitCount('1 of 5');
  check(s.count === '1 of 5', 'typing again counts again', s.count);

  // ---- a tab switch with the bar open -------------------------------------------------------------
  await c.ev('activateTab(window.__other.id), 1');
  s = await waitCount('No matches');
  check(s.open && s.count === 'No matches', 'switching tabs re-searches the new page ("No matches" there)', s);
  await c.ev(`activateTab(${tabId}), 1`);
  s = await waitCount('1 of 5');
  check(s.open && s.count === '1 of 5', 'and back: "1 of 5" again', s);
  await c.key('Enter', KEYS.Enter);
  s = await waitCount('2 of 5');
  check(s.count === '2 of 5', 'Enter after the switch: "2 of 5"', s.count);

  // ---- Escape --------------------------------------------------------------------------------------
  await c.ev("document.getElementById('find-input').focus(), 1");
  await c.key('Escape', KEYS.Escape);
  s = await c.waitFor('!window.FindBar.isOpen()', 3000).then(() => state()).catch(() => state());
  check(!s.open && await c.ev("document.getElementById('findbar').hidden") === true, 'Escape closes the bar', s);
  check(await c.ev('document.activeElement === window.__find.viewEl') === true, 'Escape hands the keyboard back to the page', await c.ev('document.activeElement && (document.activeElement.id || document.activeElement.tagName)'));
  const sel = await c.ev("window.__find.viewEl.executeJavaScript('String(window.getSelection())')");
  check(String(sel).toLowerCase() === 'quartz', 'the last hit stays selected on the page, the way Chrome leaves it', sel);

  // ---- Ctrl+F again, from the PAGE this time (main's before-input-event on the guest) ---------------
  await c.key('f', { code: 'KeyF', vk: 70, mods: CTRL });
  s = await c.waitFor('window.FindBar.isOpen() && / of 5$/.test(document.getElementById("find-count").textContent)', 3000).then(() => state()).catch(() => state());
  check(s.open && s.value === 'quartz' && s.focused, 'Ctrl+F in the page: the bar is back with the last text, focused', s);
  check(/^[1-5] of 5$/.test(s.count), 'and it counts again on open', s.count);
  // Left on match 2 (selected). Chrome reopens on that same hit; a fresh Electron session starts
  // AFTER the selection and lands on 3, so the bar walks back to it. Read once it has settled.
  s = await waitCount('2 of 5');
  check(s.count === '2 of 5', 'Ctrl+F reopens on the match left selected (2 of 5), as Chrome does', s.count);
  // The other way round: left on the LAST match, a fresh session wraps to 1; it must come back to 5.
  for (let i = 0; i < 3; i++) await c.key('Enter', KEYS.Enter);
  s = await waitCount('5 of 5');
  check(s.count === '5 of 5', 'Enter x3 from 2: "5 of 5"', s.count);
  await c.key('Escape', KEYS.Escape);
  s = await c.waitFor('!window.FindBar.isOpen()', 3000).then(() => state()).catch(() => state());
  check(!s.open, 'Escape closes it again', s);
  await c.key('f', { code: 'KeyF', vk: 70, mods: CTRL });
  await c.waitFor('window.FindBar.isOpen()', 3000).catch(() => {});
  s = await waitCount('5 of 5');
  check(s.open && s.count === '5 of 5', 'Ctrl+F reopens on the last match too (5 of 5, not wrapped to 1)', s);
  // A plain Enter after the reopen still steps on from there (the session is a live one).
  await c.key('Enter', KEYS.Enter);
  s = await waitCount('1 of 5');
  check(s.count === '1 of 5', 'Enter after the reopen wraps on to "1 of 5"', s.count);
  if (process.env.FIND_SHOTS) await c.shot(require('path').resolve(process.env.FIND_SHOTS, 'findbar.png')).catch((e) => console.log('shot failed: ' + e.message));
  await c.key('Escape', KEYS.Escape);
  s = await c.waitFor('!window.FindBar.isOpen()', 3000).then(() => state()).catch(() => state());
  check(!s.open, 'Escape closes it a third time', s);

  check(await q.quit(), 'closing the window quit Quartz');
  srv.close();
});
