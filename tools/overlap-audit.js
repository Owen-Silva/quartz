// tools/overlap-audit.js -- hover highlights, focus rings and boxes that run into their neighbours,
// against a REAL Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen, watched).
//
//   node tools/overlap-audit.js [--out=<dir>] [--only=scene,scene] [--sizes=wide,narrow] [--themes=light,dark]
//
// Every surface Quartz draws (the strip with few and many tabs, the toolbar and the address bar's
// suggestions, Home and its dock, Settings, site info, the shield, downloads, the reader, the
// history page, the phone page, the School pane, the tab menu, find, the palette, workspaces, the
// welcome, the protected-video bar) in light and dark, at the window's own 1280 px and at its
// 720 px minimum. On each, every visible control is forced into :hover and then :focus-visible
// (CDP CSS.forcePseudoState) and shot; the pixels that changed are compared with a still shot of
// the same window. A changed pixel outside the control's own box AND inside another control or a
// run of text it does not own is the bug the user saw: a highlight that paints over its neighbour.
// A hit is confirmed by shooting the same spot with the state released (what still differs there
// is something moving on its own, not the highlight) before it counts.
// Static checks on the same screens: text cut off with no ellipsis, a control cut by its own
// clipping box or hanging off the window, controls/text/icons drawn over each other, and targets
// under 24 px that are crowded (WCAG 2.5.8: a small target passes when a 24 px circle around it
// touches nothing else).
//
// Writes <out>/findings.json, <out>/sheets/<size>-<theme>.png (every scene, findings boxed in red)
// and <out>/crops/*.png (the forced state of every hover/focus finding). Summary line:
//   overlap-audit: N passed, M failed      (one check per scene x theme x size, plus the watcher)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, serve, html, Cdp, sleep, APP } = require(path.join(__dirname, '..', 'tests', 'e2e-kit'));

const args = process.argv.slice(2);
const flag = (k) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : null; };
const OUT = path.resolve(flag('out') || path.join(os.tmpdir(), 'quartz-overlap-audit'));
const ONLY = (flag('only') || '').split(',').filter(Boolean);
const SIZES = [{ name: 'wide', w: 1280, h: 800 }, { name: 'narrow', w: 720, h: 640 }].filter((s) => !flag('sizes') || flag('sizes').split(',').includes(s.name));
const THEMES = (flag('themes') || 'light,dark').split(',');
const LIB = fs.readFileSync(path.join(__dirname, 'overlap-page.js'), 'utf8');
const MAX_PER_SCENE = 140;

/*
 * Reviewed and kept on purpose. Each entry: kind, a regex on the element (d), optionally one on
 * what it ran into (into), and why it is right. Matching findings are listed as "allowed".
 */
const ALLOW = [
];
const allowed = (f) => ALLOW.find((a) => a.kind === f.kind && (!a.scene || a.scene.test(f.scene)) && a.d.test(f.d) && (!a.into || a.into.test(f.detail || '')));

const ARTICLE = (n) => `<!doctype html><html><head><meta charset="utf-8"><title>Field notes ${n}: the long way round the lake</title></head><body>
<article><h1>Field notes ${n}: the long way round the lake</h1><p class="byline">By A. Walker</p>
${Array.from({ length: 14 }, (_, i) => `<p>Paragraph ${i + 1}. The path leaves the car park, crosses the old rail bed and follows the shore for a little under four kilometres. In spring the low section floods, and the boardwalk that replaced the stepping stones is the only dry way through. Most people turn back at the bench; the better half of the walk is after it.</p>`).join('\n')}
</article></body></html>`;

