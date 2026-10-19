'use strict';

// autopause.js — Spotify auto-pause, main-process side.
//
// Spotify pauses while a tab plays a video and resumes when it stops. Quartz
// works alone, and next to Mantle (or the earlier standalone helper) it
// cooperates instead of fighting: exactly one app, the HOST, decides when
// Spotify pauses, and every other app sends its holds there. The protocol is
// written down once in docs/autopause-protocol.md, and its three shared files
// are byte-identical in both apps:
//
//   autopause-core.js    the rules (holds, only resume what we paused, the
//                        re-pause back-off, TTLs, inherit)
//   autopause-compat.js  the host's HTTP API on 127.0.0.1:8787-8790
//   autopause-link.js    the election: host, client, takeover
//
// This file supplies Quartz's eyes and hands:
//
//   Eyes: guest <webview>s that are audible, not muted and on a watched site
//         (the hold machine below turns that count into one hold, with the
//         same 1.5 s on and 1.5 s off delays the browser extension uses).
//   Hands: Windows' media session API (WinRT SMTC) on Spotify's session,
//         through a small PowerShell helper (autopause-smtc.js / .ps1),
//         only while Quartz is the host.
//
// Two switches, both in autopause.json in userData:
//   enabled      Quartz may be the host (and pause Spotify itself).
//   browserHold  Quartz's tabs count as "a video is playing".
// With both off Quartz binds no port, runs no timer and starts no helper.
//
// Everything here is best effort and nothing ever throws at the renderer: a
// failure becomes plain-English text in `status.error`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createEngine } = require('./autopause-core');
const { createCompat } = require('./autopause-compat');
const { createLink, httpGet: linkHttpGet } = require('./autopause-link');
const { createSmtc } = require('./autopause-smtc');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The host binds the first free one of these (docs/autopause-protocol.md). */
const BRIDGE_PORTS = [8787, 8788, 8789, 8790];

/**
 * This app's name on the wire: the src of its holds when another app hosts,
 * and the `server` field when it hosts. The host keys holds by src and only
 * resumes when the LAST one is released, so each app needs its own string.
 */
const BRIDGE_SRC = 'quartz';

/**
 * The scheduled task the earlier standalone helper ran under. Read once, only
 * to carry its on/off state into `enabled` for a config written before that
 * field existed (see readConfig). Never started, stopped or changed here.
 */
const LEGACY_TASK = 'SpotifyAutoPause';

/**
 * Two budgets, for two different questions.
 *
 *   PROBE   "is anything listening on a port I am guessing at?" A dead local
 *           port refuses instantly, so this only has to outlast a firewalled
 *           one. Probes run across the whole range at once.
 *
 *   ACTION  "the host is there -- let it finish." A short abort does not
 *           cancel the work on the other side; it only loses the reply.
 */
const PROBE_TIMEOUT_MS = 600;
const ACTION_TIMEOUT_MS = 6000;

/** Sound has to last this long before we take a hold (the extension's pause delay). */
const HOLD_AFTER_MS = 1500;

/** And silence this long before we hand it back (the extension's resumeDelayMs). */
const RESUME_DELAY_MS = 1500;

/**
 * A hold sent to another app's host expires after 180 s unless it is
 * refreshed -- that TTL is what stops a hold outliving the browser and pinning
 * Spotify paused forever. autopause-link.js re-sends it every 60 s.
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

/** While Quartz hosts and something holds (or it paused Spotify): one engine tick a second. */
const TICK_MS = 1000;

/**
 * Sites watched out of the box: the extension's list (minus the Spotify web
 * player) plus the common streaming and video sites. Twitch was the first
 * miss reported (2026-09-11): a list only ever covers what someone thought
 * of, so "Any tab that makes sound" stays one switch away.
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
];

/**
 * Never counted as "a video", even with `anySite` on. Spotify's own web player
 * making sound is the one thing that must never pause Spotify -- the host
 * refuses a session whose AUMID matches /spotify/ for exactly this reason, and
 * the extension keeps open.spotify.com out of its match list on purpose.
 */
const NEVER_SITES = ['spotify.com', 'open.spotify.com'];

/**
 * The defaults a config file written before `sitesBase` existed was built on.
 * A saved list keeps whatever sites it already has; this only decides which
 * newer defaults get merged into it (see readConfig).
 */
const LEGACY_BASE_SITES = ['youtube.com', 'youtube-nocookie.com'];

