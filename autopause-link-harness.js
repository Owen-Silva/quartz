/* autopause-link.test.js - two auto-pause apps on one PC (./_autopause-link.js + ./_autopause-compat.js +
 * ./_autopause-core.js, the SHARED trio; Quartz runs the same file as autopause-link-harness.js). Real
 * loopback servers on FREE test ports, the real rules engine, and ONE fake Spotify both apps can reach, so
 * every pause and resume is counted per app: only the host may ever touch Spotify.
 * Never binds 8787-8790 and never touches the real Spotify.
 *   node lib/features/autopause-link.test.js
 */
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
// Mantle keeps the trio in lib/features/_autopause-*.js, Quartz in its root as autopause-*.js.
const pick = (a, b) => (fs.existsSync(path.join(__dirname, a)) ? require(path.join(__dirname, a)) : require(path.join(__dirname, b)));
const { createLink, httpGet } = pick('_autopause-link.js', 'autopause-link.js');
const { createCompat } = pick('_autopause-compat.js', 'autopause-compat.js');
const { createEngine } = pick('_autopause-core.js', 'autopause-core.js');

let pass = 0, fail = 0;
const failures = [];
function ok(c, what) { if (c) pass++; else { fail++; failures.push(what); } }
const J = (x) => JSON.stringify(x);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return Date.now() - t0; await wait(20); } return -1; }

function spotify() { return { state: 'playing', pauses: {}, plays: {}, total() { return { pauses: Object.values(this.pauses).reduce((a, b) => a + b, 0), plays: Object.values(this.plays).reduce((a, b) => a + b, 0) }; } }; }

/** One app: engine + host server + link, its holds a single local one (Quartz's shape). */
function makeApp(name, ports, sp, opt) {
  const o = opt || {};
  const app = { name, logs: [], dead: false, reqs: new Set() };
  let link = null;
  const engine = createEngine({
    now: Date.now, log: (t) => app.logs.push(t),
    spotify: {
      state: () => (link && link.role() === 'host' && !app.dead ? sp.state : 'none'),
      pause: async () => { sp.state = 'paused'; sp.pauses[name] = (sp.pauses[name] || 0) + 1; return { ok: true }; },
      play: async () => { sp.state = 'playing'; sp.plays[name] = (sp.plays[name] || 0) + 1; return { ok: true }; },
    },
  });
  const compat = createCompat({ engine, now: Date.now, name, ports, log: (t) => app.logs.push(t), media: () => null,
    control: async () => ({ ok: true }), spotify: () => ({ found: true, state: sp.state, aumid: 'Spotify.exe' }) });
  const get = (port, route, ms, onReq) => {
    if (app.dead) return new Promise(() => {});
    return httpGet(port, route, ms, (req) => { app.reqs.add(req); req.on('close', () => app.reqs.delete(req)); if (onReq) onReq(req); });
  };
  link = createLink({
    name, ports, get, log: (t) => app.logs.push(t), canHost: () => !app.dead && o.canHost !== false,
    host: { start: () => compat.start(), stop: (w) => compat.stop(w), port: () => compat.port() },
    localHold: async (h) => { if (h) await engine.addHold(`local:${name}`, { native: true, kind: 'browser' }, Date.now()); else await engine.removeHold(`local:${name}`, 'done'); },
    onHost: async (x) => {
      if (x.last) await engine.inherit({ paused: !!(x.last.wePaused || x.last.heldByUs), suppressedForMs: x.last.repauseSuppressed ? x.last.repauseSuppressedForMs : 0 });
      compat.notify();
    },
    retire: async (why) => { if (compat.successorWatching()) engine.handOff(); else { await engine.releaseAll(why); compat.notify(); } },
  });
  app.engine = engine; app.compat = compat; app.link = link;
  app.hold = async (h) => { await link.setHeld(h); await engine.idle(); };
  /** A crash: every socket drops, nothing is handed back, nothing more is said. */
  app.crash = () => { app.dead = true; for (const r of app.reqs) { try { r.destroy(); } catch (e) { /* gone */ } } compat.stop('crash'); };
  return app;
}

