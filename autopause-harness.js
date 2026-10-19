'use strict';
// autopause-harness.js -- Quartz's Spotify auto-pause (autopause.js + autopause-smtc.js), pure node:
// no Electron, no real Spotify, no real 8787-8790 (every port is a free one picked here), no real
// PowerShell (the helper is a fake child), and never the real userData (a temp dir).
//
//   node autopause-harness.js          this file's checks         -> "AUTOPAUSE: N passed, M failed"
//   node autopause-harness.js --link   the shared protocol test (autopause-link-harness.js, kept
//                                      byte-identical with Mantle's), its summary re-printed in the
//                                      "<name>: N passed, M failed" form tools/run-suite.js reads.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const EventEmitter = require('events');
const { spawn } = require('child_process');

if (process.argv.includes('--link')) {
  const child = spawn(process.execPath, [path.join(__dirname, 'autopause-link-harness.js')], { cwd: __dirname, windowsHide: true });
  let out = '';
  child.stdout.on('data', (c) => { out += c; process.stdout.write(c); });
  child.stderr.on('data', (c) => process.stderr.write(c));
  child.on('close', (code) => {
    const m = /AUTOPAUSE-LINK (\d+) passed, (\d+) failed/.exec(out);
    if (!m) { console.log('autopause-link: 0 passed, 1 failed'); process.exit(1); }
    console.log(`autopause-link: ${m[1]} passed, ${m[2]} failed`);
    process.exit(code === 0 && m[2] === '0' ? 0 : 1);
  });
  return;
}

const ap = require('./autopause');
const { createSmtc, SCRIPT } = require('./autopause-smtc');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) pass += 1;
  else { fail += 1; console.log('FAIL ' + name); }
}
const J = (x) => JSON.stringify(x);
const settle = async (n) => { for (let i = 0; i < (n || 20); i += 1) await new Promise((r) => setImmediate(r)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function getJson(port, route) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: route, agent: false }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

/** Virtual time for the hold machine, the mute poll and the engine tick. */
function vclock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const api = {
    now: () => t,
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: t + ms, every: 0 }); return seq; },
    clearTimer: (id) => { timers.delete(id); },
    setRepeat: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: t + ms, every: ms }); return seq; },
    clearRepeat: (id) => { timers.delete(id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let best = null;
        for (const [id, x] of timers) if (x.at <= end && (!best || x.at < best[1].at)) best = [id, x];
        if (!best) break;
        const [id, x] = best;
        t = x.at;
        if (x.every) x.at = t + x.every; else timers.delete(id);
        x.fn();
        await settle();
      }
      t = end;
      await settle();
    },
    count: () => timers.size,
  };
  return api;
}

/** A Spotify behind a fake media-session helper (the shape autopause-smtc.js returns). */
function fakeSmtc(sp) {
  let last = null;
  const f = {
    calls: [],
    stops: 0,
    async state() {
      f.calls.push('state');
      const sessions = sp.present ? [{
        aumid: 'Spotify.exe', status: sp.status, title: 'Track', artist: 'Artist', album: 'Album',
        positionMs: 61000, durationMs: 200000, can: { play: true, pause: true, toggle: true, next: true, previous: false },
      }] : [];
      last = { ok: true, current: sp.present ? 'Spotify.exe' : '', sessions, at: Date.now() };
      return last;
    },
    last: () => last,
    async control(action, aumid) {
      f.calls.push(action + ':' + aumid);
      if (sp.test) return { ok: true, sent: false, dryRun: true };
      if (action === 'pause') sp.status = 'Paused';
      if (action === 'play') sp.status = 'Playing';
      sp.sent.push(action);
      return { ok: true, sent: true };
    },
    stop() { f.stops += 1; return Promise.resolve(); },
    running: () => false,
    stats: () => ({ spawns: 0, crashes: 0, timeouts: 0, badLines: 0, requests: f.calls.length }),
  };
  return f;
}

