'use strict';
/* _autopause-core.js - Spotify auto-pause: the RULES, pure and clock-injected (2026-09-30). SHARED,
 * byte-identical, between Mantle (lib/features/_autopause-core.js) and Quartz (autopause-core.js); see
 * docs/autopause-protocol.md. The owner feeds it what Windows says each tick; this file decides when
 * Spotify is held paused and when it is handed back. Ported from the earlier standalone PowerShell bridge
 * (Update-TrackFromSession, Invoke-WatcherTick, Invoke-RepauseCheck, Add/Remove-SpotifyHold,
 * Invoke-HoldTtlCheck) with its MEASURED constants.
 *
 * What the bridge learned the hard way, and this keeps:
 *   - A desktop lesson-video app (a Store app) LIES about its playback status in both directions (Playing while idle, Paused mid-lesson
 *     with audio coming out), so audio PEAK is ground truth: RealPlaying = peakRecent OR (Playing AND
 *     posRecent), where posRecent needs 2+ position changes inside the window (one catch-up jump once
 *     caused a false hold).
 *   - Instant on audio (holdMinPlayingMs 0, latency chosen over blip-avoidance, measured 8400 ->
 *     114 ms); position-only evidence still needs an 8 s run (4 of 6 position-only flips were silent
 *     navigation bursts of 3.2-4.2 s).
 *   - minHoldMs 6000: a stray click costs ONE ~7.5 s gap, never an on-off-on-off.
 *   - resumeDelayMs 4000 sits BELOW the smallest inter-blip gap (6708 ms) so separate blips do not chain.
 *   - Only resume what WE paused. Spotify the user already paused stays paused.
 *   - Re-pause a Spotify started during a hold, but give up after 2 per episode and leave it alone for
 *     5 min (the counter reset during churn, so the guard needs a wall clock).
 *   - Every hold has an expiry: a watched app's hold ends with its audio (or its session); a hold
 *     taken over HTTP (a browser) ends after 180 s without a refresh. A stranded hold (Spotify pinned
 *     paused with nobody left to release it) is the recurring failure class.
 *
 * Two kinds of source on top of the bridge's one (it watched one app only):
 *   media    an app with a Windows media session that is not a browser (a video player, a lesson app):
 *            the bridge's rule exactly.
 *   browser  a browser's media session: its status is honest (Chromium), so Playing is required, and
 *            when its audio can be measured the audio must be there too. A MUTED video therefore
 *            hands the music back, on purpose.
 *   app      ("Any sound from any app" only) an app with sound and no media session: audio only, and
 *            it must run anyMinRunMs first so a notification ping is not a pause. NOT measured; the
 *            bridge never watched such apps. Off by default for that reason.
 */

const DEFAULTS = Object.freeze({
  pollMs: 250,
  livenessWindowMs: 3000,
  resumeDelayMs: 4000,
  peakThreshold: 0.0008,
  holdMinPlayingMs: 0,
  holdMinPosOnlyMs: 8000,
  minHoldMs: 6000,
  repauseWhileHeld: true,
  repauseGiveUpAfter: 2,
  repauseGiveUpCooldownMs: 300000,
  repauseCheckEveryMs: 1000,
  resumeGraceMs: 1500,       // no re-pause within this of our own resume (the bridge's 1500)
  httpHoldTtlMs: 180000,     // the bridge's browserHoldTtlMs
  anyMinRunMs: 2000,         // 'app' kind only; not measured (see above)
});

function nz(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }

function newTrack(key) {
  return {
    key, kind: 'media', label: '', hasPos: false, lastPos: -1, posChanges: 0, lastPosChangeMs: -1, prevPosChangeMs: -1,
    lastPeak: -1, lastPeakOkMs: -1, status: 'unknown', posRecent: false, peakRecent: false, realPlaying: false,
    lastRealMs: -1, runStart: -1, firstPeakMs: -1, runHadAudio: false, runMs: -1, held: false, holdStartMs: -1, seen: -1,
    adopted: false,
  };
}