(async () => {
  const ports = (await Promise.all([freePort(), freePort(), freePort(), freePort()])).sort((a, b) => a - b);

  // 1. ALONE: one app hosts on the first port and pauses/resumes Spotify for its own hold.
  {
    const sp = spotify();
    const a = makeApp('quartz', ports, sp);
    await a.link.start();
    ok(a.link.role() === 'host' && a.link.port() === ports[0], `alone: host on the first port (${a.link.role()} ${a.link.port()})`);
    await a.hold(true);
    ok(sp.state === 'paused' && sp.pauses.quartz === 1, `alone: its hold pauses Spotify (${J(sp.pauses)})`);
    await a.hold(false);
    ok(sp.state === 'playing' && sp.plays.quartz === 1, `alone: and resumes it (${J(sp.plays)})`);
    await a.link.stop();
    ok(!a.compat.running(), 'alone: stop closes the port');
  }

  // 2. BOTH: the second app is a client; holds merge on the host; only the host touches Spotify.
  {
    const sp = spotify();
    const m = makeApp('mantle', ports, sp), q = makeApp('quartz', ports, sp);
    await m.link.start(); await q.link.start();
    ok(m.link.role() === 'host' && q.link.role() === 'client' && q.link.port() === ports[0], `both: one host, one client (${m.link.role()}/${q.link.role()})`);
    ok(!q.compat.running(), 'both: the client binds nothing');
    await q.hold(true); await m.engine.idle();
    ok(sp.state === 'paused' && J(sp.pauses) === J({ mantle: 1 }), `both: a client hold is paused by the host only (${J(sp.pauses)})`);
    await m.hold(true);
    ok(J(sp.pauses) === J({ mantle: 1 }), `both: a second hold does not pause twice (${J(sp.pauses)})`);
    await q.hold(false); await m.engine.idle();
    ok(sp.state === 'paused' && sp.total().plays === 0, 'both: one hold ending keeps Spotify paused for the other');
    await m.hold(false);
    ok(sp.state === 'playing' && J(sp.plays) === J({ mantle: 1 }), `both: the last hold ending resumes once (${J(sp.plays)})`);
    const st = q.link.hostStatus();
    ok(st && st.server === 'mantle' && st.protocol === 2, `both: the client follows the host's status (${st && st.server})`);
    await q.link.stop(); await m.link.stop();
  }

  // 3. TAKEOVER, graceful: the host quits while the client holds -> the client hosts within a few seconds,
  //    Spotify stays paused across the change (no resume-then-pause), and is resumed once when it ends.
  {
    const sp = spotify();
    const m = makeApp('mantle', ports, sp), q = makeApp('quartz', ports, sp);
    await m.link.start(); await q.link.start();
    await q.hold(true); await m.engine.idle();
    await wait(60);
    const t0 = Date.now();
    await m.link.stop('Mantle quits');
    const took = await until(() => q.link.role() === 'host', 3000);
    ok(took >= 0, `takeover: the client became host (${Date.now() - t0} ms)`);
    ok(sp.state === 'paused' && sp.total().plays === 0 && sp.total().pauses === 1, `takeover: no resume-then-pause across the change (${J(sp.pauses)} ${J(sp.plays)})`);
    ok(q.engine.snapshot().wePaused === true, 'takeover: the new host owns the pause');
    await q.hold(false);
    ok(sp.state === 'playing' && J(sp.plays) === J({ quartz: 1 }), `takeover: the new host resumes it when the hold ends (${J(sp.plays)})`);
    await q.link.stop();
  }

  // 3b. The same with NO pause between the hold and the quit (the host's /watch answer for the pause and
  //     the client's next poll race the quit), five times: never a resume across the change.
  {
    let good = 0;
    for (let i = 0; i < 5; i++) {
      const sp = spotify();
      const m = makeApp('mantle', ports, sp), q = makeApp('quartz', ports, sp);
      await m.link.start(); await q.link.start();
      await q.hold(true); await m.engine.idle();
      await m.link.stop('Mantle quits');
      await until(() => q.link.role() === 'host', 3000);
      if (q.link.role() === 'host' && sp.state === 'paused' && sp.total().plays === 0) good++;
      await q.hold(false); await q.link.stop();
    }
    ok(good === 5, `takeover right after a status change: no resume-then-pause (${good}/5)`);
  }

  // 4. Host quits with NO successor holding: it resumes what it paused (as always), the other app hosts.
  {
    const sp = spotify();
    const m = makeApp('mantle', ports, sp), q = makeApp('quartz', ports, sp);
    await m.link.start(); await q.link.start();
    await m.hold(true);
    await m.link.stop('Mantle quits');
    ok(sp.state === 'playing' && J(sp.plays) === J({ mantle: 1 }), `no successor: the host hands Spotify back on the way out (${J(sp.plays)})`);
    ok(await until(() => q.link.role() === 'host', 3000) >= 0, 'no successor: the other app still takes over');
    ok(sp.total().pauses === 1 && sp.total().plays === 1, 'no successor: nothing else moved');
    await q.link.stop();
  }

  // 5. HOST CRASH while it held for itself: the client takes over, inherits the pause, and with nothing
  //    holding resumes it at once (anti-strand).
  {
    const sp = spotify();
    const m = makeApp('mantle', ports, sp), q = makeApp('quartz', ports, sp);
    await m.link.start(); await q.link.start();
    await m.hold(true);
    await until(() => q.link.hostStatus() && q.link.hostStatus().wePaused === true, 2000);
    m.crash();
    const took = await until(() => q.link.role() === 'host' && sp.state === 'playing', 3000);
    ok(took >= 0, `crash: the client took over and resumed the stranded pause (${took} ms)`);
    ok(J(sp.plays) === J({ quartz: 1 }) && J(sp.pauses) === J({ mantle: 1 }), `crash: exactly one pause and one resume (${J(sp.pauses)} ${J(sp.plays)})`);
    await q.link.stop();
  }

  // 6. CLIENT CRASH while it held: the host drops its hold the moment its /watch socket closes.
  {
    const sp = spotify();
    const m = makeApp('mantle', ports, sp), q = makeApp('quartz', ports, sp);
    await m.link.start(); await q.link.start();
    await q.hold(true); await m.engine.idle();
    await until(() => m.compat.watching() > 0, 1000);
    q.crash();
    const t = await until(() => sp.state === 'playing', 3000);
    ok(t >= 0 && t < 2000, `client crash: its hold is dropped at once, not after 180 s (${t} ms)`);
    ok(J(sp.plays) === J({ mantle: 1 }), `client crash: resumed once by the host (${J(sp.plays)})`);
    await m.link.stop();
  }

  // 7. SIMULTANEOUS START, five times: always exactly one host.
  {
    let good = 0;
    for (let i = 0; i < 5; i++) {
      const sp = spotify();
      const m = makeApp('mantle', ports, sp), q = makeApp('quartz', ports, sp);
      await Promise.all([m.link.start(), q.link.start()]);
      const roles = [m.link.role(), q.link.role()].sort().join('/');
      const bound = [m.compat.running(), q.compat.running()].filter(Boolean).length;
      if (roles === 'client/host' && bound === 1) good++;
      await Promise.all([m.link.stop(), q.link.stop()]);
    }
    ok(good === 5, `simultaneous start: one host every time (${good}/5)`);
  }

  // 8. An app that may not host (its switch is off) with nobody hosting: role none, nothing bound,
  //    Spotify untouched; once a host appears its next hold goes there.
  {
    const sp = spotify();
    const q = makeApp('quartz', ports, sp, { canHost: false });
    await q.link.start();
    ok(q.link.role() === 'none' && !q.compat.running(), `cannot host: nothing bound (${q.link.role()})`);
    await q.hold(true);
    ok(sp.state === 'playing' && sp.total().pauses === 0, 'cannot host: Spotify untouched');
    const m = makeApp('mantle', ports, sp);
    await m.link.start();
    await q.hold(false); await q.hold(true); await m.engine.idle();
    ok(q.link.role() === 'client' && J(sp.pauses) === J({ mantle: 1 }), `cannot host: its hold goes to the new host (${q.link.role()} ${J(sp.pauses)})`);
    await q.hold(false); await q.link.stop(); await m.link.stop();
  }

  // 9. The OLD standalone bridge (no /watch, no protocol) is a host too; when it dies a client that may
  //    host takes over by polling /ping.
  {
    const sp = spotify();
    const legacy = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const body = u.pathname === '/watch' ? { ok: false, reason: 'not found' } : { ok: true, app: 'spotify-autopause', version: '1.5.3', spotifyFound: true, spotifyState: 'playing', heldByUs: false, holds: [] };
      res.writeHead(u.pathname === '/watch' ? 404 : 200, { 'Content-Type': 'application/json', Connection: 'close' }); res.end(J(body));
    });
    await new Promise((r) => legacy.listen(ports[0], '127.0.0.1', r));
    const q = makeApp('quartz', ports, sp);
    await q.link.start();
    ok(q.link.role() === 'client' && q.link.port() === ports[0], `legacy: the old bridge is the host (${q.link.role()})`);
    legacy.close(); if (legacy.closeAllConnections) legacy.closeAllConnections();
    const t = await until(() => q.link.role() === 'host', 6000);
    ok(t >= 0 && t < 5000, `legacy: a client takes over within a few seconds of it dying (${t} ms)`);
    await q.link.stop();
  }

  // 10. The SAME security gate on the protocol-2 routes: a web page cannot watch, hold or release.
  {
    const sp = spotify();
    const m = makeApp('mantle', ports, sp);
    await m.link.start();
    const call = (p, headers) => new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: ports[0], path: p, headers }, (res) => { res.resume(); resolve(res.statusCode); });
      r.on('error', () => resolve(0)); r.end();
    });
    const page = await call('/watch?src=x', { Origin: 'https://evil.example' });
    const nocors = await call('/pause?src=x', { 'Sec-Fetch-Site': 'cross-site' });
    const rebind = await call('/pause?src=x', { Host: 'evil.example:' + ports[0] });
    ok(page === 403 && nocors === 403 && rebind === 403, `gate: page watch/no-cors hold/rebinding refused (${page}/${nocors}/${rebind})`);
    ok(sp.total().pauses === 0 && m.engine.snapshot().holds.length === 0, 'gate: nothing was held');
    await m.link.stop();
  }

  for (const f of failures) console.log('FAIL ' + f);
  console.log(`AUTOPAUSE-LINK ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', (e && e.stack) || e); console.log(`AUTOPAUSE-LINK ${pass} passed, ${fail + 1} failed`); process.exit(1); });