/** A guest <webview>'s webContents, as far as watchGuest looks. */
function fakeGuest(id, url) {
  const g = new EventEmitter();
  g.id = id;
  g.url = url;
  g.muted = false;
  g.audible = false;
  g.getURL = () => g.url;
  g.isAudioMuted = () => g.muted;
  g.isCurrentlyAudible = () => g.audible;
  g.isDestroyed = () => false;
  g.play = (on) => { g.audible = !!on; g.emit('audio-state-changed', { audible: !!on }); };
  return g;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-autopause-'));
let tmpN = 0;
const tmpFile = (name) => { tmpN += 1; return path.join(TMP, `${tmpN}-${name}`); };
const nullGet = async () => null;

/* A profile saved before this change, field for field: the old defaults with three sites of its
 * own that are not defaults now (it keeps them), browserHold off; and its legacy task, disabled at the task level (<Settings><Enabled>false</Enabled>) while a trigger stays enabled. */
const OWN_SITES = ['youtube.com', 'youtube-nocookie.com', 'twitch.tv', 'kick.com', 'vimeo.com', 'dailymotion.com', 'tiktok.com',
  'netflix.com', 'hulu.com', 'disneyplus.com', 'primevideo.com', 'max.com', 'peacocktv.com', 'crunchyroll.com',
  'lessons.example.com', 'classroom.example.org', 'tutor.example.net'];
const OWN_FILE = { browserHold: false, anySite: false, sites: OWN_SITES, sitesBase: OWN_SITES, directEnabled: false };
const EXTRA = ['lessons.example.com', 'classroom.example.org', 'tutor.example.net'];   // saved sites outside the defaults
function taskXml(enabled) {
  const xml = '<?xml version="1.0" encoding="UTF-16"?>\r\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\r\n' +
    '  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>\r\n' +
    `  <Settings>\r\n    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\r\n    <Enabled>${enabled}</Enabled>\r\n  </Settings>\r\n</Task>\r\n`;
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}
function writeTask(enabled) { const f = tmpFile('SpotifyAutoPause'); fs.writeFileSync(f, taskXml(enabled)); return f; }
function writeJson(obj) { const f = tmpFile('autopause.json'); fs.writeFileSync(f, JSON.stringify(obj, null, 2)); return f; }

(async () => {
  // ---------------------------------------------------------------- defaults
  {
    ok(J(ap.DEFAULT_SITES) === J(OWN_SITES.slice(0, 14)), `defaults: exactly the 14 neutral video sites (${ap.DEFAULT_SITES.length})`);
    ok(J(ap.LEGACY_BASE_SITES) === J(['youtube.com', 'youtube-nocookie.com']), 'defaults: the legacy base is the two YouTube hosts only');
    ok(ap.DEFAULT_CONFIG.enabled === true && ap.DEFAULT_CONFIG.browserHold === true, 'defaults: enabled and browserHold on for a fresh profile');
    ok(ap.BRIDGE_SRC === 'quartz', `defaults: holds go out as src=quartz (${ap.BRIDGE_SRC})`);
    ok(ap.taskStateFromXml(ap.decodeTaskXml(taskXml(false))) === 'disabled', 'task xml: <Settings><Enabled>false is disabled (a trigger\'s true does not count)');
    ok(ap.taskStateFromXml(ap.decodeTaskXml(taskXml(true))) === 'enabled', 'task xml: enabled');
    ok(ap.taskStateFromXml('not xml') === 'unknown', 'task xml: junk is unknown');
    ok(ap.readLegacyTask(path.join(TMP, 'no-such-task')) === 'absent', 'task file: missing is absent');
  }

  // ------------------------------------------------- (a) the existing profile
  {
    const cfgFile = writeJson(OWN_FILE);
    const taskFile = writeTask(false);
    let linkCalls = 0;
    const sp = { present: true, status: 'Playing', sent: [] };
    const sm = fakeSmtc(sp);
    const port = await freePort();
    const inst = ap.create({ configFile: cfgFile, taskFile, smtc: sm, get: nullGet, ports: [port], linkGet: async () => { linkCalls += 1; return { code: 0 }; } });
    await sleep(60);
    const cfg = inst._config();
    ok(cfg.enabled === false && cfg.browserHold === false, `existing profile: enabled=false, browserHold=false (${cfg.enabled}/${cfg.browserHold})`);
    ok(EXTRA.every((s) => cfg.sites.includes(s)) && cfg.sites.length === 17, `existing profile: its saved sites are kept, non-default ones included (${cfg.sites.length})`);
    ok(!inst._linkOn() && linkCalls === 0 && !inst._compat.running(), `existing profile: the link never starts, no probe, no port (${inst._linkOn()} ${linkCalls})`);
    ok(sm.calls.length === 0, `existing profile: no media-session helper (${J(sm.calls)})`);
    const seeded = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    ok(seeded.enabled === false && seeded.browserHold === false && EXTRA.every((s) => seeded.sites.includes(s)) && seeded.directEnabled === false,
      `existing profile: enabled=false is written down once, nothing else lost (${J({ e: seeded.enabled, b: seeded.browserHold, n: seeded.sites.length })})`);
    const st = await inst.status();
    const keys = ['installed', 'enabled', 'bridge', 'role', 'port', 'spotify', 'wePaused', 'holds', 'browserHold', 'audibleTabs', 'config', 'error'];
    ok(keys.every((k) => k in st), `status: every field settings.js reads, plus role (${Object.keys(st).join(',')})`);
    ok(st.installed === true && st.enabled === false && st.bridge === 'stopped' && st.role === 'off' && st.config.browserHold === false,
      `status: installed, off, stopped (${J({ i: st.installed, e: st.enabled, b: st.bridge, r: st.role })})`);
    // A tab plays: with browserHold off it counts for nothing.
    const g = fakeGuest(1, 'https://www.youtube.com/watch?v=x');
    inst.watchGuest(g);
    g.play(true);
    await sleep(1700);
    ok(inst._machine.playing === 0 && !inst._machine.holding && sm.calls.length === 0 && sp.sent.length === 0, 'existing profile: a playing tab holds nothing');
    ok(inst.handleQuit({ preventDefault() {} }) === false, 'existing profile: quit is not delayed');
    // Seeded once: the file's value wins over the task from now on.
    const again = ap.create({ configFile: cfgFile, taskFile: writeTask(true), smtc: fakeSmtc(sp), get: nullGet, ports: [port], autoStart: false });
    ok(again._config().enabled === false, 'existing profile: the written value wins over a later task state');
    // The sites survive a write round trip (sitesBase moves to the new defaults; the list stays 17).
    await again.setConfig({ anySite: false });
    const rt = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    const third = ap.create({ configFile: cfgFile, taskFile, smtc: fakeSmtc(sp), get: nullGet, ports: [port], autoStart: false });
    ok(rt.sitesBase.length === 14 && third._config().sites.length === 17 && EXTRA.every((s) => third._config().sites.includes(s)), 'existing profile: its non-default sites survive a rewrite');
  }

  // ------------------------------------------------- (b), (c) and the other migrations
  {
    const mk = (cfg, task) => {
      const configFile = cfg === null ? tmpFile('none.json') : writeJson(cfg);
      const taskFile = task === null ? path.join(TMP, 'no-task-' + tmpN) : writeTask(task);
      return { inst: ap.create({ configFile, taskFile, smtc: fakeSmtc({ present: false, sent: [] }), get: nullGet, ports: [], autoStart: false }), configFile };
    };
    const b = mk(null, null);
    ok(b.inst._config().enabled === true && b.inst._config().browserHold === true, '(b) no file, no task: enabled');
    ok(!fs.existsSync(b.configFile), '(b) no file: nothing written until a change');
    ok(mk(null, true).inst._config().enabled === true, '(c) no file, task enabled: enabled');
    ok(mk(null, false).inst._config().enabled === false, 'no file, task disabled: off');
    ok(mk({ browserHold: true, directEnabled: false, sites: ['youtube.com'] }, null).inst._config().enabled === false, 'file without enabled, no task: directEnabled=false stays off');
    ok(mk({ browserHold: true, directEnabled: true }, null).inst._config().enabled === true, 'file without enabled, no task: directEnabled=true is on');
    ok(mk({ enabled: true }, false).inst._config().enabled === true, 'a file with enabled keeps it');
    const legacy = mk({ sites: ['youtube.com', 'lessons.example.com'] }, null).inst._config().sites;
    ok(legacy.includes('twitch.tv') && legacy.includes('lessons.example.com') && !legacy.includes('tutor.example.net'),
      `a list written before sitesBase: new defaults merged in, its own sites kept, nothing else added (${legacy.length})`);
  }

  // ------------------------------------------------- hosting: hold machine -> link.setHeld -> engine -> Spotify
  {
    const port = await freePort();
    const vc = vclock();
    const sp = { present: true, status: 'Playing', sent: [] };
    const sm = fakeSmtc(sp);
    let quits = 0;
    const inst = ap.create({
      app: { quit: () => { quits += 1; }, getPath: () => TMP },
      configFile: tmpFile('host.json'), taskFile: path.join(TMP, 'no-task-host'), smtc: sm, get: nullGet, ports: [port],
      setTimer: vc.setTimer, clearTimer: vc.clearTimer, setRepeat: vc.setRepeat, clearRepeat: vc.clearRepeat, autoStart: false,
    });
    await inst._syncLink('test');
    ok(inst._link.role() === 'host' && inst._link.port() === port && inst._compat.running(), `host: alone, Quartz hosts on the given port (${inst._link.role()} ${inst._link.port()})`);
    ok(sm.calls.length === 0 && !inst._ticking(), 'host: idle, no helper and no tick');
    await inst.status();   // the settings pane's read freshens Spotify's state
    const ping = await getJson(port, '/ping');
    ok(ping && ping.app === 'spotify-autopause' && ping.server === 'quartz' && ping.protocol === 2, `host: /ping speaks protocol 2 as quartz (${ping && ping.server})`);
    ok(ping && ping.spotifyFound === true && ping.spotifyState === 'playing', `adapter: 'Playing' reads as playing (${ping && ping.spotifyState})`);
    const g = fakeGuest(7, 'https://m.youtube.com/watch?v=y');
    inst.watchGuest(g);
    g.play(true);
    await vc.advance(1499);
    ok(!inst._link.held() && sp.sent.length === 0, 'hold machine: no hold before 1.5 s of sound');
    await vc.advance(1);
    await settle(40);
    ok(inst._link.held() && J(sp.sent) === J(['pause']), `hold machine: at 1.5 s link.setHeld(true) and Spotify pauses (${J(sp.sent)})`);
    let st = await inst.status();
    ok(st.role === 'host' && st.bridge === 'running' && st.wePaused === true && st.browserHold === true && J(st.holds) === J(['quartz']) && st.port === port,
      `status while hosting: ${J({ r: st.role, b: st.bridge, w: st.wePaused, h: st.holds })}`);
    ok(inst._ticking(), 'host: the engine ticks while it holds');
    const now = await getJson(port, '/now');
    ok(now && now.status === 'paused' && now.title === 'Track' && now.positionMs === 61000 && now.durationMs === 200000 && now.canNext === true && now.canPrev === false && now.held === true,
      `adapter: /now maps the helper's session (${J(now && { s: now.status, p: now.positionMs, n: now.canNext, h: now.held })})`);
    const ctl = await getJson(port, '/control?cmd=play');
    ok(ctl && ctl.ok === false && ctl.reason === 'held', 'host: play from the card is refused while held');
    // Muted: the tab stops counting, and after 1.5 s the hold goes and Spotify resumes.
    g.muted = true;
    await vc.advance(500);
    ok(inst._machine.playing === 0, 'mute poll: a muted tab stops counting');
    await vc.advance(1500);
    await settle(40);
    ok(!inst._link.held() && J(sp.sent) === J(['pause', 'play']), `hold machine: 1.5 s of silence -> link.setHeld(false), Spotify resumes (${J(sp.sent)})`);
    await vc.advance(1000);
    ok(!inst._ticking(), 'host: the tick stops when nothing holds');
    // A hold over HTTP (another app) while hosting, then quit: Spotify is handed back before Quartz goes.
    g.muted = false;
    await vc.advance(500);
    await vc.advance(1500);
    await settle(40);
    ok(J(sp.sent) === J(['pause', 'play', 'pause']), `host: the tab pauses it again (${J(sp.sent)})`);
    const doc = await inst.doctor();
    ok(doc && doc.json && doc.json.role === 'host' && /host on port/.test(doc.text) && typeof doc.ok === 'boolean', `doctor: built from the link and engine (${doc && doc.json && doc.json.role})`);
    let prevented = 0;
    const deferred = inst.handleQuit({ preventDefault() { prevented += 1; } });
    await sleep(100);
    await settle(40);
    ok(deferred === true && prevented === 1 && quits === 1, `quit: deferred once, then quits (${deferred} ${prevented} ${quits})`);
    ok(J(sp.sent) === J(['pause', 'play', 'pause', 'play']) && !inst._compat.running(), `quit: Spotify is handed back and the port closes (${J(sp.sent)})`);
    ok(inst.handleQuit({ preventDefault() { prevented += 1; } }) === false && prevented === 1, 'quit: the second before-quit goes straight through');
  }

  // ------------------------------------------------- two apps: one hosts, the other is its client
  {
    const port = await freePort();
    const spH = { present: true, status: 'Playing', sent: [] };
    const spC = { present: true, status: 'Playing', sent: [] };
    const host = ap.create({ configFile: tmpFile('h.json'), taskFile: path.join(TMP, 'no-task-h'), smtc: fakeSmtc(spH), get: nullGet, ports: [port], autoStart: false });
    await host._syncLink('test');
    const vc = vclock();
    const cl = ap.create({ configFile: tmpFile('c.json'), taskFile: path.join(TMP, 'no-task-c'), smtc: fakeSmtc(spC), get: nullGet, ports: [port], autoStart: false,
      setTimer: vc.setTimer, clearTimer: vc.clearTimer, setRepeat: vc.setRepeat, clearRepeat: vc.clearRepeat });
    await cl._syncLink('test');
    ok(host._link.role() === 'host' && cl._link.role() === 'client' && !cl._compat.running(), `both: one host, one client (${host._link.role()}/${cl._link.role()})`);
    const g = fakeGuest(3, 'https://www.twitch.tv/x');
    cl.watchGuest(g);
    g.play(true);
    await vc.advance(1500);
    await sleep(150);
    ok(J(spH.sent) === J(['pause']) && spC.sent.length === 0, `both: the client's tab is paused by the host only (${J(spH.sent)}/${J(spC.sent)})`);
    const st = await cl.status();
    ok(st.role === 'client' && st.bridge === 'running' && st.port === port && st.holds.includes('quartz'), `both: the client's status shows the host's holds (${J(st.holds)})`);
    g.play(false);
    await vc.advance(1500);
    await sleep(150);
    ok(J(spH.sent) === J(['pause', 'play']), `both: and the host resumes it (${J(spH.sent)})`);
    await cl._link.stop();
    await host._link.stop();
  }

  // ------------------------------------------------- adapter mapping: absent, closed, and only the host sees Spotify
  {
    const port = await freePort();
    const sp = { present: false, status: 'Playing', sent: [] };
    const inst = ap.create({ configFile: tmpFile('a.json'), taskFile: path.join(TMP, 'no-task-a'), smtc: fakeSmtc(sp), get: nullGet, ports: [port], autoStart: false });
    await inst._syncLink('test');
    let ping = await getJson(port, '/ping');
    await getJson(port, '/pause?src=other');
    ping = await getJson(port, '/ping');
    ok(ping && ping.spotifyFound === false && ping.spotifyState === 'none', `adapter: no Spotify session reads as none (${ping && ping.spotifyState})`);
    sp.present = true; sp.status = 'Closed';
    await getJson(port, '/resume?src=other');
    await getJson(port, '/pause?src=other');
    ping = await getJson(port, '/ping');
    ok(ping && ping.spotifyState === 'none' && sp.sent.length === 0, `adapter: a closed session reads as none (${ping && ping.spotifyState})`);
    await inst.setEnabled(false);   // browserHold still on: the link stays, as a non-host
    ok(inst._link.role() === 'none' && !inst._compat.running(), `switch off: Quartz stops hosting (${inst._link.role()})`);
    sp.status = 'Playing';
    const r = await inst._engine.addHold('x', { native: false }, Date.now());
    ok(r.action === 'no-spotify' && sp.sent.length === 0, `adapter: a non-host engine sees no Spotify (${r.action})`);
    await inst.setConfig({ browserHold: false });
    ok(!inst._linkOn(), 'both switches off: the link stops');
    await inst._link.stop();
  }

  // ------------------------------------------------- test mode never controls, never reaches 8787-8790
  {
    const kids = [];
    const fakeSpawn = (cmd, args) => {
      const c = new EventEmitter();
      c.pid = 4242; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.writes = [];
      c.stdin = {
        write(s) {
          c.writes.push(s);
          const q = JSON.parse(s);
          const reply = q.op === 'state'
            ? { id: q.id, ok: true, current: 'Spotify.exe', sessions: [{ aumid: 'Spotify.exe', status: 'playing', title: 't', artist: '', album: '', positionMs: 0, durationMs: 0, can: {} }] }
            : { id: q.id, ok: true, sent: true };
          setImmediate(() => c.stdout.emit('data', JSON.stringify(reply) + '\n'));
        },
        end() { setImmediate(() => c.emit('exit', 0)); },
      };
      c.kill = () => setImmediate(() => c.emit('exit', null));
      kids.push({ cmd, args, c });
      return c;
    };
    const smtc = createSmtc({ test: true, spawn: fakeSpawn });
    const noPort = ap.create({ test: true, env: {}, configFile: tmpFile('t.json'), taskFile: path.join(TMP, 'no-task-t'), smtc, get: nullGet, autoStart: false });
    await noPort._syncLink('test');
    ok(noPort._link.role() === 'none' && !noPort._compat.running(), `test mode, no port named: never hosts, never a client (${noPort._link.role()})`);
    await noPort._link.stop();
    const port = await freePort();
    const vc = vclock();
    const named = ap.create({ test: true, env: { QUARTZ_AUTOPAUSE_PORT: String(port) }, configFile: tmpFile('t2.json'), taskFile: path.join(TMP, 'no-task-t2'), smtc,
      get: nullGet, autoStart: false, setTimer: vc.setTimer, clearTimer: vc.clearTimer, setRepeat: vc.setRepeat, clearRepeat: vc.clearRepeat });
    await named._syncLink('test');
    ok(named._link.role() === 'host' && named._link.port() === port, `test mode, port named: hosts on that port only (${named._link.port()})`);
    const g = fakeGuest(9, 'https://www.youtube.com/');
    named.watchGuest(g);
    g.play(true);
    await vc.advance(1500);
    await settle(60);
    await sleep(30);
    const snap = named._engine.snapshot(Date.now());
    const ops = kids.flatMap((k) => k.c.writes.map((w) => JSON.parse(w).op));
    ok(named._link.held() && snap.wePaused === true, `test mode: the rules still run (a simulated pause) (${snap.wePaused})`);
    ok(ops.length > 0 && !ops.includes('control'), `test mode: the helper is only ever asked to read (${J(ops)})`);
    await getJson(port, '/control?cmd=next');
    const ops2 = kids.flatMap((k) => k.c.writes.map((w) => JSON.parse(w).op));
    ok(!ops2.includes('control'), 'test mode: the card\'s buttons send nothing either');
    named.handleQuit({ preventDefault() {} });
    await sleep(100);
    await smtc.stop();
  }

  // ------------------------------------------------- autopause-smtc.js against a fake child
  {
    const vc = vclock();
    const kids = [];
    let mode = 'reply';
    const fakeSpawn = (cmd, args, opts) => {
      const c = new EventEmitter();
      c.pid = 5000 + kids.length; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.writes = []; c.ended = false;
      c.stdin = {
        write(s) {
          c.writes.push(s);
          const q = JSON.parse(s);
          if (mode !== 'reply') return;
          const body = q.op === 'state'
            ? { id: q.id, ok: true, current: 'Spotify.exe', sessions: [{ aumid: 'Spotify.exe', status: 'paused' }] }
            : { id: q.id, ok: true, sent: true };
          const text = 'not json at all\r\n' + JSON.stringify(body) + '\r\n';
          const cut = Math.floor(text.length / 2);
          setImmediate(() => { c.stdout.emit('data', Buffer.from(text.slice(0, cut))); setImmediate(() => c.stdout.emit('data', Buffer.from(text.slice(cut)))); });
        },
        end() { c.ended = true; setImmediate(() => c.emit('exit', 0)); },
      };
      c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null)); };
      kids.push({ cmd, args, opts, c });
      return c;
    };
    const sm = createSmtc({ spawn: fakeSpawn, requestMs: 4000, idleMs: 60000, backoffMs: [1000, 3000], setTimer: vc.setTimer, clearTimer: vc.clearTimer, now: vc.now });
    ok(kids.length === 0, 'smtc: nothing spawns until asked');
    const s1 = await sm.state();
    const k0 = kids[0];
    ok(k0 && k0.cmd === 'powershell.exe' && J(k0.args) === J(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT]) && k0.opts.windowsHide === true,
      `smtc: spawns the helper hidden (${k0 && k0.cmd})`);
    ok(s1.ok === true && s1.current === 'Spotify.exe' && s1.sessions.length === 1 && sm.last() === s1, 'smtc: a reply split across chunks with \\r\\n parses');
    ok(sm.stats().badLines >= 1, `smtc: a junk line is counted, not fatal (${sm.stats().badLines})`);
    const c1 = await sm.control('pause', 'Spotify.exe');
    ok(c1.ok === true && c1.sent === true && JSON.parse(k0.c.writes[1]).op === 'control' && JSON.parse(k0.c.writes[1]).aumid === 'Spotify.exe', 'smtc: control goes out with its aumid (live mode)');
    ok((await sm.control('dance', 'Spotify.exe')).ok === false, 'smtc: an unknown action is refused');
    // Timeout.
    mode = 'silent';
    const pt = sm.state();
    await vc.advance(4000);
    const t1 = await pt;
    ok(t1.ok === false && t1.reason === 'timeout', `smtc: a request times out (${t1.reason})`);
    // Crash with a request in flight: it fails, the next waits out the backoff, then a fresh helper.
    const pc = sm.state();
    await settle();
    kids[kids.length - 1].c.emit('exit', 1);
    const cr = await pc;
    ok(cr.ok === false && cr.reason === 'helper exited', `smtc: a crash fails what was in flight (${cr.reason})`);
    mode = 'reply';
    const early = await sm.state();
    ok(early.ok === false && early.reason === 'helper restarting', `smtc: no respawn inside the backoff (${early.reason})`);
    const before = kids.length;
    await vc.advance(1000);
    const back = await sm.state();
    ok(back.ok === true && kids.length === before + 1, `smtc: after the backoff a fresh helper answers (${kids.length - before})`);
    // Idle exit.
    const cur = kids[kids.length - 1].c;
    await vc.advance(59999);
    ok(!cur.ended && sm.running(), 'smtc: still up just before the idle limit');
    await vc.advance(1);
    await settle();
    ok(cur.ended && !sm.running(), 'smtc: exits after 60 s with nothing to do');
    const n = kids.length;
    ok((await sm.state()).ok === true && kids.length === n + 1, 'smtc: the next request spawns it again');
    await sm.stop();
    ok(!sm.running(), 'smtc: stop ends it');
    // Test mode: control is a dry run and never spawns.
    const tk = [];
    const dry = createSmtc({ test: true, spawn: (...a) => { tk.push(a); return fakeSpawn(...a); } });
    const dr = await dry.control('pause', 'Spotify.exe');
    ok(dr.ok === true && dr.sent === false && dr.dryRun === true && tk.length === 0, `smtc: test mode never sends (${J(dr)})`);
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* a temp dir */ }
  console.log(`AUTOPAUSE: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('CRASH', (e && e.stack) || e);
  console.log(`AUTOPAUSE: ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
