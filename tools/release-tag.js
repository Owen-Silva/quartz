#!/usr/bin/env node
'use strict';
/*
 * release-tag.js -- cut a release tag the in-app updater will accept: SSH-signed, and verified
 * before it leaves this machine.
 *
 *   node tools/release-tag.js            sign v<version> (package.json) at HEAD and verify it
 *   node tools/release-tag.js --push     ... then push the tag to origin
 *   --key=<path>                         the private signing key; else $QUARTZ_RELEASE_KEY, else
 *                                        `git config quartz.releaseSigningKey`
 *
 * What it checks first: HEAD is on the default branch and already pushed there (every user's clone
 * must be able to fast-forward to it), tracked files are clean, the tag does not exist yet, and the
 * key file exists. Then `git tag -s` with gpg.format=ssh, all of it on the command line, so nothing
 * in the user's git config is changed or needed.
 *
 * What it verifies against. Users check a release with the release-signers file of the copy they
 * have INSTALLED, which is the previous release's, not this one's. So the new tag is verified with
 * updater.js's own check (verifyReleaseTag) against the previous release tag's release-signers when
 * that has a key, and against HEAD's only when no earlier release had one (the bootstrap release).
 * A tag that fails is deleted again and nothing is pushed. When the signing key is missing from
 * HEAD's own release-signers (a rotation away from it), it says so: the NEXT release must then be
 * signed with a key that is in HEAD's file.
 *
 * Prints one summary line: "release-tag: <tag> signed and verified (<principal>, <fingerprint>)"
 * or "release-tag: refused: <reason>".
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const U = require('../updater');

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }) });
    } catch (e) { resolve({ code: -1, stdout: '', stderr: e.message }); return; }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, stdout: out, stderr: e.code === 'ENOENT' ? cmd + ' was not found on PATH' : e.message }));
    child.on('close', (code) => resolve({ code: code == null ? -1 : code, stdout: out, stderr: err }));
  });
}

/**
 * Cut and verify the tag. opts: { cwd, key, push, git?, sshProgram?, say? }.
 * Resolves { ok, tag, reason?, verified?, pushed? }. Never pushes a tag that did not verify, and
 * deletes a tag it created that did not.
 */
