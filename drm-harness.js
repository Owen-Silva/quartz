// drm-harness.js -- pure-node tests for drm-sites.js and drm-main.js (run: node drm-harness.js).
// No Electron, no Edge: drm-main gets a fake ipcMain, a fake spawn and a temp userData folder.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const S = require('./drm-sites');
const DrmMain = require('./drm-main');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
const site = (u, extra) => { const s = S.siteForUrl(u, extra); return s ? s.id : null; };

// ---- known streaming services, by address -------------------------------------------------------
const yes = {
  'https://www.primevideo.com/': 'prime',
  'https://www.primevideo.com/detail/0ABCDEF/ref=atv': 'prime',
  'https://primevideo.com/region/eu/storefront': 'prime',
  'https://www.amazon.com/gp/video/detail/B0B8TR9Q5Z/': 'prime',
  'https://www.amazon.com/gp/video/storefront': 'prime',
  'https://www.amazon.co.uk/gp/video/detail/B0X': 'prime',
  'https://www.amazon.com.au/gp/video/storefront/': 'prime',
  'https://www.amazon.de/Prime-Video/b?node=3010075031': 'prime',
  'https://www.amazon.com/Amazon-Video/b?node=2858778011': 'prime',
  'https://www.netflix.com/browse': 'netflix',
  'https://netflix.com/watch/81234567': 'netflix',
  'https://www.disneyplus.com/en-gb/home': 'disney',
  'https://play.max.com/video/watch/abc': 'max',
  'https://play.hbomax.com/': 'max',
  'https://www.hulu.com/watch/123': 'hulu',
  'https://tv.apple.com/us/show/severance': 'appletv',
  'https://music.apple.com/us/album/1': 'applemusic',
  'https://www.peacocktv.com/watch/playback': 'peacock',
  'https://www.paramountplus.com/shows/': 'paramount',
  'https://open.spotify.com/track/1': 'spotify',
  'https://tv.youtube.com/welcome/': 'youtubetv',
  'https://www.crunchyroll.com/watch/G1': 'crunchyroll',
  'https://WWW.NETFLIX.COM./browse': 'netflix',
};
for (const [u, id] of Object.entries(yes)) eq('site ' + u, site(u), id);

// ---- never a bar: plain video sites, the rest of Amazon, lookalikes, non-web ---------------------
const no = [
  'https://www.youtube.com/', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=x',
  'https://music.youtube.com/', 'https://youtu.be/dQw4w9WgXcQ',
  'https://www.twitch.tv/', 'https://www.twitch.tv/videos/1', 'https://clips.twitch.tv/x',
  'https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871',
  'https://www.amazon.com/', 'https://www.amazon.com/dp/B0CHX1W1XY', 'https://www.amazon.com/s?k=gp/video',
  'https://www.amazon.com/gp/videogames', 'https://aws.amazon.com/gp/video/', 'https://amazon.evil.com/gp/video/',
  'https://netflix.com.evil.example/', 'https://notnetflix.com/', 'https://fakeprimevideo.com/',
  'https://spotify.com/', 'https://www.spotify.com/us/premium/', 'https://apple.com/tv', 'https://www.apple.com/apple-tv-plus/',
  'https://developer.apple.com/', 'https://www.google.com/search?q=netflix.com',
  'file:///C:/netflix.com/index.html', 'about:blank', 'javascript:alert(1)', '', null, 42,
  'http://127.0.0.1:8080/needs.html',
];
for (const u of no) eq('no site ' + u, site(u), null);

// ---- key systems ----------------------------------------------------------------------------------
eq('widevine protected', S.isProtectedKeySystem('com.widevine.alpha'), true);
eq('playready protected', S.isProtectedKeySystem('com.microsoft.playready.recommendation'), true);
eq('fairplay protected', S.isProtectedKeySystem('com.apple.fps.1_0'), true);
eq('clearkey not protected', S.isProtectedKeySystem('org.w3.clearkey'), false);
eq('junk not protected', S.isProtectedKeySystem('com.widevine.alphaX'), false);
eq('non-string not protected', S.isProtectedKeySystem({ toString: () => 'com.widevine.alpha' }), false);
eq('family widevine', S.keySystemFamily('com.widevine.alpha'), 'Widevine');
eq('family playready', S.keySystemFamily('com.microsoft.playready'), 'PlayReady');

// ---- the behaviour verdict: a refusal alone is a probe ----------------------------------------------
const v = (seen) => S.emeVerdict(seen).need;
eq('nothing seen', v({}), false);
eq('probe only (YouTube/Twitch style)', v({ denied: ['com.widevine.alpha'] }), false);
eq('encrypted but nothing refused', v({ encrypted: true }), false);
eq('clearkey refused + encrypted', v({ denied: ['org.w3.clearkey'], encrypted: true }), false);
eq('widevine refused + encrypted', v({ denied: ['com.widevine.alpha'], encrypted: true }), true);
eq('granted wins (a build with Widevine)', v({ denied: ['com.microsoft.playready'], granted: ['com.widevine.alpha'], encrypted: true }), false);
eq('null seen', v(null), false);

