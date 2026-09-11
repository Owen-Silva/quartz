'use strict';

// autopause.js — Spotify auto-pause, main-process side.
//
// The user already has a working auto-pause tool at ~/spotify-autopause: a local
// PowerShell HTTP bridge (127.0.0.1, first free port of 8787-8790) driven by a
// scheduled task, plus an Opera GX extension that speaks to it. This module is
// the same client protocol, spoken from THIS browser, plus a switch that turns
// the whole-computer half on and off.
//
// Nothing under ~/spotify-autopause is modified from here. We are a client.
//
// Two prongs:
//
//   1. The whole-computer switch. ON means the scheduled task is enabled and
//      the bridge is answering; OFF means the task is DISABLED and the bridge
//      process is gone. Ending the task alone is not enough -- it carries a
//      repeating keepalive trigger, so a merely-ended task restarts itself
//      within minutes.
//
//   2. The browser prong. Guest <webview>s that are audible on a watched site
//      register a hold with the bridge, exactly the way the Opera extension
//      does, under a DIFFERENT src id so the two browsers can never release
//      each other's hold.
//
// Everything here is best effort and nothing ever throws at the renderer: a
// failure becomes plain-English text in `status.error`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The installed tool. Same layout install.ps1 created; we only read it. */
const TOOL_DIR = path.join(os.homedir(), 'spotify-autopause');
const BRIDGE_SCRIPT = path.join(TOOL_DIR, 'bridge', 'spotify-bridge.ps1');
const DOCTOR_SCRIPT = path.join(TOOL_DIR, 'doctor.ps1');
const TASK_NAME = '\\SpotifyAutoPause';

/** The bridge binds the first free one of these and writes its choice to port.txt. */
const BRIDGE_PORTS = [8787, 8788, 8789, 8790];

/**
 * The hold key. The bridge keys holds by `src` and only resumes when the LAST
 * hold is released, so Opera's 'browser' hold and ours have to be different
 * strings or one browser closing a video would hand back the other's hold.
 * The bridge validates src against ^[A-Za-z0-9:._-]{1,80}$ and silently falls
 * back to 'browser' for anything else -- 'owen-browser' passes.
 */
const BRIDGE_SRC = 'owen-browser';

/**
 * Two budgets, for two different questions -- the same split the extension
 * makes, and for the same measured reason.
 *
 *   PROBE   "is anything listening on a port I am guessing at?" A dead local
 *           port refuses instantly, so this only has to outlast a firewalled
 *           one. status() probes the whole range at once, so this is also the
 *           floor under its ~1.5 s answer.
 *
 *   ACTION  "the bridge is there -- let it finish." Its HTTP listener is
 *           single threaded and shares a thread with the native watcher tick
 *           (821 ms observed on this machine), so a short abort does NOT
 *           cancel the work: the bridge pauses Spotify and only fails to write
 *           the reply, which desyncs the client and stutters the music.
 */
const PROBE_TIMEOUT_MS = 600;
const ACTION_TIMEOUT_MS = 6000;

/** Sound has to last this long before we take a hold (the extension's pause delay). */
const HOLD_AFTER_MS = 1500;

/** And silence this long before we hand it back (the extension's resumeDelayMs). */
const RESUME_DELAY_MS = 1500;

/**
 * The bridge expires an HTTP hold after browserHoldTtlMs (180 s) unless it is
 * refreshed -- that TTL is what stops a hold outliving the browser and pinning
 * Spotify paused forever. 60 s gives three missed beats before it trips, which
 * is the cadence the extension uses.
 */
const REFRESH_MS = 60000;

/**
 * How often we ask an audible guest whether it is muted.
 *
 * Electron fires no event when a tab is muted: the renderer calls
 * `setAudioMuted()` on the <webview> tag, which goes straight to the guest's
 * WebContents without anything coming back to main. Worse, Chromium keeps a
 * muted tab AUDIBLE -- `audio-state-changed` stays true and
 * `isCurrentlyAudible()` stays true, because "this tab is producing sound" is
 * what draws Chrome's crossed-out speaker. Audible and audible-but-silenced are
 * only told apart by `isAudioMuted()`, and the only way to learn it changed is
 * to ask. 500 ms is under the mute button's own feel and the question is a
 * cheap in-process read, so it costs nothing a user could measure -- and we
 * only ever ask while something is audible (see syncMutePoll).
 */
const MUTE_POLL_MS = 500;

/**
 * Sites watched out of the box: the extension's list (minus the Spotify web
 * player) plus the streaming and video sites the user actually opens. Twitch was
 * the first miss reported (2026-09-11): a list only ever covers what someone
 * thought of, so "Any tab that makes sound" stays one switch away.
 */