const DEFAULT_CONFIG = {
  // Quartz may host. A file written before this field existed gets it from
  // the earlier helper's scheduled task on first read (see readConfig).
  enabled: true,
  browserHold: true,
  anySite: false,
  sites: DEFAULT_SITES.slice(),
  sitesBase: DEFAULT_SITES.slice(),
  // Legacy: the earlier helper's "launched directly" choice. Read only to
  // migrate a file with no task behind it; kept so the field round-trips.
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
// Migration from the earlier standalone helper
// ---------------------------------------------------------------------------

/** Where Windows keeps the legacy task's XML. */
function legacyTaskFile(env) {
  const e = env || process.env;
  const root = e.SystemRoot || e.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'Tasks', LEGACY_TASK);
}

/** Task XML bytes -> text. Windows writes them UTF-16LE, usually with a BOM. */
function decodeTaskXml(buf) {
  if (!buf || !buf.length) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  if (buf.length >= 2 && buf[1] === 0x00) return buf.toString('utf16le');
  return buf.toString('utf8');
}

/**
 * 'enabled' | 'disabled' | 'unknown' from the task XML text (the same rule as
 * Mantle's taskStateFromXml): the task-level <Enabled> inside <Settings>.
 */
function taskStateFromXml(text) {
  const s = String(text || '');
  if (!/<Task[\s>]/.test(s)) return 'unknown';
  const m = /<Settings>[\s\S]*?<\/Settings>/.exec(s);
  const en = m ? /<Enabled>\s*(true|false)\s*<\/Enabled>/i.exec(m[0]) : null;
  return en && en[1].toLowerCase() === 'false' ? 'disabled' : 'enabled';
}

/** The legacy task's state, read synchronously: 'enabled' | 'disabled' | 'absent' | 'unknown'. */
function readLegacyTask(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'absent' : 'unknown';
  }
  return taskStateFromXml(decodeTaskXml(buf));
}

// ---------------------------------------------------------------------------
// The integration
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 *   deps.app       Electron's app, for userData. Optional -- without it the
 *                  config lives in the temp dir, which is what a harness gets.
 *   deps.onChange  Called with a Status whenever anything moves.
 *   deps.test      --test-profile: never binds 8787-8790 (only the port named
 *                  by QUARTZ_AUTOPAUSE_PORT, if any), never reaches another
 *                  app's host, and never sends Spotify a command.
 * Injectable for a harness: configFile, taskFile, env, smtc, ports, linkGet,
 * bridge, now, log, autoStart, setTimer/clearTimer/setRepeat/clearRepeat.
 */
