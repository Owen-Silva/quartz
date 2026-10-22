'use strict';
/*
 * updater-e2e.js -- the in-app updater in a REAL Quartz, end to end, against a local fake release.
 *
 *   node tests/updater-e2e.js [--shots=<dir>]     -> "updater-e2e: N passed, M failed"
 *
 * What it builds, all under %TEMP%:
 *   - origin.git: a bare clone of this repo's HEAD (what is COMMITTED is what is tested);
 *   - a release: one more commit on origin's default branch, tagged v99.0.0;
 *   - app: a normal clone of origin.git, with node_modules as a junction to this repo's own
 *     node_modules (so no install; the release changes no package file, so npm ci never runs, and
 *     a test profile refuses npm ci anyway);
 *   - a fake GitHub releases API on 127.0.0.1 answering /repos/Owen-Silva/quartz/releases/latest.
 * Then Quartz starts from app (--test-profile, its own temp profile, off-screen, watched by
 * testwatch.js) with QUARTZ_TEST_UPDATER_API / _REPO pointing at the fakes, and the test checks:
 *   1. the card renders ("Quartz v99.0.0 is out", an Update button);
 *   2. pressing Update walks downloading -> installing -> restarting and Quartz quits by itself;
 *   3. Quartz comes back on its own (app.relaunch, same command line), app's HEAD is the tag, the
 *      release's file is there, and the card says "Quartz is now on v99.0.0".
 * Kills only the processes it started (matched by this run's unique --profile-name), removes the
 * junction before anything else in the temp folder, and refuses to launch under MIN_FREE_GB.
 */
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const { Cdp, sleep } = require('./e2e-kit');
const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher } = require(path.join(REPO, 'testwatch'));
const U = require(path.join(REPO, 'updater'));

const shotsArg = process.argv.find((a) => a.startsWith('--shots='));
const SHOTS = shotsArg ? shotsArg.slice(8) : '';
const TAG = 'v99.0.0';
const PROFILE = 'qup-e2e-' + process.pid;
const PROFILE_DIR = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-updater-e2e-'));
const PORT = 9300 + (process.pid % 400);

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log('PASS ' + label); }
  else { fail++; console.log('FAIL ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 400))); }
}
const say = (l) => console.log('     ' + l);
const GITC = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];
function git(cwd, ...args) { return execFileSync('git', GITC.concat(args), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

/** Main-process pids of OUR Quartz (this run's profile name, no --type=). */
function ourMainPids() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*--profile-name=" + PROFILE + "*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { $_.ProcessId }"],
    { encoding: 'utf8' });
    return out.split(/\s+/).map(Number).filter(Boolean);
  } catch (e) { return []; }
}
function killPid(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ } }

async function chromeTarget(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
      const ct = list.find((x) => x.type === 'page' && /index\.html/.test(String(x.url)));
      if (ct) return ct;
    } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  return null;
}