async function cutReleaseTag(opts) {
  const o = Object.assign({}, opts);
  const cwd = o.cwd || process.cwd();
  const git = o.git || ((args) => run('git', args, cwd));
  const say = o.say || ((l) => console.log(l));
  const out = async (args) => { const r = await git(args); return r.code === 0 ? r.stdout.trim() : null; };
  const refuse = (reason, tag) => ({ ok: false, tag: tag || '', reason });

  const top = await out(['rev-parse', '--show-toplevel']);
  if (!top) return refuse('this is not a git repository');
  let version = '';
  try { version = String(JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8')).version || ''); } catch (e) { return refuse('package.json could not be read: ' + e.message); }
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) return refuse('package.json has no usable version ("' + version + '")');
  const tag = 'v' + version;

  // Where the tag goes: the default branch, already pushed, clean.
  const branch = await out(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) return refuse('HEAD is not on a branch', tag);
  const def = ((await out(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])) || 'origin/master').replace(/^origin\//, '');
  if (branch !== def) return refuse('HEAD is on "' + branch + '", not the default branch "' + def + '"', tag);
  const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty.code !== 0) return refuse('git could not read the status', tag);
  if (dirty.stdout.trim()) return refuse('tracked files have uncommitted changes', tag);
  const head = await out(['rev-parse', 'HEAD']);
  const pushed = await git(['merge-base', '--is-ancestor', 'HEAD', 'origin/' + def]);
  if (pushed.code !== 0) return refuse('HEAD (' + String(head).slice(0, 7) + ') is not on origin/' + def + ' yet: push the branch first', tag);
  if (await out(['rev-parse', '--verify', '--quiet', 'refs/tags/' + tag])) return refuse('the tag ' + tag + ' already exists; never move a published tag, release a newer version', tag);

  const key = String(o.key || '').trim();
  if (!key) return refuse('no signing key: pass --key=<path>, set QUARTZ_RELEASE_KEY, or run "git config quartz.releaseSigningKey <path>"', tag);
  if (!fs.existsSync(key)) return refuse('the signing key ' + key + ' does not exist', tag);

  // The keys the users will check with: the previous release's file, or HEAD's for the first one.
  const tags = ((await out(['tag', '--list', 'v*', '--sort=-v:refname', '--merged', 'HEAD'])) || '').split(/\r?\n/).filter(Boolean);
  const prev = tags.find((t) => t !== tag) || '';
  const fileAt = async (rev) => { const r = await git(['show', rev + ':' + U.SIGNERS_FILE]); return r.code === 0 ? r.stdout : ''; };
  const prevSigners = prev ? U.parseSigners(await fileAt(prev)) : { lines: [], keys: [] };
  const headSigners = U.parseSigners(await fileAt('HEAD'));
  const against = prevSigners.lines.length ? prevSigners : headSigners;
  const againstWhat = prevSigners.lines.length ? prev + '\'s ' + U.SIGNERS_FILE + ' (what users have installed)'
    : 'HEAD\'s ' + U.SIGNERS_FILE + ' (no earlier release has one: this is the bootstrap release)';
  if (!against.lines.length) return refuse('neither HEAD nor an earlier release has a key in ' + U.SIGNERS_FILE + ', so nothing could verify this tag', tag);

  say('Signing ' + tag + ' at ' + String(head).slice(0, 7) + ' with ' + key + '; verifying against ' + againstWhat + '.');
  const keyArg = key.split(path.sep).join('/');
  const made = await git(['-c', 'gpg.format=ssh', '-c', 'user.signingkey=' + keyArg, '-c', 'gpg.ssh.program=' + (o.sshProgram || 'ssh-keygen'),
    'tag', '-s', tag, '-m', 'Quartz ' + version]);
  if (made.code !== 0) {
    if (await out(['rev-parse', '--verify', '--quiet', 'refs/tags/' + tag])) await git(['tag', '-d', tag]);
    return refuse('git tag -s failed: ' + String(made.stderr || made.stdout).trim().split(/\r?\n/)[0], tag);
  }
  const tagObject = await out(['rev-parse', '--verify', '--quiet', 'refs/tags/' + tag]);
  const v = await U.verifyReleaseTag({
    run: git, tag, tagObject, sha: head, sshProgram: o.sshProgram,
    signers: { pinned: true, lines: against.lines, keys: against.keys, error: '' },
  });
  if (!v.ok) {
    const d = await git(['tag', '-d', tag]);
    return refuse(v.why + (d.code === 0 ? '; the tag was deleted again, nothing was pushed' : '; ALSO the tag could not be deleted: run "git tag -d ' + tag + '"'), tag);
  }
  say(v.text);
  // ssh-keygen's fingerprint of a key line: SHA256 of the key blob, base64 without padding.
  const fp = (k) => 'SHA256:' + require('crypto').createHash('sha256').update(Buffer.from(k.key, 'base64')).digest('base64').replace(/=+$/, '');
  if (!headSigners.keys.some((k) => fp(k) === v.fingerprint)) {
    say('Note: the key that signed ' + tag + ' is not in HEAD\'s ' + U.SIGNERS_FILE + '. Once users have ' + tag + ', the next release must be signed with a key that is.');
  }
  if (!o.push) {
    say('Not pushed. Next:\n  git push origin refs/tags/' + tag + '\n  gh release create ' + tag + ' --verify-tag --title "Quartz ' + version + '" --notes-file notes.md');
    return { ok: true, tag, verified: v, pushed: false };
  }
  const p = await git(['push', 'origin', 'refs/tags/' + tag]);
  if (p.code !== 0) return { ok: false, tag, verified: v, pushed: false, reason: 'the tag is signed and verified but the push failed: ' + String(p.stderr).trim().split(/\r?\n/).pop() };
  say('Pushed ' + tag + '. Next: gh release create ' + tag + ' --verify-tag --title "Quartz ' + version + '" --notes-file notes.md');
  return { ok: true, tag, verified: v, pushed: true };
}

module.exports = { cutReleaseTag };

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const arg = (name) => { const a = argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : ''; };
    let key = arg('key') || process.env.QUARTZ_RELEASE_KEY || '';
    if (!key) { const r = await run('git', ['config', '--get', 'quartz.releaseSigningKey'], process.cwd()); key = r.code === 0 ? r.stdout.trim() : ''; }
    const r = await cutReleaseTag({ cwd: process.cwd(), key, push: argv.includes('--push') });
    if (r.ok) console.log('release-tag: ' + r.tag + ' signed and verified (' + r.verified.principal + ', ' + r.verified.fingerprint + ')' + (r.pushed ? ', pushed' : ', not pushed'));
    else console.log('release-tag: refused: ' + r.reason);
    process.exit(r.ok ? 0 : 1);
  })().catch((e) => { console.log('release-tag: refused: ' + ((e && e.stack) || e)); process.exit(1); });
}