function create(deps) {
  const d = deps || {};
  const app = d.app || null;
  const onChange = typeof d.onChange === 'function' ? d.onChange : () => {};
  const test = !!d.test;
  const env = d.env || process.env;
  const now = d.now || Date.now;
  const bridge = d.bridge || createBridgeClient({ get: d.get });
  /**
   * Every timer this integration owns goes through these, so a harness can
   * drive the whole guest -> count -> hold path in virtual time.
   */
  const setTimer = d.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer || ((t) => clearTimeout(t));
  const setRepeat = d.setRepeat || ((fn, ms) => setInterval(fn, ms));
  const clearRepeat = d.clearRepeat || ((t) => clearInterval(t));

  /** A test instance only ever touches the port it is given, and only on purpose. */
  const envPort = (() => {
    const n = Number(env.QUARTZ_AUTOPAUSE_PORT);
    return test && Number.isInteger(n) && n > 1024 && n < 65536 ? n : null;
  })();
  const ports = d.ports || (test ? (envPort ? [envPort] : []) : BRIDGE_PORTS);

  let config = null;
  let lastError = null;
  /** webContents id -> { contents, audible, muted, host } for every live guest. */
  const guests = new Map();
  /** The host another app runs, as last probed while our link is off (status/_bridge). */
  let lastPing = null;
  let lastSent = '';
  let quitting = false;
  const recent = [];   // the last few log lines, for doctor()

  function log(text) {
    const line = new Date(now()).toISOString().slice(11, 19) + ' ' + String(text);
    recent.push(line);
    if (recent.length > 30) recent.shift();
    if (typeof d.log === 'function') { try { d.log(String(text)); } catch { /* the owner's problem */ } }
  }

  // -- config ---------------------------------------------------------------

  /**
   * Resolved lazily, never at module load: --test-profile rewrites userData
   * after this file is required, and a test run must not write the real one.
   */
  function configPath() {
    if (d.configFile) return d.configFile;
    const base = app ? app.getPath('userData') : path.join(os.tmpdir(), 'browser-autopause');
    return path.join(base, 'autopause.json');
  }

  /** `enabled` for a profile written before the field existed: the legacy task's state. */
  function migratedEnabled(parsed) {
    const task = readLegacyTask(d.taskFile || legacyTaskFile(env));
    if (task === 'enabled') return { value: true, sure: true };
    if (task === 'disabled') return { value: false, sure: true };
    if (task === 'absent') {
      // No task: the old switch was a remembered choice (directEnabled). With
      // no file at all, a fresh install, auto-pause is simply on.
      return { value: parsed ? parsed.directEnabled === true : true, sure: true };
    }
    // The task exists but could not be read: off for now, and not written
    // down, so the next start asks again.
    return { value: parsed ? parsed.directEnabled === true : false, sure: false };
  }

  function readConfig() {
    if (config) return config;
    config = { ...DEFAULT_CONFIG, sites: DEFAULT_SITES.slice() };
    let raw = null;
    let missing = false;
    try {
      raw = fs.readFileSync(configPath(), 'utf8');
    } catch (err) {
      missing = !!(err && err.code === 'ENOENT');
    }
    if (raw == null) {
      // No file (a fresh profile) or one we cannot read right now: defaults,
      // with `enabled` from the legacy task. Nothing is written until a change.
      config.enabled = missing ? migratedEnabled(null).value : false;
      return config;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
      config.enabled = migratedEnabled(null).value;
      return config;
    }
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
      // the base, absent from the list) stays removed. A site the user's list
      // has stays, default or not.
      const base = sanitiseSites(parsed.sitesBase) || LEGACY_BASE_SITES;
      for (const site of DEFAULT_SITES) {
        if (!base.includes(site) && !sites.includes(site)) sites.push(site);
      }
      config.sites = sites;
    }
    config.sitesBase = DEFAULT_SITES.slice();
    if (typeof parsed.enabled === 'boolean') {
      config.enabled = parsed.enabled;
    } else {
      // Written before `enabled` existed: carry the old switch over once and
      // write it down, so the answer never changes under the user later.
      const m = migratedEnabled(parsed);
      config.enabled = m.value;
      if (m.sure) writeConfig();
    }
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

  // -- Spotify, through Windows' media session (host role only) -------------

  const smtc = d.smtc || createSmtc({ test, log: (t) => log(t) });
  let link = null;
  let sim = null;       // test mode: what Spotify WOULD be after our (unsent) command
  let pending = null;   // live: { state, until } after a command, until the session catches up
  let refreshing = null;

  /** Spotify's session in the helper's last read, or null. */
  function spotifySession() {
    const s = smtc.last();
    const list = s && Array.isArray(s.sessions) ? s.sessions : [];
    return list.find((x) => x && /spotify/i.test(String(x.aumid || ''))) || null;
  }

  /** 'playing' | 'paused' | 'stopped' | ... | 'none', lowercased; 'none' when Spotify is absent. */
  function spState() {
    if (sim) return sim;
    const sess = spotifySession();
    let raw = sess ? String(sess.status || '').toLowerCase() : 'none';
    if (!raw || raw === 'closed') raw = 'none';
    if (pending && now() < pending.until && raw !== pending.state) return pending.state;
    pending = null;
    return raw;
  }

  /** Freshen the helper's read. One at a time; bounded by the helper's own timeout. */
  function refresh() {
    if (!refreshing) {
      refreshing = Promise.resolve()
        .then(() => smtc.state())
        .catch(() => null)
        .then((r) => {
          refreshing = null;
          if (r && r.ok === false && r.reason) log(`media session read failed: ${r.reason}`);
          return r;
        });
    }
    return refreshing;
  }

  /** The same, but never longer than `ms` (an HTTP caller has its own clock running). */
  function refreshWithin(ms) {
    let t = null;
    return Promise.race([
      refresh(),
      new Promise((resolve) => { t = setTimer(resolve, ms); }),
    ]).then(() => { if (t !== null) clearTimer(t); });
  }

  async function spotifyControl(action) {
    const sess = spotifySession();
    if (!sess) return { ok: false, reason: 'Spotify is not open' };
    const r = await smtc.control(action, sess.aumid);
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || 'Windows did not answer' };
    if (r.dryRun) {
      log(`test: would ${action} Spotify (nothing sent)`);
      sim = action === 'pause' ? 'paused' : action === 'play' ? 'playing' : sim;
      return { ok: true };
    }
    if (r.sent === false) return { ok: false, reason: 'Spotify did not take the command' };
    pending = { state: action === 'pause' ? 'paused' : 'playing', until: now() + 2000 };
    return { ok: true };
  }

  /** The engine: the rules. Only the HOST's engine sees Spotify at all. */
  const engine = createEngine({
    now,
    log: (t) => log(t),
    spotify: {
      state: () => (link && link.role() === 'host' ? spState() : 'none'),
      pause: () => spotifyControl('pause'),
      play: () => spotifyControl('play'),
    },
  });

  /** The helper's sessions in the shape autopause-compat.js's /now reads. */
  function mediaSessions() {
    const s = smtc.last();
    const list = s && Array.isArray(s.sessions) ? s.sessions : [];
    const mapped = list.map((x) => ({
      aumid: String(x.aumid || ''),
      title: String(x.title || ''),
      artist: String(x.artist || ''),
      album: String(x.album || ''),
      status: String(x.status || 'none').toLowerCase(),
      playing: String(x.status || '').toLowerCase() === 'playing',
      timeline: { positionMs: Number(x.positionMs) || 0, durationMs: Number(x.durationMs) || 0 },
      can: x.can && typeof x.can === 'object' ? x.can : {},
      art: null,
    }));
    const current = s && s.current ? String(s.current).toLowerCase() : '';
    const shown = mapped.find((x) => current && x.aumid.toLowerCase() === current) || null;
    return { sessions: mapped, shown };
  }

  const compat = createCompat({
    engine,
    now,
    name: BRIDGE_SRC,
    ports,
    log: (t) => log(t),
    refresh: () => refreshWithin(2500),
    spotify: () => {
      const sess = spotifySession();
      return { found: !!sess, state: spState(), aumid: sess ? sess.aumid : null };
    },
    media: () => mediaSessions(),
    // The now-playing card's transport buttons: whatever Windows calls current.
    control: async (cmd) => {
      const m = mediaSessions();
      const target = m.shown || m.sessions.find((x) => x.playing) || m.sessions[0];
      if (!target) return { ok: false, reason: 'no session' };
      const r = await smtc.control(cmd, target.aumid);
      if (r && r.dryRun) { log(`test: would send ${cmd} (nothing sent)`); return { ok: true }; }
      return r && r.ok === true && r.sent !== false ? { ok: true } : { ok: false, reason: (r && r.reason) || 'Windows did not answer' };
    },
    changed: () => { syncTick(); emit(); },
  });

  /** Our own hold's key in our own engine (host role). */
  const LOCAL_KEY = 'local:' + BRIDGE_SRC;

  link = createLink({
    name: BRIDGE_SRC,
    ports,
    get: d.linkGet || linkHttpGet,
    log: (t) => log(t),
    setTimer: d.linkSetTimer,
    clearTimer: d.linkClearTimer,
    canHost: () => !quitting && readConfig().enabled && (!test || envPort !== null),
    host: {
      start: () => (ports.length ? compat.start() : Promise.resolve(null)),
      stop: (why) => compat.stop(why),
      port: () => compat.port(),
    },
    localHold: async (held) => {
      await refresh();
      if (held) await engine.addHold(LOCAL_KEY, { native: true, kind: 'browser', label: 'Quartz tabs' }, now());
      else await engine.removeHold(LOCAL_KEY, 'its tabs went quiet');
      compat.notify();
      syncTick();
    },
    onHost: async (x) => {
      const prev = x && x.last;
      if (prev) {
        await refresh();
        await engine.inherit({
          paused: !!(prev.wePaused || prev.heldByUs),
          suppressedForMs: prev.repauseSuppressed ? Number(prev.repauseSuppressedForMs) || 0 : 0,
        });
      }
      compat.notify();
      syncTick();
      emit();
    },
    retire: async (why) => {
      stopTick();
      if (compat.successorWatching()) {
        const r = engine.handOff();
        log(`handed Spotify over to the other app (${r.action})`);
      } else {
        // Only a host with something to hand back needs Spotify's state (and the helper).
        const snap = engine.snapshot(now());
        if (snap.holds.length > 0 || snap.wePaused) await refresh();
        await engine.releaseAll(why);
        compat.notify();
      }
      sim = null;
      pending = null;
    },
    onChange: () => { syncTick(); emit(); },
  });

  // -- the engine's clock (host role only) ----------------------------------
  //
  // TTLs and the re-pause check need a tick, but only while there is something
  // to decide: Quartz hosts AND a hold exists or Spotify is paused by us. An
  // idle host runs no timer and lets the helper exit.

  let tickTimer = null;
  let ticking = false;

  function wantTick() {
    if (!link || link.role() !== 'host' || quitting) return false;
    const snap = engine.snapshot(now());
    return snap.holds.length > 0 || snap.wePaused;
  }

  function stopTick() {
    if (tickTimer !== null) { clearRepeat(tickTimer); tickTimer = null; }
  }

  async function tickOnce() {
    if (ticking) return;
    ticking = true;
    try {
      await refresh();
      if (link.role() === 'host') await engine.tick(now(), []);
      compat.notify();
    } catch (err) {
      log(`the auto-pause tick threw: ${(err && err.message) || err}`);
    } finally {
      ticking = false;
    }
    syncTick();
    emit();
  }

  function syncTick() {
    const want = wantTick();
    if (want === (tickTimer !== null)) return;
    if (want) tickTimer = setRepeat(() => { tickOnce(); }, TICK_MS);
    else stopTick();
  }

  // -- taking part ----------------------------------------------------------
  //
  // The link runs only while Quartz may host or its tabs count. Calls are
  // queued, so a switch flipped twice in a row cannot start and stop at once.

  let linkOn = false;
  let linkQueue = Promise.resolve();

  function wantLink() {
    const cfg = readConfig();
    return !quitting && (cfg.enabled || cfg.browserHold);
  }

  function syncLink(why) {
    linkQueue = linkQueue.then(async () => {
      try {
        if (wantLink()) {
          if (!linkOn) { linkOn = true; await link.start(); } else await link.sync();
        } else if (linkOn) {
          linkOn = false;
          stopTick();
          await link.stop(why || 'switched off');
        }
      } catch (err) {
        lastError = 'Spotify auto-pause could not start: ' + ((err && err.message) || err);
        log(`the auto-pause link threw: ${(err && err.stack) || err}`);
      }
      if (!linkOn && smtc.running && smtc.running()) smtc.stop();
      syncTick();
      emit();
    });
    return linkQueue;
  }

  // -- the browser prong ----------------------------------------------------

  const machine = createHoldMachine({
    holdAfterMs: HOLD_AFTER_MS,
    resumeDelayMs: RESUME_DELAY_MS,
    refreshMs: REFRESH_MS,
    setTimer,
    clearTimer,
    onHold: async () => { await link.setHeld(true); return true; },
    // The link re-sends a hold to another app's host on its own clock.
    onRefresh: async () => true,
    onRelease: async () => { await link.setHeld(false); return true; },
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
    if (mutePollTimer !== null) { clearRepeat(mutePollTimer); mutePollTimer = null; }
  }

  function anyAudibleGuest() {
    for (const entry of guests.values()) if (entry.audible) return true;
    return false;
  }

  // An interval while something is audible, not a timeout re-armed from its own callback: in
  // Electron's main process every setTimeout also calls process.activateUvLoop(), and doing that
  // from a timer callback twice a second can lock the main thread and libuv's poll thread into
  // waking each other hundreds of times a second.
  function armMutePoll() {
    mutePollTimer = setRepeat(() => {
      let changed = false;
      for (const entry of guests.values()) {
        if (!entry.audible) continue;
        const muted = safeMuted(entry.contents);
        if (muted !== entry.muted) { entry.muted = muted; changed = true; }
      }
      // Re-evaluating twice a second when nothing moved would be pure noise, so
      // only a real change goes through. recount() stops us via syncMutePoll.
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

  // -- status ---------------------------------------------------------------

  /** The host's picture: ours when we host, the other app's when we are its client. */
  function hostPicture() {
    const role = linkOn ? link.role() : 'off';
    if (role === 'host') {
      const snap = engine.snapshot(now());
      const sess = spotifySession();
      return {
        port: link.port(),
        spotify: !!sess,
        wePaused: snap.wePaused && snap.holds.length > 0,
        holds: snap.holds.map((h) => (h.key === LOCAL_KEY ? BRIDGE_SRC : h.native ? 'native' : h.key.replace(/^http:/, ''))),
      };
    }
    const hs = role === 'client' ? link.hostStatus() : lastPing;
    const ping = parseBridgeStatus(hs);
    return {
      port: role === 'client' ? link.port() : (ping ? ping.port : null),
      spotify: !!(ping && ping.spotifyFound),
      wePaused: !!(ping && ping.heldByUs),
      holds: ping ? ping.holds.slice() : [],
    };
  }

  /** Build a Status from what we already know. No I/O -- safe to call on any change. */
  function snapshot() {
    const cfg = readConfig();
    const role = linkOn ? link.role() : 'off';
    const pic = hostPicture();
    let error = lastError;
    if (!error && role === 'host' && link.port() == null && ports.length) {
      error = 'Ports 8787-8790 are all taken, so other apps cannot share this auto-pause.';
    }
    if (!error && role === 'host') {
      const snap = engine.snapshot(now());
      if (snap.lastError) error = 'Spotify could not be paused: ' + snap.lastError;
    }
    return {
      installed: true,
      enabled: cfg.enabled,
      bridge: role === 'host' || role === 'client' ? 'running' : 'stopped',
      role,
      port: pic.port,
      spotify: pic.spotify,
      wePaused: pic.wePaused,
      holds: pic.holds,
      browserHold: machine.holding,
      // "Tabs counted as playing", which is what the settings line reads out --
      // a muted tab is audible to Chromium but is not one of these.
      audibleTabs: machine.playing,
      config: {
        browserHold: cfg.browserHold,
        anySite: cfg.anySite,
        sites: cfg.sites.slice(),
      },
      error: error || null,
    };
  }

  /** Push the current picture at the renderer, but only when it actually moved. */
  function emit() {
    const payload = snapshot();
    let key;
    try { key = JSON.stringify(payload); } catch { key = String(Math.random()); }
    if (key === lastSent) return payload;
    lastSent = key;
    try { onChange(payload); } catch { /* a dead renderer is not our problem */ }
    return payload;
  }

  /**
   * The renderer's read, answered inside ~1.5 s whatever is running. Hosting:
   * a fresh read of Spotify. Off: one probe of the ports for another app's
   * host, so the readout and the now-playing card still know about it.
   */
  async function status() {
    const role = linkOn ? link.role() : 'off';
    if (role === 'host') {
      await refreshWithin(1200);
    } else if (role !== 'client') {
      const found = await discover().catch(() => null);
      lastPing = found ? found.status : null;
    }
    return emit();
  }

  async function setEnabled(on) {
    lastError = null;
    readConfig().enabled = !!on;
    writeConfig();
    await syncLink(on ? 'switched on' : 'switched off');
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
    if (typeof p.browserHold === 'boolean') await syncLink('a switch moved');
    return status();
  }

  /** A read-only report of who decides and what it sees. Starts nothing, sends nothing. */
  async function doctor() {
    const st = await status();
    const cfg = readConfig();
    const role = st.role;
    const snap = engine.snapshot(now());
    const helper = smtc.stats ? smtc.stats() : null;
    const sess = spotifySession();
    const hs = role === 'client' ? link.hostStatus() : role === 'off' ? lastPing : null;
    const json = {
      role,
      port: st.port,
      enabled: cfg.enabled,
      browserHold: cfg.browserHold,
      test,
      tabsPlaying: machine.playing,
      holding: machine.holding,
      host: role === 'host'
        ? { server: BRIDGE_SRC, holds: st.holds, wePaused: snap.wePaused, repauseSuppressed: snap.suppressed,
          lastAction: snap.lastAction, lastError: snap.lastError, spotify: sess ? spState() : 'none' }
        : (hs ? { server: String(hs.server || hs.version || 'the standalone helper'), holds: st.holds,
          wePaused: !!hs.wePaused, spotify: String(hs.spotifyState || 'unknown') } : null),
      helper: helper ? Object.assign({ running: !!(smtc.running && smtc.running()) }, helper) : null,
      log: recent.slice(-15),
    };
    const lines = [];
    if (role === 'host') {
      lines.push(`Quartz is the auto-pause host${st.port ? ' on port ' + st.port : ' (no free port: deciding alone)'}.`);
      lines.push(sess ? `Spotify is open (${spState()}).` : 'Spotify is not open.');
      lines.push(`Holds: ${st.holds.length ? st.holds.join(', ') : 'none'}${snap.wePaused ? '; Spotify is paused by auto-pause' : ''}.`);
      if (snap.suppressed) lines.push('Spotify was restarted during a hold, so auto-pause is leaving it alone for a while.');
    } else if (role === 'client') {
      lines.push(`Another app (${json.host ? json.host.server : 'unknown'}) is the auto-pause host on port ${st.port}; Quartz sends it its holds.`);
    } else if (role === 'none') {
      lines.push('No app is the auto-pause host, and Quartz may not be one (the switch is off).');
    } else {
      lines.push(cfg.enabled || cfg.browserHold ? 'Auto-pause is starting.' : 'Auto-pause is off in Quartz.');
      if (json.host) lines.push(`Another app (${json.host.server}) is the auto-pause host on port ${st.port}.`);
    }
    if (cfg.browserHold) lines.push(`Tabs playing: ${machine.playing}${machine.holding ? ' (holding Spotify paused)' : ''}.`);
    if (st.error) lines.push('Problem: ' + st.error);
    return { ok: !st.error, text: lines.join('\n'), json };
  }

  /** Another app's host, or ours: { port, status } or null. Probes only when the link has no port. */
  async function discover() {
    const role = linkOn ? link.role() : 'off';
    if ((role === 'host' || role === 'client') && typeof link.port() === 'number') {
      const status = role === 'client' ? link.hostStatus() : { ok: true, port: link.port() };
      return { port: link.port(), status: parseBridgeStatus(status) || { ok: true, port: link.port() } };
    }
    const found = await bridge.discover(PROBE_TIMEOUT_MS);
    lastPing = found ? found.status : lastPing;
    return found;
  }

  /** What main.js's now-playing card reaches: the host's port (ours or theirs). */
  const mediaBridge = {
    get port() {
      const role = linkOn ? link.role() : 'off';
      if ((role === 'host' || role === 'client') && typeof link.port() === 'number') return link.port();
      return bridge.port;
    },
    discover: () => discover(),
    forget() { bridge.forget(); },
  };

  /**
   * before-quit. Handing a hold back (or Spotify itself, when we host) is
   * async and quit is synchronous, so the quit is deferred exactly once and
   * for at most ~1.5 s. Doing nothing would leave Spotify paused until the
   * host's 180 s TTL expired the hold, or with no host left at all.
   */
  function handleQuit(event) {
    machine.stop();
    stopMutePoll();
    stopTick();
    if (quitting) return false;
    quitting = true;
    const role = linkOn ? link.role() : 'off';
    const snap = engine.snapshot(now());
    const mustWait = (role === 'host' && (snap.holds.length > 0 || snap.wePaused)) || (role === 'client' && link.held());
    if (!mustWait) {
      linkOn = false;
      link.stop('quitting').catch(() => {}).then(() => smtc.stop());
      return false;
    }
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { smtc.stop(); } catch { /* gone */ }
      if (app) app.quit();
    };
    const timer = setTimeout(finish, 1500);
    linkOn = false;
    link.stop('quitting')
      .catch(() => {})
      .then(() => { clearTimeout(timer); finish(); });
    return true;
  }

  if (d.autoStart !== false) setTimer(() => { if (wantLink()) syncLink('starting'); }, 0);

  return {
    status,
    setEnabled,
    setConfig,
    doctor,
    watchGuest,
    handleQuit,
    // Exposed for main.js's now-playing card and for a harness.
    _bridge: mediaBridge,
    _machine: machine,
    _snapshot: () => snapshot(),
    _config: () => readConfig(),
    _link: link,
    _engine: engine,
    _compat: compat,
    _smtc: smtc,
    _syncLink: syncLink,
    _tick: tickOnce,
    _ticking: () => tickTimer !== null,
    _linkOn: () => linkOn,
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
  taskStateFromXml,
  decodeTaskXml,
  readLegacyTask,
  legacyTaskFile,
  BRIDGE_SRC,
  BRIDGE_PORTS,
  DEFAULT_SITES,
  DEFAULT_CONFIG,
  LEGACY_BASE_SITES,
  HOLD_AFTER_MS,
  RESUME_DELAY_MS,
  REFRESH_MS,
  MUTE_POLL_MS,
  PROBE_TIMEOUT_MS,
  ACTION_TIMEOUT_MS,
};
