'use strict';
/* _autopause-compat.js - the auto-pause HOST's HTTP API on 127.0.0.1:8787-8790. SHARED, byte-identical,
 * between Mantle (lib/features/_autopause-compat.js) and Quartz (autopause-compat.js); the protocol is
 * written down once in docs/autopause-protocol.md in both repos. Change both copies together.
 *
 * Whichever app (Mantle or Quartz) binds a port first is the HOST, the one decision maker over Spotify;
 * the other is a CLIENT that sends its holds here (./_autopause-link.js runs the election). The routes are
 * the original standalone bridge's (/ping /status /pause /resume /now /sessions /control /config), so a
 * browser extension written for it keeps working, plus protocol 2:
 *   /pause  ttl=<ms>  the hold's own expiry (5 s .. 10 min; default the engine's 180 s)
 *           can=host  the sender can take over as host: while its hold lives, a host that stops hands
 *                     Spotify over instead of resuming it (the sender inherits the pause)
 *   /watch  ?src=<id>&since=<sig>  a long poll: answers at once when the status signature differs from
 *           since, else when it changes, or after 240 s. A client holds one open at all times, so it
 *           learns of the host's exit the instant the socket closes (no polling), and the host learns of
 *           a client's crash the same way (its hold is dropped then, not 180 s later).
 *
 * SAFETY (the old bridge allowed any web page; kept identical in both apps): a request carrying an Origin is
 * served only from a browser EXTENSION (chrome-extension:// / moz-extension:// / extension://); a web page
 * gets 403. A request with NO Origin is a local app (Node http, PowerShell) only while it also carries no
 * Sec-Fetch-Site (or "none" = typed by the user): browsers send Sec-Fetch-Site to 127.0.0.1, so a page's
 * <img src=".../pause"> or no-cors GET (no Origin) is refused with 403 before any route runs (fetchOk).
 * The Host must be 127.0.0.1 or localhost (no DNS rebinding). Bodies are capped at 4 KB, src is
 * ^[A-Za-z0-9:._-]{1,80}$ (else 'browser'), and /control takes play|pause|toggle|next|prev only.
 * Differences from the old bridge, on purpose: ad ducking is not served (POST /config says so in words),
 * and its debug routes are gone.
 */
const http = require('http');

const PORTS = [8787, 8788, 8789, 8790];
const SRC_RE = /^[A-Za-z0-9:._-]{1,80}$/;
const CMDS = { play: 'play', pause: 'pause', toggle: 'toggle', next: 'next', prev: 'previous' };
const PROTOCOL = 2;
const WATCH_MS = 240000;