const DEFAULT_SITES = [
  'youtube.com',
  'youtube-nocookie.com',
  'twitch.tv',
  'kick.com',
  'vimeo.com',
  'dailymotion.com',
  'tiktok.com',
  'netflix.com',
  'hulu.com',
  'disneyplus.com',
  'primevideo.com',
  'max.com',
  'peacocktv.com',
  'crunchyroll.com',
  'lessonplayer.example',
  'lessonplayer-academy.example',
  'lessons.example',
];

/**
 * Never counted as "a video", even with `anySite` on. Spotify's own web player
 * making sound is the one thing that must never pause Spotify -- the bridge
 * refuses a session whose AUMID matches /spotify/ for exactly this reason, and
 * the extension keeps open.spotify.com out of its match list on purpose.
 */
const NEVER_SITES = ['spotify.com', 'open.spotify.com'];

/** The defaults a config file written before `sitesBase` existed was built on. */
const LEGACY_BASE_SITES = [
  'youtube.com', 'youtube-nocookie.com', 'lessonplayer.example', 'lessonplayer-academy.example', 'lessons.example',
];

const DEFAULT_CONFIG = {
  browserHold: true,
  anySite: false,
  sites: DEFAULT_SITES.slice(),
  sitesBase: DEFAULT_SITES.slice(),
  // Only consulted when the scheduled task is missing: with no task to enable,
  // the switch is a remembered choice plus a directly launched bridge.
  directEnabled: false,
};

// ---------------------------------------------------------------------------
// Pure helpers
//
// Everything in this section is injectable-dependency free and exported, so the
// site matcher, the hold machine and the response parsing can be exercised from
// plain node with no Electron in the process.
// ---------------------------------------------------------------------------

/** Lowercased bare hostname: no scheme, no port, no trailing dot. '' if unusable. */
function normaliseHost(value) {
  let host = String(value == null ? '' : value).trim().toLowerCase();
  if (!host) return '';
  // Tolerate someone pasting a whole URL into the site list.
  if (host.includes('://')) host = host.slice(host.indexOf('://') + 3);
  host = host.split('/')[0].split('?')[0].split('#')[0];
  if (host.includes('@')) host = host.slice(host.indexOf('@') + 1);
  // IPv6 literals keep their brackets; everything else loses a :port.
  if (!host.startsWith('[')) host = host.split(':')[0];
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/** The host of a page URL, or '' for about:blank, file://, a bad URL, anything. */
function hostOfUrl(url) {
  try {
    return normaliseHost(new URL(String(url)).hostname);
  } catch {
    return '';
  }
}

/**
 * Does `host` belong to one of `sites`? An exact match or a subdomain of one --
 * `m.youtube.com` matches `youtube.com`, `notyoutube.com` does not.
 */
function hostMatchesSites(host, sites) {
  const h = normaliseHost(host);
  if (!h || !Array.isArray(sites)) return false;
  for (const raw of sites) {
    const site = normaliseHost(raw);
    if (!site) continue;
    if (h === site || h.endsWith('.' + site)) return true;
  }
  return false;
}

/** A hostname we accept into the site list: letters, digits, dots, hyphens. */
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Clean a list that came from a text box: normalise, drop junk, de-duplicate, cap. */
function sanitiseSites(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const raw of value) {
    const host = normaliseHost(raw);
    if (!host || host.length > 253 || !HOST_RE.test(host)) continue;
    if (out.indexOf(host) === -1) out.push(host);
    if (out.length >= 100) break;
  }
  return out;
}

/** True when this host must never count as playable audio, whatever the settings say. */
function isNeverSite(host) {
  return hostMatchesSites(host, NEVER_SITES);
}

/**
 * The fields of a bridge reply we actually rely on. /ping and /status are the
 * same handler and return the same document; /pause and /resume return it plus
 * `action` and `reason`. Anything missing degrades to a safe default rather
 * than throwing -- a bridge newer than this file must not break the UI.
 */
function parseBridgeStatus(json) {
  if (!json || typeof json !== 'object' || json.ok !== true) return null;
  return {
    ok: true,
    port: Number.isInteger(json.port) ? json.port : null,
    version: typeof json.version === 'string' ? json.version : '',
    spotifyFound: json.spotifyFound === true,
    spotifyState: typeof json.spotifyState === 'string' ? json.spotifyState : 'unknown',
    heldByUs: json.heldByUs === true,
    holds: Array.isArray(json.holds) ? json.holds.map(String) : [],
    action: typeof json.action === 'string' ? json.action : '',
    reason: typeof json.reason === 'string' ? json.reason : '',
  };
}

/**
 * schtasks /Query /V output -> { exists, enabled, running }.
 *
 * A missing task exits non-zero, so `code` decides existence. The task carries
 * several triggers and therefore prints several `Status:` blocks; the first is
 * as good as any. `Scheduled Task State` is the enabled/disabled flag proper,
 * and Status only backs it up when the line is absent.
 */
