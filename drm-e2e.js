require('./tools/lowcpu-optional.js');   // first: one capped browser at a time (requested 2026-09-17)
// drm-e2e.js -- the "needs DRM, open in Edge" bar end to end, against a REAL Quartz test instance
// and LOCAL pages. Edge is never started: QUARTZ_EDGE_STUB makes main append each URL to a file.
//
//   node drm-e2e.js [--cdp 9426] [--shots <dir>] [--keep] [--live]
//
// 1. A local server: plain.html (no media), probe.html (asks for Widevine, is refused, plays nothing:
//    what YouTube/Twitch-style probes look like), clearkey.html (asks for Clear Key, is granted),
//    needs.html (asks for Widevine, is refused, then feeds a <video> an ENCRYPTED WebM init segment
//    through MSE, so Chromium fires a real 'encrypted' event), watch.html served on "localhost",
//    which QUARTZ_DRM_TEST_SITE makes a known streaming site ("Test Stream").
// 2. Quartz: --test-profile --profile-name=drme2e<pid> --offscreen --show-inactive --measure-visible.
//    testwatch.js fails the run if the window ever touches the screen. Not launched under 2.5 GB free.
// 3. Checks: no bar on plain / probe / clearkey; the hook is invisible to the page; the bar on
//    needs.html and on the known site; Open in Edge (stub gets the URL, bar says it opened); Always use
//    Edge (rule stored, bar says sent); a later navigation to the site is stopped and sent; Turn off;
//    a failed launch says why and offers Try again; Close hides it; Settings lists the rule.
//    --live also loads real youtube.com / twitch.tv / vimeo.com pages and requires NO bar on them.
// Kills ONLY the process it started and deletes its temp profile. One summary line:
// "drm-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WS = require(path.join(__dirname, 'node_modules', 'ws'));
const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher } = require('./testwatch');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9426'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'quartz-drm-shots'));
const KEEP = argv.includes('--keep');
const LIVE = argv.includes('--live');
const APP = __dirname;
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROFILE = 'drme2e' + process.pid;
const PROFILE_DIR = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);
const STUB = path.join(os.tmpdir(), 'quartz-drm-edge-stub-' + process.pid + '.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
}
const stubLines = () => { try { return fs.readFileSync(STUB, 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } };

/* ---- the pages ---------------------------------------------------------------------------- */
const WIDEVINE_CFG = `[{ initDataTypes: ['cenc', 'webm'], videoCapabilities: [{ contentType: 'video/webm; codecs="vp8"' }] }]`;
// A WebM init segment whose one video track is encrypted (ContentEncryption, AES, a 16-byte key
// id). Appending it to a SourceBuffer makes Chromium's parser fire a trusted 'encrypted' event.
const WEBM_BUILDER = `
function vint(n) { const b = [0x01, 0, 0, 0, 0, 0, 0, 0]; for (let i = 7; i >= 1; i--) { b[i] = n & 0xff; n = Math.floor(n / 256); } return b; }
function E(id, payload) { return id.concat(vint(payload.length), payload); }
function U(n) { const out = []; do { out.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0); return out; }
function Str(s) { return Array.from(s).map((c) => c.charCodeAt(0)); }
function encryptedWebmInit() {
  const header = E([0x1A, 0x45, 0xDF, 0xA3], [].concat(
    E([0x42, 0x86], U(1)), E([0x42, 0xF7], U(1)), E([0x42, 0xF2], U(4)), E([0x42, 0xF3], U(8)),
    E([0x42, 0x82], Str('webm')), E([0x42, 0x87], U(4)), E([0x42, 0x85], U(2))));
  const keyId = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const info = E([0x15, 0x49, 0xA9, 0x66], [].concat(E([0x2A, 0xD7, 0xB1], U(1000000)), E([0x4D, 0x80], Str('drm-e2e')), E([0x57, 0x41], Str('drm-e2e'))));
  const enc = E([0x6D, 0x80], E([0x62, 0x40], [].concat(
    E([0x50, 0x31], U(0)), E([0x50, 0x32], U(1)), E([0x50, 0x33], U(1)),
    E([0x50, 0x35], [].concat(E([0x47, 0xE1], U(5)), E([0x47, 0xE2], keyId), E([0x47, 0xE7], E([0x47, 0xE8], U(1))))))));
  const track = E([0xAE], [].concat(E([0xD7], U(1)), E([0x73, 0xC5], U(1)), E([0x83], U(1)), E([0x86], Str('V_VP8')),
    E([0xE0], [].concat(E([0xB0], U(320)), E([0xBA], U(240)))), enc));
  const tracks = E([0x16, 0x54, 0xAE, 0x6B], track);
  const segment = [0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF].concat(info, tracks);
  return new Uint8Array(header.concat(segment));
}`;
const PAGES = {
  '/plain.html': `<!doctype html><title>plain</title><p>Nothing to play here.</p>`,
  '/plain2.html': `<!doctype html><title>plain2</title><p>Nothing here either.</p>`,
  '/probe.html': `<!doctype html><title>probe</title><p>probe</p><script>
    window.__probe = 'pending';
    navigator.requestMediaKeySystemAccess('com.widevine.alpha', ${WIDEVINE_CFG})
      .then(() => { window.__probe = 'granted'; }, (e) => { window.__probe = 'refused:' + e.name; });
  </script>`,
  '/clearkey.html': `<!doctype html><title>clearkey</title><script>
    window.__ck = 'pending';
    navigator.requestMediaKeySystemAccess('org.w3.clearkey', ${WIDEVINE_CFG})
      .then(() => { window.__ck = 'granted'; }, (e) => { window.__ck = 'refused:' + e.name; });
  </script>`,
  '/needs.html': `<!doctype html><title>needs</title><video id="v" muted></video><script>${WEBM_BUILDER}
    window.__needs = { request: 'pending', encrypted: false, ms: '' };
    const v = document.getElementById('v');
    v.addEventListener('encrypted', (e) => { window.__needs.encrypted = e.initDataType || true; });
    navigator.requestMediaKeySystemAccess('com.widevine.alpha', ${WIDEVINE_CFG})
      .then(() => { window.__needs.request = 'granted'; }, (e) => { window.__needs.request = 'refused:' + e.name; })
      .then(() => {
        const ms = new MediaSource();
        v.src = URL.createObjectURL(ms);
        ms.addEventListener('sourceopen', () => {
          try {
            const sb = ms.addSourceBuffer('video/webm; codecs="vp8"');
            sb.addEventListener('error', () => { window.__needs.ms = 'sourcebuffer error'; });
            sb.appendBuffer(encryptedWebmInit());
            window.__needs.ms = 'appended';
          } catch (e) { window.__needs.ms = 'threw ' + e.name + ': ' + e.message; }
        });
      });
  </script>`,
  '/watch.html': `<!doctype html><title>Test Stream</title><p>A streaming site (by address).</p>`,
  '/watch2.html': `<!doctype html><title>Test Stream 2</title><p>Another page of it.</p>`,
};
const server = http.createServer((req, res) => {
  const p = String(req.url || '').split('?')[0];
  const body = PAGES[p];
  if (!body) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
});
const listen = (srv, port) => new Promise((r, j) => { srv.once('error', j); srv.listen(port, '127.0.0.1', () => r(srv.address().port)); });

/* ---- CDP ----------------------------------------------------------------------------------- */
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WS(this.wsUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { this.ws.on('open', r); this.ws.on('error', j); });
    this.ws.on('message', (raw) => { const m = JSON.parse(String(raw)); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m); } });
    return this;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
  async ev(expr) {
    const m = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (m.error) throw new Error(JSON.stringify(m.error));
    if (m.result.exceptionDetails) throw new Error('threw: ' + ((m.result.exceptionDetails.exception || {}).description || m.result.exceptionDetails.text));
    return m.result.result.value;
  }
  async waitFor(expr, ms) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < (ms || 10000)) { try { last = await this.ev(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(100); }
    throw new Error('timed out: ' + expr.slice(0, 160) + ' (last ' + JSON.stringify(last).slice(0, 200) + ')');
  }
  close() { try { this.ws.close(); } catch (e) { /* gone */ } }
}
async function targets() { return (await fetch('http://127.0.0.1:' + CDP_PORT + '/json')).json(); }
async function waitTarget(pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 10000)) {
    try { const t = (await targets()).find(pred); if (t) return t; } catch (e) { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('no such target');
}
async function guest(urlRe) {
  const t = await waitTarget((x) => x.type === 'webview' && urlRe.test(String(x.url)), 15000);
  const g = await new Cdp(t.webSocketDebuggerUrl).open();
  // The target's url names the page as soon as the navigation starts, while the frame can still
  // hold the guest's first about:blank (readyState "complete", not a secure context, so no EME
  // at all). Wait until the document itself is the page before anything reads it.
  await g.waitFor(`new RegExp(${JSON.stringify(urlRe.source)}).test(location.href)`, 15000);
  return g;
}

/* ---- run ------------------------------------------------------------------------------------ */
(async () => {
  let child = null, watcher = null, chrome = null;
  try {
    const free = freeRamGb();
    if (!(free >= MIN_FREE_GB)) { console.log('drm-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }
    const port = await listen(server, 0);
    const B = 'http://127.0.0.1:' + port;
    const K = 'http://localhost:' + port; // the "known streaming site"
    fs.mkdirSync(SHOTS, { recursive: true });
    try { fs.unlinkSync(STUB); } catch (e) { /* none */ }
    watcher = startWatcher((l) => console.log('[e2e] ' + l));
    await watcher.ready;
    const env = Object.assign({}, process.env, { QUARTZ_EDGE_STUB: STUB, QUARTZ_DRM_TEST_SITE: 'localhost', QUARTZ_TEST_CDM: 'missing' });
    child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + CDP_PORT, '--test-profile', '--profile-name=' + PROFILE, ...OFFSCREEN_ARGS], { cwd: APP, stdio: 'ignore', env });
    watcher.watch(child.pid);
    console.log('[e2e] quartz pid ' + child.pid + ', pages :' + port);

    const ct = await waitTarget((x) => x.type === 'page' && /index\.html/.test(String(x.url)), 30000);
    chrome = await new Cdp(ct.webSocketDebuggerUrl).open();
    await chrome.waitFor('!!(window.Drm && window.DrmSites && typeof createTab === "function" && window.Drm.state())', 20000);
    check(true, 'chrome up with Drm and its state');
    const st0 = await chrome.ev('window.Drm.state()');
    check(st0.widevine && st0.widevine.available === false, 'no Widevine (stock, or castlabs with QUARTZ_TEST_CDM=missing): reported missing', st0.widevine);
    check(st0.edge && st0.edge.how === 'stub', 'test profile: Edge launch is the stub', st0.edge);
    check(/by address and by what their video does/.test(st0.detection), 'detection: both ways on', st0.detection);

    // Opens a tab in front and parks it on window.__t[name].
    const open = (name, url) => chrome.ev(`(() => { window.__t = window.__t || {}; const t = createTab(${JSON.stringify(url)}); window.__t[${JSON.stringify(name)}] = t; activateTab(t.id); return t.id; })()`);
    const info = (name) => chrome.ev(`window.Drm._tab(window.__t[${JSON.stringify(name)}])`);
    const waitInfo = (name, cond, ms) => chrome.waitFor(`(() => { const i = window.Drm._tab(window.__t[${JSON.stringify(name)}]); return (${cond}) ? i : null; })()`, ms || 12000);
    const click = (name, label) => chrome.ev(`(() => { const t = window.__t[${JSON.stringify(name)}]; const b = Array.from(t.noteEl ? t.noteEl.querySelectorAll('button') : []).find((x) => x.textContent === ${JSON.stringify(label)} || x.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b) return 'no button ' + ${JSON.stringify(label)}; b.click(); return 'ok'; })()`);
    const shot = async (file) => {
      await sleep(200);
      const m = await chrome.send('Page.captureScreenshot', { format: 'png' });
      if (m.result && m.result.data) fs.writeFileSync(path.join(SHOTS, file), Buffer.from(m.result.data, 'base64'));
    };

    // ---- 1. a plain page: no bar ---------------------------------------------------------------
    await open('plain', B + '/plain.html');
    const gPlain = await guest(/plain\.html/);
    await gPlain.waitFor('document.readyState === "complete"');
    await sleep(800);
    check((await info('plain')).bar === null, 'plain page: no bar');
    const nativeLook = await gPlain.ev('Function.prototype.toString.call(navigator.requestMediaKeySystemAccess)');
    check(/\[native code\]/.test(nativeLook), 'the EME hook still prints as native code to the page', nativeLook);
    check(await gPlain.ev('navigator.requestMediaKeySystemAccess.name') === 'requestMediaKeySystemAccess', 'the hooked function keeps its name');
    check(await gPlain.ev('typeof window.__quartzDrm === "undefined" && !Object.keys(window).some((k) => /drm/i.test(k))'), 'nothing of the watcher is visible in the page');
    gPlain.close();

    // ---- 2. a probe (refused Widevine, no encrypted media): no bar --------------------------------
    await open('probe', B + '/probe.html');
    const gProbe = await guest(/probe\.html/);
    const probe = await gProbe.waitFor('window.__probe !== "pending" && window.__probe');
    check(probe === 'refused:NotSupportedError', 'probe: the page still gets the refusal it would get anyway', probe);
    gProbe.close();
    const pi = await waitInfo('probe', 'i && i.seen.denied.length === 1');
    await sleep(700);
    check(pi.seen.denied[0] === 'com.widevine.alpha', 'probe: the watcher reported the refused Widevine request', pi.seen);
    check((await info('probe')).bar === null, 'probe only (YouTube/Twitch style): NO bar');

    // ---- 3. Clear Key (works in Electron): no bar, nothing recorded -----------------------------------
    await open('ck', B + '/clearkey.html');
    const gCk = await guest(/clearkey\.html/);
    const ck = await gCk.waitFor('window.__ck !== "pending" && window.__ck');
    check(ck === 'granted', 'clearkey: granted as before', ck);
    gCk.close();
    await sleep(700);
    const cki = await info('ck');
    check(cki.bar === null && cki.seen.denied.length === 0, 'clearkey: no bar, nothing reported', cki);

    // ---- 4. refused Widevine + encrypted media: the bar ----------------------------------------------
    await open('needs', B + '/needs.html');
    const gNeeds = await guest(/needs\.html/);
    const needsPage = await gNeeds.waitFor('window.__needs && window.__needs.ms && window.__needs');
    await sleep(600);
    const needsPage2 = await gNeeds.ev('window.__needs');
    gNeeds.close();
    check(!!needsPage2.encrypted, 'needs: Chromium fired a real encrypted event for the WebM init segment', needsPage2);
    let ni;
    try { ni = await waitInfo('needs', 'i && i.bar && i.bar.mode === "need"'); } catch (e) { ni = await info('needs'); }
    check(ni.bar && ni.bar.mode === 'need', 'needs: the bar is up', ni);
    check(ni.bar && /^This page uses DRM-protected video, which Quartz can\u2019t play yet: (?:this build of Quartz has no Widevine|Widevine is switched off for this test run)\.$/.test(ni.bar.text), 'needs: the words', ni.bar && ni.bar.text);
    check(ni.bar && JSON.stringify(ni.bar.buttons) === JSON.stringify(['Open in Edge', 'Always use Edge for this site']), 'needs: one primary action + the always option', ni.bar && ni.bar.buttons);
    check(ni.bar && ni.bar.display === 'flex', 'needs: shown on the tab in front');
    const geo = await chrome.ev(`(() => { const t = window.__t.needs; const r = t.noteEl.getBoundingClientRect(); const w = t.viewEl.getBoundingClientRect(); return { barTop: Math.round(r.top), barH: Math.round(r.height), viewTop: Math.round(w.top), pos: getComputedStyle(t.noteEl).position, primaryBg: getComputedStyle(t.noteEl.querySelector('.drm-bar-primary')).backgroundColor }; })()`);
    check(geo.pos === 'absolute' && geo.barTop === geo.viewTop && geo.barH === 40, 'needs: the bar floats over the top of the page (no layout jump), 40px', geo);
    // One picture per theme, each named by the theme the chrome actually wears when it is taken.
    for (const mode of ['dark', 'light']) {
      await chrome.ev(`setThemeMode('${mode}'), 1`);
      await sleep(400);
      const worn = await chrome.ev('document.documentElement.getAttribute("data-theme") || "unknown"');
      await shot('drm-bar-need-' + worn + '.png');
    }
    await chrome.ev("setThemeMode('dark'), 1");
    check(await click('needs', 'Open in Edge') === 'ok', 'needs: Open in Edge clicked');
    const opened = await waitInfo('needs', 'i && i.bar && i.bar.mode === "opened"');
    check(opened.bar.text === 'Opened in Microsoft Edge.', 'needs: the bar says it opened', opened.bar.text);
    check(stubLines()[0] === B + '/needs.html', 'needs: Edge got exactly this URL (stub)', stubLines());

    // ---- 5. a known streaming site, by address ------------------------------------------------------
    await open('known', K + '/watch.html');
    const ki = await waitInfo('known', 'i && i.bar && i.bar.mode === "need"');
    check(/^Test Stream uses DRM-protected video, which Quartz can\u2019t play yet: (?:this build of Quartz has no Widevine|Widevine is switched off for this test run)\.$/.test(ki.bar.text), 'known site: the bar names the service', ki.bar.text);
    check(JSON.stringify(ki.bar.buttons) === JSON.stringify(['Open in Edge', 'Always use Edge for Test Stream']), 'known site: buttons', ki.bar.buttons);
    check(await click('known', 'Always use Edge for Test Stream') === 'ok', 'known site: Always clicked');
    const sent = await waitInfo('known', 'i && i.bar && i.bar.mode === "sent"');
    check(sent.bar.text === 'Opened in Microsoft Edge. You chose to always watch Test Stream there.', 'always: the bar says it was sent', sent.bar.text);
    check(JSON.stringify(sent.bar.buttons) === JSON.stringify(['Turn off']), 'always: Turn off offered', sent.bar.buttons);
    check(stubLines()[1] === K + '/watch.html', 'always: Edge got the URL', stubLines());
    const st1 = await chrome.ev('window.Drm.state()');
    check(st1.alwaysEdge.length === 1 && st1.alwaysEdge[0].key === 'test', 'always: rule stored in main', st1.alwaysEdge);
    let stored = null;
    try { stored = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'drm.json'), 'utf8')); } catch (e) { stored = String(e.message); }
    check(stored && Array.isArray(stored.alwaysEdge) && stored.alwaysEdge[0] === 'test', 'always: written to <userData>/drm.json', stored);
    await shot('drm-bar-sent.png');

    // Settings lists it.
    await chrome.ev("Settings.open('Protected video'), 1");
    const setTxt = await chrome.waitFor(`(() => { const f = document.querySelector('#settings-panel [data-field="drmsites"]'); return f && /Test Stream/.test(f.textContent) ? document.querySelector('#settings-panel [data-section="drm"]').textContent : null; })()`, 8000).catch((e) => 'ERR ' + e.message);
    check(/Always open in Microsoft Edge/.test(setTxt) && /Test Stream/.test(setTxt) && /can\u2019t play DRM-protected video yet/.test(setTxt), 'Settings > Protected video lists the rule', setTxt);
    await shot('drm-settings.png');
    await chrome.ev("(window.Settings.close ? window.Settings.close() : 0), 1");

    // ---- 6. leave, come back: the navigation is stopped and sent ----------------------------------------
    await chrome.ev(`window.__t.known.viewEl.loadURL(${JSON.stringify(B + '/plain2.html')}), 1`);
    await waitInfo('known', 'i && i.bar === null');
    check(true, 'left the site: the bar went away');
    await chrome.ev(`window.__t.known.viewEl.executeJavaScript('location.href = ${JSON.stringify(K + '/watch2.html')}'), 1`);
    const sent2 = await waitInfo('known', 'i && i.bar && i.bar.mode === "sent"');
    check(!!sent2, 'came back: the bar says it was sent to Edge');
    await sleep(800);
    const where = await chrome.ev('window.__t.known.viewEl.getURL()');
    check(where === B + '/plain2.html', 'came back: Quartz stayed where it was (navigation stopped)', where);
    check(stubLines()[2] === K + '/watch2.html', 'came back: Edge got the new URL', stubLines());

    // Turn off.
    check(await click('known', 'Turn off') === 'ok', 'Turn off clicked');
    const off = await waitInfo('known', 'i && i.bar && i.bar.mode === "off"');
    check(off.bar.text === 'Test Stream will open in Quartz from now on.', 'Turn off: the bar says what happens next', off.bar.text);
    const st2 = await chrome.ev('window.Drm.state()');
    check(st2.alwaysEdge.length === 0, 'Turn off: rule removed', st2.alwaysEdge);

    // ---- 7. Edge fails: the reason, and Try again ----------------------------------------------------
    fs.writeFileSync(STUB + '.fail', '');
    await open('fail', K + '/watch.html');
    await waitInfo('fail', 'i && i.bar && i.bar.mode === "need"');
    await click('fail', 'Open in Edge');
    const failed = await waitInfo('fail', 'i && i.bar && i.bar.mode === "failed"');
    check(failed.bar.text === 'Microsoft Edge didn\u2019t open: Edge did not start (test failure).', 'Edge failure: the bar says why', failed.bar.text);
    check(JSON.stringify(failed.bar.buttons) === JSON.stringify(['Try again']), 'Edge failure: Try again offered', failed.bar.buttons);
    await shot('drm-bar-failed.png');
    fs.unlinkSync(STUB + '.fail');
    await click('fail', 'Try again');
    const retried = await waitInfo('fail', 'i && i.bar && i.bar.mode === "opened"');
    check(!!retried, 'Try again: opened');

    // ---- 8. Close hides it for the site in this tab --------------------------------------------------
    await open('dismiss', K + '/watch.html');
    await waitInfo('dismiss', 'i && i.bar && i.bar.mode === "need"');
    check(await click('dismiss', 'Close') === 'ok', 'Close clicked');
    await chrome.ev(`window.__t.dismiss.viewEl.executeJavaScript("history.pushState({}, '', '/watch.html?x=1')"), 1`);
    await sleep(900);
    check((await info('dismiss')).bar === null, 'Close: stays closed while the tab is on the site');

    // ---- 9. tab switching: the bar follows its own tab ------------------------------------------------
    await chrome.ev('activateTab(window.__t.plain.id), 1');
    await sleep(300);
    const hid = await info('needs');
    check(hid.bar && hid.bar.display === 'none', 'a background tab\u2019s bar is hidden', hid.bar);

    // ---- 10. (--live) real YouTube / Twitch / Vimeo: never a bar ------------------------------------------
    if (LIVE) {
      const live = { yt: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', tw: 'https://www.twitch.tv/directory', vi: 'https://vimeo.com/76979871' };
      for (const [name, url] of Object.entries(live)) {
        await open(name, url);
        await sleep(12000);
        const li = await info(name);
        check(li.bar === null, 'live ' + url + ': no bar', { seen: li.seen, bar: li.bar });
        await chrome.ev(`closeTab(window.__t.${name}.id), 1`);
        await sleep(500);
      }
    }
  } catch (e) {
    check(false, 'HARNESS ERROR ' + (e && e.stack || e));
  } finally {
    if (watcher) { const v = watcher.verdict(); check(v.ok, v.line); watcher.stop(); }
    if (chrome) chrome.close();
    if (child && !KEEP) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ }
      await sleep(1200);
      for (let i = 0; i < 10; i++) { try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
    }
    try { fs.unlinkSync(STUB); } catch (e) { /* none */ }
    try { fs.unlinkSync(STUB + '.fail'); } catch (e) { /* none */ }
    server.close();
    console.log(`drm-e2e: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
