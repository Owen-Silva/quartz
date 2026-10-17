'use strict';
// tests/watch-mock.js -- the four services Watch reads, served from tests/watch-fixtures/ on 127.0.0.1,
// for watch-e2e.js. Never a real service, never the user's accounts.
//
// One HTTP server per service, each on its own port so every page sits at its real path (a reader
// that ends on /login or /errors/validateCaptcha looks exactly as it would on the real host):
//   youtube  /  /feed/history  /playlist?list=WL   an HTML page that sets window.ytInitialData from the
//            fixture's ytInitialData and a ytcfg whose get('LOGGED_IN') is the fixture's loggedIn;
//            /results?search_query=  tests/watch-fixtures/youtube-search.html;  /watch?v=  a stand-in page.
//   disney   /home   an HTML page whose script fetch()es every capture path of the fixture from this same
//            host (the reader captures them over CDP by path), each answered with that capture's JSON.
//            Signed out, /home redirects to /login (a page with a log-in link), as the real site does.
//   prime    /   HTML embedding <script id="dv-web-page-hydration-data" type="application/json"> and
//            dv-web-global-store-data from the fixture. Robot: / redirects to /errors/validateCaptcha.
//   espn     the scoreboard JSON per league and the WatchESPN home JSON. BOTH ESPN hosts
//            (site.api.espn.com, watch.product.api.espn.com) point at this one server; their paths
//            do not collide. Event times are shifted so the fixture's live game started 40 min ago.
//
// Modes, per service, switchable at runtime (setMode() in-process, or GET /__mode?svc=<id>&mode=<m> on
// the control server; GET /__mode alone answers the modes and the request log):
//   ok               the fixtures
//   signed-out       youtube/prime: the signed-out fixture; disney: /home -> /login
//   changed-layout   the "-changed" fixture (youtube: youtube-empty; espn: JSON with none of its keys)
//   robot            prime only: Amazon's robot check
//   slow             the request is held and never answered (the reader's 20 s budget ends it)
//   down             the listener is closed: connection refused on that port until the mode changes
//
//   node tests/watch-mock.js     serves until Ctrl+C; prints the ports and the QUARTZ_WATCH_REBASE value.
const fs = require('fs');
const http = require('http');
const path = require('path');

const FIX = path.join(__dirname, 'watch-fixtures');
const SERVICES = ['youtube', 'disney', 'prime', 'espn'];
const MODES = {
  youtube: ['ok', 'signed-out', 'changed-layout', 'slow', 'down'],
  disney: ['ok', 'signed-out', 'changed-layout', 'slow', 'down'],
  prime: ['ok', 'signed-out', 'changed-layout', 'robot', 'slow', 'down'],
  espn: ['ok', 'changed-layout', 'slow', 'down'],
};
const ORIGINS = {
  youtube: ['https://www.youtube.com'],
  disney: ['https://www.disneyplus.com'],
  prime: ['https://www.primevideo.com'],
  espn: ['https://site.api.espn.com', 'https://watch.product.api.espn.com'],
};
// The live NHL game in espn-nhl.json; every fixture time moves by the same amount so it started 40 min ago.
const ESPN_ANCHOR = Date.parse('2026-10-17T01:00:00Z');
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z/g;

const cache = new Map();
function fixture(name) {
  if (!cache.has(name)) cache.set(name, fs.readFileSync(path.join(FIX, name), 'utf8'));
  return cache.get(name);
}
const fx = (name) => JSON.parse(fixture(name + '.json'));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** JSON that can sit inside a <script> element (no "</script>", no line separators). */
const BS = String.fromCharCode(92);
const inScript = (v) => JSON.stringify(v).split('<').join(BS + 'u003c')
  .split(String.fromCharCode(0x2028)).join(BS + 'u2028').split(String.fromCharCode(0x2029)).join(BS + 'u2029');

function send(res, status, type, body, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
  return true;
}
const html = (res, body) => send(res, 200, 'text/html; charset=utf-8', body);
const json = (res, body) => send(res, 200, 'application/json; charset=utf-8', typeof body === 'string' ? body : JSON.stringify(body));
const redirect = (res, to) => send(res, 302, 'text/plain', 'moved', { Location: to });
const page = (title, head, body) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + esc(title) + '</title>' + (head || '') + '</head><body>' + (body || '') + '</body></html>';

const SEARCH = { tag: false, delay: {} };

