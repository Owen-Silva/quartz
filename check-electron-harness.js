'use strict';
// check-electron-harness.js - tools/check-electron.js's pure half, with fixtures. No network,
// no Electron.   node check-electron-harness.js
//
// The script's network half (git ls-remote, releases.json, the GitHub API) is exercised by running
// it; this pins down the parts a wrong answer would come from: reading the pin out of package.json,
// tag parsing and ordering (prereleases before their release, alpha.14 after alpha.9), which tags
// count as "newer", and the verdict's policy windows.
const CE = require('./tools/check-electron');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail))); }
}

// --- parsing ---
ok('pin read from the package.json spec', CE.pinFromPackage('github:castlabs/electron-releases#v44.5.1+wvcus').tag === 'v44.5.1+wvcus');
ok('a non-castlabs spec has no pin', CE.pinFromPackage('^44.5.1') === null);
ok('a tag without +wvcus is not ours', CE.parseTag('v44.5.1') === null);
ok('prerelease parsed', CE.parseTag('v45.0.0-alpha.14+wvcus').pre === 'alpha.14');

// --- ordering ---
const P = (t) => CE.parseTag(t);
ok('patch order', CE.compare(P('v44.9.3+wvcus'), P('v44.5.1+wvcus')) > 0);
ok('numeric, not string, order', CE.compare(P('v44.10.0+wvcus'), P('v44.9.3+wvcus')) > 0);
ok('alpha.14 after alpha.9', CE.compare(P('v45.0.0-alpha.14+wvcus'), P('v45.0.0-alpha.9+wvcus')) > 0);
ok('beta after alpha', CE.compare(P('v45.0.0-beta.1+wvcus'), P('v45.0.0-alpha.14+wvcus')) > 0);
ok('release after its prerelease', CE.compare(P('v45.0.0+wvcus'), P('v45.0.0-beta.1+wvcus')) > 0);

// --- ls-remote output (peeled ^{} lines and non-castlabs tags are folded away) ---
const LS = [
  'aaa\trefs/tags/v44.5.1+wvcus', 'bbb\trefs/tags/v44.5.1+wvcus^{}', 'ccc\trefs/tags/v44.9.3+wvcus',
  'ddd\trefs/tags/v45.0.0-alpha.3+wvcus', 'eee\trefs/tags/v43.8.3+wvcus', 'fff\trefs/tags/some-other-tag',
].join('\n');
const tags = CE.tagsFromLsRemote(LS);
ok('ls-remote: 4 unique castlabs tags, sorted', tags.map((t) => t.tag).join(',') === 'v43.8.3+wvcus,v44.5.1+wvcus,v44.9.3+wvcus,v45.0.0-alpha.3+wvcus', tags.map((t) => t.tag));

// --- plan + verdict ---
const pin = P('v44.5.1+wvcus');
const now = new Date('2026-10-26T12:00:00Z');
let p = CE.plan(tags, pin);
ok('plan: latest same-major is 44.9.3', p.latestSame && p.latestSame.tag === 'v44.9.3+wvcus');
ok('plan: an alpha is never a newer major', p.latestNewerMajor === null);
ok('plan: newer list is stable only by default', p.newer.map((t) => t.tag).join() === 'v44.9.3+wvcus');
ok('plan: --pre lists the alpha too', CE.plan(tags, pin, { pre: true }).newer.length === 2);

let v = CE.verdict(p, pin, { 'v44.9.3+wvcus': '2026-10-22T21:31:20Z' }, now);
ok('verdict: 3 days behind a patch is inside the window', v.level === 'behind' && /patch behind 3 days/.test(v.line), v);
v = CE.verdict(p, pin, { 'v44.9.3+wvcus': '2026-10-10T00:00:00Z' }, now);
ok('verdict: 16 days behind a patch is overdue', v.level === 'overdue' && /BUMP OVERDUE/.test(v.line) && /within 7/.test(v.line), v);
v = CE.verdict(p, pin, {}, now);
ok('verdict: an unknown date says so and is not called overdue', v.level === 'behind' && /\?/.test(v.line), v);

