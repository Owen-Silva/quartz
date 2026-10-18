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

console.log('golive-procs-test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
