'use strict';
/*
 * release-signing-test.js -- signed release tags (updater.js "signed release tags", the swap
 * helper's second check, tools/release-tag.js) against throwaway git repos and throwaway ed25519
 * keys in %TEMP%. No network: "origin" is a local bare repo and the releases API is a fake fetch.
 * Needs git 2.34+ and ssh-keygen on PATH (Git for Windows ships both); without them every
 * signature check fails, and so does this harness, with the reason.
 *
 *   node tests/release-signing-test.js   -> "release-signing-test: N passed, M failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const U = require('../updater');
const { cutReleaseTag } = require('../tools/release-tag');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log('PASS ' + label); }
  else { fail++; console.log('FAIL ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 500))); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-signing-test-'));
// Every git here (the updater's and the release tool's included) gets the same identity, no CRLF
// conversion, and never signs on its own because of a global tag.gpgSign / commit.gpgSign.
const CFG = { 'core.autocrlf': 'false', 'user.name': 'Test', 'user.email': 'test@example.invalid', 'init.defaultBranch': 'master', 'tag.gpgSign': 'false', 'commit.gpgSign': 'false' };
process.env.GIT_CONFIG_COUNT = String(Object.keys(CFG).length);
Object.keys(CFG).forEach((k, i) => { process.env['GIT_CONFIG_KEY_' + i] = k; process.env['GIT_CONFIG_VALUE_' + i] = CFG[k]; });
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function gitTry(cwd, ...args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }; }
function write(dir, rel, text) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
const fwd = (p) => p.split(path.sep).join('/');
const PKG = (v) => JSON.stringify({ name: 'browser', version: v, dependencies: {} }, null, 2) + '\n';

/** A throwaway ed25519 key: { priv, pub (the "type base64" pair), fp, line(principal) }. */
function makeKey(name) {
  const priv = path.join(ROOT, 'key-' + name);
  const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test-' + name, '-f', priv], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ssh-keygen could not make a test key: ' + (r.error ? r.error.message : r.stderr));
  const [type, b64] = fs.readFileSync(priv + '.pub', 'utf8').trim().split(/\s+/);
  const fp = 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '');
  return { priv, type, b64, fp, line: (principal) => (principal || 'quartz-release') + ' namespaces="git" ' + type + ' ' + b64 };
}
const signersText = (...keys) => '# test signers\n\n' + keys.map((k) => k.line()).join('\n') + '\n';

/** Tag HEAD of `dir`: how = 'signed' (with key), 'annotated' (unsigned), 'light'. */
function tagAt(dir, tag, how, key, rev) {
  if (how === 'signed') git(dir, '-c', 'gpg.format=ssh', '-c', 'user.signingkey=' + fwd(key.priv), '-c', 'gpg.ssh.program=ssh-keygen', 'tag', '-s', tag, '-m', 'Quartz ' + tag, rev || 'HEAD');
  else if (how === 'annotated') git(dir, 'tag', '-a', tag, '-m', 'Quartz ' + tag, rev || 'HEAD');
  else git(dir, 'tag', tag, rev || 'HEAD');
}

let n = 0;
/** origin.git (bare), pub (the maintainer's clone), app (the user's install). seedFiles go in the first commit. */
function world(seedFiles) {
  const dir = path.join(ROOT, 'w' + (++n));
  const seed = path.join(dir, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'master');
  write(seed, 'package.json', PKG('0.1.0'));
  write(seed, 'package-lock.json', '{"lockfileVersion":3}\n');
  write(seed, 'main.js', '// one\n');
  for (const [k, v] of Object.entries(seedFiles || {})) write(seed, k, v);
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'one'); git(seed, 'tag', 'v0.1.0');
  const origin = path.join(dir, 'origin.git');
  git(dir, 'clone', '-q', '--bare', seed, origin);
  const pub = path.join(dir, 'pub');
  git(dir, 'clone', '-q', origin, pub);
  const app = path.join(dir, 'app');
  git(dir, 'clone', '-q', origin, app);
  return {
    dir, origin, pub, app, data: path.join(dir, 'profile'),
    /** Commit files in pub, tag it (how/key), push. Returns the commit sha. */
    release(tag, how, key, files) {
      for (const [k, v] of Object.entries(files || { 'main.js': '// ' + tag + '\n' })) write(pub, k, v);
      git(pub, 'add', '-A'); git(pub, 'commit', '-q', '-m', 'release ' + tag);
      tagAt(pub, tag, how, key);
      git(pub, 'push', '-q', 'origin', 'master', tag);
      return git(pub, 'rev-parse', 'HEAD');
    },
  };
}

