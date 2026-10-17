// filelinks-e2e.js -- links on a LOCAL page, end to end, in a REAL Quartz test instance.
//
//   node filelinks-e2e.js
//
// tests/e2e-kit.js launches it (--test-profile, off-screen, watched). A temp folder holds three
// local pages; a local http server holds a web page that tries to reach one of them.
//   - a file:// page's plain relative link (<a href="b.html">) navigates the tab to b.html;
//   - its target="_blank" link opens a NEW tab on c.html, and the first tab stays where it was;
//   - its window.open('c.html') does the same;
//   - an http page's link to file:/// is refused: the tab stays on the http page and its note bar
//     says "Quartz blocked this page from opening a file on your computer: <path>";
//   - the same page's location.assign('file:///...') and window.open('file:///...') are refused,
//     no tab opens, and the note says so;
//   - the note goes away when the tab next navigates.
// Clicks are element.click() run in the guest: page-initiated, which is what will-navigate and
// setWindowOpenHandler judge. One summary line: "filelinks-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, serve, html, Cdp, sleep } = require('./tests/e2e-kit');

const CDP = Number(process.env.FILELINKS_CDP) || 9260;

run('filelinks-e2e', async ({ check, launch, say }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-filelinks-'));
  const page = (title, body) => '<!doctype html><meta charset="utf-8"><title>' + title + '</title><body style="font:16px sans-serif">' + body + '</body>';
  fs.writeFileSync(path.join(dir, 'a.html'), page('Local A',
    '<a id="rel" href="b.html">to b</a> <a id="blank" href="c.html" target="_blank">c in a new tab</a>'));
  fs.writeFileSync(path.join(dir, 'b.html'), page('Local B', '<p id="b">this is b</p>'));
  fs.writeFileSync(path.join(dir, 'c.html'), page('Local C', '<p id="c">this is c</p>'));
  const A = pathToFileURL(path.join(dir, 'a.html')).href;
  const B = pathToFileURL(path.join(dir, 'b.html')).href;
  const C = pathToFileURL(path.join(dir, 'c.html')).href;
  const bPath = path.join(dir, 'b.html');

  const srv = await serve((req, res, p) => {
    if (p === '/web.html') return html(res, page('Web page', '<a id="f" href="' + B + '">a file link</a> <a id="wb" href="/next.html" target="_blank">web, new tab</a>'));
    if (p === '/next.html') return html(res, page('Web next', '<p>next</p>'));
    return false;
  });
  const W = 'http://127.0.0.1:' + srv.port;

  try {
    const q = await launch({ cdp: CDP });
    const c = q.chrome;

    // The guest's own CDP target, by its current URL.
    const guest = async (url) => {
      const t0 = Date.now();
      while (Date.now() - t0 < 10000) {
        const hit = (await q.targets()).find((x) => x.type === 'webview' && x.url === url);
        if (hit) return new Cdp(hit.webSocketDebuggerUrl).open();
        await sleep(150);
      }
      throw new Error('no guest target on ' + url);
    };
    const open = async (url, name) => {
      await c.ev(`(() => { const t = createTab(${JSON.stringify(url)}); window[${JSON.stringify(name)}] = t; activateTab(t.id); return t.id; })()`);
      await c.waitFor(`window[${JSON.stringify(name)}].ready === true`, 15000);
    };
    const urlOf = (name) => c.ev(`(() => { try { return window[${JSON.stringify(name)}].viewEl.getURL(); } catch (e) { return 'ERR ' + e.message; } })()`);
    const noteOf = (name) => c.ev(`(() => { const t = window[${JSON.stringify(name)}]; const n = t && t.noteEl; return n ? { text: n.textContent, blocked: n.dataset.fileBlocked || '', shown: n.style.display, attached: !!n.isConnected } : null; })()`);
    const tabUrls = () => c.ev('tabs.map((t) => { try { return t.viewEl && t.viewEl.getURL ? t.viewEl.getURL() : t.url; } catch (e) { return t.url; } })');
    const waitTabs = async (n, ms) => { const t0 = Date.now(); let l; while (Date.now() - t0 < (ms || 6000)) { l = await tabUrls(); if (l.length >= n) return l; await sleep(100); } return l; };

    // ---- file -> file, a plain relative link ---------------------------------------------------
    await open(A, '__a');
    let g = await guest(A);
    await g.ev('document.getElementById("rel").click(), 1');
    let now = '';
    for (let i = 0; i < 60 && now !== B; i++) { now = await urlOf('__a'); if (now !== B) await sleep(100); }
    check(now === B, 'a local page\'s relative link navigates the tab to the sibling file', now);
    check((await noteOf('__a')) === null, 'no blocked note on the local tab', await noteOf('__a'));
    g.close();

    // ---- file -> file, target=_blank opens a tab ------------------------------------------------
    await open(A, '__a2');
    const before = (await tabUrls()).length;
    g = await guest(A);
    await g.ev('document.getElementById("blank").click(), 1');
    let list = await waitTabs(before + 1);
    check(list.length === before + 1 && list.includes(C), 'target="_blank" to a local file opens a new tab on it', { before, list });
    check((await urlOf('__a2')) === A, 'the opening tab stays on its own page', await urlOf('__a2'));

    // ---- file -> file, window.open --------------------------------------------------------------
    const before2 = (await tabUrls()).length;
    await g.ev('window.open("c.html"), 1');
    list = await waitTabs(before2 + 1);
    check(list.length === before2 + 1 && list.filter((u) => u === C).length >= 2, 'window.open of a local file from a local page opens a tab on it', { before2, list });
    // What a file:// guest can READ is not this change's business (filenav.js), but say it.
    const readable = await g.ev(`fetch(${JSON.stringify(C)}).then((r) => r.text()).then((t) => 'fetch ok, ' + t.length + ' bytes', (e) => 'fetch refused: ' + e.message)`).catch((e) => 'eval failed: ' + e.message);
    say('a file:// guest fetching a sibling file: ' + readable);
    g.close();

    // ---- http -> file, a link: blocked, and the tab says so ------------------------------------
    await open(W + '/web.html', '__w');
    g = await guest(W + '/web.html');
    // The web's own target="_blank" still takes the old road (windowOpenDecision): a tab.
    const before0 = (await tabUrls()).length;
    await g.ev('document.getElementById("wb").click(), 1');
    list = await waitTabs(before0 + 1);
    check(list.length === before0 + 1 && list.includes(W + '/next.html'), 'an http page\'s target="_blank" link still opens a tab', { before0, list });
    await c.ev('activateTab(window.__w.id), 1');
    await sleep(200);
    await g.ev('document.getElementById("f").click(), 1');
    let note = null;
    for (let i = 0; i < 40 && !note; i++) { note = await noteOf('__w'); if (!note) await sleep(100); }
    await sleep(400);
    check((await urlOf('__w')) === W + '/web.html', 'an http page\'s link to file:/// does not navigate', await urlOf('__w'));
    const want = 'Quartz blocked this page from opening a file on your computer: ' + bPath;
    check(!!note && note.text.includes(want) && note.blocked === '1' && note.attached, 'the tab shows the blocked note with the path', { note, want });
    check(!!note && note.shown === 'flex', 'the note is on screen (the tab is in front)', note);

    // ---- http -> file, location.assign and window.open -----------------------------------------
    await c.ev('clearAppNote(window.__w), 1');
    await g.ev(`location.assign(${JSON.stringify(B)}), 1`).catch(() => 0);
    note = null;
    for (let i = 0; i < 40 && !note; i++) { note = await noteOf('__w'); if (!note) await sleep(100); }
    check(!!note && note.text.includes(want) && (await urlOf('__w')) === W + '/web.html', 'location.assign to a file from an http page is refused, with the note', { note, url: await urlOf('__w') });

    await c.ev('clearAppNote(window.__w), 1');
    const before3 = (await tabUrls()).length;
    await g.ev(`window.open(${JSON.stringify(B)}), 1`).catch(() => 0);
    note = null;
    for (let i = 0; i < 40 && !note; i++) { note = await noteOf('__w'); if (!note) await sleep(100); }
    await sleep(500);
    list = await tabUrls();
    check(list.length === before3 && !list.includes(B), 'window.open of a file from an http page opens no tab', { before3, list });
    check(!!note && note.text.includes(want), 'window.open of a file from an http page shows the note', note);

    // ---- the note goes with the next navigation -------------------------------------------------
    await g.ev(`location.assign(${JSON.stringify(W + '/next.html')}), 1`).catch(() => 0);
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) { gone = (await noteOf('__w')) === null; if (!gone) await sleep(100); }
    check(gone, 'the blocked note clears when the tab navigates on', await noteOf('__w'));
    g.close();

    await q.quit();
  } finally {
    srv.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
  }
});