const withMajor = CE.tagsFromLsRemote(LS + '\nggg\trefs/tags/v45.1.0+wvcus\nhhh\trefs/tags/v46.0.0+wvcus');
p = CE.plan(withMajor, pin);
ok('plan: the newest major wins', p.latestNewerMajor.tag === 'v46.0.0+wvcus' && p.newerMajors.length === 2);
v = CE.verdict(p, pin, { 'v46.0.0+wvcus': '2026-10-20T00:00:00Z', 'v44.9.3+wvcus': '2026-10-22T00:00:00Z' }, now);
ok('verdict: major and patch both named', /major behind: v46\.0\.0/.test(v.line) && /patch behind/.test(v.line) && v.level === 'behind', v);
v = CE.verdict(p, pin, { 'v46.0.0+wvcus': '2026-09-01T00:00:00Z', 'v44.9.3+wvcus': '2026-10-22T00:00:00Z' }, now);
ok('verdict: a major out 55 days is overdue', v.level === 'overdue' && /within 21/.test(v.line), v);

const top = P('v44.9.3+wvcus');
v = CE.verdict(CE.plan(tags, top), top, {}, now);
ok('verdict: up to date at the newest stable tag', v.level === 'ok' && /^up to date/.test(v.line), v);

// --- upstream ahead of castlabs ---
const index = new Map([['45.0.0', { version: '45.0.0', chrome: '156.0.8078.48', date: '2026-10-21' }], ['44.9.3', { version: '44.9.3', chrome: '152.0.7977.167', date: '2026-10-21' }]]);
ok('upstream-ahead: names upstream 45 when castlabs has only alphas', /Electron 45\.0\.0 .*Chromium 156/.test(CE.upstreamAhead(index, pin, tags) || ''));
ok('upstream-ahead: silent once castlabs tags it', CE.upstreamAhead(index, pin, CE.tagsFromLsRemote(LS + '\nzzz\trefs/tags/v45.0.0+wvcus')) === null);

ok('days: floors, never negative', CE.daysBetween('2026-10-25T13:00:00Z', now) === 0 && CE.daysBetween(now, '2026-01-01') === 0);

// --- Settings > About's age sentence (settings.js chromiumAgeLine), lifted out of the file ---
{
  // CRLF-normalised: a Windows checkout with core.autocrlf (the CI runner's) has \r\n line ends.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'settings.js'), 'utf8').replace(/\r\n/g, '\n');
  const m = /\n  function chromiumAgeLine\(v, now\) \{[\s\S]*?\n  \}\n/.exec(src);
  ok('about: chromiumAgeLine is in settings.js', !!m);
  if (m) {
    const ageLine = new Function(m[0] + '\nreturn chromiumAgeLine;')(); // node only: a harness, not a page
    const n = new Date('2026-10-26T12:00:00Z');
    const l1 = ageLine({ chrome: '152.0.7977.130', built: '2026-10-03T03:38:22Z' }, n);
    ok('about: 23 days -> "3 weeks ago" and the missing-fixes warning', /Chromium 152\.0\.7977\.130 was built on .*\(3 weeks ago\)\. Chromium ships security fixes/.test(l1), l1);
    const l2 = ageLine({ chrome: '152.0.7977.167', built: '2026-10-22T03:00:00Z' }, n);
    ok('about: 4 days -> no warning', /\(4 days ago\)\.$/.test(l2), l2);
    const l3 = ageLine({ chrome: '152.0.7977.130' }, n);
    ok('about: no build date -> says why, no guess', /cannot be shown: this window did not report when its Electron was built/.test(l3), l3);
    ok('about: no versions at all -> still a sentence', /cannot be shown/.test(ageLine(null, n)));
  }
}

console.log(`check-electron-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
