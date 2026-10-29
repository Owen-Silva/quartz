// testwatch-harness.js -- pure-node tests for testwatch.js waitChromeBooted (run: node testwatch-harness.js).
// No Electron. The expression waitChromeBooted sends is evaluated for real, in a vm context that plays
// the chrome window through its boot, phase by phase:
//   0 loading     index.html's head: app.js not evaluated yet (createTab, tabs, viewsEl undefined)
//   1 scripts     app.js evaluated, Drm's state answered by main, init() NOT run (viewsEl null, no tabs):
//                 the gap the drm e2e tests used to act in, where createTab() returns null
//   2 init        DOMContentLoaded ran init(): the strip is bound, the session read still in flight
//   3 booted      the boot strip is built (one tab)
// A fake clock steps the phases, so the timings it reports are exact.
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { waitChromeBooted, CHROME_BOOTED } = require('./testwatch');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function ok(name, cond, info) {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (info === undefined ? '' : '\n  ' + JSON.stringify(info))); }
}

/** A chrome whose phase is a function of the fake clock: phases[i] starts at ms[i]. */
function fakeChrome(at, opts) {
  const o = opts || {};
  let t = 0;
  const clock = { now: () => t, sleep: async (n) => { t += n; } };
  const phaseNow = () => { let p = 0; for (let i = 0; i < at.length; i++) if (t >= at[i]) p = i; return p; };
  const ev = async (expr) => {
    if (o.rejectUntil && t < o.rejectUntil) throw new Error('Cannot find context with specified id');
    const p = phaseNow();
    const g = { window: {} };
    if (p >= 1) {
      g.createTab = function () { return g.viewsEl ? { id: 1 } : null; };
      g.openWatchTab = function () { return !!g.createTab(); };
      g.viewsEl = null; g.tabs = []; g.restoring = false;
      if (!o.noDrm) g.window.Drm = { state: () => ({ widevine: { available: false } }) };
    }
    if (p >= 2) g.viewsEl = { id: 'views' };
    if (p >= 3) g.tabs = [{ id: 1 }];
    if (o.restoring && p >= 3) g.restoring = true;
    g.window.window = g.window;
    const ctx = vm.createContext(Object.assign(g, { window: g.window }));
    // Drm lives on window in the page; here window IS the global, as in a browser.
    if (g.window.Drm) ctx.Drm = g.window.Drm;
    ctx.window = ctx;
    return vm.runInContext(expr, ctx);
  };
  return { ev, clock, phaseNow };
}

const DRM = '!!(window.Drm && window.Drm.state())';

