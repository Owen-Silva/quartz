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
 * is epoch SECONDS). The newest file by mtime is the truth; an age of ten
 * minutes or more is reported, and an hour or more is called stale — never
 * silently either way.
 *
 * AGE IS NOT A FAULT. A Claude Code session that is idle simply stops writing:
 * the limits it last reported are still the truth, only older. So ten minutes
 * buys a note and the age beside the numbers, and only an hour earns the word
 * "stale" and a dimmed pill. Unreadable or missing files are the real fault
 * and are still 'error'.
 *
 * TODAY'S SPEND IS A DELTA, NOT A TOTAL. Each statusline file carries its
 * session's LIFETIME cost, and a session that has run for days would otherwise
 * dump all of it into "today". A per-day baseline file (<userData>/
 * budget-day.json) remembers what each session had already cost when this
 * machine first looked at it today; today's spend is the sum of the growth
 * since. A session that STARTED today is the exception: all of its cost is
 * today's, so its baseline is zero.
 *
 * HOW A SESSION'S START IS KNOWN. Not from the file's birthtime: the hook
 * writes a .tmp and renames it over the target on every tick, so the file is
 * brand new every 30 seconds and its birthtime always equals its mtime
 * (measured on the live folder — every one of the user's files had birth == mtime
 * to the millisecond). The honest number is `receivedAt - cost
 * .total_duration_ms`, which is wall-clock since the session opened; checked
 * against the birthtimes of the matching .jsonl transcripts, it lands on the
 * same minute for every live session. Birthtime is kept only as a fallback
 * for a document with no duration in it, and the fallback from THERE is to
 * treat the session as older — the side that never overcounts.
 *
 * CONTRACT
 *   create({ app, ipcMain, isChromeSender, isBundledPage, send })
 *     -> { snapshot(), stop() }
 *   snapshot() -> {
 *     state: 'ok' | 'stale' | 'error' | 'unbuilt',   // 'stale' = an hour or older
 *     reason: string,                       // plain words, always set when state != 'ok'
 *     at: number,                            // ms, when this snapshot was taken
 *     fiveHour: { pct: number, resetsAt: number } | null,   // resetsAt in ms
 *     week:     { pct: number, resetsAt: number } | null,
 *     todayUsd: number | null,               // growth today, over sessions touched today
 *     sessionsToday: number,
 *     todaySince: number | null,             // ms: when a mid-flight baseline was taken
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
 *   - The extra create() options `dir`, `now`, `setTimer`, `clearTimer`,
 *     `stateFile` and `stat` exist for the harness. Main passes none of them:
 *     it gets the folder from the home directory and the baseline file from
 *     app.getPath('userData').
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** How often the folder is re-read. The statusline hook ticks far faster. */
const POLL_MS = 30000;

/**
 * From here the age is worth saying out loud: the pill appends it and the card
 * explains it. The numbers are still the truth — Claude Code only writes while
 * a session is actually running, so a quiet afternoon is not a fault.
 */
const AGE_NOTE_MS = 10 * 60 * 1000;

/**
 * And from HERE the reading is old enough to be called stale: an hour without
 * a tick means nothing has been running long enough that the percentages may
 * have moved under us (a limit window can roll in an hour). The word and the
 * dimmed pill are reserved for this, not for a ten-minute pause.
 */
const STALE_MS = 60 * 60 * 1000;

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

/**
 * 'YYYY-MM-DD' in LOCAL time — the key the baseline file is stamped with.
 * Deliberately not toISOString(): that is UTC, and a day that rolls over at
 * 8 pm local would reset the figure in the middle of the user's evening.
 */
function localDateKey(ms) {
  const d = new Date(ms);
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** The session id a statusline file belongs to: its name without '.json'. */
function sessionIdOf(name) {
  return String(name).slice(0, -5);
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

  /* Wall-clock since the session opened. It is what makes "did this session
     start today" answerable — see the note at the top of the file. */
  const durationMs = num(json.cost && json.cost.total_duration_ms);

  return {
    receivedAt,
    costUsd: num(json.cost && json.cost.total_cost_usd),
    durationMs,
    startedAt: durationMs === null ? null : receivedAt - durationMs,
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
    snap.todaySince === null || snap.todaySince === undefined ? '-' : snap.todaySince,
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
  /* The harness fakes birthtimes through here; main never passes it. */
  const statFile = typeof opts.stat === 'function' ? opts.stat : (file) => fs.statSync(file);

  /* Where the per-day baselines live. The user's userData, not the statusline
     folder: that one is Claude Code's and this module never writes to it. */
  let stateFile = '';
  let stateWhy = '';
  const memoryOnly = "today's baselines are held in memory only (no app data folder), " +
    "so today's figure restarts with the browser";
  if (typeof opts.stateFile === 'string') {
    stateFile = opts.stateFile;
    if (!stateFile) stateWhy = memoryOnly;
  } else if (electronApp && typeof electronApp.getPath === 'function') {
    try { stateFile = path.join(electronApp.getPath('userData'), 'budget-day.json'); } catch (err) {
      stateFile = '';
      stateWhy = 'the app data folder could not be found (' + ((err && err.message) || 'error') +
        '), so today\'s figure is counted from when this window opened';
    }
  } else {
    stateWhy = memoryOnly;
  }

  /** contents.id -> { contents, count, lastKey } — the new-tab guests. */
  const guests = new Map();

  let last = null;
  let lastKey = '';
  let timer = null;

  /* --- the per-day baselines -------------------------------------------
     { date: 'YYYY-MM-DD' local, sessions: { <id>: { baseline, first } } }
     `baseline` is what a session had ALREADY cost when this machine first saw
     it today, and `first` is when that happened. A session whose file was born
     today has a baseline of 0, because all of its cost is today's. Kept on
     disk so closing the browser does not reset the day. */

  let day = { date: '', sessions: {} };
  let dayOnDisk = '';        // what was last written, so an unchanged day is not rewritten
  let saveFailed = false;

  function dayJson() {
    try { return JSON.stringify(day); } catch { return ''; }
  }

  function loadDay() {
    day = { date: '', sessions: {} };
    dayOnDisk = '';
    if (!stateFile) return;
    let text;
    try {
      text = fs.readFileSync(stateFile, 'utf8');
    } catch (err) {
      /* Not there on the first run of a profile: that is the normal case and
         it is not a fault. Anything else is, and it says so. */
      if (!err || err.code !== 'ENOENT') {
        stateWhy = 'the day-baseline file could not be read (' + ((err && err.code) || 'error') +
          "), so today's figure is counted from now: " + stateFile;
      }
      return;
    }
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    const sessions = json && json.sessions && typeof json.sessions === 'object' && !Array.isArray(json.sessions)
      ? json.sessions : null;
    if (!json || typeof json.date !== 'string' || !sessions) {
      stateWhy = 'the day-baseline file was unreadable and was started over, ' +
        "so today's figure is counted from now: " + stateFile;
      return;
    }
    /* Every row is checked: a baseline of NaN would make today's figure NaN
       for the rest of the day. */
    const clean = {};
    for (const id of Object.keys(sessions)) {
      const row = sessions[id];
      if (!row || typeof row !== 'object') continue;
      const baseline = num(row.baseline);
      if (baseline === null || baseline < 0) continue;
      const first = num(row.first);
      clean[id] = { baseline, first: first === null ? 0 : first };
    }
    day = { date: json.date, sessions: clean };
    dayOnDisk = dayJson();
  }

  function saveDay() {
    if (!stateFile) return;
    const text = dayJson();
    if (!text || text === dayOnDisk) return;      // nothing moved; no disk churn
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, text);
      dayOnDisk = text;
      if (saveFailed) { saveFailed = false; stateWhy = ''; }
    } catch (err) {
      saveFailed = true;
      stateWhy = 'the day-baseline file could not be saved (' + ((err && err.code) || 'error') +
        "), so today's figure may restart: " + stateFile;
    }
  }

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
      todaySince: null,
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
      try { stat = statFile(path.join(dir, name)); } catch { continue; }
      if (!stat.isFile()) continue;
      /* birthtime is how a session that STARTED today is told from one that
         has been running for days; a filesystem that has no real one gives 0
         or NaN, which reads as "older" — the side that never overcounts. */
      files.push({ name, mtimeMs: stat.mtimeMs, birthtimeMs: num(stat.birthtimeMs) });
    }

    if (!files.length) {
      return failed('no statusline readings in ' + dir + ' yet — Claude Code writes one per session while it runs');
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const newest = files[0];

    /* Today's spend. Every file whose reading landed on today's LOCAL date
       counts once; the rest are not even opened (see TODAY_SLACK_MS). What is
       counted is the GROWTH since the baseline, never the session's lifetime
       total — three sessions that have run all week are not $1,800 of today. */
    const at = now();
    const dayFloor = startOfLocalDay(at) - TODAY_SLACK_MS;
    const dateKey = localDateKey(at);
    /* Midnight: the day's baselines are yesterday's and are thrown away. */
    if (day.date !== dateKey) day = { date: dateKey, sessions: {} };
    let todayUsd = 0;
    let sessionsToday = 0;
    let todaySince = null;
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
          saveDay();
          return failed('the newest statusline file is not readable as a reading: ' + file.name);
        }
        continue;
      }
      if (isNewest) newestDoc = doc;
      if (sameLocalDay(doc.receivedAt, at) && doc.costUsd !== null) {
        const id = sessionIdOf(file.name);
        let row = day.sessions[id];
        if (!row) {
          /* First sight of this session today. A session that STARTED today
             spent all of its money today; one that was already running spent
             an unknown part of it yesterday, so only what it spends from this
             moment on can honestly be called today's. */
          const startedToday = doc.startedAt !== null
            ? sameLocalDay(doc.startedAt, at)
            : (file.birthtimeMs !== null && sameLocalDay(file.birthtimeMs, at));
          row = { baseline: startedToday ? 0 : doc.costUsd, first: at };
          day.sessions[id] = row;
        }
        /* Never negative: a cost that went DOWN is a session id reused or a
           file rewritten from scratch, and neither is money spent today. */
        todayUsd += Math.max(0, doc.costUsd - row.baseline);
        sessionsToday += 1;
        /* Only a MID-FLIGHT baseline makes the figure a partial one, and only
           then does the card say what it is counted from. */
        if (row.baseline > 0 && (todaySince === null || row.first < todaySince)) {
          todaySince = row.first;
        }
      }
    }

    saveDay();

    if (!newestDoc.fiveHour && !newestDoc.week) {
      return failed('the newest statusline file has no rate limits in it: ' + newest.name);
    }

    const ageMs = Math.max(0, at - newestDoc.receivedAt);
    const stale = ageMs >= STALE_MS;

    /* An 'ok' reading can still carry notes, and it carries ALL of them: a
       file we skipped, or a baseline we could not keep, without saying so
       would be exactly the silent failure this app does not do. Age is first
       because it is the one that explains the pill. */
    const notes = [];
    if (ageMs >= AGE_NOTE_MS) {
      notes.push('last written ' + ageWords(ageMs) +
        ' ago — Claude Code writes only while a session is active');
    }
    if (unreadable) {
      notes.push(unreadable + (unreadable === 1 ? ' file in' : ' files in') +
        ' the statusline folder could not be read; the rest are counted');
    }
    if (stateWhy) notes.push(stateWhy);

    return {
      state: stale ? 'stale' : 'ok',
      reason: notes.join(' · '),
      at,
      fiveHour: newestDoc.fiveHour,
      week: newestDoc.week,
      todayUsd: Math.round(todayUsd * 1e6) / 1e6,
      sessionsToday,
      todaySince,
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

  /* The baselines have to be in hand BEFORE the first reading, or the first
     reading of every run would re-baseline every session to its current cost
     and today's figure would restart at zero on every launch. */
  loadDay();
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
    dayState: () => JSON.parse(dayJson() || '{}'),
  };
}

module.exports = {
  create, parseDoc, changeKey, ageWords, startOfLocalDay, sameLocalDay, localDateKey,
  AGE_NOTE_MS, STALE_MS,
};
