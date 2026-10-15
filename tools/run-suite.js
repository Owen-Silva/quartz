try { require('C:/Users/you/tools/lowcpu.js'); } catch (e) { /* not on this machine (a cloud runner): no cap needed */ }   // first: one capped browser at a time (The user, 2026-09-17)
// tools/run-suite.js -- every Quartz harness, one after another, and ONE summary line.
//
//   node tools/run-suite.js [--unit] [--only=a,b] [--skip=a,b] [--out=<dir>] [--timeout=<s>]
//
//   --unit       pure-node harnesses only (no Electron): seconds, safe on any machine.
//   --only/skip  test names (the left column below), comma separated.
//   --out        writes <dir>/suite.txt, <dir>/suite.json and <dir>/logs/<name>.txt.
//
// The Electron ones (e2e) launch a REAL off-screen test instance each (--test-profile --offscreen,
// watched by testwatch.js), one at a time. Each refuses to launch under 2.5 GB free RAM (exit 3),
// which shows here as SKIP with that reason, never as a pass. On the user's laptop that is the usual
// case, so run them in the cloud: `cloudtest --recipe quartz-core`.
//
// A test passes when it exits 0 AND its own summary line ("<name>: N passed, M failed" or
// "smoke: N ok, M failed") says 0 failed. No summary line = FAIL, whatever the exit code.
// The last line is the verdict:
//   quartz-suite: 17 files: 15 pass, 0 FAIL, 2 skipped | checks 812 passed, 0 failed
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (k) => { const a = args.find((x) => x === '--' + k || x.startsWith('--' + k + '=')); return a === undefined ? null : (a.includes('=') ? a.slice(a.indexOf('=') + 1) : true); };
const list = (k) => { const v = flag(k); return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []; };
const UNIT_ONLY = !!flag('unit');
const ONLY = list('only');
const SKIP = list('skip');
const OUT = typeof flag('out') === 'string' ? path.resolve(flag('out')) : null;
const TIMEOUT_S = Number(flag('timeout')) || 0;

const exists = (p) => { try { return fs.existsSync(p); } catch (e) { return false; } };
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

/*
 * The manifest. `needs` returns why a test cannot run HERE (it is then SKIP, with the reason),
 * or null. Unit tests first: they are seconds, and a broken module shows before any launch.
 */