/* ---- YouTube ---------------------------------------------------------------------------------- */
const YT_STEP = { '/': 'youtube-home', '/feed/history': 'youtube-history', '/playlist': 'youtube-watchlater' };
function youtube(mode, req, res, p, q) {
  if (YT_STEP[p]) {
    const name = mode === 'signed-out' ? 'youtube-signedout' : mode === 'changed-layout' ? 'youtube-empty' : YT_STEP[p];
    const f = fx(name);
    const script = '<script>var ytcfg={data_:{LOGGED_IN:' + (f.loggedIn === true) + '},get:function(k){return this.data_[k];}};'
      + 'window.ytInitialData=' + inScript(f.ytInitialData) + ';</script>';
    // A cookie for the reader's session, so a search that leaked his cookies would show it (e2e checks).
    return send(res, 200, 'text/html; charset=utf-8', page('YouTube', script, '<div id="content">mock YouTube (' + esc(name) + ')</div>'), { 'Set-Cookie': 'e2e_his_session=1; Path=/; SameSite=Lax' });
  }
  if (p === '/results') {
    // SEARCH.tag puts [query] in front of every title, so two answers can be told apart; SEARCH.delay
    // holds the answer to one query for that many ms (a query still in flight when the next is typed).
    const qv = String(q.get('search_query') || '');
    let body = fixture('youtube-search.html');
    if (SEARCH.tag) body = body.split('"title":{"runs":[{"text":"').join('"title":{"runs":[{"text":"[' + qv.replace(/[^A-Za-z0-9 ]/g, '') + '] ');
    const ms = Number(SEARCH.delay[qv]) || 0;
    if (ms > 0) { const tm = setTimeout(() => { try { html(res, body); } catch (e) { /* gone */ } }, ms); res.on('close', () => clearTimeout(tm)); return true; }
    return html(res, body);
  }
  if (p === '/watch') return html(res, page('Mock video ' + esc(q.get('v') || ''), '', '<h1>mock YouTube watch page</h1>'));
  return false;
}

