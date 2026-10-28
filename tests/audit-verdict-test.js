'use strict';
// tests/audit-verdict-test.js -- tools/audit-verdict.js, the ci workflow's npm audit verdict.
//
// Fixtures shaped like `npm audit --omit=dev --json` (npm 11) and like package-lock.json's electron entry.
// The CI step passes only on a line starting `npm-audit: runtime deps: 0 critical, 0 high,`, so every
// case checks both the ok flag and that the line agrees with it under that same pattern.

const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const { checkLock, verdict } = require('../tools/audit-verdict.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}
const PASS_RE = /^npm-audit: runtime deps: 0 critical, 0 high,/;
function agrees(r) { return PASS_RE.test(r.line) === r.ok; }

const meta = (c, h, m, l) => ({ vulnerabilities: { info: 0, low: l, moderate: m, high: h, critical: c, total: c + h + m + l } });

// --- verdict ---
let r = verdict({ auditReportVersion: 2, vulnerabilities: {}, metadata: meta(0, 0, 0, 0) });
check('clean report passes', r.ok && agrees(r), r.line);

r = verdict({ vulnerabilities: { foo: { severity: 'moderate', fixAvailable: true } }, metadata: meta(0, 0, 1, 0) });
check('moderate only passes (verdict counts high and critical)', r.ok && agrees(r) && / 1 moderate/.test(r.line), r.line);

r = verdict({
  vulnerabilities: {
    electron: { severity: 'high', isDirect: true, fixAvailable: false },
    undici: { severity: 'high', isDirect: false, fixAvailable: true },
  },
  metadata: meta(0, 2, 0, 0),
});
check('high fails', !r.ok && agrees(r), r.line);
check('electron advisory points at a castlabs tag, not "no fix"', /electron \(high: needs a newer castlabs tag/.test(r.line), r.line);
check('fixable transitive advisory says fix available', /undici \(high: fix available\)/.test(r.line), r.line);

r = verdict({ vulnerabilities: { x: { severity: 'critical', fixAvailable: false } }, metadata: meta(1, 0, 0, 0) });
check('critical fails, no fix yet named', !r.ok && agrees(r) && /x \(critical: no fix yet\)/.test(r.line), r.line);

r = verdict({ error: { code: 'ENOAUDIT', summary: 'Your configured registry does not support audit requests.' } });
check('audit endpoint error is NO VERDICT and fails', !r.ok && agrees(r) && /NO VERDICT \(Your configured registry/.test(r.line), r.line);

r = verdict(null);
check('missing or unparseable report fails', !r.ok && agrees(r) && /NO VERDICT/.test(r.line), r.line);

r = verdict({ vulnerabilities: {}, metadata: {} });
check('report without counts fails', !r.ok && agrees(r), r.line);

// --- checkLock ---
const lock = (e) => ({ lockfileVersion: 3, packages: e === undefined ? {} : { 'node_modules/electron': e } });
r = checkLock(lock({ version: '44.5.1+wvcus', resolved: 'git+ssh://git@github.com/castlabs/electron-releases.git#9b90904' }));
check('castlabs git entry is audited as upstream x.y.z', r.ok && /audited as upstream electron@44\.5\.1$/.test(r.line) && !/#/.test(r.line), r.line);
r = checkLock(lock({ version: '44.9.3', resolved: 'https://registry.npmjs.org/electron/-/electron-44.9.3.tgz' }));
check('registry electron passes', r.ok && /electron@44\.9\.3$/.test(r.line), r.line);
r = checkLock(lock({ resolved: 'git+ssh://git@github.com/castlabs/electron-releases.git#abc' }));
check('unversioned git entry fails (audit would skip it)', !r.ok && /no semver version/.test(r.line), r.line);
r = checkLock(lock(undefined));
check('no electron entry fails', !r.ok && /no node_modules\/electron entry/.test(r.line), r.line);

// --- the real lockfile, and the CLI's exit code ---
const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
r = checkLock(real);
check('this repo\'s package-lock.json: electron is visible to npm audit', r.ok, r.line);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-verdict-'));
try {
  const f = path.join(tmp, 'audit.json');
  fs.writeFileSync(f, JSON.stringify({ vulnerabilities: {}, metadata: meta(0, 0, 0, 0) }));
  let p = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'audit-verdict.js'), f], { encoding: 'utf8' });
  check('CLI: clean report exits 0 with the pass line', p.status === 0 && PASS_RE.test(p.stdout), p.stdout + p.stderr);
  fs.writeFileSync(f, '{"not json');
  p = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'audit-verdict.js'), f], { encoding: 'utf8' });
  check('CLI: broken JSON exits 1 with NO VERDICT', p.status === 1 && /NO VERDICT/.test(p.stdout), p.stdout + p.stderr);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('audit-verdict: ' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