const TESTS = [
  { name: 'argvurl', file: 'argvurl-harness.js' },
  { name: 'bravesearch', file: 'bravesearch-harness.js' },
  { name: 'drm', file: 'drm-harness.js' },
  { name: 'favicons', file: 'favicons-harness.js' },
  // Drives an instance it does not start itself (CDP_PORT): the suite launches one for it.
  { name: 'files', file: 'files-harness.js', launch: 9241, e2e: true },
  { name: 'keywords', file: 'keywords-harness.js' },
  { name: 'log', file: 'log-harness.js' },
  { name: 'profilemove', file: 'profilemove-harness.js' },
  // session.json's writer: a refused rename (a scanner holding the file) keeps the snapshot.
  { name: 'sessionfile', file: 'sessionfile-harness.js' },
  { name: 'toprow', file: 'toprow-harness.js' },
  { name: 'log-e2e', file: 'log-e2e.js', e2e: true },
  { name: 'log-e2e-nogate', file: 'log-e2e.js', args: ['--no-gate', '--cdp', '9428'], e2e: true },
  { name: 'drm-e2e', file: 'drm-e2e.js', e2e: true },
  { name: 'favicons-e2e', file: 'favicons-e2e.js', e2e: true },
  // Site logos outside the tab strip (bookmarks bar, new tab page, history page), and no request
  // to a Google favicon host anywhere.
  { name: 'pagefavicons-e2e', file: 'pagefavicons-e2e.js', e2e: true },
  { name: 'bravesearch-e2e', file: 'bravesearch-e2e.js', e2e: true },
  { name: 'toprow-e2e', file: 'toprow-e2e.js', e2e: true },
  // The daily paths (tests/e2e-kit.js): session restore across restarts, tab sleep and wake,
  // find in page, downloads, the address bar.
  { name: 'sessions-e2e', file: 'sessions-e2e.js', e2e: true },
  { name: 'sleep-e2e', file: 'sleep-e2e.js', e2e: true },
  { name: 'find-e2e', file: 'find-e2e.js', e2e: true },
  { name: 'downloads-e2e', file: 'downloads-e2e.js', e2e: true },
  { name: 'omnibox-e2e', file: 'omnibox-e2e.js', e2e: true },
  // Drives the shared look file with looksync/fake-writer.js (vendored, so it runs anywhere).
  { name: 'looksync-e2e', file: 'looksync-e2e.js', e2e: true },
  {
    name: 'smoke', file: 'smoketest.js', args: [path.join(os.tmpdir(), 'quartz-suite-smoke')], e2e: true,
    // Not on a cloud runner: the terminal needs node-pty built for Electron, and there is no
    // Electron prebuild of @homebridge/node-pty-prebuilt-multiarch and its npm package lacks the
    // winpty sources to build one (tried on a runner: gyp 'deps/winpty/src/winpty.gyp not found').
    needs: () => {
      const why = [];
      if (!exists(path.join(ROOT, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch', 'build', 'Release', 'conpty.node'))) why.push('node-pty built for Electron (node_modules/@homebridge/node-pty-prebuilt-multiarch/build/Release/conpty.node; no Electron prebuild exists and the package cannot be built from npm)');
      if (!exists(path.join(os.homedir(), '.local', 'bin', 'claude.exe'))) why.push('claude.exe at ~/.local/bin');
      return why.length ? 'opens a Claude Code pane: needs ' + why.join(' and ') + ', not on this machine' : null;
    },
  },
];

const SUMMARY = /^(?:\S.*?): (\d+) (?:passed|ok), (\d+) failed/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * For a harness that drives an instance it does not start (t.launch = its CDP port): the same
 * off-screen test instance the e2e files start, watched by testwatch.js, killed by ITS pid only,
 * its temp profile deleted. Returns { env, stop() } or { skip: reason }.
 */
async function launchFor(t) {
  const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher } = require(path.join(ROOT, 'testwatch'));
  const free = freeRamGb();
  if (!(free >= MIN_FREE_GB)) return { skip: `${t.name}: not launched: ${free.toFixed(2)} GB free RAM, needs ${MIN_FREE_GB} GB` };
  const profile = 'suite' + t.name + process.pid;
  const watcher = startWatcher(() => {});
  await watcher.ready;
  const child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + t.launch, '--test-profile', '--profile-name=' + profile, ...OFFSCREEN_ARGS], { cwd: ROOT, stdio: 'ignore' });
  watcher.watch(child.pid);
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await (await fetch('http://127.0.0.1:' + t.launch + '/json')).json()).some((x) => x.type === 'page' && /index\.html/.test(String(x.url))); } catch (e) { /* not yet */ }
    if (!up) await sleep(250);
  }
  if (up) await sleep(2500); // the chrome's own boot (tabs, settings) after the page target exists
  return {
    up,
    env: Object.assign({}, process.env, { CDP_PORT: String(t.launch) }),
    async stop() {
      const v = watcher.verdict();
      watcher.stop();
      try { require('child_process').execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ }
      await sleep(1200);
      for (let i = 0; i < 10; i++) { try { fs.rmSync(path.join(os.tmpdir(), 'browser-test-profile-' + profile), { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
      return v;
    },
  };
}

async function runLaunched(t) {
  const inst = await launchFor(t);
  if (inst.skip) return { name: t.name, file: t.file, status: 'SKIP', why: inst.skip, ms: 0, passed: 0, failed: 0, failLines: [], text: inst.skip };
  if (!inst.up) { await inst.stop(); return { name: t.name, file: t.file, status: 'FAIL', why: 'the test instance never came up on :' + t.launch, ms: 0, passed: 0, failed: 1, failLines: [], text: '' }; }
  const r = await runOne(t, inst.env);
  const v = await inst.stop();
  if (!v.ok) { r.status = 'FAIL'; r.failed++; r.why += ' | ' + v.line; }
  else r.passed++; // the off-screen watch is a check too
  return r;
}

function runOne(t, env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = [];
    const child = spawn(process.execPath, [path.join(ROOT, t.file), ...(t.args || [])], { cwd: ROOT, env: env || process.env, windowsHide: true });
    const limit = (TIMEOUT_S || (t.e2e ? 300 : 90)) * 1000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (e) { child.kill(); } }, limit);
    const take = (d) => { const s = String(d); out.push(s); if (process.env.SUITE_ECHO === '1') process.stdout.write(s); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.join('');
      const lines = text.split(/\r?\n/);
      let summary = null;
      for (let i = lines.length - 1; i >= 0; i--) { const m = SUMMARY.exec(lines[i].trim()); if (m) { summary = { line: lines[i].trim(), passed: Number(m[1]), failed: Number(m[2]) }; break; } }
      let status, why = '';
      if (timedOut) { status = 'FAIL'; why = 'timed out after ' + limit / 1000 + ' s'; }
      else if (code === 3 && /not launched: .* GB free RAM/.test(text)) { status = 'SKIP'; why = (lines.find((l) => /not launched/.test(l)) || '').trim(); }
      else if (code === 2 && /cannot run/.test(text)) { status = 'SKIP'; why = (lines.find((l) => /cannot run/.test(l)) || '').trim(); }
      else if (!summary) { status = 'FAIL'; why = 'no summary line (exit ' + code + ')'; }
      else if (summary.failed > 0 || code !== 0) { status = 'FAIL'; why = summary.line + (code !== 0 && summary.failed === 0 ? ' but exit ' + code : ''); }
      else { status = 'PASS'; why = summary.line; }
      const failLines = lines.filter((l) => /^(FAIL|HARNESS ERROR)\b/.test(l.trim())).slice(0, 8);
      resolve({ name: t.name, file: t.file, status, why, ms: Date.now() - t0, passed: summary ? summary.passed : 0, failed: summary ? summary.failed : (status === 'FAIL' ? 1 : 0), failLines, text });
    });
  });
}

