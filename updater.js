'use strict';
/*
 * updater.js -- in-app updates for a Quartz that was installed from source (a git clone).
 *
 * Pure Node: no Electron in here, so tests/updater-test.js drives every path with throwaway git
 * repos and a fake fetch. updater-main.js wires it to the app (IPC, the timer, the restart) and
 * updater-chrome.js draws it (the card in the corner, and the Updates rows in Settings > About).
 *
 * WHERE A RELEASE COMES FROM. GitHub Releases of the public repo: an unauthenticated
 *   GET {apiBase}/repos/{owner}/{repo}/releases/latest
 * with the last ETag in If-None-Match, so an unchanged answer is a 304 and costs almost nothing.
 * A rate-limited answer (403/429 with no requests left, or Retry-After) is said as such and the
 * next check waits for GitHub's reset time. Owner, repo, the API base and fetch are injectable.
 *
 * WHEN AN UPDATE COUNTS AS AVAILABLE. Only when the release's tag commit is NOT already in HEAD:
 * the tag is fetched, then `git merge-base --is-ancestor <tag> HEAD`. A folder at or ahead of the
 * release is never prompted.
 *
 * WHEN THE UPDATE BUTTON IS OFFERED. Every one of these must hold; otherwise the user is told
 * exactly which did not, and shown the commands to update by hand:
 *   - the app folder is a normal git clone (a linked worktree, where .git is a file, never checks);
 *   - its origin is the public repo;  - it is on the default branch;
 *   - tracked files have no uncommitted changes;  - it is not a shallow clone;
 *   - a fast-forward to the tag is possible;
 *   - when the release changes the dependencies (package.json or package-lock.json beyond their
 *     version fields): npm and node are on PATH.
 *
 * WHAT UPDATE DOES.
 *   1. Downloading: fetch the tag again and re-check every condition above.
 *   2. Installing: only when the dependencies changed (see depsChanged), `npm ci` runs in a
 *      STAGING copy of the release (<app>\.quartz-update\tree, exported from git without touching
 *      the index). It cannot run in place: Windows will not delete node_modules\electron\dist while
 *      Quartz is running from it, and npm ci starts by deleting node_modules. This is the step that
 *      can take minutes (it downloads the castlabs Electron the release pins), and the progress
 *      text says so. Without new dependencies: `git merge --ff-only <tag>` here and now.
 *   3. Restarting: through Quartz's normal quit path, so the session and tabs restore. When new
 *      dependencies were staged, a small helper (runSwap below, run by node from PATH) waits for
 *      Quartz to exit, THEN runs `git merge --ff-only <tag>` and swaps the staged node_modules in,
 *      and starts Quartz again. Until Quartz has quit, the app folder is untouched.
 *
 * IF ANYTHING FAILS. `git reset --keep <old sha>`; a staged node_modules is thrown away (the live
 * one was never touched, so there is nothing to reinstall); the swap helper renames the old
 * node_modules back. Quartz stays on the old version and says why, with the log's path. Never a
 * half-updated install.
 *
 * NEVER SILENT. Every state carries a sentence: why there is no check (off), why a check failed,
 * why there is no button, why an update failed and where its log is.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OWNER = 'Owen-Silva';
const REPO = 'quartz';
const API_BASE = 'https://api.github.com';
const OPT_OUT_FILE = 'updates.local.json';   // in the app folder: present = the updater is off
const STAGING_DIR = '.quartz-update';        // in the app folder (same volume, so the swap is a rename)
const STATE_FILE = 'updates.json';           // in the profile folder
const LOG_FILE = 'updater.log';              // in the profile folder
const PLAN_FILE = 'update-swap-plan.json';   // in the profile folder, for the swap helper
const RESULT_FILE = 'update-swap-result.json';
const HELPER_FILE = 'update-swap.js';
const FIRST_CHECK_MS = 30 * 1000;
const EVERY_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;             // after a failed check
const SNOOZE_MS = 24 * 60 * 60 * 1000;       // "Later"
const FETCH_TIMEOUT_MS = 15000;
const LOG_MAX_BYTES = 1024 * 1024;
// This file as it was when Quartz started: the swap helper must be the version that wrote the
// plan, not the one the merge just put on disk.
let SELF_SOURCE = null;
try { SELF_SOURCE = fs.readFileSync(__filename); } catch { /* copied from disk instead */ }
const NPM_TEXT = 'Installing dependencies with npm ci. This can take several minutes: it downloads ' +
  'the castlabs Electron this release pins. You can keep browsing meanwhile.';

/* ---- small pure helpers (exported for the tests) -------------------------------------------- */

