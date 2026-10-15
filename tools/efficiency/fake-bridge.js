// tools/efficiency/fake-bridge.js -- a stand-in for the Spotify auto-pause bridge (~/spotify-autopause,
// a PowerShell TcpListener on 127.0.0.1:8787-8790) for the efficiency bench on a runner, where the
// real one does not exist. Quartz's now-playing card then does what it does on the user's machine: one
// GET /now per poll on a port that answers, instead of probing four dead ones.
//
//   node tools/efficiency/fake-bridge.js [--port=8787]
//
// Routes: /ping and /status (the bridge status shape autopause.js parses), /now (a playing track
// whose position advances; the art bytes only when the caller's artHash is not the current one,
// none for art=0). Every reply closes its connection, like the PowerShell listener.
'use strict';
const http = require('http');

const port = Number((process.argv.find((a) => a.startsWith('--port=')) || '--port=8787').slice(7));
const T0 = Date.now();
const ART = Buffer.alloc(6000, 7).toString('base64');   // a few KB, like a small cover jpeg
const ART_HASH = 'fakeart1';
let served = 0;
let nowServed = 0;
let title = 'Fake Track';

function now(query) {
  const body = {
    ok: true, source: 'Spotify.exe', title, artist: 'Bench', album: 'Runner',
    status: 'playing', positionMs: (Date.now() - T0) % 200000, durationMs: 200000,
    canNext: true, canPrev: true, canPlayPause: true, artHash: ART_HASH,
  };
  const art = query.get('art');
  const have = query.get('artHash');
  if (art !== '0' && have !== ART_HASH) body.art = ART;
  return body;
}

const server = http.createServer((req, res) => {
  served++;
  const u = new URL(req.url, 'http://127.0.0.1');
  let body;
  if (u.pathname === '/ping' || u.pathname === '/status') {
    body = { ok: true, port, version: 'fake-bench', spotifyFound: true, spotifyState: 'playing', heldByUs: false, holds: [] };
  } else if (u.pathname === '/now') { nowServed++; body = now(u.searchParams); }
  else if (u.pathname === '/config') body = { ok: true, adDuck: { enabled: false, level: 0 } };
  // Test-only routes (media-e2e.js): how many requests so far, and change the track's title.
  else if (u.pathname === '/__count') body = { ok: true, served, nowServed };
  else if (u.pathname === '/__set') { title = u.searchParams.get('title') || title; body = { ok: true, title }; }
  else body = { ok: false, reason: 'unknown route' };
  const text = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), connection: 'close' });
  res.end(text);
});
server.listen(port, '127.0.0.1', () => console.log('fake-bridge: listening on ' + port));
setInterval(() => console.log('fake-bridge: ' + served + ' requests'), 30000);