/* ---- Disney+ ---------------------------------------------------------------------------------- */
function disneyCaptures() {
  const out = new Map();
  for (const name of ['disney-home', 'disney-changed']) {
    for (const c of fx(name).captures || []) if (!out.has(c.path)) out.set(c.path, c.json);
  }
  return out;
}
let DISNEY_CAPTURES = null;
function disney(mode, req, res, p) {
  if (!DISNEY_CAPTURES) DISNEY_CAPTURES = disneyCaptures();
  if (p === '/home') {
    if (mode === 'signed-out') return redirect(res, '/login');
    const f = fx(mode === 'changed-layout' ? 'disney-changed' : 'disney-home');
    const paths = (f.captures || []).map((c) => c.path);
    const script = '<script>(function(){var p=' + inScript(paths) + ';'
      + 'Promise.all(p.map(function(u){return fetch(u,{cache:"no-store"}).then(function(r){return r.text();},function(){return "";});}))'
      + '.then(function(){document.body.setAttribute("data-loaded",String(p.length));});})();</script>';
    return html(res, page(f.title || 'Home | Disney+', script, '<main id="app">mock Disney+ home</main>'));
  }
  if (p === '/login') {
    const f = fx('disney-signedout');
    return html(res, page(f.title || 'Log In | Disney+', '', '<a href="/login" data-testid="login-button">Log In</a>'));
  }
  if (DISNEY_CAPTURES.has(p)) return json(res, DISNEY_CAPTURES.get(p));
  if (/^\/browse\//.test(p)) return html(res, page('Mock Disney+ title', '', '<h1>mock Disney+ title</h1>'));
  return false;
}

/* ---- Prime Video ------------------------------------------------------------------------------ */
function prime(mode, req, res, p) {
  if (p === '/') {
    if (mode === 'robot') return redirect(res, '/errors/validateCaptcha');
    const f = fx(mode === 'signed-out' ? 'prime-signedout' : mode === 'changed-layout' ? 'prime-changed' : 'prime-home');
    let head = '';
    if (f.hydration) head += '<script id="dv-web-page-hydration-data" type="application/json">' + inScript(f.hydration) + '</script>';
    if (f.store) head += '<script id="dv-web-global-store-data" type="application/json">' + inScript(f.store) + '</script>';
    return html(res, page(f.title || 'Prime Video', head, '<main id="pv">mock Prime Video</main>'));
  }
  if (p === '/errors/validateCaptcha') {
    const f = fx('prime-robot');
    return html(res, page(f.title || 'Amazon.com', '',
      '<form method="get" action="/errors/validateCaptcha"><h4>Enter the characters you see below</h4>'
      + '<input id="captchacharacters" name="field-keywords" type="text"></form>'));
  }
  if (/^\/detail\//.test(p)) return html(res, page('Mock Prime title', '', '<h1>mock Prime Video title</h1>'));
  return false;
}

/* ---- ESPN ------------------------------------------------------------------------------------- */
function shifted(name) {
  const shift = (Date.now() - 40 * 60e3) - ESPN_ANCHOR;
  return fixture(name + '.json').replace(ISO_RE, (iso) => new Date(Date.parse(iso) + shift).toISOString());
}
const ESPN_LEAGUE = { 'hockey/nhl': 'espn-nhl', 'football/nfl': 'espn-nfl' };
function espn(mode, req, res, p) {
  const m = /^\/apis\/site\/v2\/sports\/(.+)\/scoreboard$/.exec(p);
  if (m) {
    if (mode === 'changed-layout') return json(res, { sportsData: { eventList: [] }, layoutV3: true });
    return json(res, shifted(ESPN_LEAGUE[m[1]] || 'espn-empty'));
  }
  if (p === '/api/product/v3/watchespn/web/home') {
    if (mode === 'changed-layout') return json(res, { pageV3: { sections: [] } });
    return json(res, shifted('espn-watch'));
  }
  return false;
}

const HANDLERS = { youtube, disney, prime, espn };

/* ---- the servers -------------------------------------------------------------------------------- */
async function start(opts) {
  const o = opts || {};
  const say = typeof o.log === 'function' ? o.log : () => {};
  const modes = {};
  const log = [];          // every request: { svc, path, url, t }
  const held = {};         // svc -> Set of held (slow) responses
  const servers = {};
  const ports = {};

  function listen(svc, port) {
    return new Promise((resolve, reject) => {
      const s = servers[svc];
      const onErr = (e) => { s.removeListener('listening', onOk); reject(e); };
      const onOk = () => { s.removeListener('error', onErr); resolve(s.address().port); };
      s.once('error', onErr);
      s.once('listening', onOk);
      s.listen(port || 0, '127.0.0.1');
    });
  }

  for (const svc of SERVICES) {
    modes[svc] = 'ok';
    held[svc] = new Set();
    servers[svc] = http.createServer((req, res) => {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      log.push({ svc, path: u.pathname, url: u.pathname + u.search, t: Date.now(), cookie: String(req.headers.cookie || '') });
      const mode = modes[svc];
      if (mode === 'slow') {
        held[svc].add(res);
        res.on('close', () => held[svc].delete(res));
        return;   // never answered
      }
      let done = false;
      try { done = HANDLERS[svc](mode, req, res, u.pathname, u.searchParams); } catch (e) { say('mock ' + svc + ' threw: ' + (e && e.message)); }
      if (!done && !res.headersSent) send(res, 404, 'text/plain', 'not in the mock: ' + u.pathname);
    });
    servers[svc].keepAliveTimeout = 2000;
    ports[svc] = await listen(svc, 0);
  }

  async function setMode(svc, mode) {
    if (!MODES[svc] || MODES[svc].indexOf(mode) === -1) throw new Error('mock: no mode ' + mode + ' for ' + svc);
    const was = modes[svc];
    if (was === mode) return;
    modes[svc] = mode;
    if (was === 'slow') for (const r of Array.from(held[svc])) { try { r.destroy(); } catch (e) { /* gone */ } }
    if (mode === 'down') {
      await new Promise((r) => { servers[svc].close(() => r()); servers[svc].closeAllConnections(); for (const h of Array.from(held[svc])) { try { h.destroy(); } catch (e) { /* gone */ } } });
    } else if (was === 'down') {
      let lastErr = null;
      for (let i = 0; i < 20; i++) {
        try { await listen(svc, ports[svc]); lastErr = null; break; } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 150)); }
      }
      if (lastErr) throw new Error('mock: ' + svc + ' could not listen on :' + ports[svc] + ' again (' + lastErr.code + ')');
    } else {
      // A mode change must not ride on a kept-alive connection from before it.
      servers[svc].closeIdleConnections();
    }
    say('mock ' + svc + ' -> ' + mode);
  }

  const origin = (svc) => 'http://127.0.0.1:' + ports[svc];
  const rebase = [];
  for (const svc of SERVICES) for (const from of ORIGINS[svc]) rebase.push([from, origin(svc)]);

  // The control server: /__mode on its own port, so it answers while a service is down.
  const control = http.createServer((req, res) => {
    const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
    if (u.pathname !== '/__mode') return send(res, 404, 'text/plain', 'no');
    const svc = u.searchParams.get('svc');
    const mode = u.searchParams.get('mode');
    if (svc && mode) {
      setMode(svc, mode).then(() => json(res, { ok: true, modes }), (e) => send(res, 400, 'application/json', JSON.stringify({ ok: false, error: e.message })));
      return true;
    }
    return json(res, { modes, ports, log: log.slice(-200) });
  });
  const controlPort = await new Promise((r) => control.listen(0, '127.0.0.1', () => r(control.address().port)));

  return {
    ports,
    controlPort,
    origin,
    rebase,
    modes: () => Object.assign({}, modes),
    setMode,
    /** YouTube /results: { tag: true } prefixes titles with [query]; { delay: { q: ms } } holds one query's answer. */
    setSearch: (o) => { SEARCH.tag = !!(o && o.tag); SEARCH.delay = Object.assign({}, (o && o.delay) || {}); },
    log,
    /** Requests to `svc` since `t` (ms), optionally only paths matching `re`. */
    hits: (svc, t, re) => log.filter((l) => l.svc === svc && l.t >= (t || 0) && (!re || re.test(l.path))).length,
    close: async () => {
      for (const svc of SERVICES) {
        for (const h of Array.from(held[svc])) { try { h.destroy(); } catch (e) { /* gone */ } }
        try { servers[svc].closeAllConnections(); servers[svc].close(); } catch (e) { /* closed */ }
      }
      try { control.close(); } catch (e) { /* closed */ }
    },
  };
}

module.exports = { start, SERVICES, MODES, ORIGINS };

if (require.main === module) {
  start({ log: (l) => console.log(l) }).then((m) => {
    console.log('watch-mock: ' + JSON.stringify(m.ports) + ' control :' + m.controlPort);
    console.log('QUARTZ_WATCH_REBASE=' + JSON.stringify(m.rebase));
  });
}
