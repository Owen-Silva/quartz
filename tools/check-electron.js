#!/usr/bin/env node
'use strict';
// tools/check-electron.js -- is the pinned castlabs Electron (and so the Chromium inside it) behind?
//
//   node tools/check-electron.js            the report and a one-line verdict
//   node tools/check-electron.js --json     the same as JSON (for a scheduled check)
//   node tools/check-electron.js --pre      also list alpha/beta tags (never used for the verdict)
//
// WHY. Quartz runs castlabs' Electron build (Widevine), pinned in package.json as
// `github:castlabs/electron-releases#v<x.y.z>+wvcus`. Chromium security fixes reach this browser
// ONLY when that pin is bumped, and nothing else watches for new tags. Electron supports only its
// latest three majors, and fixes land on the latest minor of each, so a pin left alone quietly
// stops getting fixes. The bump policy this checks against is in docs/engineering-notes.md
// ("Electron and Chromium updates"): a patch within 7 days of the castlabs tag, an exploited-in-
// the-wild Chromium fix immediately, a new major within about 3 weeks.
//
// WHAT IT READS (no token needed, nothing is written, package.json is never changed):
//   - the tags: `git ls-remote --tags https://github.com/castlabs/electron-releases`
//     (plain git: no API rate limit);
//   - each version's Chromium and upstream release date: https://releases.electronjs.org/releases.json
//     (castlabs builds the same upstream version, so Chromium matches);
//   - the castlabs tag date for at most three tags (the pin, the latest of its major, the latest
//     newer major): `gh api` when gh is installed and signed in, else the public GitHub API
//     (60 requests an hour per IP). When neither answers, the upstream date stands in, and the
//     report SAYS so on that line.
//
// EXIT CODE. 0 = up to date or behind but inside the policy window; 1 = behind past the policy
// window (a bump is overdue); 2 = the check itself could not run (no network, git missing).
// The verdict line says which, with the reason, every time.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = 'castlabs/electron-releases';
const REPO_URL = 'https://github.com/' + REPO;
const UPSTREAM_INDEX = 'https://releases.electronjs.org/releases.json';
const PATCH_DAYS = 7;   // policy: same-major patch bump within 7 days of the castlabs tag
const MAJOR_DAYS = 21;  // policy: new major within about 3 weeks of castlabs stable
const DAY = 86400000;

/* ---- pure helpers (exported for check-electron-harness.js) ---------------------------------- */