run('overlap-audit', async (k) => {
  const { check, launch, say } = k;
  fs.mkdirSync(path.join(OUT, 'sheets'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'crops'), { recursive: true });
  const srv = await serve((req, res, p) => {
    const m = /^\/p\/(\d+)\.html$/.exec(p);
    if (m) return html(res, ARTICLE(m[1]));
    return false;
  });
  const B = 'http://127.0.0.1:' + srv.port;
  const q = await launch({ cdp: 9437 });
  const chrome = q.chrome;
  await chrome.send('Page.enable');
  const findings = [];
  const guests = new Map();

  async function guest(re, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 12000)) {
      const list = await q.targets();
      const t = list.find((x) => x.type === 'webview' && re.test(String(x.url)));
      if (t) {
        if (guests.has(t.id)) return guests.get(t.id);
        const c = await new Cdp(t.webSocketDebuggerUrl).open();
        await c.send('Page.enable');
        guests.set(t.id, c);
        return c;
      }
      await sleep(200);
    }
    throw new Error('no guest page matching ' + re);
  }
  async function shotB64(c, clip) {
    const m = await Promise.race([
      c.send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: Object.assign({ scale: 1 }, clip) }),
      sleep(15000).then(() => ({ error: { message: 'capture timed out' } })),
    ]);
    if (m.error || !m.result) throw new Error('capture: ' + (m.error && m.error.message));
    return m.result.data;
  }
  const frame = (c) => c.ev('new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(() => r(1))); setTimeout(() => r(0), 150); })');
  const closeAll = () => chrome.ev(`(() => { for (const f of [() => Settings.close(), () => SiteInfo.close(), () => Shield.close(), () => Downloads.close(), () => History.close(), () => FindBar.close(), () => TabSearch.close(), () => Workspaces.close(), () => closeTabMenu()]) { try { f(); } catch (e) {} } try { document.activeElement && document.activeElement.blur(); } catch (e) {} return 1; })()`);

  /** One scene on one page: static checks, then every control hovered and focused. */
  async function audit(c, scene, tag, roots, viewTag) {
    await c.ev(LIB + ';1');
    await c.ev('__ov.still(true)');
    await sleep(120);
    const cands = await c.ev('__ov.collect(' + JSON.stringify(roots) + ')');
    const vp = await c.ev('({ w: innerWidth, h: innerHeight })');
    const out = [];
    for (const f of await c.ev('__ov.staticChecks()')) out.push(Object.assign({ scene, tag }, f));
    const b0 = await shotB64(c, { x: 0, y: 0, width: vp.w, height: vp.h });
    await sleep(1100);
    const b1 = await shotB64(c, { x: 0, y: 0, width: vp.w, height: vp.h });
    await c.ev('__ov.setBase(' + JSON.stringify(b0) + ',' + JSON.stringify(b1) + ')');
    await c.send('DOM.enable');
    await c.send('CSS.enable');
    const doc = await c.send('DOM.getDocument', { depth: 0 });
    const qs = await c.send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: '[data-ov]' });
    const ids = new Map();
    for (const nodeId of (qs.result && qs.result.nodeIds) || []) {
      const a = await c.send('DOM.getAttributes', { nodeId });
      const at = (a.result && a.result.attributes) || [];
      const ix = at.indexOf('data-ov');
      if (ix >= 0) ids.set(Number(at[ix + 1]), nodeId);
    }
    for (const cand of cands.slice(0, MAX_PER_SCENE)) {
      const nodeId = ids.get(cand.i);
      if (!nodeId) continue;
      const pad = 12;
      const x0 = Math.max(0, Math.floor(cand.r.x - pad)), y0 = Math.max(0, Math.floor(cand.r.y - pad));
      const x1 = Math.min(vp.w, Math.ceil(cand.r.x + cand.r.w + pad)), y1 = Math.min(vp.h, Math.ceil(cand.r.y + cand.r.h + pad));
      if (x1 - x0 < 2 || y1 - y0 < 2) continue;
      const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      for (const [kind, states] of [['hover', ['hover']], ['focus', ['focus', 'focus-visible']]]) {
        await c.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: states });
        await frame(c);
        const b64 = await shotB64(c, clip);
        const j = await c.ev(`__ov.judge(${cand.i}, ${JSON.stringify(b64)}, ${x0}, ${y0}, ${JSON.stringify(kind)})`);
        await c.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
        if (!j.into.length) continue;
        // confirm: the same spot with the state released must be clean there
        await frame(c);
        const rel = await shotB64(c, clip);
        const j0 = await c.ev(`__ov.judge(${cand.i}, ${JSON.stringify(rel)}, ${x0}, ${y0}, "released")`);
        const real = j.into.filter((h) => !j0.into.some((z) => z.d === h.d && z.px >= h.px * 0.5));
        if (!real.length) continue;
        const crop = path.join(OUT, 'crops', `${viewTag}-${scene}-${kind}-${out.length}.png`);
        fs.writeFileSync(crop, Buffer.from(b64, 'base64'));
        out.push({ scene, tag, kind: kind + '-bleeds', d: j.d, detail: 'into ' + real.map((h) => h.d + ' (' + h.px + ' px)').join('; '), r: j.painted || j.own, crop: path.basename(crop) });
      }
    }
    await c.send('CSS.disable').catch(() => 0);
    const full = await shotB64(c, { x: 0, y: 0, width: vp.w, height: vp.h });
    await c.ev('__ov.still(false)');
    return { out, full, n: cands.length, vp };
  }

  /* ---- the scenes ---- */
  const ev = (s) => chrome.ev(s);
  const openTab = async (url) => ev(`(() => { const t = createTab(${JSON.stringify(url)}); activateTab(t.id); return t.id; })()`);
  // the base state: Home and two pages
  await openTab(B + '/p/1.html');
  await openTab(B + '/p/2.html');
  await chrome.waitFor('tabs.every((t) => t.kind !== "page" || t.ready !== false)', 15000).catch(() => 0);
  const homeTab = await ev('(() => { const t = tabs.find((x) => /newtab\\.html/.test(x.url || "")); return t ? t.id : null; })()') || await openTab('');
  const pageTab = await ev(`tabs.find((x) => /\\/p\\/1\\.html/.test(x.url || "")).id`);
  const activate = (id) => ev(`(activateTab(${JSON.stringify(id)}), 1)`);
  const PINS = [
    { id: 'spotify', name: 'Spotify', native: true, running: true },
    { id: 'code', name: 'Visual Studio Code', running: true },
    { id: 'obs64', name: 'OBS Studio' },
    { id: 'discordapp', name: 'Discord', web: true },
    { id: 'steam', name: 'Steam', running: true },
    { id: 'notion', name: 'Notion' },
    { id: 'figma', name: 'Figma', native: true },
  ];

  const SCENES = [
    { name: 'strip-few', roots: ['#titlebar', '.navrow'], setup: async () => activate(pageTab) },
    {
      name: 'strip-many', roots: ['#titlebar', '.navrow'],
      setup: async () => { for (let i = 10; i < 32; i++) await ev(`(createTab(${JSON.stringify(B + '/p/' + i + '.html')}, { background: true }), 1)`); await activate(pageTab); await sleep(800); },
      teardown: async () => ev(`(() => { for (const t of tabs.slice()) if (/\\/p\\/(1\\d|2\\d|3\\d)\\.html/.test(t.url || '')) closeTab(t.id); return 1; })()`),
    },
    {
      name: 'omnibox', roots: ['#omni-suggest', '.navrow'],
      setup: async () => { await activate(pageTab); await ev("(() => { const o = document.getElementById('omnibox'); o.focus(); o.select(); return 1; })()"); await chrome.type('field'); await chrome.waitFor('History.isOpen()', 5000).catch(() => 0); await sleep(300); },
    },
    { name: 'settings', roots: ['#settings-panel'], setup: async () => ev('(Settings.open(), 1)') },
    {
      name: 'settings-open', roots: ['#settings-panel'], pages: true, wideOnly: true,
      setup: async () => { await ev('(Settings.open(), 1)'); await ev(`(() => { for (const h of document.querySelectorAll('#settings-panel [aria-expanded="false"]')) h.click(); return 1; })()`); await sleep(400); },
    },
    { name: 'siteinfo', roots: ['#siteinfo-panel'], setup: async () => { await activate(pageTab); await ev('(SiteInfo.open(), 1)'); await sleep(300); } },
    { name: 'shield', roots: ['#shield-panel'], setup: async () => { await activate(pageTab); await ev('(Shield.open(), 1)'); await sleep(300); } },
    { name: 'downloads', roots: ['#downloads-panel'], setup: async () => { await ev('(Downloads.open(), 1)'); await sleep(300); } },
    { name: 'find', roots: ['#findbar'], setup: async () => { await activate(pageTab); await ev('(FindBar.open(), 1)'); await sleep(200); await chrome.type('path'); await sleep(400); } },
    { name: 'palette', roots: ['#tabsearch'], setup: async () => { await ev('(TabSearch.open(), 1)'); await sleep(400); } },
    { name: 'workspaces', roots: ['#workspaces-panel'], setup: async () => { await ev('(Workspaces.open(), 1)'); await sleep(400); } },
    { name: 'tabmenu', roots: ['#tabmenu'], setup: async () => { await activate(pageTab); await ev('(openTabMenu(220, 44, tabMenuItemsForTab(getActiveTab())), 1)'); await sleep(200); } },
    {
      name: 'drm-bar', roots: ['.drm-bar'],
      setup: async () => { await activate(pageTab); await ev('(() => { const t = getActiveTab(); t.drmSeen = { denied: ["com.widevine.alpha"], granted: [], encrypted: true }; Drm.evaluate(t); return 1; })()'); await sleep(300); },
      teardown: async () => ev('(() => { const t = getActiveTab(); t.drmSeen = { denied: [], granted: [], encrypted: false }; Drm.evaluate(t); return 1; })()'),
    },
    {
      name: 'school', roots: ['#sidepane'],
      setup: async () => { await ev(`(() => { let ws = workspaces.find((w) => w.pane === 'school'); if (!ws) { ws = createWorkspace('School', 'forest'); ws.pane = 'school'; } switchWorkspace(ws.id); syncSidePane(true); return 1; })()`); await sleep(1200); },
      teardown: async () => { await ev('(switchWorkspace(DEFAULT_WORKSPACE_ID), syncSidePane(true), 1)'); await sleep(600); },
    },
    {
      name: 'home', guest: /newtab\.html/, roots: ['body'],
      setup: async (g) => { await activate(homeTab); g = await guest(/newtab\.html/); await g.waitFor('typeof window.__applyApps === "function"', 8000); await g.ev('(window.__applyApps({ pins: ' + JSON.stringify(PINS) + ' }), 1)'); await sleep(500); return g; },
    },
    {
      name: 'home-dock-edit', guest: /newtab\.html/, roots: ['#dock'],
      setup: async () => { await activate(homeTab); const g = await guest(/newtab\.html/); await g.ev('(window.__applyApps({ pins: ' + JSON.stringify(PINS) + ' }), document.getElementById("dock").scrollIntoView({ block: "center" }), document.getElementById("dock-edit").click(), 1)'); await sleep(400); return g; },
      teardown: async (g) => g && g.ev('(() => { const b = document.getElementById("dock-edit"); if (b && b.getAttribute("aria-pressed") === "true") b.click(); scrollTo(0, 0); return 1; })()'),
    },
    {
      name: 'history-page', guest: /historypage\.html/, roots: ['body'],
      setup: async () => { const id = await openTab(await ev('History.pageUrl()')); const g = await guest(/historypage\.html/); await sleep(900); g.__tab = id; return g; },
      teardown: async (g) => g && ev(`(closeTab(${JSON.stringify(g.__tab)}), 1)`),
    },
    {
      name: 'reader', guest: /reader\.html/, roots: ['body', '#reader'],
      setup: async () => { await activate(pageTab); await ev('(Reader.open(), 1)'); const g = await guest(/reader\.html/); await sleep(1200); g.__tab = await ev('getActiveTab().id'); return g; },
      teardown: async (g) => { if (g) await ev(`(closeTab(${JSON.stringify(g.__tab)}), 1)`); await activate(pageTab); },
    },
    {
      name: 'phone', guest: /phone\.html/, roots: ['body'],
      setup: async () => { const id = await openTab(await ev('PHONE_URL')); const g = await guest(/phone\.html/); await sleep(1500); g.__tab = id; return g; },
      teardown: async (g) => { if (g) await ev(`(() => { const t = tabs.find((x) => /phone\\.html/.test(x.url || '')); if (t) closeTab(t.id); return 1; })()`); await ev('(switchWorkspace(DEFAULT_WORKSPACE_ID), 1)'); await activate(pageTab); },
    },
    {
      name: 'welcome', guest: /welcome\.html/, roots: ['body'],
      setup: async () => { await ev('(FirstRun.open(), 1)'); const g = await guest(/welcome\.html/); await sleep(1200); return g; },
      teardown: async () => { await ev(`(() => { for (const t of tabs.slice()) if (/welcome\\.html/.test(t.url || '')) closeTab(t.id); return 1; })()`); await activate(pageTab); },
    },
  ].filter((s) => !ONLY.length || ONLY.includes(s.name));

  for (const size of SIZES) {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    for (const theme of THEMES) {
      await ev('QuartzTheme.setMode(' + JSON.stringify(theme) + ').then(() => 1)');
      await sleep(700);
      const viewTag = size.name + '-' + theme;
      const sheetItems = [];
      for (const s of SCENES) {
        if (s.wideOnly && size.name !== 'wide') continue;
        const tag = viewTag + ' ' + s.name;
        let g = null, n = 0, bad = 0;
        try {
          await closeAll();
          const r = await s.setup();
          g = s.guest ? (r && r.ev ? r : await guest(s.guest)) : null;
          const c = g || chrome;
          if (g) await g.waitFor('document.documentElement.getAttribute("data-theme") === ' + JSON.stringify(theme) + ' || !document.documentElement.hasAttribute("data-theme")', 4000).catch(() => 0);
          const pages = s.pages ? 14 : 1;
          for (let pg = 0; pg < pages; pg++) {
            const res = await audit(c, s.name, tag, s.roots, viewTag);
            n += res.n;
            const mine = res.out.map((f) => Object.assign(f, { allowed: !!allowed(f), why: (allowed(f) || {}).why }));
            findings.push(...mine);
            bad += mine.filter((f) => !f.allowed).length;
            sheetItems.push({ b64: res.full, label: s.name + (pages > 1 ? ' p' + (pg + 1) : '') + ' - ' + mine.filter((f) => !f.allowed).length + ' findings', bad: mine.some((f) => !f.allowed), boxes: mine.filter((f) => !f.allowed).map((f) => f.r) });
            if (pages > 1) {
              const more = await c.ev(`(() => { const p = document.querySelector('#settings-panel .set-body') || document.querySelector('#settings-panel'); const before = p.scrollTop; p.scrollTop += p.clientHeight * 0.85; return p.scrollTop > before + 4; })()`);
              if (!more) break;
              await sleep(250);
            }
          }
          check(n > 0 && bad === 0, `${tag}: ${n} controls, no overlaps/clips/crowded targets`, bad ? findings.filter((f) => f.tag === tag && !f.allowed).slice(0, 4).map((f) => f.kind + ' ' + f.d + ' ' + (f.detail || '')).join(' | ') : (n ? undefined : 'the scene did not open (no controls under ' + s.roots.join(',') + ')'));
        } catch (e) {
          check(false, `${tag}: HARNESS ERROR ${e && e.message || e}`);
        }
        try { if (s.teardown) await s.teardown(g); } catch (e) { say('teardown ' + s.name + ': ' + e.message); }
        if (g) { await g.ev('(window.__ov && __ov.still(false), 1)').catch(() => 0); }
      }
      await closeAll();
      try {
        const b64 = await chrome.ev('__ov.sheet(' + JSON.stringify(sheetItems) + ', 4, 420, ' + JSON.stringify('Quartz overlap audit - ' + viewTag + ' - ' + new Date().toISOString().slice(0, 16)) + ')');
        fs.writeFileSync(path.join(OUT, 'sheets', viewTag + '.png'), Buffer.from(b64, 'base64'));
        say('sheet ' + path.join(OUT, 'sheets', viewTag + '.png'));
      } catch (e) { say('sheet failed: ' + e.message); }
    }
  }
  await chrome.send('Emulation.clearDeviceMetricsOverride');
  const byKind = {};
  for (const f of findings.filter((x) => !x.allowed)) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify({ at: new Date().toISOString(), byKind, findings }, null, 1));
  say('findings ' + findings.filter((x) => !x.allowed).length + ' (' + Object.entries(byKind).map(([k2, v]) => k2 + ' ' + v).join(', ') + '), allowed ' + findings.filter((x) => x.allowed).length + ' -> ' + path.join(OUT, 'findings.json'));
  for (const g of guests.values()) g.close();
  srv.close();
  await q.quit();
});