(async () => {
  // ---- the expression itself, phase by phase ---------------------------------------------------
  {
    const c = fakeChrome([0, 100, 200, 300]);
    const probe = (extra) => '(() => { try { return !!(' + CHROME_BOOTED + (extra ? ' && (' + extra + ')' : '') + '); } catch (e) { return "threw"; } })()';
    eq('phase 0 (loading): not booted, and no throw', await c.ev(probe(DRM)), false);
    await c.clock.sleep(100);
    eq('phase 1 (scripts only): not booted', await c.ev(probe(DRM)), false);
    eq('phase 1: the old readiness check WOULD have passed here', await c.ev('!!(window.Drm && typeof createTab === "function" && window.Drm.state())'), true);
    eq('phase 1: and createTab() really returns null here', await c.ev('createTab("x")'), null);
    await c.clock.sleep(100);
    eq('phase 2 (init ran, no strip yet): not booted', await c.ev(probe(DRM)), false);
    await c.clock.sleep(100);
    eq('phase 3 (strip built): booted', await c.ev(probe(DRM)), true);
    eq('phase 3: createTab() gives a tab', await c.ev('createTab("x").id'), 1);
  }

  // ---- waitChromeBooted waits through the gap and reports it -----------------------------------
  {
    const c = fakeChrome([0, 400, 1200, 1300]);
    const lines = [];
    const r = await waitChromeBooted(c.ev, DRM, 10000, (l) => lines.push(l), Object.assign({ poll: 50 }, c.clock));
    eq('gap: resolves only once booted (phase 3)', c.phaseNow(), 3);
    eq('gap: scripts first answered at 400 ms', r.scriptsMs, 400);
    eq('gap: booted at 1300 ms', r.bootedMs, 1300);
    eq('gap: one evidence line', lines.length, 1);
    ok('gap: the line names both times and the gap', /booted 1300 ms .*answered at 400 ms .*900 ms/.test(lines[0] || ''), lines);
  }
  {
    const c = fakeChrome([0, 0, 0, 0]);
    const lines = [];
    const r = await waitChromeBooted(c.ev, DRM, 10000, (l) => lines.push(l), c.clock);
    eq('already booted: answers on the first poll, no gap recorded', r, { scriptsMs: null, bootedMs: 0 });
    ok('already booted: the line says they answered together', /together/.test(lines[0] || ''), lines);
  }
  {
    // CDP errors while the page is still coming up are retried, never fatal.
    const c = fakeChrome([0, 300, 600, 700], { rejectUntil: 500 });
    const r = await waitChromeBooted(c.ev, DRM, 10000, null, c.clock);
    eq('rejecting evaluate: retried until booted', r.bootedMs, 700);
  }
  {
    // The test's own condition is ANDed in: no Drm state, no boot, however ready the strip is.
    const c = fakeChrome([0, 100, 200, 300], { noDrm: true });
    let err = null;
    try { await waitChromeBooted(c.ev, DRM, 2000, null, c.clock); } catch (e) { err = e.message; }
    ok('extra false: times out', /never booted in 2000 ms/.test(err || ''), err);
    ok('extra false: says the scripts never answered', /scripts never answered/.test(err || ''), err);
  }
  {
    // An extra that THROWS (window.Drm missing, .state() on undefined) is "not yet", not a crash.
    const c = fakeChrome([0, 100, 200, 300], { noDrm: true });
    let err = null;
    try { await waitChromeBooted(c.ev, 'window.Drm.state() !== null', 1000, null, c.clock); } catch (e) { err = e.message; }
    ok('extra throws: times out with the reason', /never booted in 1000 ms.*last: /.test(err || ''), err);
  }
  {
    // Stuck in the gap (init never runs): the error says the scripts answered and init never followed.
    const c = fakeChrome([0, 100, 1e9, 1e9]);
    let err = null;
    try { await waitChromeBooted(c.ev, DRM, 3000, null, c.clock); } catch (e) { err = e.message; }
    ok('stuck in the gap: names when the scripts answered', /answered at 100 ms, init\(\)\/the boot strip never followed/.test(err || ''), err);
  }
  {
    // restoring true means restoreSession() is mid-build: not booted.
    const c = fakeChrome([0, 100, 200, 300], { restoring: true });
    let err = null;
    try { await waitChromeBooted(c.ev, DRM, 1000, null, c.clock); } catch (e) { err = e.message; }
    ok('restoring: not booted', /never booted/.test(err || ''), err);
  }

  // ---- the three drm e2e files wait for the boot before they act -------------------------------
  for (const f of ['drm-e2e.js', 'drm-castlabs-e2e.js', 'drm-route-e2e.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const wait = src.indexOf('await waitChromeBooted((e) => chrome.ev(e)');
    const act = Math.min(...['createTab(', '(openWatchTab()'].map((s) => { const i = src.indexOf(s, wait < 0 ? 0 : wait); return i < 0 ? Infinity : i; }));
    ok(f + ': waits for the boot with waitChromeBooted', wait > 0);
    ok(f + ': the wait comes before the first tab it opens', wait > 0 && act > wait && act !== Infinity, { wait, act });
    ok(f + ': no bare "typeof createTab/openWatchTab" readiness wait left',
      !/waitFor\('!!\(window\.Drm[^']*typeof (createTab|openWatchTab) === "function"/.test(src));
  }

  console.log(`testwatch-harness: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('HARNESS ERROR ' + (e && e.stack || e)); console.log(`testwatch-harness: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