/** 'v44.5.1+wvcus' | '44.5.1+wvcus' | 'v45.0.0-alpha.3+wvcus' -> parts, or null for anything else. */
function parseTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\+wvcus$/.exec(String(tag || '').trim());
  if (!m) return null;
  return { tag: 'v' + m[1] + '.' + m[2] + '.' + m[3] + (m[4] ? '-' + m[4] : '') + '+wvcus',
    version: m[1] + '.' + m[2] + '.' + m[3] + (m[4] ? '-' + m[4] : ''),
    major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

/** The pin out of package.json's electron dependency, or null with no castlabs tag in it. */
function pinFromPackage(spec) {
  const m = /#(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+wvcus)\s*$/.exec(String(spec || ''));
  return m ? parseTag(m[1]) : null;
}

/** Semver order, prereleases before their release (alpha.9 < alpha.14 < beta.1 < release). */
function compare(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const pa = a.pre.split('.'), pb = b.pre.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
    if (na && nb && +pa[i] !== +pb[i]) return +pa[i] - +pb[i];
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** `git ls-remote --tags` output -> unique parsed +wvcus tags, sorted oldest first. */
function tagsFromLsRemote(text) {
  const seen = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /refs\/tags\/([^\s^]+)(\^\{\})?$/.exec(line.trim());
    if (!m) continue;
    const t = parseTag(m[1]);
    if (t) seen.set(t.tag, t);
  }
  return [...seen.values()].sort(compare);
}

/**
 * The comparison. tags: parsed, sorted; pin: parsed.
 * -> { newer: [tags newer than the pin], latestSame, latestNewerMajor, newerMajors: [latest per major] }
 * Stable tags only unless opts.pre (prereleases never count toward the verdict).
 */
function plan(tags, pin, opts) {
  const stable = tags.filter((t) => !t.pre);
  const listed = (opts && opts.pre) ? tags : stable;
  const newer = listed.filter((t) => compare(t, pin) > 0);
  const sameMajor = stable.filter((t) => t.major === pin.major);
  const latestSame = sameMajor.length ? sameMajor[sameMajor.length - 1] : null;
  const byMajor = new Map();
  for (const t of stable) if (t.major > pin.major) byMajor.set(t.major, t); // sorted: last wins
  const newerMajors = [...byMajor.values()];
  const latestNewerMajor = newerMajors.length ? newerMajors[newerMajors.length - 1] : null;
  return { newer, latestSame: latestSame && compare(latestSame, pin) > 0 ? latestSame : null, latestNewerMajor, newerMajors };
}

/** Whole days between two Dates / ISO strings (floored, never negative). */
function daysBetween(from, to) {
  const a = new Date(from).getTime(), b = new Date(to).getTime();
  if (!isFinite(a) || !isFinite(b)) return null;
  return Math.max(0, Math.floor((b - a) / DAY));
}

/**
 * The one-line verdict. p: plan(); dates: { [tag]: ISO date of the castlabs tag (or stand-in) };
 * now: Date. -> { level: 'ok'|'behind'|'overdue', line }
 * "Days behind" counts from the date the newer tag appeared: that is when the policy clock starts.
 */
function verdict(p, pin, dates, now) {
  const parts = [];
  let level = 'ok';
  if (p.latestNewerMajor) {
    const t = p.latestNewerMajor;
    const d = daysBetween(dates[t.tag], now);
    const late = d !== null && d > MAJOR_DAYS;
    if (late) level = 'overdue'; else if (level === 'ok') level = 'behind';
    parts.push('major behind: ' + t.tag + ' has been out ' + (d === null ? 'an unknown number of' : d) + ' days' +
      (late ? ' (policy: within ' + MAJOR_DAYS + ')' : ''));
  }
  if (p.latestSame) {
    const t = p.latestSame;
    const d = daysBetween(dates[t.tag], now);
    const late = d !== null && d > PATCH_DAYS;
    if (late) level = 'overdue'; else if (level === 'ok') level = 'behind';
    parts.push('patch behind ' + (d === null ? '? ' : d + ' ') + 'days: ' + t.tag + ' is out' +
      (late ? ' (policy: within ' + PATCH_DAYS + ')' : ''));
  }
  if (!parts.length) return { level, line: 'up to date: ' + pin.tag + ' is the newest stable castlabs tag' };
  return { level, line: (level === 'overdue' ? 'BUMP OVERDUE: ' : '') + parts.join('; ') };
}

/**
 * Upstream Electron already has a stable major newer than the pin that castlabs has not tagged
 * yet: worth a line (the clock for that major starts at the castlabs tag, so no verdict change).
 * index: Map(version -> releases.json row). -> one line, or null.
 */
function upstreamAhead(index, pin, tags) {
  let best = null;
  for (const [ver, r] of index) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(ver);
    if (!m || +m[1] <= pin.major) continue;
    if (tags.some((t) => !t.pre && t.major === +m[1])) continue;
    const t = { major: +m[1], minor: +m[2], patch: +m[3], pre: '' };
    if (!best || compare(t, best.t) > 0) best = { t, r };
  }
  return best ? 'Electron ' + best.r.version + ' (Chromium ' + best.r.chrome + ') stable upstream since ' + best.r.date +
    '; castlabs has no stable +wvcus ' + best.t.major + ' tag yet' : null;
}

/* ---- the network half ------------------------------------------------------------------------ */