async function main() {
  const free = freeRamGb();
  if (!(free >= MIN_FREE_GB)) { console.log('updater-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }

  // ---- the world --------------------------------------------------------------------------------
  const origin = path.join(WORK, 'origin.git');
  const pub = path.join(WORK, 'pub');
  const app = path.join(WORK, 'app');
  git(WORK, 'clone', '-q', '--bare', '--no-local', REPO, origin);
  const branch = git(origin, 'symbolic-ref', '--short', 'HEAD');
  // The user's clone first, THEN the release lands on origin: the clone is one commit behind it.
  git(WORK, 'clone', '-q', origin, app);
  const oldSha = git(app, 'rev-parse', 'HEAD');
  git(WORK, 'clone', '-q', origin, pub);
  fs.writeFileSync(path.join(pub, 'UPDATED-TO-V99.txt'), 'This file arrived with the fake release ' + TAG + '.\n');
  git(pub, 'add', '-A'); git(pub, 'commit', '-q', '-m', 'Fake release ' + TAG); git(pub, 'tag', TAG);
  git(pub, 'push', '-q', 'origin', branch, TAG);
  const tagSha = git(pub, 'rev-parse', 'HEAD');
  if (tagSha === oldSha) throw new Error('the fake release is not newer than the clone');
  const nmTarget = fs.realpathSync(path.join(REPO, 'node_modules'));
  execFileSync('cmd', ['/c', 'mklink', '/J', path.join(app, 'node_modules'), nmTarget], { stdio: 'ignore' });
  check(fs.existsSync(path.join(app, 'node_modules', 'electron', 'dist', 'electron.exe')), 'app clone ready on ' + branch + ' at ' + oldSha.slice(0, 7) + ', release ' + TAG + ' at ' + tagSha.slice(0, 7));

  // ---- the fake GitHub --------------------------------------------------------------------------
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/repos/Owen-Silva/quartz/releases/latest') {
      res.writeHead(200, { 'content-type': 'application/json', etag: '"fake-' + TAG + '"' });
      res.end(JSON.stringify({ tag_name: TAG, name: 'Quartz ' + TAG, html_url: 'http://127.0.0.1/' + TAG, body: 'A fake release.', target_commitish: branch }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = 'http://127.0.0.1:' + server.address().port;

  // ---- launch -----------------------------------------------------------------------------------
  const watcher = startWatcher(say);
  await watcher.ready;
  const env = Object.assign({}, process.env, {
    QUARTZ_TEST_UPDATER_API: api, QUARTZ_TEST_UPDATER_REPO: origin, QUARTZ_TEST_UPDATER_FIRST_MS: '1500',
  });
  const exe = path.join(app, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(exe, ['.', '--remote-debugging-port=' + PORT, '--test-profile', '--profile-name=' + PROFILE, ...OFFSCREEN_ARGS], { cwd: app, stdio: 'ignore', env });
  let gone = false;
  child.on('exit', () => { gone = true; });
  watcher.watch(child.pid);
  say('quartz pid ' + child.pid + ' on :' + PORT);
  try {
    let ct = await chromeTarget(40000);
    if (!ct) throw new Error('the chrome page never came up');
    let c = await new Cdp(ct.webSocketDebuggerUrl).open();
    const card = await c.waitFor("(() => { const k = document.querySelector('.qup-card[data-status=available]'); return k && k.classList.contains('is-up') ? k.textContent : ''; })()", 40000)
      .catch(async (e) => { say('no card; updater state: ' + JSON.stringify(await c.ev('window.api.updates.state()').catch((x) => x.message)).slice(0, 600)); return null; });
    check(typeof card === 'string' && card.includes('Quartz ' + TAG + ' is out'), 'the card renders: "Quartz ' + TAG + ' is out"', card);
    const btn = await c.ev("(() => { const b = document.querySelector('.qup-card [data-act=update]'); return b ? b.textContent : ''; })()");
    check(btn === 'Update', 'the card offers the Update button', btn);
    check(hits.includes('/repos/Owen-Silva/quartz/releases/latest'), 'Quartz asked the (fake) releases API');
    const st = await c.ev('window.api.updates.state()');
    check(st && st.status === 'available' && st.canUpdate && !st.needsNpm, 'state: available, button offered, no npm ci', st && { status: st.status, blocked: st.blocked });

    if (SHOTS) {
      try {
        await sleep(400);   // the card's one fade-in
        const r = await c.ev("(() => { const b = document.querySelector('.qup-card').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()");
        const pad = 24;
        const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + 2 * pad, height: r.h + 2 * pad, scale: 1 } });
        const full = await c.send('Page.captureScreenshot', { format: 'png' });
        fs.mkdirSync(SHOTS, { recursive: true });
        if (shot.result && shot.result.data) fs.writeFileSync(path.join(SHOTS, 'update-card.png'), Buffer.from(shot.result.data, 'base64'));
        if (full.result && full.result.data) fs.writeFileSync(path.join(SHOTS, 'update-card-window.png'), Buffer.from(full.result.data, 'base64'));
        say('screenshots in ' + SHOTS);
      } catch (e) { say('screenshot failed: ' + e.message); }
    }

    // ---- Settings > About > Updates ---------------------------------------------------------------
    await c.ev("Settings.open('About'), 1");
    const about = await c.waitFor("(() => { const f = document.querySelector('[data-field=updates]'); if (!f) return null; const l = f.querySelector('.qup-about-line'); return l && /is out/.test(l.textContent) ? { line: l.textContent, buttons: [...f.querySelectorAll('button')].map((b) => b.textContent) } : null; })()", 15000).catch((e) => ({ error: e.message }));
    check(about && /Quartz v99\.0\.0 is out/.test(about.line || '') && about.buttons.includes('Check for updates') && about.buttons.includes('Update to ' + TAG) && about.buttons.includes('Check now'),
      'Settings > About shows the release, the switch, Update and Check now', about);
    if (SHOTS) {
      try {
        const full = await c.send('Page.captureScreenshot', { format: 'png' });
        if (full.result && full.result.data) fs.writeFileSync(path.join(SHOTS, 'settings-about-updates.png'), Buffer.from(full.result.data, 'base64'));
      } catch (e) { say('screenshot failed: ' + e.message); }
    }
    await c.ev("(typeof Settings.close === 'function' && Settings.close()), 1").catch(() => 0);

    // ---- Update ---------------------------------------------------------------------------------
    await c.ev("window.__qupSeen = []; window.api.updates.onState((s) => window.__qupSeen.push(s.status + ':' + (s.progress ? s.progress.stage : ''))); document.querySelector('.qup-card [data-act=update]').click(); 1");
    let seen = [];
    const t0 = Date.now();
    while (!gone && Date.now() - t0 < 60000) {
      try { seen = await c.ev('window.__qupSeen.slice()'); } catch (e) { /* the page is going */ }
      await sleep(100);
    }
    try { c.close(); } catch (e) { /* closed */ }
    check(gone, 'Quartz quit by itself after Update', { seen });
    const stages = seen.filter((x) => x.startsWith('updating:')).map((x) => x.split(':')[1]);
    check(stages.includes('downloading') && stages.includes('installing') && stages[stages.length - 1] === 'restarting', 'progress: downloading -> installing -> restarting', seen);
    check(git(app, 'rev-parse', 'HEAD') === tagSha && fs.existsSync(path.join(app, 'UPDATED-TO-V99.txt')), 'the app folder is on ' + TAG + ' (git merge --ff-only), the release file is there');
    check(git(app, 'status', '--porcelain', '--untracked-files=no') === '', 'the app folder has no local changes after the update');

    // ---- the relaunch ---------------------------------------------------------------------------
    let pids = [];
    for (let i = 0; i < 100 && !pids.length; i++) { pids = ourMainPids(); if (!pids.length) await sleep(300); }
    if (pids.length) watcher.watch(pids[0]);
    check(pids.length === 1, 'Quartz started again by itself (app.relaunch, same command line)', pids);
    ct = await chromeTarget(40000);
    check(!!ct, 'the relaunched chrome came up on the same debugging port');
    if (ct) {
      c = await new Cdp(ct.webSocketDebuggerUrl).open();
      const done = await c.waitFor("(() => { const k = document.querySelector('.qup-card[data-status=updated]'); return k ? k.textContent : ''; })()", 30000);
      check(typeof done === 'string' && done.includes('Quartz is now on ' + TAG), 'after the restart the card says "Quartz is now on ' + TAG + '"', done);
      const s2 = await c.ev('window.api.updates.state()');
      // 'current' once the first check after the restart has run; updated stays set either way.
      check(s2 && /^(updated|current)$/.test(s2.status) && s2.updated && s2.updated.tag === TAG && s2.current && tagSha.startsWith(s2.current.sha),
        'state: updated to ' + TAG + ', current sha is the tag', s2 && { status: s2.status, updated: s2.updated, current: s2.current });
      if (SHOTS) {
        try {
          const shot = await c.send('Page.captureScreenshot', { format: 'png' });
          if (shot.result && shot.result.data) fs.writeFileSync(path.join(SHOTS, 'updated-card-window.png'), Buffer.from(shot.result.data, 'base64'));
        } catch (e) { say('screenshot failed: ' + e.message); }
      }
      try { c.close(); } catch (e) { /* closed */ }
    }
  } finally {
    for (const pid of ourMainPids()) killPid(pid);
    if (!gone) killPid(child.pid);
    await sleep(1200);
    const v = watcher.verdict(); check(v.ok, v.line); watcher.stop();
    server.close();
  }
}

main().catch((e) => { fail++; console.log('FAIL HARNESS ERROR ' + (e && e.stack || e)); }).then(async () => {
  for (const pid of ourMainPids()) killPid(pid);
  // The junction first (rmdir only: its target is this repo's real node_modules), then the rest.
  try { execFileSync('cmd', ['/c', 'rmdir', path.join(WORK, 'app', 'node_modules')], { stdio: 'ignore' }); } catch (e) { /* not made */ }
  if (fs.existsSync(path.join(WORK, 'app', 'node_modules'))) console.log('     the node_modules junction is still there; leaving ' + WORK + ' in place');
  else { try { U.removeTree(WORK); } catch (e) { say('could not remove ' + WORK + ': ' + e.message); } }
  for (let i = 0; i < 10; i++) { try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
  console.log('updater-e2e: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
