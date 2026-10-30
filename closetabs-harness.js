// closetabs-harness.js - pure-node test for closetabs.js (run: node closetabs-harness.js).
// The argv shapes are the ones a caller builds: "<Quartz.exe>" "<app dir>" --close-tabs=... --keep=...
// and the reordered one Chromium hands 'second-instance' (switches first, its own added).
const path = require('path');
const CT = require('./closetabs');
const { urlFromArgv } = require('./argvurl');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function ok(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('FAIL ' + name + (detail ? '\n  ' + detail : '')); }
}

const EXE = path.join(__dirname, 'node_modules', 'electron', 'dist', 'Quartz.exe');
const ROOT = __dirname;
const req = (...rest) => CT.requestFromArgv([EXE, ROOT, ...rest]);
const refused = (name, r, words) => {
  ok(name + ': refused', !!r && r.ok === false, JSON.stringify(r));
  ok(name + ': says why (' + words + ')', !!r && typeof r.reason === 'string' && r.reason.includes(words), r && r.reason);
};

/* ---- argv: what counts as a close request ---------------------------------------------------- */

eq('no switches: not a close request', req('https://a.test/'), null);
eq('no args at all', CT.requestFromArgv([EXE, ROOT]), null);
eq('not an array', CT.requestFromArgv(undefined), null);
eq('a lookalike switch is not ours', req('--close-tabsx=http://a.test/', '--keeper=http://a.test/'), null);

eq('one prefix', req('--close-tabs=http://localhost:4830/'),
  { ok: true, close: ['http://localhost:4830/'], keep: [] });
eq('prefix plus keeps', req('--close-tabs=http://localhost:4830/', '--keep=http://localhost:4830/keep-me/', '--keep=http://localhost:4830/b/'),
  { ok: true, close: ['http://localhost:4830/'], keep: ['http://localhost:4830/keep-me/', 'http://localhost:4830/b/'] });
eq('Chromium order: switches first, its own added, app dir after', CT.requestFromArgv([EXE, '--allow-file-access-from-files',
  '--keep=http://localhost:4830/k/', '--close-tabs=http://localhost:4830/', '--original-process-start-time=1', ROOT]),
  { ok: true, close: ['http://localhost:4830/'], keep: ['http://localhost:4830/k/'] });
eq('switch name in capitals (Chromium lower-cases names on Windows; either works)', req('--CLOSE-TABS=http://a.test/'),
  { ok: true, close: ['http://a.test/'], keep: [] });
eq('several --close-tabs, duplicates once', req('--close-tabs=http://a.test/', '--close-tabs=https://b.test/x', '--close-tabs=http://a.test/'),
  { ok: true, close: ['http://a.test/', 'https://b.test/x'], keep: [] });
eq('a value with "=" in it splits at the first "="', req('--close-tabs=http://a.test/p?x=1&y=2'),
  { ok: true, close: ['http://a.test/p?x=1&y=2'], keep: [] });
eq('canonical: host lower-cased, a missing path gains "/"', req('--close-tabs=HTTP://LocalHost:4830'),
  { ok: true, close: ['http://localhost:4830/'], keep: [] });
eq('canonical: default port dropped', req('--close-tabs=http://localhost:80/x'),
  { ok: true, close: ['http://localhost/x'], keep: [] });
eq('surrounding spaces trimmed', req('--close-tabs=  http://a.test/  '),
  { ok: true, close: ['http://a.test/'], keep: [] });
eq('nothing after a bare "--" is a switch', req('--', '--close-tabs=http://a.test/'), null);

/* ---- argv: refusals, each with its reason ------------------------------------------------------ */

