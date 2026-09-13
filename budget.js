'use strict';

/*
 * budget.js — the Claude Code usage readout (main process).
 *
 * It watches one folder of JSON files and turns it into one small object that
 * the titlebar pill and the new tab page both read. There is no network here
 * and nothing is written: the folder is Claude Code's, this only reads it.
 *
 * SOURCE. Claude Code's statusLine hook writes one JSON per session to
 *   C:\Users\you\mission-control\data\statusline\<session>.json
 * with `receivedAt`, `cost.total_cost_usd`, `rate_limits.five_hour
 * .{used_percentage,resets_at}` and `rate_limits.seven_day.{...}` (resets_at
 * is epoch SECONDS). The newest file by mtime is the truth; a file older than
 * ten minutes is reported as stale, never silently.
 *
 * CONTRACT
 *   create({ app, ipcMain, isChromeSender, isBundledPage, send })
 *     -> { snapshot(), stop() }
 *   snapshot() -> {
 *     state: 'ok' | 'stale' | 'error' | 'unbuilt',
 *     reason: string,                       // plain words, always set when state != 'ok'
 *     at: number,                            // ms, when this snapshot was taken
 *     fiveHour: { pct: number, resetsAt: number } | null,   // resetsAt in ms
 *     week:     { pct: number, resetsAt: number } | null,
 *     todayUsd: number | null,               // sum over sessions touched today
 *     sessionsToday: number,
 *     source: { file: string, receivedAt: number, ageMs: number } | null
 *   }
 *   IPC (chrome only, gated by isChromeSender):
 *     'budget:describe' -> snapshot()
 *   Push (chrome): send('budget:update', snapshot()) on every change, 30 s poll.
 *   New-tab guests have no preload: a guest prints
 *     console.log('newtab:budget {"action":"subscribe"}')
 *   and main answers with contents.executeJavaScript('window.__applyBudget(...)')
 *   exactly the way stocks.js does for its tile.
 *
 * NOTES ON THE CONTRACT AS BUILT
 *   - 'unbuilt' is still a legal state for a reader to receive, but nothing
 *     here emits it any more: the first reading is taken synchronously inside
 *     create(), so snapshot() is a real answer from the first call onward.
 *   - `reason` is also set on an 'ok' snapshot when something partial
 *     happened (a file in the folder that would not parse). The state is
 *     honest — the numbers ARE good — and the note still reaches the card,
 *     because a file we silently skipped is exactly the kind of thing that
 *     should not be silent.
 *   - The extra create() options `dir`, `now`, `setTimer` and `clearTimer`
 *     exist for the harness. Main passes none of them.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** How often the folder is re-read. The statusline hook ticks far faster. */
const POLL_MS = 30000;

/**
 * Older than this and the reading is stale. Claude Code only writes while a
 * session is actually running, so "stale" is the normal state of a quiet
 * afternoon — which is why the reason says so in as many words instead of
 * looking like a fault.
 */
const STALE_MS = 10 * 60 * 1000;

/**
 * A file is only opened when its mtime is near enough to today to be able to
 * carry a `receivedAt` from today. The hook rewrites the file on every tick,
 * so mtime and receivedAt are the same instant; six hours of slack covers a
 * clock nudge or a daylight-saving step without opening 90 files a tick.
 */
const TODAY_SLACK_MS = 6 * 60 * 60 * 1000;

/** The default folder. `dir` in the options overrides it (the harness does). */
function defaultDir() {
  return path.join(os.homedir(), 'mission-control', 'data', 'statusline');
}

/** Local midnight at the start of the day `ms` falls in. */
function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** True when the two instants are the same LOCAL calendar day. */
function sameLocalDay(a, b) {
  return startOfLocalDay(a) === startOfLocalDay(b);
}

/** A finite number, or null. Percentages and dollars both come through here. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** "14 min", "3 h 12 m", "just now" — the age in words, for a reason line. */
function ageWords(ms) {
  const n = Math.max(0, Math.round(ms / 60000));
  if (n < 1) return 'under a minute';
  if (n < 60) return n + ' min';
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? h + ' h ' + m + ' m' : h + ' h';
}