/** One source's verdict for this tick (Update-TrackFromSession). `s` = { status, positionMs|null, peak (-1 = unknown) }. */
function updateTrack(t, s, now, cfg) {
  t.seen = now;
  t.status = String(s.status || 'unknown').toLowerCase();
  const pos = typeof s.positionMs === 'number' && Number.isFinite(s.positionMs) && s.positionMs >= 0 ? s.positionMs : -1;
  if (pos >= 0) {
    if (t.hasPos) {
      if (Math.abs(pos - t.lastPos) > 50) {       // the bridge's 0.05 s
        t.posChanges += 1;
        t.prevPosChangeMs = t.lastPosChangeMs;
        t.lastPosChangeMs = now;
      }
    } else t.hasPos = true;
    t.lastPos = pos;
  }
  const peak = typeof s.peak === 'number' && Number.isFinite(s.peak) ? s.peak : -1;
  t.lastPeak = peak;
  if (peak >= 0 && peak > cfg.peakThreshold) t.lastPeakOkMs = now;
  const win = cfg.livenessWindowMs;
  t.posRecent = t.posChanges >= 2 && t.lastPosChangeMs >= 0 && now - t.lastPosChangeMs <= win &&
    t.prevPosChangeMs >= 0 && t.lastPosChangeMs - t.prevPosChangeMs <= win;
  t.peakRecent = t.lastPeakOkMs >= 0 && now - t.lastPeakOkMs <= win;
  const playing = t.status === 'playing';
  if (t.kind === 'browser') t.realPlaying = playing && (peak >= 0 || t.lastPeakOkMs >= 0 ? t.peakRecent : true);
  else if (t.kind === 'app') t.realPlaying = t.peakRecent;
  else t.realPlaying = t.peakRecent || (playing && t.posRecent);
  return t;
}

/**
 * createEngine({ spotify, log, config }) -> engine
 *   spotify: { state(): 'playing' | 'paused' | 'stopped' | 'none', pause(): Promise<{ok, reason}>,
 *              play(): Promise<{ok, reason}> }  (the feature's adapter; dryRun lives there)
 *   log(text): counts and states only, never a title or an app name.
 * engine.tick(now, sources) where sources = [{ key, kind, label, status, positionMs, peak }]
 */