/** A clone URL or a path, reduced to one comparable form: "github.com/owen-silva/quartz". */
function normaliseRepoUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  let m = /^[\w.-]+@([^:/\\]+):(?!\/\/)(.+)$/.exec(s);                       // git@github.com:o/r.git
  if (m) s = m[1] + '/' + m[2];
  else if ((m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(s))) s = m[1] + '/' + m[2];
  else s = path.resolve(s.replace(/^file:\/\/\/(?=[A-Za-z]:)/i, '').replace(/^file:\/\//i, ''));
  return s.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

/** "v1.2.10" vs "1.2.9": 1, -1 or 0. Anything that is not a version compares as 0. */
function compareVersions(a, b) {
  const p = (v) => String(v || '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10));
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) return 0;
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

/** Why a request never got an answer, in plain words. */
function netWhy(err) {
  const c = (err && err.cause) || {};
  const code = String(c.code || (err && err.code) || '');
  if (err && err.name === 'AbortError') return 'GitHub did not answer within ' + Math.round(FETCH_TIMEOUT_MS / 1000) + ' s';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'no internet (api.github.com could not be found)';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/.test(code)) {
    return 'no internet (GitHub could not be reached: ' + code + ')';
  }
  const msg = String((err && err.message) || err || '').trim();
  return msg ? 'the request failed: ' + msg.slice(0, 160) : 'the request failed';
}

/**
 * Does moving between these two package.json / package-lock.json pairs need npm ci? Every release
 * bumps "version" in both files, and that alone must not cost the user a multi-minute reinstall,
 * so the version fields are set aside before comparing. Anything unreadable counts as a change.
 */
function depsChanged(oldPkg, newPkg, oldLock, newLock) {
  const strip = (text, isLock) => {
    if (text == null) return null;
    const j = JSON.parse(text);
    delete j.version;
    if (isLock && j.packages && j.packages['']) delete j.packages[''].version;
    return JSON.stringify(j);
  };
  try {
    return strip(oldPkg, false) !== strip(newPkg, false) || strip(oldLock, true) !== strip(newLock, true);
  } catch {
    return true;
  }
}

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
function tail(s, n) { const t = String(s || '').trim(); return t.length > (n || 300) ? '…' + t.slice(-(n || 300)) : t; }
function short(sha) { return String(sha || '').slice(0, 7); }
function clock(ms) { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

/* ---- the default runners (tests inject their own) --------------------------------------------- */

/** Run a command; resolves { code, stdout, stderr }. A missing program is code -1 with a sentence. */
function runCmd(cmd, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env || process.env, windowsHide: true, shell: !!o.shell });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: cmd + ' could not start: ' + e.message });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      finish({ code: -1, stdout: out, stderr: err + '\n' + cmd + ' did not finish within ' + Math.round((o.timeoutMs || 120000) / 1000) + ' s' });
    }, o.timeoutMs || 120000);
    const onData = (which) => (d) => {
      const s = d.toString();
      if (which === 'out') out += s; else err += s;
      if (o.onLine) { for (const l of s.split(/\r?\n/)) if (l.trim()) o.onLine(l); }
    };
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));
    child.on('error', (e) => finish({ code: -1, stdout: out, stderr: e.code === 'ENOENT' ? cmd + ' was not found on PATH' : String(e.message) }));
    child.on('close', (code) => finish({ code: code == null ? -1 : code, stdout: out, stderr: err }));
  });
}

function defaultGit(args, opts) {
  const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, (opts && opts.env) || {});
  return runCmd('git', args, Object.assign({}, opts, { env }));
}

function defaultNpm(args, opts) {
  // npm is npm.cmd on Windows, and a .cmd only starts through a shell (Node refuses it otherwise).
  return runCmd(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, Object.assign({ shell: process.platform === 'win32' }, opts));
}

async function defaultTools() {
  const n = await runCmd('node', ['--version'], { timeoutMs: 15000 });
  const m = await defaultNpm(['--version'], { timeoutMs: 30000 });
  if (n.code !== 0) return 'node was not found on PATH';
  if (m.code !== 0) return 'npm was not found on PATH';
  return '';
}

async function defaultFetch(url, init) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try { return await fetch(url, Object.assign({}, init, { signal: ac.signal })); } finally { clearTimeout(t); }
}

/** Remove a folder; a junction or symlink is unlinked, never followed into. */
function removeTree(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return; }
  if (st.isSymbolicLink()) { try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); } return; }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) removeTree(path.join(p, name));
    fs.rmdirSync(p);
  } else {
    try { fs.unlinkSync(p); } catch (e) { if (e.code === 'EPERM') { fs.chmodSync(p, 0o666); fs.unlinkSync(p); } else throw e; }
  }
}

/* ---- what the app folder is ---------------------------------------------------------------- */

/**
 * '' when the updater may run here, else the sentence saying why it is fully off (no check, no
 * prompt): the opt-out file, or a linked worktree (.git is a file).
 */