/**
 * One statusline document -> the fields we use, or null if it is not one.
 * Everything is checked: a half-written file (the hook writes a .tmp and
 * renames, but a crash mid-write is still a thing) must read as bad JSON
 * rather than as a session that cost NaN dollars.
 */
function parseDoc(text) {
  let json;
  try { json = JSON.parse(text); } catch { return null; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

  const receivedAt = Date.parse(String(json.receivedAt || ''));
  if (!Number.isFinite(receivedAt)) return null;

  const limits = (json.rate_limits && typeof json.rate_limits === 'object') ? json.rate_limits : null;
  const window = (key) => {
    const row = limits && limits[key] && typeof limits[key] === 'object' ? limits[key] : null;
    if (!row) return null;
    const pct = num(row.used_percentage);
    const resets = num(row.resets_at);
    if (pct === null) return null;
    /* resets_at is epoch SECONDS in this file and milliseconds everywhere
       else in the app; converted here so nothing downstream has to know. */
    return { pct, resetsAt: resets === null ? 0 : Math.round(resets * 1000) };
  };

  return {
    receivedAt,
    costUsd: num(json.cost && json.cost.total_cost_usd),
    fiveHour: window('five_hour'),
    week: window('seven_day'),
  };
}

/** The key a change is judged on: the numbers and the words, not the clock. */
function changeKey(snap) {
  const pct = (w) => (w ? w.pct + '@' + w.resetsAt : '-');
  return [
    snap.state,
    snap.reason,
    pct(snap.fiveHour),
    pct(snap.week),
    snap.todayUsd === null ? '-' : snap.todayUsd.toFixed(4),
    snap.sessionsToday,
    snap.source ? snap.source.receivedAt : '-',
  ].join('|');
}

function create(options) {
  const opts = options || {};
  const ipcMain = opts.ipcMain;
  const send = typeof opts.send === 'function' ? opts.send : () => {};
  const gate = typeof opts.isChromeSender === 'function' ? opts.isChromeSender : () => false;
  const isBundledPage = typeof opts.isBundledPage === 'function' ? opts.isBundledPage : () => false;
  const electronApp = opts.app;
  const dir = opts.dir || defaultDir();
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));

  /** contents.id -> { contents, count, lastKey } — the new-tab guests. */
  const guests = new Map();

  let last = null;
  let lastKey = '';
  let timer = null;

  /* --- reading the folder ---------------------------------------------- */

  /**
   * A snapshot that could not be taken. `at` is still set, because the pill
   * shows the age of whatever it is holding either way.
   */
  function failed(reason) {
    return {
      state: 'error',
      reason,
      at: now(),
      fiveHour: null,
      week: null,
      todayUsd: null,
      sessionsToday: 0,
      source: null,
    };
  }

  /**
   * Read the folder and build one snapshot. Synchronous on purpose: it is ~90
   * stat() calls and a handful of small reads once every 30 s, and a
   * synchronous read cannot interleave with the rename the hook does, so a
   * tick never sees half a folder.
   */
  function read() {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      const code = err && err.code;
      if (code === 'ENOENT') return failed('the statusline folder is not there: ' + dir);
      return failed('cannot read the statusline folder (' + (code || 'error') + '): ' + dir);
    }

    /* Only real .json files. The hook leaves <session>.json.<pid>.tmp files
       behind when a write is interrupted; those are not readings. */
    const files = [];
    for (const name of names) {
      if (name.length < 6 || name.slice(-5).toLowerCase() !== '.json') continue;
      let stat;
      try { stat = fs.statSync(path.join(dir, name)); } catch { continue; }
      if (!stat.isFile()) continue;
      files.push({ name, mtimeMs: stat.mtimeMs });
    }

    if (!files.length) {
      return failed('no statusline readings in ' + dir + ' yet — Claude Code writes one per session while it runs');
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const newest = files[0];

    /* Today's spend. Every file whose reading landed on today's LOCAL date
       counts once; the rest are not even opened (see TODAY_SLACK_MS). */
    const at = now();
    const dayFloor = startOfLocalDay(at) - TODAY_SLACK_MS;
    let todayUsd = 0;
    let sessionsToday = 0;
    let unreadable = 0;
    let newestDoc = null;

    for (const file of files) {
      const isNewest = file === newest;
      if (!isNewest && file.mtimeMs < dayFloor) continue;
      let doc = null;
      try {
        doc = parseDoc(fs.readFileSync(path.join(dir, file.name), 'utf8'));
      } catch {
        doc = null;
      }
      if (!doc) {
        unreadable += 1;
        if (isNewest) {
          return failed('the newest statusline file is not readable as a reading: ' + file.name);
        }
        continue;
      }
      if (isNewest) newestDoc = doc;
      if (sameLocalDay(doc.receivedAt, at) && doc.costUsd !== null) {
        todayUsd += doc.costUsd;
        sessionsToday += 1;
      }
    }

    if (!newestDoc.fiveHour && !newestDoc.week) {
      return failed('the newest statusline file has no rate limits in it: ' + newest.name);
    }

    const ageMs = Math.max(0, at - newestDoc.receivedAt);
    const stale = ageMs > STALE_MS;

    /* An 'ok' reading can still carry a note. A file we skipped without
       saying so would be exactly the silent failure this app does not do. */
    let reason = '';
    if (stale) {
      reason = 'newest reading is ' + ageWords(ageMs) +
        ' old — Claude Code only writes while a session is running';
    } else if (unreadable) {
      reason = unreadable + (unreadable === 1 ? ' file in' : ' files in') +
        ' the statusline folder could not be read; the rest are counted';
    }

    return {
      state: stale ? 'stale' : 'ok',
      reason,
      at,
      fiveHour: newestDoc.fiveHour,
      week: newestDoc.week,
      todayUsd: Math.round(todayUsd * 1e6) / 1e6,
      sessionsToday,
      source: { file: newest.name, receivedAt: newestDoc.receivedAt, ageMs },
    };
  }

  /* --- pushing --------------------------------------------------------- */

  function snapshot() {
    return last;
  }

  /**
   * Take a reading and hand it out if anything moved. `at` and the age move
   * every tick by definition and are not part of the key: the pill ages its
   * own reading against its own clock between pushes.
   */
  function refresh() {
    const next = read();
    const key = changeKey(next);
    const changed = key !== lastKey;
    last = next;
    lastKey = key;
    if (changed) {
      send('budget:update', next);
      pushGuests();
    }
    return next;
  }

  function schedule() {
    if (timer) return;
    timer = setTimer(function tick() {
      timer = null;
      try { refresh(); } catch { /* a reading that threw must not stop the poll */ }
      schedule();
    }, POLL_MS);
  }

  /* --- the guest channel ------------------------------------------------
     The new tab page is a preload-less file:// guest, so it asks on its
     console and is answered by executeJavaScript — the same channel
     stocks.js uses for the markets tile, built the same way on purpose. */

  /** `newtab:budget {json}` off a guest's console. null for every other line. */
  function parseGuestLine(line) {
    const s = String(line == null ? '' : line);
    if (s.slice(0, 14) !== 'newtab:budget ') return null;
    let body;
    try { body = JSON.parse(s.slice(14)); } catch { return null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const action = String(body.action || '');
    return action ? { action } : null;
  }

  function pushTo(rec) {
    const contents = rec.contents;
    if (!contents || contents.isDestroyed()) return;
    let json;
    try { json = JSON.stringify(last); } catch { return; }
    /* JSON is not quite a JS literal: U+2028/9 are line terminators in
       source but legal inside a JSON string, and this string becomes source. */
    const safe = json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const code = 'window.__applyBudget && window.__applyBudget(' + safe + ')';
    try {
      const answer = contents.executeJavaScript(code, true);
      if (answer && typeof answer.catch === 'function') answer.catch(() => {});
    } catch { /* the guest navigated away mid-push */ }
  }

  /** Every guest that is not already showing this reading. */
  function pushGuests() {
    for (const rec of guests.values()) {
      if (rec.lastKey === lastKey) continue;
      rec.lastKey = lastKey;
      pushTo(rec);
    }
  }

  function subscribe(contents) {
    if (!contents || contents.isDestroyed()) return;
    const id = contents.id;
    const rec = guests.get(id);
    if (rec) {
      rec.count += 1;
      /* A re-subscribe is a page that just came back on screen: it has
         nothing on it, so the memo is dropped and it is painted again. */
      rec.lastKey = '';
      pushTo(rec);
      rec.lastKey = lastKey;
      return;
    }
    const fresh = { contents, count: 1, lastKey };
    guests.set(id, fresh);
    contents.once('destroyed', () => drop(id, false));
    pushTo(fresh);
  }

  function unsubscribe(contents) {
    if (!contents) return;
    drop(contents.id, true);
  }

  function drop(id, oneOnly) {
    const rec = guests.get(id);
    if (!rec) return;
    if (oneOnly) rec.count -= 1;
    else rec.count = 0;
    if (rec.count > 0) return;
    guests.delete(id);
  }

  /**
   * Electron has changed this event's shape: >=36 emits one details object,
   * older builds emit (event, level, message, ...). Both are read, so the
   * module does not break on an Electron bump in either direction.
   */
  function messageOf(first, args) {
    if (first && typeof first === 'object' && typeof first.message === 'string') return first.message;
    /* The pre-36 shape: (event, level, message, line, sourceId). Read off
       `arguments` rather than as declared parameters, because Electron 44
       deprecation-warns on any console-message listener with more than one. */
    if (typeof args[2] === 'string') return args[2];
    if (typeof args[1] === 'string') return args[1];
    return '';
  }

  /** One `newtab:budget` line from a guest. Returns true if it was ours. */
  function handleGuestLine(contents, line) {
    const msg = parseGuestLine(line);
    if (!msg) return false;
    if (msg.action === 'subscribe') { subscribe(contents); return true; }
    if (msg.action === 'unsubscribe') { unsubscribe(contents); return true; }
    if (msg.action === 'refresh') {
      /* A page asking for a repaint gets one whether or not the numbers
         moved — that is the whole point of asking. */
      refresh();
      const rec = guests.get(contents.id);
      if (rec) { rec.lastKey = ''; pushTo(rec); rec.lastKey = lastKey; }
      return true;
    }
    return false;
  }

  /**
   * Put a listener on one guest. Called for every <webview> main creates; the
   * URL test is done per MESSAGE rather than once here, because a guest is
   * created before it has navigated anywhere.
   */
  function watchGuest(contents) {
    if (!contents || contents.isDestroyed()) return;
    contents.on('console-message', function (details) {
      let url = '';
      try { url = contents.getURL(); } catch { url = ''; }
      if (!isBundledPage(url)) return;
      try { handleGuestLine(contents, messageOf(details, arguments)); } catch { /* a line we could not use */ }
    });
  }

  function stop() {
    if (timer) { clearTimer(timer); timer = null; }
    guests.clear();
  }

  /* --- wiring ----------------------------------------------------------- */

  last = read();
  lastKey = changeKey(last);
  schedule();

  if (electronApp && typeof electronApp.on === 'function') {
    electronApp.on('web-contents-created', (_event, contents) => {
      try {
        if (contents && contents.getType() === 'webview') watchGuest(contents);
      } catch { /* a guest that died between creation and here */ }
    });
  }

  if (ipcMain && typeof ipcMain.handle === 'function') {
    ipcMain.handle('budget:describe', (event) => (gate(event) ? snapshot() : null));
  }

  return {
    snapshot,
    stop,
    /* Everything below is for the harness and for a doctor line later. */
    refresh,
    subscribe,
    unsubscribe,
    handleGuestLine,
    watchGuest,
    guestCount: () => guests.size,
  };
}

module.exports = { create, parseDoc, changeKey, ageWords, startOfLocalDay, sameLocalDay };