function parseTaskQuery(code, stdout) {
  if (code !== 0) return { exists: false, enabled: false, running: false };
  const text = String(stdout == null ? '' : stdout);
  const state = /^[ \t]*Scheduled Task State:[ \t]*(.+)$/im.exec(text);
  const status = /^[ \t]*Status:[ \t]*(.+)$/im.exec(text);
  const statusText = status ? status[1].trim() : '';
  const enabled = state
    ? !/disabled/i.test(state[1])
    : !/disabled/i.test(statusText);
  return { exists: true, enabled, running: /running/i.test(statusText) };
}

/** One short line of plain English out of a failed command, for status.error. */
function firstErrorLine(stderr, stdout, fallback) {
  const text = String(stderr || '').trim() || String(stdout || '').trim();
  if (!text) return fallback;
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) || fallback;
  return line.trim().replace(/^ERROR:\s*/i, '').slice(0, 300);
}

/**
 * The hold state machine, with every moving part injected so it can be driven
 * by fake timers in a test harness.
 *
 * `setPlaying(n)` is the only input. Everything else is bookkeeping:
 *
 *   n > 0 for holdAfterMs      -> onHold()      (a /pause that registers our src)
 *   held, every refreshMs      -> onRefresh()   (a repeat /pause: a refresh, not a pause)
 *   n === 0 for resumeDelayMs  -> onRelease()   (a /resume that hands the hold back)
 *
 * onHold/onRefresh/onRelease may be async and may fail. While one is in flight
 * the machine records the newest count and re-evaluates once it settles, so a
 * refresh can never race a release and re-register the hold we are handing back
 * -- the failure mode that pins Spotify paused with nothing left to free it.
 */
function createHoldMachine(opts) {
  const o = opts || {};
  const holdAfterMs = Number.isFinite(o.holdAfterMs) ? o.holdAfterMs : HOLD_AFTER_MS;
  const resumeDelayMs = Number.isFinite(o.resumeDelayMs) ? o.resumeDelayMs : RESUME_DELAY_MS;
  const refreshMs = Number.isFinite(o.refreshMs) ? o.refreshMs : REFRESH_MS;
  const setTimer = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer || ((t) => clearTimeout(t));
  const onHold = o.onHold || (async () => true);
  const onRefresh = o.onRefresh || (async () => true);
  const onRelease = o.onRelease || (async () => true);
  const onChange = o.onChange || (() => {});

  let playing = 0;
  let held = false;
  let holdTimer = null;
  let releaseTimer = null;
  let refreshTimer = null;
  let op = null;          // the promise of the in-flight bridge call, or null
  let dirty = false;      // setPlaying() arrived mid-op; re-evaluate after
  let stopped = false;

  function clearHoldTimer() {
    if (holdTimer !== null) { clearTimer(holdTimer); holdTimer = null; }
  }
  function clearReleaseTimer() {
    if (releaseTimer !== null) { clearTimer(releaseTimer); releaseTimer = null; }
  }
  function clearRefreshTimer() {
    if (refreshTimer !== null) { clearTimer(refreshTimer); refreshTimer = null; }
  }

  function armRefresh() {
    clearRefreshTimer();
    refreshTimer = setTimer(() => {
      refreshTimer = null;
      if (!held || stopped) return;
      run(async () => {
        // A repeat /pause for a src the bridge already holds is a refresh: it
        // does not move playback. A miss is survivable -- three of them and
        // the bridge's own TTL drops the hold for us.
        await onRefresh();
        if (held && !stopped) armRefresh();
      });
    }, refreshMs);
  }

  /** Serialise every bridge call; re-evaluate once the queue drains. */
  function run(fn) {
    if (op) { dirty = true; return op; }
    op = (async () => {
      try {
        await fn();
      } catch {
        // A bridge call never throws at the caller; the next evaluation retries.
      } finally {
        op = null;
      }
      if (dirty) { dirty = false; evaluate(); }
    })();
    return op;
  }

  function evaluate() {
    if (stopped) return;
    if (op) { dirty = true; return; }
    if (playing > 0) {
      clearReleaseTimer();
      if (held || holdTimer !== null) return;
      holdTimer = setTimer(() => {
        holdTimer = null;
        if (playing <= 0 || held || stopped) return;
        run(async () => {
          const ok = await onHold();
          if (ok && !stopped) {
            held = true;
            armRefresh();
            onChange();
          }
        });
      }, holdAfterMs);
      return;
    }
    // Nothing is playing. An unfired hold timer is simply cancelled -- there is
    // no hold to hand back yet.
    clearHoldTimer();
    if (!held || releaseTimer !== null) return;
    releaseTimer = setTimer(() => {
      releaseTimer = null;
      if (playing > 0 || !held || stopped) return;
      run(async () => {
        const ok = await onRelease();
        if (ok) {
          held = false;
          clearRefreshTimer();
          onChange();
        }
        // A failed release leaves `held` true on purpose: the hold really does
        // still exist on the bridge, and the next silence retries it.
      });
    }, resumeDelayMs);
  }

  return {
    setPlaying(n) {
      const next = Math.max(0, Number(n) || 0);
      if (next === playing) return;
      playing = next;
      evaluate();
    },
    /** Hand the hold back now, waiting for nothing. Used on quit. */
    async releaseNow() {
      clearHoldTimer();
      clearReleaseTimer();
      clearRefreshTimer();
      if (!held) return false;
      const ok = await onRelease();
      if (ok) { held = false; onChange(); }
      return ok;
    },
    /** The in-flight bridge call, or null -- a harness awaits this to settle. */
    pending() { return op; },
    get playing() { return playing; },
    get holding() { return held; },
    stop() {
      stopped = true;
      clearHoldTimer();
      clearReleaseTimer();
      clearRefreshTimer();
    },
  };
}

