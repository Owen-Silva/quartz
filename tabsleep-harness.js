'use strict';
// tabsleep-harness.js - the boot and background sleep DECISIONS in app.js, pure node, no Quartz.
//   node tabsleep-harness.js
// app.js is a plain renderer script (no exports), so the pure pieces are cut out of its source
// by name and run in a vm: restoreAsleepRows() (lazy restore: which stored rows are born asleep
// and which one is predicted in front), newTabSleepVerdict() (what to do with a new tab page
// that has sat in the background), and HOME_BUSY_PROBE (the page-side check that keeps a Home
// holding typed text awake), run against a tiny fake document.
// The live paths (a real restore, a real sleep and wake) are sessions-e2e.js / sleep-e2e.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail))); }
}

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

/** The source of `function <name>(...) { ... }`, by brace matching from its first `{`. */
function cutFunction(name) {
  const at = src.indexOf('\nfunction ' + name + '(');
  if (at === -1) throw new Error('app.js has no function ' + name);
  let i = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at + 1, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}
function cutConst(name, endMarker) {
  const at = src.indexOf('\nconst ' + name + ' = ');
  if (at === -1) throw new Error('app.js has no const ' + name);
  const end = src.indexOf(endMarker, at);
  return src.slice(at + 1, end + endMarker.length);
}

const ctx = vm.createContext({});
vm.runInContext(
  cutFunction('restoreAsleepRows') + '\n' + cutFunction('newTabSleepVerdict') + '\n'
  + cutConst('HOME_BUSY_PROBE', "'})()';") + '\n'
  + 'this.restoreAsleepRows = restoreAsleepRows; this.newTabSleepVerdict = newTabSleepVerdict;'
  + ' this.HOME_BUSY_PROBE = HOME_BUSY_PROBE;', ctx);
const { restoreAsleepRows, newTabSleepVerdict, HOME_BUSY_PROBE } = ctx;

const rows = (entries) => entries.map((entry, index) => ({ entry, index }));
const sorted = (set) => Array.from(set).sort((a, b) => a - b);

// --- lazy restore ---------------------------------------------------------
{
  // Five pages in Home, the third in front: only it is awake.
  const r = rows([{ url: 'a', ws: 'home' }, { url: 'b', ws: 'home' }, { url: 'c', ws: 'home' }, { url: 'd', ws: 'home' }, { url: 'e', ws: 'home' }]);
  const p = restoreAsleepRows(r, 2, 'home', true, true);
  ok('5 tabs: front is the stored active row', p.front === 2, p.front);
  ok('5 tabs: the other 4 are born asleep', JSON.stringify(sorted(p.asleep)) === '[0,1,3,4]', sorted(p.asleep));
  ok('5 tabs: exactly 1 awake', r.length - p.asleep.size === 1);
  // Lazy off (a sleep setting is off): the current workspace comes back awake, as before.
  const off = restoreAsleepRows(r, 2, 'home', true, false);
  ok('lazy off: nothing in the current workspace is born asleep', off.asleep.size === 0, sorted(off.asleep));
  // Both off (workspaceSleep "off"): nothing at all.
  ok('workspaceSleep off: nothing born asleep', restoreAsleepRows(r, 2, 'home', false, false).asleep.size === 0);
}
{
  // Other workspaces: born asleep exactly as before, pinned or not.
  const r = rows([{ url: 'p', ws: 'home', pinned: true }, { url: 'a', ws: 'home' }, { url: 'x', ws: 'ws2', pinned: true }, { url: 'y', ws: 'ws2' }, { url: 'b', ws: 'home' }]);
  const p = restoreAsleepRows(r, 4, 'home', true, true);
  ok('pinned in the current workspace stays awake', !p.asleep.has(0));
  ok('non-front page in the current workspace sleeps', p.asleep.has(1));
  ok('other workspace: pinned and plain both asleep', p.asleep.has(2) && p.asleep.has(3));
  ok('front awake', p.front === 4 && !p.asleep.has(4));
  const old = restoreAsleepRows(r, 4, 'home', true, false);
  ok('lazy off: only the other workspace sleeps (old rule)', JSON.stringify(sorted(old.asleep)) === '[2,3]', sorted(old.asleep));
}
{
  // Claude panes and native app tabs are never born asleep, in either workspace.
  const r = rows([{ claude: true, ws: 'home' }, { native: 'app1', ws: 'home' }, { url: 'a', ws: 'home' }, { claude: true, ws: 'ws2' }, { native: 'app2', ws: 'ws2' }, { url: 'b', ws: 'home' }]);
  const p = restoreAsleepRows(r, 5, 'home', true, true);
  ok('claude + native never born asleep', ![0, 1, 3, 4].some((i) => p.asleep.has(i)), sorted(p.asleep));
  ok('page beside them sleeps', p.asleep.has(2) && !p.asleep.has(5));
}
{
  // Active row in another workspace (or missing): the front is the LAST row of the current one,
  // which is what restoreSession() raises afterwards.
  const r = rows([{ url: 'a', ws: 'home' }, { url: 'b', ws: 'home' }, { url: 'x', ws: 'ws2' }]);
  const p = restoreAsleepRows(r, 2, 'home', true, true);
  ok('active elsewhere: front = last row of current', p.front === 1, p.front);
  ok('active elsewhere: that row awake, the other asleep', !p.asleep.has(1) && p.asleep.has(0));
  const q = restoreAsleepRows(r, -1, 'home', true, true);
  ok('no active (-1): front = last row of current', q.front === 1, q.front);
  // Nothing in the current workspace: the pool is every row, the active one wins.
  const s = restoreAsleepRows(r, 2, 'gone', true, true);
  ok('empty current workspace: active row is the front', s.front === 2, s.front);
  // ...and it is born asleep by the OTHER-workspace rule; activateTab() wakes it (one renderer).
  ok('empty current workspace: every page asleep, activation wakes one', s.asleep.size === 3);
}
{
  // The front row may be pinned or a new tab page; build order is pinned first.
  const r = [{ entry: { url: 'p', ws: 'home', pinned: true }, index: 3 }, { entry: { url: 'a', ws: 'home' }, index: 0 }, { entry: { url: 'newtab', ws: 'home' }, index: 1 }, { entry: { url: 'c', ws: 'home' }, index: 2 }];
  const p = restoreAsleepRows(r, 1, 'home', true, true);
  ok('pinned-first order: front follows the stored index', p.front === 1);
  ok('pinned-first order: asleep = the two plain pages', JSON.stringify(sorted(p.asleep)) === '[0,2]', sorted(p.asleep));
  ok('empty list: no front, nothing asleep', restoreAsleepRows([], 0, 'home', true, true).front === -1);
}
{
  // restoreSession() actually uses the plan (source check, the e2e proves it live).
  const body = cutFunction('restoreSession');
  ok('restoreSession builds from restoreAsleepRows', /restoreAsleepRows\(building, session\.active, wantCurrent, sleepOthers, lazyRestore\)/.test(body));
  ok('restoreSession: bornAsleep comes from the plan', /const bornAsleep = plan\.asleep\.has\(row\.index\)/.test(body));
  ok('restoreSession: lazy gate is backgroundSleepAllowed()', /lazyRestore = backgroundSleepAllowed\(\)/.test(body));
  const gate = cutFunction('backgroundSleepAllowed');
  ok('gate: off when workspaceSleep is off or tab sleep is Never', /workspaceSleepMode\(\) !== 'off' && tabSleepMinutes\(\) > 0/.test(gate));
}