function fakeApi() {
  const api = { body: null, headers: {} };
  api.fetch = async () => ({ status: 200, ok: true, statusText: '', headers: { get: (k) => api.headers[k.toLowerCase()] || null }, json: async () => api.body });
  api.releaseOf = (tag) => { api.body = { tag_name: tag, name: 'Quartz ' + tag, html_url: 'https://example.invalid/' + tag }; api.headers = { etag: '"e-' + tag + '"' }; };
  return api;
}

function make(w, api, extra) {
  const records = [];
  const u = U.createUpdater(Object.assign({
    appDir: w.app, dataDir: w.data, repoUrl: w.origin, fetch: api.fetch, firstCheckMs: 1000,
    timers: { setTimeout: () => ({ unref() {} }), clearTimeout() {} },
    tools: async () => '', record: (l) => records.push(l),
  }, extra || {}));
  u.records = records;
  return u;
}
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const logText = (w) => { try { return fs.readFileSync(path.join(w.data, 'updater.log'), 'utf8'); } catch { return ''; } };

async function main() {
  const A = makeKey('a');
  const B = makeKey('b');

  // ---- pure helpers -----------------------------------------------------------------------------
  {
    const p = U.parseSigners('# c\r\n\r\n' + A.line() + '\r\nquartz-release ' + B.type + ' ' + B.b64 + '\r\ngarbage line\r\n');
    check(p.lines.length === 3 && p.keys.length === 2 && p.keys[0].principal === 'quartz-release' && p.keys[1].key === B.b64,
      'parseSigners: comments and blanks dropped, CRLF ok, options optional, a garbage line still counts as a line', p);
    check(U.parseGitVersion('git version 2.53.0.windows.2').text === '2.53.0' && U.parseGitVersion('nope') === null, 'parseGitVersion');
    const repoSigners = U.readInstalledSigners(path.join(__dirname, '..'));
    check(repoSigners.pinned && repoSigners.keys.length >= 1 && repoSigners.keys.every((k) => k.type === 'ssh-ed25519'),
      'the repo\'s own ' + U.SIGNERS_FILE + ' holds at least one ed25519 key', repoSigners);
    check(!/BEGIN|PRIVATE/.test(fs.readFileSync(path.join(__dirname, '..', U.SIGNERS_FILE), 'utf8')), U.SIGNERS_FILE + ' holds no private key material');
    const missing = U.readInstalledSigners(path.join(ROOT, 'no-such-folder'));
    check(!missing.pinned && !missing.error, 'readInstalledSigners: a missing file is "no key yet", not an error', missing);
    check(/is not signed$/.test(U.signatureWhy('v1', 'error: no signature found')), 'signatureWhy: no signature found');
    check(/does not trust \(SHA256:abc\)/.test(U.signatureWhy('v1', 'Good "git" signature with ED25519 key SHA256:abc\nNo principal matched.')), 'signatureWhy: unknown key names its fingerprint');
    check(/could not run ssh-keygen/.test(U.signatureWhy('v1', 'error: cannot spawn ssh-keygen: No such file or directory')), 'signatureWhy: ssh-keygen missing');
    check(/too old to check SSH signatures/.test(U.signatureWhy('v1', 'ssh-keygen: unknown option -- Y')), 'signatureWhy: ssh-keygen without -Y');
    check(/does not match its contents/.test(U.signatureWhy('v1', 'Signature verification failed: incorrect signature')), 'signatureWhy: a tampered tag');
  }

  // ---- verifyReleaseTag on its own ----------------------------------------------------------------
  {
    const dir = path.join(ROOT, 'direct');
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'master');
    write(dir, 'a.txt', 'a\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'one');
    const c1 = head(dir);
    write(dir, 'a.txt', 'b\n'); git(dir, 'commit', '-qam', 'two');
    const c2 = head(dir);
    tagAt(dir, 'v1', 'signed', A, c1);
    tagAt(dir, 'v2', 'annotated', null, c1);
    tagAt(dir, 'v3', 'light', null, c1);
    tagAt(dir, 'v4', 'signed', B, c1);
    const obj = (t) => git(dir, 'rev-parse', 'refs/tags/' + t);
    const run = (args) => { const r = gitTry(dir, ...args); return Promise.resolve(r); };
    const pinnedA = { pinned: true, lines: [A.line()], keys: [], error: '' };
    const v = (tag, extra) => U.verifyReleaseTag(Object.assign({ run, tag, tagObject: obj(tag.replace(/^as-/, '')), sha: c1, signers: pinnedA }, extra));

    const ok = await v('v1');
    check(ok.ok && ok.state === 'verified' && ok.principal === 'quartz-release' && ok.fingerprint === A.fp,
      'a tag signed with the trusted key is verified, principal and fingerprint reported', ok);
    check(/is signed by a key this copy of Quartz trusts \(quartz-release, SHA256:/.test(ok.text), 'verified: the sentence names the key', ok.text);
    const uns = await v('v2');
    check(!uns.ok && uns.state === 'refused' && uns.why === 'the release tag v2 is not signed', 'an annotated unsigned tag is refused', uns);
    check(uns.text === 'Quartz will not install v2: the release tag v2 is not signed.', 'refused: the sentence', uns.text);
    const light = await v('v3');
    check(!light.ok && /is not signed \(it is a plain tag with no signature\)/.test(light.why), 'a lightweight tag is refused', light);
    const other = await v('v4');
    check(!other.ok && other.why === 'the release tag v4 is signed by a key this copy of Quartz does not trust (' + B.fp + ')',
      'a tag signed with another key is refused, naming that key', other);
    const moved = await v('v1', { sha: c2 });
    check(!moved.ok && moved.why === 'the signed tag v1 names commit ' + c1.slice(0, 7) + ', not ' + c2.slice(0, 7) + ', the commit this update would install',
      'a good signature on a tag that names another commit than the one merged is refused', moved);
    const renamed = await U.verifyReleaseTag({ run, tag: 'v9.9.9', tagObject: obj('v1'), sha: c1, signers: pinnedA });
    check(!renamed.ok && /the signature belongs to the tag "v1", not v9\.9\.9/.test(renamed.why), 'an old signed tag re-published under a new name is refused', renamed);
    const oldGit = await v('v1', { run: (args) => (args[0] === '--version' ? Promise.resolve({ code: 0, stdout: 'git version 2.30.1.windows.1\n', stderr: '' }) : run(args)) });
    check(!oldGit.ok && oldGit.why === 'this computer\'s git (2.30.1) cannot check SSH signatures; it needs git 2.34 or newer', 'git older than 2.34 is said plainly, never skipped', oldGit);
    const noKeygen = await v('v1', { sshProgram: 'quartz-no-such-ssh-keygen' });
    check(!noKeygen.ok && /git could not run ssh-keygen \(OpenSSH\), which it needs to check the signature on v1/.test(noKeygen.why), 'ssh-keygen missing is said plainly, never skipped', noKeygen);
    const bad = await v('v1', { signers: { pinned: true, lines: ['quartz-release garbage'], keys: [], error: '' } });
    check(!bad.ok, 'a damaged ' + U.SIGNERS_FILE + ' (no usable key) fails closed', bad);
    const unreadable = await v('v1', { signers: { pinned: true, lines: [], keys: [], error: 'EACCES' } });
    check(!unreadable.ok && /could not be read \(EACCES\)/.test(unreadable.why), 'an unreadable ' + U.SIGNERS_FILE + ' refuses', unreadable);
    const boot = await v('v2', { signers: { pinned: false }, bringsKey: true });
    check(boot.ok && boot.state === 'unpinned' && /has no release-signing key yet, so the signature on v2 was not checked\. This update brings the key/.test(boot.text),
      'no key installed: not checked, and the sentence says so (bootstrap)', boot);
    const fork = await v('v2', { signers: { pinned: false }, bringsKey: false });
    check(fork.ok && /^Neither this copy of Quartz nor v2 has a release-signing key/.test(fork.text), 'no key on either side: said as such', fork.text);
    check(!fs.readdirSync(os.tmpdir()).some((f) => f.startsWith('quartz-signers-') && fs.statSync(path.join(os.tmpdir(), f)).mtimeMs > Date.now() - 60000),
      'the temporary allowed-signers copies are removed');
  }

  // ---- the updater: signed release offered and installed --------------------------------------------
  {
    const w = world({ 'release-signers': signersText(A) });
    const api = fakeApi();
    const sha = w.release('v0.2.0', 'signed', A);
    api.releaseOf('v0.2.0');
    const u = make(w, api);
    const s = await u.check();
    check(s.status === 'available' && s.canUpdate && s.signature && s.signature.state === 'verified', 'signed release: offered, signature verified', s);
    const r = await u.update();
    check(r.ok && head(w.app) === sha, 'signed release: installed (ff-only to the signed commit)', r);
    check(/Signature: The release tag v0\.2\.0 is signed by a key this copy of Quartz trusts/.test(logText(w)), 'updater.log carries the signature line');
    check(u.records.some((l) => /^Update signature: The release tag v0\.2\.0 is signed/.test(l)), 'quartz.log (record) carries the signature line', u.records);
    check(u.records.filter((l) => /^Update signature:/.test(l)).length === 1, 'the same outcome is recorded once, not once per check', u.records);
  }

  // ---- unsigned and wrongly signed releases are refused, nothing changes ---------------------------
  for (const [how, key, re] of [['annotated', null, /^the release tag v0\.2\.0 is not signed, so Quartz will not install it/],
    ['light', null, /^the release tag v0\.2\.0 is not signed \(it is a plain tag with no signature\), so Quartz will not install it/],
    ['signed', B, /^the release tag v0\.2\.0 is signed by a key this copy of Quartz does not trust \(SHA256:[^)]+\), so Quartz will not install it/]]) {
    const w = world({ 'release-signers': signersText(A) });
    const api = fakeApi();
    w.release('v0.2.0', how, key);
    api.releaseOf('v0.2.0');
    const before = head(w.app);
    const u = make(w, api);
    const s = await u.check();
    check(s.status === 'available' && !s.canUpdate && re.test(s.blocked), how + (key ? ' (other key)' : '') + ': no Update button, the reason first', s.blocked);
    check(Array.isArray(s.manual) && s.manual.length === 0, how + ': no copy-paste commands that would install it anyway', s.manual);
    check(s.signature && s.signature.state === 'refused', how + ': signature state refused', s.signature);
    // update() refuses on its own too (a stale card, a scripted call): nothing merged.
    const r = await u.update();
    check(!r.ok && re.test(r.reason) && /Quartz stayed on the version it had/.test(r.reason) && head(w.app) === before,
      how + ': update() refuses, HEAD unchanged, the reason says nothing changed', r);
    check(u.state().status === 'failed' && re.test(u.state().failure.reason), how + ': the failure card carries the reason', u.state().failure);
    check(u.records.some((l) => /^Update signature: Quartz will not install v0\.2\.0: /.test(l)) && u.records.some((l) => /^Update to v0\.2\.0 failed: /.test(l)),
      how + ': quartz.log (record) says why', u.records);
  }

  // ---- the signers come from the installed copy, never from the fetched release ---------------------
  {
    const w = world({ 'release-signers': signersText(A) });
    const api = fakeApi();
    // The release swaps the file for key B and is signed with B: by its own file it would pass.
    w.release('v0.2.0', 'signed', B, { 'main.js': '// evil\n', 'release-signers': signersText(B) });
    api.releaseOf('v0.2.0');
    const before = head(w.app);
    const u = make(w, api);
    const s = await u.check();
    check(!s.canUpdate && /signed by a key this copy of Quartz does not trust/.test(s.blocked), 'a release that swaps release-signers for its own key is still refused', s.blocked);
    const r = await u.update();
    check(!r.ok && head(w.app) === before && fs.readFileSync(path.join(w.app, 'release-signers'), 'utf8') === signersText(A),
      'nothing merged; the installed release-signers is untouched', r);
  }

  // ---- rotation: the old key signs the release that adds the new one ----------------------------------
  {
    const w = world({ 'release-signers': signersText(A) });
    const api = fakeApi();
    const s1 = w.release('v0.2.0', 'signed', A, { 'release-signers': signersText(B) });
    api.releaseOf('v0.2.0');
    const u = make(w, api);
    await u.check();
    const r1 = await u.update();
    check(r1.ok && head(w.app) === s1, 'rotation: the release signed by the old key that brings the new one installs', r1);
    const s2 = w.release('v0.3.0', 'signed', B);
    api.releaseOf('v0.3.0');
    const u2 = make(w, api);
    const st2 = await u2.check();
    const r2 = await u2.update();
    check(st2.canUpdate && r2.ok && head(w.app) === s2, 'rotation: the next release signed by the new key installs', st2.blocked || r2);
    w.release('v0.4.0', 'signed', A);
    api.releaseOf('v0.4.0');
    const st3 = await make(w, api).check();
    check(!st3.canUpdate && /does not trust/.test(st3.blocked), 'rotation: the retired key no longer counts', st3.blocked);
  }

  // ---- bootstrap: a copy with no key takes the release that brings it, then insists ---------------------
  {
    const w = world();
    const api = fakeApi();
    const s1 = w.release('v0.2.0', 'annotated', null, { 'release-signers': signersText(A) });
    api.releaseOf('v0.2.0');
    const u = make(w, api);
    const st = await u.check();
    check(st.canUpdate && st.signature.state === 'unpinned' && /This update brings the key; every update after it must be signed\./.test(st.signature.text),
      'bootstrap: offered, and the card text says the signature was not checked and why', st.signature);
    check(u.records.some((l) => /^Update signature: This copy of Quartz has no release-signing key yet/.test(l)), 'bootstrap: said in quartz.log too', u.records);
    const r = await u.update();
    check(r.ok && head(w.app) === s1, 'bootstrap: installed', r);
    w.release('v0.3.0', 'annotated');
    api.releaseOf('v0.3.0');
    const after = await make(w, api).check();
    check(!after.canUpdate && /^the release tag v0\.3\.0 is not signed/.test(after.blocked), 'after bootstrap an unsigned release is refused', after.blocked);
  }

  // ---- the swap helper checks again before it merges ----------------------------------------------------
  {
    const w = world({ 'release-signers': signersText(A) });
    const sha = w.release('v0.2.0', 'signed', A);
    const evil = w.release('v0.2.1', 'annotated');           // a later commit the plan gets pointed at
    git(w.app, 'fetch', '-q', 'origin', 'refs/tags/v0.2.0:refs/tags/v0.2.0', 'refs/tags/v0.2.1:refs/tags/v0.2.1');
    const tagObject = git(w.app, 'rev-parse', 'refs/tags/v0.2.0');
    const from = head(w.app);
    fs.mkdirSync(w.data, { recursive: true });
    const plan = (to, extra) => Object.assign({
      appDir: w.app, stagingDir: path.join(w.app, U.STAGING_DIR), from, to, tag: 'v0.2.0', tagObject,
      log: path.join(w.data, 'updater.log'), result: path.join(w.data, 'swap-result.json'), pid: 0, exe: '',
    }, extra);
    const ok1 = await U.runSwap(plan(evil));
    const res1 = JSON.parse(fs.readFileSync(path.join(w.data, 'swap-result.json'), 'utf8'));
    check(ok1 === false && head(w.app) === from && /the signed tag v0\.2\.0 names commit .*, not .*, so Quartz did not install it/.test(res1.reason),
      'swap helper: a plan edited to another commit is refused before any merge', res1);
    fs.mkdirSync(path.join(w.app, U.STAGING_DIR, 'tree', 'node_modules'), { recursive: true });
    const ok2 = await U.runSwap(plan(sha));
    check(ok2 === true && head(w.app) === sha, 'swap helper: the verified plan merges', fs.readFileSync(path.join(w.data, 'updater.log'), 'utf8').slice(-400));
    check(/swap: signature: The release tag v0\.2\.0 is signed by a key this copy of Quartz trusts/.test(logText(w)), 'swap helper: logs the signature line');
  }

  // ---- tools/release-tag.js -------------------------------------------------------------------------------
  {
    const w = world({ 'release-signers': signersText(A) });
    const quiet = { say: () => {} };
    // HEAD = v0.1.0's commit; bump to 0.2.0 and push.
    write(w.pub, 'package.json', PKG('0.2.0')); git(w.pub, 'commit', '-qam', 'Quartz 0.2.0'); git(w.pub, 'push', '-q', 'origin', 'master');
    const wrong = await cutReleaseTag(Object.assign({ cwd: w.pub, key: B.priv }, quiet));
    check(!wrong.ok && /does not trust/.test(wrong.reason) && /the tag was deleted again, nothing was pushed/.test(wrong.reason) && gitTry(w.pub, 'rev-parse', '--verify', '--quiet', 'refs/tags/v0.2.0').code !== 0,
      'release-tag: a key not in release-signers is refused and the tag deleted', wrong);
    write(w.pub, 'main.js', '// dirty\n');
    const dirty = await cutReleaseTag(Object.assign({ cwd: w.pub, key: A.priv }, quiet));
    check(!dirty.ok && /uncommitted changes/.test(dirty.reason), 'release-tag: refuses a dirty tree', dirty);
    git(w.pub, 'checkout', '-q', '--', 'main.js');
    const nokey = await cutReleaseTag(Object.assign({ cwd: w.pub, key: '' }, quiet));
    check(!nokey.ok && /quartz\.releaseSigningKey/.test(nokey.reason), 'release-tag: no key says how to set one', nokey);
    const said = [];
    const good = await cutReleaseTag({ cwd: w.pub, key: A.priv, push: true, say: (l) => said.push(l) });
    check(good.ok && good.pushed && good.verified.fingerprint === A.fp, 'release-tag: signs, verifies and pushes', good);
    const remote = gitTry(w.pub, 'ls-remote', '--tags', 'origin', 'refs/tags/v0.2.0');
    check(remote.code === 0 && /refs\/tags\/v0\.2\.0/.test(remote.stdout), 'release-tag: the tag is on origin');
    const again = await cutReleaseTag(Object.assign({ cwd: w.pub, key: A.priv }, quiet));
    check(!again.ok && /already exists/.test(again.reason), 'release-tag: never re-tags a published version', again);
    // Rotation: HEAD's file now holds only B, but users still have v0.2.0's file (A): B must not sign yet.
    write(w.pub, 'package.json', PKG('0.3.0')); write(w.pub, 'release-signers', signersText(B));
    git(w.pub, 'commit', '-qam', 'Quartz 0.3.0'); git(w.pub, 'push', '-q', 'origin', 'master');
    const early = await cutReleaseTag(Object.assign({ cwd: w.pub, key: B.priv }, quiet));
    check(!early.ok && /does not trust/.test(early.reason), 'release-tag: verifies against the PREVIOUS release\'s signers (the new key cannot sign the rotation release)', early);
    const said2 = [];
    const rot = await cutReleaseTag({ cwd: w.pub, key: A.priv, say: (l) => said2.push(l) });
    check(rot.ok && !rot.pushed && said2.some((l) => /is not in HEAD's release-signers/.test(l)), 'release-tag: the old key signs the rotation release, and it says the next one needs the new key', said2);
    // And the updater agrees end to end: the user's copy (A) takes v0.3.0 (signed by A), then B's v0.4.0.
    git(w.pub, 'push', '-q', 'origin', 'refs/tags/v0.3.0');
    const api = fakeApi(); api.releaseOf('v0.3.0');
    const u = make(w, api);
    await u.check();
    const r = await u.update();
    check(r.ok, 'release-tag + updater: a tag cut by the tool installs', r);
  }

  // ---- the chrome draws the signature sentence (static: the renderer is not loaded here) ---------------
  {
    const chrome = fs.readFileSync(path.join(__dirname, '..', 'updater-chrome.js'), 'utf8');
    check(/s\.signature\.state === 'unpinned'\) c\.appendChild\(el\('div', 'lumen-alert-note qup-sig', s\.signature\.text\)\)/.test(chrome),
      'updater-chrome: the card shows the not-checked sentence');
    check(/qup-about-sig', s\.signature\.text\)/.test(chrome), 'updater-chrome: Settings > About shows the signature sentence');
  }

  console.log('release-signing-test: ' + pass + ' passed, ' + fail + ' failed');
}

main().catch((e) => { fail++; console.log('FAIL harness crashed: ' + ((e && e.stack) || e)); console.log('release-signing-test: ' + pass + ' passed, ' + fail + ' failed'); })
  .finally(() => { try { U.removeTree(ROOT); } catch { /* temp */ } process.exitCode = fail ? 1 : 0; });