// ---------------------------------------------------------------------------
// Bridge client
// ---------------------------------------------------------------------------

/** One GET against the local bridge. Resolves to parsed JSON or null; never rejects. */
function httpGetJson(port, route, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let req;
    try {
      req = http.request(
        { host: '127.0.0.1', port, path: route, method: 'GET', timeout: timeoutMs },
        (res) => {
          if (res.statusCode !== 200) { res.resume(); done(null); return; }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
            // The bridge answers in a few hundred bytes. Anything else is not it.
            if (body.length > 262144) { req.destroy(); done(null); }
          });
          res.on('end', () => {
            try { done(JSON.parse(body)); } catch { done(null); }
          });
          res.on('error', () => done(null));
        }
      );
    } catch {
      done(null);
      return;
    }
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
    req.end();
  });
}

/**
 * The bridge client: port discovery plus the three calls we make.
 *
 * `deps.get(port, route, timeoutMs)` is the only I/O, so a harness can either
 * point it at the live bridge (it is the default) or fake it entirely.
 */
function createBridgeClient(deps) {
  const get = (deps && deps.get) || httpGetJson;
  const ports = (deps && deps.ports) || BRIDGE_PORTS;
  let cachedPort = null;

  async function probe(port, timeoutMs) {
    return parseBridgeStatus(await get(port, '/ping', timeoutMs));
  }

  /**
   * Find the bridge. The cached port first -- a busy bridge must not be
   * mistaken for a missing one -- then the whole range AT ONCE rather than in
   * series, because status() has to answer inside ~1.5 s and four sequential
   * probes would not fit if any of them ever hit its ceiling.
   */
  async function discover(timeoutMs) {
    const budget = timeoutMs || PROBE_TIMEOUT_MS;
    if (cachedPort !== null) {
      const hit = await probe(cachedPort, budget);
      if (hit) return { port: cachedPort, status: hit };
      cachedPort = null;
    }
    const results = await Promise.all(ports.map((p) => probe(p, budget)));
    for (let i = 0; i < ports.length; i += 1) {
      if (results[i]) {
        cachedPort = ports[i];
        return { port: ports[i], status: results[i] };
      }
    }
    return null;
  }

  return {
    /** { port, status } or null. Bounded at ~2x timeoutMs. */
    discover,
    /** The last port that answered, so a caller can report it without probing. */
    get port() { return cachedPort; },
    forget() { cachedPort = null; },
    /** One call on the discovered port, re-discovering once if it has moved. */
    async call(route) {
      let found = cachedPort === null ? await discover(PROBE_TIMEOUT_MS) : { port: cachedPort };
      if (!found) return null;
      let json = parseBridgeStatus(await get(found.port, route, ACTION_TIMEOUT_MS));
      if (!json) {
        cachedPort = null;
        found = await discover(PROBE_TIMEOUT_MS);
        if (!found) return null;
        json = parseBridgeStatus(await get(found.port, route, ACTION_TIMEOUT_MS));
      }
      return json;
    },
    pause(src) { return this.call('/pause?src=' + encodeURIComponent(src || BRIDGE_SRC)); },
    resume(src) { return this.call('/resume?src=' + encodeURIComponent(src || BRIDGE_SRC)); },
  };
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

/** execFile that reports rather than throws: { code, stdout, stderr }. */
function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs || 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) code = Number.isInteger(err.code) ? err.code : 1;
        resolve({
          code,
          stdout: String(stdout || ''),
          stderr: String(stderr || (err && err.message) || ''),
        });
      }
    );
  });
}

const POWERSHELL = 'powershell.exe';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The integration
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 *   deps.app       Electron's app, for userData. Optional -- without it the
 *                  config lives next to the tool, which is what a harness gets.
 *   deps.onChange  Called with a Status whenever anything moves.
 */
