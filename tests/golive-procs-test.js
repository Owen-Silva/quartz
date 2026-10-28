'use strict';
/*
 * golive-procs-test.js -- the go-live scripts count their processes as ARRAYS.
 *
 * PowerShell unrolls a one-element array on return: `function Main-Procs { return @(...) }` hands a
 * single CimInstance back when ONE Quartz runs, and `$main.Count` on it is empty. The close step then
 * read "nothing to close", skipped closing Quartz and passed (main found it 10-18). Every call site
 * must wrap the call, `@(Main-Procs)` / `@(Test-Procs)`. This reads both scripts' text and fails on
 * any assignment of a bare call.
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log('PASS ' + label); }
  else { fail++; console.log('FAIL ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail))); }
}

const SCRIPTS = ['tools/lumen-golive.ps1', 'tools/quartz-ff-golive.ps1'];
const BARE = /=\s*(Main-Procs|Test-Procs)\b/;          // `$x = Main-Procs` (no @( ) around it)
const WRAPPED = /@\(\s*(Main-Procs|Test-Procs)\s*\)/g;   // `@(Main-Procs)`

// The check itself, on known text first: it must catch the bug and pass the fix.
check(BARE.test('$main = Main-Procs') && BARE.test('      $left = Test-Procs'), 'the pattern catches a bare `= Main-Procs` / `= Test-Procs`');
check(!BARE.test('$main = @(Main-Procs)') && !BARE.test('$up = @( Test-Procs )'), 'the pattern passes the wrapped form');

for (const rel of SCRIPTS) {
  const file = path.join(__dirname, '..', rel);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { text = ''; }
  check(text.length > 0, rel + ': present');
  if (!text) continue;
  const lines = text.split(/\r?\n/);
  const bare = [];
  lines.forEach((l, i) => {
    const code = l.replace(/#.*$/, '');                    // a comment may name the bug
    if (/^\s*function\s+(Main-Procs|Test-Procs)\b/.test(code)) return;
    if (BARE.test(code)) bare.push((i + 1) + ': ' + l.trim().slice(0, 80));
  });
  check(bare.length === 0, rel + ': no `= Main-Procs` / `= Test-Procs` without @( )', bare);
  const wrapped = (text.match(WRAPPED) || []).length;
  check(wrapped >= 3, rel + ': its process counts go through @(Main-Procs) / @(Test-Procs) (' + wrapped + ' sites)', wrapped);
  // A bare `.Count` straight on a call is the same bug in another form.
  const direct = lines.filter((l) => /\(\s*(Main-Procs|Test-Procs)\s*\)\.Count/.test(l) && !/@\(\s*(Main-Procs|Test-Procs)\s*\)\.Count/.test(l));
  check(direct.length === 0, rel + ': no (Main-Procs).Count without @', direct);
}
const ff = (() => { try { return fs.readFileSync(path.join(__dirname, '..', 'tools/quartz-ff-golive.ps1'), 'utf8'); } catch { return ''; } })();
const verdicts = ff.split(/\r?\n/).filter((l) => /verdict/.test(l) && /Write-Output/.test(l));
check(verdicts.length >= 1 && verdicts.every((l) => /'ff-golive: /.test(l)), 'quartz-ff-golive.ps1: every verdict line says ff-golive:', verdicts.map((l) => l.trim().slice(0, 50)));

// A DEPENDENCY RELEASE (lockfile or install fields changed, e.g. a castlabs Electron bump) must be
// refused before Quartz closes, and the refusal must carry the exact command that does take it:
// a STOP that only names a script leaves the operator to guess the flags, and a forced code-only
// go-live would leave the live copy on the old Electron.
const ffLines = ff.split(/\r?\n/);
const ffCode = ffLines.filter((l) => !/^\s*#/.test(l));
const depFn = (() => {
  const i = ffLines.findIndex((l) => /^function Dependency-Release\b/.test(l));
  if (i < 0) return '';
  const j = ffLines.findIndex((l, k) => k > i && /^}/.test(l));
  return ffLines.slice(i, j < 0 ? undefined : j + 1).join('\n');
})();
check(!!depFn, 'quartz-ff-golive.ps1: has a Dependency-Release refusal helper');
check(/lumen-golive\.ps1/.test(depFn) && /-Ref '\s*\+\s*\$Ref/.test(depFn) && /-Repo/.test(depFn) && /-DryRun/.test(depFn),
  'quartz-ff-golive.ps1: the refusal names lumen-golive.ps1 with -Repo, -Ref <the same ref> and -DryRun', depFn.slice(0, 120));
check(/castlabs_evs\.account reauth/.test(depFn) && /drm-rollback\.ps1/.test(depFn),
  'quartz-ff-golive.ps1: the refusal says EVS must be signed in and how to roll back');
const lockStop = ffCode.filter((l) => /package-lock\.json/.test(l) && /Stop-Golive/.test(l));
check(lockStop.length >= 1 && lockStop.every((l) => /Stop-Golive \(Dependency-Release/.test(l)),
  'quartz-ff-golive.ps1: a lockfile change STOPs through Dependency-Release', lockStop.map((l) => l.trim().slice(0, 80)));
const bareSwapStop = ffCode.filter((l) => /Stop-Golive/.test(l) && /lumen-golive\.ps1/.test(l));
check(bareSwapStop.length === 0, 'quartz-ff-golive.ps1: no STOP names lumen-golive.ps1 without the full command', bareSwapStop.map((l) => l.trim().slice(0, 80)));
// The lockfile STOP comes before Quartz is closed (step 2), so a refused release changes nothing.
const at = (re) => ffLines.findIndex((l) => re.test(l));
const lockAt = at(/Stop-Golive \(Dependency-Release 'package-lock\.json/);
const closeAt = at(/^# ---- 2\. close Quartz/);
check(lockAt > 0 && closeAt > lockAt, 'quartz-ff-golive.ps1: the lockfile refusal runs before the close step', { lockAt, closeAt });

console.log('golive-procs-test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