function createEngine(opts) {
  const o = opts || {};
  const cfg = Object.assign({}, DEFAULTS, o.config || {});
  const log = typeof o.log === 'function' ? o.log : () => {};
  const sp = o.spotify;
  const tracks = new Map();         // key -> track
  const holds = new Map();          // key -> { at, native, label, since }
  const st = { wePaused: false, episodeRepauses: 0, suppressedUntil: -1, lastResumeMs: -100000, lastRepauseCheck: -1,
    backoffLogged: false, lastError: '', lastAction: '', busy: Promise.resolve(),
    adoptPending: false, adoptUntil: -1, adoptKeys: new Set() };

  /* Every Spotify action goes through one queue: a release can never overtake the pause before it. */
  function serial(fn) {
    const p = st.busy.then(fn, fn);
    st.busy = p.catch(() => {});
    return p;
  }

  async function addHold(key, meta, now) {
    const m = meta || {};
    const refresh = holds.has(key);
    const rec = holds.get(key) || { since: now };
    rec.at = now; rec.native = !!m.native; rec.label = m.label || rec.label || ''; rec.kind = m.kind || rec.kind || '';
    rec.ttl = typeof m.ttl === 'number' && m.ttl > 0 ? m.ttl : (rec.ttl || 0);
    rec.successor = !!m.successor;
    const wasEmpty = holds.size === 0;
    holds.set(key, rec);
    if (wasEmpty) { st.episodeRepauses = 0; st.backoffLogged = false; }
    if (refresh) return { action: 'refreshed' };
    return serial(async () => {
      const state = sp.state();
      if (state === 'none') return { action: 'no-spotify' };
      if (state !== 'playing') return { action: 'already-paused' };
      const r = await sp.pause();
      if (r && r.ok) { st.wePaused = true; st.lastError = ''; st.lastAction = 'paused'; log(`hold taken (${holds.size} held): Spotify paused`); return { action: 'paused' }; }
      st.lastError = (r && r.reason) || 'Spotify did not answer';
      log(`hold taken (${holds.size} held) but the pause failed`);
      return { action: 'error', reason: st.lastError };
    });
  }

  async function removeHold(key, why) {
    holds.delete(key);
    if (holds.size === 0) { st.episodeRepauses = 0; st.backoffLogged = false; }
    return serial(async () => {
      if (!st.wePaused) return { action: 'skipped', reason: 'not-held' };
      if (holds.size > 0) return { action: 'skipped', reason: 'other-holds' };
      const state = sp.state();
      if (state === 'none') { st.wePaused = false; return { action: 'no-spotify' }; }
      if (state === 'playing') { st.wePaused = false; return { action: 'skipped', reason: 'user-resumed' }; }
      const r = await sp.play();
      if (r && r.ok) {
        st.wePaused = false; st.lastResumeMs = o.now ? o.now() : Date.now(); st.lastError = ''; st.lastAction = 'resumed';
        log(`hold released (${why || 'done'}): Spotify resumed`);
        return { action: 'resumed' };
      }
      st.lastError = (r && r.reason) || 'Spotify did not answer';
      log(`hold released (${why || 'done'}) but the resume failed`);
      return { action: 'error', reason: st.lastError };
    });
  }

  function verdicts(now, sources) {
    const seen = new Set();
    for (const s of sources || []) {
      if (!s || !s.key) continue;
      seen.add(s.key);
      let t = tracks.get(s.key);
      if (!t) { t = newTrack(s.key); tracks.set(s.key, t); }
      t.kind = s.kind === 'browser' || s.kind === 'app' ? s.kind : 'media';
      t.label = s.label || t.label;
      updateTrack(t, s, now, cfg);
    }
    return seen;
  }

  /** One watcher tick (Invoke-WatcherTick + Invoke-HoldTtlCheck + Invoke-RepauseCheck). */
  async function tick(now, sources) {
    const seen = verdicts(now, sources);
    const jobs = [];
    // ADOPTION (see adopt()): the sources on the first tick after it may take no hold for this run.
    if (st.adoptPending) { st.adoptPending = false; st.adoptUntil = now + cfg.livenessWindowMs; st.adoptKeys = new Set(seen); }
    else if (st.adoptKeys.size && now > st.adoptUntil) st.adoptKeys = new Set();
    for (const [key, t] of tracks) {
      const hk = `native:${key}`;
      if (!seen.has(key)) {             // the session is gone: its hold goes with it
        if (t.held) jobs.push(removeHold(hk, 'its source closed'));
        tracks.delete(key);
        st.adoptKeys.delete(key);     // its next session is news
        continue;
      }
      if (t.realPlaying) {
        t.lastRealMs = now;
        if (t.runStart < 0) { t.runStart = now; t.runHadAudio = false; t.firstPeakMs = -1; }
        if (t.peakRecent) t.runHadAudio = true;
        if (t.lastPeakOkMs === now && t.firstPeakMs < 0) t.firstPeakMs = now;
        if (!t.held && st.adoptKeys.has(key) && now <= st.adoptUntil) t.adopted = true;
      } else if (t.runStart >= 0 && (t.lastRealMs < 0 || now - t.lastRealMs > cfg.resumeDelayMs)) {
        t.runStart = -1; t.runHadAudio = false; t.firstPeakMs = -1; t.adopted = false;
      }
      t.runMs = t.runStart >= 0 ? now - t.runStart : -1;
      if (t.runStart >= 0) {
        const gate = t.runHadAudio ? cfg.holdMinPlayingMs : cfg.holdMinPosOnlyMs;
        // 'app': AUDIBLE time, not the run (which carries 3 s of liveness after a 500 ms ping).
        const due = t.kind === 'app' ? t.firstPeakMs >= 0 && t.lastPeakOkMs - t.firstPeakMs >= cfg.anyMinRunMs : t.runMs >= gate;
        if (!t.held && due && !t.adopted) {
          t.held = true; t.holdStartMs = now;
          jobs.push(addHold(hk, { native: true, label: t.label, kind: t.kind }, now));
        } else if (t.held && holds.has(hk)) holds.get(hk).at = now;
      } else if (t.held) {
        const heldFor = t.holdStartMs >= 0 ? now - t.holdStartMs : -1;
        if (!(cfg.minHoldMs > 0 && heldFor >= 0 && heldFor < cfg.minHoldMs)) {
          t.held = false; t.holdStartMs = -1;
          jobs.push(removeHold(hk, 'its sound stopped'));
        }
      }
    }
    // HTTP holds (a browser over the bridge-compatible API) expire without a refresh.
    if (cfg.httpHoldTtlMs > 0) {
      for (const [key, rec] of holds) {
        if (!rec.native && now - rec.at >= (rec.ttl > 0 ? rec.ttl : cfg.httpHoldTtlMs)) jobs.push(removeHold(key, 'its browser stopped refreshing it'));
      }
    }
    await Promise.all(jobs);
    await repauseCheck(now);
  }

  async function repauseCheck(now) {
    if (!cfg.repauseWhileHeld || holds.size === 0) return;
    if (st.lastRepauseCheck >= 0 && now - st.lastRepauseCheck < cfg.repauseCheckEveryMs) return;
    st.lastRepauseCheck = now;
    if (now - st.lastResumeMs < cfg.resumeGraceMs) return;
    if (st.suppressedUntil >= 0 && now < st.suppressedUntil) return;
    if (st.episodeRepauses >= cfg.repauseGiveUpAfter) {
      st.suppressedUntil = now + cfg.repauseGiveUpCooldownMs;
      if (!st.backoffLogged) { st.backoffLogged = true; log(`Spotify was started ${st.episodeRepauses} times during a hold: leaving Spotify alone for ${Math.round(cfg.repauseGiveUpCooldownMs / 60000)} min`); }
      return;
    }
    await serial(async () => {
      if (holds.size === 0 || sp.state() !== 'playing') return;
      const r = await sp.pause();
      if (r && r.ok) { st.wePaused = true; st.episodeRepauses += 1; st.lastAction = 'repaused'; log(`Spotify started during a hold: paused again (${st.episodeRepauses}/${cfg.repauseGiveUpAfter})`); }
      else { st.lastError = (r && r.reason) || 'Spotify did not answer'; log('Spotify started during a hold and the re-pause failed'); }
    });
  }

  /** Hand everything back (feature off, rest, quit, the standalone helper came back). */
  async function releaseAll(why) {
    for (const t of tracks.values()) { t.held = false; t.holdStartMs = -1; t.runStart = -1; t.adopted = false; }
    const keys = [...holds.keys()];
    holds.clear();
    st.episodeRepauses = 0; st.suppressedUntil = -1;
    if (keys.length === 0 && !st.wePaused) return { action: 'nothing' };
    return removeHold('\u0000all', why);
  }

  function snapshot(now) {
    const n = typeof now === 'number' ? now : Date.now();
    const list = [...holds.entries()].map(([key, r]) => ({ key, native: r.native, label: r.label, kind: r.kind, ageMs: n - r.at, sinceMs: n - r.since,
      successor: !!r.successor, live: r.native || n - r.at < (r.ttl > 0 ? r.ttl : cfg.httpHoldTtlMs) }));
    return {
      holds: list, wePaused: st.wePaused, episodeRepauses: st.episodeRepauses,
      suppressed: st.suppressedUntil >= 0 && n < st.suppressedUntil, suppressedForMs: st.suppressedUntil >= 0 ? Math.max(0, st.suppressedUntil - n) : 0,
      lastError: st.lastError, lastAction: st.lastAction,
      tracks: [...tracks.values()].map((t) => ({ key: t.key, kind: t.kind, real: t.realPlaying, held: t.held, adopted: t.adopted, peak: t.lastPeak, status: t.status, runMs: t.runMs })),
    };
  }

  /**
   * ADOPT (r6-apfix, 2026-09-30, from the first live day). Whatever is ALREADY playing on the first tick
   * after this (or turns audible within the liveness window, 3 s) is left alone until it stops: no hold,
   * no pause. Called when auto-pause takes charge on its own (Mantle starting, the standalone helper
   * switched off), never when someone turns it on. Why: Mantle restarted at 17:56:19 mid-video with the
   * music on, and the first tick paused Spotify straight away; the user pressed play twice and was fought
   * twice. Music the user already chose to play next to a lesson is not news; the NEXT video still pauses it.
   * adopt(false) cancels one not yet used (someone turned auto-pause on: they mean now).
   */
  function adopt(on) {
    st.adoptPending = on !== false;
    if (on === false) st.adoptKeys = new Set();
  }

  /**
   * INHERIT (protocol 2, docs/autopause-protocol.md): this app has just become the one decision maker and
   * the previous host (another app, now gone or yielding) had Spotify paused for the group. Take that pause
   * over so it is resumed when the holds end and never stranded. Only a Spotify that IS paused now is taken
   * (one the user restarted stays theirs). `suppressedForMs` carries the previous host's "leave Spotify
   * alone" back-off, so a change of host never starts a fresh fight with the user.
   */
  async function inherit(x) {
    const i = x || {};
    const now = o.now ? o.now() : Date.now();
    if (typeof i.suppressedForMs === 'number' && i.suppressedForMs > 0) st.suppressedUntil = Math.max(st.suppressedUntil, now + i.suppressedForMs);
    if (!i.paused) return { action: 'nothing' };
    const r = await serial(async () => {
      const state = sp.state();
      if (st.wePaused || (state !== 'paused' && state !== 'stopped')) return { action: 'nothing' };
      st.wePaused = true; st.lastAction = 'inherited';
      log(`took over a Spotify pause from the previous host (${holds.size} held)`);
      return { action: 'inherited' };
    });
    // Nobody holds it any more: hand it back now (the anti-strand rule).
    if (r.action === 'inherited' && holds.size === 0) return removeHold('\u0000inherit', 'the previous host had paused it and nothing plays');
    return r;
  }

  /** HAND OFF: stop deciding WITHOUT touching Spotify (another app takes over and inherits the pause). */
  function handOff() {
    for (const t of tracks.values()) { t.held = false; t.holdStartMs = -1; t.runStart = -1; t.adopted = false; }
    holds.clear();
    const was = st.wePaused;
    st.wePaused = false; st.episodeRepauses = 0; st.suppressedUntil = -1;
    return { action: was ? 'handed-off' : 'nothing', paused: was };
  }

  return { tick, adopt, addHold: (k, m, now) => addHold(k, m, nz(now, Date.now())), removeHold, releaseAll, inherit, handOff,
    snapshot, config: cfg, idle: () => st.busy, _tracks: tracks };
}

module.exports = { DEFAULTS, createEngine, updateTrack, newTrack };