function offReason(appDir) {
  if (fs.existsSync(path.join(appDir, OPT_OUT_FILE))) return 'turned off by ' + OPT_OUT_FILE + ' in the app folder';
  let st = null;
  try { st = fs.statSync(path.join(appDir, '.git')); } catch { /* no .git: not a clone, checked later */ }
  if (st && st.isFile()) return 'this folder is a linked git worktree, which never checks for updates';
  return '';
}

/* ---- the updater --------------------------------------------------------------------------- */

function createUpdater(opts) {
  const o = Object.assign({}, opts);
  const appDir = o.appDir;
  const dataDir = o.dataDir;
  const owner = o.owner || OWNER;
  const repo = o.repo || REPO;
  const apiBase = String(o.apiBase || API_BASE).replace(/\/+$/, '');
  const publicUrl = o.repoUrl || ('https://github.com/' + owner + '/' + repo + '.git');
  const publicKey = normaliseRepoUrl(publicUrl);
  const git = o.git || defaultGit;
  const npm = o.npm || defaultNpm;
  const tools = o.tools || defaultTools;
  const doFetch = o.fetch || defaultFetch;
  const now = o.now || Date.now;
  const T = o.timers || { setTimeout, clearTimeout };
  const firstMs = o.firstCheckMs == null ? FIRST_CHECK_MS : o.firstCheckMs;
  const everyMs = o.everyMs || EVERY_MS;
  const allowNpm = o.allowNpm !== false;
  const logPath = path.join(dataDir, LOG_FILE);
  const statePath = path.join(dataDir, STATE_FILE);
  const stagingDir = path.join(appDir, STAGING_DIR);
  const off = String(o.off || '') || offReason(appDir);

  let saved = readJson(statePath) || {};
  if (typeof saved.check !== 'boolean') saved.check = true;
  let timer = null;
  let busy = false;        // a check or an update is running
  let checking = null;     // the running check's promise
  let relaunchMode = '';   // 'plain' | 'swap', once an update is ready to restart

  const st = {
    status: off ? 'off' : 'idle',
    off,
    enabled: saved.check,
    current: { version: pkgVersion(appDir), sha: '' },
    release: null,
    checkedAt: (saved.last && saved.last.at) || 0,
    nextAt: 0,
    error: '',
    rateLimited: false,
    canUpdate: false,
    blocked: '',
    manual: [],
    needsNpm: false,
    progress: null,
    failure: null,
    updated: null,
    snoozed: false,
    ahead: false,
    logPath,
  };

  function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
  function persist() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(saved, null, 2));
      fs.renameSync(tmp, statePath);
    } catch (e) { log('Could not save ' + STATE_FILE + ': ' + e.message); }
  }
  function log(line) {
    const text = new Date(now()).toISOString() + ' ' + String(line).replace(/\r?\n/g, '\n    ') + '\n';
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      try { if (fs.statSync(logPath).size > LOG_MAX_BYTES) fs.renameSync(logPath, logPath + '.1'); } catch { /* none yet */ }
      fs.appendFileSync(logPath, text);
    } catch { /* the state still carries the reason */ }
    if (o.log) { try { o.log(String(line).split('\n')[0]); } catch { /* best effort */ } }
  }
  function snapshot() { return JSON.parse(JSON.stringify(st)); }
  function emit() { if (o.onState) { try { o.onState(snapshot()); } catch { /* a dead window */ } } }
  function set(patch) { Object.assign(st, patch); emit(); }

  async function g(args, extra) {
    const r = await git(args, Object.assign({ cwd: appDir }, extra));
    if (r.code !== 0) log('git ' + args.join(' ') + ' -> ' + r.code + ': ' + tail(r.stderr || r.stdout, 600));
    return r;
  }
  async function gitOut(args) { const r = await g(args); return r.code === 0 ? r.stdout.trim() : null; }

  /* -- the release ----------------------------------------------------------------------------- */

  /** { kind: 'release'|'none'|'error', release?, why?, retryAt? } */
  async function fetchRelease() {
    const url = apiBase + '/repos/' + owner + '/' + repo + '/releases/latest';
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Quartz-updater', 'X-GitHub-Api-Version': '2022-11-28' };
    if (saved.etag && saved.release) headers['If-None-Match'] = saved.etag;
    let res;
    try { res = await doFetch(url, { headers }); } catch (e) { return { kind: 'error', why: netWhy(e) }; }
    const h = (k) => { try { return res.headers.get(k); } catch { return null; } };
    if (res.status === 304 && saved.release) return { kind: 'release', release: saved.release };
    if (res.status === 404) { saved.etag = ''; saved.release = null; return { kind: 'none' }; }
    const left = h('x-ratelimit-remaining');
    if (res.status === 429 || (res.status === 403 && (left === '0' || h('retry-after')))) {
      const reset = Number(h('x-ratelimit-reset')) * 1000;
      const after = Number(h('retry-after')) * 1000;
      const retryAt = after > 0 ? now() + after : (reset > now() ? reset : now() + RETRY_MS);
      return { kind: 'error', rateLimited: true, retryAt, why: 'GitHub\'s limit for checks without signing in is used up for now; Quartz tries again at ' + clock(retryAt + 60000) };
    }
    if (!res.ok) return { kind: 'error', why: 'GitHub answered ' + res.status + (res.statusText ? ' ' + res.statusText : '') };
    let body;
    try { body = await res.json(); } catch (e) { return { kind: 'error', why: 'GitHub\'s answer was not readable: ' + e.message }; }
    const tag = body && typeof body.tag_name === 'string' ? body.tag_name.trim() : '';
    if (!/^[\w.+-]{1,64}$/.test(tag) || /^-|\.\.|\.lock$/.test(tag)) return { kind: 'error', why: 'the latest release has no usable tag name' };
    const release = {
      tag,
      name: String(body.name || tag).slice(0, 120),
      url: String(body.html_url || ('https://github.com/' + owner + '/' + repo + '/releases/tag/' + tag)),
      notes: String(body.body || '').slice(0, 2000),
      publishedAt: String(body.published_at || ''),
      branch: String(body.target_commitish || ''),
    };
    saved.etag = h('etag') || '';
    saved.release = release;
    return { kind: 'release', release };
  }

  /* -- where this folder stands against the release ---------------------------------------------- */

  async function originInfo() {
    const url = await gitOut(['remote', 'get-url', 'origin']);
    return { url: url || '', isPublic: !!url && normaliseRepoUrl(url) === publicKey };
  }

  async function defaultBranch(origin) {
    const sym = await gitOut(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (sym) return sym.replace(/^origin\//, '');
    if (origin.isPublic) {
      const r = await g(['ls-remote', '--symref', 'origin', 'HEAD'], { timeoutMs: 60000 });
      const m = /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(r.stdout || '');
      if (m) return m[1];
    }
    return '';
  }

  /**
   * Fetch the tag and work out everything the card needs: available or not, and when it is,
   * whether the button is offered and if not exactly why. Never changes the work tree.
   */
  async function inspect(release) {
    const tag = release.tag;
    const r = { available: false, canUpdate: false, blocked: '', manual: [], needsNpm: false, sha: '', head: '', ahead: false };
    const isClone = fs.existsSync(path.join(appDir, '.git'));
    if (!isClone) {
      // A folder from a zip: no history to compare, so the version number decides.
      if (compareVersions(tag, st.current.version) > 0) {
        r.available = true;
        r.blocked = 'this folder is not a git clone, so Quartz cannot update it in place';
        r.manual = ['git clone ' + publicUrl + ' quartz', 'cd quartz', 'npm ci', 'npm start'];
      }
      return r;
    }
    r.head = await gitOut(['rev-parse', 'HEAD']);
    if (!r.head) throw new Error('git could not read this folder\'s HEAD (see the log)');
    const origin = await originInfo();
    const src = origin.isPublic ? 'origin' : publicUrl;
    const f = await g(['fetch', '--no-tags', '--quiet', src, 'refs/tags/' + tag + ':refs/tags/' + tag], { timeoutMs: 180000 });
    if (f.code !== 0) {
      const why = /would clobber|rejected/.test(f.stderr) ? 'a local tag named ' + tag + ' points somewhere else than the release'
        : /not found|couldn't find remote ref/i.test(f.stderr) ? 'the release tag ' + tag + ' is not in the repository'
        : /Could not resolve host|unable to access|Failed to connect/i.test(f.stderr) ? 'no internet (git could not reach GitHub)'
        : 'git could not fetch ' + tag + ': ' + tail(f.stderr, 160);
      throw new Error(why);
    }
    r.sha = await gitOut(['rev-parse', tag + '^{commit}']);
    if (!r.sha) throw new Error('the tag ' + tag + ' does not name a commit');
    const inHead = await g(['merge-base', '--is-ancestor', r.sha, 'HEAD']);
    if (inHead.code === 0) { r.ahead = r.sha !== r.head; return r; }   // at or ahead of the release: never prompted
    if (inHead.code !== 1) throw new Error('git could not compare HEAD with ' + tag);
    r.available = true;

    const why = [];
    const pre = [];
    if (!origin.isPublic) why.push(origin.url ? 'this folder\'s origin is ' + origin.url + ', not the public repo' : 'this folder has no origin remote');
    const shallow = await gitOut(['rev-parse', '--is-shallow-repository']);
    if (shallow === 'true') why.push('this is a shallow clone');
    const branch = await gitOut(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const def = await defaultBranch(origin);
    if (!branch) { why.push('it is not on a branch (detached HEAD)'); if (def) pre.push('git switch ' + def); }
    else if (!def) why.push('the default branch could not be worked out');
    else if (branch !== def) { why.push('it is on the branch "' + branch + '", not "' + def + '"'); pre.push('git switch ' + def); }
    const dirty = await g(['status', '--porcelain', '--untracked-files=no']);
    const n = dirty.code === 0 ? dirty.stdout.split(/\r?\n/).filter((l) => l.trim()).length : -1;
    if (n > 0) why.push(plural(n, 'file has', 'files have') + ' local changes (commit or stash them first)');
    else if (n < 0) why.push('git could not read the folder\'s status');
    const ff = await g(['merge-base', '--is-ancestor', 'HEAD', r.sha]);
    const diverged = ff.code !== 0 && !(branch && def && branch !== def);
    if (diverged) why.push('this folder has commits the release does not (it has diverged)');
    const changed = await gitOut(['diff', '--name-only', 'HEAD', r.sha, '--', 'package.json', 'package-lock.json']);
    if (changed) {
      const show = async (rev, file) => { const x = await g(['show', rev + ':' + file]); return x.code === 0 ? x.stdout : null; };
      r.needsNpm = depsChanged(await show('HEAD', 'package.json'), await show(r.sha, 'package.json'),
        await show('HEAD', 'package-lock.json'), await show(r.sha, 'package-lock.json'));
    }
    if (r.needsNpm && !why.length) {
      if (!allowNpm) why.push('test runs never run npm ci, and this release changes the dependencies');
      else {
        const missing = await tools();
        if (missing) why.push(missing + ', and this release changes the dependencies');
      }
    }
    r.canUpdate = why.length === 0;
    r.blocked = why.join('; ');
    r.manual = ['cd "' + appDir + '"'].concat(pre,
      ['git pull ' + (diverged ? '' : '--ff-only ') + (origin.isPublic ? 'origin' : publicUrl) + ' ' + tag],
      r.needsNpm ? ['npm ci'] : []);
    return r;
  }

  /* -- check ------------------------------------------------------------------------------------- */

  function schedule(ms) {
    if (timer) T.clearTimeout(timer);
    timer = null;
    if (st.off || !st.enabled) { set({ nextAt: 0 }); return; }
    const wait = Math.max(1000, Math.min(ms, everyMs));
    st.nextAt = now() + wait;
    timer = T.setTimeout(() => { timer = null; check({ auto: true }); }, wait);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function check(how) {
    if (checking) return checking;
    checking = (async () => {
      try { return await doCheck(how || {}); } finally { checking = null; }
    })();
    return checking;
  }

  async function doCheck(how) {
    if (st.off) return snapshot();
    if (busy || st.status === 'updating') return snapshot();
    if (how.auto && !st.enabled) return snapshot();
    busy = true;
    set({ status: 'checking' });
    let next = everyMs;
    try {
      const got = await fetchRelease();
      saved.last = { at: now() };
      if (got.kind === 'error') {
        log('Check failed: ' + got.why);
        next = got.rateLimited ? Math.max(60000, got.retryAt - now() + 60000) : RETRY_MS;
        set({ status: 'error', error: got.why, rateLimited: !!got.rateLimited, checkedAt: now() });
        return snapshot();
      }
      if (got.kind === 'none') {
        set({ status: 'none', release: null, error: '', rateLimited: false, canUpdate: false, blocked: '', manual: [], checkedAt: now() });
        return snapshot();
      }
      const rel = got.release;
      const r = await inspect(rel);
      const snoozed = !!(saved.snooze && saved.snooze.tag === rel.tag && saved.snooze.until > now());
      st.current.sha = short(r.head);
      set({
        status: r.available ? 'available' : 'current',
        release: rel, error: '', rateLimited: false, checkedAt: now(),
        canUpdate: r.canUpdate, blocked: r.blocked, manual: r.manual, needsNpm: r.needsNpm, snoozed,
        ahead: r.ahead,
        failure: r.available ? st.failure : null,
      });
      if (r.available) log('Release ' + rel.tag + ' is out. ' + (r.canUpdate ? 'Update offered.' : 'No button: ' + r.blocked));
      return snapshot();
    } catch (e) {
      const why = String((e && e.message) || e);
      log('Check failed: ' + why);
      next = RETRY_MS;
      set({ status: 'error', error: why, checkedAt: now() });
      return snapshot();
    } finally {
      busy = false;
      persist();
      schedule(next);
    }
  }

  /* -- update ------------------------------------------------------------------------------------ */

  function progress(stage, text) { log('Update: ' + text); set({ status: 'updating', progress: { stage, text } }); }

  /** Export the release's tree into staging (git's own index untouched) and npm ci there. */
  async function stageDependencies(sha) {
    removeTree(stagingDir);
    const tree = path.join(stagingDir, 'tree');
    fs.mkdirSync(tree, { recursive: true });
    const index = path.join(stagingDir, 'index');
    const env = { GIT_INDEX_FILE: index };
    let r = await g(['read-tree', sha], { env });
    if (r.code === 0) r = await g(['checkout-index', '-a', '-f', '--prefix=' + tree.replace(/\\/g, '/') + '/'], { env });
    if (r.code !== 0) throw new Error('the release could not be unpacked for npm ci: ' + tail(r.stderr, 160));
    log('npm ci in ' + tree);
    const n = await npm(['ci', '--no-audit', '--no-fund'], { cwd: tree, timeoutMs: 30 * 60 * 1000, onLine: (l) => log('  npm: ' + l) });
    if (n.code !== 0) {
      const last = tail(n.stderr || n.stdout, 200).split(/\r?\n/).filter(Boolean).pop() || 'no reason given';
      throw new Error('npm ci failed (' + last + ')');
    }
    if (!fs.existsSync(path.join(tree, 'node_modules'))) throw new Error('npm ci finished but made no node_modules');
  }

  /**
   * Update to the release. Resolves { ok, relaunch: 'plain'|'swap' } or { ok: false, reason }.
   * On ok the caller restarts Quartz (relaunch()/swapPlan()); nothing else is left to do.
   */
  async function update() {
    if (st.off) return { ok: false, reason: 'updates are off: ' + st.off };
    if (busy) return { ok: false, reason: 'a check or an update is already running' };
    if (st.status === 'updating') return { ok: false, reason: 'an update is already running' };
    if (!st.release || !(st.status === 'available' || st.status === 'failed')) return { ok: false, reason: 'there is no update to install' };
    busy = true;
    const rel = st.release;
    let old = '';
    let mergeTried = false;
    let staged = false;
    try {
      progress('downloading', 'Downloading ' + rel.tag + '…');
      const r = await inspect(rel);
      st.current.sha = short(r.head);
      if (!r.available) throw new Error('this folder already has ' + rel.tag);
      if (!r.canUpdate) {
        set({ canUpdate: false, blocked: r.blocked, manual: r.manual });
        throw new Error(r.blocked);
      }
      old = r.head;
      if (r.needsNpm) {
        progress('installing', NPM_TEXT);
        staged = true;
        await stageDependencies(r.sha);
        // The folder itself moves only once Quartz has quit: the swap helper merges, then swaps
        // node_modules. Until then nothing in the app folder has changed.
        relaunchMode = 'swap';
        saved.pending = { from: old, to: r.sha, tag: rel.tag, mode: 'swap', at: now() };
        saved.snooze = null;
        persist();
        progress('restarting', 'Restarting: Quartz closes, moves to ' + rel.tag + ' with its new dependencies and opens again with your tabs.');
        log('Staged ' + rel.tag + ' (' + short(r.sha) + ') with new dependencies; the swap helper finishes it after the quit.');
        return { ok: true, relaunch: 'swap' };
      }
      progress('installing', 'Moving this folder to ' + rel.tag + '…');
      mergeTried = true;
      const m = await g(['merge', '--ff-only', r.sha]);
      if (m.code !== 0) throw new Error('git merge --ff-only failed: ' + (tail(m.stderr || m.stdout, 200).split(/\r?\n/).filter(Boolean)[0] || 'no reason given'));
      const now2 = await gitOut(['rev-parse', 'HEAD']);
      if (now2 !== r.sha) throw new Error('after the merge HEAD is ' + short(now2) + ', not ' + short(r.sha));
      relaunchMode = 'plain';
      saved.pending = { from: old, to: r.sha, tag: rel.tag, mode: 'plain', at: now() };
      saved.snooze = null;
      persist();
      progress('restarting', 'Restarting Quartz with your tabs…');
      log('Updated the folder from ' + short(old) + ' to ' + rel.tag + ' (' + short(r.sha) + ').');
      return { ok: true, relaunch: 'plain' };
    } catch (e) {
      const reason = String((e && e.message) || e);
      const notes = await rollback(old, mergeTried, staged);
      const full = reason + (notes ? '. ' + notes : '');
      log('Update failed: ' + full);
      set({ status: 'failed', progress: null, failure: { reason: full, log: logPath, at: now() } });
      return { ok: false, reason: full };
    } finally {
      busy = false;
    }
  }

  /** Back to the old commit; a staged node_modules is thrown away. Returns a sentence when it could not. */
  async function rollback(old, mergeTried, staged) {
    const said = [];
    if (old && mergeTried) {
      const head = await gitOut(['rev-parse', 'HEAD']);
      if (head !== old) {
        const r = await g(['reset', '--keep', old]);
        if (r.code !== 0) said.push('Going back to ' + short(old) + ' failed too: run "git reset --keep ' + old + '" in the app folder');
        else log('Rolled back to ' + short(old));
      }
    }
    if (staged) { try { removeTree(stagingDir); } catch (e) { said.push('The staging folder ' + STAGING_DIR + ' could not be removed: ' + e.message); } }
    if (!said.length) said.push('Quartz stayed on the version it had');
    return said.join('. ');
  }

  /**
   * The swap helper's plan, written once the folder is on the new commit and its node_modules is
   * staged. Returns { node, script, plan } for the caller to spawn just before it quits.
   */
  function swapPlan(relaunch) {
    const helper = path.join(dataDir, HELPER_FILE);
    fs.mkdirSync(dataDir, { recursive: true });
    if (SELF_SOURCE) fs.writeFileSync(helper, SELF_SOURCE); else fs.copyFileSync(__filename, helper);
    const plan = Object.assign({
      appDir, stagingDir, from: saved.pending && saved.pending.from, to: saved.pending && saved.pending.to,
      tag: saved.pending && saved.pending.tag, log: logPath, result: path.join(dataDir, RESULT_FILE),
    }, relaunch);   // { pid, exe, args, cwd }
    const planPath = path.join(dataDir, PLAN_FILE);
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    try { fs.unlinkSync(plan.result); } catch { /* none */ }
    return { script: helper, planPath };
  }

  /**
   * The swap helper could not be started (no node on PATH, say): nothing in the app folder has
   * changed yet, so drop the staged copy and stay on the old version, saying why.
   */
  function abandonSwap(reason) {
    saved.pending = null;
    persist();
    relaunchMode = '';
    let note = 'Quartz stayed on the version it had';
    try { removeTree(stagingDir); } catch (e) { note += '; the staging folder ' + STAGING_DIR + ' could not be removed: ' + e.message; }
    const full = reason + '. ' + note;
    log('Update failed: ' + full);
    set({ status: 'failed', progress: null, failure: { reason: full, log: logPath, at: now() } });
    return snapshot();
  }

  /* -- the rest of the surface ------------------------------------------------------------------- */

  /** At start: did the last run update this folder, and did it land? */
  async function settle() {
    const p = saved.pending;
    if (!p || st.off) return;
    saved.pending = null;
    const head = fs.existsSync(path.join(appDir, '.git')) ? await gitOut(['rev-parse', 'HEAD']) : '';
    const result = p.mode === 'swap' ? readJson(path.join(dataDir, RESULT_FILE)) : { ok: true };
    if (head === p.to && result && result.ok) {
      st.current.sha = short(head);
      set({ status: 'updated', updated: { from: short(p.from), to: short(p.to), tag: p.tag } });
      log('Quartz is now on ' + p.tag + ' (' + short(p.to) + ').');
    } else {
      const reason = (result && !result.ok && result.reason) ? result.reason
        : head === p.from ? 'the update to ' + p.tag + ' did not finish'
          : 'after the restart this folder is on ' + (short(head) || 'an unknown commit') + ', not ' + p.tag;
      set({ status: 'failed', failure: { reason: reason + '. Quartz is on the version it had', log: logPath, at: now() } });
      log('The update to ' + p.tag + ' did not land: ' + reason);
    }
    persist();
  }

  function start() {
    if (st.off) { log('Updates are off: ' + st.off); emit(); return snapshot(); }
    (async () => {
      if (fs.existsSync(path.join(appDir, '.git'))) st.current.sha = short(await gitOut(['rev-parse', 'HEAD']));
      await settle();
    })().catch((e) => log('Could not read the last update: ' + e.message)).then(() => {
      if (st.enabled) schedule(firstMs); else set({ nextAt: 0 });
    });
    return snapshot();
  }

  function stop() { if (timer) T.clearTimeout(timer); timer = null; }

  function setEnabled(on) {
    saved.check = !!on;
    persist();
    st.enabled = saved.check;
    if (st.enabled) schedule(firstMs); else { stop(); set({ nextAt: 0 }); }
    return snapshot();
  }

  function later() {
    if (st.release) {
      saved.snooze = { tag: st.release.tag, until: now() + SNOOZE_MS };
      persist();
    }
    set({ snoozed: true, updated: null, failure: st.status === 'failed' ? st.failure : null });
    return snapshot();
  }

  return {
    start, stop, check, update, later, setEnabled, swapPlan, abandonSwap,
    state: snapshot,
    relaunchMode: () => relaunchMode,
    paths: { logPath, statePath, stagingDir },
  };
}

function pkgVersion(appDir) {
  try { return String(JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version || ''); } catch { return ''; }
}

/* ---- the swap helper (runs as `node update-swap.js <plan.json>` once Quartz has quit) ------- */

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/**
 * Wait for Quartz to exit, swap the staged node_modules in, start Quartz again. Any failure puts
 * the old node_modules back, resets the folder to the old commit, and starts the old Quartz;
 * the result file tells the next start what happened.
 */
async function runSwap(plan, deps) {
  const d = Object.assign({ git: defaultGit, spawn, alive, waitMs: 60000, renameMs: 30000 }, deps);
  const say = (l) => { try { fs.appendFileSync(plan.log, new Date().toISOString() + ' swap: ' + l + '\n'); } catch { /* none */ } };
  const write = (r) => { try { fs.writeFileSync(plan.result, JSON.stringify(Object.assign({ at: Date.now() }, r))); } catch (e) { say('could not write the result: ' + e.message); } };
  const nm = path.join(plan.appDir, 'node_modules');
  const staged = path.join(plan.stagingDir, 'tree', 'node_modules');
  const old = path.join(plan.stagingDir, 'old-node_modules');
  const relaunch = () => {
    if (!plan.exe) return;
    try {
      const c = d.spawn(plan.exe, plan.args || [], { cwd: plan.cwd || plan.appDir, detached: true, stdio: 'ignore' });
      if (c && c.unref) c.unref();
      say('started ' + path.basename(plan.exe));
    } catch (e) { say('could not start Quartz again: ' + e.message); }
  };
  async function rename(a, b) {
    const t0 = Date.now();
    for (;;) {
      try { fs.renameSync(a, b); return; } catch (e) {
        if (!/EPERM|EBUSY|EACCES/.test(e.code) || Date.now() - t0 > d.renameMs) throw e;
        await sleepMs(500);
      }
    }
  }
  const tidy = () => { try { removeTree(plan.stagingDir); } catch (e) { say('could not tidy ' + plan.stagingDir + ': ' + e.message); } };
  say('waiting for Quartz (pid ' + plan.pid + ') to exit');
  const t0 = Date.now();
  while (plan.pid && d.alive(plan.pid)) {
    if (Date.now() - t0 > d.waitMs) {
      // Quartz never closed: nothing has been touched yet, so it simply stays on the old version.
      say('Quartz did not exit within ' + Math.round(d.waitMs / 1000) + ' s; nothing changed');
      write({ ok: false, reason: 'Quartz did not close within ' + Math.round(d.waitMs / 1000) + ' s, so the update was not applied' });
      tidy();
      return false;
    }
    await sleepMs(250);
  }
  // Quartz is gone: now the folder can move (merge), then node_modules (swap).
  const m = await d.git(['merge', '--ff-only', plan.to], { cwd: plan.appDir });
  if (m.code !== 0) {
    const reason = 'git merge --ff-only failed: ' + (tail(m.stderr || m.stdout, 200).split(/\r?\n/).filter(Boolean)[0] || 'no reason given');
    say(reason);
    const r = await d.git(['reset', '--keep', plan.from], { cwd: plan.appDir });
    say('reset to ' + short(plan.from) + ' -> ' + r.code);
    write({ ok: false, reason });
    tidy();
    relaunch();
    return false;
  }
  let moved = false;
  try {
    if (!fs.existsSync(staged)) throw new Error('the staged node_modules is missing');
    if (fs.existsSync(old)) removeTree(old);
    if (fs.existsSync(nm)) { await rename(nm, old); moved = true; }
    await rename(staged, nm);
    say('swapped node_modules for ' + plan.tag);
    write({ ok: true, from: plan.from, to: plan.to, tag: plan.tag });
    relaunch();
    tidy();   // the old node_modules goes with it, after Quartz is already starting
    return true;
  } catch (e) {
    const reason = 'the new dependencies could not be swapped in: ' + e.message;
    say(reason);
    if (moved && !fs.existsSync(nm)) { try { await rename(old, nm); say('put the old node_modules back'); } catch (e2) { say('could not put the old node_modules back: ' + e2.message); } }
    const r = await d.git(['reset', '--keep', plan.from], { cwd: plan.appDir });
    say('reset to ' + short(plan.from) + ' -> ' + r.code + ' ' + tail(r.stderr, 200));
    write({ ok: false, reason });
    if (fs.existsSync(nm)) tidy();
    relaunch();
    return false;
  }
}

module.exports = {
  createUpdater, runSwap, offReason, normaliseRepoUrl, compareVersions, netWhy, removeTree, depsChanged,
  OPT_OUT_FILE, STAGING_DIR, NPM_TEXT, EVERY_MS, FIRST_CHECK_MS,
};

if (require.main === module && process.argv[2]) {
  let plan;
  try { plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch (e) { console.error('update-swap: no plan: ' + e.message); process.exit(2); }
  runSwap(plan).then((ok) => process.exit(ok ? 0 : 1), (e) => { console.error(e); process.exit(1); });
}