refused('empty value', req('--close-tabs='), 'is empty');
refused('blank value', req('--close-tabs=   '), 'is empty');
refused('bare switch (the space form)', req('--close-tabs', 'http://localhost:4830/'), 'write it with "="');
refused('star', req('--close-tabs=*'), 'wildcards are not supported');
refused('star inside an address', req('--close-tabs=http://localhost:*/'), 'wildcards are not supported');
refused('bare scheme http://', req('--close-tabs=http://'), 'names no host');
refused('bare scheme https://', req('--close-tabs=https://'), 'names no host');
refused('three slashes (the URL parser would invent a host)', req('--close-tabs=http:///localhost/'), 'names no host');
refused('port with no host', req('--close-tabs=http://:4830/'), 'not a valid address');
refused('host of dots only', req('--close-tabs=http://./'), 'names no host');
refused('no scheme', req('--close-tabs=localhost:4830/'), 'only http:// and https://');
refused('file:', req('--close-tabs=file:///C:/x/'), 'only http:// and https://');
refused('javascript:', req('--close-tabs=javascript:alert(1)'), 'only http:// and https://');
refused('scheme only, no slashes', req('--close-tabs=http:'), 'only http:// and https://');
refused('bad keep refuses the whole line', req('--close-tabs=http://a.test/', '--keep=*'), 'wildcards are not supported');
refused('empty keep refuses the whole line', req('--close-tabs=http://a.test/', '--keep='), '--keep is empty');
refused('keep alone', req('--keep=http://a.test/'), 'on its own closes nothing');
refused('one good, one bad close: refused', req('--close-tabs=http://a.test/', '--close-tabs=*'), 'wildcards');
{
  const r = req('--close-tabs=*', '--keep=');
  ok('two problems: both counted', r && r.reasons && r.reasons.length === 2 && r.reason.includes('1 more problem'), r && r.reason);
}
{
  const long = 'http://' + 'x'.repeat(5000) + '*';
  const r = req('--close-tabs=' + long);
  ok('a huge refused value is quoted short', r && r.reason.length < 400, r && r.reason.length);
}
eq('checkPrefix ok', CT.checkPrefix('https://Example.com/a', '--close-tabs'), { ok: true, prefix: 'https://example.com/a' });

/* ---- the switches never open a tab (argvurl.js skips them) ------------------------------------ */

eq('close-only line: urlFromArgv finds no link', urlFromArgv([EXE, ROOT, '--close-tabs=http://localhost:4830/', '--keep=http://localhost:4830/k/']), null);
eq('close + link: the link is still found', urlFromArgv([EXE, ROOT, '--close-tabs=http://localhost:4830/', 'http://localhost:4830/new/']), 'http://localhost:4830/new/');

/* ---- commandPlan: no window, no tab, no focus for a close on its own -------------------------- */

const good = req('--close-tabs=http://localhost:4830/');
eq('plain link: opens and raises (unchanged)', CT.commandPlan(null, 'https://a.test/'), { close: null, url: 'https://a.test/', raise: true });
eq('bare second launch: raises (unchanged)', CT.commandPlan(null, null), { close: null, url: null, raise: true });
eq('close only: no link, no raise', CT.commandPlan(good, null), { close: good, url: null, raise: false });
eq('close + link: the link opens and raises', CT.commandPlan(good, 'http://localhost:4830/new/'), { close: good, url: 'http://localhost:4830/new/', raise: true });
{
  const bad = req('--close-tabs', 'http://localhost:4830/');
  const plan = CT.commandPlan(bad, urlFromArgv([EXE, ROOT, '--close-tabs', 'http://localhost:4830/']));
  eq('refused + link: the link is NOT opened, no raise', [plan.url, plan.raise, plan.close.ok], [null, false, false]);
}

/* ---- refusalFor: only plain web pages ---------------------------------------------------------- */

