'use strict';
/* _autopause-link.js - which app is the Spotify auto-pause HOST. SHARED, byte-identical, between Mantle
 * (lib/features/_autopause-link.js) and Quartz (autopause-link.js); the protocol is written down once in
 * docs/autopause-protocol.md in both repos. Change both copies together.
 *
 * Either app works alone, and both together never fight:
 *   - ELECTION. Probe 127.0.0.1:8787-8790 for a host (/ping says app "spotify-autopause"). One answers:
 *     be its CLIENT. None: bind the first free port and be the HOST. Binding is the lock: two apps that
 *     start together cannot both get 8787, and a host that bound a higher port looks below it once and
 *     yields to the lower one. So there is one decision maker over Spotify at any time.
 *   - CLIENT. Our holds go to the host as GET /pause?src=<name> (re-sent every 60 s; the host's TTL is
 *     180 s) and /resume when they end. We hold one /watch long poll open on the host: the instant its
 *     socket closes (the host quit or crashed) we elect again, so a client that may host takes over in
 *     well under a second, not after a timeout. The watch also keeps our copy of the host's status fresh,
 *     which is what a takeover inherits (wePaused, the "leave Spotify alone" back-off).
 *   - HANDOFF. A client that can take over says can=host on its holds. A host that stops while such a
 *     client still holds and watches leaves Spotify paused for it (no resume, then pause again); with no
 *     such client it resumes what it paused, as always. A taker-over inherits the pause only if Spotify IS
 *     paused, and resumes at once when nothing holds any more: no stranded pause either way.
 *   - The old standalone bridge (no /watch) is still a host: a client that could take over polls its
 *     /ping every 3 s instead.
 *
 * createLink({ name, ports, canHost(), host: { start(): Promise<port|null>, stop(why), port() },
 *              localHold(held): Promise (host role: our own hold, in our own engine),
 *              onHost({ from, last }): Promise (we just became host; `last` = the old host's status),
 *              retire(why): Promise (host role ends: hand off or hand back, owner's engine),
 *              onChange(), log(text), get(port, route, timeoutMs, onReq) })
 */
const http = require('http');

const PORTS = [8787, 8788, 8789, 8790];
const PROBE_MS = 600;
const CALL_MS = 4000;
const WATCH_WAIT_MS = 250000;    // the host answers a /watch within 240 s
const REFRESH_MS = 60000;
const LEGACY_POLL_MS = 3000;
const NONE_POLL_MS = 10000;
const REELECT_MS = 150;

/** One loopback GET, no Origin (a local app). -> { code, json } | { code: 0, error }. Never rejects. */
function httpGet(port, route, timeoutMs, onReq) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = http.request({ host: '127.0.0.1', port, path: route, method: 'GET', timeout: timeoutMs, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 1048576) { req.destroy(); finish({ code: 0, error: 'too big' }); } });
        res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch (e) { json = null; } finish({ code: res.statusCode, json }); });
        res.on('error', () => finish({ code: 0, error: 'cut off' }));
        res.on('aborted', () => finish({ code: 0, error: 'cut off' }));
      });
    } catch (e) { finish({ code: 0, error: 'unreachable' }); return; }
    req.on('timeout', () => { req.destroy(); finish({ code: 0, error: 'timeout' }); });
    req.on('error', (e) => finish({ code: 0, error: (e && e.code) || 'error' }));
    req.on('close', () => finish({ code: 0, error: 'closed' }));
    if (onReq) onReq(req);
    req.end();
  });
}

function isHost(r) { return !!(r && r.code === 200 && r.json && r.json.ok === true && /spotify-autopause/i.test(String(r.json.app || ''))); }

