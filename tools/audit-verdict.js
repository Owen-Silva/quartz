#!/usr/bin/env node
'use strict';
// tools/audit-verdict.js -- the verdict of `npm audit --omit=dev` for the ci workflow's audit job.
//
//   node tools/audit-verdict.js --check-lock [package-lock.json]   is electron visible to npm audit?
//   node tools/audit-verdict.js audit.json                          one verdict line from the JSON report
//
// Both print one line and exit 0 on a pass, 1 otherwise. The ci job judges by the line it prints
// (`npm-audit: runtime deps: 0 critical, 0 high, ...` is the only pass); the exit code is a convenience.
//
// WHY THE CASTLABS BUILD NEEDS A CHECK. Electron is a git dependency here
// (`github:castlabs/electron-releases#vX.Y.Z+wvcus`), not a registry package. npm audit still covers it:
// it matches by the lockfile's name and version (`electron`, `X.Y.Z+wvcus`), and semver ignores the
// `+wvcus` build tag, so the castlabs build is audited as upstream electron@X.Y.Z. That is the right
// verdict: a castlabs release is upstream Electron at that version plus Widevine, so upstream's
// advisories apply to it. Two things would make the verdict untrue, and this file handles both:
//   - an unversioned git entry in the lockfile: audit would skip electron without a word and pass.
//     --check-lock fails in that case instead.
//   - npm says "No fix available" for an electron advisory, because it cannot move a git dependency.
//     There usually is a fix: a newer castlabs tag at or above the advisory's patched version. The
//     verdict says so (and tools/check-electron.js lists the tags).
//
// Pure functions are exported for tests/audit-verdict-test.js.

const fs = require('fs');
const path = require('path');

/** Electron's lockfile entry -> { ok, line }. */
function checkLock(lock) {
  const e = lock && lock.packages && lock.packages['node_modules/electron'];
  if (!e) return { ok: false, line: 'npm-audit: package-lock.json has no node_modules/electron entry; the audit cannot cover Electron' };
  const m = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(\+[0-9A-Za-z.-]+)?$/.exec(e.version || '');
  if (!m) return { ok: false, line: 'npm-audit: package-lock.json has no semver version for electron (' + (e.version || 'none') + '); npm audit would skip it' };
  const src = String(e.resolved || 'the npm registry').split('#')[0];
  return { ok: true, line: 'npm-audit: electron ' + e.version + ' (' + src + ') is audited as upstream electron@' + m[1] };
}

/** The parsed `npm audit --json` report (or null) -> { ok, line }. */
function verdict(report) {
  const v = report && report.metadata && report.metadata.vulnerabilities;
  if (!v || typeof v.high !== 'number' || typeof v.critical !== 'number') {
    const why = (report && report.error && (report.error.summary || report.error.code)) || 'npm audit returned no report';
    return { ok: false, line: 'npm-audit: NO VERDICT (' + why + ')' };
  }
  const hot = Object.entries(report.vulnerabilities || {})
    .filter(([, x]) => x && (x.severity === 'high' || x.severity === 'critical'))
    .map(([name, x]) => name + ' (' + x.severity + ': ' +
      (name === 'electron' ? 'needs a newer castlabs tag, see tools/check-electron.js'
        : x.fixAvailable ? 'fix available' : 'no fix yet') + ')');
  const line = 'npm-audit: runtime deps: ' + v.critical + ' critical, ' + v.high + ' high, ' +
    (v.moderate | 0) + ' moderate, ' + (v.low | 0) + ' low' + (hot.length ? ' | ' + hot.join(', ') : '');
  return { ok: v.critical === 0 && v.high === 0, line };
}

module.exports = { checkLock, verdict };

if (require.main === module) {
  const args = process.argv.slice(2);
  let r;
  if (args[0] === '--check-lock') {
    const file = path.resolve(args[1] || 'package-lock.json');
    let lock = null;
    try { lock = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* reported below */ }
    r = lock ? checkLock(lock) : { ok: false, line: 'npm-audit: cannot read ' + file };
  } else {
    let report = null;
    try { report = JSON.parse(fs.readFileSync(path.resolve(args[0] || 'audit.json'), 'utf8')); } catch (e) { /* NO VERDICT */ }
    r = verdict(report);
  }
  console.log(r.line);
  process.exitCode = r.ok ? 0 : 1;
}