eq('page on http', CT.refusalFor({ kind: 'page', url: 'http://a.test/' }), '');
eq('page on https', CT.refusalFor({ kind: 'page', url: 'https://a.test/' }), '');
eq('pinned', CT.refusalFor({ kind: 'page', url: 'http://a.test/', pinned: true }), 'pinned');
eq('claude / terminal', CT.refusalFor({ kind: 'claude', url: '' }), 'not-web');
eq('hosted app', CT.refusalFor({ kind: 'native', url: 'quartz-app://x' }), 'not-web');
eq('catalogue app tab', CT.refusalFor({ kind: 'page', url: 'https://a.test/', app: true }), 'not-web');
eq('the kept phone tab', CT.refusalFor({ kind: 'page', url: 'http://a.test/', kept: true }), 'not-web');
eq('a bundled page (file:)', CT.refusalFor({ kind: 'page', url: 'file:///C:/q/newtab.html' }), 'not-web');
eq('nothing', CT.refusalFor(null), 'not-web');

/* ---- planClose ---------------------------------------------------------------------------------- */

const P = (id, url, extra) => Object.assign({ id, kind: 'page', url, pinned: false, app: false, kept: false, workspace: 'main' }, extra || {});
const L = 'http://localhost:4830/';
function plan(rows, args, ctx) { return CT.planClose(rows, req(...args), ctx || { activeId: rows[0] && rows[0].id, lastActive: {} }); }