function create(deps) {
  const d = deps || {};
  const app = d.app || null;
  const onChange = typeof d.onChange === 'function' ? d.onChange : () => {};
  const toolDir = d.toolDir || TOOL_DIR;
  const bridgeScript = d.bridgeScript || path.join(toolDir, 'bridge', 'spotify-bridge.ps1');
  const doctorScript = d.doctorScript || path.join(toolDir, 'doctor.ps1');
  const taskName = d.taskName || TASK_NAME;
  const exec = d.run || run;
  const spawnFn = d.spawn || spawn;
  const bridge = d.bridge || createBridgeClient({ get: d.get });
  /**
   * Every timer this integration owns -- the hold machine's and the mute poll's
   * -- goes through these, so a harness can drive the whole guest -> count ->
   * hold path in virtual time without waiting on a real clock.
   */
  const setTimer = d.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer || ((t) => clearTimeout(t));

  let config = null;
  let lastError = null;
  /** webContents id -> { contents, audible, muted, host } for every live guest. */
  const guests = new Map();
  /** Last probe result, so emit() can push without doing I/O. */
  let lastPing = null;
  let lastTask = { exists: false, enabled: false, running: false, at: 0 };
  let lastSent = '';
  let quitting = false;

  // -- config ---------------------------------------------------------------

  /**
   * Resolved lazily, never at module load: --test-profile rewrites userData
   * after this file is required, and a test run must not write the real one.
   */
  function configPath() {
    const base = app ? app.getPath('userData') : path.join(os.tmpdir(), 'browser-autopause');
    return path.join(base, 'autopause.json');
  }

  function readConfig() {
    if (config) return config;
    config = { ...DEFAULT_CONFIG, sites: DEFAULT_SITES.slice() };
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    } catch {
      return config; // no file yet, unreadable, or not JSON -- defaults stand
    }
    if (!parsed || typeof parsed !== 'object') return config;
    if (typeof parsed.browserHold === 'boolean') config.browserHold = parsed.browserHold;
    if (typeof parsed.anySite === 'boolean') config.anySite = parsed.anySite;
    if (typeof parsed.directEnabled === 'boolean') config.directEnabled = parsed.directEnabled;
    const sites = sanitiseSites(parsed.sites);
    if (sites && sites.length) {
      // A saved list would otherwise freeze the day it was written, so a site
      // added to the defaults later (Twitch, 2026-09-11) never reached anyone
      // who had touched a Spotify setting. `sitesBase` records which defaults
      // the saved list was built on; anything that joined the defaults since
      // is merged in, while a default the user removed on purpose (present in
      // the base, absent from the list) stays removed. Files written before
      // the base existed were built on the original five.
      const base = sanitiseSites(parsed.sitesBase) || LEGACY_BASE_SITES;
      for (const site of DEFAULT_SITES) {
        if (!base.includes(site) && !sites.includes(site)) sites.push(site);
      }
      config.sites = sites;
    }
    config.sitesBase = DEFAULT_SITES.slice();
    return config;
  }

  function writeConfig() {
    const target = configPath();
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = target + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(readConfig(), null, 2), 'utf8');
      fs.renameSync(tmp, target);
    } catch {
      // A profile we cannot write to still runs; the choice just will not survive.
    }
  }

  // -- the browser prong ----------------------------------------------------

  const machine = createHoldMachine({
    holdAfterMs: HOLD_AFTER_MS,
    resumeDelayMs: RESUME_DELAY_MS,
    refreshMs: REFRESH_MS,
    setTimer,
    clearTimer,
    onHold: async () => {
      // Never start the bridge just because a tab played. If nothing answers,
      // the whole-computer switch is off and that is the user's decision.
      const reply = await bridge.pause(BRIDGE_SRC);
      if (reply) { lastPing = reply; return true; }
      lastError = 'The Spotify bridge did not answer, so nothing was paused.';
      return false;
    },
    onRefresh: async () => {
      const reply = await bridge.pause(BRIDGE_SRC);
      if (reply) lastPing = reply;
      return !!reply;
    },
    onRelease: async () => {
      const reply = await bridge.resume(BRIDGE_SRC);
      if (reply) { lastPing = reply; return true; }
      // The hold stays flagged: it really does still exist on the bridge, and
      // leaving it behind is what pins Spotify paused. Retried on next silence.
      lastError = 'The Spotify bridge did not answer, so the hold is still out.';
      return false;
    },
    onChange: () => emit(),
  });

  /** Count the guests that currently count as "a video is playing". */
  function playingCount() {
    const cfg = readConfig();
    if (!cfg.browserHold) return 0;
    let n = 0;
    for (const entry of guests.values()) {
      if (!entry.audible) continue;
      // A muted tab makes no sound in the room, so it has no business holding
      // Spotify paused -- muting the video is exactly how you say "let the music
      // through". Chromium still calls it audible, so the mute flag is the only
      // thing that separates the two.
      if (entry.muted) continue;
      if (isNeverSite(entry.host)) continue;
      if (cfg.anySite || hostMatchesSites(entry.host, cfg.sites)) n += 1;
    }
    return n;
  }

  function recount() {
    machine.setPlaying(playingCount());
    syncMutePoll();
    emit();
  }

  function safeUrl(contents) {
    try { return contents.getURL(); } catch { return ''; }
  }

  /** Is this guest muted right now? A guest that is gone is nobody's hold. */
  function safeMuted(contents) {
    try {
      if (!contents || typeof contents.isAudioMuted !== 'function') return false;
      if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return false;
      return !!contents.isAudioMuted();
    } catch {
      return false;
    }
  }

  // -- the mute poll --------------------------------------------------------
  //
  // The one thing about a guest that changes with no event to announce it (see
  // MUTE_POLL_MS). We ask only while at least one guest is audible: that is the
  // only window in which the answer can move the hold either way -- a muted tab
  // is still audible, so an unmute is caught too -- and it means an idle browser
  // runs no timer at all. With the browser prong off there is no hold to move,
  // so the poll never starts.

  let mutePollTimer = null;

  function stopMutePoll() {
    if (mutePollTimer !== null) { clearTimer(mutePollTimer); mutePollTimer = null; }
  }

  function anyAudibleGuest() {
    for (const entry of guests.values()) if (entry.audible) return true;
    return false;
  }

  function armMutePoll() {
    mutePollTimer = setTimer(() => {
      mutePollTimer = null;
      let changed = false;
      for (const entry of guests.values()) {
        if (!entry.audible) continue;
        const muted = safeMuted(entry.contents);
        if (muted !== entry.muted) { entry.muted = muted; changed = true; }
      }
      // Re-evaluating twice a second when nothing moved would be pure noise, so
      // only a real change goes through. recount() re-arms us via syncMutePoll.
      if (changed) recount();
      else syncMutePoll();
    }, MUTE_POLL_MS);
  }

  /** Start the poll when something is audible, stop it when nothing is. */
  function syncMutePoll() {
    const want = readConfig().browserHold && anyAudibleGuest();
    if (want === (mutePollTimer !== null)) return;
    if (want) armMutePoll();
    else stopMutePoll();
  }

  /**
   * Wire one guest webContents. Called for every `web-contents-created` of type
   * 'webview', so a tab opened after startup is covered without any extra step.
   */
  function watchGuest(contents) {
    if (!contents || typeof contents.on !== 'function') return;
    const id = contents.id;
    if (guests.has(id)) return;
    // The contents is kept so the mute poll has something to ask; the entry is
    // dropped again on 'destroyed', so nothing outlives the tab.
    const entry = {
      contents,
      audible: false,
      muted: safeMuted(contents),
      host: hostOfUrl(safeUrl(contents)),
    };
    guests.set(id, entry);

    contents.on('audio-state-changed', (event) => {
      entry.audible = !!(event && event.audible);
      // Read the host back here too: a navigation can land either side of this.
      entry.host = hostOfUrl(safeUrl(contents));
      // And the mute flag: a tab muted while it was silent starts making sound
      // with no poll running yet, and this is the event that starts it.
      entry.muted = safeMuted(contents);
      recount();
    });

    // A same-document navigation (YouTube's own video switches) keeps the audio
    // going, so the live flag is re-read rather than assumed silent.
    const onNav = () => {
      entry.host = hostOfUrl(safeUrl(contents));
      try { entry.audible = contents.isCurrentlyAudible(); } catch { /* gone */ }
      // The mute rides on the WebContents, not the page, so it survives a
      // navigation -- re-read it rather than assume either way.
      entry.muted = safeMuted(contents);
      recount();
    };
    contents.on('did-navigate', onNav);
    contents.on('did-navigate-in-page', onNav);

    // A closed or slept tab simply drops out of the set.
    contents.on('destroyed', () => { guests.delete(id); recount(); });
  }

  // -- the whole-computer switch -------------------------------------------

  async function queryTask(maxAgeMs) {
    const age = maxAgeMs == null ? 2000 : maxAgeMs;
    if (lastTask.at && Date.now() - lastTask.at < age) return lastTask;
    const r = await exec('schtasks', ['/Query', '/TN', taskName, '/FO', 'LIST', '/V'], 4000);
    const parsed = parseTaskQuery(r.code, r.stdout);
    lastTask = { ...parsed, at: Date.now() };
    return lastTask;
  }

  /** Poll /ping until it answers (or does not), inside a bounded window. */
  async function waitForBridge(wantRunning, budgetMs) {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const found = await bridge.discover(PROBE_TIMEOUT_MS);
      lastPing = found ? found.status : null;
      if (!!found === wantRunning) return true;
      if (Date.now() >= deadline) return false;
      await sleep(400);
    }
  }

  /**
   * Every PID whose command line really does run the bridge script. We never
   * match on image name: 'powershell.exe' is also this session's own shell.
   */
  async function findBridgePids() {
    const ps =
      "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe' OR Name='pwsh.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*spotify-bridge.ps1*' } | " +
      'Select-Object -ExpandProperty ProcessId';
    const r = await exec(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', ps], 8000);
    if (r.code !== 0) return [];
    return String(r.stdout)
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }

  async function enable() {
    const task = await queryTask(0);
    if (!task.exists) {
      // No task to enable: launch the bridge ourselves and remember the choice,
      // because nothing else will bring it back after a reboot.
      readConfig().directEnabled = true;
      writeConfig();
      try {
        const child = spawnFn(
          POWERSHELL,
          [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
            // -Quiet is what the scheduled task passes: with no console attached
            // its output would go nowhere anyway, and bridge.log is unaffected.
            '-File', bridgeScript, '-Quiet',
          ],
          { detached: true, stdio: 'ignore', windowsHide: true }
        );
        child.unref();
      } catch (err) {
        lastError = 'Could not start the Spotify bridge: ' + ((err && err.message) || err);
        return;
      }
      if (!(await waitForBridge(true, 8000))) {
        lastError = 'Started the Spotify bridge, but it never answered on 8787-8790.';
      }
      return;
    }

    const changed = await exec('schtasks', ['/Change', '/TN', taskName, '/ENABLE'], 8000);
    if (changed.code !== 0) {
      lastError = 'Could not enable the SpotifyAutoPause task: ' +
        firstErrorLine(changed.stderr, changed.stdout, 'schtasks exited ' + changed.code);
      return;
    }
    const started = await exec('schtasks', ['/Run', '/TN', taskName], 8000);
    lastTask = { ...lastTask, at: 0 };   // whatever we cached is now stale
    if (!(await waitForBridge(true, 8000))) {
      // /Run can legitimately fail when an instance is already running
      // (MultipleInstances = IgnoreNew), so its exit code only matters once we
      // know nothing is actually listening.
      lastError = started.code !== 0
        ? 'Could not start the SpotifyAutoPause task: ' +
          firstErrorLine(started.stderr, started.stdout, 'schtasks exited ' + started.code)
        : 'The SpotifyAutoPause task started but the bridge never answered on 8787-8790.';
    }
  }

  async function disable() {
    // Our own hold goes back first: leaving it out would pin Spotify paused
    // with the bridge gone and nothing left to release it.
    try { await machine.releaseNow(); } catch { /* best effort */ }

    const task = await queryTask(0);
    if (task.exists) {
      // /End alone is not enough. The task repeats every few minutes, so a
      // merely-ended bridge is back before the user has finished reading the
      // settings pane -- it has to be disabled as well, and the disable is the
      // half that must succeed.
      const ended = await exec('schtasks', ['/End', '/TN', taskName], 8000);
      const changed = await exec('schtasks', ['/Change', '/TN', taskName, '/DISABLE'], 8000);
      lastTask = { ...lastTask, at: 0 };
      if (changed.code !== 0) {
        lastError = 'Could not disable the SpotifyAutoPause task: ' +
          firstErrorLine(changed.stderr, changed.stdout, 'schtasks exited ' + changed.code);
        return;
      }
      if (ended.code !== 0 && !(await waitForBridge(false, 500))) {
        // Only worth mentioning if the bridge really did survive /End.
        lastError = 'Told the task to stop and it refused: ' +
          firstErrorLine(ended.stderr, ended.stdout, 'schtasks exited ' + ended.code);
      }
    }
    readConfig().directEnabled = false;
    writeConfig();

    // Give it the ~2 s the task needs to tear its own process down, then take
    // the process out by PID if it is still there.
    if (await waitForBridge(false, 2000)) { lastError = null; return; }

    const pids = await findBridgePids();
    if (!pids.length) {
      lastError = 'The Spotify bridge is still answering and no bridge process was found.';
      return;
    }
    for (const pid of pids) {
      const killed = await exec('taskkill', ['/PID', String(pid), '/F'], 8000);
      if (killed.code !== 0) {
        lastError = 'Could not stop the Spotify bridge (pid ' + pid + '): ' +
          firstErrorLine(killed.stderr, killed.stdout, 'taskkill exited ' + killed.code);
      }
    }
    bridge.forget();
    if (!(await waitForBridge(false, 3000))) {
      lastError = 'The Spotify bridge is still answering after it was stopped.';
    }
  }

  // -- status ---------------------------------------------------------------

  /** Build a Status from what we already know. No I/O -- safe to call on any change. */
  function snapshot(ping, task) {
    const cfg = readConfig();
    const installed = (() => {
      try { return fs.existsSync(bridgeScript); } catch { return false; }
    })();
    return {
      installed,
      enabled: task && task.exists ? task.enabled : cfg.directEnabled,
      bridge: ping ? 'running' : (installed ? 'stopped' : 'unknown'),
      port: ping ? ping.port : null,
      spotify: !!(ping && ping.spotifyFound),
      wePaused: !!(ping && ping.heldByUs),
      holds: ping ? ping.holds.slice() : [],
      browserHold: machine.holding,
      // "Tabs counted as playing", which is what the settings line reads out --
      // a muted tab is audible to Chromium but is not one of these.
      audibleTabs: machine.playing,
      config: {
        browserHold: cfg.browserHold,
        anySite: cfg.anySite,
        sites: cfg.sites.slice(),
      },
      error: lastError,
    };
  }

  /** Push the current picture at the renderer, but only when it actually moved. */
  function emit() {
    const payload = snapshot(lastPing, lastTask);
    let key;
    try { key = JSON.stringify(payload); } catch { key = String(Math.random()); }
    if (key === lastSent) return payload;
    lastSent = key;
    try { onChange(payload); } catch { /* a dead renderer is not our problem */ }
    return payload;
  }

  /**
   * The renderer's read. Both halves run at once and both are short, so the
   * answer lands inside ~1.5 s whether or not anything is running -- a settings
   * pane polling every 4 s must never sit on a dead port waiting.
   */
  async function status() {
    const [found, task] = await Promise.all([
      bridge.discover(PROBE_TIMEOUT_MS).catch(() => null),
      queryTask().catch(() => lastTask),
    ]);
    lastPing = found ? found.status : null;
    if (task) lastTask = task;
    if (lastPing) lastError = null;   // it is answering; whatever went wrong is over
    return emit();
  }

  async function setEnabled(on) {
    lastError = null;
    try {
      if (on) await enable();
      else await disable();
    } catch (err) {
      lastError = 'The Spotify switch failed: ' + ((err && err.message) || err);
    }
    return status();
  }

  async function setConfig(patch) {
    const cfg = readConfig();
    const p = patch && typeof patch === 'object' ? patch : {};
    if (typeof p.browserHold === 'boolean') cfg.browserHold = p.browserHold;
    if (typeof p.anySite === 'boolean') cfg.anySite = p.anySite;
    if (Array.isArray(p.sites)) {
      const sites = sanitiseSites(p.sites);
      if (sites) cfg.sites = sites;
    }
    writeConfig();
    // Turning the browser prong off (or narrowing the site list) has to hand
    // the hold back now, not at the next audio event that may never come.
    recount();
    return status();
  }

  /** doctor.ps1 -Json. Read-only: it starts nothing and stops nothing. */
  async function doctor() {
    let exists = false;
    try { exists = fs.existsSync(doctorScript); } catch { exists = false; }
    if (!exists) {
      return { ok: false, text: 'Spotify auto-pause is not installed on this computer.', json: null };
    }
    const r = await exec(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', doctorScript, '-Json'],
      30000
    );
    const text = r.stdout.trim() || r.stderr.trim();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { ok: r.code === 0, text, json };
  }

  /**
   * before-quit. Handing the hold back is an HTTP round trip and quit is
   * synchronous, so the quit is deferred exactly once and for at most ~1.5 s.
   * Doing nothing here would leave Spotify paused until the bridge's 180 s TTL
   * expired the hold.
   */
  function handleQuit(event) {
    machine.stop();
    stopMutePoll();
    if (!machine.holding || quitting) return false;
    quitting = true;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const finish = () => { if (app) app.quit(); };
    const timer = setTimeout(finish, 1500);
    machine.releaseNow()
      .catch(() => {})
      .then(() => { clearTimeout(timer); finish(); });
    return true;
  }

  return {
    status,
    setEnabled,
    setConfig,
    doctor,
    watchGuest,
    handleQuit,
    // Exposed for a harness; the app never reaches past the four above.
    _machine: machine,
    _bridge: bridge,
    _snapshot: () => snapshot(lastPing, lastTask),
  };
}

module.exports = {
  create,
  createHoldMachine,
  createBridgeClient,
  httpGetJson,
  normaliseHost,
  hostOfUrl,
  hostMatchesSites,
  sanitiseSites,
  isNeverSite,
  parseBridgeStatus,
  parseTaskQuery,
  firstErrorLine,
  BRIDGE_SRC,
  BRIDGE_PORTS,
  DEFAULT_SITES,
  DEFAULT_CONFIG,
  HOLD_AFTER_MS,
  RESUME_DELAY_MS,
  REFRESH_MS,
  MUTE_POLL_MS,
  PROBE_TIMEOUT_MS,
  ACTION_TIMEOUT_MS,
};