// --- new tab page backgrounded ---------------------------------------------
{
  const base = { gone: false, allowed: true, asleep: false, onScreen: false, newTab: true, inCurrentWorkspace: true, broken: false, ready: true };
  const v = (over) => newTabSleepVerdict(Object.assign({}, base, over));
  ok('eligible background Home: probe', v({}) === 'probe');
  ok('closed: skip', v({ gone: true }) === 'skip');
  ok('setting off: skip', v({ allowed: false }) === 'skip');
  ok('back in front: skip', v({ onScreen: true }) === 'skip');
  ok('already asleep: skip', v({ asleep: true }) === 'skip');
  ok('navigated to a site: skip (idle rule owns it)', v({ newTab: false }) === 'skip');
  ok('other workspace: skip (workspace policy owns it)', v({ inCurrentWorkspace: false }) === 'skip');
  ok('crash card: skip', v({ broken: true }) === 'skip');
  ok('still loading: retry', v({ ready: false }) === 'retry');
  ok('null facts: skip', newTabSleepVerdict(null) === 'skip');
}
{
  // The probe, against a fake document.
  const run = (doc) => vm.runInNewContext(HOME_BUSY_PROBE, { document: doc });
  const fakeDoc = (inputs, editables, dialog) => ({
    querySelectorAll: (sel) => (sel === 'input, textarea' ? inputs : (sel === '[contenteditable]' ? editables : [])),
    querySelector: (sel) => (sel === 'dialog[open]' && dialog ? {} : null)
  });
  ok('probe: empty Home is free to sleep', run(fakeDoc([{ type: 'text', value: '', defaultValue: '' }], [], false)) === '');
  ok('probe: typed text keeps it awake', run(fakeDoc([{ type: 'text', value: 'half a url', defaultValue: '' }], [], false)) === 'unsaved text');
  ok('probe: a prefilled default is not "typed"', run(fakeDoc([{ type: 'text', value: 'x', defaultValue: 'x' }], [], false)) === '');
  ok('probe: checkbox / hidden ignored', run(fakeDoc([{ type: 'checkbox', value: 'on', defaultValue: '' }, { type: 'hidden', value: 'v', defaultValue: '' }], [], false)) === '');
  ok('probe: textarea draft keeps it awake', run(fakeDoc([{ type: 'textarea', value: 'note', defaultValue: '' }], [], false)) === 'unsaved text');
  ok('probe: contenteditable with text keeps it awake', run(fakeDoc([], [{ isContentEditable: true, textContent: ' draft ' }], false)) === 'unsaved text');
  ok('probe: open dialog keeps it awake', run(fakeDoc([], [], true)) === 'an open dialog');
}
{
  // The wiring: activateTab hands the outgoing tab to the rule, sleepTab stops the clock.
  const act = cutFunction('activateTab');
  ok('activateTab: outgoing tab goes to noteTabBackgrounded', /noteTabBackgrounded\(outgoing\)/.test(act));
  ok('activateTab: incoming tab stops its clock', /cancelNewTabSleep\(target\)/.test(act));
  ok('sleepTab: cancels the clock', /cancelNewTabSleep\(tab\)/.test(cutFunction('sleepTab')));
  const sl = cutFunction('sleepBackgroundNewTab');
  ok('sleepBackgroundNewTab: re-checks after the probe answers', (sl.match(/newTabSleepVerdict\(newTabSleepFacts\(tab\)\)/g) || []).length >= 2);
  ok('sleepBackgroundNewTab: a refusal is logged, not swallowed', /tab-sleep-skipped/.test(sl));
}

console.log('\n' + pass + ' pass / ' + fail + ' fail');
process.exitCode = fail ? 1 : 0;