// ---- rule keys and words ----------------------------------------------------------------------------
eq('rule prime', S.ruleKeyFor('https://www.amazon.com/gp/video/detail/X'), 'prime');
eq('rule host', S.ruleKeyFor('https://www.example.org/watch'), 'host:example.org');
eq('rule host with port', S.ruleKeyFor('http://127.0.0.1:8080/x'), 'host:127.0.0.1');
eq('rule none', S.ruleKeyFor('about:blank'), '');
eq('rule name prime', S.ruleKeyName('prime'), 'Prime Video');
eq('rule name host', S.ruleKeyName('host:example.org'), 'example.org');
eq('isRuleKey prime', S.isRuleKey('prime'), true);
eq('isRuleKey host', S.isRuleKey('host:example.org'), true);
eq('isRuleKey junk', S.isRuleKey('host:exa mple'), false);
eq('isRuleKey unknown id', S.isRuleKey('nope'), false);
const extra = [{ id: 'test', name: 'Test Stream', exact: ['localhost'] }];
eq('extra site', site('http://localhost:5555/x', extra), 'test');
eq('extra site not without extra', site('http://localhost:5555/x'), null);
eq('isRuleKey extra', S.isRuleKey('test', extra), true);
eq('bar text known', S.barText('Prime Video'), 'Prime Video uses DRM-protected video, which Quartz can\u2019t play yet.');
eq('bar text unknown', S.barText(''), 'This page uses DRM-protected video, which Quartz can\u2019t play yet.');
eq('edge url ok', S.edgeUrlOk('https://www.primevideo.com/'), true);
eq('edge url not file', S.edgeUrlOk('file:///C:/x'), false);
eq('edge url not flag', S.edgeUrlOk('--gpu-launcher=calc'), false);