function lsRemote() {
  return execFileSync('git', ['ls-remote', '--tags', REPO_URL], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function upstreamIndex() {
  const res = await fetch(UPSTREAM_INDEX, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('releases.json answered HTTP ' + res.status);
  const list = await res.json();
  const map = new Map();
  for (const r of list) map.set(r.version, r);
  return map;
}

/** The castlabs tag's publish date: gh first, then the public API. -> { date, from } or { date: null, why } */
async function castlabsDate(tag) {
  const api = 'repos/' + REPO + '/releases/tags/' + encodeURIComponent(tag);
  try {
    const out = execFileSync('gh', ['api', api, '--jq', '.published_at'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (out) return { date: out, from: 'castlabs release (gh)' };
  } catch (e) { /* no gh, not signed in, or no release for the tag: try the public API */ }
  try {
    const res = await fetch('https://api.github.com/' + api, { headers: { 'User-Agent': 'quartz-check-electron', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) });
    if (res.ok) { const j = await res.json(); if (j.published_at) return { date: j.published_at, from: 'castlabs release' }; }
    return { date: null, why: 'GitHub API answered HTTP ' + res.status + (res.status === 403 ? ' (rate limit?)' : '') };
  } catch (e) {
    return { date: null, why: 'GitHub API unreachable (' + (e && e.message || e) + ')' };
  }
}

async function main(argv) {
  const json = argv.includes('--json');
  const pre = argv.includes('--pre');
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const spec = (pkg.dependencies && pkg.dependencies.electron) || (pkg.devDependencies && pkg.devDependencies.electron) || '';
  const pin = pinFromPackage(spec);
  if (!pin) {
    console.log('check-electron: cannot check: package.json electron is "' + spec + '", not a castlabs +wvcus tag');
    return 2;
  }

  let tags;
  try { tags = tagsFromLsRemote(lsRemote()); } catch (e) {
    console.log('check-electron: cannot check: git ls-remote ' + REPO_URL + ' failed (' + String(e && e.message || e).split('\n')[0] + ')');
    return 2;
  }
  if (!tags.length) { console.log('check-electron: cannot check: no +wvcus tags came back from ' + REPO_URL); return 2; }

  let index = null, indexWhy = '';
  try { index = await upstreamIndex(); } catch (e) { indexWhy = String(e && e.message || e); }

  const p = plan(tags, pin, { pre });
  const now = new Date();
  // Dates for the tags the verdict needs (three API calls at most).
  const want = [pin, p.latestSame, p.latestNewerMajor].filter(Boolean);
  const dates = {}, dateNote = {};
  for (const t of want) {
    const c = await castlabsDate(t.tag);
    if (c.date) { dates[t.tag] = c.date; dateNote[t.tag] = c.from; continue; }
    const up = index && index.get(t.version);
    if (up && up.date) { dates[t.tag] = up.date; dateNote[t.tag] = 'upstream Electron date; castlabs date unavailable: ' + c.why; }
    else dateNote[t.tag] = 'no date: ' + c.why + (indexWhy ? '; releases.json: ' + indexWhy : '');
  }
  const row = (t) => {
    const up = index && index.get(t.version);
    const d = dates[t.tag];
    return { tag: t.tag, chromium: up ? up.chrome : null, date: d ? String(d).slice(0, 10) : null,
      ageDays: d ? daysBetween(d, now) : null, dateFrom: dateNote[t.tag] || null };
  };
  const v = verdict(p, pin, dates, now);
  const report = {
    pin: row(pin),
    latestSameMajor: p.latestSame ? row(p.latestSame) : null,
    newerMajors: p.newerMajors.map((t) => (t === p.latestNewerMajor ? row(t) : { tag: t.tag, chromium: index && index.get(t.version) ? index.get(t.version).chrome : null })),
    newerTags: p.newer.map((t) => t.tag),
    upstreamIndex: index ? 'ok' : 'unavailable: ' + indexWhy,
    upstreamAhead: index ? upstreamAhead(index, pin, tags) : null,
    verdict: v,
  };
  if (json) { console.log(JSON.stringify(report, null, 2)); return v.level === 'overdue' ? 1 : 0; }

  const fmt = (r) => r.tag + '  Chromium ' + (r.chromium || '? (not in releases.json' + (indexWhy ? ': ' + indexWhy : '') + ')') +
    '  tagged ' + (r.date || '?') + (r.ageDays !== null && r.ageDays !== undefined ? ' (' + r.ageDays + ' days ago)' : '') +
    (r.dateFrom && !/^castlabs release/.test(r.dateFrom) ? '  [' + r.dateFrom + ']' : '');
  console.log('pinned (package.json):     ' + fmt(report.pin));
  console.log('latest ' + pin.major + '.x castlabs:      ' + (report.latestSameMajor ? fmt(report.latestSameMajor) : 'the pin itself'));
  if (report.newerMajors.length) {
    for (const r of report.newerMajors) console.log('newer major:               ' + (r.date !== undefined ? fmt(r) : r.tag + '  Chromium ' + (r.chromium || '?')));
  } else {
    console.log('newer major:               none stable yet');
  }
  if (report.upstreamAhead) console.log('upstream, not yet castlabs: ' + report.upstreamAhead);
  console.log('tags newer than the pin:   ' + (report.newerTags.length ? report.newerTags.join(', ') : 'none') + (pre ? '' : '  (stable only; --pre lists alphas/betas)'));
  console.log('check-electron: ' + v.line);
  return v.level === 'overdue' ? 1 : 0;
}

module.exports = { upstreamAhead, parseTag, pinFromPackage, compare, tagsFromLsRemote, plan, daysBetween, verdict, PATCH_DAYS, MAJOR_DAYS };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.log('check-electron: cannot check: ' + (e && e.stack || e));
    process.exit(2);
  });
}