function srcKey(q) {
  const s = String(q.get('src') || '').trim().slice(0, 80);
  return SRC_RE.test(s) ? s : 'browser';
}
function originOk(o) { return !o || /^(chrome-extension|moz-extension|extension):\/\//i.test(String(o)); }
// No Origin: a browser still says where the request came from in Sec-Fetch-Site (127.0.0.1 is a
// trustworthy origin); Node and PowerShell callers send neither. "none" = the user typed the URL.
function fetchOk(origin, site) {
  if (origin) return originOk(origin);
  return site === undefined || String(site).trim().toLowerCase() === 'none';
}
function hostOk(h, port) { return new RegExp(`^(127\\.0\\.0\\.1|localhost)(:${port})?$`, 'i').test(String(h || '')); }

/**
 * createCompat({ engine, spotify(): {found, state, aumid}, media(): the NOW PLAYING read, control(cmd): Promise<{ok, reason}>,
 *                log, now, ports, name: 'mantle' | 'quartz', changed(),
 *                refresh(): Promise (optional: freshen spotify()/media() before a hold or a /now) })
 */
function createCompat(deps) {
  const d = deps || {};
  const name = d.name || 'mantle';
  let server = null, port = null, starting = null, closing = false;
  const watchers = new Set();      // open /watch long polls: { res, src, since, timer }
  const watchedAt = new Map();     // src -> last time it had a /watch open (a client re-opens right after each answer)
  const WATCH_GAP_MS = 2000;

  function statusJson(extra) {
    const sp = d.spotify();
    const snap = d.engine.snapshot(d.now());
    const j = Object.assign({
      ok: true, app: 'spotify-autopause', server: name, version: name, protocol: PROTOCOL, port,
      spotifyFound: !!sp.found, spotifyState: sp.found ? sp.state : 'none', heldByUs: snap.wePaused && snap.holds.length > 0, wePaused: snap.wePaused,
      control: 'smtc', holds: snap.holds.map((h) => (h.native ? 'native' : h.key.replace(/^http:/, ''))),
      repauseCount: snap.episodeRepauses, repauseSuppressed: snap.suppressed, repauseSuppressedForMs: snap.suppressedForMs,
      browserHoldTtlMs: d.engine.config.httpHoldTtlMs, adDuck: null,
    }, extra || {});
    j.sig = sigOf(j);
    return j;
  }
  /** What a client needs to follow the host, as one string: a /watch answers when it changes. */
  function sigOf(j) { return [j.spotifyState, j.wePaused ? 1 : 0, j.holds.join(','), j.repauseSuppressed ? 1 : 0].join('|'); }

  /** Answer every /watch whose picture is out of date (the owner calls this after anything moves). */
  function notify() {
    if (!watchers.size || !server) return;
    const j = statusJson();
    for (const w of [...watchers]) if (w.since !== j.sig) answerWatch(w, j);
  }
  function answerWatch(w, j) {
    if (!watchers.delete(w)) return;
    if (w.src) watchedAt.set(w.src, Date.now());
    clearTimeout(w.timer);
    w.done = true;
    send(w.res, 200, j || statusJson());
  }

  function nowJson(q) {
    const m = d.media();
    const list = m && Array.isArray(m.sessions) ? m.sessions : [];
    const s = (m && m.shown) || list.find((x) => x && x.playing) || list[0] || null;
    if (!s) return { ok: true, source: '', title: '', artist: '', album: '', status: 'none', positionMs: 0, durationMs: 0, canNext: false, canPrev: false, canPlayPause: false, held: false, art: null, artHash: '' };
    const tl = s.timeline && s.timeline.available !== false ? s.timeline : {};
    const can = s.can || {};
    const snap = d.engine.snapshot(d.now());
    const out = {
      ok: true, source: s.aumid || '', title: s.title || '', artist: s.artist || '', album: s.album || '',
      status: String(s.status || 'none'), positionMs: Math.round(tl.positionNowMs || tl.positionMs || 0), durationMs: Math.round(tl.durationMs || 0),
      canNext: can.next === true, canPrev: can.previous === true, canPlayPause: can.toggle === true || can.play === true || can.pause === true,
      held: snap.wePaused && snap.holds.length > 0, art: null, artMime: '', artHash: '',
    };
    const url = typeof s.art === 'string' ? s.art : (s.art && typeof s.art.url === 'string' ? s.art.url : '');
    const mm = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(url);
    if (mm) {
      let h = 0; const key = String(s.artKey || url.slice(-64));
      for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
      out.artHash = (h >>> 0).toString(16);
      out.artMime = mm[1];
      const want = q.get('art'), had = q.get('artHash');
      if (want !== '0' && had !== out.artHash) out.art = mm[2];
    }
    return out;
  }

  async function route(req, url, body) {
    const p = url.pathname, q = url.searchParams;
    if (p === '/ping' || p === '/status') return [200, statusJson()];
    if (p === '/pause') {
      const key = srcKey(q);
      const ttl = Math.round(Number(q.get('ttl')));
      if (d.refresh) await d.refresh();
      const r = await d.engine.addHold(`http:${key}`, {
        native: false, kind: 'http', successor: q.get('can') === 'host',
        ttl: Number.isFinite(ttl) && ttl > 0 ? Math.min(600000, Math.max(5000, ttl)) : 0,
      }, d.now());
      d.log(`a hold came in over HTTP (${r.action})`);
      if (d.changed) d.changed();
      notify();
      return [200, statusJson({ action: r.action, reason: r.reason || '' })];
    }
    if (p === '/resume') {
      const key = srcKey(q);
      const r = await d.engine.removeHold(`http:${key}`, 'its app handed it back');
      if (d.changed) d.changed();
      notify();
      return [200, statusJson({ action: r.action, reason: r.reason || '' })];
    }
    if (p === '/now') { if (d.refresh) await d.refresh(); return [200, nowJson(q)]; }
    if (p === '/sessions') {
      const snap = d.engine.snapshot(d.now());
      return [200, { ok: true, sessions: snap.tracks.map((t) => ({ kind: t.kind, realPlaying: t.real, held: t.held, status: t.status })) }];
    }
    if (p === '/control') {
      let cmd = q.get('cmd') || '';
      if (!cmd && body) { try { const j = JSON.parse(body); cmd = j && typeof j.cmd === 'string' ? j.cmd : ''; } catch (e) { cmd = ''; } }
      if (!Object.prototype.hasOwnProperty.call(CMDS, cmd)) return [200, { ok: false, cmd: String(cmd).slice(0, 16), reason: 'bad cmd' }];
      const snap = d.engine.snapshot(d.now());
      if ((cmd === 'play' || cmd === 'toggle') && snap.wePaused && snap.holds.length) return [200, { ok: false, cmd, reason: 'held', holds: snap.holds.length }];
      const r = await d.control(CMDS[cmd]);
      return [200, r.ok ? { ok: true, cmd, result: true, source: name } : { ok: false, cmd, reason: r.reason || 'no session' }];
    }
    if (p === '/config') {
      if (req.method === 'POST') return [200, { ok: false, reason: `${name.charAt(0).toUpperCase() + name.slice(1)} does not turn Spotify’s ads down, so there is nothing to change here` }];
      return [200, { ok: true, config: { adDuck: { enabled: false } }, server: name }];
    }
    return [404, { ok: false, reason: 'not found' }];
  }

  /**
   * /watch?src=&since=: hold the request open until the picture changes (or WATCH_MS). The socket IS the
   * liveness signal both ways: a client whose socket closes before we answered has gone (crashed or
   * quit), so its hold goes now; a client sees ours close the moment this app exits.
   */
  function watch(req, res, q) {
    const src = q.has('src') ? srcKey(q) : '';
    const w = { res, src, since: String(q.get('since') || ''), timer: null, done: false };
    const j = statusJson();
    if (w.since !== j.sig) return send(res, 200, j);
    watchers.add(w);
    if (src) watchedAt.set(src, Date.now());
    w.timer = setTimeout(() => answerWatch(w), WATCH_MS);
    if (w.timer.unref) w.timer.unref();
    res.on('close', () => {
      if (w.done || closing) return;
      watchers.delete(w);
      clearTimeout(w.timer);
      if (!src || [...watchers].some((x) => x.src === src)) return;
      watchedAt.delete(src);
      d.engine.removeHold(`http:${src}`, 'its app closed').then((r) => {
        if (r && r.action !== 'skipped') d.log(`a client app went away: its hold was dropped (${r.action})`);
        if (d.changed) d.changed();
        notify();
      }, () => {});
    });
    return undefined;
  }

  function send(res, code, obj) {
    if (res.writableEnded || res.destroyed) return;
    const b = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'Cache-Control': 'no-store', Connection: 'close',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(b);
  }

  function handler(req, res) {
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (!hostOk(req.headers.host, port) || !fetchOk(origin, req.headers['sec-fetch-site'])) return send(res, 403, { ok: false, reason: 'only this PC’s apps and browser extensions may use this' });
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true' }); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { ok: false, reason: 'GET or POST only' });
    let body = '', big = false;
    req.setEncoding('utf8');
    req.on('data', (c) => { if (body.length + c.length > 4096) { big = true; } else body += c; });
    req.on('end', () => {
      if (big) return send(res, 413, { ok: false, reason: 'body over 4 KB' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return send(res, 400, { ok: false, reason: 'bad url' }); }
      if (url.pathname === '/watch') return watch(req, res, url.searchParams);
      route(req, url, body).then(([code, obj]) => send(res, code, obj), (e) => {
        d.log(`a compatible-API request threw: ${(e && e.stack) || e}`);
        send(res, 500, { ok: false, reason: `${name} could not do that` });
      });
    });
  }

  function listenOn(p) {
    return new Promise((resolve) => {
      const s = http.createServer(handler);
      s.once('error', () => { try { s.close(); } catch (e) { /* never bound */ } resolve(null); });
      s.listen(p, '127.0.0.1', () => resolve(s));
    });
  }

  async function start() {
    if (server) return port;
    if (starting) return starting;
    starting = (async () => {
      for (const p of d.ports || PORTS) {
        const s = await listenOn(p);
        if (s) { server = s; port = p; s.on('error', (e) => d.log(`the compatible API stopped: ${e && e.code}`)); d.log(`serving the bridge-compatible API on 127.0.0.1:${p}`); return p; }
      }
      d.log('the bridge-compatible API could not start: ports 8787-8790 are all taken');
      return null;
    })();
    try { return await starting; } finally { starting = null; }
  }

  function stop(why) {
    if (!server) return;
    const s = server;
    closing = true;
    for (const w of watchers) { clearTimeout(w.timer); w.done = true; }
    watchers.clear();
    server = null; port = null;
    try { s.close(); if (typeof s.closeAllConnections === 'function') s.closeAllConnections(); } catch (e) { /* gone */ }
    closing = false;
    d.log(`bridge-compatible API closed (${why || 'stopped'})`);
  }

  /** Live holds from clients that can take over AND hold a /watch open (or did within WATCH_GAP_MS, the moment
   *  between an answer and their next poll): they will notice our exit and take the pause over. */
  function successorWatching() {
    const srcs = new Set([...watchers].map((w) => w.src).filter(Boolean));
    const t = Date.now();
    for (const [s, at] of watchedAt) if (t - at < WATCH_GAP_MS) srcs.add(s);
    return d.engine.snapshot(d.now()).holds.some((h) => h.successor && h.live && !h.native && srcs.has(h.key.replace(/^http:/, '')));
  }

  return { start, stop, notify, successorWatching, port: () => port, running: () => !!server, watching: () => watchers.size };
}

module.exports = { createCompat, PORTS, PROTOCOL, originOk, fetchOk, hostOk, srcKey };
