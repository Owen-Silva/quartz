'use strict';
/*
 * watch-leaks.js -- Lumen's leak log (main process).
 *
 * Lumen is a full replacement for the services' own apps, so every time it has to send
 * the user somewhere else is a bug to find: a normal Quartz tab, Microsoft Edge, an app link
 * (disneyplus://, intent:) a hosted page tried, or a window. Each one is recorded here:
 *
 *   - ONE quartz.log line (the caller's own wording, so the existing lines stay as they are);
 *   - a counter in <userData>/watch-leaks.json: how many, of which kind, and the last reason,
 *     which Settings > Lumen shows as "Times Lumen had to leave: N, last: <reason>".
 *
 * Nothing here decides where a page goes; watch-main.js and watch-player-main.js do, and
 * call record() when the answer is "out of Lumen". The file holds no URL path or query,
 * only the host, so a search or a title id never lands on disk.
 */
const fs = require('fs');
const path = require('path');

const FILE = 'watch-leaks.json';
const KINDS = ['tab', 'edge', 'app', 'window'];
const REASON_MAX = 160;

function blank() {
  const kinds = {};
  for (const k of KINDS) kinds[k] = 0;
  return { count: 0, kinds, last: null };
}

function hostOf(url) {
  try { return new URL(String(url || '')).host.slice(0, 80); } catch { return ''; }
}

function clean(text, max) {
  return String(text || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || REASON_MAX);
}

/** What a stored file may hold; anything else is the empty state. */
function cleanState(raw) {
  const out = blank();
  if (!raw || typeof raw !== 'object') return out;
  const n = Number(raw.count);
  out.count = Number.isInteger(n) && n > 0 ? n : 0;
  if (raw.kinds && typeof raw.kinds === 'object') {
    for (const k of KINDS) { const v = Number(raw.kinds[k]); out.kinds[k] = Number.isInteger(v) && v > 0 ? v : 0; }
  }
  const l = raw.last;
  if (l && typeof l === 'object' && KINDS.indexOf(l.kind) !== -1) {
    const at = Number(l.at);
    out.last = { kind: l.kind, reason: clean(l.reason), host: clean(l.host, 80), at: Number.isFinite(at) && at > 0 ? at : 0 };
  }
  return out;
}

function create(deps) {
  const d = deps || {};
  const app = d.app || null;
  const log = typeof d.log === 'function' ? d.log : (line) => console.log('[lumen] ' + line);
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  let state = null;

  function file() {
    let dir = d.dir || '';
    if (!dir && app && typeof app.getPath === 'function') { try { dir = app.getPath('userData'); } catch { dir = ''; } }
    return dir ? path.join(dir, FILE) : '';
  }
  function load() {
    if (state) return state;
    const f = file();
    let raw = null;
    if (f) { try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { raw = null; } }
    state = cleanState(raw);
    return state;
  }
  function save() {
    const f = file();
    if (!f) return;
    try {
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, f);
    } catch (err) { log('Lumen: could not save the leak count: ' + clean((err && err.message) || err, 120)); }
  }

  /**
   * One way out of Lumen. o: { kind: 'tab'|'edge'|'app'|'window', reason, url, line }.
   * line: the quartz.log line to write (one per leak); without it, a plain one is made.
   * Returns the new state.
   */
  function record(o) {
    const x = o && typeof o === 'object' ? o : {};
    const kind = KINDS.indexOf(x.kind) !== -1 ? x.kind : 'tab';
    const host = hostOf(x.url);
    const reason = clean(x.reason) || ('left for ' + (kind === 'edge' ? 'Microsoft Edge' : kind === 'app' ? 'an app' : 'a tab'));
    const line = clean(x.line, 400) || ('Lumen left (' + kind + '): ' + reason + (host ? ': ' + host : ''));
    try { log(line); } catch { /* the log is gone; the count still moves */ }
    const s = load();
    s.count += 1;
    s.kinds[kind] += 1;
    s.last = { kind, reason, host, at: now() };
    save();
    return view();
  }

  function view() {
    const s = load();
    return { count: s.count, kinds: Object.assign({}, s.kinds), last: s.last ? Object.assign({}, s.last) : null };
  }

  function reset() {
    state = blank();
    save();
    return view();
  }

  return { record, state: view, reset, file };
}

/** The Settings line: "Times Lumen had to leave: 3, last: <reason>". */
function summary(st) {
  const s = cleanState(st);
  return 'Times Lumen had to leave: ' + s.count + (s.last && s.last.reason ? ', last: ' + s.last.reason : '');
}

module.exports = { create, summary, cleanState, FILE, KINDS };