function createLink(opts) {
  const o = opts || {};
  const name = o.name;
  const ports = o.ports || PORTS;
  const get = o.get || httpGet;
  const log = o.log || (() => {});
  const changed = () => { try { if (o.onChange) o.onChange(); } catch (e) { /* the owner's problem */ } };
  const canHost = () => { try { return !!o.canHost(); } catch (e) { return false; } };
  const T = { set: o.setTimer || setTimeout, clear: o.clearTimer || clearTimeout };

  let role = 'off';              // off | host | client | none
  let hostPort = null;           // the host's port (client), or ours (host)
  let last = null;               // the host's newest status (client role)
  let held = false;
  let stopped = true;
  let electing = null, again = false;
  let gen = 0;                   // bumps on every role change: a stale loop or timer sees it and stops
  let watchReq = null;
  let refreshTimer = null, pollTimer = null;

  function later(fn, ms) { const t = T.set(fn, ms); if (t && t.unref) t.unref(); return t; }
  function clearTimers() {
    if (refreshTimer) { T.clear(refreshTimer); refreshTimer = null; }
    if (pollTimer) { T.clear(pollTimer); pollTimer = null; }
    if (watchReq) { const r = watchReq; watchReq = null; try { r.destroy(); } catch (e) { /* gone */ } }
  }

  async function probeAll(below) {
    const list = ports.filter((p) => (below == null || p < below) && p !== (role === 'host' ? hostPort : null));
    const hits = await Promise.all(list.map((p) => get(p, '/ping', PROBE_MS)));
    for (let i = 0; i < list.length; i += 1) if (isHost(hits[i])) return { port: list[i], status: hits[i].json };
    return null;
  }

  function elect(why) {
    if (stopped) return Promise.resolve(role);
    if (electing) { again = true; return electing; }
    electing = (async () => {
      do { again = false; try { await electOnce(why); } catch (e) { log(`auto-pause link: electing threw: ${(e && e.message) || e}`); } } while (again && !stopped);
      return role;
    })();
    return electing.finally(() => { electing = null; });
  }

  async function electOnce(why) {
    if (stopped) return;
    if (role === 'host') {
      if (!canHost()) { await retire('this app may not decide any more'); return electOnce(why); }
      return;
    }
    const found = await probeAll(null);
    if (stopped) return;
    if (found) return becomeClient(found);
    if (!canHost()) { setRole('none'); armNonePoll(); return; }
    const p = await o.host.start();
    if (stopped) { if (p != null) o.host.stop('stopped while starting'); return; }
    if (p == null) return becomeHost(null, 'no free port: deciding for this app alone');   // ports taken by other software
    const lower = await probeAll(p);
    if (lower) {             // two apps bound at once: the lower port is the host, we were never it
      o.host.stop('another app is the auto-pause host');
      return becomeClient(lower);
    }
    return becomeHost(p, why);
  }

  function setRole(r, force) {
    if (role !== r || force) { if (role !== r) log(`auto-pause link: ${role} -> ${r}`); role = r; gen += 1; clearTimers(); changed(); }
  }

  async function becomeHost(p, why) {
    const from = role, prev = last;
    setRole('host');
    hostPort = p; last = null;
    log(`auto-pause link: this app is the host on ${p}${why ? ` (${why})` : ''}`);
    if (held) await o.localHold(true);
    await o.onHost({ from, last: from === 'client' ? prev : null });
    changed();
  }

  async function becomeClient(found) {
    setRole('client', true);
    hostPort = found.port; last = found.status;
    log(`auto-pause link: a client of the host on ${found.port} (${String(found.status.server || 'the standalone helper')})`);
    const g = gen;
    if (Number(found.status.protocol) >= 2) watchLoop(g);
    else armLegacyPoll(g);
    changed();
    if (held) await sendHold(g);
  }

  async function sendHold(g) {
    if (refreshTimer) { T.clear(refreshTimer); refreshTimer = null; }
    let q = `/pause?src=${encodeURIComponent(name)}`;
    if (canHost()) q += '&can=host';
    const r = await get(hostPort, q, CALL_MS);
    if (g !== gen) return;
    if (isHost(r)) { last = r.json; changed(); }
    else { log('auto-pause link: the host did not take our hold; looking again'); later(() => elect('the host did not answer'), REELECT_MS); return; }
    if (held) refreshTimer = later(() => { refreshTimer = null; if (g === gen && held) sendHold(g); }, REFRESH_MS);
  }

  async function sendRelease(g) {
    if (refreshTimer) { T.clear(refreshTimer); refreshTimer = null; }
    const r = await get(hostPort, `/resume?src=${encodeURIComponent(name)}`, CALL_MS);
    if (g === gen && isHost(r)) { last = r.json; changed(); }
  }

  async function watchLoop(g) {
    let since = (last && last.sig) || '';
    while (g === gen && !stopped) {
      const t0 = Date.now();
      const r = await get(hostPort, `/watch?src=${encodeURIComponent(name)}&since=${encodeURIComponent(since)}`, WATCH_WAIT_MS, (req) => { if (g === gen) watchReq = req; });
      if (g !== gen) return;
      watchReq = null;
      if (isHost(r)) {
        last = r.json; since = r.json.sig || ''; changed();
        if (Date.now() - t0 < 40) await new Promise((res) => later(res, 40));   // never a hot loop
        continue;
      }
      if (r && r.code === 404) { armLegacyPoll(g); return; }   // a host without /watch
      break;
    }
    if (g === gen && !stopped) {
      log('auto-pause link: the host went away');
      later(() => { if (g === gen) elect('the host went away'); }, REELECT_MS);
    }
  }

  function armLegacyPoll(g) {
    if (!canHost() || pollTimer) return;   // a client that cannot take over has nothing to check for
    pollTimer = later(async () => {
      pollTimer = null;
      if (g !== gen || stopped) return;
      const r = await get(hostPort, '/ping', PROBE_MS * 2);
      if (g !== gen || stopped) return;
      if (isHost(r)) { last = r.json; armLegacyPoll(g); } else elect('the host went away');
    }, LEGACY_POLL_MS);
  }

  function armNonePoll() {
    if (!held || pollTimer) return;   // nobody hosts and we may not: look again only while we hold
    const g = gen;
    pollTimer = later(() => { pollTimer = null; if (g === gen && held) elect('still holding'); }, NONE_POLL_MS);
  }

  async function retire(why) {
    const p = hostPort;
    gen += 1;
    try { await o.retire(why); } catch (e) { log(`auto-pause link: retiring threw: ${(e && e.message) || e}`); }
    o.host.stop(why);
    log(`auto-pause link: no longer the host on ${p} (${why})`);
    role = 'off'; hostPort = null; clearTimers(); changed();
  }

  return {
    start() { if (!stopped) return elect('already started'); stopped = false; return elect('starting'); },
    /** Stop taking part. Host: hand off or hand back (owner's retire). Client: our hold goes back first. */
    async stop(why) {
      if (stopped) return;
      if (role === 'host') await retire(why || 'stopped');
      else if (role === 'client' && held) await sendRelease(gen);
      stopped = true; held = false;
      role = 'off'; hostPort = null; gen += 1; clearTimers(); changed();
    },
    /** Our own "something plays" (Quartz: its tabs; Mantle: its watched apps). */
    async setHeld(h) {
      const next = !!h;
      if (next === held) return;
      held = next;
      if (stopped) return;
      if (role === 'host') await o.localHold(next);
      else if (role === 'client') { if (next) await sendHold(gen); else await sendRelease(gen); }
      else if (next) await elect('a hold with nowhere to go');
    },
    /** The owner's "may we host" changed (a switch moved): step down, or look for the job. */
    sync() { if (stopped) return Promise.resolve(role); if (role === 'client' && !canHost() && pollTimer) { T.clear(pollTimer); pollTimer = null; } return role === 'client' ? Promise.resolve(role) : elect('a switch moved'); },
    role: () => role,
    port: () => hostPort,
    held: () => held,
    hostStatus: () => last,
    elect,
  };
}

module.exports = { createLink, httpGet, PORTS, PROBE_MS, REFRESH_MS, LEGACY_POLL_MS };