// ---- drm-main.js ------------------------------------------------------------------------------------
function fakeIpc() {
  const on = {}, handle = {};
  return { on: (c, f) => { on[c] = f; }, handle: (c, f) => { handle[c] = f; }, _on: on, _handle: handle };
}
const CHROME = { id: 1, getURL: () => 'file:///index.html' };
const GUEST = { id: 7, getURL: () => 'https://example.org/watch' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drm-harness-'));
function make(extraOpts) {
  const ipc = fakeIpc();
  const sent = [];
  const spawned = [];
  const m = DrmMain.create(Object.assign({
    app: { getPath: () => tmp },
    ipcMain: ipc,
    isChromeSender: (e) => e.sender === CHROME,
    send: (c, p) => sent.push([c, p]),
    env: { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF' },
    exists: (p) => p === path.join('C:\\PF86', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    spawn: (exe, args, o) => {
      spawned.push({ exe, args, o });
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('spawn'));
      return child;
    },
  }, extraOpts || {}));
  return { m, ipc, sent, spawned };
}

(async () => {
  let t = make();
  eq('edge found in Program Files (x86)', t.m.edge(), { found: true, path: path.join('C:\\PF86', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), how: 'msedge' });
  eq('stock electron: no widevine', t.m.widevine().available, false);

  let r = await t.m.openInEdge('https://www.primevideo.com/detail/X');
  eq('launch ok', r.ok, true);
  eq('launch args: one URL, nothing else', t.spawned[0].args, ['https://www.primevideo.com/detail/X']);
  eq('launch detached', t.spawned[0].o.detached, true);
  r = await t.m.openInEdge('file:///C:/Windows/System32/calc.exe');
  eq('file url refused', r.ok, false);
  r = await t.m.openInEdge('--renderer-cmd-prefix=calc');
  eq('flag-shaped url refused', r.ok, false);
  eq('refused urls never spawn', t.spawned.length, 1);

  // spawn error -> the reason comes back
  t = make({ spawn: () => { const c = new EventEmitter(); c.unref = () => {}; setImmediate(() => c.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))); return c; } });
  r = await t.m.openInEdge('https://www.netflix.com/');
  eq('spawn error reported', [r.ok, r.reason], [false, 'Edge could not be started (ENOENT)']);
  eq('last launch kept for Settings', t.m.state().lastLaunch.ok, false);

  // no msedge.exe: the protocol fallback through shell
  const opened = [];
  t = make({ exists: () => false, shell: { openExternal: (u) => { opened.push(u); return Promise.resolve(); } } });
  r = await t.m.openInEdge('https://www.hulu.com/');
  eq('protocol fallback', [r.ok, r.how, opened[0]], [true, 'protocol', 'microsoft-edge:https://www.hulu.com/']);
  t = make({ exists: () => false });
  r = await t.m.openInEdge('https://www.hulu.com/');
  eq('no edge at all', [r.ok, r.reason], [false, 'Microsoft Edge was not found on this PC']);

  // the stub (test profiles): writes the URL, never spawns
  const stub = path.join(tmp, 'edge-stub.txt');
  t = make({ edgeStub: stub });
  r = await t.m.openInEdge('https://www.disneyplus.com/');
  eq('stub ok', r.ok, true);
  eq('stub wrote', fs.readFileSync(stub, 'utf8'), 'https://www.disneyplus.com/\n');
  eq('stub never spawns', t.spawned.length, 0);
  fs.writeFileSync(stub + '.fail', '');
  r = await t.m.openInEdge('https://www.disneyplus.com/');
  eq('stub failure', [r.ok, r.reason], [false, 'Edge did not start (test failure)']);
  fs.unlinkSync(stub + '.fail');

  // rules: stored, validated, pushed, persisted
  t = make();
  r = t.m.setAlways('prime', true);
  eq('always on', [r.ok, r.state.alwaysEdge], [true, [{ key: 'prime', name: 'Prime Video' }]]);
  eq('pushed drm:changed', t.sent.some(([c]) => c === 'drm:changed'), true);
  eq('saved to drm.json', JSON.parse(fs.readFileSync(path.join(tmp, 'drm.json'), 'utf8')), { alwaysEdge: ['prime'] });
  r = t.m.setAlways('nonsense key', true);
  eq('junk key refused', r.ok, false);
  const t2 = make();
  eq('read back on a new start', t2.m.state().alwaysEdge.map((x) => x.key), ['prime']);
  r = t2.m.setAlways('prime', false);
  eq('always off', r.state.alwaysEdge, []);

  // IPC: the gate, and the guest's report forwarded with its webContents id
  t = make();
  eq('state refused to a guest', await t.ipc._handle['drm:state']({ sender: GUEST }), null);
  eq('edge refused to a guest', (await t.ipc._handle['drm:open-in-edge']({ sender: GUEST }, { url: 'https://x.org/' })).ok, false);
  eq('always refused to a guest', t.ipc._handle['drm:set-always']({ sender: GUEST }, { key: 'prime', on: true }).ok, false);
  t.ipc._on['drm:eme']({ sender: GUEST }, { kind: 'request', keySystem: 'com.widevine.alpha', granted: false });
  t.ipc._on['drm:eme']({ sender: GUEST }, { kind: 'request', keySystem: 'org.w3.clearkey', granted: false });
  t.ipc._on['drm:eme']({ sender: GUEST }, { kind: 'encrypted', initDataType: 'webm' });
  t.ipc._on['drm:eme']({ sender: CHROME }, { kind: 'encrypted', initDataType: 'webm' });
  t.ipc._on['drm:eme']({ sender: GUEST }, { kind: 'evil' });
  const sig = t.sent.filter(([c]) => c === 'drm:signal').map(([, p]) => p);
  eq('signals forwarded (protected request + encrypted only, never from the chrome)', sig, [
    { kind: 'request', keySystem: 'com.widevine.alpha', granted: false, wcId: 7, url: 'https://example.org/watch' },
    { kind: 'encrypted', initDataType: 'webm', wcId: 7, url: 'https://example.org/watch' },
  ]);
  t.ipc._on['drm:hook']({ sender: GUEST }, { ok: false, result: 'failed' });
  eq('hook trouble surfaces in state', /could not start \(failed\)/.test(t.m.state().detection), true);

  // a castlabs-style build: components report Widevine
  t = make({ electron: { components: { status: () => ({ oimompecagnajdejgnnjijobebaeigek: { title: 'Widevine Content Decryption Module', status: 'updated', version: '4.10.2830.0' } }) } } });
  eq('castlabs widevine available', t.m.widevine().available, true);
  t = make({ electron: { components: { status: () => ({}) } } });
  eq('castlabs, not downloaded', t.m.widevine().available, false);

  // preload registration: refused cleanly on a session without the API
  t = make({ session: { defaultSession: {} } });
  t.m.start();
  eq('no session preload support said', /no session preload support/.test(t.m.state().detection), true);
  const reg = [];
  t = make({ session: { defaultSession: { registerPreloadScript: (o) => { reg.push(o); return 'id1'; } } } });
  t.m.start();
  eq('preload registered as a frame preload', [reg[0].type, path.basename(reg[0].filePath)], ['frame', 'drm-preload.js']);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`drm-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('HARNESS ERROR ' + (e && e.stack || e)); console.log(`drm-test: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