{
  const rows = [P(1, 'https://news.test/'), P(2, L + 'a/'), P(3, L + 'b/'), P(4, L + 'keep-me/'), P(5, 'http://localhost:48300/')];
  const r = plan(rows, ['--close-tabs=' + L, '--keep=' + L + 'keep-me/'], { activeId: 1, lastActive: {} });
  eq('closes the matches, keeps the --keep, leaves other hosts', r.close, [2, 3]);
  eq('counts', [r.matched, r.kept, r.pinned, r.notWeb, r.spared], [3, 1, 0, 0, 0]);
  eq('toast', CT.toastText(r), 'Closed 2 tabs (1 kept by --keep)');
  ok('log line is a sentence', /^Closed 2 tabs starting with http:\/\/localhost:4830\/, asked for on the command line; left open: 1 kept by --keep\.$/.test(CT.logText(r)), CT.logText(r));
}
{
  const rows = [P(1, 'https://news.test/'), P(2, 'http://localhost:4830/x')];
  const r = plan(rows, ['--close-tabs=http://localhost:4830'], { activeId: 1 });
  eq('a host-only prefix gains its "/" and still matches', r.close, [2]);
  const r2 = plan([P(1, 'https://news.test/'), P(2, 'http://localhost:48300/x')], ['--close-tabs=http://localhost:4830'], { activeId: 1 });
  eq('...and never a longer port', r2.close, []);
  eq('one tab: singular', CT.toastText(r), 'Closed 1 tab');
}
{
  const rows = [P(1, 'https://news.test/'), P(2, L + 'p/', { pinned: true }), P(3, L + 'app/', { app: true }),
    { id: 4, kind: 'claude', url: '', workspace: 'main' }, { id: 5, kind: 'native', url: '', workspace: 'main' }, P(6, L + 'z/')];
  const r = plan(rows, ['--close-tabs=' + L], { activeId: 1 });
  eq('pinned, app tabs, Claude, native: never closed', r.close, [6]);
  eq('the left-alone ones are counted', [r.pinned, r.notWeb], [1, 1]);
  eq('toast names them', CT.toastText(r), 'Closed 1 tab (1 pinned, 1 not a plain web page)');
}
{
  // The window's only workspace, every tab a stale preview: the one on screen stays.
  const rows = [P(1, L + 'a/'), P(2, L + 'b/'), P(3, L + 'c/')];
  const r = plan(rows, ['--close-tabs=' + L], { activeId: 2, lastActive: { main: 2 } });
  eq('never the last tab: the active one stays', r.close, [1, 3]);
  eq('spared counted', r.spared, 1);
  eq('toast says so', CT.toastText(r), 'Closed 2 tabs (1 left as the last tab)');
}
{
  const rows = [P(1, L + 'only/')];
  const r = plan(rows, ['--close-tabs=' + L], { activeId: 1 });
  eq('a window of one tab: nothing closes', r.close, []);
  eq('...and the toast says why', CT.toastText(r), 'Closed no tabs (1 left as the last tab)');
  ok('...log too', CT.logText(r).includes('1 left as the last tab'), CT.logText(r));
}
{
  // Two workspaces. "work" would empty: its remembered tab stays. "main" keeps a survivor of its own.
  const rows = [P(1, 'https://news.test/'), P(2, L + 'a/'), P(3, L + 'b/', { workspace: 'work' }), P(4, L + 'c/', { workspace: 'work' })];
  const r = plan(rows, ['--close-tabs=' + L], { activeId: 1, lastActive: { work: 3 } });
  eq('another workspace never empties: its last-shown tab stays', r.close, [2, 4]);
  const r2 = plan(rows, ['--close-tabs=' + L], { activeId: 1, lastActive: {} });
  eq('...no last-shown tab: its last one stays', r2.close, [2, 3]);
}
{
  const rows = [P(1, L + 'a/'), P(2, L + 'b/'), P(3, 'https://news.test/'), P(4, L + 'c/')];
  const r = plan(rows, ['--close-tabs=' + L], { activeId: 2 });
  eq('the tab in front closes LAST', r.close, [1, 4, 2]);
}
{
  const rows = [P(1, 'https://news.test/'), P(2, 'HTTP://LOCALHOST:4830/a/'), P(3, 'https://other.test/q'), P(4, 'not a url')];
  const r = plan(rows, ['--close-tabs=' + L, '--close-tabs=https://other.test/'], { activeId: 1 });
  eq('several prefixes; tab addresses compared canonically; junk skipped', r.close, [2, 3]);
}
{
  const rows = [P(1, 'https://news.test/'), P(2, 'file:///C:/q/newtab.html'), P(3, 'http://localhost:4830/')];
  const r = plan(rows, ['--close-tabs=http://localhost:4831/'], { activeId: 1 });
  eq('nothing matched', [r.close, r.matched], [[], 0]);
  eq('toast for nothing matched', CT.toastText(r), 'No open tabs start with http://localhost:4831/');
  ok('log for nothing matched', /^Closing tabs from the command line found none starting with http:\/\/localhost:4831\/\.$/.test(CT.logText(r)), CT.logText(r));
}
{
  // A plan re-checks what it was handed: a request built by hand cannot slip a wildcard through.
  const forged = { ok: true, close: ['*'], keep: [] };
  const r = CT.planClose([P(1, L), P(2, L + 'x')], forged, { activeId: 1 });
  eq('forged request: refused', r.ok, false);
  ok('...with the reason', String(r.reason).includes('wildcards'), r.reason);
  eq('forged keep: refused', CT.planClose([P(1, L)], { ok: true, close: [L], keep: ['ftp://x/'] }, {}).ok, false);
  eq('empty close list: refused', CT.planClose([P(1, L)], { ok: true, close: [], keep: [] }, {}).ok, false);
  eq('a refused request plans nothing', CT.planClose([P(1, L)], req('--close-tabs=*'), {}).ok, false);
}

/* ---- refusal words reach the user ------------------------------------------------------------- */

{
  const bad = req('--close-tabs=*');
  ok('refusal toast says why', CT.toastText(bad).startsWith("Didn't close any tabs: --close-tabs=* is refused: wildcards"), CT.toastText(bad));
  ok('refusal toast mentions a dropped link', CT.toastText(bad, 'The link on the same command line was not opened either.').endsWith('not opened either.'), CT.toastText(bad, 'x'));
  ok('refusal log line is a sentence', /^Refused to close tabs from the command line: .+\.$/.test(CT.logText(bad)), CT.logText(bad));
  ok('second launch prints the refusal', CT.handedText(bad).startsWith('[close-tabs] refused: --close-tabs=* is refused'), CT.handedText(bad));
  ok('second launch prints the hand-over', CT.handedText(req('--close-tabs=' + L, '--keep=' + L + 'k/')).includes('close ' + L + '; keep ' + L + 'k/'),
    CT.handedText(req('--close-tabs=' + L)));
}

console.log(`closetabs-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