(async () => {
  let picked = TESTS.filter((t) => !(UNIT_ONLY && t.e2e));
  if (ONLY.length) picked = picked.filter((t) => ONLY.includes(t.name));
  const unknown = [...ONLY, ...SKIP].filter((n) => !TESTS.some((t) => t.name === n));
  if (unknown.length) { console.log('quartz-suite: unknown test name(s): ' + unknown.join(', ') + ' (known: ' + TESTS.map((t) => t.name).join(', ') + ')'); process.exit(2); }
  if (picked.some((t) => t.e2e) && !exists(ELECTRON)) {
    console.log('quartz-suite: Electron is not installed at ' + ELECTRON + ' (run: node node_modules/electron/install.js); the e2e tests will fail');
  }
  const results = [];
  for (const t of picked) {
    let r;
    if (SKIP.includes(t.name)) r = { name: t.name, file: t.file, status: 'SKIP', why: 'skipped by --skip', ms: 0, passed: 0, failed: 0, failLines: [], text: '' };
    else {
      const blocked = t.needs ? t.needs() : null;
      r = blocked ? { name: t.name, file: t.file, status: 'SKIP', why: blocked, ms: 0, passed: 0, failed: 0, failLines: [], text: '' }
        : t.launch ? await runLaunched(t) : await runOne(t);
    }
    results.push(r);
    console.log(`${r.status.padEnd(4)} ${r.name.padEnd(16)} ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${r.why}`);
    for (const l of r.failLines) console.log('       ' + l.trim().slice(0, 240));
  }
  const n = (s) => results.filter((r) => r.status === s).length;
  const checksPassed = results.reduce((a, r) => a + r.passed, 0);
  const checksFailed = results.reduce((a, r) => a + r.failed, 0);
  const verdict = `quartz-suite: ${results.length} files: ${n('PASS')} pass, ${n('FAIL')} FAIL, ${n('SKIP')} skipped | checks ${checksPassed} passed, ${checksFailed} failed`;
  if (OUT) {
    fs.mkdirSync(path.join(OUT, 'logs'), { recursive: true });
    for (const r of results) if (r.text) fs.writeFileSync(path.join(OUT, 'logs', r.name + '.txt'), r.text);
    fs.writeFileSync(path.join(OUT, 'suite.json'), JSON.stringify({ verdict, at: new Date().toISOString(), results: results.map(({ text, ...r }) => r) }, null, 2));
    fs.writeFileSync(path.join(OUT, 'suite.txt'), results.map((r) => `${r.status} ${r.name} ${(r.ms / 1000).toFixed(1)} s ${r.why}`).join('\n') + '\n' + verdict + '\n');
  }
  console.log(verdict);
  process.exit(n('FAIL') ? 1 : 0);
})();
